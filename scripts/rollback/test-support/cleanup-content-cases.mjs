import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs, { closeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  assert,
  checkout,
  cleanupIdentityBoundDirectory,
  caught,
  createCleanupHandle,
  existsSync,
  fixture,
  join,
  lstatSync,
  preservedQuarantine,
  readFileSync,
  rmSync,
  test,
  writeFileSync,
} from "./cleanup-fixture.mjs";
import {
  assertCleanupStrictFingerprint,
  cleanupStrictIdentityFingerprint,
} from "../runtime/cleanup-tree.mjs";
import { setDescriptorCloseImplementationForTest } from "../runtime/descriptor-close.mjs";

// Model a filesystem clock tick containing both writes, or stale size metadata
// for the EOF cases. Inode, path operations and file bytes remain real IO.
function holdMutationTimestamps(victim, fields = ["ctimeNs", "mtimeNs"]) {
  const identity = fs.lstatSync(victim, { bigint: true });
  const native = { lstatSync: fs.lstatSync, fstatSync: fs.fstatSync };
  for (const key of Object.keys(native)) {
    fs[key] = (...arguments_) => {
      const actual = native[key](...arguments_);
      if (actual.dev === identity.dev && actual.ino === identity.ino) {
        for (const field of fields) { actual[field] = identity[field]; }
      }
      return actual;
    };
  }
  syncBuiltinESMExports();
  return () => {
    Object.assign(fs, native);
    syncBuiltinESMExports();
  };
}

export function registerCleanupContentCases() {
  registerFingerprintCases();
  registerMutationCases();
  registerBoundedReadCases();
  registerReadFailureCases();
}

function registerFingerprintCases() {
  test("regular-file content remains bound when every strict metadata field matches", () => {
    const current = fixture();
    try {
      const root = checkout(current.target);
      const victim = join(root, "owned");
      writeFileSync(victim, Buffer.alloc(128 * 1024 + 17, 0x41));
      const owned = cleanupStrictIdentityFingerprint(lstatSync(victim, { bigint: true }), "file", victim);
      writeFileSync(victim, Buffer.alloc(128 * 1024 + 17, 0x42));
      const foreign = lstatSync(victim, { bigint: true });
      assert.equal(readFileSync(victim)[0], 0x42);
      assert.equal(owned.size, String(foreign.size));
      assert.equal(owned.ino, String(foreign.ino));
      const sameMetadata = Object.freeze({
        ...Object.fromEntries(Object.keys(owned).filter((field) => field !== "fileContentSha256")
          .map((field) => [field, field === "kind" || field === "linkTargetBase64"
            ? owned[field] : String(foreign[field])])),
        fileContentSha256: owned.fileContentSha256,
      });
      const observed = cleanupStrictIdentityFingerprint(foreign, "file", victim);
      for (const field of Object.keys(sameMetadata)) {
        if (field !== "fileContentSha256") {
          assert.equal(sameMetadata[field], observed[field], field);
        }
      }
      assert.throws(
        () => assertCleanupStrictFingerprint(sameMetadata, victim, "checkout/owned"),
        /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout\/owned/u,
      );
      assert.notEqual(sameMetadata.fileContentSha256, observed.fileContentSha256);
      assert.equal(
        owned.fileContentSha256,
        createHash("sha256").update(Buffer.alloc(128 * 1024 + 17, 0x41)).digest("hex"),
      );
      assert.equal(
        observed.fileContentSha256,
        createHash("sha256").update(readFileSync(victim)).digest("hex"),
      );
    } finally {
      rmSync(current.boundary, { recursive: true, force: true });
    }
  });

  test("regular-file fingerprint fails closed when its descriptor close reports failure", () => {
    const current = fixture();
    try {
      const victim = join(checkout(current.target), "owned");
      writeFileSync(victim, "owned\n");
      const identity = lstatSync(victim, { bigint: true });
      const restore = setDescriptorCloseImplementationForTest((descriptor) => {
        closeSync(descriptor);
        throw new Error("injected close failure");
      });
      try {
        assert.throws(
          () => cleanupStrictIdentityFingerprint(identity, "file", victim),
          /ROLLBACK_CLEANUP_FILE_CLOSE_FAILED/u,
        );
      } finally {
        restore();
      }
      assert.equal(readFileSync(victim, "utf8"), "owned\n");
    } finally {
      rmSync(current.boundary, { recursive: true, force: true });
    }
  });

}

