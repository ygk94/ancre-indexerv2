// Certificate audit (D32, D42): compare every committed row with the registry state the indexer has rebuilt at
// the certificate's block. D26 holds iff C_committed <= C_true entry by entry (D32), where C = w / B is the
// NORMALISED share of the edge in its row (B+ = max(10 000, Σ w+), B- = max(10 000, Σ |w-|), ENCODING §4).
//
// Every finding names the edge (or row) whose PROOF corrects it, with that proof (contracts/PROOFS.md, ENCODING §7):
// proveEdge(u, agentJ) only succeeds when the committed weight of agentJ differs from the registry's, so a finding is
// never filed on an edge whose weight is right (review 06/10, SW1: a dilution used to be filed as INFLATED on the
// sibling edges, whose proveEdge reverts NothingToProve).
//
//   FABRICATED      committed edge with no registry edge of the same sign (none, rejected, or opposite sign)  -> (v)
//   INFLATED        trust-raising misstatement of the weight: w > w_registry (positive), |w| < |w_registry| (negative)
//   OVERSTATED_NEG  negative weight above the registry's (griefing a provider with distrust it did not earn)
//   OMITTED_NEG     a negative registry edge of the row's client is missing from a provided row (a provided row is
//                   complete; negatives are never omitted, ENCODING §3.2), whatever the target    -> proveEdge (i)
//   DILUTION        a positive registry edge missing from the row while the row's committed budget B+ is below the true
//                   one (the omission raises the share of every other edge, AM-5.11)               -> proveEdge (i)
//   DEFLATED        0 < w < w_registry while B+ committed < B+ true (same effect as DILUTION)       -> proveEdge
//                   (an omission or deflation covered by a declared sPlus is harmless and not reported, as watcher.py)
//   SOURCE          an agent row commits a source (SRC, VIA_OWNER) that is not src(u) of R7 -> proveWallet (iv)
//   SOURCE_MISSING  an agent row without SRC while src(u) exists: its client's row is not committed
//   UNKNOWN_AGENT   a row belongs to an agent node never minted in the registry: every edge of it is fabricated
//                   (a burnt agent is known: its source-less empty row is legitimate, ENCODING §7.2)
//   WRONG_INDEX     same weight as the registry but another feedbackIndex (e.g. a pre-v1 tie rule): Registry-verified
//                   refuses it at submission (ENCODING §3.4 re-reads (w, feedbackIndex)); not provable by proveEdge
//   SHAPE           a row breaks the shape or canonical-form rules of ENCODING §3.2 (02-bis): SRC/VIA_OWNER on an
//                   anchor or address row; a source-less agent row with edges, SPLUS, ALIAS, or on an ownerFallback set;
//                   a zero SRC; an SRC that is an anchor (AnchorAsSource, D48-A); an alias of a non-agent row; an SPLUS
//                   equal to the committed sum: refused at submission by the 02-bis contract
// On a row whose source is wrong (SOURCE) or whose agent does not exist (UNKNOWN_AGENT), proveEdge reverts BadProof(25):
// the edge findings of that row are labelled with the proof that voids the row (proveWallet).
// The edge rule is R1-R6 with rule B (D48-B, src/lib/edges.ts): a current controller's negative edge is a true edge.
import { GRID, ZERO, type EdgeSchema } from "./rules.js";
import { edgeDecision, type EdgeView } from "./edges.js";
import type { CertRow } from "./certificate.js";

export type NodeInfo = { kind: "anchor" | "agent" | "address"; agentId?: bigint; address?: string };

export interface RegistryView extends EdgeView {
  /** Agents the client has at least one active (client, agent, tag) triple on. */
  agentsRatedBy(client: string): Promise<string[]>;
}

export type DiscrepancyKind =
  | "FABRICATED" | "INFLATED" | "OVERSTATED_NEG" | "OMITTED_NEG" | "DILUTION" | "DEFLATED" | "WRONG_INDEX" | "SOURCE"
  | "SOURCE_MISSING" | "UNKNOWN_AGENT" | "SHAPE";
