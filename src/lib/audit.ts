// Certificate audit (D32, D42): compare every committed row with the registry state the indexer has rebuilt at
// the certificate's block. D26 holds iff C_committed <= C_true entry by entry (D32), where C = w / B is the
// NORMALISED share of the edge in its row (B+ = max(10 000, Σ w+), B- = max(10 000, Σ |w-|), ENCODING §4).
// Comparing raw weights is not enough: lowering or omitting an honest positive edge shrinks B+ and raises the
// share of every other edge of the row (dilution, AM-5.11).
//
//   FABRICATED      committed edge with no registry edge of the same sign (none, rejected, or opposite sign)  -> (v)
//   INFLATED        trust-raising misstatement: positive share above the true share, or negative share below it -> (v)
//   OVERSTATED_NEG  negative share above the true share (griefing a provider with distrust it did not earn)
//   OMITTED_NEG     a negative registry edge of the row's client is missing from a provided row (a provided row is
//                   complete; negatives are never omitted, ENCODING §3.2), whatever the target    -> proveEdge (i)
//   SOURCE          an agent row commits a source (SRC, VIA_OWNER) that is not src(u) of R7 -> proveWallet (iv)
//   SOURCE_MISSING  an agent row without SRC while src(u) exists: its client's row is not committed
//   UNKNOWN_AGENT   a row belongs to an agent node with no agent in the registry: every edge of it is fabricated
// Format ancre-cert-v1 (contracts/ENCODING.md): B+ = max(10 000, sPlus) with the declared sPlus when present; alias rows
// carry their ref's edges and are audited like any row. In a Registry-verified set the contract already refuses
// FABRICATED/INFLATED at submission: the audit matters for dilution and omitted negatives (AM-INT.1).
import { ZERO, GRID, type EdgeSchema } from "./rules.js";
import { edgeDecision, type EdgeView } from "./edges.js";
import type { CertRow } from "./certificate.js";

export type NodeInfo = { kind: "anchor" | "agent" | "address"; agentId?: bigint; address?: string };

export interface RegistryView extends EdgeView {
  /** Agents the client has at least one active (client, agent, tag) triple on. */
  agentsRatedBy(client: string): Promise<string[]>;
}

export type DiscrepancyKind =
  | "FABRICATED" | "INFLATED" | "OVERSTATED_NEG" | "OMITTED_NEG" | "SOURCE" | "SOURCE_MISSING" | "UNKNOWN_AGENT";
export type AuditOptions = { ownerFallback: boolean }; // policy.ownerFallback of the set (D44, ENCODING §1)
export type Discrepancy = {
  kind: DiscrepancyKind; u: number; dst?: number; client?: string; agentId?: string;
  wCommitted: number; wRegistry: number; bCommitted?: number; bRegistry?: number;
  feedbackIndex?: number; registryFeedbackIndex?: string;
};
export type AuditResult = { edgesChecked: number; rowsChecked: number; discrepancies: Discrepancy[] };

type TrueRow = { w: Map<string, number>; fi: Map<string, bigint>; bPlus: number; bMinus: number };

/** The client's true row in the registry: every agent it rated, under the set's schema (whole graph, not only certified nodes). */
export async function registryRow(view: RegistryView, schema: EdgeSchema, client: string): Promise<TrueRow> {
  const agents = await view.agentsRatedBy(client);
  const ds = await Promise.all(agents.map((a) => edgeDecision(view, schema, client, a)));
  const w = new Map<string, number>();
  const fi = new Map<string, bigint>();
  let pos = 0;
  let neg = 0;
  ds.forEach((d, i) => {
    if (!d || d.w === 0) return;
    w.set(agents[i]!, d.w);
    if (d.feedbackIndex !== undefined) fi.set(agents[i]!, d.feedbackIndex);
    if (d.w > 0) pos += d.w; else neg -= d.w;
  });
  const G = Number(GRID);
  return { w, fi, bPlus: Math.max(G, pos), bMinus: Math.max(G, neg) };
}

