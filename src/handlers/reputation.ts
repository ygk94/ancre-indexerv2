// ReputationRegistry (ERC-8004 v2.0.0): every feedback is kept (layer 1); reference edges are compiled (layer 3).
// Tags are identified by keccak256(tag1) (the indexedTag1 topic), never by their decoded text: the text is
// attacker-chosen (unbounded length, U+0000) and only stored as a display column (src/lib/text.ts, review 06/10).
import { indexer } from "envio";
import { VALUE_ABS_MAX, ZERO, controllerReason, refTagOfHash } from "../lib/rules.js";
import { bumpStats, getAgent, isOperator, lc, recomputeRefEdge } from "../lib/state.js";
import { safeText, storedTag, tripleId } from "../lib/text.js";

indexer.onEvent(
  { contract: "ReputationRegistry", event: "NewFeedback", fields: { transaction: ["hash", "from"] } },
  async ({ event, context }) => {
    const p = event.params;
    const agentId = p.agentId.toString();
    const client = lc(p.clientAddress);
    const block = event.block.number;
    const agent = await getAgent(context, agentId);
    const ctl = controllerReason(client, agent, await isOperator(context, agent.owner, client));
    const id = `${agentId}-${client}-${p.feedbackIndex}`;
    const tag = storedTag(p.tag1, p.indexedTag1);
    const triple = tripleId(client, agentId, tag.hash);
    context.Feedback.set({
      id, agent_id: agentId, client, feedbackIndex: p.feedbackIndex, value: p.value,
      valueDecimals: Number(p.valueDecimals), tag1: tag.text, tagHash: tag.hash, tag1Exact: tag.exact,
      tag2: safeText(p.tag2).text, endpoint: safeText(p.endpoint).text, feedbackURI: safeText(p.feedbackURI).text,
      feedbackHash: p.feedbackHash, triple,
      blockNumber: BigInt(block), logIndex: event.logIndex, txHash: event.transaction.hash,
      txFrom: lc(event.transaction.from ?? ZERO), revokedAtBlock: undefined, clientWasController: ctl,
    });
    const outOfRange = p.value >= VALUE_ABS_MAX || p.value <= -VALUE_ABS_MAX;
    await bumpStats(context, block, { feedbacks: 1, selfRatings: ctl ? 1 : 0, outOfRange: outOfRange ? 1 : 0 });
    // feedbackIndex grows per (client, agent): a new feedback is always the latest of its triple (D14).
    // Kept for every tag: an anchor set may commit its own filter (D12), which the certificate audit replays.
    context.TripleLatest.set({ id: triple, client, agent_id: agentId, tag1: tag.text, tagHash: tag.hash, feedback_id: id });
    if (refTagOfHash(tag.hash)) await recomputeRefEdge(context, client, agentId, block);
  },
);

indexer.onEvent({ contract: "ReputationRegistry", event: "FeedbackRevoked" }, async ({ event, context }) => {
  const agentId = event.params.agentId.toString();
  const client = lc(event.params.clientAddress);
  const id = `${agentId}-${client}-${event.params.feedbackIndex}`;
  const block = event.block.number;
  const fb = await context.Feedback.get(id);
  if (!fb || fb.revokedAtBlock !== undefined) return;
  context.Feedback.set({ ...fb, revokedAtBlock: BigInt(block) });
  await bumpStats(context, block, { revoked: 1 });
  const tl = await context.TripleLatest.get(fb.triple);
  if (tl?.feedback_id !== id) return;
  // Fall back to the latest non-revoked feedback of the triple (none -> null).
  const all = await context.Feedback.getWhere({ triple: { _eq: fb.triple } });
  let best: (typeof all)[number] | undefined;
  for (const f of all) {
    if (f.id === id || f.revokedAtBlock !== undefined) continue;
    if (!best || f.feedbackIndex > best.feedbackIndex) best = f;
  }
  context.TripleLatest.set({ ...tl, feedback_id: best?.id });
  if (refTagOfHash(fb.tagHash)) await recomputeRefEdge(context, client, agentId, block);
});
