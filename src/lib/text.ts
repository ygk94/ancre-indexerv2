// Free text from the chain (tags, URIs, endpoints) is attacker-controlled: it never enters a key or an index, and it is
// stored in a form Postgres always accepts (NUL-free, well-formed UTF-16), so that Envio's NUL escape-and-retry never
// rewrites a row behind our back (review 06/10, NUL and LONGTAG).
//
//   key   = keccak256(tag1 bytes), as the contract compares tags (AM-04.2) and as the event's indexedTag1 topic carries it
//   text  = the raw text when it is exact (no U+0000, well-formed, at most TEXT_MAX UTF-8 bytes, hashes to the key),
//           else an escaped and truncated display form, flagged `exact = false`: it must never be matched as a tag.
import { keccak256, stringToBytes, type Hex } from "viem";

export const TEXT_MAX = 1024; // bytes kept for display (the key is the hash, whatever the length)

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const memo = new Map<string, Hex>(); // schema tags are hashed on every lookup: a handful of distinct strings
/** keccak256 of the tag bytes. Prefers the event topic (exact even when the decoded text is lossy). */
export function tagHash(tag1: string, indexedTopic?: string): Hex {
  if (indexedTopic && HASH_RE.test(indexedTopic)) return indexedTopic.toLowerCase() as Hex;
  let h = memo.get(tag1);
  if (!h) {
    h = keccak256(stringToBytes(tag1));
    if (memo.size < 4096 && tag1.length <= 256) memo.set(tag1, h); // bounded: feedback tags are attacker-chosen
  }
  return h;
}

/** Marker of a schema tag whose bytes are not valid UTF-8 (src/lib/calls.ts): "<marker>0x<hex>". A schema can only
 *  hold it through calldata; a feedback is matched by its topic, never through this function. */
export const BYTES_TAG = "\u0000bytes:";
/** keccak256 of a SCHEMA tag's bytes (the text, or the bytes behind the BYTES_TAG marker). */
export function schemaTagHash(tag: string): Hex {
  if (tag.startsWith(BYTES_TAG + "0x")) return keccak256(tag.slice(BYTES_TAG.length) as Hex);
  return tagHash(tag);
}

const isWellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

/** Postgres-safe display text: NUL and lone surrogates escaped (\u0000), truncated to TEXT_MAX bytes. */
export function safeText(s: string): { text: string; exact: boolean } {
  const clean = !s.includes("\u0000") && isWellFormed(s);
  if (clean && stringToBytes(s).length <= TEXT_MAX) return { text: s, exact: true };
  let out = clean ? s : s.replace(/[\u0000]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  if (stringToBytes(out).length > TEXT_MAX) out = utf8Prefix(out, TEXT_MAX - 3) + "...";
  return { text: out, exact: false };
}

/** Longest prefix of whole code points that fits in `max` UTF-8 bytes (one pass, stops at the limit). */
function utf8Prefix(s: string, max: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > max) break;
    bytes += n;
    end += ch.length;
  }
  return s.slice(0, end);
}

/** A tag as stored: hash (key), display text, and whether the text is the exact tag (safe to match by text). */
export function storedTag(tag1: string, indexedTopic?: string): { hash: Hex; text: string; exact: boolean } {
  const hash = tagHash(tag1, indexedTopic);
  const { text, exact } = safeText(tag1);
  return { hash, text, exact: exact && tagHash(tag1) === hash };
}

/** Key of the D14 unit (client, agent, tag): fixed length whatever the tag. */
export const tripleId = (client: string, agentId: string, hash: string) => `${client}-${agentId}-${hash}`;
