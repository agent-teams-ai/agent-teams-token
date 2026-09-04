import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertCustodyCanonicalSpelling,
  closeDirectoryCustody,
  createDirectoryCustody,
  custodyBackendChild,
  custodyBackendDirectory,
  validateCustodyComponent,
  verifyDirectoryCustody,
} from "../runtime/custody.mjs";
import { stageExactWorktreePaths } from "../slices/gate-contract.mjs";
import {
  assertRollbackWorkspaceHandle,
  closeRollbackWorkspaceHandle,
  createRollbackWorkspaceHandle,
} from "../slices/workspace-handle.mjs";

test("portable custody keeps Linux descriptor traversal and gives Darwin no /dev/fd child", () => {
  assert.equal(custodyBackendChild("linux", 17, undefined, "leaf"), "/proc/self/fd/17/leaf");
  assert.equal(custodyBackendDirectory("linux", 17), "/proc/self/fd/17/.");
  assert.equal(
    custodyBackendChild("darwin", 17, "/private/var/folders/a/b", "leaf"),
    "/private/var/folders/a/b/leaf",
  );
  assert.equal(
    custodyBackendDirectory("darwin", 17, "/private/var/folders/a/b"),
    "/private/var/folders/a/b",
  );
  assert.doesNotMatch(
    custodyBackendChild("darwin", 17, "/private/var/folders/a/b", "leaf"),
    /\/dev\/fd/u,
  );
  for (const component of ["", ".", "..", "a/b", "a\0b"]) {
    assert.throws(() => validateCustodyComponent(component), /ROLLBACK_CUSTODY_COMPONENT_UNSAFE/u);
  }
});

test("only the exact Darwin temporary alias is accepted and Linux spelling stays exact", () => {
  assert.equal(
    assertCustodyCanonicalSpelling({
      requestedPath: "/var/folders/ab/cd/T",
      canonicalPath: "/private/var/folders/ab/cd/T",
      platform: "darwin",
      allowDarwinTemporaryAlias: true,
    }),
    undefined,
  );
  assert.throws(
    () => assertCustodyCanonicalSpelling({
      requestedPath: "/var/folders/ab/cd/T",
      canonicalPath: "/private/var/folders/ab/cd/T-successor",
      platform: "darwin",
      allowDarwinTemporaryAlias: true,
    }),
    /ROLLBACK_CUSTODY_CANONICALIZATION_UNSAFE/u,
  );
  assert.throws(
    () => assertCustodyCanonicalSpelling({
      requestedPath: "/tmp",
      canonicalPath: "/private/tmp",
      platform: "darwin",
      allowDarwinTemporaryAlias: true,
    }),
    /ROLLBACK_CUSTODY_CANONICALIZATION_UNSAFE/u,
  );
  assert.throws(
    () => assertCustodyCanonicalSpelling({
      requestedPath: "/var/folders/ab/cd/T",
      canonicalPath: "/private/var/folders/ab/cd/T",
      platform: "linux",
      allowDarwinTemporaryAlias: true,
    }),
    /ROLLBACK_CUSTODY_CANONICALIZATION_UNSAFE/u,
  );
});

