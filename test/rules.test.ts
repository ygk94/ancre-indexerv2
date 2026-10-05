// Unit tests on simulated events: the normative edge rules (D14, D15, bounds, D16/D20) inside the indexer.
import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { readFileSync, existsSync } from "node:fs";
import { quantize, REF_SCHEMA, decToWad } from "../src/lib/rules.js";

type Hex = `0x${string}`;
const ZERO: Hex = "0x0000000000000000000000000000000000000000";
const EA0B: Hex = "0xea0b21fb2441464f4920ce3e34d478235605816b";
const OWNER4: Hex = "0x1111111111111111111111111111111111111111";
const X0730: Hex = "0x0730536018541c5149a049d35528a76c2c8f1e6b";
const W8317: Hex = "0x449854134593bcb92c1244cfb382b5ab6254eead";

const mint = (tokenId: bigint, to: Hex) => ({
  contract: "IdentityRegistry" as const, event: "Transfer" as const, params: { from: ZERO, to, tokenId },
});
const setWallet = (agentId: bigint, wallet: Hex) => ({
  contract: "IdentityRegistry" as const, event: "MetadataSet" as const,
  params: { agentId, indexedMetadataKey: "", metadataKey: "agentWallet", metadataValue: wallet },
});
const fb = (agentId: bigint, client: Hex, feedbackIndex: bigint, value: bigint, tag1: string, valueDecimals = 0n) => ({
  contract: "ReputationRegistry" as const, event: "NewFeedback" as const,
  params: { agentId, clientAddress: client, feedbackIndex, value, valueDecimals, indexedTag1: "", tag1, tag2: "",
    endpoint: "", feedbackURI: "", feedbackHash: ("0x" + "00".repeat(32)) as Hex },
});

describe("quantize (graph.quantize port)", () => {
  it("matches the solver on the reference tags", (t) => {
    const s = (k: string) => REF_SCHEMA.get(k)!;
    t.expect(quantize(-100n, 0, s("slash"))).toBe(-10000);
    t.expect(quantize(1n, 0, s("slash"))).toBeUndefined(); // positive side is empty -> out of bounds
    t.expect(quantize(90n, 0, s("quality"))).toBe(8000);
    t.expect(quantize(40n, 0, s("quality"))).toBe(-2000); // 40/100 with neutral 50 -> distrust
    t.expect(quantize(4999n, 2, s("quality"))).toBe(-2); // 49.99 -> -(0.01/50)*1e4 = -2
    t.expect(quantize(10n ** 38n, 0, s("vouch"))).toBeUndefined();
    t.expect(quantize(0n, 0, s("vouch"))).toBe(0);
    t.expect(decToWad("-0.5")).toBe(-(5n * 10n ** 17n));
  });
});

describe("schema copy", () => {
  // The Cloud forbids imports outside the indexer folder, so the schema is copied. In the monorepo, it must
  // stay byte-identical to the solver's (the reference). Skipped in the standalone ancre-indexer repo.
  const solver = new URL("../../solver/schema_reference.json", import.meta.url);
  it.runIf(existsSync(solver))("src/lib/schema_reference.json == solver/schema_reference.json", (t) => {
    t.expect(readFileSync(new URL("../src/lib/schema_reference.json", import.meta.url), "utf8")).toBe(readFileSync(solver, "utf8"));
  });
});

