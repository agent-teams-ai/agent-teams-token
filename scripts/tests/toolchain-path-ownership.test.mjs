import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, chownSync, copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readVerifiedBytes } from "../toolchain-files.mjs";
import { assertOwnedDirectoryChain, canonicalizeTrustedPath } from "../toolchain-paths.mjs";
import { fetchArtifacts, installArtifacts, runPnpm, verifyCache } from "../toolchain.mjs";
import { makeFixture } from "./toolchain-fixture.mjs";

const ownerError = /TOOLCHAIN_DIRECTORY_OWNER_INVALID/u;
const identityError = /TOOLCHAIN_DIRECTORY_IDENTITY_INVALID/u;
const scriptsSource = dirname(dirname(fileURLToPath(import.meta.url)));

function copyChildSource(source, destination, depth = 0, budget = { entries: 0 }) {
  assert.ok(depth <= 16 && ++budget.entries <= 1024, "fixture source tree limit");
  const original = lstatSync(source);
  assert.ok(original.isDirectory() || (original.isFile() && original.nlink === 1),
    "fixture source must contain only directories and single-link regular files");
  const directory = original.isDirectory();
  if (directory) {
    mkdirSync(destination, { mode: 0o700 });
    for (const name of readdirSync(source)) {
      copyChildSource(join(source, name), join(destination, name), depth + 1, budget);
    }
  } else {
    const { bytes } = readVerifiedBytes(source, { maximumBytes: 1024 * 1024 });
    writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
    assert.deepEqual(readVerifiedBytes(destination).bytes, bytes);
  }
  const copied = lstatSync(destination);
  const parent = lstatSync(dirname(destination));
  assert.equal(copied.uid, process.getuid());
  // Darwin and setgid directories allocate entries with the parent's group.
  const inheritedGroup = process.platform === "darwin" || (parent.mode & 0o2000) !== 0;
  assert.equal(copied.gid, inheritedGroup ? parent.gid : process.getegid());
  assert.equal(copied.mode & 0o777, directory ? 0o700 : 0o600);
  assert.ok(directory ? copied.isDirectory() : copied.isFile() && copied.nlink === 1);
  assert.ok(copied.dev !== original.dev || copied.ino !== original.ino);
  // Only exclusive, newly owned fixture entries become readable/traversable.
  // No source links are copied, and the caller's umask never changes here.
  chmodSync(destination, directory ? 0o755 : 0o644);
}

function assertSourceUnchanged(before, after) {
  // Reads may update atime; identity and authority must remain unchanged.
  for (const key of ["dev", "ino", "mode", "nlink", "uid", "gid", "size", "mtimeMs", "ctimeMs"]) {
    assert.equal(after[key], before[key]);
  }
}

function registerChildSourceTests() {
  for (const mask of [0o022, 0o077]) {
    test(`ownership: copied child source is readable with umask ${mask.toString(8)}`, (context) => {
      const root = disposableRoot(context);
      const destination = join(root, "scripts");
      const names = ["", ...readdirSync(scriptsSource, { recursive: true })];
      const before = names.map((name) => lstatSync(join(scriptsSource, name)));
      const previous = process.umask(mask);
      try {
        copyChildSource(scriptsSource, destination);
        assert.equal(process.umask(), mask);
      } finally {process.umask(previous);}
      assert.equal(lstatSync(root).mode & 0o7777, 0o700);
      assert.deepEqual(readdirSync(destination, { recursive: true }).toSorted(), names.slice(1).toSorted());
      for (const [index, name] of names.entries()) {
        const source = join(scriptsSource, name);
        const copied = lstatSync(join(destination, name));
        const after = lstatSync(source);
        assertSourceUnchanged(before[index], after);
        assert.equal(copied.mode & 0o7777, before[index].isDirectory() ? 0o755 : 0o644);
        if (before[index].isFile()) {
          assert.deepEqual(readVerifiedBytes(join(destination, name)).bytes, readVerifiedBytes(source).bytes);
        }
      }
      context.diagnostic(`verified ${names.length} source entries: directories=0755 files=0644; private parent=0700; bytes and source authority unchanged`);
    });
  }
  for (const link of [symlinkSync, linkSync]) {
    test(`ownership: child source rejects ${link.name} without changing private authority`, (context) => {
      const root = disposableRoot(context);
      const source = join(root, "source");
      mkdirSync(source, { mode: 0o700 });
      const sentinel = join(root, "sentinel");
      writeFileSync(sentinel, "private source", { mode: 0o600 });
      link(sentinel, join(source, "link"));
      const before = lstatSync(sentinel);
      const mask = process.umask();
      assert.throws(() => copyChildSource(source, join(root, "copy")), /single-link regular files/u);
      assert.equal(process.umask(), mask);
      assert.equal(readFileSync(sentinel, "utf8"), "private source");
      assertSourceUnchanged(before, lstatSync(sentinel));
      assert.equal(lstatSync(root).mode & 0o7777, 0o700);
    });
  }
}

