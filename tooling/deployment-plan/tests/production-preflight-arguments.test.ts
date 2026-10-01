import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const base = ["--prepared", "--expectations", "--observations", "--attempt-state"];
const candidate = ["--candidate-revision", "--repository-root"];
const pairs = (flags: readonly string[]): string[] => flags.flatMap(flag => [flag, "unused-preflight-input"]);

function check(args: readonly string[], reason = "PREFLIGHT_ARGUMENTS"): void {
  const result = spawnSync(process.execPath, [new URL("../src/composition/production-preflight.ts", import.meta.url).pathname, ...args], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    status: "invalid", reason, broadcastAllowed: false, coverage: "token-and-reserves-only",
    unresolvedPrerequisites: ["runtime immutable values require deterministic local execution", "Safe deployment and live authority observation", "contributor commitment execution", "authenticated live-chain evidence"],
  }, args.join(" "));
}

test("preflight rejects every four-pair subset missing a base flag", () => {
  const flags = [...base, ...candidate];
  for (let first = 0; first < flags.length; first++) {
    for (let second = first + 1; second < flags.length; second++) {
      if (first === 4 && second === 5) { continue; }
      check(pairs(flags.filter((_, index) => index !== first && index !== second)));
    }
  }
});

test("preflight requires both candidate options and rejects malformed pairs", () => {
  const valid = pairs(base);
  for (const args of [
    [], valid.slice(0, -2), [...valid, ...pairs([candidate[0]!])], [...valid, ...pairs([candidate[1]!])],
    pairs([base[0]!, base[1]!, base[2]!, base[2]!]),
    pairs([base[0]!, base[1]!, base[2]!, "--unknown"]),
    [...valid.slice(0, -1), ""], valid.slice(0, -1),
    pairs([...base, candidate[0]!, candidate[0]!]), pairs([...base, candidate[0]!, "--unknown"]),
    [...pairs([...base, ...candidate]).slice(0, -1), ""], pairs([...base, ...candidate]).slice(0, -1),
  ]) { check(args); }
});

test("preflight accepts exact four/six-pair forms in different orders before rejecting absent inputs", () => {
  for (const flags of [base, base.toReversed(), [...base, ...candidate], [...candidate, ...base].toReversed(),
    [candidate[0]!, base[2]!, base[0]!, candidate[1]!, base[3]!, base[1]!]]) {
    check(pairs(flags), "PREFLIGHT_INPUT");
  }
});