/** policy.ownerFallback (D44) and policy.registryVerified (D32) of the set (ENCODING §1). */
export type AuditOptions = { ownerFallback: boolean; registryVerified?: boolean };
export type Discrepancy = {
  kind: DiscrepancyKind; u: number; dst?: number; client?: string; agentId?: string;
  wCommitted: number; wRegistry: number; bCommitted?: number; bRegistry?: number;
  /** DILUTION / DEFLATED: committed Σw+ of the row and its declared budget (sPlus, else Σw+), for remedy() */
  rowPlus?: number; rowDeclared?: number;
  feedbackIndex?: number; registryFeedbackIndex?: string;
  /** on-chain remedy: proveEdge | proveWallet | refused at submission | none (...) */
  proof: string;
  note?: string;
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

const REFUSED = "refused at submission";

export async function auditRows(view: RegistryView, schema: EdgeSchema, nodes: NodeInfo[], nCert: number, rows: CertRow[],
  opts: AuditOptions = { ownerFallback: false }): Promise<AuditResult> {
  const out: Discrepancy[] = [];
  const G = Number(GRID);
  const rv = opts.registryVerified ?? true;
  let edgesChecked = 0;
  const certified = new Map<string, number>();
  nodes.slice(0, nCert).forEach((n, i) => { if (n.kind === "agent") certified.set(n.agentId!.toString(), i); });
  const anchors = new Set(nodes.filter((n) => n.kind === "anchor").map((n) => n.address!));
  // one true row per client: D20 copies, v1 aliases and an anchor row + its agent copy share a client
  const truthOf = new Map<string, Promise<TrueRow>>();
  const trueRow = (c: string) => truthOf.get(c) ?? truthOf.set(c, registryRow(view, schema, c)).get(c)!;

  for (const row of rows) {
    const node = nodes[row.u];
    if (!node) throw new Error(`row u=${row.u} outside the node table`);
    const shape: string[] = [...(row.notes ?? [])];
    let client: string | undefined;
    let voidedBy: string | undefined; // a row-level fault: proveWallet voids the whole row (proveEdge reverts BadProof(25))
    let agentId: string | undefined;
    if (node.kind === "agent") {
      agentId = node.agentId!.toString();
      const a = await view.agent(agentId);
      if (!a) {
        out.push({ kind: "UNKNOWN_AGENT", u: row.u, agentId, wCommitted: 0, wRegistry: 0, proof: rv ? REFUSED : "proveWallet" });
        voidedBy = "UNKNOWN_AGENT";
      } else {
        // R7: the wallet always wins; the owner only on an ownerFallback set (D44); otherwise no source
        const viaOwner = a.wallet === ZERO && opts.ownerFallback;
        client = a.wallet !== ZERO ? a.wallet : viaOwner && a.owner !== ZERO ? a.owner : undefined;
        if (row.src === undefined && (row.edges.length > 0 || row.sPlus !== undefined || row.aliasOf !== undefined)) {
          shape.push("source-less agent row with edges, SPLUS or ALIAS");
        }
        if (row.src === undefined && opts.ownerFallback) shape.push("source-less agent row on an ownerFallback set");
        if (row.src !== undefined && anchors.has(row.src)) shape.push("agent row sourced by an anchor (AnchorAsSource, D48-A)");
        if (row.aliasOf !== undefined && nodes[row.aliasOf]?.kind !== "agent") shape.push("alias of a non-agent row");
        if (row.src === undefined) {
          if (client) {
            out.push({ kind: "SOURCE_MISSING", u: row.u, client, agentId, wCommitted: 0, wRegistry: 0, proof: "proveWallet" });
            voidedBy = "SOURCE_MISSING"; // a source-less row has no edge to prove (BadProof(7)): proveWallet voids it
          }
        } else if (row.src !== client || row.viaOwner !== viaOwner) {
          out.push({ kind: "SOURCE", u: row.u, client: row.src, agentId, wCommitted: 0, wRegistry: 0, proof: "proveWallet" });
          voidedBy = "SOURCE";
        }
      }
    } else {
      client = node.address;
      if (row.src !== undefined || row.viaOwner || row.aliasOf !== undefined) shape.push("anchor/address row with SRC, VIA_OWNER or ALIAS");
    }
    if (shape.length > 0) {
      out.push({ kind: "SHAPE", u: row.u, client, agentId, wCommitted: 0, wRegistry: 0, proof: REFUSED, note: [...new Set(shape)].join("; ") });
    }
    // Audit the edges against the TRUE client (a wrong committed wallet must not hide omissions).
    const truth: TrueRow = client ? await trueRow(client) : { w: new Map(), fi: new Map(), bPlus: G, bMinus: G };
    const edgeProof = voidedBy ? "proveWallet" : client ? "proveEdge" : REFUSED;
    const committedPlus = row.edges.reduce((s, e) => s + (e.w > 0 ? e.w : 0), 0);
    const bPlusC = Math.max(G, row.sPlusEffective); // declared true sum when present (D32), else committed Σw+
    // Dilution of the positive side: the budget left once the provable faults of the row are proven (fabricated edges
    // to 0, inflated ones to the registry weight: ENCODING §7.1, X = max(dEff - cOut + cIn, Scur) = dEff - Σcorr) is
    // below the true one, so the correct committed shares are too large. Using the raw committed budget would let an
    // invented edge mask an omission (code review 06/10).
    const excess = row.edges.reduce((s, e) => {
      if (e.w <= 0) return s;
      const n = nodes[e.dst];
      const wr = n?.kind === "agent" ? truth.w.get(n.agentId!.toString()) ?? 0 : 0;
      return s + e.w - Math.min(e.w, Math.max(wr, 0));
    }, 0);
    const diluted = client !== undefined && Math.max(G, row.sPlusEffective - excess) < truth.bPlus;
    const dil = { bCommitted: bPlusC, bRegistry: truth.bPlus, rowPlus: committedPlus, rowDeclared: row.sPlusEffective };
    const committedAgents = new Set<string>();
    for (const e of row.edges) {
      edgesChecked++;
      const dstNode = nodes[e.dst];
      const target = dstNode?.kind === "agent" ? dstNode.agentId!.toString() : undefined;
      if (target) committedAgents.add(target);
      const wr = target ? truth.w.get(target) ?? 0 : 0;
      const base = { u: row.u, dst: e.dst, client, agentId: target, wCommitted: e.w, wRegistry: wr, feedbackIndex: e.feedbackIndex,
        registryFeedbackIndex: target ? truth.fi.get(target)?.toString() : undefined, proof: edgeProof };
      if (wr === 0 || Math.sign(wr) !== Math.sign(e.w)) { out.push({ kind: "FABRICATED", ...base }); continue; }
      if (e.w === wr) {
        const fiReg = truth.fi.get(target!);
        if (fiReg !== undefined && BigInt(e.feedbackIndex) !== fiReg) {
          out.push({ kind: "WRONG_INDEX", ...base, proof: voidedBy ? edgeProof : rv ? REFUSED : "none (same weight, not provable)" });
        }
        continue;
      }
      if (e.w > 0) {
        if (e.w > wr) out.push({ kind: "INFLATED", ...base });
        else if (diluted) out.push({ kind: "DEFLATED", ...base, ...dil });
        // else: harmless deflation (t stays a lower bound), not reported (watcher.py DEFLATED_HARMLESS)
      } else {
        out.push({ kind: e.w > wr ? "INFLATED" : "OVERSTATED_NEG", ...base });
      }
    }
    // Registry edges missing from the row. proveEdge takes an agentId: an omission toward an agent left out of the node
    // table is provable too (violation vector omitted_negative drops #4 from the table); `dst` is set when the agent is
    // a certified node. Never toward the row's own agent (proveEdge BadProof(27), no self-loop).
    for (const [target, wr] of truth.w) {
      if (target === agentId || committedAgents.has(target)) continue;
      const base = { u: row.u, dst: certified.get(target), client, agentId: target, wCommitted: 0, wRegistry: wr,
        registryFeedbackIndex: truth.fi.get(target)?.toString(), proof: edgeProof };
      if (wr < 0) out.push({ kind: "OMITTED_NEG", ...base });
      else if (diluted) out.push({ kind: "DILUTION", ...base, ...dil });
      // else: omission covered by the declared sPlus (or below GRID): harmless, not reported
    }
  }
  return { edgesChecked, rowsChecked: rows.length, discrepancies: out };
}
