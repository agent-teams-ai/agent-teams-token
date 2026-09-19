import assert from "node:assert/strict";
import test from "node:test";
import { assertReadinessBundle, assertReadinessFreshness } from "../src/application/readiness.ts";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluateReadiness } from "../src/domain/readiness.ts";
import { parseReadinessEvidence } from "../src/adapters/readiness-evidence.ts";

const base = () => ({
  schema: "agtmai-readiness-evidence-v1" as const, broadcastAllowed: false as const,
  manifestSha256: `0x${"11".repeat(32)}`, observedAt: "100", validUntil: "200",
  ethereum: { chainId: "1" as const, deployed: true, fixedSupply: "1000", backing: "500", pendingEthereumToSolana: "0", pendingSolanaToEthereum: "0", block: { number: "10", hash: `0x${"22".repeat(32)}`, timestamp: "100" }, authorityComplete: true },
  solana: { genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", deployed: true, supply: "500", authorityComplete: true, slot: "20", blockTime: "100" },
  protocolQualified: true, coverageComplete: true, estimates: { complete: true, operations: [] },
});

test("readiness reconciles fixed supply and rejects a surplus or under-backing claim", () => {
  const exact = evaluateReadiness(base());
  assert.equal(exact.status, "qualified");
  assert.equal(exact.reconciliation.status, "exact");
  assert.equal(exact.reconciliation.adjustedGlobalSupply, "1000");
  const surplus = evaluateReadiness({ ...base(), ethereum: { ...base().ethereum, backing: "600" } });
  assert.equal(surplus.status, "incomplete");
  assert.equal(surplus.reconciliation.status, "surplus");
  const under = evaluateReadiness({ ...base(), ethereum: { ...base().ethereum, backing: "400" } });
  assert.equal(under.status, "inconsistent");
  assert.ok(under.reasons.includes("under-backed"));
});

test("unknown pending effects remain explicitly unknown", () => {
  const report = evaluateReadiness({ ...base(), ethereum: { ...base().ethereum, pendingEthereumToSolana: null } });
  assert.equal(report.reconciliation.status, "unknown");
  assert.equal(report.reconciliation.adjustedGlobalSupply, null);
  assert.ok(report.reasons.includes("reconciliation-unknown"));
});

test("readiness evidence rejects duplicate JSON members before evaluation", () => {
  const value = JSON.stringify(base());
  assert.equal(JSON.stringify(parseReadinessEvidence(new TextEncoder().encode(value))), value);
  assert.throws(() => parseReadinessEvidence(new TextEncoder().encode(value.replace('"schema":"agtmai-readiness-evidence-v1"', '"schema":"agtmai-readiness-evidence-v1","schema":"other"'))), /READINESS_EVIDENCE_SCHEMA|duplicate/i);
});


test("every readiness boolean rejects string false and other malformed types at parsing and evaluation", () => {
  const paths = [["broadcastAllowed"], ["protocolQualified"], ["coverageComplete"], ["ethereum", "deployed"],
    ["ethereum", "authorityComplete"], ["solana", "deployed"], ["solana", "authorityComplete"], ["estimates", "complete"]];
  for (const path of paths) {
    for (const value of ["false", "true", 0, 1, null, {}, [], undefined]) {
      const evidence = base();
      let target = evidence as unknown as Record<string, unknown>;
      for (const key of path.slice(0, -1)) { target = target[key] as Record<string, unknown>; }
      target[path.at(-1)!] = value;
      assert.throws(() => parseReadinessEvidence(new TextEncoder().encode(JSON.stringify(evidence))), /READINESS_/, path.join("."));
      assert.throws(() => evaluateReadiness(evidence), /READINESS_/, path.join("."));
    }
  }
  const evidence = base(); evidence.ethereum.deployed = false;
  assert.equal(evaluateReadiness(parseReadinessEvidence(new TextEncoder().encode(JSON.stringify(evidence)))).status, "not-deployed");
});

test("report verification requires complete typed canonical facts and consistent qualification", () => {
  const report = evaluateReadiness(base()), digest = report.manifestSha256;
  assertReadinessBundle(report, digest);
  for (const key of Object.keys(report)) {
    const partial = { ...report } as Record<string, unknown>; delete partial[key];
    assert.throws(() => assertReadinessBundle(partial, digest), /READINESS_BUNDLE_INVALID/, key);
  }
  for (const patch of [{ status: "forged" }, { reasons: [1] }, { reasons: ["invented"] }, { authorityComplete: "true" },
    { authorityComplete: false }, { estimatesComplete: "true" }, { estimatesComplete: false }, { observedAt: 100 },
    { observedAt: "01" }, { validUntil: "99" }, { broadcastAllowed: true }, { manifestSha256: "bad" }, { extra: true },
    { reconciliation: {} }, { reconciliation: { ...report.reconciliation, backingSurplus: 0 } },
    { reconciliation: { ...report.reconciliation, backingSurplus: "1" } },
    { reconciliation: { ...report.reconciliation, adjustedGlobalSupply: null } }]) {
    assert.throws(() => assertReadinessBundle({ ...report, ...patch }, digest), /READINESS_BUNDLE_INVALID/);
  }
  assert.throws(() => assertReadinessBundle({ ...report, manifestSha256: "bad" }, "bad"), /READINESS_BUNDLE_INVALID/);
  for (const evidence of [
    { ...base(), ethereum: { ...base().ethereum, pendingEthereumToSolana: null } },
    { ...base(), ethereum: { ...base().ethereum, backing: "600" } },
    { ...base(), ethereum: { ...base().ethereum, backing: "400" } },
    { ...base(), ethereum: { ...base().ethereum, deployed: false, authorityComplete: false } },
    { ...base(), estimates: { complete: false } },
  ]) { assertReadinessBundle(evaluateReadiness(evidence), digest); }
});

test("read-only verify CLI rejects a forged partial report even without --now", async context => {
  const root = await mkdtemp(join(tmpdir(), "readiness-verify-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "report.json"), report = evaluateReadiness(base());
  const run = () => spawnSync(process.execPath, [resolve("tooling/deployment-plan/src/composition/readiness.ts"), "verify", "--bundle", bundle,
    "--manifest-sha256", report.manifestSha256], { encoding: "utf8" });
  const partial = JSON.stringify({ schema: report.schema, broadcastAllowed: false, manifestSha256: report.manifestSha256 });
  await writeFile(bundle, partial);
  const refused = run();
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stderr).reason, "READINESS_BUNDLE_INVALID");
  assert.equal(await readFile(bundle, "utf8"), partial);
  await writeFile(bundle, JSON.stringify(report));
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { status: "verified", broadcastAllowed: false });
});

