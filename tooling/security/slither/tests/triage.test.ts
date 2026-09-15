import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateFindingTriage } from "../src/application/triage.ts";
import { findingFingerprint, normalizedIdentityHash, sha256, sourceLocation } from "../src/adapters/fingerprint.ts";
import { assertSerializedAgainstSchema } from "../src/adapters/json-schema.ts";
import { parseSlitherJson } from "../src/adapters/slither-json.ts";
import type { Finding, FindingTriage } from "../src/domain/model.ts";

const source = "contract A {}";
const base = { detectorId: "naming-convention", impact: "Informational" as const, confidence: "High", identity: "name", findingIdentityHash: normalizedIdentityHash("name"), location: sourceLocation("contracts/evm/src/A.sol", 0, 8, source) };
const finding: Finding = { ...base, fingerprint: findingFingerprint(base) };
const triage: FindingTriage = { schemaVersion: 1, fingerprint: finding.fingerprint, owner: "security", disposition: "accepted-design", rationale: "Public token constants intentionally follow Solidity constant naming.", reviewedAt: "2026-08-29T00:00:00Z" };

test("every visible lower-impact fingerprint requires exact current triage", () => {
  assert.deepEqual(validateFindingTriage([finding], [triage]), []);
  assert.match(validateFindingTriage([finding], [])[0] ?? "", /requires exactly one/u);
  assert.match(validateFindingTriage([], [triage])[0] ?? "", /stale/u);
  assert.match(validateFindingTriage([finding], [triage, triage])[0] ?? "", /unique/u);
});

test("production triage pins the exact current captured findings without suppressing them", async () => {
  const raw = await readFile("tooling/security/slither/triage.v1.json", "utf8");
  await assertSerializedAgainstSchema(raw, "tooling/security/slither/triage-ledger.schema.v1.json");
  const document = JSON.parse(raw) as {
    schemaVersion: number;
    findings: FindingTriage[];
  };
  const suppressions = JSON.parse(await readFile("tooling/security/slither/suppressions.v1.json", "utf8")) as {
    suppressions: { fingerprint: string; detectorId: string; sourceHash: string }[];
  };
  const expected = [
    "sha256:140af649035e807216f8c00445e94afd9bc7ead2c6e488c07a055e1a9f4351cb",
    "sha256:14d28e3d595e6c0183a7aa9af6506913ff42e526ababa720b0740d32c25076bb",
    "sha256:3e9bbd4f4becbedeaf399132a78aae873c16832f014081535116f8d9a71b58bf",
    "sha256:41a24f69881fa7e61a657184f095cca8f63b0294157d67d51f53c35fa205be6a",
    "sha256:f395435ae8382a9eb4bc8f3ee2c1dd920aa1736be8d305e12a37207ef71472a9",
    "sha256:6968e5dfe430c2af75b3853c25e887ca502f113bf9bda91f9534c82162306811",
    "sha256:8263a454f64d24c9db2b6ba6d64e2f87cd69bd6a25d40eeb480da1133e77acfa",
    "sha256:83f6581c3996d4e9b5968b277ce1ff495a578911f308179538cc8f86ed788d8c",
    "sha256:8dcdc97543baa44ed283ce33a2c4fc42bc59911a37b8b2d132787666173d54ff",
    "sha256:9d8ec352a3f51ab1633f119d920d738e74bfeac64ffdcae6a3f53ae7bcf64272",
    "sha256:cf3dec3433de4ea4c848ce18b2dcf0c2b034f800f9d37f47f038d32f767ebad1",
    "sha256:fb34e078e26432fff83d02582abcd0a15d915cf968edc1caa59ceb40a395ba82",
    "sha256:1b33a698b01a9588c2bfec6ab5c8d99b225d34821f174554f641cea86ff593a2",
    "sha256:5a4b67c294acc3ba734748554fb15f29296b9891f20cd24cd62e61f05cb908b0",
    "sha256:6a9eb1b35262e570240d647216f6240aaf9f3eb1c0b615e3542f48e96da43396",
    "sha256:6cba562ee91147d937d6c16b1094a83f333df909e852a027a4c6a4a463777443",
    "sha256:7ea3b090f6f4b90c801214b373cbbc46e2cca220e127347e382744940042cb50",
    "sha256:9f0e4495f3006b7bb7fed724098975f75fd3bcccff3280c5adb0df856aca2dcf",
    "sha256:ce70f4037558f57df4f3b299af5765113c5fa6ada98b6b6a94d33fd6d36d1d26",
    "sha256:d5b879fba117edb58befc8d6fc53ae3adf138e611a7327c5332e65a692664ccc",
    "sha256:efd8f5efafa87c1fad1e76342676ba8f2eb7122649f114a86e52179845e748c5",
  ];
  const reviewedDates = [
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-09-15T07:56:21.125Z",
    "2026-08-29T00:00:00.000Z",
    "2026-09-08T05:52:55.734Z",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-09-08T05:52:55.734Z",
    "2026-08-29T00:00:00.000Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
    "2026-09-15T07:56:21.125Z",
  ];

  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(document.findings.map(({ fingerprint }) => fingerprint), expected);
  assert.ok(document.findings.every(({ owner }) => owner === "project-security"));
  assert.deepEqual(document.findings.map(({ reviewedAt }) => reviewedAt), reviewedDates);
  assert.ok(document.findings.every(({ rationale }) => rationale.trim().length >= 20));
  assert.deepEqual(suppressions.suppressions.map(({ fingerprint, detectorId, sourceHash }) => ({ fingerprint, detectorId, sourceHash })), [
    {
      fingerprint: "sha256:704c6fd405b64b61d8f0712240be87d8ce8b180287dc75322e25459bd3cea098",
      detectorId: "divide-before-multiply",
      sourceHash: "sha256:52b9f943411da5187a7660d8125f2801f6ade1dc0271c660f4b6ee49b5efe13d",
    },
    {
      fingerprint: "sha256:4827979f6c7702c447c128b9ee3a92daf133e21a3c4c1ae04ea84b73db49d20c",
      detectorId: "arbitrary-send-erc20",
      sourceHash: "sha256:673cad0516c8e0068aa495e8fa5e93ae43cc84547b57c9bd824daec292e56a80",
    },
  ]);
});

// A live ledger update must never silently re-authorize historical captured output.
test("historical captured findings require retained triage and reject current triage", async () => {
  const historicalRaw = await readFile("tooling/security/slither/tests/fixtures/triage.8977f78.json", "utf8");
  assert.equal(sha256(historicalRaw), "da21f8a8a21ef827e4c96afc0d1a6a4527c63c5f66c6c1f7d46a915ad34c2cfe");
  const historical = JSON.parse(historicalRaw) as { findings: FindingTriage[] };
  const current = JSON.parse(await readFile("tooling/security/slither/triage.v1.json", "utf8")) as { findings: FindingTriage[] };
  const parsed = await parseSlitherJson(await readFile("tooling/security/slither/tests/fixtures/slither-0.11.6-production.json", "utf8"), process.cwd());
  assert.deepEqual(validateFindingTriage(parsed.findings, historical.findings), []);
  const errors = validateFindingTriage(parsed.findings, current.findings);
  assert.equal(errors.length, 11);
  assert.ok(errors.some((error) => error.includes("467424bcf1a60111645314c6c00da8f7fba5ddeb991f55d82eae0cd5b54c4742 requires exactly one")));
  assert.ok(errors.some((error) => error.includes("f395435ae8382a9eb4bc8f3ee2c1dd920aa1736be8d305e12a37207ef71472a9 is stale")));
});
