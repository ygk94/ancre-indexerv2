// Parity and audit on REAL Monad history without HyperSync: the layer-1 dump of the indexer (solver/tests/fixtures/indexer)
// is replayed through the current handlers (test/replay.ts). Monorepo only (skipped when the dump is absent).
//   1. reference edges at block 108 434 518 == solver/graph.py (fixture test/fixtures/ref_edges_143_108434518.json);
//   2. certificate audit of the normative vectors at their identity block 108 835 675: honest = 0 finding,
//      violations = their kind ON THE EDGE THAT PROVES THEM (dilution: the omitted #18 -> #3, review 06/10 SW1).
// ANCRE_VECTORS=<solver dir> points 2. at another solver tree (e.g. the 04-bis one, vectors regenerated under D48 at
// 110 994 810, past the dump): its data/mainnet-<block>.{feedbacks,identity}.json.gz snapshot then completes the replay.
// The vectors of main (01/10, block 108 835 675) predate D48-A: mainnet_slash_anchor makes the anchor 0xea0b the source of
// #18, which the 02-bis contract refuses (AnchorAsSource, vector common_A_mainnet_old_slash_anchor): the audit says SHAPE.
import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { auditRows, type NodeInfo, type RegistryView } from "../src/lib/audit.js";
import { decodeRows, type CertRow } from "../src/lib/certificate.js";
import { setSchema, storeView } from "../src/lib/view.js";
import { dumpBlock, hasDump, historyItems, snapshotTail } from "./replay.js";

const SOLVER = process.env.ANCRE_VECTORS ? pathToFileURL(process.env.ANCRE_VECTORS.replace(/\/?$/, "/"))
  : new URL("../../solver/", import.meta.url);
const VEC = new URL("vectors/", SOLVER);
const load = (f: string) => JSON.parse(readFileSync(new URL(f, VEC), "utf8"));

async function replay(upTo: number) {
  const ix = createTestIndexer();
  const items = historyItems(upTo);
  if (upTo > dumpBlock()) {
    const snap = (x: string) => new URL(`data/mainnet-${upTo}.${x}.json.gz`, SOLVER);
    if (!existsSync(snap("feedbacks"))) throw new Error(`block ${upTo} is past the dump and no snapshot completes it`);
    items.push(...snapshotTail(snap("feedbacks").pathname, snap("identity").pathname, upTo));
  }
  await ix.process({ chains: { 143: { simulate: items as never } } as never });
  return ix;
}