test("ancestor sibling churn is harmless but a held leaf substitution fails closed", () => {
  const parent = mkdtempSync(join(tmpdir(), "agtmai-custody-parent-"));
  chmodSync(parent, 0o700);
  const target = join(parent, "owned");
  const held = join(parent, "owned.held");
  const successor = join(parent, "owned.successor-sentinel");
  mkdirSync(target, { mode: 0o700 });
  const custody = createDirectoryCustody(target, { owned: true });
  try {
    const unrelated = join(tmpdir(), "agtmai-custody-unrelated-" + process.pid);
    mkdirSync(unrelated, { mode: 0o700 });
    rmSync(unrelated, { recursive: true });
    assert.doesNotThrow(() => verifyDirectoryCustody(custody));

    renameSync(target, held);
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(successor, "foreign successor survives\n");
    assert.throws(() => verifyDirectoryCustody(custody), /ROLLBACK_CUSTODY_ANCESTOR_SUBSTITUTED/u);
    assert.equal(lstatSync(held).isDirectory(), true);
    assert.equal(lstatSync(target).isDirectory(), true);
    assert.equal(existsSync(successor), true);
  } finally {
    closeDirectoryCustody(custody);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("staging hashes held bytes and rejects a regular-file to symlink replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-stage-custody-"));
  chmodSync(root, 0o700);
  const path = join(root, "entry.txt");
  const original = join(root, "entry.original.txt");
  writeFileSync(path, "trusted bytes\n");
  const recorder = {
    run(_group, id) {
      if (id.endsWith("-hash-1")) {
        renameSync(path, original);
        symlinkSync("foreign-target", path);
      }
      return { stdout: "a".repeat(40) + "\n" };
    },
  };
  try {
    assert.throws(
      () => stageExactWorktreePaths(root, ["entry.txt"], recorder, "fixture", "stage"),
      /ROLLBACK_CUSTODY_SUBSTITUTED/u,
    );
    assert.equal(readlinkSync(path), "foreign-target");
    assert.equal(lstatSync(original).isFile(), true);
  } finally {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) unlinkSync(path);
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof-slice and manifest-proof capture custody before untrusted Git and omit READY on substitution", () => {
  const proofSlice = readFileSync(join(process.cwd(), "scripts/rollback/slices/proof-slice.mjs"), "utf8");
  const manifestProof = readFileSync(join(process.cwd(), "scripts/rollback/slices/manifest-proof.mjs"), "utf8");
  const sliceCreate = proofSlice.slice(
    proofSlice.indexOf("function createSliceContext("),
    proofSlice.indexOf("function prepareSlicePreState("),
  );
  assert.ok(sliceCreate.indexOf("mkdirSync(checkout") >= 0);
  assert.ok(sliceCreate.indexOf("createRollbackWorkspaceHandle(") > sliceCreate.indexOf("mkdirSync(checkout"));
  assert.ok(proofSlice.indexOf("createRollbackWorkspaceHandle(") < proofSlice.indexOf("materializeCandidateCheckout({"));
  assert.ok(manifestProof.indexOf("createRollbackWorkspaceHandle(") < manifestProof.indexOf("run(\"git\", ["));

  for (const consumer of ["proof-slice", "manifest-proof"]) {
    const boundary = mkdtempSync(join(tmpdir(), `agtmai-${consumer}-early-custody-`));
    chmodSync(boundary, 0o700);
    const checkout = join(boundary, "checkout");
    const gate = join(boundary, "gate-tmp");
    const held = join(boundary, "checkout.held");
    const evidence = join(boundary, "evidence");
    mkdirSync(checkout, { mode: 0o700 });
    mkdirSync(gate, { mode: 0o700 });
    mkdirSync(evidence, { mode: 0o700 });
    const handle = createRollbackWorkspaceHandle(checkout, gate);
    try {
      renameSync(checkout, held);
      mkdirSync(checkout, { mode: 0o700 });
      writeFileSync(join(checkout, "foreign-successor"), "survives\n");
      assert.throws(
        () => assertRollbackWorkspaceHandle(handle, checkout),
        /ROLLBACK_REMOVAL_WORKSPACE_SUBSTITUTED/u,
      );
      assert.equal(existsSync(join(checkout, "foreign-successor")), true);
      assert.equal(lstatSync(held).isDirectory(), true);
      assert.equal(existsSync(join(evidence, "READY")), false);
    } finally {
      closeRollbackWorkspaceHandle(handle);
      rmSync(boundary, { recursive: true, force: true });
    }
  }
});

test("ancestor-chain descriptors close when custody creation fails after opening", () => {
  const parent = mkdtempSync(join(tmpdir(), "agtmai-custody-close-"));
  chmodSync(parent, 0o700);
  const target = join(parent, "not-private");
  mkdirSync(target, { mode: 0o755 });
  chmodSync(target, 0o755);
  const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  const before = readdirSync(descriptorDirectory).length;
  try {
    assert.throws(
      () => createDirectoryCustody(target, { owned: true }),
      /ROLLBACK_CUSTODY_OWNED_DIRECTORY_UNSAFE/u,
    );
    assert.equal(readdirSync(descriptorDirectory).length, before);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
