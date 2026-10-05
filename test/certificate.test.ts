// E4 (stable part): the indexer decodes the certificate calldata exactly as the contract and the solver encode it.
// Checked on every normative vector of solver/vectors (monorepo only; skipped in the standalone repo).
import { describe, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { decodeNewNodes, decodeRows, graphRoot, EncodingError } from "../src/lib/certificate.js";

// normative vectors: test/vectors in the standalone repo, ../../solver/vectors in the ANCRE monorepo
const LOCAL = new URL("./vectors/", import.meta.url);
const DIR = existsSync(LOCAL) ? LOCAL : new URL("../../solver/vectors/", import.meta.url);
const VECTORS = existsSync(DIR)
  ? [...readdirSync(DIR).filter((f) => f.endsWith(".json")),
     ...readdirSync(new URL("violations/", DIR)).filter((f) => f.endsWith(".json")).map((f) => `violations/${f}`)]
  : [];

describe.runIf(VECTORS.length > 0)("certificate calldata v1 (solver/vectors, violations included)", () => {
  for (const f of VECTORS) {
    it(`${f}: rows decode to the vector's rows and graphRoot matches`, (t) => {
      const v = JSON.parse(readFileSync(new URL(f, DIR), "utf8"));
      const k = v.set.anchors.length;
      const d = decodeRows(v.calldata.rows, v.nCert, k);
      t.expect(d.rows.map((r) => ({
        u: r.u, source: r.src ?? null, via: r.u < k ? "anchor" : !r.src ? (v.nodes[r.u].kind === "address" ? "address" : "none") : r.viaOwner ? "owner" : "wallet",
        aliasOf: r.aliasOf ?? null, bPlus: Math.max(10_000, r.sPlusEffective), edges: r.edges,
      }))).toEqual(v.rows.map((r: any) => ({
        u: r.u, source: r.source ?? null, via: r.via, aliasOf: r.aliasOf ?? null, bPlus: r.bPlus,
        edges: r.edges.map((e: any) => ({ dst: e.dst, w: e.w, feedbackIndex: e.feedbackIndex })),
      })));
      t.expect(graphRoot(d.rows.map((r) => r.leaf))).toBe(v.expected.graphRoot);
      const nodes = decodeNewNodes(v.calldata.newNodes);
      t.expect(nodes.map((n) => (n.kind === "agent" ? `a${n.agentId}` : `x${n.address}`))).toEqual(
        v.nodes.slice(k).map((n: any) => (n.kind === "agent" ? `a${n.agentId}` : `x${n.address.toLowerCase()}`)));
    });
  }
});

describe("certificate calldata: structural rejects (as the contract)", () => {
  it("rejects a zero weight, a non-increasing dst and trailing bytes", (t) => {
    // W=2, 1 row: u=0, nE=1, dst=1, w=0, fi=1
    t.expect(() => decodeRows("0x02" + "00000001" + "0000" + "0001" + "0001" + "0000" + "00000001")).toThrow(EncodingError);
    t.expect(() => decodeRows("0x02" + "00000001" + "0000" + "0002" + "0002" + "2710" + "00000001" + "0001" + "2710" + "00000001")).toThrow(EncodingError);
    t.expect(() => decodeRows("0x02" + "00000000" + "ff")).toThrow(EncodingError);
    t.expect(graphRoot([])).toBe("0x" + "00".repeat(32));
    t.expect(() => decodeRows("0x02zz")).toThrow(EncodingError);
    t.expect(() => decodeRows("0x02" + "00000000", 70_000)).toThrow(EncodingError);
  });
});
