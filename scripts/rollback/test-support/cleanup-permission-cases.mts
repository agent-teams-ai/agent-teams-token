import assert from "node:assert/strict";
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, existsSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { checkout, fixture } from "./cleanup-fixture.mjs";
import {
  captureCleanupTreeSnapshot, cleanupIdentityBoundDirectory, createCleanupHandle,
} from "../runtime/cleanup.mjs";

type Boundary = {
  stage: string;
  path?: string;
  sourcePath?: string;
  stagedPath?: string;
};

function sealedProvider(mode = 0o500) {
  const current = fixture();
  const root = checkout(current.target);
  const local = join(root, ".local");
  const inputs = join(local, "INPUT");
  const provider = join(inputs, "provider");
  const modules = join(provider, "node_modules");
  const packageRoot = join(modules, "package");
  for (const path of [local, inputs, provider, modules, packageRoot]) {
    mkdirSync(path, { mode: 0o700 });
  }
  const declaration = join(packageRoot, "index.d.ts");
  writeFileSync(declaration, "export declare const input: string;\n", { mode: 0o400 });
  // Held fixture FDs let teardown release only the original read-only objects,
  // including after a rejecting case has moved them into retained quarantine.
  const descriptors = [provider, modules, packageRoot].map((path) =>
    openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
  for (const descriptor of descriptors) { fchmodSync(descriptor, mode); }
  return {
    ...current, root, inputs, provider, declaration, descriptors,
    release() {
      for (const descriptor of descriptors) {
        fchmodSync(descriptor, 0o700);
        closeSync(descriptor);
      }
      rmSync(current.boundary, { recursive: true, force: true });
    },
  };
}

for (const mode of [0o500, 0o555]) {
  test(`Linux fd-bound cleanup removes captured provider directories with mode ${mode.toString(8)}`,
    { skip: process.platform !== "linux" }, () => {
    assert.equal(process.platform, "linux", "this regression requires real Linux rename semantics");
    const current = sealedProvider(mode);
    let parent: number | undefined;
    let destination: number | undefined;
    try {
      const before = fstatSync(current.descriptors[0]!, { bigint: true });
      assert.equal(before.uid, BigInt(process.getuid!()));
      assert.equal(before.mode & 0o777n, BigInt(mode));
      assert.equal(lstatSync(current.inputs).mode & 0o777, 0o700);
      mkdirSync(join(current.root, "destination"), { mode: 0o700 });
      parent = openSync(current.inputs, constants.O_RDONLY | constants.O_DIRECTORY);
      destination = openSync(join(current.root, "destination"), constants.O_RDONLY | constants.O_DIRECTORY);
      // Both parents are writable and same-UID. Moving the directory itself
      // between parents still requires owner write permission to update '..'.
      assert.throws(() => renameSync(`/proc/self/fd/${parent}/provider`,
        `/proc/self/fd/${destination}/provider`), { code: "EACCES" });
      assert.equal(fstatSync(current.descriptors[0]!, { bigint: true }).ino, before.ino);
      const handle = createCleanupHandle(current.target, current.policy);
      assert.ok(handle);
      captureCleanupTreeSnapshot(handle);
      const adjusted: string[] = [];
      let checkedFile = false;
      const report = cleanupIdentityBoundDirectory(handle, {
        onBoundary(event: Boundary) {
          if (event.stage === "before-directory-permissions") {
            assert.ok(event.sourcePath?.startsWith("/proc/self/fd/"));
            assert.equal(lstatSync(event.sourcePath!).mode & 0o777, mode);
            adjusted.push(event.path!);
          }
          if (event.stage === "before-entry-delete" && event.path?.endsWith("index.d.ts")) {
            assert.equal(lstatSync(event.stagedPath!).mode & 0o777, 0o400);
            assert.equal(readFileSync(event.stagedPath!, "utf8"), "export declare const input: string;\n");
            checkedFile = true;
          }
        },
      });
      assert.ok(report);
      assert.equal(report.result, "contents-removed");
      assert.equal(report.device, handle.device);
      assert.equal(report.inode, handle.inode);
      assert.equal(report.removedEntryCount, 8);
      assert.deepEqual(adjusted, ["checkout/.local/INPUT/provider",
        "checkout/.local/INPUT/provider/node_modules",
        "checkout/.local/INPUT/provider/node_modules/package"]);
      assert.equal(checkedFile, true);
      assert.equal(existsSync(current.target), false);
      assert.equal(handle.closed, true);
      assert.equal(fstatSync(current.descriptors[0]!, { bigint: true }).ino, before.ino);
      assert.equal(fstatSync(current.descriptors[0]!, { bigint: true }).mode & 0o777n,
        BigInt(mode | 0o200));
    } finally {
      if (parent !== undefined) { closeSync(parent); }
      if (destination !== undefined) { closeSync(destination); }
      current.release();
    }
  });
}

for (const substitute of ["directory", "symlink", "file-content"] as const) {
  test(`cleanup permission transition preserves ${substitute} substitution and quarantine`, () => {
    const current = sealedProvider();
    const external = join(current.boundary, "external");
    let replacement: string | undefined;
    let reached = false;
    try {
      mkdirSync(external, { mode: 0o700 });
      writeFileSync(join(external, "sentinel"), "external survives\n");
      chmodSync(external, 0o500);
      const handle = createCleanupHandle(current.target, current.policy);
      assert.ok(handle);
      captureCleanupTreeSnapshot(handle);
      let failure: Error | undefined;
      assert.throws(() => cleanupIdentityBoundDirectory(handle, {
        onBoundary(event: Boundary) {
          if (event.stage !== "before-directory-permissions"
            || event.path !== "checkout/.local/INPUT/provider") { return; }
          reached = true;
          if (substitute === "file-content") {
            const file = join(event.sourcePath!, "node_modules/package/index.d.ts");
            chmodSync(file, 0o600);
            writeFileSync(file, "export declare const other: string;\n");
            chmodSync(file, 0o400);
          } else {
            const source = event.sourcePath!;
            // Linux also requires write permission for the adversarial move.
            chmodSync(source, 0o700);
            renameSync(source, source + ".original");
            chmodSync(source + ".original", 0o500);
            replacement = join(realpathSync(dirname(source)), basename(source));
            if (substitute === "directory") { mkdirSync(source, { mode: 0o500 }); }
            else { symlinkSync(external, source); }
          }
        },
      }), (error: unknown) => {
        assert.ok(error instanceof Error);
        failure = error;
        assert.match(error.message, substitute === "file-content"
          ? /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH/u
          : /ROLLBACK_CUSTODY_PARENT_SUBSTITUTED/u);
        assert.match(error.message, /preservedQuarantine=/u);
        return true;
      });
      assert.ok(failure);
      assert.equal(reached, true);
      assert.equal(handle.closed, true);
      const quarantine = /preservedQuarantine=([^\s]+)/u.exec(failure.message)![1]!;
      assert.equal(existsSync(quarantine), true);
      assert.equal(lstatSync(external).mode & 0o777, 0o500);
      assert.equal(readFileSync(join(external, "sentinel"), "utf8"), "external survives\n");
      if (substitute === "directory") {
        assert.equal(lstatSync(replacement!).mode & 0o777, 0o500);
        chmodSync(replacement!, 0o700);
      } else if (substitute === "symlink") {
        assert.equal(lstatSync(replacement!).isSymbolicLink(), true);
      } else {
        const preserved = join(quarantine, "tree/checkout/.local/INPUT/provider/node_modules/package/index.d.ts");
        assert.equal(lstatSync(preserved).mode & 0o777, 0o400);
        assert.equal(readFileSync(preserved, "utf8"), "export declare const other: string;\n");
      }
    } finally {
      if (existsSync(external)) { chmodSync(external, 0o700); }
      if (substitute === "directory" && replacement !== undefined && existsSync(replacement)) {
        chmodSync(replacement, 0o700);
      }
      current.release();
    }
  });
}
