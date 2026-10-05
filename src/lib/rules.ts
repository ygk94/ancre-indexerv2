// Normative edge rules, ported from solver/graph.py (the reference implementation).
// Any change here must keep test/parity.test.ts green against the solver.
//
//   D14  edge unit = latest non-revoked feedback per (client, agent, tag1); then, across the
//        filter's tags, negative dominance (any weight < 0 -> the most negative, else the largest);
//        ties between tags: highest feedbackIndex (solver/FORMAT.md R5, format v1).
//   D15  only `endorsement` tags create edges.
//   D18  normative weight: int16 on the 1e-4 grid, truncation toward zero.
//   CR   out-of-bounds value -> rejected, never capped; bounds compared on the exact value.
//        Out-of-bounds latest feedback gives nothing for that tag (no fallback to an older one).
//   D16/D20  reject when the client is a CURRENT controller of the target
//        (owner, operator of the owner, agentWallet, approved). The "past owner" rule is removed (D20).
import schemaJson from "./schema_reference.json" with { type: "json" };

export const WAD = 10n ** 18n;
export const GRID = 10_000n;
export const VALUE_ABS_MAX = 10n ** 38n;
export const ZERO = "0x0000000000000000000000000000000000000000";

export type TagKind = "endorsement" | "measurement";
export type TagSpec = { minWad: bigint; neutralWad: bigint; maxWad: bigint; kind: TagKind };

/** Exact decimal string (e.g. "-100", "0.5") -> WAD. Throws if not representable. */
export function decToWad(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`bad decimal: ${s}`);
  const frac = m[3] ?? "";
  if (frac.length > 18) throw new Error(`bound not representable in WAD: ${s}`);
  const v = BigInt(m[2]!) * WAD + BigInt(frac.padEnd(18, "0") || "0");
  return m[1] === "-" ? -v : v;
}

export function loadSchema(obj: { tags: Record<string, { min: string; neutral: string; max: string; kind: string }> }) {
  const out = new Map<string, TagSpec>();
  for (const [tag, s] of Object.entries(obj.tags)) {
    const spec: TagSpec = { minWad: decToWad(s.min), neutralWad: decToWad(s.neutral), maxWad: decToWad(s.max), kind: s.kind as TagKind };
    if (!(spec.minWad <= spec.neutralWad && spec.neutralWad <= spec.maxWad)) throw new Error(`${tag}: min <= neutral <= max`);
    if (spec.kind !== "endorsement" && spec.kind !== "measurement") throw new Error(`${tag}: unknown kind ${s.kind}`);
    out.set(tag, spec);
  }
  return out;
}

export const REF_SCHEMA = loadSchema(schemaJson);
export const REF_FILTER: readonly string[] = schemaJson.filters.reference;
const REF_FILTER_SET = new Set(REF_FILTER);

/** A set's edge schema: tag -> bounds/kind (D12) and the tags of its filter. */
export type EdgeSchema = { specs: Map<string, TagSpec>; filter: ReadonlySet<string> };
export const REF: EdgeSchema = { specs: REF_SCHEMA, filter: REF_FILTER_SET };

/** True when a feedback with this tag1 can contribute to an edge of the set (D15 + filter). */
export function isEdgeTag(tag1: string, schema: EdgeSchema = REF): boolean {
  return schema.filter.has(tag1) && schema.specs.get(tag1)?.kind === "endorsement";
}
export const isRefTag = (tag1: string) => isEdgeTag(tag1, REF);

/** graph.quantize: q in [-10000, 10000] or undefined when out of bounds. */
export function quantize(value: bigint, decimals: number, spec: TagSpec): number | undefined {
  if (value > VALUE_ABS_MAX || value < -VALUE_ABS_MAX) return undefined;
  if (decimals < 0 || decimals > 18) throw new Error("valueDecimals out of [0,18]");
  const v = value * 10n ** BigInt(18 - decimals);
  if (v < spec.minWad || v > spec.maxWad) return undefined;
  if (v >= spec.neutralWad) {
    const den = spec.maxWad - spec.neutralWad;
    if (den === 0n) return 0;
    return Number(((v - spec.neutralWad) * GRID) / den); // >= 0: bigint division == floor == truncation
  }
  const den = spec.neutralWad - spec.minWad; // > 0 since min <= v < neutral
  return -Number(((spec.neutralWad - v) * GRID) / den); // truncation toward zero of the negative
}

export type TagCandidate = { tag1: string; value: bigint; decimals: number; feedbackIndex: bigint };

export type Combined =
  | { kind: "edge"; w: number; tag1: string; feedbackIndex: bigint }
  | { kind: "none"; reason: "OUT_OF_BOUNDS" | "ZERO_WEIGHT" };

/**
 * D14 combination for one (client, agent) pair.
 * `latest` holds, for each tag of the set's filter, the latest non-revoked feedback of the triple (any bounds).
 * Returns undefined when no tag of the filter has a feedback (no SetEdge row needed).
 */
export function combine(latest: TagCandidate[], schema: EdgeSchema = REF): Combined | undefined {
  const scored: { q: number; c: TagCandidate }[] = [];
  let any = false;
  for (const c of latest) {
    if (!isEdgeTag(c.tag1, schema)) continue;
    any = true;
    const q = quantize(c.value, c.decimals, schema.specs.get(c.tag1)!);
    if (q !== undefined) scored.push({ q, c });
  }
  if (!any) return undefined;
  if (scored.length === 0) return { kind: "none", reason: "OUT_OF_BOUNDS" };
  const neg = scored.filter((x) => x.q < 0);
  // R5 (format v1, F-6): ties between tags of equal weight go to the HIGHEST feedbackIndex (the contract stores only
  // tag hashes and keeps the first feedback met scanning from the last index down). Ties never change w.
  const byIndex = (a: { q: number; c: TagCandidate }, b: { q: number; c: TagCandidate }) =>
    a.c.feedbackIndex > b.c.feedbackIndex ? a : a.c.feedbackIndex < b.c.feedbackIndex ? b : a;
  const pick = neg.length > 0
    ? neg.reduce((m, x) => (x.q < m.q ? x : x.q > m.q ? m : byIndex(m, x)))
    : scored.reduce((m, x) => (x.q > m.q ? x : x.q < m.q ? m : byIndex(m, x)));
  if (pick.q === 0) return { kind: "none", reason: "ZERO_WEIGHT" };
  return { kind: "edge", w: pick.q, tag1: pick.c.tag1, feedbackIndex: pick.c.feedbackIndex };
}

export type ControllerReason = "owner" | "operator" | "agentWallet" | "approved";

/** graph.Identity.controllers minus past owners (D20). Reason precedence matches the solver. */
export function controllerReason(
  client: string,
  agent: { owner: string; wallet: string; approved: string },
  ownerHasOperator: boolean,
): ControllerReason | undefined {
  if (agent.owner !== ZERO && client === agent.owner) return "owner";
  if (ownerHasOperator) return "operator";
  if (agent.wallet !== ZERO && client === agent.wallet) return "agentWallet";
  if (agent.approved !== ZERO && client === agent.approved) return "approved";
  return undefined;
}

export const REJECT_OF: Record<ControllerReason, "CONTROLLER_OWNER" | "CONTROLLER_OPERATOR" | "CONTROLLER_WALLET" | "CONTROLLER_APPROVED"> = {
  owner: "CONTROLLER_OWNER",
  operator: "CONTROLLER_OPERATOR",
  agentWallet: "CONTROLLER_WALLET",
  approved: "CONTROLLER_APPROVED",
};
