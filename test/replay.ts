// Offline replay of the REAL Monad history from a dump of the indexer's layer 1 (solver/tests/fixtures/indexer, one
// <Entity>.json per entity, block in BLOCK): every OwnerChange, WalletChange, ApprovalChange, OperatorChange and
// Feedback row becomes the simulated event that produced it, in (block, logIndex) order, up to a chosen block.
// It rebuilds layers 2 and 3 with the CURRENT handlers, without HyperSync (no ENVIO_API_TOKEN needed): the parity and
// audit checks of test/parity.test.ts / test/audit.test.ts can then run on any machine (review 06/10, journal).
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { keccak256, stringToBytes } from "viem";

export const DUMP = new URL("../../solver/tests/fixtures/indexer/", import.meta.url);
export const hasDump = () => existsSync(new URL("BLOCK", DUMP));
export const dumpBlock = () => Number(readFileSync(new URL("BLOCK", DUMP), "utf8").trim());
const load = (e: string): any[] => (existsSync(new URL(`${e}.json`, DUMP)) ? JSON.parse(readFileSync(new URL(`${e}.json`, DUMP), "utf8")) : []);
const ZERO = "0x0000000000000000000000000000000000000000";
const txOf = (block: number, n: number) => ("0x" + block.toString(16).padStart(32, "0") + n.toString(16).padStart(32, "0"));

/** Simulated items of the dumped history with blockNumber <= upTo, sorted. */
export function historyItems(upTo: number): unknown[] {
  const out: { b: number; l: number; item: any }[] = [];
  const push = (b: number, l: number, item: any) => { if (b <= upTo) out.push({ b, l, item: { ...item, block: { number: b }, logIndex: l } }); };
  for (const r of load("OwnerChange")) push(+r.blockNumber, r.logIndex, { contract: "IdentityRegistry", event: "Transfer",
    transaction: { hash: txOf(+r.blockNumber, r.logIndex) }, params: { from: r.from, to: r.to, tokenId: BigInt(r.agent_id) } });
  for (const r of load("WalletChange")) push(+r.blockNumber, r.logIndex, { contract: "IdentityRegistry", event: "MetadataSet",
    transaction: { hash: txOf(+r.blockNumber, r.logIndex) },
    params: { agentId: BigInt(r.agent_id), indexedMetadataKey: "", metadataKey: "agentWallet", metadataValue: r.wallet === ZERO ? "0x" : r.wallet } });
  for (const r of load("ApprovalChange")) push(+r.blockNumber, r.logIndex, { contract: "IdentityRegistry", event: "Approval",
    params: { owner: ZERO, approved: r.approved, tokenId: BigInt(r.agent_id) } });
  for (const r of load("OperatorChange")) push(+r.blockNumber, r.logIndex, { contract: "IdentityRegistry", event: "ApprovalForAll",
    params: { owner: r.owner, operator: r.operator, approved: r.approved } });
  for (const r of load("Feedback")) {
    push(+r.blockNumber, r.logIndex, { contract: "ReputationRegistry", event: "NewFeedback",
      transaction: { hash: txOf(+r.blockNumber, r.logIndex), from: r.client },
      params: { agentId: BigInt(r.agent_id), clientAddress: r.client, feedbackIndex: BigInt(r.feedbackIndex), value: BigInt(r.value),
        valueDecimals: BigInt(r.valueDecimals), indexedTag1: keccak256(stringToBytes(r.tag1)), tag1: r.tag1, tag2: r.tag2 ?? "",
        endpoint: "", feedbackURI: "", feedbackHash: "0x" + "00".repeat(32) } });
    if (r.revokedAtBlock != null) push(+r.revokedAtBlock, 1_000_000, { contract: "ReputationRegistry", event: "FeedbackRevoked",
      params: { agentId: BigInt(r.agent_id), clientAddress: r.client, feedbackIndex: BigInt(r.feedbackIndex) } });
  }
  out.sort((x, y) => x.b - y.b || x.l - y.l);
  return out.map((x) => x.item);
}

/** Events that bring the replayed dump up to a solver snapshot (solver/data/<chain>-<block>.{feedbacks,identity}.json.gz,
 *  format of graph.load_feedbacks_onchain / identity.json) taken AFTER the dump's block: new feedbacks, then the final
 *  owner and wallet of every agent that differs, all dated at the snapshot block. Used to audit vectors whose identity
 *  block is past the dump (04-bis vectors at 110 994 810, dump at 110 813 936). */
export function snapshotTail(feedbacksGz: string, identityGz: string, upTo: number): unknown[] {
  const fb = JSON.parse(gunzipSync(readFileSync(feedbacksGz)).toString()).feedbacks as any[];
  const idn = JSON.parse(gunzipSync(readFileSync(identityGz)).toString());
  const dump = load("Feedback");
  const seen = new Set(dump.map((f) => `${f.agent_id}-${f.client}-${f.feedbackIndex}`));
  const owner = new Map<string, string>();
  const wallet = new Map<string, string>();
  const key = (r: any) => +r.blockNumber * 1e6 + r.logIndex;
  for (const r of load("OwnerChange").sort((a, b) => key(a) - key(b))) owner.set(r.agent_id, r.to);
  for (const r of load("WalletChange").sort((a, b) => key(a) - key(b))) wallet.set(r.agent_id, r.wallet);
  const out: any[] = [];
  let l = 0;
  const at = (item: any) => out.push({ ...item, block: { number: upTo }, logIndex: l++ });
  for (const [a, o] of Object.entries(idn.owner as Record<string, string>)) {
    if (owner.get(a) !== o) at({ contract: "IdentityRegistry", event: "Transfer", params: { from: owner.get(a) ?? ZERO, to: o, tokenId: BigInt(a) } });
  }
  for (const [a, w] of Object.entries(idn.wallet as Record<string, string>)) {
    if ((wallet.get(a) ?? ZERO) !== w) at({ contract: "IdentityRegistry", event: "MetadataSet",
      params: { agentId: BigInt(a), indexedMetadataKey: "", metadataKey: "agentWallet", metadataValue: w === ZERO ? "0x" : w } });
  }
  for (const f of fb) {
    if (seen.has(`${f.a}-${f.c}-${f.i}`)) continue;
    at({ contract: "ReputationRegistry", event: "NewFeedback", transaction: { from: f.c },
      params: { agentId: BigInt(f.a), clientAddress: f.c, feedbackIndex: BigInt(f.i), value: BigInt(f.v), valueDecimals: BigInt(f.d),
        indexedTag1: keccak256(stringToBytes(f.t1)), tag1: f.t1, tag2: f.t2 ?? "", endpoint: "", feedbackURI: "",
        feedbackHash: "0x" + "00".repeat(32) } });
  }
  return out;
}
