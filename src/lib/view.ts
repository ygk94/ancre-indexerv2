// RegistryView backed by the indexer's entities. Works with a handler context and with the test indexer
// (both expose Entity.get / Entity.getWhere on the current chain).
import type { RegistryView } from "./audit.js";
import type { EdgeSchema, TagKind, TagSpec } from "./rules.js";
import { schemaTagHash, tripleId } from "./text.js";

type Getter<T> = { get(id: string): Promise<T | undefined> };
type Store = {
  Agent: Getter<{ owner: string; wallet: string; approved: string }>;
  Operator: Getter<{ active: boolean }>;
  Feedback: Getter<{ value: bigint; valueDecimals: number; feedbackIndex: bigint }>;
  TripleLatest: Getter<{ feedback_id?: string }> & {
    getWhere(filter: { client: { _eq: string } }): Promise<{ agent_id: string; feedback_id?: string }[]>;
  };
};

export function storeView(s: Store): RegistryView {
  return {
    agent: (id) => s.Agent.get(id),
    isOperator: async (owner, client) => (await s.Operator.get(`${owner}-${client}`))?.active ?? false,
    // keyed by keccak256(tag): the schema's tag text is hashed, the stored (display) text is never compared (NUL)
    latest: async (client, agentId, tag1) => {
      const t = await s.TripleLatest.get(tripleId(client, agentId, schemaTagHash(tag1)));
      const f = t?.feedback_id ? await s.Feedback.get(t.feedback_id) : undefined;
      return f && { tag1, value: f.value, decimals: f.valueDecimals, feedbackIndex: f.feedbackIndex };
    },
    agentsRatedBy: async (client) => {
      const rows = await s.TripleLatest.getWhere({ client: { _eq: client } });
      return [...new Set(rows.filter((r) => r.feedback_id).map((r) => r.agent_id))];
    },
  };
}

/** Edge schema committed by an anchor set: TagSpec bounds already in WAD (ENCODING §1), kind 0/1. */
export function setSchema(tags: { tag: string; min: string | bigint; neutral: string | bigint; max: string | bigint; kind: number }[]): EdgeSchema {
  const specs = new Map<string, TagSpec>();
  for (const t of tags) {
    if (t.kind !== 0 && t.kind !== 1) throw new Error(`${t.tag}: kind ${t.kind} not in {0, 1}`);
    const spec = { minWad: BigInt(t.min), neutralWad: BigInt(t.neutral), maxWad: BigInt(t.max),
      kind: (t.kind === 0 ? "endorsement" : "measurement") as TagKind };
    // same checks as registerAnchorSet (ENCODING §1): min <= neutral <= max, min < max
    if (!(spec.minWad <= spec.neutralWad && spec.neutralWad <= spec.maxWad && spec.minWad < spec.maxWad)) {
      throw new Error(`${t.tag}: bounds must satisfy min <= neutral <= max and min < max`);
    }
    specs.set(t.tag, spec);
  }
  return { specs, filter: new Set(tags.map((t) => t.tag)) };
}
