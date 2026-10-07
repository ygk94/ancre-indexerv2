// Non-regression tests for the findings of the 06/10 maximal review on the indexer (docs/revue/revue-max-2026-10-06-complete.md,
// journal docs/chantiers/journal/indexer-revue.md): SW2, NUL, LONGTAG, REGCB, SW1, DECODE, DEC18, rule B (D48-B), SEQ.
// Simulated events, no network (the node-table repair is pointed at a local JSON-RPC server).
import { afterAll, beforeAll, describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeFunctionData, keccak256, stringToBytes, toFunctionSelector, type Hex } from "viem";
import abi from "../abis/AnchoredReputation.json" with { type: "json" };
import { decodeRows, graphRoot } from "../src/lib/certificate.js";
import { decodeSetCall, findCertCalls, findSetCall } from "../src/lib/calls.js";
import { combine, quantize, REF_SCHEMA } from "../src/lib/rules.js";
import { TEXT_MAX, safeText, schemaTagHash } from "../src/lib/text.js";
import { startMockRpc, type MockRpc } from "./rpcmock.js";

const CHAIN = 10143;
const ZERO: Hex = "0x0000000000000000000000000000000000000000";
const A: Hex = "0x00000000000000000000000000000000000000aa";
const B: Hex = "0x00000000000000000000000000000000000000bb";
const O1: Hex = "0x1111111111111111111111111111111111111111";
const W1: Hex = "0x2222222222222222222222222222222222222222";
const O2: Hex = "0x3333333333333333333333333333333333333333";
const C: Hex = "0x5555555555555555555555555555555555555555";
const E18 = 10n ** 18n;
const tx = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;

const mint = (tokenId: bigint, to: Hex, hash?: Hex) => ({ contract: "IdentityRegistry" as const, event: "Transfer" as const,
  ...(hash ? { transaction: { hash } } : {}), params: { from: ZERO, to, tokenId } });
const setWallet = (agentId: bigint, wallet: Hex, hash?: Hex) => ({ contract: "IdentityRegistry" as const, event: "MetadataSet" as const,
  ...(hash ? { transaction: { hash } } : {}), params: { agentId, indexedMetadataKey: "", metadataKey: "agentWallet", metadataValue: wallet } });
const fb = (agentId: bigint, client: Hex, feedbackIndex: bigint, value: bigint, tag1: string, topic = true) => ({
  contract: "ReputationRegistry" as const, event: "NewFeedback" as const,
  params: { agentId, clientAddress: client, feedbackIndex, value, valueDecimals: 0n,
    indexedTag1: topic ? keccak256(stringToBytes(tag1)) : "", tag1, tag2: "", endpoint: "", feedbackURI: "",
    feedbackHash: ("0x" + "00".repeat(32)) as Hex } });

async function run(items: unknown[]) {
  const ix = createTestIndexer();
  await ix.process({ chains: { [CHAIN]: { simulate: items as never } } as never });
  return ix;
}

let rpc: MockRpc;
beforeAll(async () => { rpc = await startMockRpc(); process.env.ENVIO_MONAD_TESTNET_RPC = rpc.url; });
afterAll(async () => { await rpc.close(); });

describe("SW2: uint32 alphaN / alphaD never go to an Int32 column", () => {
  it("schema declares them BigInt, and a 3e9 alphaD is stored exactly", async (t) => {
    const schema = readFileSync(new URL("../schema.graphql", import.meta.url), "utf8");
    for (const f of ["alphaN", "alphaD", "bCommitted", "bRegistry"]) t.expect(schema).toMatch(new RegExp(`\\n\\s+${f}: BigInt\\b`));
    const ix = await run([{ contract: "AnchoredReputation", srcAddress: CONTRACT, event: "AnchorSetRegistered",
      transaction: { input: "0x", hash: tx(9) },
      params: { setId: ("0x" + "ab".repeat(32)) as Hex, anchors: [A, B], lambdas: [E18 / 2n, E18 / 2n], alphaN: 1n, alphaD: 3_000_000_000n } }]);
    const set = await ix.AnchorSet.getOrThrow("0x" + "ab".repeat(32));
    t.expect([set.alphaN, set.alphaD]).toEqual([1n, 3_000_000_000n]);
  });
});