describe("reference edges (SetEdge, set \"ref\")", () => {
  it("#4: slash -100 then review +1 from 0xea0b -> negative dominance keeps -10000 (D14)", async (t) => {
    const ix = createTestIndexer();
    await ix.process({ chains: { 143: { simulate: [
      mint(4n, OWNER4),
      fb(4n, EA0B, 1n, -100n, "slash"),
      fb(4n, EA0B, 2n, 1n, "review"),
    ] } } });
    const e = await ix.SetEdge.getOrThrow(`ref-${EA0B}-4`);
    t.expect(e.w).toBe(-10000);
    t.expect(e.decidingTag).toBe("slash");
    t.expect(e.rejected).toBeUndefined();
  });

  it("#8317: feedback from its own agentWallet is a self-rating and never an edge (D16)", async (t) => {
    const ix = createTestIndexer();
    await ix.process({ chains: { 143: { simulate: [
      mint(8317n, OWNER4),
      setWallet(8317n, W8317),
      fb(8317n, W8317, 1n, 90n, "quality"),
    ] } } });
    const e = await ix.SetEdge.getOrThrow(`ref-${W8317}-8317`);
    t.expect(e.w).toBe(0);
    t.expect(e.rejected).toBe("CONTROLLER_WALLET");
    const f = await ix.Feedback.getOrThrow(`8317-${W8317}-1`);
    t.expect(f.clientWasController).toBe("agentWallet");
    t.expect((await ix.ChainStats.getOrThrow("stats")).selfRatings).toBe(1);
  });

  it("1e38 is rejected, never capped, and does not fall back to an older in-bounds feedback", async (t) => {
    const ix = createTestIndexer();
    await ix.process({ chains: { 143: { simulate: [
      mint(182n, OWNER4),
      fb(182n, EA0B, 1n, 80n, "vouch"),
      fb(182n, EA0B, 2n, 10n ** 38n, "vouch"),
    ] } } });
    const e = await ix.SetEdge.getOrThrow(`ref-${EA0B}-182`);
    t.expect(e.w).toBe(0);
    t.expect(e.rejected).toBe("OUT_OF_BOUNDS");
    t.expect((await ix.ChainStats.getOrThrow("stats")).outOfRange).toBe(1);
  });

  it("measurement and unknown tags create no edge (D15)", async (t) => {
    const ix = createTestIndexer();
    await ix.process({ chains: { 143: { simulate: [
      mint(9n, OWNER4),
      fb(9n, EA0B, 1n, 1500n, "elo"),
      fb(9n, EA0B, 2n, 5n, "not-in-schema"),
    ] } } });
    t.expect(await ix.SetEdge.get(`ref-${EA0B}-9`)).toBeUndefined();
    t.expect((await ix.ChainStats.getOrThrow("stats")).feedbacks).toBe(2);
  });

  it("a transfer to the client turns an existing edge into an owner rejection, and wallets are re-indexed", async (t) => {
    const ix = createTestIndexer();
    await ix.process({ chains: { 143: { simulate: [
      mint(18n, OWNER4),
      setWallet(18n, EA0B),
      setWallet(22n, EA0B),
      fb(18n, X0730, 1n, 100n, "vouch"),
    ] } } });
    t.expect((await ix.SetEdge.getOrThrow("ref-0x0730536018541c5149a049d35528a76c2c8f1e6b-18")).w).toBe(10000);
    let stats = await ix.ChainStats.getOrThrow("stats");
    t.expect([stats.sharedWallets, stats.agentsOnSharedWallets]).toEqual([1, 2]);
    await ix.process({ chains: { 143: { simulate: [
      setWallet(18n, "0x"), // cleared on transfer (MESURÉ 72/72 on Monad)
      { contract: "IdentityRegistry" as const, event: "Transfer" as const,
        params: { from: OWNER4, to: X0730, tokenId: 18n } },
    ] } } });
    const e = await ix.SetEdge.getOrThrow("ref-0x0730536018541c5149a049d35528a76c2c8f1e6b-18");
    t.expect(e.w).toBe(0);
    t.expect(e.rejected).toBe("CONTROLLER_OWNER");
    const a = await ix.Agent.getOrThrow("18");
    t.expect([a.wallet, a.transferCount]).toEqual([ZERO, 1]);
    stats = await ix.ChainStats.getOrThrow("stats");
    t.expect([stats.sharedWallets, stats.agentsOnSharedWallets, stats.refEdges]).toEqual([0, 0, 0]);
  });

  it("revoking the latest feedback of a triple falls back to the previous non-revoked one", async (t) => {
    const ix = createTestIndexer();
    await ix.process({ chains: { 143: { simulate: [
      mint(2n, OWNER4),
      fb(2n, EA0B, 1n, 100n, "vouch"),
      fb(2n, EA0B, 2n, 30n, "vouch"),
      { contract: "ReputationRegistry" as const, event: "FeedbackRevoked" as const,
        params: { agentId: 2n, clientAddress: EA0B, feedbackIndex: 2n } },
    ] } } });
    const e = await ix.SetEdge.getOrThrow(`ref-${EA0B}-2`);
    t.expect([e.w, e.feedbackIndex]).toEqual([10000, 1n]);
    t.expect((await ix.ChainStats.getOrThrow("stats")).revoked).toBe(1);
  });

  it("revoking every reference feedback of a pair gives NO_ACTIVE_FEEDBACK, not OUT_OF_BOUNDS", async (t) => {
    const ix = createTestIndexer();
    await ix.process({ chains: { 143: { simulate: [
      mint(2n, OWNER4),
      fb(2n, EA0B, 1n, 80n, "vouch"),
      { contract: "ReputationRegistry" as const, event: "FeedbackRevoked" as const,
        params: { agentId: 2n, clientAddress: EA0B, feedbackIndex: 1n } },
    ] } } });
    const e = await ix.SetEdge.getOrThrow(`ref-${EA0B}-2`);
    t.expect([e.w, e.rejected]).toEqual([0, "NO_ACTIVE_FEEDBACK"]);
    t.expect((await ix.ChainStats.getOrThrow("stats")).refEdges).toBe(0);
  });

  it("R5 tie between tags of equal weight: the highest feedbackIndex decides (format v1), not the tag name", async (t) => {
    const ix = createTestIndexer();
    await ix.process({ chains: { 143: { simulate: [
      mint(2n, OWNER4),
      fb(2n, EA0B, 1n, 100n, "vouch"),   // +10000
      fb(2n, EA0B, 2n, 1n, "review"),    // +10000, higher index
    ] } } });
    const e = await ix.SetEdge.getOrThrow(`ref-${EA0B}-2`);
    t.expect([e.w, e.decidingTag, e.feedbackIndex]).toEqual([10000, "review", 2n]);
  });
});
