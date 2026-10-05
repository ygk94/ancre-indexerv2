// Certificate calldata decoding (contracts/ENCODING.md §2-3, format ancre-cert-v1, unified 01/10).
// Pure functions: no network, safe to run in both handler phases.
import { bytesToHex, hexToBytes as viemHexToBytes, isHex, keccak256, type Hex } from "viem";

export type CertEdge = { dst: number; w: number; feedbackIndex: number };
/**
 * One committed row. `src` = the source client of an agent row (SRC bit), `viaOwner` = VIA_OWNER bit (D44),
 * `sPlus` = DECLARED true positive sum (SPLUS bit, D32), `aliasOf` = u of the copied row (ALIAS bit, D20).
 * `edges` are expanded (an alias inherits its ref's edges); `sPlusEffective` = declared sPlus, else the committed Σw+
 * (an alias inherits its ref's). B+ = max(10 000, sPlusEffective) (ENCODING §4).
 */
export type CertRow = {
  u: number; src?: string; viaOwner: boolean; sPlus?: number; aliasOf?: number;
  edges: CertEdge[]; sPlusEffective: number; leaf: Hex;
};
export type DecodedRows = { W: 2 | 4; rows: CertRow[] };
export type NewNode = { kind: "agent"; agentId: bigint } | { kind: "address"; address: string };

export class EncodingError extends Error {}

const hexToBytes = (h: string): Uint8Array => {
  if (!isHex(h, { strict: true }) || h.length % 2) throw new EncodingError("invalid hex");
  return viemHexToBytes(h as Hex);
};
const toHex = (b: Uint8Array): Hex => bytesToHex(b);
const uint = (b: Uint8Array, o: number, n: number) => {
  if (o + n > b.length) throw new EncodingError(`truncated at ${o}`);
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i]!;
  return v;
};

const SRC = 0x8000;
const SPLUS = 0x4000;
const ALIAS = 0x2000;
const VIA_OWNER = 0x1000;
const NE_MASK = 0x0fff;

/**
 * rows = W:u8 ‖ numRows:u32 ‖ row*;  row = u:W ‖ hdr:u16 ‖ [src:20] ‖ [sPlus:u32] ‖ [ref:W] ‖ (dst:W ‖ w:int16 ‖ feedbackIndex:u32)*nE
 * Leaf = the row bytes from u to its last byte. Structural and shape checks mirror the contract (ENCODING §3.2);
 * `k` (number of anchors) enables the anchor-specific checks.
 */
