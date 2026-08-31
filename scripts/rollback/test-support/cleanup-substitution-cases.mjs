import * as fixtureSupport from "./cleanup-fixture.mjs";
const { assert, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, test, captureCleanupTreeSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, targetPrefix, cleanupIdentityBoundDirectory, fixture, checkout, caught, preservedQuarantine } = fixtureSupport;
export { assert, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, test, captureCleanupTreeSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, targetPrefix, cleanupIdentityBoundDirectory, fixture, checkout, caught, preservedQuarantine };

test("entry quarantine refuses an injected destination without overwriting it", () => {
  const current = fixture();
  try {
    const root = checkout(current.target);
    writeFileSync(join(root, "owned"), "owned-survives\n");
    const handle = createCleanupHandle(current.target, current.policy);
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-entry-quarantine" && event.path === "checkout/owned") {
            writeFileSync(event.stagedPath, "foreign-survives\n");
          }
        },
      }),
      /ROLLBACK_CLEANUP_ENTRY_DESTINATION_SUBSTITUTED path=checkout\/owned/u,
    );
    const quarantine = preservedQuarantine(error);
    assert.equal(
      readFileSync(join(quarantine, "entries", "entry-0000001", "owned"), "utf8"),
      "owned-survives\n",
    );
    assert.equal(
      readFileSync(join(quarantine, "entries", "entry-0000002"), "utf8"),
      "foreign-survives\n",
    );
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});

test("atomic nested-file quarantine preserves both original and substitute", () => {
  const current = fixture();
  try {
    const root = checkout(current.target);
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "owned"), "owned-survives\n");
    const handle = createCleanupHandle(current.target, current.policy);
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-entry-quarantine" && event.path === "checkout/nested/owned") {
            renameSync(event.sourcePath, event.sourcePath + ".original");
            writeFileSync(event.sourcePath, "foreign-survives\n");
          }
        },
      }),
      /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout\/nested\/owned/u,
    );
    const quarantine = preservedQuarantine(error);
    assert.equal(
      readFileSync(join(quarantine, "entries", "entry-0000002", "owned.original"), "utf8"),
      "owned-survives\n",
    );
    assert.equal(
      readFileSync(join(quarantine, "entries", "entry-0000002", "owned"), "utf8"),
      "foreign-survives\n",
    );
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});

test("final file unlink revalidates identity and preserves both file identities", () => {
  const current = fixture();
  try {
    const root = checkout(current.target);
    writeFileSync(join(root, "owned"), "owned-survives\n");
    const handle = createCleanupHandle(current.target, current.policy);
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-entry-delete" && event.path === "checkout/owned") {
            renameSync(event.stagedPath, event.stagedPath + ".original");
            writeFileSync(event.stagedPath, "foreign-survives\n");
          }
        },
      }),
      /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout\/owned/u,
    );
    const quarantine = preservedQuarantine(error);
    assert.equal(
      readFileSync(join(quarantine, "entries", "entry-0000002.original"), "utf8"),
      "owned-survives\n",
    );
    assert.equal(
      readFileSync(join(quarantine, "entries", "entry-0000002"), "utf8"),
      "foreign-survives\n",
    );
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});

