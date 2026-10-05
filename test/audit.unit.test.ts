// Fast audit unit tests on a fake registry view (no network): rules added after the 05/10 code review.
import { describe, it } from "vitest";
import { auditRows, type NodeInfo, type RegistryView } from "../src/lib/audit.js";
import type { CertRow } from "../src/lib/certificate.js";
import { REF, ZERO } from "../src/lib/rules.js";

const A = "0x00000000000000000000000000000000000000aa"; // anchor
const C = "0x00000000000000000000000000000000000000cc"; // wallet of agent 7
const O = "0x00000000000000000000000000000000000000ee"; // owner
// registry: A vouches 100 for agent 7 (feedbackIndex 3); agent 7 has wallet C; agent 9 is burnt (owner and wallet 0)
const agents: Record<string, { owner: string; wallet: string; approved: string }> = {
  "7": { owner: O, wallet: C, approved: ZERO },
  "9": { owner: ZERO, wallet: ZERO, approved: ZERO },
};
const view: RegistryView = {
  agent: async (id) => agents[id],
  isOperator: async () => false,
  latest: async (client, agentId, tag1) =>
    client === A && agentId === "7" && tag1 === "vouch" ? { tag1, value: 100n, decimals: 0, feedbackIndex: 3n } : undefined,
  agentsRatedBy: async (client) => (client === A ? ["7"] : []),
};
const nodes: NodeInfo[] = [{ kind: "anchor", address: A }, { kind: "agent", agentId: 7n }, { kind: "agent", agentId: 9n }];
const row = (r: Partial<CertRow> & { u: number }): CertRow =>
  ({ viaOwner: false, edges: [], sPlusEffective: 0, leaf: "0x00", ...r }) as CertRow;
const kinds = async (rows: CertRow[]) => (await auditRows(view, REF, nodes, 3, rows)).discrepancies.map((d) => d.kind);

describe("audit rules (fake registry)", () => {
  it("honest: anchor row + agent 7 (source C, empty) + burnt agent 9 (source-less, empty) -> 0 discrepancy", async (t) => {
    t.expect(await kinds([
      row({ u: 0, edges: [{ dst: 1, w: 10_000, feedbackIndex: 3 }], sPlusEffective: 10_000 }),
      row({ u: 1, src: C }),
      row({ u: 2 }),
    ])).toEqual([]);
  });
  it("same weight, wrong feedbackIndex -> WRONG_INDEX", async (t) => {
    t.expect(await kinds([row({ u: 0, edges: [{ dst: 1, w: 10_000, feedbackIndex: 1 }], sPlusEffective: 10_000 })])).toEqual(["WRONG_INDEX"]);
  });
  it("shape: SRC on an anchor row, a source-less agent row with SPLUS -> SHAPE", async (t) => {
    t.expect(await kinds([row({ u: 0, src: C, edges: [{ dst: 1, w: 10_000, feedbackIndex: 3 }], sPlusEffective: 10_000 })])).toEqual(["SHAPE"]);
    t.expect(await kinds([row({ u: 2, sPlus: 5_000, sPlusEffective: 5_000 })])).toEqual(["SHAPE"]);
  });
  it("a burnt agent is not UNKNOWN_AGENT; a never-minted one is", async (t) => {
    t.expect(await kinds([row({ u: 2 })])).toEqual([]);
    const ghost: NodeInfo[] = [...nodes.slice(0, 2), { kind: "agent", agentId: 404n }];
    t.expect((await auditRows(view, REF, ghost, 3, [row({ u: 2 })])).discrepancies.map((d) => d.kind)).toEqual(["UNKNOWN_AGENT"]);
  });
});