describe("NUL / LONGTAG: tags are keyed by keccak256, never by their text", () => {
  it("'x' and 'x\\0' are two triples; 'vouch\\0' is never a vouch; the stored text is NUL-free and flagged", async (t) => {
    const ix = await run([mint(2n, O2), fb(2n, A, 1n, 50n, "x"), fb(2n, A, 2n, 50n, "x\u0000"), fb(2n, B, 1n, 100n, "vouch\u0000")]);
    const triples = await ix.TripleLatest.getAll();
    t.expect(new Set(triples.map((x) => x.id)).size).toBe(3);
    t.expect(triples.every((x) => !x.id.includes("\u0000") && !x.tag1.includes("\u0000"))).toBe(true);
    const f = await ix.Feedback.getOrThrow(`2-${B}-1`);
    t.expect([f.tag1, f.tag1Exact, f.tagHash]).toEqual(["vouch\\u0000", false, keccak256(stringToBytes("vouch\u0000"))]);
    t.expect(await ix.SetEdge.get(`ref-${B}-2`)).toBeUndefined(); // not the reference tag "vouch"
    t.expect((await ix.Feedback.getOrThrow(`2-${A}-1`)).tag1Exact).toBe(true);
  });

  it("a 4 KiB tag gives a fixed-length key and a truncated, flagged display text", async (t) => {
    const long = "z".repeat(4096);
    const ix = await run([mint(2n, O2), fb(2n, A, 1n, 50n, long)]);
    const f = await ix.Feedback.getOrThrow(`2-${A}-1`);
    t.expect(f.triple.length).toBeLessThan(200);
    t.expect([f.tag1Exact, stringToBytes(f.tag1).length <= TEXT_MAX]).toEqual([false, true]);
    t.expect((await ix.TripleLatest.getAll())[0]!.id).toBe(`${A}-2-${keccak256(stringToBytes(long))}`);
  });

  it("the indexedTag1 topic is the identity even when the event carries no topic (computed) or lossy text", async (t) => {
    const ix = await run([mint(2n, O2), fb(2n, A, 1n, 100n, "vouch", false)]); // no topic: hash computed from the text
    t.expect((await ix.SetEdge.getOrThrow(`ref-${A}-2`)).w).toBe(10_000);
    t.expect(safeText("\uD800x")).toEqual({ text: "\\ud800x", exact: false }); // lone surrogate escaped
  });
});

