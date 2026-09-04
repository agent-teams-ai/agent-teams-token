import * as fixtureSupport from "./cleanup-fixture.mjs";
const { assert, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, test, captureCleanupTreeSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, targetPrefix, cleanupIdentityBoundDirectory, fixture, checkout, caught, preservedQuarantine } = fixtureSupport;
export { assert, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, test, captureCleanupTreeSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, targetPrefix, cleanupIdentityBoundDirectory, fixture, checkout, caught, preservedQuarantine };

test("production cleanup is policy-bound, descriptor-anchored, bounded, and deterministic", () => {
  const external = mkdtempSync(join(tmpdir(), "agtmai-rollback-cleanup-external-"));
  const externalSentinel = join(external, "sentinel");
  writeFileSync(externalSentinel, "must-survive\n");
  const reports = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const current = fixture();
      try {
        const root = checkout(current.target);
        mkdirSync(join(root, "nested"));
        writeFileSync(join(root, "nested", "z.txt"), "z\n");
        writeFileSync(join(root, "a.txt"), "a\n");
        symlinkSync(externalSentinel, join(root, "external-link"));
        const handle = createCleanupHandle(current.target, current.policy);
        const report = cleanupIdentityBoundDirectory(handle);
        assert.equal(report.schemaVersion, 2);
        assert.equal(report.result, "contents-removed");
        assert.deepEqual(report.allowedEntries, ["checkout"]);
        assert.deepEqual(report.limits, {
          maxDepth: 128,
          maxEntries: 1_000_000,
          maxRelativeBytes: 16_384,
        });
        assert.equal(report.removedEntryCount, 5);
        assert.equal(existsSync(current.target), false);
        assert.equal(readFileSync(externalSentinel, "utf8"), "must-survive\n");
        reports.push(report.removedEntries);
      } finally {
        rmSync(current.boundary, { recursive: true, force: true });
      }
    }
    assert.deepEqual(reports[0], reports[1]);
    assert.deepEqual(reports[0], [
      { path: "checkout", kind: "directory" },
      { path: "checkout/a.txt", kind: "file" },
      { path: "checkout/external-link", kind: "symlink" },
      { path: "checkout/nested", kind: "directory" },
      { path: "checkout/nested/z.txt", kind: "file" },
    ]);
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});

test("arbitrary targets, prefixes, roots, direct paths, and depth fail closed", () => {
  const current = fixture();
  try {
    const root = checkout(current.target);
    writeFileSync(join(root, "sentinel"), "survive\n");
    assert.throws(
      () => createCleanupHandle(current.target),
      /ROLLBACK_CLEANUP_POLICY_INVALID/u,
    );
    assert.throws(
      () => createCleanupHandle(current.target, { ...current.policy, targetPrefix: "arbitrary-" }),
      /ROLLBACK_CLEANUP_PREFIX_NOT_ALLOWLISTED/u,
    );
    assert.throws(
      () => createCleanupHandle(current.target, { ...current.policy, temporaryRoot: tmpdir() }),
      /ROLLBACK_CLEANUP_TEMP_ROOT_INVALID/u,
    );
    assert.throws(
      () => createCleanupHandle(current.target, { ...current.policy, allowedEntries: ["foreign"] }),
      /ROLLBACK_CLEANUP_ALLOWLIST_INVALID/u,
    );

    mkdirSync(join(current.target, "foreign"));
    let handle = createCleanupHandle(current.target, current.policy);
    assert.throws(
      () => cleanupIdentityBoundDirectory(handle),
      /ROLLBACK_CLEANUP_PATH_NOT_ALLOWLISTED path=foreign/u,
    );
    assert.equal(readFileSync(join(root, "sentinel"), "utf8"), "survive\n");
    assert.equal(existsSync(join(current.target, "foreign")), true);
    rmSync(join(current.target, "foreign"), { recursive: true });

    let cursor = root;
    for (let depth = 0; depth < 129; depth += 1) {
      cursor = join(cursor, "d");
      mkdirSync(cursor);
    }
    handle = createCleanupHandle(current.target, current.policy);
    assert.throws(
      () => cleanupIdentityBoundDirectory(handle),
      /ROLLBACK_CLEANUP_DEPTH_LIMIT_EXCEEDED/u,
    );
    assert.equal(readFileSync(join(root, "sentinel"), "utf8"), "survive\n");
    assert.equal(existsSync(cursor), true);
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});

test("atomic child quarantine preserves a substituted top-level child", () => {
  const current = fixture();
  try {
    const root = checkout(current.target);
    writeFileSync(join(root, "owned-sentinel"), "owned-survives\n");
    const handle = createCleanupHandle(current.target, current.policy);
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-entry-quarantine" && event.path === "checkout") {
            renameSync(event.sourcePath, event.sourcePath + ".original");
            mkdirSync(event.sourcePath);
            writeFileSync(join(event.sourcePath, "foreign-sentinel"), "foreign-survives\n");
          }
        },
      }),
      /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout/u,
    );
    const quarantine = preservedQuarantine(error);
    assert.equal(
      readFileSync(join(quarantine, "tree", "checkout.original", "owned-sentinel"), "utf8"),
      "owned-survives\n",
    );
    assert.equal(
      readFileSync(join(quarantine, "tree", "checkout", "foreign-sentinel"), "utf8"),
      "foreign-survives\n",
    );
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});

