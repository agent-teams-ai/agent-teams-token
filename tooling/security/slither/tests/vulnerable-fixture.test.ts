import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerVulnerableFixtureCreateArguments, IMAGE } from "../src/adapters/container-contract.ts";
import { findingFingerprint, normalizedIdentityHash, sha256, sourceLocation } from "../src/adapters/fingerprint.ts";
import { evaluateVulnerableFixture } from "../src/application/policy.ts";
import type { Finding } from "../src/domain/model.ts";

test("vulnerable fixture uses the same pinned hardened container contract", () => {
  const joined = dockerVulnerableFixtureCreateArguments({ input: "/tmp/input", forge: "/tmp/forge", solc: "/tmp/solc", imagePath: "/official/bin:/usr/bin:/bin", pythonPath: "/official/python" }).join(" ");
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
  assert.equal(evaluateVulnerableFixture([finding], sha256(source)).exitCode, 20);
  assert.equal(evaluateVulnerableFixture([], sha256(source)).exitCode, 40);
  assert.equal(evaluateVulnerableFixture([{...finding, detectorId:"tx-origin"}], sha256(source)).exitCode, 40);
  assert.equal(evaluateVulnerableFixture([{...finding, location:{...finding.location,path:"contracts/evm/src/Other.sol"}}], sha256(source)).exitCode, 40);
});