test("canonical reports reject impossible supplies and contradictory status/reason combinations", () => {
  const report = evaluateReadiness(base()), digest = report.manifestSha256;
  for (const [adjustedGlobalSupply, backingSurplus, status, reasons] of [
    ["-1", "0", "exact", []], ["-1", "1", "surplus", ["surplus"]],
    ["-1", "-1", "under-backed", ["under-backed"]],
    ["1", "-2", "under-backed", ["under-backed"]],
  ] as const) {
    const inconsistent = { ...report, status: status === "under-backed" ? "inconsistent" : reasons.length ? "incomplete" : "qualified",
      reasons, reconciliation: { adjustedGlobalSupply, backingSurplus, status } };
    assert.throws(() => assertReadinessBundle(inconsistent, digest), /READINESS_BUNDLE_INVALID/);
  }
  const reports = [report,
    evaluateReadiness({ ...base(), ethereum: { ...base().ethereum, backing: "600" } }),
    evaluateReadiness({ ...base(), ethereum: { ...base().ethereum, backing: "400" } }),
    evaluateReadiness({ ...base(), ethereum: { ...base().ethereum, pendingEthereumToSolana: null } }),
    evaluateReadiness({ ...base(), ethereum: { ...base().ethereum, deployed: false } }),
  ];
  for (const valid of reports) {
    assertReadinessBundle(valid, digest);
    for (const status of ["qualified", "incomplete", "inconsistent", "not-deployed"]) {
      if (status !== valid.status) { assert.throws(() => assertReadinessBundle({ ...valid, status }, digest), /READINESS_BUNDLE_INVALID/); }
    }
    for (const reason of ["reconciliation-unknown", "surplus", "under-backed", "authority-observation-incomplete", "estimates-incomplete"]) {
      const reasons = valid.reasons.includes(reason) ? valid.reasons.filter(r => r !== reason) : [...valid.reasons, reason].toSorted();
      assert.throws(() => assertReadinessBundle({ ...valid, reasons }, digest), /READINESS_BUNDLE_INVALID/);
    }
  }
  assert.throws(() => evaluateReadiness({ ...base(), ethereum: { ...base().ethereum, backing: "1501" } }), /READINESS_ADJUSTED_SUPPLY_NEGATIVE/);
});

