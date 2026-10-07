// Shared state helpers used by the identity and reputation handlers.
// Every helper reads before it writes (handlers run twice: preload, then processing).
import type { EvmOnEventContext, Agent, ChainStats, SetEdge } from "envio";
import { REF, ZERO } from "./rules.js";
import { edgeDecision } from "./edges.js";
import { storeView } from "./view.js";

type Ctx = EvmOnEventContext;

export const lc = (a: string) => a.toLowerCase();

export function blankAgent(id: string): Agent {
  return { id, owner: ZERO, wallet: ZERO, approved: ZERO, uri: "", registeredBlock: undefined,
    registeredTxFrom: undefined, transferCount: 0, lastTransferBlock: undefined, refEdgeRows: 0,
    regTx: undefined, regPhase: undefined };
}

export async function getAgent(context: Ctx, id: string): Promise<Agent> {
  return (await context.Agent.get(id)) ?? blankAgent(id);
}

const BLANK_STATS: Omit<ChainStats, "id"> = { agents: 0, transfers: 0, feedbacks: 0, revoked: 0, selfRatings: 0,
  outOfRange: 0, refEdges: 0, sharedWallets: 0, agentsOnSharedWallets: 0, lastBlock: 0n };

export async function bumpStats(context: Ctx, block: number, delta: Partial<Record<keyof typeof BLANK_STATS, number>>) {
  const s = (await context.ChainStats.get("stats")) ?? { id: "stats", ...BLANK_STATS };
  const next: ChainStats = { ...s, lastBlock: BigInt(block) > s.lastBlock ? BigInt(block) : s.lastBlock };
  for (const [k, v] of Object.entries(delta) as [keyof typeof BLANK_STATS, number][]) {
    if (k !== "lastBlock") (next[k] as number) = (s[k] as number) + v;
  }
  context.ChainStats.set(next);
}

/** Move an agent between WalletAgents rows and keep the shared-wallet counters exact. */
export async function moveWallet(context: Ctx, agentId: string, from: string, to: string, block: number) {
  if (from === to) return;
  let dShared = 0;
  let dOnShared = 0;
  const [src, dst] = await Promise.all([
    from !== ZERO ? context.WalletAgents.get(from) : undefined,
    to !== ZERO ? context.WalletAgents.get(to) : undefined,
  ]);
  if (src) {
    const ids = src.agentIds.filter((x) => x !== agentId);
    if (src.count > 1) { dShared -= 1; dOnShared -= src.count; }
    if (ids.length > 1) { dShared += 1; dOnShared += ids.length; }
    context.WalletAgents.set({ ...src, agentIds: ids, count: ids.length });
  }
  if (to !== ZERO) {
    const ids = [...(dst?.agentIds ?? []).filter((x) => x !== agentId), agentId];
    const before = dst?.count ?? 0;
    if (before > 1) { dShared -= 1; dOnShared -= before; }
    if (ids.length > 1) { dShared += 1; dOnShared += ids.length; }
    context.WalletAgents.set({ id: to, agentIds: ids, count: ids.length });
  }
  if (dShared !== 0 || dOnShared !== 0) await bumpStats(context, block, { sharedWallets: dShared, agentsOnSharedWallets: dOnShared });
}

export async function isOperator(context: Ctx, owner: string, client: string): Promise<boolean> {
  if (owner === ZERO) return false;
  return (await context.Operator.get(`${owner}-${client}`))?.active ?? false;
}

export const REF_SET = "ref";

type Decision = Awaited<ReturnType<typeof edgeDecision>>;
/** The SetEdge row a decision gives, or undefined when it equals `prev` (nothing to write). */
function nextEdge(prev: SetEdge | undefined, d: Decision, client: string, agentId: string, block: number): SetEdge | undefined {
  const base = { id: `${REF_SET}-${client}-${agentId}`, set_id: REF_SET, client, agent_id: agentId, updatedAtBlock: BigInt(block) };
  const next: SetEdge = d
    ? { ...base, w: d.w, decidingTag: d.tag1, feedbackIndex: d.feedbackIndex, rejected: d.rejected }
    : { ...base, w: 0, decidingTag: undefined, feedbackIndex: undefined, rejected: "NO_ACTIVE_FEEDBACK" };
  if (prev && prev.w === next.w && prev.rejected === next.rejected && prev.decidingTag === next.decidingTag &&
      prev.feedbackIndex === next.feedbackIndex) return undefined;
  return next;
}
const retained = (e: SetEdge | undefined) => (e && e.w !== 0 ? 1 : 0);

/** R2-R6 for one (client, agent) pair of the reference set, written to SetEdge. */
export async function recomputeRefEdge(context: Ctx, client: string, agentId: string, block: number) {
  const edgeId = `${REF_SET}-${client}-${agentId}`;
  const [agent, prev, d, refSet] = await Promise.all([
    getAgent(context, agentId),
    context.SetEdge.get(edgeId),
    edgeDecision(storeView(context as never), REF, client, agentId),
    context.AnchorSet.get(REF_SET),
  ]);
  if (!d && !prev) return;
  const next = nextEdge(prev, d, client, agentId, block);
  if (!next) return;
  if (!prev) {
    context.Agent.set({ ...agent, refEdgeRows: agent.refEdgeRows + 1 }); // lets recomputeEdgesInto skip edge-less agents
    if (!refSet) context.AnchorSet.set({ id: REF_SET, kind: "reference", anchors: undefined, lambdas: undefined, alphaN: undefined,
      alphaD: undefined, tagsJson: undefined, policyJson: undefined, ownerFallback: undefined, registryVerified: undefined,
      decodable: undefined, nodesComplete: undefined, nodeCount: undefined, registeredBlock: undefined, registeredTx: undefined });
  }
  context.SetEdge.set(next);
  const delta = retained(next) - retained(prev);
  if (delta !== 0) await bumpStats(context, block, { refEdges: delta });
}

/** Controllers of `agentId` changed: recompute every reference edge pointing to it. The decisions are read in
 *  parallel (one round of storage reads, not 3 per edge: review 06/10, SEQ), then written with one stats delta. */
export async function recomputeEdgesInto(context: Ctx, agentId: string, block: number) {
  if ((await getAgent(context, agentId)).refEdgeRows === 0) return; // fresh mints, farm agents: no query
  const edges = (await context.SetEdge.getWhere({ agent_id: { _eq: agentId } })).filter((e) => e.set_id === REF_SET);
  const view = storeView(context as never);
  const decisions = await Promise.all(edges.map((e) => edgeDecision(view, REF, e.client, agentId)));
  let delta = 0;
  edges.forEach((prev, i) => {
    const next = nextEdge(prev, decisions[i], prev.client, agentId, block);
    if (!next) return;
    context.SetEdge.set(next);
    delta += retained(next) - retained(prev);
  });
  if (delta !== 0) await bumpStats(context, block, { refEdges: delta });
}
