// E4: audit of real certificates (solver/vectors, format ancre-cert-v1) against the Monad registry state the indexer
// rebuilt from real history (HyperSync) at the vectors' identity block (108 835 675). The 4 honest mainnet vectors
// must give 0 discrepancy; the 4 normative violation vectors (D37) must each be caught with the right kind.
// Slow-ish (real history): runs with `pnpm test:parity`.
import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { existsSync, readFileSync } from "node:fs";
import { auditRows, type NodeInfo, type RegistryView } from "../src/lib/audit.js";
import { decodeRows, type CertRow } from "../src/lib/certificate.js";
import { setSchema, storeView } from "../src/lib/view.js";

const LOCAL = new URL("./vectors/", import.meta.url); // standalone repo; ../../solver/vectors in the monorepo
const DIR = existsSync(LOCAL) ? LOCAL : new URL("../../solver/vectors/", import.meta.url);
const BLOCK = 108_835_675;
const load = (f: string) => JSON.parse(readFileSync(new URL(f, DIR), "utf8"));

function prepare(v: any) {
  const k = v.set.anchors.length;
  const nodes: NodeInfo[] = v.nodes.map((n: any) =>
    n.kind === "agent" ? { kind: "agent", agentId: BigInt(n.agentId) } : { kind: n.kind, address: n.address.toLowerCase() });
  return { k, nodes, schema: setSchema(v.set.tags), rows: decodeRows(v.calldata.rows, v.nCert, k).rows,
    opts: { ownerFallback: v.set.policy.ownerFallback as boolean } };
}

describe.runIf(process.env.PARITY === "1" && existsSync(DIR))("certificate audit on real Monad state (format v1)", () => {
  it("honest vectors: 0 discrepancy; violation vectors and tampered variants: caught", async (t) => {
    const ix = createTestIndexer();
    await ix.process({ chains: { 143: { startBlock: 52_952_790, endBlock: BLOCK } } });
    const view: RegistryView = storeView(ix as never);
    const audit = async (v: any, rows?: CertRow[], nodes?: NodeInfo[]) => {
      const p = prepare(v);
      return auditRows(view, p.schema, nodes ?? p.nodes, v.nCert, rows ?? p.rows, p.opts);
    };

    // 1. honest certificates, Registry-verified, as accepted on chain by the contract (FORMAT.md §5)
    for (const f of ["mainnet_slash_anchor.json", "mainnet_honest_d20.json", "mainnet_scanner_preD15.json", "mainnet_em_d44.json"]) {
      const v = load(f);
      t.expect(v.identityBlock).toBe(BLOCK);
      const a = await audit(v);
      t.expect(a.discrepancies, f).toEqual([]);
      t.expect(a.edgesChecked, f).toBe(v.rows.reduce((s: number, r: any) => s + r.edges.length, 0));
    }

    // 2. the four normative violations (D37, FORMAT.md §6)
    const kinds = async (f: string) => (await audit(load(f))).discrepancies.map((d) => [d.kind, d.agentId]);
    t.expect(await kinds("violations/fabricated.json")).toEqual([["FABRICATED", "4"]]);              // 0x0730 -> #4, no feedback
    t.expect(await kinds("violations/inflated.json")).toEqual([["INFLATED", "4"]]);                  // #18's slash on #4 committed as -1
    t.expect(await kinds("violations/omitted_negative.json")).toEqual([["OMITTED_NEG", "4"], ["OMITTED_NEG", "4"]]); // anchor row + copy
    const dil = (await audit(load("violations/dilution.json"))).discrepancies;                         // #18 -> #3 omitted, sPlus undeclared
    t.expect(dil.map((d) => [d.kind, d.agentId, d.bCommitted, d.bRegistry])).toEqual([["INFLATED", "2", 10_000, 20_000]]);

    // 3. tampered variants of the honest slash_anchor certificate
    const v = load("mainnet_slash_anchor.json");
    const p = prepare(v);
    const node = (agentId: number) => p.nodes.findIndex((n) => n.kind === "agent" && n.agentId === BigInt(agentId));
    const clone = (): CertRow[] => p.rows.map((r) => ({ ...r, edges: r.edges.map((e) => ({ ...e })) }));
    const ea0b = 1; // anchor 0xea0b, row u = 1

    // declaring the true sPlus makes an omission of a positive edge harmless (no dilution, D32)
    const declared = clone();
    const r1 = declared.find((r) => r.u === ea0b)!;
    r1.edges = r1.edges.filter((e) => e.dst !== node(2));
    r1.sPlusEffective = 10_000; // not declared: B+ falls back to the committed sum
    t.expect((await audit(v, declared)).discrepancies.map((d) => [d.kind, d.agentId])).toEqual([["INFLATED", "3"]]); // undeclared: diluted
    r1.sPlusEffective = 20_000;
    t.expect((await audit(v, declared)).discrepancies).toEqual([]);                                     // declared: fine

    // opposite sign: a slash invented where the registry holds a +10000 vouch -> FABRICATED
    const opp = clone();
    opp.find((r) => r.u === ea0b)!.edges.find((e) => e.dst === node(2))!.w = -10_000;
    t.expect((await audit(v, opp)).discrepancies.map((d) => [d.kind, d.agentId])).toContainEqual(["FABRICATED", "2"]);

    // an agent row without SRC although agentWallet != 0 -> SOURCE_MISSING
    const sm = clone();
    sm.find((r) => r.u === node(2))!.src = undefined;
    t.expect((await audit(v, sm)).discrepancies.map((d) => d.kind)).toEqual(["SOURCE_MISSING"]);

    // a wrong source must not hide the omissions of the true client (#18 speaks for 0xea0b under D20)
    const hide = clone();
    const r18 = hide.find((r) => r.u === node(18))!;
    r18.src = "0x000000000000000000000000000000000000dead";
    r18.edges = [];
    r18.sPlusEffective = 0;
    t.expect((await audit(v, hide)).discrepancies.map((d) => [d.kind, d.agentId])).toEqual([["SOURCE", "18"], ["OMITTED_NEG", "4"]]);

    // a row for an agent node never minted -> UNKNOWN_AGENT; every edge to it is FABRICATED (no silent skip)
    const ghostNodes = p.nodes.map((n, i) => (i === node(3) ? { kind: "agent" as const, agentId: 999_999n } : n));
    const ghost = clone();
    ghost.find((r) => r.u === node(3))!.edges = [{ dst: node(4), w: 10_000, feedbackIndex: 1 }];
    t.expect((await audit(v, ghost, ghostNodes)).discrepancies.map((d) => [d.kind, d.u])).toEqual(
      [["FABRICATED", ea0b], ["UNKNOWN_AGENT", node(3)], ["FABRICATED", node(3)], ["FABRICATED", node(18)]]);
  }, 900_000);
});