test("both chain observations must fall within the declared interval, including its boundaries", () => {
  for (const chain of ["ethereum", "solana"]) {
    for (const timestamp of ["0", "99", "100", "150", "200", "201"]) {
      const evidence = base();
      if (chain === "ethereum") { evidence.ethereum.block.timestamp = timestamp; } else { evidence.solana.blockTime = timestamp; }
      if (["100", "150", "200"].includes(timestamp)) { assert.equal(evaluateReadiness(evidence).status, "qualified"); }
      else {
        assert.throws(() => evaluateReadiness(evidence), /READINESS_OBSERVATION_OUTSIDE_INTERVAL/);
        assert.throws(() => parseReadinessEvidence(new TextEncoder().encode(JSON.stringify(evidence))), /READINESS_OBSERVATION_OUTSIDE_INTERVAL/);
      }
    }
  }
});

test("estimate expiry must be canonical, later than observation and no later than validUntil", () => {
  for (const complete of [true, false]) {
    for (const expiresAt of ["0", "99", "100", "201", "01", "-1", "invalid"]) {
      const evidence = { ...base(), estimates: { complete, operations: [{ id: "deploy", estimatedNative: "1", worstCaseNative: "2", expiresAt }] } };
      assert.throws(() => evaluateReadiness(evidence), /READINESS_ESTIMATE_EXPIRY_OUTSIDE_INTERVAL|expiresAt must be a canonical decimal string/);
    }
  }
  for (const expiresAt of ["101", "150", "200"]) {
    const evidence = { ...base(), estimates: { complete: true, operations: [{ id: "deploy", estimatedNative: "1", worstCaseNative: "2", expiresAt }] } };
    assert.equal(evaluateReadiness(evidence).status, "qualified");
  }
});


test("report and CLI freshness end at the earliest operation estimate expiry", async context => {
  const evidence = { ...base(), estimates: { complete: true, operations: [
    { id: "later", estimatedNative: "1", worstCaseNative: "2", expiresAt: "180" },
    { id: "earliest", estimatedNative: "1", worstCaseNative: "2", expiresAt: "101" },
  ] } };
  const report = evaluateReadiness(evidence);
  assert.equal(report.status, "qualified");
  assert.equal(report.validUntil, "101");
  assert.equal(evidence.validUntil, "200");
  assertReadinessBundle(report, report.manifestSha256);
  assertReadinessFreshness(evidence, "100");
  assertReadinessFreshness(evidence, "101");
  for (const now of ["99", "102", "150", "200"]) {
    assert.throws(() => assertReadinessFreshness(evidence, now), /READINESS_EVIDENCE_STALE/);
  }
  const root = await mkdtemp(join(tmpdir(), "readiness-expiry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "report.json"); await writeFile(bundle, JSON.stringify(report));
  for (const now of ["101", "150"]) {
    const result = spawnSync(process.execPath, [resolve("tooling/deployment-plan/src/composition/readiness.ts"), "verify", "--bundle", bundle,
      "--manifest-sha256", report.manifestSha256, "--now", now], { encoding: "utf8" });
    assert.equal(result.status, now === "101" ? 0 : 2, result.stderr);
    if (now === "150") { assert.equal(JSON.parse(result.stderr).reason, "READINESS_BUNDLE_STALE"); }
  }
  assert.equal(evaluateReadiness({ ...evidence, estimates: { ...evidence.estimates, complete: false } }).validUntil, "101");
  assert.equal(evaluateReadiness(base()).validUntil, "200");
});
