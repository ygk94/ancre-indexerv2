// Consistency check: indexer (GraphQL) vs the registries read live (RPC + Multicall3), at the block the
// indexer has processed. Brief 03 §7. Read-only: eth_call only.
//
//   node scripts/check.ts [--chain 143] [--endpoint http://localhost:8080/v1/graphql] [--full]
//
// Checks, per chain:
//   1. getVersion() of both registries == "2.0.0" (D17 watch)
//   2. for EVERY minted agent (from the identity history, not from the indexed feedbacks: an agent whose feedbacks were
//      all missed must be queried too, review 06/10 CHECKCOV): set(getClients(agent)) == set of indexed clients
//   3. for every (client, agent) couple: getLastIndex == max indexed feedbackIndex  (=> Σ getLastIndex == #feedbacks)
//   3b. readFeedback == the indexed row (value, valueDecimals, keccak256(tag1 bytes) == tagHash, isRevoked), for the
//      latest feedback of every triple, or for every feedback with --full (CHECKCOV: a missed revocation, a lossy tag)
//   4. mints: ownerOf(maxId) exists and ownerOf(maxId + 1) reverts
//   5. owner and agentWallet of every agent (--full) or of a 500-agent sample: ownerOf / getAgentWallet
// GraphQL pagination stops on an EMPTY page, like solver/from_indexer.py (solver/FORMAT.md §7, review 06/10 K22): a
// server-side row cap below the page size must not truncate silently.
// Exit code 0 when everything matches, 1 otherwise. Writes a JSON report to stdout.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, keccak256, parseAbi, type Address, type Hex } from "viem";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1]! : d; };
const ENDPOINT = opt("--endpoint", process.env.ENVIO_GRAPHQL ?? "http://localhost:8080/v1/graphql");
const CHAIN = Number(opt("--chain", "143"));
const FULL = args.includes("--full");

const CHAINS: Record<number, { rpc: string; identity: Address; reputation: Address }> = {
  143: { rpc: process.env.ENVIO_MONAD_RPC ?? "https://rpc.monad.xyz",
    identity: "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432", reputation: "0x8004baa17c55a88189ae136b182e5fda19de9b63" },
  10143: { rpc: process.env.ENVIO_MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz",
    identity: "0x8004a818bfb912233c491871b3d84c89a494bd9e", reputation: "0x8004b663056a597dffe9eccc1965a193b7388713" },
  10: { rpc: process.env.ENVIO_OPTIMISM_RPC ?? "https://mainnet.optimism.io",
    identity: "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432", reputation: "0x8004baa17c55a88189ae136b182e5fda19de9b63" },
};
const abi = parseAbi([
  "function getVersion() pure returns (string)",
  "function getClients(uint256 agentId) view returns (address[])",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  // tag1/tag2 read as bytes (same ABI encoding as string): exact bytes, so keccak256 matches indexedTag1 even for invalid UTF-8
  "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, bytes tag1, bytes tag2, bool isRevoked)",
]);
export const PAGE = 1000;

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.HASURA_ADMIN_SECRET ?? ENDPOINT.includes("localhost")) headers["x-hasura-admin-secret"] = process.env.HASURA_ADMIN_SECRET ?? "testing";
  const r = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  const j = (await r.json()) as { data?: T; errors?: unknown };
  if (j.errors || !j.data) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

/** Keyset pagination: pages ordered by id, cursor = last id; stops on an EMPTY page only (K22). */
export async function paginate<T extends { id: string }>(page: (last: string) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  let last = "";
  for (;;) {
    const rows = await page(last);
    if (rows.length === 0) return out;
    out.push(...rows);
    last = rows[rows.length - 1]!.id;
  }
}

/** One entity of one chain. */
const all = <T extends { id: string }>(entity: string, fields: string): Promise<T[]> => paginate(async (last) =>
  (await gql<Record<string, T[]>>(
    `query($c: Int!, $last: String!) { ${entity}(where: {chainId: {_eq: $c}, id: {_gt: $last}}, order_by: {id: asc}, limit: ${PAGE}) { id ${fields} } }`,
    { c: CHAIN, last }))[entity]!);

export type IndexedFeedback = { id: string; agent_id: string; client: string; feedbackIndex: string; value: string;
  valueDecimals: number; tagHash: string; triple: string; blockNumber: string; revokedAtBlock: string | null };
export type ChainFeedback = readonly [bigint, number, Hex, Hex, boolean] | undefined;

/** Differences between an indexed feedback and readFeedback at `block` (empty = identical). */
export function feedbackDiff(f: IndexedFeedback, r: ChainFeedback, block: bigint): string[] {
  if (!r) return ["readFeedback failed"];
  const [value, decimals, tag1] = r;
  const revoked = f.revokedAtBlock !== null && BigInt(f.revokedAtBlock) <= block;
  const out: string[] = [];
  if (value !== BigInt(f.value)) out.push(`value ${value} vs ${f.value}`);
  if (Number(decimals) !== f.valueDecimals) out.push(`decimals ${decimals} vs ${f.valueDecimals}`);
  if (keccak256(tag1).toLowerCase() !== f.tagHash.toLowerCase()) out.push("tag1 hash");
  if (r[4] !== revoked) out.push(`isRevoked ${r[4]} vs ${revoked}`);
  return out;
}

