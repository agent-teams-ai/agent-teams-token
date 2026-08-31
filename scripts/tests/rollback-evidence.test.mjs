import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  canonicalJson,
  publishEvidenceSeal,
  publishReadyMarker,
} from "../rollback/proof-runtime.mjs";
import { validateEvidenceBundle } from "../rollback/validate-evidence.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const schemaPath = join(repositoryRoot, "architecture/rollback/recovery-evidence.schema.json");
const candidateSha = "1".repeat(40);
const tree = "2".repeat(40);
const baselineSha = "b7a868f85d89c4bb7a9aeed1d854a5f949306a45";
const commonGates = [
  "doctor-core", "foundation-assert-dev-only", "foundation-assert-registry", "foundation-check",
  "lint", "typecheck", "build", "package-tests", "linux-parity", "genesis-vector", "security-check",
  "local-evm-unit", "local-evm-integration", "genesis-local-verifier", "forge-format", "forge-build",
  "forge-unit-fuzz", "forge-invariants", "forge-gas-size",
];
const survivorGates = {
  "local-solana": ["solana-offline-toolchain-verify", "solana-unit-and-strict-real", "solana-real-fixture"],
  "deployment-plan": ["deployment-unit-suite", "deployment-strict-anvil"],
  slither: ["slither-unit", "slither-real-analyzer", "slither-evidence-validate"],
};
const hash = (value) => createHash("sha256").update(value).digest("hex");