describe("rule B (D48-B) and DEC18 in the edge rules", () => {
  it("a controller's negative edge is kept; its positive edge is rejected", async (t) => {
    const ix = await run([mint(4n, O1), setWallet(4n, W1), fb(4n, O1, 1n, -100n, "slash"), fb(4n, W1, 1n, 100n, "vouch")]);
    const neg = await ix.SetEdge.getOrThrow(`ref-${O1}-4`);
    t.expect([neg.w, neg.rejected, neg.decidingTag]).toEqual([-10_000, undefined, "slash"]);
    const p = await ix.SetEdge.getOrThrow(`ref-${W1}-4`);
    t.expect([p.w, p.rejected]).toEqual([0, "CONTROLLER_WALLET"]);
    // the owner flips to a positive: rejected again (sign of the combination)
    await ix.process({ chains: { [CHAIN]: { simulate: [fb(4n, O1, 2n, 100n, "slash"), fb(4n, O1, 3n, 100n, "vouch")] } } as never });
    t.expect((await ix.SetEdge.getOrThrow(`ref-${O1}-4`)).rejected).toBe("CONTROLLER_OWNER");
  });

  it("valueDecimals > 18 gives nothing for that tag (no exception), like the contract's _normalize", (t) => {
    t.expect(quantize(1n, 19, REF_SCHEMA.get("vouch")!)).toBeUndefined();
    t.expect(combine([{ tag1: "vouch", value: 1n, decimals: 19, feedbackIndex: 1n }])).toEqual({ kind: "none", reason: "OUT_OF_BOUNDS" });
    t.expect(combine([{ tag1: "vouch", value: 1n, decimals: 19, feedbackIndex: 2n }, { tag1: "review", value: 1n, decimals: 0, feedbackIndex: 1n }]))
      .toEqual({ kind: "edge", w: 10_000, tag1: "review", feedbackIndex: 1n });
  });

  it("SEQ: every reference edge into an agent is recomputed when a controller changes", async (t) => {
    const ix = await run([mint(4n, O1), fb(4n, A, 1n, 100n, "vouch"), fb(4n, B, 1n, 100n, "vouch"), fb(4n, C, 1n, 100n, "vouch")]);
    t.expect((await ix.ChainStats.getOrThrow("stats")).refEdges).toBe(3);
    await ix.process({ chains: { [CHAIN]: { simulate: [{ contract: "IdentityRegistry", event: "ApprovalForAll",
      params: { owner: O1, operator: B, approved: true } }] } } as never });
    t.expect((await ix.SetEdge.getOrThrow(`ref-${B}-4`)).rejected).toBe("CONTROLLER_OPERATOR");
    t.expect((await ix.ChainStats.getOrThrow("stats")).refEdges).toBe(2);
  });
});

describe("REGCB: register() emits its wallet after the ERC-721 callback", () => {
  const registered = (agentId: bigint, hash: Hex) => ({ contract: "IdentityRegistry" as const, event: "Registered" as const,
    transaction: { hash }, params: { agentId, agentURI: "ipfs://x", owner: C } });
  it("a wallet unset in the callback stays unset; a plain registration keeps msg.sender", async (t) => {
    const T = tx(1);
    const ix = await run([
      mint(7n, C, T), setWallet(7n, "0x" as Hex, T), registered(7n, T), setWallet(7n, C, T), // unset in onERC721Received
      mint(8n, C, tx(2)), registered(8n, tx(2)), setWallet(8n, C, tx(2)),                    // plain register()
    ]);
    t.expect((await ix.Agent.getOrThrow("7")).wallet).toBe(ZERO);
    t.expect((await ix.Agent.getOrThrow("8")).wallet).toBe(C);
    const changes = (await ix.WalletChange.getAll()).filter((w) => w.agent_id === "7").map((w) => w.wallet);
    t.expect(changes).toEqual([ZERO]); // the stale MetadataSet(C) is not replayed by from_indexer either
    // a later wallet change in another transaction applies normally
    await ix.process({ chains: { [CHAIN]: { simulate: [setWallet(7n, W1, tx(3))] } } as never });
    t.expect((await ix.Agent.getOrThrow("7")).wallet).toBe(W1);
  });
  it("a transfer in the callback: owner D, wallet cleared, the late MetadataSet(C) ignored", async (t) => {
    const T = tx(4);
    const D: Hex = "0x6666666666666666666666666666666666666666";
    const ix = await run([mint(9n, C, T),
      { contract: "IdentityRegistry", event: "Transfer", transaction: { hash: T }, params: { from: C, to: D, tokenId: 9n } },
      setWallet(9n, "0x" as Hex, T), registered(9n, T), setWallet(9n, C, T)]);
    const a = await ix.Agent.getOrThrow("9");
    t.expect([a.owner, a.wallet]).toEqual([D, ZERO]);
  });
});

