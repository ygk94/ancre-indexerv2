// Decoding of the ANCRE contract's calls from the transaction input (P2 gate, chantier 03: a handler reads
// `transaction.input`). A direct call is decoded as is. A call made THROUGH a contract (Safe, Multicall3, a 4337 or
// EIP-7702 account) carries the inner call as a contiguous ABI `bytes` inside the wrapper's input: `nestedCalls` scans
// the input for the function selector and decodes every occurrence (review 06/10, OUTERCALL). A nested candidate is
// only trusted when it provably is the committed data: the set params hash to the event's setId (registerAnchorSet),
// the rows hash to the event's graphRoot (submitCertificate). Monad serves no call traces (AM-03.3), hence the scan.
// Pure functions: safe in both handler phases.
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, hexToBytes, keccak256, toFunctionSelector, type Hex } from "viem";
import abi from "../../abis/AnchoredReputation.json" with { type: "json" };
import { decodeNewNodes, type NewNode } from "./certificate.js";
import { BYTES_TAG } from "./text.js";

const ABI = abi as readonly unknown[] as Parameters<typeof decodeFunctionData>[0]["abi"];

export type SetTag = { tag: string; min: string; neutral: string; max: string; kind: number };
export type SetCall = {
  setId: Hex;                        // computeSetId(p), recomputed from the decoded params
  anchors: string[]; lambdas: string[]; alphaN: number; alphaD: number; tags: SetTag[];
  policy: Record<string, unknown> & { ownerFallback: boolean; registryVerified: boolean };
};
export type CertCall = { setId: Hex; nCert: number; newNodes: Hex; rows: Hex };

function decode(input: string | undefined, name: string): readonly unknown[] | undefined {
  if (!input || input.length < 10) return undefined;
  if (name === "registerAnchorSet") return decodeRegister(input);
  try {
    const d = decodeFunctionData({ abi: ABI, data: input as Hex });
    return d.functionName === name ? (d.args as readonly unknown[]) : undefined;
  } catch {
    return undefined; // another selector (wrapper) or malformed
  }
}

type Fn = { type: string; name?: string; inputs?: { name: string; type: string; components?: unknown[] }[] };
const fnOf = (name: string) => (ABI as readonly Fn[]).find((x) => x.type === "function" && x.name === name)!;
const SELECTORS: Record<string, string> = Object.fromEntries(["registerAnchorSet", "submitCertificate", "addNodes"]
  .map((n) => [n, toFunctionSelector(fnOf(n) as never).slice(2)])); // computed once (review: SELECTOR per call)

// SetParams with TagSpec.tag read as `bytes` (same ABI encoding as `string`): the exact tag bytes, so that a tag that is
// not valid UTF-8 keeps the hash the contract compares (keccak256 of the bytes), and computeSetId re-encodes exactly.
const SET_PARAMS_BYTES = (() => {
  const clone = JSON.parse(JSON.stringify(fnOf("registerAnchorSet").inputs![0])) as { components: { name: string; components?: { name: string; type: string }[] }[] };
  const tags = clone.components.find((c) => c.name === "tags")!;
  tags.components!.find((c) => c.name === "tag")!.type = "bytes";
  return clone;
})();
function decodeRegister(input: string): readonly unknown[] | undefined {
  if (input.slice(2, 10).toLowerCase() !== SELECTORS.registerAnchorSet) return undefined;
  try {
    return decodeAbiParameters([SET_PARAMS_BYTES] as never, ("0x" + input.slice(10)) as Hex) as readonly unknown[];
  } catch {
    return undefined;
  }
}

const MAX_TRIES = 1024; // decodes per transaction (bounded: a crafted input may repeat the selector at will)

/** Every decodable occurrence of `name`'s calldata in the input, the direct call first, filtered by `pre` (a cheap
 *  check on the hex that follows the selector) BEFORE decoding: decoys for another set never use up the budget. */
function* nestedCalls(input: string | undefined, name: string, pre: (afterSelector: string) => boolean = () => true) {
  if (!input || input.length < 10) return;
  const hex = input.slice(2).toLowerCase();
  const sel = SELECTORS[name]!;
  let tries = 0;
  for (let i = hex.indexOf(sel); i >= 0 && tries < MAX_TRIES; i = hex.indexOf(sel, i + 1)) {
    if (i % 2 || !pre(hex.slice(i + 8, i + 8 + 64))) continue; // byte-aligned, right set only
    tries++;
    const args = decode("0x" + hex.slice(i), name);
    if (args) yield args;
  }
}

