// Unit tests on simulated events: the AnchoredReputation handlers (set registration, node table, certificate audit).
// A tiny registry is simulated on the testnet chain, then real-shaped calldata (encodeFunctionData on the contract ABI)
// is attached to the ANCRE events, as a direct EOA call would carry it.
import { afterAll, beforeAll, describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { encodeFunctionData, type Hex } from "viem";
import abi from "../abis/AnchoredReputation.json" with { type: "json" };
import { decodeRows, graphRoot } from "../src/lib/certificate.js";
import { decodeSetCall } from "../src/lib/calls.js";
import { agentKey, startMockRpc, type MockRpc } from "./rpcmock.js";

const CHAIN = 10143;
const ZERO: Hex = "0x0000000000000000000000000000000000000000";
const A: Hex = "0x00000000000000000000000000000000000000aa"; // anchors, strictly increasing
const B: Hex = "0x00000000000000000000000000000000000000bb";
const O1: Hex = "0x1111111111111111111111111111111111111111";
const W1: Hex = "0x2222222222222222222222222222222222222222";
const O2: Hex = "0x3333333333333333333333333333333333333333";
const SUBMITTER: Hex = "0x4444444444444444444444444444444444444444";
const E18 = 10n ** 18n;

const mint = (tokenId: bigint, to: Hex) => ({ contract: "IdentityRegistry" as const, event: "Transfer" as const, params: { from: ZERO, to, tokenId } });
const setWallet = (agentId: bigint, wallet: Hex) => ({ contract: "IdentityRegistry" as const, event: "MetadataSet" as const,
  params: { agentId, indexedMetadataKey: "", metadataKey: "agentWallet", metadataValue: wallet } });
const fb = (agentId: bigint, client: Hex, feedbackIndex: bigint, value: bigint, tag1: string) => ({
  contract: "ReputationRegistry" as const, event: "NewFeedback" as const,
  params: { agentId, clientAddress: client, feedbackIndex, value, valueDecimals: 0n, indexedTag1: "", tag1, tag2: "",
    endpoint: "", feedbackURI: "", feedbackHash: ("0x" + "00".repeat(32)) as Hex } });

// ---- calldata, as the certifier would send it (contracts/ENCODING.md)
const be = (v: number, n: number) => v.toString(16).padStart(2 * n, "0");
const i16 = (w: number) => be(w < 0 ? w + 0x10000 : w, 2);
type Row = { u: number; src?: Hex; edges: [dst: number, w: number, fi: number][] };
function encodeRows(rows: Row[]): Hex { // W = 2
  let h = be(2, 1) + be(rows.length, 4);
  for (const r of rows) {
    h += be(r.u, 2) + be((r.src ? 0x8000 : 0) | r.edges.length, 2) + (r.src ? r.src.slice(2) : "");
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
const SET_ID = decodeSetCall(registerInput)!.setId; // computeSetId(p), as the contract emits it
const CONTRACT: Hex = "0x8be6d3dd7f20b94cd9b1ec51de199291b109da9b"; // official testnet instance (config.yaml, 07/10)
const ANCRE = { contract: "AnchoredReputation" as const, srcAddress: CONTRACT };
const certInput = (rows: Row[], newNodes: Hex = agentNodes(1, 2)) => encodeFunctionData({ abi, functionName: "submitCertificate",
  args: [SET_ID, 4, E18, newNodes, "0x", encodeRows(rows)] });
const MULTICALL3: Hex = "0xca11bde05977b3631167028862be2a173976ca11";
const M3 = [{ type: "function", name: "aggregate", stateMutability: "payable", outputs: [],
  inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "callData", type: "bytes" }] }] }] as const;
const multicall = (inner: Hex) => encodeFunctionData({ abi: M3, functionName: "aggregate", args: [[{ target: CONTRACT, callData: inner }]] });

// node-table repair (nodeKeyAt through the Effect API) answered by a local JSON-RPC server
let rpc: MockRpc;
beforeAll(async () => { rpc = await startMockRpc(); process.env.ENVIO_MONAD_TESTNET_RPC = rpc.url; });
afterAll(async () => { await rpc.close(); });

