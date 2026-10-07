// AnchoredReputation (ANCRE verifier): every certificate is audited, in the handler, against the registry state the
// indexer has rebuilt at the certificate's block (D42). Events of the same chain are processed in (block, logIndex)
// order, so the identity and reputation entities read here are exactly the registry as of that log.
//
// Where the data comes from (review 06/10, OUTERCALL):
//   set schema    registerAnchorSet calldata, direct or NESTED in a wrapper's input (Safe, Multicall3, 4337, 7702),
//                 trusted only when the params hash to the event's setId (computeSetId);
//   node table    the calldata of a direct addNodes / submitCertificate (exact `count` entries), otherwise the
//                 contract's own immutable keys, nodeKeyAt(setId, i), read at the head through an Effect
//                 (src/lib/nodekeys.ts); a hole that cannot be read yet is retried on the next NodesAdded or certificate;
//   rows          submitCertificate calldata, direct or nested, trusted only when the rows hash to the event's
//                 graphRoot (and nCert, numRows match). The 02-bis contract requires msg.sender == tx.origin on open sets
//                 (G-11), so a nested certificate is an attested set's (or an EIP-7702 account's).
// Anything else is reported as such (UNDECODABLE, ROOT_MISMATCH, NODES_MISSING, UNKNOWN_SET), never audited on a guess.
import { indexer, type AnchorSet, type Discrepancy, type EvmOnEventContext, type SetHealth, type SetNode } from "envio";
import type { NodeInfo } from "../lib/audit.js";
import { auditRows } from "../lib/audit.js";
import { decodeRows, graphRoot, EncodingError, type CertRow, type NewNode } from "../lib/certificate.js";
import { decodeAppendedNodes, findCertCalls, findSetCall, type SetTag } from "../lib/calls.js";
import { MAX_KEYS, nodeKeysEffect, nodeOfKey } from "../lib/nodekeys.js";
import { setSchema, storeView } from "../lib/view.js";
import { GRID, ZERO } from "../lib/rules.js";
import { lc } from "../lib/state.js";

const blankSet = (id: string): AnchorSet => ({
  id, kind: "onchain", anchors: undefined, lambdas: undefined, alphaN: undefined, alphaD: undefined, tagsJson: undefined,
  policyJson: undefined, ownerFallback: undefined, registryVerified: undefined, decodable: undefined, nodesComplete: undefined,
  nodeCount: undefined, registeredBlock: undefined, registeredTx: undefined,
});
const blankHealth = (id: string): SetHealth => ({
  id, set_id: id, certificates: 0, lastCertificate_id: undefined, lastCertBlock: undefined, status: "UNAUDITED",
  openDiscrepancies: 0, edgesProven: 0, rowsVoided: 0, transfersFlagged: 0, registryChangedAtBlock: undefined, lastEEff: undefined,
});
const isDirect = (to: string | undefined, contract: string) => to !== undefined && lc(to) === lc(contract);

const setNodeRow = (setId: string, index: number, n: NewNode | { kind: "anchor"; address: string }): SetNode => ({
  id: `${setId}-${index}`, set_id: setId, index, kind: n.kind,
  agentId: n.kind === "agent" ? n.agentId.toString() : undefined, address: n.kind !== "agent" ? n.address : undefined,
});

/** Reads the keys of the missing indices from the contract (Effect, processing pass only) and writes their SetNode rows.
 *  Returns the rows written. Indices still unreadable stay holes. */
async function repairNodes(context: EvmOnEventContext, contract: string, setId: string, missing: number[]): Promise<SetNode[]> {
  const out: SetNode[] = [];
  const sorted = [...new Set(missing)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length;) {
    let j = i; // contiguous run, at most MAX_KEYS long
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1 && j + 1 - i < MAX_KEYS) j++;
    const from = sorted[i]!;
    const keys = await context.effect(nodeKeysEffect, { contract: lc(contract), setId, from, count: j - i + 1 });
    keys.forEach((k, n) => {
      const node = nodeOfKey(k);
      if (!node) return;
      const row = setNodeRow(setId, from + n, node);
      context.SetNode.set(row);
      out.push(row);
    });
    i = j + 1;
  }
  return out;
}

const holes = (have: Iterable<number>, upTo: number) => {
  const s = new Set(have);
  return [...Array(upTo).keys()].filter((i) => !s.has(i));
};