describe.runIf(hasDump())("offline replay of the real Monad history (dump of the indexer)", () => {
  it("reference edges at block 108 434 518 == solver/graph.py", async (t) => {
    const REF = JSON.parse(readFileSync(new URL("./fixtures/ref_edges_143_108434518.json", import.meta.url), "utf8"));
    const ix = await replay(REF.block);
    const edges = (await ix.SetEdge.getAll())
      .filter((e) => e.set_id === "ref" && e.rejected === undefined && e.w !== 0)
      .map((e) => ({ client: e.client, agent: e.agent_id, w: e.w, tag1: e.decidingTag, feedbackIndex: String(e.feedbackIndex) }))
      .sort((a, b) => (a.client < b.client ? -1 : a.client > b.client ? 1 : Number(a.agent) - Number(b.agent)));
    t.expect(edges).toEqual(REF.edges);
    const s = await ix.ChainStats.getOrThrow("stats");
    t.expect([s.agents, s.feedbacks, s.selfRatings]).toEqual([REF.counts.agentsMinted, REF.counts.feedbacks, 78]);
  }, 300_000);

  it.runIf(existsSync(VEC))("certificate audit of the normative vectors at their identity block", async (t) => {
    const BLOCK = load("mainnet_slash_anchor.json").identityBlock as number;
    const preD48 = BLOCK === 108_835_675;
    const ix = await replay(BLOCK);
    const view: RegistryView = storeView(ix as never);
    const anchorSourced = (d: { kind: string; note?: string }) => d.kind === "SHAPE" && /AnchorAsSource/.test(d.note ?? "");
    const audit = async (f: string) => {
      const v = load(f);
      t.expect(v.identityBlock, f).toBe(BLOCK);
      const k = v.set.anchors.length;
      const nodes: NodeInfo[] = v.nodes.map((n: any) =>
        n.kind === "agent" ? { kind: "agent", agentId: BigInt(n.agentId) } : { kind: n.kind, address: n.address.toLowerCase() });
      return (await auditRows(view, setSchema(v.set.tags), nodes, v.nCert, decodeRows(v.calldata.rows, v.nCert, k).rows,
        { ownerFallback: v.set.policy.ownerFallback, registryVerified: v.set.policy.registryVerified })).discrepancies
        .filter((d) => !(preD48 && anchorSourced(d)));
    };
    if (preD48) { // the one finding a pre-D48 vector gets: the row the 02-bis contract refuses
      const v = load("mainnet_slash_anchor.json");
      const nodes: NodeInfo[] = v.nodes.map((n: any) =>
        n.kind === "agent" ? { kind: "agent", agentId: BigInt(n.agentId) } : { kind: n.kind, address: n.address.toLowerCase() });
      const all = (await auditRows(view, setSchema(v.set.tags), nodes, v.nCert, decodeRows(v.calldata.rows, v.nCert, 2).rows,
        { ownerFallback: false })).discrepancies;
      t.expect(all.map((d) => [d.kind, d.agentId, anchorSourced(d)])).toEqual([["SHAPE", "18", true]]);
    }
    for (const f of ["mainnet_slash_anchor.json", "mainnet_honest_d20.json", "mainnet_scanner_preD15.json", "mainnet_em_d44.json"]) {
      t.expect((await audit(f)).map((d) => [d.kind, d.u, d.agentId, d.note]), f).toEqual([]);
    }
    const kinds = async (f: string) => (await audit(f)).map((d) => [d.kind, d.agentId, d.proof]);
    t.expect(await kinds("violations/fabricated.json")).toEqual([["FABRICATED", "4", "proveEdge"]]);
    t.expect(await kinds("violations/inflated.json")).toEqual([["INFLATED", "4", "proveEdge"]]);
    const om = await kinds("violations/omitted_negative.json");
    t.expect(om.length > 0 && om.every((d) => d[0] === "OMITTED_NEG" && d[1] === "4")).toBe(true);
    const dil = (await audit("violations/dilution.json")).map((d) => [d.kind, d.agentId, d.bCommitted, d.bRegistry, d.proof]);
    t.expect(dil).toEqual([["DILUTION", "3", 10_000, 20_000, "proveEdge"]]); // the omitted edge #18 -> #3, not its sibling #2
  }, 300_000);

  // port of the tampered variants of test/audit.test.ts (section 3), on main's vectors (anchor 0xea0b = row 1)
  it.runIf(existsSync(VEC) && load("mainnet_slash_anchor.json").identityBlock === 108_835_675)("tampered variants of slash_anchor", async (t) => {
    const ix = await replay(108_835_675);
    const view: RegistryView = storeView(ix as never);
    const v = load("mainnet_slash_anchor.json");
    const nodes0: NodeInfo[] = v.nodes.map((n: any) =>
      n.kind === "agent" ? { kind: "agent", agentId: BigInt(n.agentId) } : { kind: n.kind, address: n.address.toLowerCase() });
    const rows0 = decodeRows(v.calldata.rows, v.nCert, 2).rows;
    const audit = async (rows: CertRow[], nodes = nodes0) => (await auditRows(view, setSchema(v.set.tags), nodes, v.nCert, rows,
      { ownerFallback: false })).discrepancies.filter((d) => !(d.kind === "SHAPE" && /AnchorAsSource/.test(d.note ?? "")));
    const node = (agentId: number) => nodes0.findIndex((n) => n.kind === "agent" && n.agentId === BigInt(agentId));
    const clone = (): CertRow[] => rows0.map((r) => ({ ...r, edges: r.edges.map((e) => ({ ...e })) }));
    const ea0b = 1;
    const declared = clone();
    const r1 = declared.find((r) => r.u === ea0b)!;
    r1.edges = r1.edges.filter((e) => e.dst !== node(2));
    r1.sPlusEffective = 10_000;
    t.expect((await audit(declared)).map((d) => [d.kind, d.agentId, d.proof])).toEqual([["DILUTION", "2", "proveEdge"]]);
    r1.sPlusEffective = 20_000;
    t.expect(await audit(declared)).toEqual([]);
    const opp = clone();
    opp.find((r) => r.u === ea0b)!.edges.find((e) => e.dst === node(2))!.w = -10_000;
    t.expect((await audit(opp)).map((d) => [d.kind, d.agentId])).toContainEqual(["FABRICATED", "2"]);
    const sm = clone();
    sm.find((r) => r.u === node(2))!.src = undefined;
    t.expect((await audit(sm)).map((d) => d.kind)).toEqual(["SOURCE_MISSING"]);
    const hide = clone();
    const r18 = hide.find((r) => r.u === node(18))!;
    r18.src = "0x000000000000000000000000000000000000dead";
    r18.edges = [];
    r18.sPlusEffective = 0;
    t.expect((await audit(hide)).map((d) => [d.kind, d.agentId, d.proof])).toEqual(
      [["SOURCE", "18", "proveWallet"], ["DILUTION", "2", "proveWallet"], ["DILUTION", "3", "proveWallet"],
        ["OMITTED_NEG", "4", "proveWallet"]]); // every omission of the true client is shown; proveWallet voids the row
    const ghostNodes = nodes0.map((n, i) => (i === node(3) ? { kind: "agent" as const, agentId: 999_999n } : n));
    const ghost = clone();
    ghost.find((r) => r.u === node(3))!.edges = [{ dst: node(4), w: 10_000, feedbackIndex: 1 }];
    t.expect((await audit(ghost, ghostNodes)).map((d) => [d.kind, d.u])).toEqual(
      [["FABRICATED", ea0b], ["DILUTION", ea0b], ["UNKNOWN_AGENT", node(3)], ["FABRICATED", node(3)], ["FABRICATED", node(18)],
       ["DILUTION", node(18)]]); // the true edge to the real #3 is now missing from both rows: diluted once the ghost is proven
  }, 300_000);
});