function registerMutationCases() {
  for (const [stage, size] of [
    ["before-target-quarantine", 13], ["before-entry-quarantine", 13],
    ["before-entry-delete", 13], ["before-entry-delete", 3 * 64 * 1024 + 17],
  ]) {
    test(`strict cleanup preserves ${size} same-size bytes with identical metadata at ${stage}`, () => {
      const current = fixture();
      let restore;
      try {
        const victim = join(checkout(current.target), "owned");
        const original = size === 13 ? Buffer.from("owned-before\n") : Buffer.alloc(size, 0x61);
        const replacement = Buffer.from(original);
        assert.equal(original.length, size);
        if (size === 13) { replacement.set(Buffer.from("foreign-now!\n")); }
        else { replacement[64 * 1024 + 5] = 0x62; } // Interior byte beyond the first chunk.
        assert.equal(replacement.length, size);
        writeFileSync(victim, original);
        restore = holdMutationTimestamps(victim);
        const handle = createCleanupHandle(current.target, current.policy);
        let mutatedPath;
        const error = caught(() => cleanupIdentityBoundDirectory(handle, {
          onBoundary(event) {
            if (event.stage !== stage || stage !== "before-target-quarantine"
              && event.path !== "checkout/owned") { return; }
            mutatedPath = stage === "before-target-quarantine" ? victim
              : stage === "before-entry-delete" ? event.stagedPath : event.sourcePath;
            const before = fs.lstatSync(mutatedPath, { bigint: true });
            writeFileSync(mutatedPath, replacement);
            const after = fs.lstatSync(mutatedPath, { bigint: true });
            for (const field of ["dev", "ino", "size", "birthtimeNs", "ctimeNs", "mtimeNs", "mode", "nlink", "uid", "gid"]) {
              assert.equal(after[field], before[field], field);
            }
          },
        }), /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout\/owned/u);
        const quarantine = preservedQuarantine(error);
        const survivor = stage === "before-target-quarantine"
          ? join(quarantine, "tree", "checkout", "owned")
          : stage === "before-entry-quarantine"
            ? join(quarantine, "entries", "entry-0000001", "owned")
            : join(quarantine, "entries", "entry-0000002");
        assert.deepEqual(readFileSync(survivor), replacement);
        assert.equal(handle.closed, true);
      } finally {
        restore?.();
        rmSync(current.boundary, { recursive: true, force: true });
      }
    });
  }

  test("entry quarantine never rebaselines content changed during rename", () => {
    const current = fixture();
    const nativeRename = fs.renameSync;
    let restore;
    try {
      const victim = join(checkout(current.target), "owned");
      writeFileSync(victim, "owned-before\n");
      restore = holdMutationTimestamps(victim);
      let source;
      let reachedDelete = false;
      fs.renameSync = (from, to) => {
        nativeRename(from, to);
        if (from === source) { writeFileSync(to, "foreign-now!\n"); }
      };
      syncBuiltinESMExports();
      const error = caught(() => cleanupIdentityBoundDirectory(createCleanupHandle(current.target, current.policy), {
        onBoundary(event) {
          if (event.path !== "checkout/owned") { return; }
          if (event.stage === "before-entry-quarantine") { source = event.sourcePath; }
          if (event.stage === "before-entry-delete") { reachedDelete = true; }
        },
      }), /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout\/owned/u);
      assert.equal(reachedDelete, false);
      assert.equal(readFileSync(join(preservedQuarantine(error), "entries", "entry-0000002"), "utf8"), "foreign-now!\n");
    } finally {
      fs.renameSync = nativeRename;
      restore?.();
      syncBuiltinESMExports();
      rmSync(current.boundary, { recursive: true, force: true });
    }
  });

  test("content fingerprints cover empty and multi-chunk files and permit unchanged cleanup", () => {
    const current = fixture();
    try {
      const root = checkout(current.target);
      for (const bytes of [Buffer.alloc(0), Buffer.alloc(3 * 64 * 1024 + 17, 0x61)]) {
        const victim = join(root, "owned");
        writeFileSync(victim, bytes);
        const fingerprint = cleanupStrictIdentityFingerprint(lstatSync(victim, { bigint: true }), "file", victim);
        assert.equal(fingerprint.fileContentSha256, createHash("sha256").update(bytes).digest("hex"));
      }
      writeFileSync(join(root, "empty"), "");
      cleanupIdentityBoundDirectory(createCleanupHandle(current.target, current.policy));
      assert.equal(existsSync(current.target), false);
    } finally {
      rmSync(current.boundary, { recursive: true, force: true });
    }
  });

}