indexer.onEvent(
  { contract: "AnchoredReputation", event: "AnchorSetRegistered", fields: { transaction: ["hash", "input"] } },
  async ({ event, context }) => {
    const setId = event.params.setId.toLowerCase();
    const health = await context.SetHealth.get(setId);
    if (context.isPreload) return;
    const call = findSetCall(event.transaction.input, setId); // direct or nested: params must hash to setId
    const anchors = event.params.anchors.map(lc); // the event is authoritative for the anchors (node indices 0..k-1)
    context.AnchorSet.set({
      ...blankSet(setId), anchors, lambdas: event.params.lambdas.map(String),
      alphaN: BigInt(event.params.alphaN), alphaD: BigInt(event.params.alphaD), // uint32: never an Int32 column (SW2)
      tagsJson: call ? JSON.stringify(call.tags) : undefined, policyJson: call ? JSON.stringify(call.policy) : undefined,
      ownerFallback: call?.policy.ownerFallback, registryVerified: call?.policy.registryVerified,
      decodable: call !== undefined, nodesComplete: true, nodeCount: anchors.length,
      registeredBlock: BigInt(event.block.number), registeredTx: event.transaction.hash,
    });
    anchors.forEach((address, index) => context.SetNode.set(setNodeRow(setId, index, { kind: "anchor", address })));
    if (!health) context.SetHealth.set(blankHealth(setId));
  },
);

indexer.onEvent(
  { contract: "AnchoredReputation", event: "NodesAdded", fields: { transaction: ["input", "to"] } },
  async ({ event, context }) => {
    const setId = event.params.setId.toLowerCase();
    const set = await context.AnchorSet.get(setId);
    const from = Number(event.params.fromIndex);
    const count = Number(event.params.count);
    let nodes: NewNode[] | undefined;
    try {
      if (isDirect(event.transaction.to, event.srcAddress)) nodes = decodeAppendedNodes(event.transaction.input, setId);
    } catch (e) { if (!(e instanceof EncodingError)) throw e; }
    // _appendNodes reverts on an existing node (NodeExists): a direct call appends exactly `count` entries, in order
    const exact = nodes !== undefined && nodes.length === count;
    // the common case (complete table, exact direct append right after it) never reads the table: no O(n) per event
    const clean = exact && set?.nodesComplete === true && from === (set.nodeCount ?? 0);
    const table = set && !clean ? await context.SetNode.getWhere({ set_id: { _eq: setId } }) : [];
    if (context.isPreload || !set) return;
    const nodeCount = Math.max(set.nodeCount ?? 0, from + count);
    if (exact) nodes!.forEach((n, i) => context.SetNode.set(setNodeRow(setId, from + i, n)));
    if (clean) {
      context.AnchorSet.set({ ...set, nodeCount, nodesComplete: true });
      return;
    }
    const have = new Set(table.map((n) => n.index));
    if (exact) nodes!.forEach((_, i) => have.add(from + i));
    // relayed (or undecodable) append, and any older hole: read the immutable keys from the contract
    const missing = holes(have, nodeCount);
    if (missing.length > 0) for (const r of await repairNodes(context, event.srcAddress, setId, missing)) have.add(r.index);
    context.AnchorSet.set({ ...set, nodeCount, nodesComplete: holes(have, nodeCount).length === 0 });
  },
);

type Status = "AUDITED" | "UNDECODABLE" | "ROOT_MISMATCH" | "UNKNOWN_SET" | "NODES_MISSING";

