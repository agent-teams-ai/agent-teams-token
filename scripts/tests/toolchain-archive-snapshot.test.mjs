import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareVerifiedPayload, cleanupPreparedPayload } from "../toolchain-archive.mjs";

function fixture(context) {
  const root = fs.mkdtempSync(join(tmpdir(), "agtmai-private-archive-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(join(source, "tool"), "authenticated bytes\n");
  const archive = join(root, "archive.tar.gz");
  assert.equal(childProcess.spawnSync("/usr/bin/tar", ["-czf", archive, "-C", source, "tool"]).status, 0);
  const bytes = fs.readFileSync(archive);
  return { root, bytes, archive, name: "fixture", platform: "linux-x64", toolsRoot: root,
    missingCode: "TEST_MISSING", artifact: { archive: "tar.gz", expectedFiles: ["tool"],
      sha256: createHash("sha256").update(bytes).digest("hex") } };
}

async function assertParallelCustody(context) {
    const args = fixture(context);
    const executable = join(args.root, "verified-command");
    fs.writeFileSync(executable, "#!/bin/sh\nprintf 'verified\\n'\n", { mode: 0o755 });
    const expectedSha256 = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
    const source = `
      import { prepareVerifiedPayload, cleanupPreparedPayload } from ${JSON.stringify(new URL("../toolchain-archive.mjs", import.meta.url).href)};
      import { executeVerifiedFile } from ${JSON.stringify(new URL("../toolchain-execution.mjs", import.meta.url).href)};
      const args = JSON.parse(process.argv[1]);
      for (let index = 0; index < 3; index += 1) {
        const prepared = prepareVerifiedPayload(args);
        try {
          const output = executeVerifiedFile({ path: process.argv[2], expectedSha256: process.argv[3] });
          if (output !== "verified") { throw new Error("unexpected authenticated output"); }
        } finally { cleanupPreparedPayload(prepared); }
      }
    `;
    const outcomes = await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
      const child = childProcess.spawn(process.execPath, [
        "--input-type=module", "--eval", source, JSON.stringify(args), executable, expectedSha256,
      ], { env: { ...process.env, TMPDIR: args.root }, stdio: ["ignore", "ignore", "pipe"], timeout: 15_000 });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, signal, stderr }));
    })));
    for (const outcome of outcomes) { assert.equal(outcome.status, 0, JSON.stringify(outcome)); }
    assert.deepEqual(fs.readdirSync(args.root).filter((name) =>
      name.startsWith(".install-part-") || name.startsWith("agtmai-toolchain-exec-")), []);
}