// nodes: 0 = A, 1 = B, 2 = agent #1 (wallet W1), 3 = agent #2
const HONEST: Row[] = [
  { u: 0, edges: [[2, 10_000, 1]] },               // A vouches #1 (100)
  { u: 1, edges: [[2, 10_000, 1]] },               // B vouches #1 (100)
  { u: 2, src: W1, edges: [[3, 5_000, 1]] },       // #1 (through its wallet W1) vouches #2 (50)
];

function world() {
  return [
    mint(1n, O1), setWallet(1n, W1), mint(2n, O2),
    fb(1n, A, 1n, 100n, "vouch"), fb(1n, B, 1n, 100n, "vouch"), fb(2n, W1, 1n, 50n, "vouch"),
    { ...ANCRE, event: "AnchorSetRegistered" as const,
      transaction: { input: registerInput, to: CONTRACT, hash: ("0x" + "01".repeat(32)) as Hex },
      params: { setId: SET_ID, anchors: [A, B], lambdas: [E18 / 2n, E18 / 2n], alphaN: 1n, alphaD: 3n } },
  ];
}
const rootOf = (rows: Row[]) => graphRoot(decodeRows(encodeRows(rows)).rows.map((r) => r.leaf));
const submit = (rows: Row[], input: Hex = certInput(rows), root: Hex = rootOf(HONEST), tx = "02") => [
  { ...ANCRE, event: "NodesAdded" as const, transaction: { input, to: CONTRACT },
    params: { setId: SET_ID, fromIndex: 2n, count: 2n } },
  { ...ANCRE, event: "CertificateSubmitted" as const,
    transaction: { input, to: CONTRACT, from: SUBMITTER, hash: ("0x" + tx.repeat(32)) as Hex },
    params: { setId: SET_ID, certBlock: 1n, eEff: 15n, graphRoot: root,
      vectorRoot: ("0x" + "00".repeat(32)) as Hex, versionHash: ("0x" + "00".repeat(32)) as Hex,
      nCert: 4n, numRows: BigInt(rows.length), registryVerified: true } },
];

async function run(items: unknown[]) {
  const ix = createTestIndexer();
  await ix.process({ chains: { [CHAIN]: { simulate: items as never } } as never });
  return ix;
}

