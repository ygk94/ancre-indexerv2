// E3 parity: the indexer replays the real history of each chain (HyperSync) up to a fixed block and must
// produce exactly the reference edges computed by solver/graph.py (fixtures frozen from the solver by
// analytics/survival_scan.py + analytics/export_fixture.py), plus the same registry figures.
// Slow (full history): run with `pnpm test:parity`.
import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { readdirSync, readFileSync } from "node:fs";

const START: Record<number, number> = { 143: 52_952_790, 10143: 10_391_697, 10: 147_514_947 }; // = config.yaml
const DIR = new URL("./fixtures/", import.meta.url);
const FIXTURES = readdirSync(DIR)
  .filter((f) => /^ref_edges_\d+_\d+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(new URL(f, DIR), "utf8")));

describe.runIf(process.env.PARITY === "1")("parity with solver/graph.py", () => {
  for (const REF of FIXTURES) {
    it(`chain ${REF.chainId} at block ${REF.block}: same reference edges and registry figures`, async (t) => {
      const ix = createTestIndexer();
      await ix.process({ chains: { [REF.chainId]: { startBlock: START[REF.chainId]!, endBlock: REF.block } } });

      const edges = (await ix.SetEdge.getAll())
        .filter((e) => e.set_id === "ref" && e.rejected === undefined && e.w !== 0)
        .map((e) => ({ client: e.client, agent: e.agent_id, w: e.w, tag1: e.decidingTag, feedbackIndex: String(e.feedbackIndex) }))
        .sort((a, b) => (a.client < b.client ? -1 : a.client > b.client ? 1 : Number(a.agent) - Number(b.agent)));
      t.expect(edges).toEqual(REF.edges);

      const s = await ix.ChainStats.getOrThrow("stats");
      t.expect({
        agentsMinted: s.agents, transfers: s.transfers, sharedWallets: s.sharedWallets,
        agentsOnSharedWallets: s.agentsOnSharedWallets, feedbacks: s.feedbacks, revoked: s.revoked, absValueGe1e38: s.outOfRange,
      }).toEqual((({ couples: _c, ...rest }) => rest)(REF.counts));

      const fbs = await ix.Feedback.getAll();
      t.expect(new Set(fbs.map((f) => `${f.client}-${f.agent_id}`)).size).toBe(REF.counts.couples);

      if (REF.chainId === 143) {
        // Self-ratings: the indexer evaluates controllers at each feedback's block, the scan at the final block.
        // On Monad they coincide (78 feedbacks of #8317 by its own agentWallet); checked explicitly.
        const self = fbs.filter((f) => f.clientWasController !== undefined);
        t.expect(self.length).toBe(78);
        t.expect(new Set(self.map((f) => `${f.agent_id}:${f.clientWasController}`))).toEqual(new Set(["8317:agentWallet"]));
        t.expect(s.selfRatings).toBe(78);
      }
    }, 900_000);
  }
});
