// scripts/publish.sh guard before `rsync --delete` (review 06/10, PUBLISH): only the ROOT of a clone whose origin is
// exactly ygk94/ancre-indexer is accepted. Runs the guard only (PUBLISH_CHECK_ONLY=1): no copy, no push.
import { describe, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/publish.sh", import.meta.url).pathname;
const env = { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH ?? ""}`, PUBLISH_CHECK_ONLY: "1" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env, stdio: "ignore" });
const guard = (dst: string) => spawnSync("bash", [SCRIPT, dst], { env, encoding: "utf8" }).status;

function clone(origin: string) {
  const d = mkdtempSync(join(tmpdir(), "ancre-publish-"));
  git(d, "init", "-q");
  git(d, "remote", "add", "origin", origin);
  mkdirSync(join(d, "src"));
  return d;
}

// publish.sh is not copied to the standalone repo: monorepo only
describe.runIf(existsSync(SCRIPT) && spawnSync("git", ["--version"], { env }).status === 0)("publish.sh guard", () => {
  it("accepts the work-tree root of an exact ygk94/ancre-indexer clone", (t) => {
    t.expect(guard(clone("https://github.com/ygk94/ancre-indexer.git"))).toBe(0);
    t.expect(guard(clone("git@github.com:ygk94/ancre-indexer"))).toBe(0);
  });
  it("refuses .git, a sub-folder, a look-alike origin and a missing folder", (t) => {
    const d = clone("https://github.com/ygk94/ancre-indexer.git");
    t.expect(guard(join(d, ".git"))).not.toBe(0);
    t.expect(guard(join(d, "src"))).not.toBe(0);
    t.expect(guard(clone("https://github.com/evil/ygk94/ancre-indexer-fork.git"))).not.toBe(0);
    t.expect(guard(clone("https://github.com/ygk94/ancre-indexer.git.evil"))).not.toBe(0);
    t.expect(guard(join(d, "nope"))).not.toBe(0);
  });
});