export async function auditRows(view: RegistryView, schema: EdgeSchema, nodes: NodeInfo[], nCert: number, rows: CertRow[],
  opts: AuditOptions = { ownerFallback: false }): Promise<AuditResult> {
  const out: Discrepancy[] = [];
  const G = Number(GRID);
  let edgesChecked = 0;
  const certified = new Map<string, number>();
  nodes.slice(0, nCert).forEach((n, i) => { if (n.kind === "agent") certified.set(n.agentId!.toString(), i); });

  for (const row of rows) {
    const node = nodes[row.u];
    if (!node) throw new Error(`row u=${row.u} outside the node table`);
    let client: string | undefined;
    if (node.kind === "agent") {
      const agentId = node.agentId!.toString();
      const a = await view.agent(agentId);
      if (!a || a.owner === ZERO) {
        out.push({ kind: "UNKNOWN_AGENT", u: row.u, agentId, wCommitted: 0, wRegistry: 0 });
      } else {
        // R7: the wallet always wins; the owner only on an ownerFallback set (D44); otherwise no source
        const viaOwner = a.wallet === ZERO && opts.ownerFallback;
        client = a.wallet !== ZERO ? a.wallet : viaOwner ? a.owner : undefined;
        if (row.src === undefined) {
          if (client) out.push({ kind: "SOURCE_MISSING", u: row.u, client, agentId, wCommitted: 0, wRegistry: 0 });
        } else if (row.src !== client || row.viaOwner !== viaOwner) {
          out.push({ kind: "SOURCE", u: row.u, client: row.src, agentId, wCommitted: 0, wRegistry: 0 });
        }
      }
    } else {
      client = node.address;
    }
    // Audit the edges against the TRUE client (a wrong committed wallet must not hide omissions).
    const truth: TrueRow = client ? await registryRow(view, schema, client) : { w: new Map(), fi: new Map(), bPlus: G, bMinus: G };
    const bPlusC = Math.max(G, row.sPlusEffective); // declared true sum when present (D32), else committed Σw+
    const bMinusC = Math.max(G, row.edges.reduce((s, e) => s + (e.w < 0 ? -e.w : 0), 0));
    for (const e of row.edges) {
      edgesChecked++;
      const dstNode = nodes[e.dst];
      const agentId = dstNode?.kind === "agent" ? dstNode.agentId!.toString() : undefined;
      const wr = agentId ? truth.w.get(agentId) ?? 0 : 0;
      const base = { u: row.u, dst: e.dst, client, agentId, wCommitted: e.w, wRegistry: wr, feedbackIndex: e.feedbackIndex,
        registryFeedbackIndex: agentId ? truth.fi.get(agentId)?.toString() : undefined };
      if (wr === 0 || Math.sign(wr) !== Math.sign(e.w)) { out.push({ kind: "FABRICATED", ...base }); continue; }
      // shares compared exactly by cross-multiplication: |w|/B_committed vs |wr|/B_true
      const [bc, bt] = e.w > 0 ? [bPlusC, truth.bPlus] : [bMinusC, truth.bMinus];
      const lhs = BigInt(Math.abs(e.w)) * BigInt(bt);
      const rhs = BigInt(Math.abs(wr)) * BigInt(bc);
      if (lhs === rhs) continue;
      const withB = { ...base, bCommitted: bc, bRegistry: bt };
      if (e.w > 0) { if (lhs > rhs) out.push({ kind: "INFLATED", ...withB }); }
      else out.push({ kind: lhs < rhs ? "INFLATED" : "OVERSTATED_NEG", ...withB });
    }
    // Every negative registry edge of the client must be in the row, whatever the target: proveEdge takes an
    // agentId, so an omission toward an agent left out of the node table is provable too (violation vector
    // omitted_negative drops #4 from the table). `dst` is set when the agent is a certified node.
    const committedAgents = new Set(row.edges.map((e) => {
      const n = nodes[e.dst];
      return n?.kind === "agent" ? n.agentId!.toString() : "";
    }));
    const self = node.kind === "agent" ? node.agentId!.toString() : undefined;
    for (const [agentId, wr] of truth.w) {
      if (wr >= 0 || agentId === self || committedAgents.has(agentId)) continue;
      out.push({ kind: "OMITTED_NEG", u: row.u, dst: certified.get(agentId), client, agentId, wCommitted: 0, wRegistry: wr,
        registryFeedbackIndex: truth.fi.get(agentId)?.toString() });
    }
  }
  return { edgesChecked, rowsChecked: rows.length, discrepancies: out };
}
