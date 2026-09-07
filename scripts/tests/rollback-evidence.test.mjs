import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  canonicalJson,
  EvidenceRecorder,
  runEvidenceLifecycle,
  publishEvidenceSeal,
  publishReadyMarker,
} from "../rollback/proof-runtime.mjs";
import { validateEvidenceBundle } from "../rollback/validate-evidence.mjs";

import { setDescriptorCloseImplementationForTest } from "../rollback/runtime/descriptor-close.mjs";
import { createDirectoryCustody } from "../rollback/runtime/custody.mjs";
import { assertOtherDescriptorsClosed, injectedUncertainClose } from "./rollback-descriptor-close-fixture.mjs";

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

function fixtureBundle(parent = tmpdir()) {
  const bundle = mkdtempSync(join(parent, "agtmai-recovery-evidence-test-"));
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

function standaloneValidation(bundle) {
  return spawnSync(process.execPath, [
    join(repositoryRoot, "scripts/rollback/validate-evidence.mjs"),
    "--bundle=" + bundle,
    "--expected-sha=" + candidateSha,
  ], { encoding: "utf8" });
}

for (const fault of ["constructor", "action", "action-finalize-close", "message-getter", "message-setter"]) {
  test(`exception annotation cannot bypass lifecycle teardown: ${fault}`, (context) => {
    const fixture = fixtureBundle();
    context.after(() => rmSync(fixture.bundle, { recursive: true, force: true }));
    const custody = createDirectoryCustody(fixture.bundle, { owned: true });
    const target = { custody, path: fixture.bundle };
    const descriptors = [custody.descriptor, ...custody.ancestorChain.map((entry) => entry.descriptor)];
    const primary = new Error("primary frozen failure");
    const annotation = new Error("annotation accessor failure");
    if (fault.startsWith("message-")) {
      Object.defineProperty(primary, "message", {
        get() {
          if (fault === "message-getter") {throw annotation;}
          return "primary";
        },
        set() {throw annotation;},
      });
    }
    Object.freeze(primary);
    const secondary = new Error("diagnostics failure");
    const finalized = [];
    const calls = [];
    let injection;
    let caught;
    const restore = setDescriptorCloseImplementationForTest((descriptor) => {
      calls.push(descriptor);
      closeSync(descriptor);
    });
    try {
      runEvidenceLifecycle(target, () => {
        if (fault === "constructor") {throw primary;}
        return { finalize(status, error) {
          finalized.push([status, error]);
          if (fault === "action-finalize-close") {throw secondary;}
        } };
      }, () => {
        publishReadyMarker(target, publishEvidenceSeal(target, fixture.statement, schemaPath));
        validateEvidenceBundle({ bundlePath: fixture.bundle, allowPendingReady: true });
        if (fault === "action-finalize-close") {injection = injectedUncertainClose(0);}
        throw primary;
      });
    } catch (error) {
      caught = error;
    } finally {
      injection?.restore();
      restore();
      // A red run leaks real descriptors: release only those still owned/open.
      context.after(() => {
        for (const descriptor of descriptors) {
          if (!(injection?.calls ?? calls).includes(descriptor)) {closeSync(descriptor);}
        }
        if (injection?.reusedDescriptor() !== undefined) {closeSync(injection.reusedDescriptor());}
      });
    }
    const closed = injection?.calls ?? calls;
    context.diagnostic(`close attempts=${closed.length}/${descriptors.length}; finalized=${finalized.length}`);
    assert.deepEqual(new Set(closed), new Set(descriptors));
    assert.equal(closed.length, descriptors.length);
    assertOtherDescriptorsClosed(descriptors, injection?.reusedDescriptor());
    if (injection !== undefined) {assert.doesNotThrow(() => fstatSync(injection.reusedDescriptor()));}
    assert.deepEqual(finalized, fault === "constructor" ? [] : [["failed", primary]]);
    let annotated = caught;
    if (fault === "action-finalize-close") {
      assert.equal(caught.message, "ROLLBACK_EVIDENCE_CUSTODY_CLOSE_FAILED");
      assert.equal(caught.errors[1].errors[0].code, "EINTR");
      assert.equal(caught.errors[0].errors[1], secondary);
      assert.equal(caught.cause, caught.errors[0]);
      annotated = caught.errors[0].errors[0];
      assert.equal(caught.errors[0].cause, annotated);
    }
    assert.equal(annotated.cause, primary);
    assert.equal(annotated.errors[0], primary);
    if (fault.startsWith("message-")) {assert.equal(annotated.errors[1], annotation);}
    else {assert.ok(annotated.errors[1] instanceof TypeError);}
    assert.equal(lstatSync(join(fixture.bundle, "READY"), { throwIfNoEntry: false }), undefined);
    assert.equal(standaloneValidation(fixture.bundle).status, 1);
    const next = { path: fixture.bundle, custody: createDirectoryCustody(fixture.bundle, { owned: true }) };
    assert.equal(runEvidenceLifecycle(next, () => ({}), () => "subsequent lifecycle"), "subsequent lifecycle");
    assert.equal(lstatSync(join(fixture.bundle, "READY"), { throwIfNoEntry: false }), undefined);
  });
}

for (const fault of ["none", "close", "last-close", "late-validation", "late-validation-and-close", "late-validation-finalize-and-close"]) {
  test(`sealed production lifecycle terminal settlement: ${fault}`, (context) => {
    const fixture = fixtureBundle();
    context.after(() => rmSync(fixture.bundle, { recursive: true, force: true }));
    const custody = createDirectoryCustody(fixture.bundle, { owned: true });
    const target = { custody, path: fixture.bundle };
    let primary;
    const cleanup = new Error("injected diagnostics finalization failure");
    let injection;
    let failure;
    try {
      runEvidenceLifecycle(target, () => new EvidenceRecorder(target, {}), (recorder) => {
        recorder.finalize("passed");
        const publication = publishEvidenceSeal(target, fixture.statement, schemaPath);
        validateEvidenceBundle({ bundlePath: fixture.bundle, expectedSha: candidateSha, requireReady: false });
        publishReadyMarker(target, publication);
        // Real seal/artifacts and production validator; only gate facts are synthetic.
        validateEvidenceBundle({ bundlePath: fixture.bundle, expectedSha: candidateSha, allowPendingReady: true });
        if (fault.includes("close")) {
          injection = injectedUncertainClose(fault === "last-close" ? custody.ancestorChain.length : 0);
        }
        if (fault.includes("finalize")) {
          const finalize = recorder.finalize.bind(recorder);
          recorder.finalize = (status, error) => {
            finalize(status, error);
            throw cleanup;
          };
        }
        if (fault.startsWith("late-validation")) {
          try {
            // A real late validator rejection, without damaging the sealed
            // bytes: the independent default validator would still accept them.
            validateEvidenceBundle({
              bundlePath: fixture.bundle, expectedSha: "f".repeat(40), allowPendingReady: true,
            });
          } catch (error) {
            primary = error;
            throw error;
          }
          assert.fail("late validator accepted the wrong candidate");
        }
      });
    } catch (error) {
      failure = error;
    } finally {
      injection?.restore();
    }
    if (injection !== undefined) {
      const reused = injection.reusedDescriptor();
      try {
        assert.equal(injection.calls.length, custody.ancestorChain.length + 1);
        assert.equal(new Set(injection.calls).size, injection.calls.length);
        assertOtherDescriptorsClosed(injection.calls, reused);
        assert.doesNotThrow(() => fstatSync(reused));
      } finally {
        closeSync(reused);
      }
    }
    if (fault === "none") {
      assert.equal(failure, undefined);
    } else if (fault === "late-validation") {
      assert.equal(failure, primary);
    } else if (fault === "close" || fault === "last-close") {
      assert.equal(failure.message, "ROLLBACK_CUSTODY_CLOSE_FAILED");
      assert.equal(failure.errors[0].code, "EINTR");
    } else if (fault.includes("finalize")) {
      assert.equal(failure.errors[0].cause, primary);
      assert.deepEqual(failure.errors[0].errors, [primary, cleanup]);
      assert.equal(failure.errors[1].errors[0].code, "EINTR");
    } else {
      assert.equal(failure.cause, primary);
      assert.equal(failure.errors[1].errors[0].code, "EINTR");
    }
    if (fault.startsWith("late-validation")) {
      assert.match(primary.message, /RECOVERY_EVIDENCE_CANDIDATE_MISMATCH/u);
    }
    const validated = standaloneValidation(fixture.bundle);
    context.diagnostic(`producer=${fault === "none" ? "success" : "failed"} standalone=${validated.status}`);
    assert.equal(validated.status, fault === "none" ? 0 : 1, validated.stdout + validated.stderr);
    if (fault !== "none") {
      assert.match(validated.stderr, /ENOENT.*READY/u);
    }
  });
}

for (const substitution of ["root", "ancestor", "pending", "pending-bytes", "ready", "ready-symlink"]) {
  test(`terminal publication preserves foreign ${substitution} after custody closes`, (context) => {
    const root = mkdtempSync(join(tmpdir(), "agtmai-terminal-successor-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const parent = join(root, "parent");
    mkdirSync(parent, { mode: 0o700 });
    const fixture = fixtureBundle(parent);
    const custody = createDirectoryCustody(fixture.bundle, { owned: true });
    const target = { custody, path: fixture.bundle };
    let restore;
    let foreignPath;
    let foreignIdentity;
    let heldBundle = fixture.bundle;
    let closed = 0;
    try {
      assert.throws(() => runEvidenceLifecycle(target, () => new EvidenceRecorder(target, {}), (recorder) => {
        recorder.finalize("passed");
        const publication = publishEvidenceSeal(target, fixture.statement, schemaPath);
        publishReadyMarker(target, publication);
        validateEvidenceBundle({ bundlePath: fixture.bundle, allowPendingReady: true });
        restore = setDescriptorCloseImplementationForTest((descriptor) => {
          closeSync(descriptor);
          closed += 1;
          if (closed !== custody.ancestorChain.length + 1) {return;}
          if (substitution === "root" || substitution === "ancestor") {
            const moved = substitution === "root" ? fixture.bundle : parent;
            renameSync(moved, moved + ".held");
            mkdirSync(moved, { mode: 0o700 });
            heldBundle = substitution === "root" ? moved + ".held"
              : fixture.bundle.replace(parent, parent + ".held");
            foreignPath = join(moved, "sentinel");
          } else {
            foreignPath = join(fixture.bundle, substitution.startsWith("pending") ? "READY.pending" : "READY");
            if (substitution === "pending") {
              renameSync(foreignPath, foreignPath + ".held");
            }
          }
          if (substitution === "pending-bytes") {
            chmodSync(foreignPath, 0o600);
          }
          if (substitution === "ready-symlink") {
            symlinkSync("missing-foreign-target", foreignPath);
          } else {
            writeFileSync(foreignPath, "preserve successor", { flag: substitution === "pending-bytes" ? "w" : "wx", mode: 0o400 });
          }
          foreignIdentity = lstatSync(foreignPath, { bigint: true });
        });
      }), /ROLLBACK_EVIDENCE_SETTLEMENT_SUBSTITUTED/u);
    } finally {
      restore?.();
    }
    assert.equal(closed, custody.ancestorChain.length + 1);
    assert.deepEqual(lstatSync(foreignPath, { bigint: true }), foreignIdentity);
    if (substitution !== "ready-symlink") {
      assert.equal(readFileSync(foreignPath, "utf8"), "preserve successor");
    }
    assert.equal(standaloneValidation(heldBundle).status, 1);
  });
}

test("staged READY validation is explicitly provisional until terminal publication", (context) => {
  const fixture = fixtureBundle();
  context.after(() => rmSync(fixture.bundle, { recursive: true, force: true }));
  const target = { custody: createDirectoryCustody(fixture.bundle, { owned: true }), path: fixture.bundle };
  runEvidenceLifecycle(target, () => new EvidenceRecorder(target, {}), (recorder) => {
    recorder.finalize("passed");
    publishReadyMarker(target, publishEvidenceSeal(target, fixture.statement, schemaPath));
    assert.equal(standaloneValidation(fixture.bundle).status, 1);
    const provisional = spawnSync(process.execPath, [
      join(repositoryRoot, "scripts/rollback/validate-evidence.mjs"),
      "--bundle=" + fixture.bundle, "--allow-pending-ready",
    ], { encoding: "utf8" });
    assert.equal(provisional.status, 0, provisional.stderr);
    assert.match(provisional.stdout, /^RECOVERY_EVIDENCE_PROVISIONAL /u);
  });
  assert.equal(lstatSync(join(fixture.bundle, "READY.pending"), { throwIfNoEntry: false }), undefined);
  assert.equal(standaloneValidation(fixture.bundle).status, 0);
});
