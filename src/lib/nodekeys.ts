// Node-table repair from the contract (review 06/10, OUTERCALL). addNodes is permissionless on an open set and may be
// sent through any contract (Multicall3, Safe, 4337, EIP-7702): its entries are then not in a calldata we can trust,
// and Monad serves no call traces. The node keys, however, are written once and never change (NodeExists, stable
// index, ENCODING §2): `nodeKeyAt(setId, i)` read at the FINALIZED head gives the key of every index appended in a
// finalized block, whatever the block the indexer is at; a speculative block that is later dropped can never put a
// wrong key in the cache (code review 06/10). A zero key means "not appended in a finalized block (yet)": it is never
// cached, the index stays a hole and is retried on the next use (next NodesAdded or certificate).
// Effect API (DOC docs.envio.dev effect-api, read 06/10): batched, deduplicated, rate limited; never a raw RPC call in a
// handler (handlers run twice).
import { createEffect, S } from "envio";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import type { NewNode } from "./certificate.js";

/** RPC per chain: same variables as scripts/check.ts (Envio Cloud only passes ENVIO_* variables). */
export function rpcUrl(chainId: number): string | undefined {
  const env = process.env;
  switch (chainId) {
    case 143: return env.ENVIO_MONAD_RPC ?? "https://rpc.monad.xyz";
    case 10143: return env.ENVIO_MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz";
    case 10: return env.ENVIO_OPTIMISM_RPC ?? "https://mainnet.optimism.io";
    default: return undefined;
  }
}

const ABI = parseAbi(["function nodeKeyAt(bytes32 setId, uint256 i) view returns (bytes32)"]);
export const MAX_KEYS = 256; // indices per effect call (a handler asks for more in several calls)
const clients = new Map<string, ReturnType<typeof createPublicClient>>();

export const nodeKeysEffect = createEffect({
  name: "nodeKeyAt",
  input: { contract: S.string, setId: S.string, from: S.number, count: S.number },
  output: S.array(S.string),
  rateLimit: { calls: 10, per: "second" }, // rpc.monad.xyz: 25 rps for everything (CLAUDE.md §8)
  cache: true,
  crossChain: false, // the contract address may be the same on several chains
}, async ({ input, context }) => {
  const url = rpcUrl(context.chain.id);
  if (!url) { context.cache = false; return []; }
  const client = clients.get(url) ?? clients.set(url, createPublicClient({ transport: http(url, { batch: true, retryCount: 3 }) })).get(url)!;
  const n = Math.min(input.count, MAX_KEYS);
  try {
    const keys = await Promise.all([...Array(n).keys()].map((i) => client.readContract({
      address: input.contract as Address, abi: ABI, functionName: "nodeKeyAt", args: [input.setId as Hex, BigInt(input.from + i)],
      blockTag: "finalized" })));
    if (keys.some((k) => BigInt(k) === 0n)) context.cache = false; // not appended at the RPC's head: retry later
    return keys.map((k) => k.toLowerCase());
  } catch (e) {
    context.cache = false; // transport error: never cache it, the hole is retried on the next use
    context.log.warn("nodeKeyAt unreadable", { error: String(e) });
    return [];
  }
});

const MASK160 = (1n << 160n) - 1n;
/** Node key (kind << 248 | value) -> node; undefined for 0 (not appended) or an unknown kind. */
export function nodeOfKey(key: string): (NewNode | { kind: "anchor"; address: string }) | undefined {
  const k = BigInt(key);
  const kind = Number(k >> 248n);
  const v = k & ((1n << 248n) - 1n);
  const addr = () => "0x" + (v & MASK160).toString(16).padStart(40, "0");
  if (kind === 1) return { kind: "agent", agentId: v };
  if (kind === 2) return { kind: "address", address: addr() };
  if (kind === 3) return { kind: "anchor", address: addr() };
  return undefined;
}