function uidOracle() {
  const uid = Number(execFileSync("/usr/bin/id", ["-u"], { encoding: "utf8" }).trim());
  assert.ok(Number.isSafeInteger(uid) && uid >= 0);
  assert.equal(process.getuid(), uid);
  return uid;
}

function disposableRoot(context, prefix = join(tmpdir(), "agtmai-path-ownership-")) {
  const root = canonicalizeTrustedPath(mkdtempSync(prefix));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(lstatSync(root).uid, uidOracle());
  return root;
}

function registerOwnedPathTests() {
  test("ownership: real UID owns existing and future managed directories", (context) => {
    const root = disposableRoot(context);
    const leaf = join(root, ".tools");
    assert.doesNotThrow(() => assertOwnedDirectoryChain(join(leaf, "downloads")));
    mkdirSync(leaf, { mode: 0o700 });
    assert.doesNotThrow(() => assertOwnedDirectoryChain(leaf));
    assert.doesNotThrow(() => assertOwnedDirectoryChain(join(leaf, "pnpm-store", "metadata-cache")));
    // Artifact selection must not select the host's pathname rules.
    assert.doesNotThrow(() => assertOwnedDirectoryChain(leaf, {
      platform: "linux-x64", hostPlatform: process.platform,
    }));
  });

  for (const mode of [0o702, 0o720, 0o777, 0o1777]) {
    test(`ownership: writable managed leaf and intermediate rejected (${mode.toString(8)})`, (context) => {
      const root = disposableRoot(context);
      const leaf = join(root, ".tools");
      mkdirSync(leaf);
      chmodSync(leaf, mode);
      assert.throws(() => assertOwnedDirectoryChain(leaf), identityError);
      assert.throws(() => assertOwnedDirectoryChain(join(leaf, "downloads")), identityError);
    });
  }

  test("ownership: symlink substitutions, dangling links and non-directories fail closed", (context) => {
    const root = disposableRoot(context);
    const leaf = join(root, ".tools");
    mkdirSync(leaf);
    assertOwnedDirectoryChain(leaf);
    renameSync(leaf, `${leaf}.held`);
    symlinkSync(`${leaf}.held`, leaf, "dir");
    assert.throws(() => assertOwnedDirectoryChain(leaf), identityError);
    assert.throws(() => assertOwnedDirectoryChain(join(leaf, "downloads")), identityError);
    const dangling = join(root, "dangling");
    symlinkSync(join(root, "missing"), dangling, "dir");
    assert.throws(() => assertOwnedDirectoryChain(dangling), identityError);
    const file = join(root, "file");
    writeFileSync(file, "synthetic sentinel");
    assert.throws(() => assertOwnedDirectoryChain(file), identityError);
    assert.throws(() => assertOwnedDirectoryChain(join(file, "child")), identityError);
  });

  test("ownership: inaccessible parent is not treated as a nonexistent leaf", (context) => {
    if (uidOracle() === 0) {context.skip("root bypasses directory search permissions"); return;}
    const root = disposableRoot(context);
    const parent = join(root, "inaccessible");
    mkdirSync(parent);
    chmodSync(parent, 0o600);
    try {assert.throws(() => assertOwnedDirectoryChain(join(parent, "missing")), identityError);}
    finally {chmodSync(parent, 0o700);}
  });

  test("ownership: the system sticky temporary root cannot itself be managed", () => {
    const temporary = canonicalizeTrustedPath("/tmp");
    const entry = lstatSync(temporary);
    assert.equal(entry.mode & 0o7777, 0o1777);
    assert.throws(() => assertOwnedDirectoryChain(temporary), identityError);
  });
}

function registerDarwinPathTests() {
  test("ownership: Darwin canonical aliases and private var folders retain host semantics", (context) => {
    if (process.platform !== "darwin") {context.skip("requires actual Darwin filesystem aliases"); return;}
    const root = disposableRoot(context, "/tmp/agtmai-path-ownership-");
    assert.ok(root.startsWith("/private/tmp/"));
    const alias = root.replace(/^\/private\/tmp/u, "/tmp");
    assert.equal(canonicalizeTrustedPath(alias), root);
    assertOwnedDirectoryChain(alias, { platform: "linux-x64", hostPlatform: "darwin" });
    assert.equal(canonicalizeTrustedPath("/var/folders"), "/private/var/folders");
    const privateTemp = disposableRoot(context);
    assertOwnedDirectoryChain(privateTemp);
    const link = join(privateTemp, "link");
    symlinkSync(root, link, "dir");
    assert.throws(() => assertOwnedDirectoryChain(link), identityError);
    assert.throws(() => assertOwnedDirectoryChain("/tmp"), identityError);
  });
}

function ownedDirectory(path, uid, mode = 0o755) {
  mkdirSync(path);
  chownSync(path, uid, uid);
  chmodSync(path, mode);
  const entry = lstatSync(path);
  assert.equal(entry.uid, uid);
  assert.equal(entry.mode & 0o7777, mode);
  return path;
}