export function registerArchiveSnapshotTests() {
  test("parallel processes prepare and execute without sharing invocation custody", assertParallelCustody);
  test("overlapping archive preparations retain independent cleanup custody", (context) => {
    const args = fixture(context);
    let sibling;
    const first = prepareVerifiedPayload({
      ...args,
      onArchiveVerified() { sibling = prepareVerifiedPayload(args); },
    });
    try {
      cleanupPreparedPayload(first);
      assert.equal(fs.readFileSync(join(sibling.source, "tool"), "utf8"), "authenticated bytes\n");
    } finally { cleanupPreparedPayload(sibling); }
    assert.deepEqual(fs.readdirSync(args.root).filter((name) => name.startsWith(".install-part-")), []);
  });

  test("archive custody canonicalizes the Darwin system temp alias before allocation", {
    skip: process.platform !== "darwin" && "requires Darwin /tmp alias",
  }, (context) => {
    const args = fixture(context);
    const root = fs.mkdtempSync("/tmp/agtmai-archive-alias-");
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = prepareVerifiedPayload({ ...args, toolsRoot: root });
    try {
      assert.equal(prepared.stageRoot, fs.realpathSync(prepared.stageRoot));
      assert.ok(prepared.stageRoot.startsWith("/private/tmp/"));
      assert.equal(fs.readFileSync(join(prepared.source, "tool"), "utf8"), "authenticated bytes\n");
    } finally { cleanupPreparedPayload(prepared); }
    assert.deepEqual(fs.readdirSync(root), []);
  });

  test("archive custody rejects untrusted descendant aliases before allocating a stage", (context) => {
    const args = fixture(context);
    const target = join(args.root, "target");
    const alias = join(args.root, "alias");
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias);
    assert.throws(() => prepareVerifiedPayload({ ...args, toolsRoot: alias }), /TOOLCHAIN_DIRECTORY_IDENTITY_INVALID/u);
    assert.deepEqual(fs.readdirSync(target), []);
  });

  for (const attack of ["overwrite", "hardlink-write"]) {
    test(`cache ${attack} at extraction cannot affect the unlinked private snapshot`, (context) => {
      const args = fixture(context);
      const spawn = childProcess.spawnSync;
      let extractions = 0;
      childProcess.spawnSync = (command, argv, options) => {
        if (command === "/usr/bin/tar" && argv.includes("/dev/fd/3")) {
          extractions += 1;
          const descriptor = options.stdio[3];
          const stats = fs.fstatSync(descriptor);
          assert.equal(stats.nlink, 0);
          assert.notEqual(stats.ino, fs.statSync(args.archive).ino);
          let target = args.archive;
          if (attack === "hardlink-write") {
            target = join(args.root, "cache-alias");
            fs.linkSync(args.archive, target);
          }
          fs.writeFileSync(target, "hostile bytes");
          const bytes = Buffer.alloc(args.bytes.length);
          fs.readSync(descriptor, bytes, 0, bytes.length, 0);
          assert.deepEqual(bytes, args.bytes);
          const result = spawn(command, argv, options);
          assert.equal(result.status, 0);
          assert.equal(fs.readFileSync(join(argv.at(-1), "tool"), "utf8"), "authenticated bytes\n");
          return result;
        }
        return spawn(command, argv, options);
      };
      syncBuiltinESMExports();
      try {
        assert.throws(() => prepareVerifiedPayload(args), /TOOLCHAIN_ARCHIVE_SUBSTITUTED/u);
        assert.equal(extractions, 1);
      } finally { childProcess.spawnSync = spawn; syncBuiltinESMExports(); }
    });
  }

  test("snapshot hardlink surviving unlink prevents any extraction", (context) => {
    const args = fixture(context);
    const unlink = fs.unlinkSync;
    const spawn = childProcess.spawnSync;
    let extractions = 0;
    fs.unlinkSync = (path) => {
      if (String(path).endsWith("/.archive-snapshot")) { fs.linkSync(path, join(args.root, "snapshot-alias")); }
      return unlink(path);
    };
    childProcess.spawnSync = (...argv) => { extractions += 1; return spawn(...argv); };
    syncBuiltinESMExports();
    try {
      assert.throws(() => prepareVerifiedPayload(args), /TOOLCHAIN_ARCHIVE_SNAPSHOT_LINKED/u);
      assert.equal(extractions, 0);
    } finally { fs.unlinkSync = unlink; childProcess.spawnSync = spawn; syncBuiltinESMExports(); }
  });

  test("cache hardlinks are rejected before snapshot preparation", (context) => {
    const args = fixture(context);
    fs.linkSync(args.archive, join(args.root, "alias"));
    assert.throws(() => prepareVerifiedPayload(args), /TOOLCHAIN_ARCHIVE_UNSAFE/u);
  });

  test("snapshot mutation during unlink is rejected before extraction", (context) => {
    const args = fixture(context);
    const unlink = fs.unlinkSync;
    const spawn = childProcess.spawnSync;
    let mutated = false;
    let extractions = 0;
    fs.unlinkSync = (path) => {
      if (String(path).endsWith("/.archive-snapshot")) {
        // Preserve the length so the post-unlink digest, not a size check,
        // must reject a mutation after the first snapshot authentication.
        fs.writeFileSync(path, Buffer.alloc(args.bytes.length, 0x61));
        mutated = true;
      }
      return unlink(path);
    };
    childProcess.spawnSync = (...argv) => { extractions += 1; return spawn(...argv); };
    syncBuiltinESMExports();
    try {
      assert.throws(() => prepareVerifiedPayload(args), /TOOLCHAIN_ARCHIVE_SNAPSHOT_UNVERIFIED/u);
      assert.equal(mutated, true);
      assert.equal(extractions, 0);
    } finally { fs.unlinkSync = unlink; childProcess.spawnSync = spawn; syncBuiltinESMExports(); }
  });

  test("ordinary private snapshot extraction retains authenticated payload", (context) => {
    const args = fixture(context);
    const prepared = prepareVerifiedPayload(args);
    try { assert.equal(fs.readFileSync(join(prepared.source, "tool"), "utf8"), "authenticated bytes\n"); }
    finally { cleanupPreparedPayload(prepared); }
  });
}