const str = (x: unknown) => (typeof x === "bigint" ? x.toString() : x);
const json = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(str) : str(v)]));

/** registerAnchorSet(SetParams) -> anchors, tags (bounds in WAD), policy. Direct call only. */
export function decodeSetCall(input: string | undefined): SetCall | undefined {
  const args = decode(input, "registerAnchorSet");
  return args ? setCallOf(args) : undefined;
}

/** The registerAnchorSet call (direct or nested) whose params hash to `setId`. */
export function findSetCall(input: string | undefined, setId: string): SetCall | undefined {
  for (const args of nestedCalls(input, "registerAnchorSet")) {
    const c = setCallOf(args);
    if (c.setId.toLowerCase() === setId.toLowerCase()) return c;
  }
  return undefined;
}

/** submitCertificate calls (direct or nested) naming `setId` (first argument, checked before decoding): the caller
 *  keeps the one whose rows hash to graphRoot. */
export function* findCertCalls(input: string | undefined, setId: string): Generator<CertCall> {
  const want = setId.toLowerCase().replace(/^0x/, "");
  for (const args of nestedCalls(input, "submitCertificate", (w) => w === want)) yield certCallOf(args);
}

/** Schema tag name: the text when the bytes are valid UTF-8, else a byte marker (see text.ts schemaTagHash). */
function tagName(bytes: Hex): string {
  const b = hexToBytes(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return BYTES_TAG + bytes.toLowerCase();
  }
}

function setCallOf(args: readonly unknown[]): SetCall {
  const p = args[0] as {
    anchors: readonly string[]; lambdas: readonly bigint[]; alphaN: number; alphaD: number;
    tags: readonly { tag: Hex; min: bigint; neutral: bigint; max: bigint; kind: number }[];
    policy: Record<string, unknown> & { ownerFallback: boolean; registryVerified: boolean };
  };
  return {
    setId: computeSetId(p),
    anchors: p.anchors.map((a) => a.toLowerCase()),
    lambdas: p.lambdas.map(String),
    alphaN: Number(p.alphaN), alphaD: Number(p.alphaD),
    tags: p.tags.map((t) => ({ tag: tagName(t.tag), min: t.min.toString(), neutral: t.neutral.toString(), max: t.max.toString(), kind: Number(t.kind) })),
    policy: json(p.policy) as SetCall["policy"],
  };
}

/** The node entries appended by a transaction: addNodes(setId, entries) or submitCertificate(..., newNodes, ...). */
export function decodeAppendedNodes(input: string | undefined, setId: string): NewNode[] | undefined {
  const add = decode(input, "addNodes");
  if (add) return (add[0] as string).toLowerCase() === setId.toLowerCase() ? decodeNewNodes(add[1] as string) : undefined;
  const c = decodeCertCall(input);
  if (c) return c.setId.toLowerCase() === setId.toLowerCase() ? decodeNewNodes(c.newNodes) : undefined;
  return undefined;
}

/** submitCertificate(setId, nCert, eMax, newNodes, vectors, rows). */
export function decodeCertCall(input: string | undefined): CertCall | undefined {
  const args = decode(input, "submitCertificate");
  return args ? certCallOf(args) : undefined;
}
const certCallOf = (args: readonly unknown[]): CertCall =>
  ({ setId: args[0] as Hex, nCert: Number(args[1]), newNodes: args[3] as Hex, rows: args[5] as Hex });

// AnchoredReputation.computeSetId: keccak256(abi.encode(anchors, lambdas, alphaN, alphaD, tagSchemaHash, tags, policy)).
// The handler compares it with the event's setId, so that calldata from a wrapper sharing the selector is never trusted.
const SET_PARAMS = SET_PARAMS_BYTES.components as unknown as readonly { name: string; type: string; components?: unknown[] }[];
function computeSetId(p: Record<string, unknown>): Hex {
  return keccak256(encodeAbiParameters(SET_PARAMS as never, SET_PARAMS.map((c) => p[c.name]) as never));
}
