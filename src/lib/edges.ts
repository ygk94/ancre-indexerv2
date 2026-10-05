// The one normative edge decision (D14, D15, bounds, D16/D20), shared by SetEdge (layer 3) and the certificate
// audit, so that the rule tested in parity with solver/graph.py is the rule the audit applies.
import { combine, controllerReason, isEdgeTag, REJECT_OF, type EdgeSchema, type TagCandidate } from "./rules.js";

export type TagCandidateSource = (client: string, agentId: string, tag1: string) => Promise<TagCandidate | undefined>;
export interface EdgeView {
  agent(agentId: string): Promise<{ owner: string; wallet: string; approved: string } | undefined>;
  isOperator(owner: string, client: string): Promise<boolean>;
  /** Latest non-revoked feedback of (client, agent, tag1), any bounds (D14 selection). */
  latest: TagCandidateSource;
}

export type EdgeReject =
  | "OUT_OF_BOUNDS" | "ZERO_WEIGHT" | "CONTROLLER_OWNER" | "CONTROLLER_OPERATOR" | "CONTROLLER_WALLET" | "CONTROLLER_APPROVED";
/** rejected undefined = edge retained (w != 0). */
export type EdgeDecision = { w: number; tag1?: string; feedbackIndex?: bigint; rejected?: EdgeReject };

/** undefined = the client has no active feedback on the agent under any tag of the set's filter. */
export async function edgeDecision(view: EdgeView, schema: EdgeSchema, client: string, agentId: string): Promise<EdgeDecision | undefined> {
  const tags = [...schema.filter].filter((t) => isEdgeTag(t, schema));
  const [agent, ...cands] = await Promise.all([view.agent(agentId), ...tags.map((t) => view.latest(client, agentId, t))]);
  const c = combine(cands.filter((x): x is TagCandidate => x !== undefined), schema);
  if (!c) return undefined;
  if (c.kind === "none" && c.reason === "OUT_OF_BOUNDS") return { w: 0, rejected: "OUT_OF_BOUNDS" };
  const why = agent ? controllerReason(client, agent, await view.isOperator(agent.owner, client)) : undefined;
  if (why) return { w: 0, rejected: REJECT_OF[why] };
  if (c.kind === "none") return { w: 0, rejected: "ZERO_WEIGHT" };
  return { w: c.w, tag1: c.tag1, feedbackIndex: c.feedbackIndex };
}