export function decodeRows(hex: string, nCert?: number, k?: number): DecodedRows {
  const b = hexToBytes(hex);
  const W = uint(b, 0, 1);
  if (W !== 2 && W !== 4) throw new EncodingError(`bad W ${W}`);
  if (W === 2 && nCert !== undefined && nCert > 0xffff) throw new EncodingError("W = 2 with nCert > 65 535"); // BadRows(1)
  const numRows = uint(b, 1, 4);
  if (nCert !== undefined && numRows > nCert) throw new EncodingError("numRows > nCert");
  let o = 5;
  const rows: CertRow[] = [];
  const byU = new Map<number, CertRow>();
  let prevU = -1;
  for (let r = 0; r < numRows; r++) {
    const start = o;
    const u = uint(b, o, W); o += W;
    const hdr = uint(b, o, 2); o += 2;
    const nE = hdr & NE_MASK;
    if (nE > 256) throw new EncodingError(`row ${r}: nE ${nE} > ROW_MAX`);
    if (u <= prevU || (nCert !== undefined && u >= nCert)) throw new EncodingError(`row ${r}: bad u ${u}`);
    prevU = u;
    let src: string | undefined;
    if (hdr & SRC) { if (o + 20 > b.length) throw new EncodingError("truncated src"); src = toHex(b.subarray(o, o + 20)).toLowerCase(); o += 20; }
    let sPlus: number | undefined;
    if (hdr & SPLUS) { sPlus = uint(b, o, 4); o += 4; }
    let aliasOf: number | undefined;
    if (hdr & ALIAS) { aliasOf = uint(b, o, W); o += W; }
    const viaOwner = (hdr & VIA_OWNER) !== 0;
    if (viaOwner && !src) throw new EncodingError(`row ${r}: VIA_OWNER without SRC`);
    if (k !== undefined && u < k && (src || viaOwner)) throw new EncodingError(`row ${r}: anchor row with SRC/VIA_OWNER`);
    const edges: CertEdge[] = [];
    let prevDst = -1;
    for (let e = 0; e < nE; e++) {
      const dst = uint(b, o, W); o += W;
      let w = uint(b, o, 2); o += 2;
      if (w >= 0x8000) w -= 0x10000;
      const feedbackIndex = uint(b, o, 4); o += 4;
      if (dst <= prevDst || dst === u || (nCert !== undefined && dst >= nCert)) throw new EncodingError(`row ${r}: bad dst ${dst}`);
      if (w === 0 || Math.abs(w) > 10_000) throw new EncodingError(`row ${r}: bad w ${w}`);
      prevDst = dst;
      edges.push({ dst, w, feedbackIndex });
    }
    const committedPlus = edges.reduce((s, e) => s + (e.w > 0 ? e.w : 0), 0);
    if (sPlus !== undefined && sPlus < Math.max(1, committedPlus)) throw new EncodingError(`row ${r}: sPlus below committed Σw+`); // BadRows(7)
    let row: CertRow;
    if (aliasOf !== undefined) {
      const ref = byU.get(aliasOf);
      if (nE !== 0 || sPlus !== undefined) throw new EncodingError(`row ${r}: alias with edges or SPLUS`);          // BadRows(8)
      if (!ref || ref.aliasOf !== undefined || aliasOf >= u || (k !== undefined && u < k)) throw new EncodingError(`row ${r}: bad alias ref`); // BadRows(9)
      if (!src || ref.src !== src) throw new EncodingError(`row ${r}: alias source differs from ref`);              // BadRows(10)
      row = { u, src, viaOwner, aliasOf, edges: ref.edges.map((e) => ({ ...e })), sPlusEffective: ref.sPlusEffective,
        leaf: keccak256(b.subarray(start, o)) };
    } else {
      row = { u, src, viaOwner, sPlus, edges, sPlusEffective: sPlus ?? committedPlus, leaf: keccak256(b.subarray(start, o)) };
    }
    rows.push(row);
    byU.set(u, row);
  }
  if (o !== b.length) throw new EncodingError(`trailing bytes: ${b.length - o}`);
  return { W: W as 2 | 4, rows };
}

/** Pairwise keccak reduction; an odd element moves up unchanged; 0x0 when there is no row (_merkleRoot). */
export function graphRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return ("0x" + "00".repeat(32)) as Hex;
  let level = leaves.slice();
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push(keccak256(("0x" + level[i]!.slice(2) + level[i + 1]!.slice(2)) as Hex));
    if (level.length % 2) next.push(level[level.length - 1]!);
    level = next;
  }
  return level[0]!;
}

/** newNodes = (0x01 ‖ agentId:u32 | 0x02 ‖ address:20)* */
export function decodeNewNodes(hex: string): NewNode[] {
  const b = hexToBytes(hex);
  const out: NewNode[] = [];
  let o = 0;
  while (o < b.length) {
    const kind = b[o++];
    if (kind === 1) { out.push({ kind: "agent", agentId: BigInt(uint(b, o, 4)) }); o += 4; }
    else if (kind === 2) {
      if (o + 20 > b.length) throw new EncodingError("truncated address node");
      out.push({ kind: "address", address: toHex(b.subarray(o, o + 20)).toLowerCase() }); o += 20;
    } else throw new EncodingError(`bad node kind ${kind}`);
  }
  return out;
}