// ---- certificates (same harness as test/ancre.test.ts)
const be = (v: number, n: number) => v.toString(16).padStart(2 * n, "0");
const i16 = (w: number) => be(w < 0 ? w + 0x10000 : w, 2);
type Row = { u: number; src?: Hex; sPlus?: number; edges: [dst: number, w: number, fi: number][] };
function encodeRows(rows: Row[]): Hex { // W = 2; src given (even 0x0) => SRC bit + 20 bytes
  let h = be(2, 1) + be(rows.length, 4);
  for (const r of rows) {
    const hdr = (r.src !== undefined ? 0x8000 : 0) | (r.sPlus !== undefined ? 0x4000 : 0) | r.edges.length;
    h += be(r.u, 2) + be(hdr, 2) + (r.src !== undefined ? r.src.slice(2) : "") + (r.sPlus !== undefined ? be(r.sPlus, 4) : "");
    for (const [dst, w, fi] of r.edges) h += be(dst, 2) + i16(w) + be(fi, 4);
  }
  return ("0x" + h) as Hex;
}
const agentNodes = (...ids: number[]) => ("0x" + ids.map((id) => "01" + be(id, 4)).join("")) as Hex;
const policy = { theta: E18 / 1000n, rhoN: 1, rhoD: 2, minAnchors: 2, vetoQuorum: 1, vetoMax: -1, maxAge: 288000n,
  minRefresh: 288000n, slackRefresh: 0n, eLowMax: E18 / 100n, strictTransfer: true, registryVerified: true,
  ownerFallback: false, submitters: [] as Hex[] };
const registerInput = encodeFunctionData({ abi, functionName: "registerAnchorSet", args: [{
  anchors: [A, B], lambdas: [E18 / 2n, E18 / 2n], alphaN: 1, alphaD: 3, tagSchemaHash: ("0x" + "00".repeat(32)) as Hex,
  tags: [{ tag: "vouch", min: 0n, neutral: 0n, max: 100n * E18, kind: 0 }], policy }] });
const SET_ID = decodeSetCall(registerInput)!.setId;
const CONTRACT: Hex = "0x8be6d3dd7f20b94cd9b1ec51de199291b109da9b"; // official testnet instance (config.yaml, 07/10)
const ANCRE = { contract: "AnchoredReputation" as const, srcAddress: CONTRACT };
const NCERT = 5; // 0 = A, 1 = B, 2 = #1 (wallet W1), 3 = #2, 4 = #3
const certInput = (rows: Row[]) => encodeFunctionData({ abi, functionName: "submitCertificate",
  args: [SET_ID, NCERT, E18, agentNodes(1, 2, 3), "0x", encodeRows(rows)] });
const rootOf = (rows: Row[]) => graphRoot(decodeRows(encodeRows(rows)).rows.map((r) => r.leaf));
function world() {
  return [
    mint(1n, O1), setWallet(1n, W1), mint(2n, O2), mint(3n, O2),
    fb(1n, A, 1n, 100n, "vouch"), fb(1n, B, 1n, 100n, "vouch"), fb(2n, W1, 1n, 100n, "vouch"), fb(3n, W1, 1n, 100n, "vouch"),
    { ...ANCRE, event: "AnchorSetRegistered" as const, transaction: { input: registerInput, hash: tx(100) },
      params: { setId: SET_ID, anchors: [A, B], lambdas: [E18 / 2n, E18 / 2n], alphaN: 1n, alphaD: 3n } },
  ];
}
const submit = (rows: Row[], n = 2) => {
  const input = certInput(rows);
  return [
    { ...ANCRE, event: "NodesAdded" as const, transaction: { input, to: CONTRACT }, params: { setId: SET_ID, fromIndex: 2n, count: 3n } },
    { ...ANCRE, event: "CertificateSubmitted" as const, transaction: { input, from: C, hash: tx(200 + n) },
      params: { setId: SET_ID, certBlock: 1n, eEff: 15n, graphRoot: rootOf(rows), vectorRoot: ("0x" + "00".repeat(32)) as Hex,
        versionHash: ("0x" + "00".repeat(32)) as Hex, nCert: BigInt(NCERT), numRows: BigInt(rows.length), registryVerified: true } },
  ];
};
const ANCHORS: Row[] = [{ u: 0, edges: [[2, 10_000, 1]] }, { u: 1, edges: [[2, 10_000, 1]] }];
const findings = async (ix: Awaited<ReturnType<typeof run>>) =>
  (await ix.Discrepancy.getAll()).map((d) => [d.kind, d.u, d.agentId, d.wCommitted, d.wRegistry, d.proof]);