indexer.onEvent(
  { contract: "AnchoredReputation", event: "CertificateSubmitted", fields: { transaction: ["hash", "from", "input"] } },
  async ({ event, context }) => {
    const p = event.params;
    const setId = p.setId.toLowerCase();
    const id = `${event.transaction.hash}-${event.logIndex}`;
    const nCert = Number(p.nCert);
    const [set, health, table] = await Promise.all([
      context.AnchorSet.get(setId), context.SetHealth.get(setId), context.SetNode.getWhere({ set_id: { _eq: setId } }),
    ]);
    if (context.isPreload) return; // decoding and the audit run once, in the processing pass
    const base = {
      id, set_id: setId, certBlock: p.certBlock, blockNumber: BigInt(event.block.number), txHash: event.transaction.hash,
      submitter: lc(event.transaction.from ?? ZERO), eEff: p.eEff, graphRoot: p.graphRoot, vectorRoot: p.vectorRoot,
      versionHash: p.versionHash, nCert, numRows: Number(p.numRows), registryVerified: p.registryVerified,
      graphRootMatches: undefined as boolean | undefined, rowsChecked: 0, edgesChecked: 0, discrepancyCount: 0,
    };
    if (!set) context.AnchorSet.set(blankSet(setId)); // registered before start_block: keep Certificate.set non-null
    const k = set?.anchors?.length ?? 0;

    // the committed rows: the first candidate call (direct or nested) whose rows hash to graphRoot
    let rows: CertRow[] | undefined;
    let decoded = false;
    for (const c of findCertCalls(event.transaction.input, setId)) {
      try {
        const r = decodeRows(c.rows, nCert, k).rows;
        decoded = true;
        if (c.nCert === nCert && r.length === base.numRows && graphRoot(r.map((x) => x.leaf)).toLowerCase() === p.graphRoot.toLowerCase()) {
          rows = r;
          break;
        }
      } catch (e) { if (!(e instanceof EncodingError)) throw e; }
    }

    let status: Status = "AUDITED";
    let findings: Awaited<ReturnType<typeof auditRows>>["discrepancies"] = [];
    if (!rows) {
      status = decoded ? "ROOT_MISMATCH" : "UNDECODABLE"; // not the committed graph: auditing it would prove nothing
      base.graphRootMatches = decoded ? false : undefined;
    } else if (!set?.tagsJson) {
      status = "UNKNOWN_SET";
      base.graphRootMatches = true;
    } else {
      base.graphRootMatches = true;
      const byIndex = new Map(table.map((n) => [n.index, n]));
      const missing = holes(byIndex.keys(), nCert);
      if (missing.length > 0) {
        for (const r of await repairNodes(context, event.srcAddress, setId, missing)) byIndex.set(r.index, r);
        const nodeCount = Math.max(set.nodeCount ?? 0, nCert);
        context.AnchorSet.set({ ...set, nodeCount, nodesComplete: holes(byIndex.keys(), nodeCount).length === 0 });
      }
      if (holes(byIndex.keys(), nCert).length > 0) status = "NODES_MISSING";
      else {
        const nodes: NodeInfo[] = [];
        for (const [i, n] of byIndex) nodes[i] = n.kind === "agent"
          ? { kind: "agent", agentId: BigInt(n.agentId!) } : { kind: n.kind as "anchor" | "address", address: n.address };
        const schema = setSchema(JSON.parse(set.tagsJson) as SetTag[]);
        const r = await auditRows(storeView(context as never), schema, nodes, nCert, rows,
          { ownerFallback: set.ownerFallback ?? false, registryVerified: p.registryVerified });
        base.rowsChecked = r.rowsChecked;
        base.edgesChecked = r.edgesChecked;
        findings = r.discrepancies;
      }
    }

    base.discrepancyCount = findings.length;
    context.Certificate.set({ ...base, status });
    const big = (x: number | undefined) => (x !== undefined ? BigInt(x) : undefined);
    findings.forEach((d, n) => context.Discrepancy.set({
      id: `${id}-${n}`, certificate_id: id, set_id: setId, kind: d.kind, proof: d.proof,
      provenAtBlock: undefined, u: d.u, dst: d.dst, client: d.client, agentId: d.agentId, wCommitted: d.wCommitted,
      wRegistry: d.wRegistry, bCommitted: big(d.bCommitted), bRegistry: big(d.bRegistry),
      rowPlus: big(d.rowPlus), rowDeclared: big(d.rowDeclared),
      feedbackIndex: big(d.feedbackIndex), registryFeedbackIndex: d.registryFeedbackIndex !== undefined ? BigInt(d.registryFeedbackIndex) : undefined,
    }));
    const h = health ?? blankHealth(setId);
    context.SetHealth.set({
      ...h, certificates: h.certificates + 1, lastCertificate_id: id, lastCertBlock: p.certBlock, lastEEff: p.eEff,
      status: status !== "AUDITED" ? "UNAUDITED" : findings.length > 0 ? "DISCREPANCY" : "CLEAN",
      openDiscrepancies: findings.length, registryChangedAtBlock: undefined, // a new certificate re-reads the registry
    });
  },
);

const DILUTIVE = new Set(["DILUTION", "DEFLATED"]);
const pos = (w: bigint) => (w > 0n ? w : 0n);