test("preflight snapshot preserves a child replaced before target quarantine", () => {
  const current = fixture();
  const original = join(current.boundary, "owned-original");
  try {
    const root = checkout(current.target);
    writeFileSync(join(root, "owned"), "owned-survives\n");
    const handle = createCleanupHandle(current.target, current.policy);
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-target-quarantine") {
            const source = join(event.sourcePath, "checkout", "owned");
            renameSync(source, original);
            writeFileSync(source, "foreign-survives\n");
          }
        },
      }),
      /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout(?:\/owned)?/u,
    );
    const quarantine = preservedQuarantine(error);
    assert.equal(readFileSync(original, "utf8"), "owned-survives\n");
    assert.equal(
      readFileSync(join(quarantine, "tree", "checkout", "owned"), "utf8"),
      "foreign-survives\n",
    );
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});

test("preflight snapshot preserves a top-level addition before target quarantine", () => {
  const current = fixture();
  try {
    const root = checkout(current.target);
    writeFileSync(join(root, "owned"), "owned-survives\n");
    const handle = createCleanupHandle(current.target, current.policy);
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-target-quarantine") {
            const foreign = join(event.sourcePath, "foreign");
            mkdirSync(foreign);
            writeFileSync(join(foreign, "sentinel"), "foreign-survives\n");
          }
        },
      }),
      /ROLLBACK_CLEANUP_ENTRY_SET_MISMATCH path=\./u,
    );
    const quarantine = preservedQuarantine(error);
    assert.equal(
      readFileSync(join(quarantine, "tree", "checkout", "owned"), "utf8"),
      "owned-survives\n",
    );
    assert.equal(
      readFileSync(join(quarantine, "tree", "foreign", "sentinel"), "utf8"),
      "foreign-survives\n",
    );
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});

test("preflight snapshot preserves a later child replaced from an earlier child hook", () => {
  const current = fixture();
  try {
    const root = checkout(current.target);
    writeFileSync(join(root, "a"), "a-owned\n");
    writeFileSync(join(root, "z"), "z-owned-survives\n");
    const handle = createCleanupHandle(current.target, current.policy);
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-entry-quarantine" && event.path === "checkout/a") {
            const later = join(dirname(event.sourcePath), "z");
            renameSync(later, later + ".original");
            writeFileSync(later, "z-foreign-survives\n");
          }
        },
      }),
      /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout\/z/u,
    );
    const quarantine = preservedQuarantine(error);
    assert.equal(
      readFileSync(join(quarantine, "entries", "entry-0000001", "z.original"), "utf8"),
      "z-owned-survives\n",
    );
    assert.equal(
      readFileSync(join(quarantine, "entries", "entry-0000001", "z"), "utf8"),
      "z-foreign-survives\n",
    );
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});

test("strict cleanup fingerprints reject same-inode content mutation", () => {
  const current = fixture();
  try {
    const root = checkout(current.target);
    const victim = join(root, "owned");
    writeFileSync(victim, "owned-before\n");
    const handle = createCleanupHandle(current.target, current.policy);
    let inode;
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-target-quarantine") {
            const before = lstatSync(victim, { bigint: true });
            writeFileSync(victim, "foreign-now!\n");
            const after = lstatSync(victim, { bigint: true });
            inode = { before: String(before.ino), after: String(after.ino) };
          }
        },
      }),
      /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout\/owned/u,
    );
    assert.deepEqual(inode, { before: inode.before, after: inode.before });
    const quarantine = preservedQuarantine(error);
    assert.equal(
      readFileSync(join(quarantine, "tree", "checkout", "owned"), "utf8"),
      "foreign-now!\n",
    );
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});

test("strict cleanup fingerprints preserve an unlink-recreated substitute without assuming inode reuse", () => {
  const current = fixture();
  try {
    const root = checkout(current.target);
    const victim = join(root, "owned");
    writeFileSync(victim, "owned-before\n");
    const handle = createCleanupHandle(current.target, current.policy);
    let sizes;
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-target-quarantine") {
            const before = lstatSync(victim, { bigint: true });
            unlinkSync(victim);
            writeFileSync(victim, "foreign-unlink-recreated\n");
            const after = lstatSync(victim, { bigint: true });
            sizes = { before: String(before.size), after: String(after.size) };
          }
        },
      }),
      /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout(?:\/owned)?/u,
    );
    assert.notEqual(sizes.after, sizes.before, "fixture must deterministically change the strict size fingerprint");
    const quarantine = preservedQuarantine(error);
    assert.equal(
      readFileSync(join(quarantine, "tree", "checkout", "owned"), "utf8"),
      "foreign-unlink-recreated\n",
    );
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});

test("target quarantine refuses an injected destination without overwriting it", () => {
  const current = fixture();
  try {
    const root = checkout(current.target);
    writeFileSync(join(root, "owned"), "owned-survives\n");
    const handle = createCleanupHandle(current.target, current.policy);
    const error = caught(
      () => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event) {
          if (event.stage === "before-target-quarantine") {
            mkdirSync(event.quarantinedPath);
            writeFileSync(join(event.quarantinedPath, "foreign"), "foreign-survives\n");
          }
        },
      }),
      /ROLLBACK_CLEANUP_TARGET_DESTINATION_SUBSTITUTED/u,
    );
    const quarantine = preservedQuarantine(error);
    assert.equal(readFileSync(join(root, "owned"), "utf8"), "owned-survives\n");
    assert.equal(
      readFileSync(join(quarantine, "tree", "foreign"), "utf8"),
      "foreign-survives\n",
    );
  } finally {
    rmSync(current.boundary, { recursive: true, force: true });
  }
});
