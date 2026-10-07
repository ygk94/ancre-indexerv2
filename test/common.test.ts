// Joint vectors 02-bis / 04-bis (solver/vectors/common, D48, D50, R1; solver/FORMAT.md §8): the registry of each vector is
// replayed as events, the set and the certificate are submitted with their real calldata, and the live audit must agree
// with the contract's verdict: ACCEPTED -> AUDITED with 0 finding (rule B: a controller's negative edge is a true edge);
// AnchorAsSource -> SHAPE on that row; BadNodes (address(0) node) -> never audited as clean.
// Runs when the vectors exist: solver/vectors/common after the 04-bis merge, or ANCRE_VECTORS=<a solver dir>.
import { afterAll, beforeAll, describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { encodeFunctionData, keccak256, stringToBytes, toHex, type Hex } from "viem";
import abi from "../abis/AnchoredReputation.json" with { type: "json" };
import { decodeSetCall } from "../src/lib/calls.js";
import { startMockRpc, type MockRpc } from "./rpcmock.js";

const SOLVER = process.env.ANCRE_VECTORS ? pathToFileURL(process.env.ANCRE_VECTORS.replace(/\/?$/, "/"))
  : new URL("../../solver/", import.meta.url);
const DIR = new URL("vectors/common/", SOLVER);
const FILES = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")) : [];
const CHAIN = 10143;
const CONTRACT = "0x8be6d3dd7f20b94cd9b1ec51de199291b109da9b"; // official testnet instance (config.yaml, 07/10)
const ANCRE = { contract: "AnchoredReputation", srcAddress: CONTRACT };
const ZERO = "0x0000000000000000000000000000000000000000";

function items(v: any): unknown[] {
  const r = v.registry;
  const out: any[] = [];
  let b = 20_000_000; // above the testnet start_block of config.yaml
  const at = (x: any) => out.push({ ...x, block: { number: b++ } });
  for (const a of r.agents) {
    const id = BigInt(a.agentId);
    at({ contract: "IdentityRegistry", event: "Transfer", transaction: { hash: toHex(b, { size: 32 }) }, params: { from: ZERO, to: a.owner, tokenId: id } });
    if (a.agentWallet !== ZERO) at({ contract: "IdentityRegistry", event: "MetadataSet", transaction: { hash: toHex(b, { size: 32 }) },
      params: { agentId: id, indexedMetadataKey: "", metadataKey: "agentWallet", metadataValue: a.agentWallet } });
    if (a.approved !== ZERO) at({ contract: "IdentityRegistry", event: "Approval", params: { owner: a.owner, approved: a.approved, tokenId: id } });
  }
  for (const o of r.operators ?? []) at({ contract: "IdentityRegistry", event: "ApprovalForAll", params: { owner: o.owner, operator: o.operator, approved: true } });
  const idx = new Map<string, bigint>();
  for (const f of r.feedbacks) {
    const k = `${f.client}-${f.agentId}`;
    const i = (idx.get(k) ?? 0n) + 1n;
    idx.set(k, i);
    at({ contract: "ReputationRegistry", event: "NewFeedback", transaction: { hash: toHex(b, { size: 32 }), from: f.client },
      params: { agentId: BigInt(f.agentId), clientAddress: f.client, feedbackIndex: i, value: BigInt(f.value), valueDecimals: BigInt(f.decimals),
        indexedTag1: keccak256(stringToBytes(f.tag1)), tag1: f.tag1, tag2: f.tag2 ?? "", endpoint: "", feedbackURI: "", feedbackHash: "0x" + "00".repeat(32) } });
    if (f.revoked) at({ contract: "ReputationRegistry", event: "FeedbackRevoked", params: { agentId: BigInt(f.agentId), clientAddress: f.client, feedbackIndex: i } });
  }
  const s = v.set;
  const big = ["theta", "maxAge", "minRefresh", "slackRefresh", "eLowMax"];
  const policy = Object.fromEntries(Object.entries(s.policy).map(([k, x]) => [k, big.includes(k) ? BigInt(x as string) : x]));
  const registerInput = encodeFunctionData({ abi, functionName: "registerAnchorSet", args: [{
    anchors: s.anchors, lambdas: s.lambdas.map(BigInt), alphaN: s.alphaN, alphaD: s.alphaD, tagSchemaHash: s.tagSchemaHash,
    tags: s.tags.map((t: any) => ({ ...t, min: BigInt(t.min), neutral: BigInt(t.neutral), max: BigInt(t.max) })), policy }] as never });
  const setId = decodeSetCall(registerInput)!.setId;
  const input = encodeFunctionData({ abi, functionName: "submitCertificate",
    args: [setId, v.nCert, 10n ** 18n, v.calldata.newNodes, v.calldata.vectors, v.calldata.rows] as never });
  const k = s.anchors.length;
  const added = v.nodes.length - k;
  at({ ...ANCRE, event: "AnchorSetRegistered", transaction: { input: registerInput, hash: toHex(b, { size: 32 }) },
    params: { setId, anchors: s.anchors, lambdas: s.lambdas.map(BigInt), alphaN: BigInt(s.alphaN), alphaD: BigInt(s.alphaD) } });
  at({ ...ANCRE, event: "NodesAdded", transaction: { input, to: CONTRACT }, params: { setId, fromIndex: BigInt(k), count: BigInt(added) } });
  at({ ...ANCRE, event: "CertificateSubmitted", transaction: { input, hash: toHex(b, { size: 32 }), from: "0x00000000000000000000000000000000000000c0" },
    params: { setId, certBlock: 1n, eEff: 0n, graphRoot: v.expected.graphRoot, vectorRoot: v.expected.vectorRoot ?? "0x" + "00".repeat(32),
      versionHash: "0x" + "00".repeat(32), nCert: BigInt(v.nCert), numRows: BigInt(v.rows.length), registryVerified: s.policy.registryVerified } });
  return out;
}

let rpc: MockRpc;
beforeAll(async () => { rpc = await startMockRpc(); process.env.ENVIO_MONAD_TESTNET_RPC = rpc.url; });
afterAll(async () => { await rpc.close(); });

describe.runIf(FILES.length > 0)("joint vectors 02-bis / 04-bis: the live audit agrees with the contract", () => {
  for (const f of FILES) {
    it(f, async (t) => {
      const v = JSON.parse(readFileSync(new URL(f, DIR), "utf8"));
      if (!v.registry) return t.skip(); // real-registry vector (fork): covered by test/offline.test.ts
      const ix = createTestIndexer();
      await ix.process({ chains: { [CHAIN]: { simulate: items(v) as never } } as never });
      const [cert] = await ix.Certificate.getAll();
      const ds = (await ix.Discrepancy.getAll()).map((d) => [d.kind, d.u, d.agentId]);
      const verdict = v.expect.submission as string;
      const proven = v.expect.then?.proveEdge; // accepted (attested) but false: the audit names the edge to prove
      if (verdict === "ACCEPTED" && proven) {
        t.expect([cert!.status, ds]).toEqual(["AUDITED", [[proven.kind, proven.row, String(proven.agentJ)]]]);
      } else if (verdict === "ACCEPTED") t.expect([cert!.status, ds]).toEqual(["AUDITED", []]);
      else if (verdict.startsWith("AnchorAsSource")) {
        const u = Number(/\((\d+)\)/.exec(verdict)![1]);
        t.expect(cert!.status).toBe("AUDITED");
        t.expect(ds).toContainEqual(["SHAPE", u, String(v.nodes[u].agentId)]);
      } else t.expect(cert!.status).not.toBe("AUDITED"); // BadNodes: the node table is refused, never a clean audit
    });
  }
});