function registerBoundedReadCases() {
  for (const scenario of ["growth", "truncation", "read-failure"]) {
    test(`content verification is bounded and closes its descriptor on ${scenario}`, () => {
      const current = fixture();
      const nativeRead = fs.readSync;
      let descriptor;
      let reads = 0;
      try {
        const victim = join(checkout(current.target), "owned");
        writeFileSync(victim, Buffer.alloc(2 * 64 * 1024, 0x61));
        const identity = lstatSync(victim, { bigint: true });
        const injected = new Error("injected read failure");
        fs.readSync = (held, buffer, offset, length, position) => {
          descriptor = held;
          reads += 1;
          assert.ok(length <= 64 * 1024);
          if (scenario === "read-failure") { throw injected; }
          const count = nativeRead(held, buffer, offset, length, position);
          if (scenario === "growth") { fs.appendFileSync(victim, "growth"); }
          else if (reads === 1) { fs.truncateSync(victim, 0); }
          return count;
        };
        syncBuiltinESMExports();
        assert.throws(() => cleanupStrictIdentityFingerprint(identity, "file", victim),
          scenario === "read-failure" ? (error) => error.message === "ROLLBACK_CLEANUP_FILE_READ_FAILED"
            && error.cause === injected : /ROLLBACK_CLEANUP_FILE_CHANGED/u);
        assert.ok(reads <= 3, "verification must not chase a growing EOF");
        assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
      } finally {
        fs.readSync = nativeRead;
        syncBuiltinESMExports();
        rmSync(current.boundary, { recursive: true, force: true });
      }
    });
  }

  for (const size of [0, 2 * 64 * 1024 + 17]) {
    test(`content verification rejects growth beyond ${size} captured bytes with stale metadata`, () => {
      const current = fixture();
      const nativeRead = fs.readSync;
      let restore;
      let descriptor;
      let reads = 0;
      try {
        const victim = join(checkout(current.target), "owned");
        writeFileSync(victim, Buffer.alloc(size, 0x61));
        const identity = lstatSync(victim, { bigint: true });
        restore = holdMutationTimestamps(victim, ["ctimeNs", "mtimeNs", "size"]);
        fs.appendFileSync(victim, "foreign-growth");
        fs.readSync = (held, ...arguments_) => {
          descriptor = held;
          reads += 1;
          return nativeRead(held, ...arguments_);
        };
        syncBuiltinESMExports();
        // Before the EOF probe, both bounded passes accepted the unchanged
        // prefix and authorized a file containing these extra foreign bytes.
        assert.throws(() => cleanupStrictIdentityFingerprint(identity, "file", victim),
          /ROLLBACK_CLEANUP_FILE_CHANGED/u);
        assert.ok(reads <= Math.ceil(size / (64 * 1024)) + 1);
        assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
        assert.equal(readFileSync(victim).length, size + Buffer.byteLength("foreign-growth"));
      } finally {
        fs.readSync = nativeRead;
        restore?.();
        syncBuiltinESMExports();
        rmSync(current.boundary, { recursive: true, force: true });
      }
    });
  }

  test("file content open rejects a FIFO substitute without waiting for a writer", {
    skip: process.platform !== "linux",
  }, () => {
    const current = fixture();
    try {
      const victim = join(checkout(current.target), "owned");
      writeFileSync(victim, "owned\n");
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { execFileSync } from "node:child_process";
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const { cleanupStrictIdentityFingerprint } = await import(process.argv[2]);
        const victim = process.argv[1];
        const identity = fs.lstatSync(victim, { bigint: true });
        const nativeOpen = fs.openSync;
        let descriptor;
        fs.openSync = (path, ...arguments_) => {
          if (path === victim) {
            fs.renameSync(victim, victim + ".original");
            execFileSync("/usr/bin/mkfifo", [victim]);
            // A blocking open here hangs indefinitely with no FIFO writer.
            descriptor = nativeOpen(path, ...arguments_);
            return descriptor;
          }
          return nativeOpen(path, ...arguments_);
        };
        syncBuiltinESMExports();
        assert.throws(() => cleanupStrictIdentityFingerprint(identity, "file", victim),
          /ROLLBACK_CLEANUP_FILE_CHANGED/u);
        assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
        assert.equal(fs.lstatSync(victim).isFIFO(), true);
        assert.equal(fs.readFileSync(victim + ".original", "utf8"), "owned\\n");
        process.stdout.write("FIFO_REJECTED_DESCRIPTOR_CLOSED\\n");
      `, victim, new URL("../runtime/cleanup-tree.mjs", import.meta.url).href], {
        encoding: "utf8", timeout: 3_000,
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "FIFO_REJECTED_DESCRIPTOR_CLOSED\n");
    } finally {
      rmSync(current.boundary, { recursive: true, force: true });
    }
  });

}

function registerReadFailureCases() {
  test("changed strict metadata is rejected before opening file content", () => {
    const current = fixture();
    const nativeOpen = fs.openSync;
    let opens = 0;
    try {
      const victim = join(checkout(current.target), "owned");
      writeFileSync(victim, "owned\n");
      const expected = cleanupStrictIdentityFingerprint(lstatSync(victim, { bigint: true }), "file", victim);
      writeFileSync(victim, "foreign-longer\n");
      fs.openSync = (...arguments_) => {
        opens += 1;
        return nativeOpen(...arguments_);
      };
      syncBuiltinESMExports();
      assert.throws(() => assertCleanupStrictFingerprint(expected, victim, "checkout/owned"),
        /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=checkout\/owned/u);
      assert.equal(opens, 0, "foreign bytes must not be opened for hashing");
    } finally {
      fs.openSync = nativeOpen;
      syncBuiltinESMExports();
      rmSync(current.boundary, { recursive: true, force: true });
    }
  });

  test("two-pass fingerprints reject a changing read view with identical metadata", () => {
    const current = fixture();
    const nativeRead = fs.readSync;
    let restore;
    let descriptor;
    let changed = false;
    try {
      const victim = join(checkout(current.target), "owned");
      const bytes = Buffer.alloc(2 * 64 * 1024 + 17, 0x61);
      writeFileSync(victim, bytes);
      restore = holdMutationTimestamps(victim);
      const identity = lstatSync(victim, { bigint: true });
      fs.readSync = (held, buffer, offset, length, position) => {
        descriptor = held;
        const count = nativeRead(held, buffer, offset, length, position);
        if (!changed && position === 0n && count > 0) {
          changed = true;
          bytes[5] = 0x62; // Already-hashed bytes change before the second pass.
          writeFileSync(victim, bytes);
        }
        return count;
      };
      syncBuiltinESMExports();
      assert.throws(() => cleanupStrictIdentityFingerprint(identity, "file", victim),
        /ROLLBACK_CLEANUP_FILE_CHANGED/u);
      assert.equal(changed, true);
      assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
      assert.deepEqual(readFileSync(victim), bytes);
    } finally {
      fs.readSync = nativeRead;
      restore?.();
      syncBuiltinESMExports();
      rmSync(current.boundary, { recursive: true, force: true });
    }
  });

  test("file fingerprint retains the read failure when close also fails without retrying", () => {
    const current = fixture();
    const nativeRead = fs.readSync;
    const readFailure = new Error("injected read failure");
    const closeFailure = new Error("injected close failure");
    let restoreClose;
    let descriptor;
    let closes = 0;
    try {
      const victim = join(checkout(current.target), "owned");
      writeFileSync(victim, "owned\n");
      const identity = lstatSync(victim, { bigint: true });
      fs.readSync = (held) => {
        descriptor = held;
        throw readFailure;
      };
      syncBuiltinESMExports();
      restoreClose = setDescriptorCloseImplementationForTest((held) => {
        closes += 1;
        assert.equal(held, descriptor);
        closeSync(held);
        throw closeFailure;
      });
      assert.throws(() => cleanupStrictIdentityFingerprint(identity, "file", victim), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, "ROLLBACK_CLEANUP_FILE_CLOSE_FAILED");
        assert.equal(error.cause.message, "ROLLBACK_CLEANUP_FILE_READ_FAILED");
        assert.equal(error.cause.cause, readFailure);
        assert.deepEqual(error.errors, [error.cause, closeFailure]);
        return true;
      });
      assert.equal(closes, 1);
      assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
    } finally {
      restoreClose?.();
      fs.readSync = nativeRead;
      syncBuiltinESMExports();
      rmSync(current.boundary, { recursive: true, force: true });
    }
  });
}
