import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerVulnerableFixtureArguments, IMAGE } from "../src/adapters/container-contract.ts";
import { findingFingerprint, normalizedIdentityHash, sourceLocation } from "../src/adapters/fingerprint.ts";
import { evaluateVulnerableFixture } from "../src/application/policy.ts";
import type { Finding } from "../src/domain/model.ts";

test("vulnerable fixture uses the same pinned hardened container contract", () => {
  const joined = dockerVulnerableFixtureArguments({ input: "/tmp/input", output: "/tmp/output", forge: "/tmp/forge", solc: "/tmp/solc", imagePath: "/official/bin:/usr/bin:/bin", pythonPath: "/official/python", containerName: "agtmai-slither-vulnerable" }).join(" ");
  for (const required of [IMAGE, "--network none", "--read-only", "--user 1000:1000", "--cap-drop ALL", "dst=/input,readonly", "src/Vulnerable.sol", "slither . --fail-pedantic --foundry-ignore-compile", "slither.exit"]) {
    assert.match(joined, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
  assert.equal(joined.match(/--fail-pedantic/gu)?.length, 3);
  assert.equal(joined.includes("--fail-on pedantic"), false);
  assert.doesNotMatch(joined, /JSON\.stringify|manufactured|mock/u);
});

test("a real blocking detector result maps to required policy exit 20", () => {
  const source = "contract Vulnerable {}";
  const base = { detectorId: "suicidal", impact: "High" as const, confidence: "High", identity: "destroy", findingIdentityHash: normalizedIdentityHash("destroy"), location: sourceLocation("contracts/evm/src/Vulnerable.sol", 0, 8, source) };
  const finding: Finding = { ...base, fingerprint: findingFingerprint(base) };
  assert.equal(evaluateVulnerableFixture([finding]).exitCode, 20);
  assert.equal(evaluateVulnerableFixture([]).exitCode, 40);
});