describe("SW1: a dilution is filed on the OMITTED edge, with the proof that closes it", () => {
  it("W1 vouches #2 and #3, the row commits only #2: DILUTION on #3 (proveEdge), never INFLATED on #2", async (t) => {
    const rows: Row[] = [...ANCHORS, { u: 2, src: W1, edges: [[3, 10_000, 1]] }];
    const ix = await run([...world(), ...submit(rows)]);
    t.expect(await findings(ix)).toEqual([["DILUTION", 2, "3", 0, 10_000, "proveEdge"]]);
    const d = (await ix.Discrepancy.getAll())[0]!;
    t.expect([d.bCommitted, d.bRegistry, d.dst]).toEqual([10_000n, 20_000n, 4]);
    // proveEdge(u = 2, agentJ = #3): the finding closes and the set is CLEAN again
    await ix.process({ chains: { [CHAIN]: { simulate: [{ ...ANCRE, event: "EdgeProven",
      params: { setId: SET_ID, node: 2n, agentId: 3n, wOld: 0n, wNew: 10_000n, eLowEff: 20n, eEff: 20n } }] } } as never });
    const h = await ix.SetHealth.getOrThrow(SET_ID);
    t.expect([h.status, h.openDiscrepancies, h.edgesProven]).toEqual(["CLEAN", 0, 1]);
  });

  it("a proof on a sibling edge does not close it; a declared sPlus makes the omission harmless", async (t) => {
    const rows: Row[] = [...ANCHORS, { u: 2, src: W1, edges: [[3, 10_000, 1]] }];
    const ix = await run([...world(), ...submit(rows)]);
    await ix.process({ chains: { [CHAIN]: { simulate: [{ ...ANCRE, event: "EdgeProven",
      params: { setId: SET_ID, node: 2n, agentId: 2n, wOld: 10_000n, wNew: 5_000n, eLowEff: 20n, eEff: 20n } }] } } as never });
    t.expect((await ix.SetHealth.getOrThrow(SET_ID)).status).toBe("DISCREPANCY");
    const declared: Row[] = [...ANCHORS, { u: 2, src: W1, sPlus: 20_000, edges: [[3, 10_000, 1]] }];
    const ok = await run([...world(), ...submit(declared)]);
    t.expect(await findings(ok)).toEqual([]);
  });

  it("two omissions: proving one re-evaluates the other on the amended row", async (t) => {
    // W1 also vouches #4 (+10000): true B+ = 30 000; the row commits only #2 (B+ 10 000)
    const extra = [mint(4n, O2), fb(4n, W1, 1n, 100n, "vouch")];
    const rows: Row[] = [...ANCHORS, { u: 2, src: W1, edges: [[3, 10_000, 1]] }];
    const ix = await run([...world(), ...extra, ...submit(rows)]);
    t.expect((await findings(ix)).map((d) => [d[0], d[2]])).toEqual([["DILUTION", "3"], ["DILUTION", "4"]]);
    await ix.process({ chains: { [CHAIN]: { simulate: [{ ...ANCRE, event: "EdgeProven",
      params: { setId: SET_ID, node: 2n, agentId: 3n, wOld: 0n, wNew: 10_000n, eLowEff: 20n, eEff: 20n } }] } } as never });
    t.expect((await ix.SetHealth.getOrThrow(SET_ID)).openDiscrepancies).toBe(1); // 20 000 < 30 000: #4 still dilutes
    await ix.process({ chains: { [CHAIN]: { simulate: [{ ...ANCRE, event: "EdgeProven",
      params: { setId: SET_ID, node: 2n, agentId: 4n, wOld: 0n, wNew: 10_000n, eLowEff: 20n, eEff: 20n } }] } } as never });
    t.expect((await ix.SetHealth.getOrThrow(SET_ID)).status).toBe("CLEAN");
  });

  it("an EdgeProven never closes a row-level finding (SHAPE) of the same row", async (t) => {
    const rows: Row[] = [{ u: 0, src: ZERO, edges: [[2, 10_000, 1]] }, ANCHORS[1]!, { u: 2, src: W1, edges: [[3, 10_000, 1]] }];
    const ix = await run([...world(), ...submit(rows)]);
    t.expect((await findings(ix)).map((d) => d[0])).toEqual(["SHAPE", "DILUTION"]);
    await ix.process({ chains: { [CHAIN]: { simulate: [{ ...ANCRE, event: "EdgeProven",
      params: { setId: SET_ID, node: 0n, agentId: 1n, wOld: 10_000n, wNew: 10_000n, eLowEff: 0n, eEff: 0n } }] } } as never });
    t.expect((await ix.Discrepancy.getAll()).find((d) => d.kind === "SHAPE")!.provenAtBlock).toBeUndefined();
  });

  it("code review: an invented edge cannot mask an omission (budget judged after the provable faults)", async (t) => {
    // registry: A vouches #1 and #2 (B+ 20 000); the row commits #1 and an invented #3, and omits #2 (raw Σw+ = 20 000)
    const rows: Row[] = [{ u: 0, edges: [[2, 10_000, 1], [4, 10_000, 1]] }, ANCHORS[1]!,
      { u: 2, src: W1, edges: [[3, 10_000, 1], [4, 10_000, 1]] }];
    const ix = await run([...world(), fb(2n, A, 1n, 100n, "vouch"), ...submit(rows)]);
    t.expect((await findings(ix)).map((d) => [d[0], d[1], d[2]])).toEqual([["FABRICATED", 0, "3"], ["DILUTION", 0, "2"]]);
    // proving the invented edge leaves the dilution open (amended budget 10 000 < 20 000)
    await ix.process({ chains: { [CHAIN]: { simulate: [{ ...ANCRE, event: "EdgeProven",
      params: { setId: SET_ID, node: 0n, agentId: 3n, wOld: 10_000n, wNew: 0n, eLowEff: 20n, eEff: 20n } }] } } as never });
    const h = await ix.SetHealth.getOrThrow(SET_ID);
    t.expect([h.status, h.openDiscrepancies]).toEqual(["DISCREPANCY", 1]);
  });

  it("code review: the edge findings of a SOURCE_MISSING row carry proveWallet", async (t) => {
    const rows: Row[] = [...ANCHORS, { u: 2, edges: [] }]; // #1 has the wallet W1 but its row has no SRC
    const ix = await run([...world(), ...submit(rows)]);
    const ds = await findings(ix);
    t.expect(ds.map((d) => [d[0], d[2], d[5]])).toEqual(
      [["SOURCE_MISSING", "1", "proveWallet"], ["DILUTION", "2", "proveWallet"], ["DILUTION", "3", "proveWallet"]]);
  });

  it("edge findings of a row with a wrong source are labelled proveWallet (proveEdge reverts BadProof(25))", async (t) => {
    const rows: Row[] = [...ANCHORS, { u: 2, src: C, edges: [[3, 10_000, 1]] }];
    const ix = await run([...world(), ...submit(rows)]);
    const ds = await findings(ix);
    t.expect(ds[0]).toEqual(["SOURCE", 2, "1", 0, 0, "proveWallet"]);
    t.expect(ds.slice(1).every((d) => d[5] === "proveWallet")).toBe(true);
  });
});