describe("AnchoredReputation handlers", () => {
  it("registers the set from calldata (params hash to setId) and rebuilds the node table", async (t) => {
    const ix = await run([...world(), ...submit(HONEST)]);
    const set = await ix.AnchorSet.getOrThrow(SET_ID);
    t.expect([set.decodable, set.nodesComplete, set.registryVerified, set.nodeCount]).toEqual([true, true, true, 4]);
    t.expect(set.anchors).toEqual([A, B]);
    t.expect(JSON.parse(set.tagsJson!)).toEqual([{ tag: "vouch", min: "0", neutral: "0", max: (100n * E18).toString(), kind: 0 }]);
    const nodes = (await ix.SetNode.getAll()).sort((a, b) => a.index - b.index).map((n) => [n.index, n.kind, n.agentId ?? n.address]);
    t.expect(nodes).toEqual([[0, "anchor", A], [1, "anchor", B], [2, "agent", "1"], [3, "agent", "2"]]);
  });

  it("an honest certificate is AUDITED with 0 discrepancy and the set is CLEAN", async (t) => {
    const ix = await run([...world(), ...submit(HONEST)]);
    const [cert] = await ix.Certificate.getAll();
    t.expect([cert!.status, cert!.graphRootMatches, cert!.submitter]).toEqual(["AUDITED", true, SUBMITTER]);
    t.expect([cert!.rowsChecked, cert!.edgesChecked, cert!.discrepancyCount]).toEqual([3, 3, 0]);
    const h = await ix.SetHealth.getOrThrow(SET_ID);
    t.expect([h.status, h.certificates, h.openDiscrepancies]).toEqual(["CLEAN", 1, 0]);
  });

  it("rows that do not hash to the committed graphRoot are ROOT_MISMATCH, never CLEAN", async (t) => {
    const ix = await run([...world(), ...submit(HONEST, certInput(HONEST), ("0x" + "00".repeat(32)) as Hex)]);
    const [cert] = await ix.Certificate.getAll();
    t.expect([cert!.status, cert!.graphRootMatches, cert!.discrepancyCount]).toEqual(["ROOT_MISMATCH", false, 0]);
    t.expect((await ix.SetHealth.getOrThrow(SET_ID)).status).toBe("UNAUDITED");
  });

  it("an inflated edge is flagged with its remedy; the on-chain proof closes it", async (t) => {
    const inflated: Row[] = [HONEST[0]!, HONEST[1]!, { u: 2, src: W1, edges: [[3, 10_000, 1]] }];
    const ix = await run([...world(), ...submit(inflated, certInput(inflated), rootOf(inflated))]);
    const ds = (await ix.Discrepancy.getAll()).map((d) => [d.kind, d.u, d.agentId, d.wCommitted, d.wRegistry, d.proof]);
    t.expect(ds).toEqual([["INFLATED", 2, "2", 10_000, 5_000, "proveEdge"]]);
    t.expect((await ix.SetHealth.getOrThrow(SET_ID)).status).toBe("DISCREPANCY");
    await ix.process({ chains: { [CHAIN]: { simulate: [{ ...ANCRE, event: "EdgeProven",
      params: { setId: SET_ID, node: 2n, agentId: 2n, wOld: 10_000n, wNew: 5_000n, eLowEff: 20n, eEff: 20n } }] } } as never });
    const h = await ix.SetHealth.getOrThrow(SET_ID);
    t.expect([h.status, h.openDiscrepancies, h.edgesProven]).toEqual(["CLEAN", 0, 1]);
    t.expect((await ix.Discrepancy.getAll())[0]!.provenAtBlock).toBeDefined();
  });

  it("a relayed call with no recognisable inner call is never audited (UNDECODABLE)", async (t) => {
    rpc.keys.set(`${SET_ID.toLowerCase()}-2`, agentKey(1)); rpc.keys.set(`${SET_ID.toLowerCase()}-3`, agentKey(2));
    const opaque = ("0xdeadbeef" + "00".repeat(64)) as Hex; // e.g. a compressed batch: the rows are nowhere in the input
    const ix = await run([...world(), ...submit(HONEST, opaque)]);
    t.expect((await ix.Certificate.getAll())[0]!.status).toBe("UNDECODABLE");
    t.expect((await ix.SetHealth.getOrThrow(SET_ID)).status).toBe("UNAUDITED");
  });

  it("OUTERCALL: a certificate nested in a wrapper is audited when its rows hash to graphRoot", async (t) => {
    rpc.keys.set(`${SET_ID.toLowerCase()}-2`, agentKey(1)); rpc.keys.set(`${SET_ID.toLowerCase()}-3`, agentKey(2));
    const wrapped = multicall(certInput(HONEST));
    const items = submit(HONEST, wrapped);
    for (const it of items) (it.transaction as { to: Hex }).to = MULTICALL3;
    const ix = await run([...world(), ...items]);
    const [cert] = await ix.Certificate.getAll();
    t.expect([cert!.status, cert!.graphRootMatches, cert!.discrepancyCount]).toEqual(["AUDITED", true, 0]);
    const set = await ix.AnchorSet.getOrThrow(SET_ID);
    t.expect([set.nodesComplete, set.nodeCount]).toEqual([true, 4]); // node table read back from nodeKeyAt
    t.expect(rpc.calls).toBeGreaterThan(0);
    // a nested decoy that does not hash to graphRoot is never audited
    const decoy = multicall(certInput(HONEST.slice(0, 2)));
    const bad = submit(HONEST, decoy);
    const ix2 = await run([...world(), ...bad]);
    t.expect((await ix2.Certificate.getAll())[0]!.status).toBe("ROOT_MISMATCH");
  });

  it("OUTERCALL: a relayed addNodes leaves no permanent hole (nodeKeyAt repair, retried while the RPC is down)", async (t) => {
    const add = multicall(encodeFunctionData({ abi, functionName: "addNodes", args: [SET_ID, agentNodes(1, 2)] }));
    const direct = certInput(HONEST, "0x");
    const relayedAdd = { ...ANCRE, event: "NodesAdded" as const, transaction: { input: add, to: MULTICALL3 },
      params: { setId: SET_ID, fromIndex: 2n, count: 2n } };
    // RPC down at the time of the append and of the first certificate: NODES_MISSING, never a guess
    rpc.down = true;
    const ix = await run([...world(), relayedAdd, submit(HONEST, direct)[1]!]);
    t.expect((await ix.Certificate.getAll())[0]!.status).toBe("NODES_MISSING");
    t.expect((await ix.AnchorSet.getOrThrow(SET_ID)).nodesComplete).toBe(false);
    // the RPC is back: the next certificate repairs the table and is audited
    rpc.down = false;
    rpc.keys.set(`${SET_ID.toLowerCase()}-2`, agentKey(1)); rpc.keys.set(`${SET_ID.toLowerCase()}-3`, agentKey(2));
    await ix.process({ chains: { [CHAIN]: { simulate: [submit(HONEST, direct, rootOf(HONEST), "03")[1]!] } } as never });
    const certs = (await ix.Certificate.getAll()).sort((a, b) => Number(a.blockNumber - b.blockNumber)).map((c) => c.status);
    t.expect(certs).toEqual(["NODES_MISSING", "AUDITED"]);
    t.expect((await ix.AnchorSet.getOrThrow(SET_ID)).nodesComplete).toBe(true);
    const nodes = (await ix.SetNode.getAll()).sort((a, b) => a.index - b.index).map((n) => [n.index, n.kind, n.agentId ?? n.address]);
    t.expect(nodes).toEqual([[0, "anchor", A], [1, "anchor", B], [2, "agent", "1"], [3, "agent", "2"]]);
  });

  it("OUTERCALL: a relayed addNodes is repaired at once when the RPC answers", async (t) => {
    rpc.keys.set(`${SET_ID.toLowerCase()}-2`, agentKey(1)); rpc.keys.set(`${SET_ID.toLowerCase()}-3`, agentKey(2));
    const add = multicall(encodeFunctionData({ abi, functionName: "addNodes", args: [SET_ID, agentNodes(1, 2)] }));
    const ix = await run([...world(), { ...ANCRE, event: "NodesAdded" as const, transaction: { input: add, to: MULTICALL3 },
      params: { setId: SET_ID, fromIndex: 2n, count: 2n } }]);
    const set = await ix.AnchorSet.getOrThrow(SET_ID);
    t.expect([set.nodesComplete, set.nodeCount, (await ix.SetNode.getAll()).length]).toEqual([true, 4, 4]);
  });

  it("OUTERCALL: a set registered through a Safe / Multicall3 gets its schema (params hash to setId)", async (t) => {
    const items = world();
    const reg = items[items.length - 1] as { transaction: { input: Hex; to: Hex } };
    reg.transaction.input = multicall(registerInput);
    reg.transaction.to = MULTICALL3;
    const ix = await run([...items, ...submit(HONEST)]);
    const set = await ix.AnchorSet.getOrThrow(SET_ID);
    t.expect([set.decodable, set.registryVerified]).toEqual([true, true]);
    t.expect((await ix.Certificate.getAll())[0]!.status).toBe("AUDITED");
  });

  it("set params that do not hash to the event's setId give no schema (UNKNOWN_SET)", async (t) => {
    const items = world();
    const reg = items[items.length - 1] as { params: { setId: Hex } };
    const other = ("0x" + "ab".repeat(32)) as Hex;
    reg.params.setId = other;
    const certs = submit(HONEST).map((it) => ({ ...it, params: { ...it.params, setId: other } }));
    const ix = await run([...items, ...certs]);
    t.expect((await ix.AnchorSet.getOrThrow(other)).decodable).toBe(false);
    t.expect((await ix.Certificate.getAll())[0]!.status).toBe("UNDECODABLE"); // the cert calldata names SET_ID, not `other`
  });

  it("a registry upgrade after the certificate marks the set STALE", async (t) => {
    const ix = await run([...world(), ...submit(HONEST), { ...ANCRE, event: "RegistryChanged",
      params: { setId: SET_ID, certifiedVersionHash: ("0x" + "01".repeat(32)) as Hex, currentVersionHash: ("0x" + "02".repeat(32)) as Hex } }]);
    t.expect((await ix.SetHealth.getOrThrow(SET_ID)).status).toBe("STALE");
  });
});