function writeArtifact(bundle, path, value) {
  const target = join(bundle, path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  writeFileSync(target, bytes, { mode: 0o600 });
  return { path, byteLength: bytes.length, sha256: hash(bytes) };
}

function inventory() {
  const entries = [{
    path: "README.md",
    mode: "100644",
    gitObject: "3".repeat(40),
    byteLength: 7,
    sha256: hash("fixture"),
  }];
  return {
    schemaVersion: 1,
    tree,
    entryCount: 1,
    totalBytes: 7,
    sha256: hash(Buffer.from(JSON.stringify(entries), "utf8")),
    entries,
  };
}

function statusSnapshot() {
  return {
    schemaVersion: 1,
    format: "git-status-porcelain-v1-z",
    byteLength: 0,
    sha256: hash(Buffer.alloc(0)),
    base64: "",
  };
}

function manifest(sliceId) {
  return {
    schemaVersion: 1,
    sliceId,
    baselineSha,
    ownedRoot: `tooling/${sliceId}`,
    ownedPaths: [`tooling/${sliceId}/fixture`],
    restoreFromBaseline: [],
    sharedPaths: ["package.json"],
    reverseEdits: [],
    retainedSharedPaths: [],
    survivingGates: ["fixture"],
  };
}

function fixtureBundle() {
  const bundle = mkdtempSync(join(tmpdir(), "agtmai-recovery-evidence-test-"));
  chmodSync(bundle, 0o700);
  const candidateInventory = inventory();
  const candidateArtifact = writeArtifact(bundle, "candidate-inventory.v1.json", candidateInventory);
  const status = statusSnapshot();
  const slices = ["local-solana", "deployment-plan", "slither"];
  const manifestFacts = [];
  const sliceFacts = [];
  for (const sliceId of slices) {
    const manifestValue = manifest(sliceId);
    const manifestArtifact = writeArtifact(bundle, `slices/${sliceId}/manifest.v1.json`, manifestValue);
    manifestFacts.push({
      sliceId,
      sha256: hash(Buffer.from(JSON.stringify(manifestValue), "utf8")),
      artifact: manifestArtifact,
    });
    const preStatus = writeArtifact(bundle, `slices/${sliceId}/pre-state-status.v1.json`, status);
    const preInventory = writeArtifact(bundle, `slices/${sliceId}/pre-state-inventory.v1.json`, candidateInventory);
    const rollbackStatus = writeArtifact(bundle, `slices/${sliceId}/executed-rollback-status.v1.json`, status);
    const rollbackInventory = writeArtifact(
      bundle,
      `slices/${sliceId}/executed-rollback-inventory.v1.json`,
      candidateInventory,
    );
    const gates = [
      ...commonGates,
      ...slices.filter((value) => value !== sliceId).flatMap((survivor) => survivorGates[survivor]),
    ];
    sliceFacts.push({
      sliceId,
      manifestSha256: manifestFacts.at(-1).sha256,
      candidateSha,
      checkoutInventorySha256: candidateInventory.sha256,
      preState: {
        sha: "5".repeat(40), tree, statusSha256: status.sha256, status: preStatus,
        inventorySha256: candidateInventory.sha256, inventory: preInventory,
        entryCount: 1, totalBytes: 7,
      },
      application: {
        candidateSha, tree, pathCount: 1, pathsSha256: hash(sliceId),
      },
      rollback: {
        sha: "5".repeat(40), tree, statusSha256: status.sha256, status: rollbackStatus,
        inventorySha256: candidateInventory.sha256, inventory: rollbackInventory,
        entryCount: 1, totalBytes: 7,
      },
      assertions: {
        candidateByteEquivalent: true,
        rollbackStatusEquivalent: true,
        rollbackTreeEquivalent: true,
        rollbackInventoryEquivalent: true,
        forbiddenResidueAbsent: true,
        ownedRootShapeValid: true,
      },
      expectedGateIds: [...gates],
      executedGateIds: [...gates],
      cleanupStatus: "passed",
      status: "passed",
    });
  }
  const statement = {
    schemaVersion: 1,
    kind: "agtmai-recovery-proof-statement",
    status: "passed",
    mode: "full",
    baselineSha,
    globalManifestEvidence: "candidate-bound-local-proof-complete-hosted-ci-pending",
    candidate: {
      sha: candidateSha,
      tree,
      inventorySha256: candidateInventory.sha256,
      entryCount: 1,
      totalBytes: 7,
      inventory: candidateArtifact,
    },
    environment: {
      binaries: [
        "anvil", "cast", "chisel", "docker", "forge", "node", "pnpm", "solana",
        "solana-keygen", "solana-test-validator", "solc", "spl-token",
      ],
      runtime: {
        platform: "linux-x64",
        version: "v24.20.0",
        artifactSha256: "6".repeat(64),
        executableSha256: "7".repeat(64),
      },
      slitherImage: {
        manifestDigest: `sha256:${"8".repeat(64)}`,
        sourceRevision: "9".repeat(40),
        platform: "linux/amd64",
      },
      workspaceLinkCount: 2,
    },
    manifests: manifestFacts,
    slices: sliceFacts,
  };
  return { bundle, statement };
}

test("strict validator accepts a canonical sealed statement only after READY publication", (context) => {
  const fixture = fixtureBundle();
  context.after(() => rmSync(fixture.bundle, { recursive: true, force: true }));
  const publication = publishEvidenceSeal(fixture.bundle, fixture.statement, schemaPath);
  assert.throws(
    () => validateEvidenceBundle({ bundlePath: fixture.bundle, expectedSha: candidateSha }),
    /ENOENT/u,
  );
  const beforeReady = validateEvidenceBundle({
    bundlePath: fixture.bundle,
    expectedSha: candidateSha,
    requireReady: false,
  });
  assert.equal(beforeReady.proofDigestSha256, publication.seal.statement.canonicalSha256);
  publishReadyMarker(fixture.bundle, publication);
  assert.equal(
    validateEvidenceBundle({ bundlePath: fixture.bundle, expectedSha: candidateSha }).candidateSha,
    candidateSha,
  );
});

test("field deletion, incomplete gates and post-seal artifact mutation fail closed", (context) => {
  const deleted = fixtureBundle();
  context.after(() => rmSync(deleted.bundle, { recursive: true, force: true }));
  delete deleted.statement.slices[0].cleanupStatus;
  publishEvidenceSeal(deleted.bundle, deleted.statement, schemaPath);
  assert.throws(
    () => validateEvidenceBundle({ bundlePath: deleted.bundle, requireReady: false }),
    /RECOVERY_EVIDENCE_SCHEMA_REQUIRED/u,
  );

  const gates = fixtureBundle();
  context.after(() => rmSync(gates.bundle, { recursive: true, force: true }));
  gates.statement.slices[1].executedGateIds.pop();
  publishEvidenceSeal(gates.bundle, gates.statement, schemaPath);
  assert.throws(
    () => validateEvidenceBundle({ bundlePath: gates.bundle, requireReady: false }),
    /RECOVERY_EVIDENCE_SLICE_FACT_MISMATCH/u,
  );

  const mutuallyIncomplete = fixtureBundle();
  context.after(() => rmSync(mutuallyIncomplete.bundle, { recursive: true, force: true }));
  mutuallyIncomplete.statement.slices[2].expectedGateIds.pop();
  mutuallyIncomplete.statement.slices[2].executedGateIds.pop();
  publishEvidenceSeal(mutuallyIncomplete.bundle, mutuallyIncomplete.statement, schemaPath);
  assert.throws(
    () => validateEvidenceBundle({ bundlePath: mutuallyIncomplete.bundle, requireReady: false }),
    /RECOVERY_EVIDENCE_SLICE_FACT_MISMATCH/u,
  );

  const artifact = fixtureBundle();
  context.after(() => rmSync(artifact.bundle, { recursive: true, force: true }));
  const publication = publishEvidenceSeal(artifact.bundle, artifact.statement, schemaPath);
  publishReadyMarker(artifact.bundle, publication);
  writeFileSync(join(artifact.bundle, "candidate-inventory.v1.json"), "{}\n");
  assert.throws(
    () => validateEvidenceBundle({ bundlePath: artifact.bundle }),
    /RECOVERY_EVIDENCE_ARTIFACT_MISMATCH/u,
  );
});

test("deterministic statement and seal exclude volatile diagnostic telemetry", (context) => {
  const left = fixtureBundle();
  const right = fixtureBundle();
  context.after(() => rmSync(left.bundle, { recursive: true, force: true }));
  context.after(() => rmSync(right.bundle, { recursive: true, force: true }));
  writeFileSync(join(left.bundle, "diagnostics.json"), '{"startedAt":"2026-01-01","durationMs":1}\n');
  writeFileSync(join(right.bundle, "diagnostics.json"), '{"startedAt":"2027-01-01","durationMs":999}\n');
  assert.equal(canonicalJson(left.statement), canonicalJson(right.statement));
  const leftPublication = publishEvidenceSeal(left.bundle, left.statement, schemaPath);
  const rightPublication = publishEvidenceSeal(right.bundle, right.statement, schemaPath);
  assert.equal(leftPublication.seal.statement.canonicalSha256, rightPublication.seal.statement.canonicalSha256);
  assert.equal(readFileSync(join(left.bundle, "seal.json"), "utf8"), readFileSync(join(right.bundle, "seal.json"), "utf8"));
});