test("symlinks are never followed and final unlink preserves a substituted symlink", () => {
  const current = fixture();
  const external = mkdtempSync(join(tmpdir(), "agtmai-rollback-cleanup-links-"));
  const originalTarget = join(external, "original-target");
  const foreignTarget = join(external, "foreign-target");
  writeFileSync(originalTarget, "original-target-survives\n");
  writeFileSync(foreignTarget, "foreign-target-survives\n");
  try {
    const root = checkout(current.target);
    symlinkSync(originalTarget, join(root, "link"));
    const handle = createCleanupHandle(current.target, current.policy);
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-entry-delete" && event.path === "checkout/link") {
            renameSync(event.stagedPath, event.stagedPath + ".original");
            symlinkSync(foreignTarget, event.stagedPath);
          }
        },
      }),
      /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout\/link/u,
    );
    const quarantine = preservedQuarantine(error);
    assert.equal(
      readlinkSync(join(quarantine, "entries", "entry-0000002.original")),
      originalTarget,
    );
    assert.equal(
      readlinkSync(join(quarantine, "entries", "entry-0000002")),
      foreignTarget,
    );
    assert.equal(readFileSync(originalTarget, "utf8"), "original-target-survives\n");
    assert.equal(readFileSync(foreignTarget, "utf8"), "foreign-target-survives\n");
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("strict raw-target fingerprint preserves a same-path symlink substitute", () => {
  const current = fixture();
  const external = mkdtempSync(join(tmpdir(), "agtmai-rollback-cleanup-link-reuse-"));
  const originalTarget = join(external, "original-target");
  const foreignTarget = join(external, "foreign-target");
  writeFileSync(originalTarget, "original-target-survives\n");
  writeFileSync(foreignTarget, "foreign-target-survives\n");
  try {
    const root = checkout(current.target);
    symlinkSync(originalTarget, join(root, "link"));
    const handle = createCleanupHandle(current.target, current.policy);
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-entry-delete" && event.path === "checkout/link") {
            unlinkSync(event.stagedPath);
            symlinkSync(foreignTarget, event.stagedPath);
            assert.equal(readlinkSync(event.stagedPath), foreignTarget);
          }
        },
      }),
      /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout\/link/u,
    );
    const quarantine = preservedQuarantine(error);
    assert.equal(readlinkSync(join(quarantine, "entries", "entry-0000002")), foreignTarget);
    assert.equal(readFileSync(originalTarget, "utf8"), "original-target-survives\n");
    assert.equal(readFileSync(foreignTarget, "utf8"), "foreign-target-survives\n");
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("atomic final-directory quarantine preserves a last-moment substitute", () => {
  const current = fixture();
  try {
    const root = checkout(current.target);
    writeFileSync(join(root, "owned-sentinel"), "owned-survives\n");
    const movedName = basename(current.target) + ".original";
    const handle = createCleanupHandle(current.target, current.policy);
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-target-quarantine") {
            renameSync(event.sourcePath, event.sourcePath + ".original");
            mkdirSync(event.sourcePath, { mode: 0o700 });
            const substituteCheckout = join(event.sourcePath, "checkout");
            mkdirSync(substituteCheckout);
            writeFileSync(join(substituteCheckout, "foreign-sentinel"), "foreign-survives\n");
          }
        },
      }),
      /ROLLBACK_CLEANUP_TARGET_SUBSTITUTED_AT_QUARANTINE/u,
    );
    preservedQuarantine(error);
    assert.equal(
      readFileSync(join(current.boundary, movedName, "checkout", "owned-sentinel"), "utf8"),
      "owned-survives\n",
    );
    assert.equal(
      readFileSync(join(current.target, "checkout", "foreign-sentinel"), "utf8"),
      "foreign-survives\n",
    );
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});

test("final rmdir boundary revalidates identity and preserves a replacement directory", () => {
  const current = fixture();
  try {
    const root = checkout(current.target);
    writeFileSync(join(root, "owned"), "generated\n");
    const handle = createCleanupHandle(current.target, current.policy);
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-target-delete") {
            renameSync(event.quarantinedPath, event.quarantinedPath + ".original");
            mkdirSync(event.quarantinedPath);
            writeFileSync(join(event.quarantinedPath, "foreign-sentinel"), "foreign-survives\n");
          }
        },
      }),
      /ROLLBACK_CLEANUP_TARGET_SUBSTITUTED_AT_DELETE/u,
    );
    const quarantine = preservedQuarantine(error);
    assert.equal(existsSync(join(quarantine, "tree.original")), true);
    assert.equal(
      readFileSync(join(quarantine, "tree", "foreign-sentinel"), "utf8"),
      "foreign-survives\n",
    );
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});