/**
 * A proof landed on row `node` of the latest certificate: close what it corrects.
 *  - RowVoided: every finding of the row.
 *  - EdgeProven(node, agentJ): the findings of that exact edge (u, agentJ) whose remedy is proveEdge (SW1: the proof
 *    names the omitted or misstated edge, never a sibling). Then the remaining DILUTION / DEFLATED findings of the row
 *    are re-evaluated on the amended row (positive sum S += wNew+ - wOld+, declared budget likewise for an edge that was
 *    committed): once max(GRID, max(declared, S)) reaches the true B+, the row no longer dilutes (ENCODING §7.1 X bound).
 */
async function remedy(context: EvmOnEventContext, setId: string, node: number,
  edge: { agentId: string; wOld: bigint; wNew: bigint } | undefined, block: number,
  bump: Partial<Pick<SetHealth, "edgesProven" | "rowsVoided">>, eEff: bigint) {
  const h = await context.SetHealth.get(setId);
  const open = h?.lastCertificate_id ? await context.Discrepancy.getWhere({ set_id: { _eq: setId } }) : [];
  if (context.isPreload || !h) return;
  let closed = 0;
  const close = (d: Discrepancy, extra: Partial<Discrepancy> = {}) => {
    context.Discrepancy.set({ ...d, ...extra, provenAtBlock: BigInt(block) });
    closed++;
  };
  const row = open.filter((d) => d.certificate_id === h.lastCertificate_id && d.provenAtBlock === undefined && d.u === node);
  const rest: Discrepancy[] = [];
  for (const d of row) {
    if (!edge) close(d);
    else if (d.proof === "proveEdge" && d.agentId === edge.agentId) close(d);
    else rest.push(d);
  }
  if (edge) {
    const dPlus = pos(edge.wNew) - pos(edge.wOld);
    for (const d of rest) {
      if (!DILUTIVE.has(d.kind) || d.rowPlus === undefined || d.rowDeclared === undefined || d.bRegistry === undefined) continue;
      const rowPlus = d.rowPlus + dPlus;
      const rowDeclared = d.rowDeclared + (edge.wOld !== 0n ? dPlus : 0n);
      const budget = [GRID, rowPlus, rowDeclared].reduce((m, x) => (x > m ? x : m));
      if (budget >= d.bRegistry) close(d, { rowPlus, rowDeclared, bCommitted: budget });
      else context.Discrepancy.set({ ...d, rowPlus, rowDeclared, bCommitted: budget });
    }
  }
  const openLeft = Math.max(0, h.openDiscrepancies - closed);
  context.SetHealth.set({
    ...h, edgesProven: h.edgesProven + (bump.edgesProven ?? 0), rowsVoided: h.rowsVoided + (bump.rowsVoided ?? 0), lastEEff: eEff,
    openDiscrepancies: openLeft, status: h.status === "DISCREPANCY" && openLeft === 0 ? "CLEAN" : h.status,
  });
}

indexer.onEvent({ contract: "AnchoredReputation", event: "EdgeProven" }, async ({ event, context }) => {
  const p = event.params;
  await remedy(context, p.setId.toLowerCase(), Number(p.node), { agentId: p.agentId.toString(), wOld: p.wOld, wNew: p.wNew },
    event.block.number, { edgesProven: 1 }, p.eEff);
});

indexer.onEvent({ contract: "AnchoredReputation", event: "RowVoided" }, async ({ event, context }) => {
  const p = event.params;
  await remedy(context, p.setId.toLowerCase(), Number(p.node), undefined, event.block.number, { rowsVoided: 1 }, p.eEff);
});

indexer.onEvent({ contract: "AnchoredReputation", event: "TransferFlagged" }, async ({ event, context }) => {
  const setId = event.params.setId.toLowerCase();
  const h = await context.SetHealth.get(setId);
  if (context.isPreload || !h) return;
  context.SetHealth.set({ ...h, transfersFlagged: h.transfersFlagged + 1 });
});

indexer.onEvent({ contract: "AnchoredReputation", event: "RegistryChanged" }, async ({ event, context }) => {
  const setId = event.params.setId.toLowerCase();
  const h = await context.SetHealth.get(setId);
  if (context.isPreload || !h) return;
  context.SetHealth.set({ ...h, status: "STALE", registryChangedAtBlock: BigInt(event.block.number) });
});