describe("code review: nested calls and schema tags", () => {
  const M3 = [{ type: "function", name: "aggregate", stateMutability: "payable", outputs: [],
    inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "callData", type: "bytes" }] }] }] as const;
  it("decoys for another set never push the real certificate out of the scan", (t) => {
    const other = ("0x" + "cd".repeat(32)) as Hex;
    const decoy = encodeFunctionData({ abi, functionName: "submitCertificate", args: [other, 4, E18, "0x", "0x", "0x02" + "00000000"] });
    const real = certInput(ANCHORS);
    const input = encodeFunctionData({ abi: M3, functionName: "aggregate",
      args: [[...Array(40).fill({ target: CONTRACT, callData: decoy }), { target: CONTRACT, callData: real }]] });
    const got = [...findCertCalls(input, SET_ID)];
    t.expect(got.map((c) => c.rows)).toEqual([encodeRows(ANCHORS)]);
  });
  it("a schema tag that is not valid UTF-8 keeps the hash of its bytes", (t) => {
    const fn = (abi as any[]).find((x) => x.type === "function" && x.name === "registerAnchorSet");
    const params = JSON.parse(JSON.stringify(fn.inputs[0]));
    params.components.find((c: any) => c.name === "tags").components.find((c: any) => c.name === "tag").type = "bytes";
    const p = { anchors: [A, B], lambdas: [E18 / 2n, E18 / 2n], alphaN: 1, alphaD: 3, tagSchemaHash: ("0x" + "00".repeat(32)) as Hex,
      tags: [{ tag: "0xff76" as Hex, min: 0n, neutral: 0n, max: 100n * E18, kind: 0 }], policy };
    const encoded = encodeAbiParameters([params], [p]);
    const input = (toFunctionSelector(fn) + encoded.slice(2)) as Hex;
    const setId = keccak256(encodeAbiParameters(params.components, params.components.map((c: any) => (p as any)[c.name])));
    const call = findSetCall(input, setId)!;
    t.expect(call).toBeDefined();
    t.expect(schemaTagHash(call.tags[0]!.tag)).toBe(keccak256("0xff76"));
    t.expect(schemaTagHash("vouch")).toBe(keccak256(stringToBytes("vouch")));
  });
});

