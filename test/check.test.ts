// scripts/check.ts (live consistency check): pagination and feedback comparison (review 06/10, K22 and CHECKCOV).
import { describe, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, stringToBytes, toHex } from "viem";
import { feedbackDiff, feedbacksToCompare, paginate, type IndexedFeedback } from "../scripts/check.js";

describe("check.ts", () => {
  it("code review: launched through a symlinked path, main() still runs (no silent exit 0)", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "ancre-check-"));
    symlinkSync(new URL("..", import.meta.url).pathname, join(dir, "ix"));
    const r = spawnSync(process.execPath, ["--experimental-strip-types", join(dir, "ix/scripts/check.ts"), "--endpoint", "http://127.0.0.1:1/v1/graphql"],
      { encoding: "utf8" });
    t.expect(r.status).toBe(2); // main ran and failed on the unreachable endpoint
  });

  it("K22: pagination stops on an EMPTY page, not on a short one (server row cap below the page size)", async (t) => {
    const rows = [...Array(2_345).keys()].map((i) => ({ id: String(i).padStart(5, "0") }));
    let calls = 0;
    const capped = async (last: string) => { calls++; return rows.filter((r) => r.id > last).slice(0, 700); }; // cap 700 < 1000
    t.expect((await paginate(capped)).length).toBe(2_345);
    t.expect(calls).toBe(5); // 4 pages + 1 empty
  });

  const f: IndexedFeedback = { id: "4-0xa-2", agent_id: "4", client: "0xa", feedbackIndex: "2", value: "-100", valueDecimals: 0,
    tagHash: keccak256(stringToBytes("slash")), triple: "0xa-4-h", blockNumber: "10", revokedAtBlock: null };
  const chain = (over: Partial<{ v: bigint; d: number; tag: string; rev: boolean }> = {}) =>
    [over.v ?? -100n, over.d ?? 0, toHex(stringToBytes(over.tag ?? "slash")), "0x", over.rev ?? false] as const;

  it("CHECKCOV: value, decimals, tag (by hash) and revocation are compared with readFeedback", (t) => {
    t.expect(feedbackDiff(f, chain(), 20n)).toEqual([]);
    t.expect(feedbackDiff(f, chain({ rev: true }), 20n)).toEqual(["isRevoked true vs false"]); // a missed FeedbackRevoked
    t.expect(feedbackDiff(f, chain({ tag: "slash\u0000" }), 20n)).toEqual(["tag1 hash"]);        // a NUL-stripped tag
    t.expect(feedbackDiff(f, chain({ v: 5n, d: 2 }), 20n)).toEqual(["value 5 vs -100", "decimals 2 vs 0"]);
    t.expect(feedbackDiff({ ...f, revokedAtBlock: "30" }, chain(), 20n)).toEqual([]); // revoked after the checked block
    t.expect(feedbackDiff(f, undefined, 20n)).toEqual(["readFeedback failed"]);
  });

  it("the latest feedback of each triple is compared by default, every feedback with --full", (t) => {
    const g = { ...f, id: "4-0xa-1", feedbackIndex: "1" };
    t.expect(feedbacksToCompare([g, f], false).map((x) => x.id)).toEqual(["4-0xa-2"]);
    t.expect(feedbacksToCompare([g, f], true).length).toBe(2);
  });
});
