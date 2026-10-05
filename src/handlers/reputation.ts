// ReputationRegistry (ERC-8004 v2.0.0): every feedback is kept (layer 1); reference edges are compiled (layer 3).
import { indexer } from "envio";
import { VALUE_ABS_MAX, ZERO, controllerReason, isRefTag } from "../lib/rules.js";
import { bumpStats, getAgent, isOperator, lc, recomputeRefEdge } from "../lib/state.js";

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
    const triple = `${client}-${agentId}-${p.tag1}`;
    context.Feedback.set({
      id, agent_id: agentId, client, feedbackIndex: p.feedbackIndex, value: p.value,
      valueDecimals: Number(p.valueDecimals), tag1: p.tag1, tag2: p.tag2, endpoint: p.endpoint,
      feedbackURI: p.feedbackURI, feedbackHash: p.feedbackHash, triple,
      blockNumber: BigInt(block), logIndex: event.logIndex, txHash: event.transaction.hash,
      txFrom: lc(event.transaction.from ?? ZERO), revokedAtBlock: undefined, clientWasController: ctl,
    });
    const outOfRange = p.value >= VALUE_ABS_MAX || p.value <= -VALUE_ABS_MAX;
    await bumpStats(context, block, { feedbacks: 1, selfRatings: ctl ? 1 : 0, outOfRange: outOfRange ? 1 : 0 });
    // feedbackIndex grows per (client, agent): a new feedback is always the latest of its triple (D14).
    // Kept for every tag: an anchor set may commit its own filter (D12), which the certificate audit replays.
    context.TripleLatest.set({ id: triple, client, agent_id: agentId, tag1: p.tag1, feedback_id: id });
    if (isRefTag(p.tag1)) await recomputeRefEdge(context, client, agentId, block);
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
  if (isRefTag(fb.tag1)) await recomputeRefEdge(context, client, agentId, block);
});