describe("DECODE: a zero SRC reads as no source (as the contract), the certificate is still audited", () => {
  it("anchor row with SRC = 0x0: AUDITED with SHAPE, the other faults are still reported", async (t) => {
    const rows: Row[] = [{ u: 0, src: ZERO, edges: [[2, 10_000, 1]] }, ANCHORS[1]!, { u: 2, src: W1, edges: [[3, 10_000, 1], [4, 10_000, 1]] },
      { u: 3, edges: [] }];
    const ix = await run([...world(), ...submit(rows)]);
    t.expect((await ix.Certificate.getAll())[0]!.status).toBe("AUDITED");
    t.expect((await findings(ix)).map((d) => [d[0], d[1], d[5]])).toEqual([["SHAPE", 0, "refused at submission"]]);
  });
  it("source-less agent row encoded with SRC = 0x0: SHAPE, never a false SOURCE", async (t) => {
    const rows: Row[] = [...ANCHORS, { u: 2, src: W1, edges: [[3, 10_000, 1], [4, 10_000, 1]] }, { u: 3, src: ZERO, edges: [] }];
    const ix = await run([...world(), ...submit(rows)]);
    t.expect((await findings(ix)).map((d) => [d[0], d[1]])).toEqual([["SHAPE", 3]]);
  });
  it("an agent row sourced by an anchor (D48-A) is SHAPE (AnchorAsSource)", async (t) => {
    const items = [...world(), setWallet(2n, A)];
    const rows: Row[] = [...ANCHORS, { u: 2, src: W1, edges: [[3, 10_000, 1], [4, 10_000, 1]] }, { u: 3, src: A, edges: [] }];
    const ix = await run([...items, ...submit(rows)]);
    const d = (await ix.Discrepancy.getAll()).find((x) => x.kind === "SHAPE");
    t.expect(d?.u).toBe(3);
  });
});