function rootOwnershipCases(root, uid) {
  const owned = ownedDirectory(join(root, "owned"), uid, 0o700);
  const cases = [[owned, "ok"], [join(owned, "new-tools", "downloads"), "ok"]];
  const immutable = ownedDirectory(join(root, "immutable"), 0, 0o555);
  // Temporarily writable only while constructing this disposable fixture.
  chmodSync(immutable, 0o755);
  const leaf = ownedDirectory(join(immutable, "leaf"), uid, 0o700);
  chmodSync(immutable, 0o555);
  cases.push([leaf, "ok"], [immutable, "owner"], [join(root, "missing"), "owner"]);
  for (const role of [".tools", "downloads", "install", "bin", "pnpm-store", "metadata-cache"]) {
    const managed = ownedDirectory(join(owned, role), 0);
    const descendant = ownedDirectory(join(managed, "caller-owned"), uid);
    cases.push([managed, "owner"], [descendant, "owner"], [join(managed, "missing"), "owner"]);
  }
  const foreign = ownedDirectory(join(root, "foreign"), uid - 1);
  cases.push([ownedDirectory(join(foreign, "leaf"), uid), "owner"]);
  for (const mode of [0o775, 0o777, 0o1777]) {
    const unsafe = ownedDirectory(join(root, `unsafe-${mode}`), 0, mode);
    cases.push([ownedDirectory(join(unsafe, "leaf"), uid), "identity"]);
  }
  const fakeTemp = ownedDirectory(join(owned, "tmp"), uid, 0o1777);
  cases.push([fakeTemp, "identity"], [join(fakeTemp, "missing"), "identity"]);
  const alias = join(root, "alias");
  symlinkSync(owned, alias, "dir");
  cases.push([join(alias, "missing"), "identity"]);
  return cases;
}

function prepareRootChild(context) {
  const root = disposableRoot(context, "/tmp/agtmai-path-root-child-");
  const node = join(root, "node");
  copyFileSync(process.execPath, node);
  chmodSync(node, 0o755);
  // Execute only copied source and newly created synthetic state. The child
  // needs no access to the host worktree's private runtime or directories.
  copyChildSource(scriptsSource, join(root, "scripts"));
  chmodSync(root, 0o755);
  return { root, node };
}

function registerRootChildTest() {
  test("ownership: actual Linux non-root child checks shared ancestors and managed caller roots", (context) => {
    if (process.platform !== "linux" || uidOracle() !== 0) {
      context.skip("privileged Linux execution unavailable; real cross-UID fixtures require root");
      return;
    }
    const { root, node } = prepareRootChild(context);
    const uid = 65534;
    const cases = rootOwnershipCases(root, uid);
    const fixture = makeFixture();
    context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const managed = ownedDirectory(join(root, "managed-tools"), 0);
    ownedDirectory(join(managed, "downloads"), uid, 0o700);
    ownedDirectory(join(managed, "bin"), uid, 0o700);
    const moduleUrl = pathToFileURL(join(root, "scripts/tests/toolchain-path-ownership.test.mjs")).href;
    const script = `import { runOwnershipChild } from ${JSON.stringify(moduleUrl)};
      runOwnershipChild(${JSON.stringify({ uid, cases, managed, lock: fixture.lock })});`;
    const result = spawnSync(node, ["--input-type=module", "--eval", script], {
      cwd: root, uid, gid: uid, encoding: "utf8", timeout: 30_000,
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", TMPDIR: join(root, "owned") },
    });
    if (result.error?.code === "EPERM") {
      context.skip("sandbox denied the actual non-root child; no UID mock substituted");
      return;
    }
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stdout, `OWNERSHIP_CHILD_OK uid=${uid} cases=${cases.length} callers=4\n`);
  });
}

export function runOwnershipChild({ uid, cases, managed, lock }) {
  assert.equal(uidOracle(), uid);
  assert.notEqual(uid, 0);
  for (const [path, expected] of cases) {
    const check = () => assertOwnedDirectoryChain(path);
    if (expected === "ok") {assert.doesNotThrow(check, path);}
    else {assert.throws(check, expected === "owner" ? ownerError : identityError, path);}
  }
  const options = { lock, platform: "linux-x64", toolsRoot: managed, offline: true, args: [] };
  for (const call of [fetchArtifacts, installArtifacts, verifyCache, runPnpm]) {
    assert.throws(() => call({ ...options, downloader: () => assert.fail("unexpected download") }), ownerError);
  }
  process.stdout.write(`OWNERSHIP_CHILD_OK uid=${uid} cases=${cases.length} callers=4\n`);
}

export function registerToolchainPathOwnershipTests() {
  registerChildSourceTests();
  registerOwnedPathTests();
  registerDarwinPathTests();
  registerRootChildTest();
}