/** The feedbacks to compare: every one (--full) or the latest of each (client, agent, tag) triple. */
export function feedbacksToCompare(fbs: IndexedFeedback[], full: boolean): IndexedFeedback[] {
  if (full) return fbs;
  const latest = new Map<string, IndexedFeedback>();
  for (const f of fbs) {
    const cur = latest.get(f.triple);
    if (!cur || BigInt(f.feedbackIndex) > BigInt(cur.feedbackIndex)) latest.set(f.triple, f);
  }
  return [...latest.values()];
}

async function main() {
  const cfg = CHAINS[CHAIN];
  if (!cfg) throw new Error(`unknown chain ${CHAIN}`);
  const client = createPublicClient({ transport: http(cfg.rpc, { batch: true, retryCount: 5 }) });

  const meta = await gql<{ _meta: { chainId: number; progressBlock: number; eventsProcessed: number }[] }>(
    "{ _meta { chainId progressBlock eventsProcessed } }");
  const m = meta._meta.find((x) => x.chainId === CHAIN);
  if (!m) throw new Error(`chain ${CHAIN} not indexed at ${ENDPOINT}`);
  const blockNumber = BigInt(m.progressBlock);
  const call = async <R>(contracts: { address: Address; functionName: string; args?: readonly unknown[] }[]) =>
    (await client.multicall({ contracts: contracts.map((c) => ({ ...c, abi })) as never, blockNumber, batchSize: 1024 * 64,
      multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11", // Multicall3, deployed on 143, 10143 and 10 (cast code, 28/09)
      allowFailure: true })) as { status: "success" | "failure"; result?: R }[];

  const report: Record<string, unknown> = { chainId: CHAIN, block: Number(blockNumber), eventsProcessed: m.eventsProcessed,
    checkedAt: new Date().toISOString(), endpoint: ENDPOINT };
  const failures: string[] = [];

  // 1. versions
  const [vi, vr] = await call<string>([{ address: cfg.identity, functionName: "getVersion" }, { address: cfg.reputation, functionName: "getVersion" }]);
  report.versions = [vi!.result, vr!.result];
  if (vi!.result !== "2.0.0" || vr!.result !== "2.0.0") failures.push(`getVersion ${vi!.result}/${vr!.result}`);

  // indexed feedbacks up to the processed block
  const fbs = (await all<IndexedFeedback>("Feedback",
    "agent_id client feedbackIndex value valueDecimals tagHash triple blockNumber revokedAtBlock"))
    .filter((f) => BigInt(f.blockNumber) <= blockNumber);
  const lastIdx = new Map<string, bigint>();
  const clientsOf = new Map<string, Set<string>>();
  for (const f of fbs) {
    const k = `${f.agent_id}|${f.client}`;
    const i = BigInt(f.feedbackIndex);
    if ((lastIdx.get(k) ?? 0n) < i) lastIdx.set(k, i);
    (clientsOf.get(f.agent_id) ?? clientsOf.set(f.agent_id, new Set()).get(f.agent_id)!).add(f.client);
  }
  report.feedbacksIndexed = fbs.length;

  // 2. getClients per MINTED agent (identity history below), not only per rated one (CHECKCOV)
  const minted = [...new Set((await all<{ id: string; agent_id: string; blockNumber: string }>("OwnerChange", "agent_id blockNumber"))
    .filter((x) => BigInt(x.blockNumber) <= blockNumber).map((x) => x.agent_id))];
  const agents = [...new Set([...minted, ...clientsOf.keys()])];
  const gc = await call<Address[]>(agents.map((a) => ({ address: cfg.reputation, functionName: "getClients", args: [BigInt(a)] })));
  let clientsMismatch = 0;
  gc.forEach((r, i) => {
    const onchain = new Set((r.result ?? []).map((x) => x.toLowerCase()));
    const idx = clientsOf.get(agents[i]!) ?? new Set<string>();
    if (r.status !== "success" || onchain.size !== idx.size || [...idx].some((c) => !onchain.has(c))) {
      clientsMismatch++;
      if (clientsMismatch <= 5) failures.push(`getClients(${agents[i]}): chain ${onchain.size} vs indexed ${idx.size}`);
    }
  });
  report.getClients = { agents: agents.length, mismatches: clientsMismatch };

  // 3. getLastIndex per couple
  const couples = [...lastIdx.keys()];
  const gl = await call<bigint>(couples.map((k) => {
    const [a, c] = k.split("|");
    return { address: cfg.reputation, functionName: "getLastIndex", args: [BigInt(a!), c as Address] };
  }));
  let sumChain = 0n;
  let lastMismatch = 0;
  gl.forEach((r, i) => {
    sumChain += r.result ?? 0n;
    if (r.status !== "success" || r.result !== lastIdx.get(couples[i]!)) {
      lastMismatch++;
      if (lastMismatch <= 5) failures.push(`getLastIndex(${couples[i]}): chain ${r.result} vs indexed ${lastIdx.get(couples[i]!)}`);
    }
  });
  report.getLastIndex = { couples: couples.length, sumOnChain: Number(sumChain), mismatches: lastMismatch };
  if (sumChain !== BigInt(fbs.length)) failures.push(`Σ getLastIndex ${sumChain} != indexed feedbacks ${fbs.length}`);

  // 3b. readFeedback against the indexed rows
  const cmp = feedbacksToCompare(fbs, FULL);
  const rf = await call<readonly [bigint, number, Hex, Hex, boolean]>(cmp.map((f) => ({ address: cfg.reputation,
    functionName: "readFeedback", args: [BigInt(f.agent_id), f.client as Address, BigInt(f.feedbackIndex)] })));
  let fbMismatch = 0;
  rf.forEach((r, i) => {
    const d = feedbackDiff(cmp[i]!, r.status === "success" ? r.result : undefined, blockNumber);
    if (d.length > 0) { fbMismatch++; if (fbMismatch <= 5) failures.push(`readFeedback(${cmp[i]!.id}): ${d.join(", ")}`); }
  });
  report.readFeedback = { compared: cmp.length, full: FULL, mismatches: fbMismatch };

  // 4 + 5. agents: owner and wallet AT the checked block, replayed from the layer-1 history (the live indexer may
  // already be past `blockNumber` while we page through GraphQL)
  const key = (x: { blockNumber: string; logIndex: number }) => BigInt(x.blockNumber) * 1_000_000n + BigInt(x.logIndex);
  const byOrder = <T extends { blockNumber: string; logIndex: number }>(a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const owners = (await all<{ id: string; agent_id: string; to: string; blockNumber: string; logIndex: number }>(
    "OwnerChange", "agent_id to blockNumber logIndex")).filter((x) => BigInt(x.blockNumber) <= blockNumber).sort(byOrder);
  const wallets = (await all<{ id: string; agent_id: string; wallet: string; blockNumber: string; logIndex: number }>(
    "WalletChange", "agent_id wallet blockNumber logIndex")).filter((x) => BigInt(x.blockNumber) <= blockNumber).sort(byOrder);
  const state = new Map<string, { owner: string; wallet: string }>();
  for (const o of owners) state.set(o.agent_id, { owner: o.to, wallet: state.get(o.agent_id)?.wallet ?? "0x0000000000000000000000000000000000000000" });
  for (const w of wallets) { const st = state.get(w.agent_id); if (st) st.wallet = w.wallet; }
  const idx = [...state].map(([id, st]) => ({ id, ...st })).filter((a) => a.owner !== "0x0000000000000000000000000000000000000000");
  const maxId = idx.reduce((m, a) => (BigInt(a.id) > m ? BigInt(a.id) : m), 0n);
  const [top, next] = await call<Address>([
    { address: cfg.identity, functionName: "ownerOf", args: [maxId] }, { address: cfg.identity, functionName: "ownerOf", args: [maxId + 1n] }]);
  report.mints = { indexed: idx.length, maxId: Number(maxId), ownerOfMaxExists: top!.status === "success", ownerOfNextReverts: next!.status === "failure" };
  if (top!.status !== "success" || next!.status !== "failure") failures.push(`mint count: ownerOf(${maxId}) / ownerOf(${maxId + 1n})`);

  const sample = FULL ? idx : idx.filter((_, i) => i % Math.max(1, Math.floor(idx.length / 500)) === 0);
  const ow = await call<Address>(sample.map((a) => ({ address: cfg.identity, functionName: "ownerOf", args: [BigInt(a.id)] })));
  const wa = await call<Address>(sample.map((a) => ({ address: cfg.identity, functionName: "getAgentWallet", args: [BigInt(a.id)] })));
  let ownerMismatch = 0;
  let walletMismatch = 0;
  sample.forEach((a, i) => {
    if (ow[i]!.result?.toLowerCase() !== a.owner) { ownerMismatch++; if (ownerMismatch <= 5) failures.push(`ownerOf(${a.id}): ${ow[i]!.result} vs ${a.owner}`); }
    if (wa[i]!.result?.toLowerCase() !== a.wallet) { walletMismatch++; if (walletMismatch <= 5) failures.push(`getAgentWallet(${a.id}): ${wa[i]!.result} vs ${a.wallet}`); }
  });
  report.identity = { checked: sample.length, full: FULL, ownerMismatches: ownerMismatch, walletMismatches: walletMismatch };

  report.ok = failures.length === 0;
  report.failures = failures;
  console.log(JSON.stringify(report, null, 1));
  process.exit(failures.length === 0 ? 0 : 1);
}

// run only when launched as a script (the test imports the helpers); both sides resolved, symlinks included (/tmp on macOS)
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
