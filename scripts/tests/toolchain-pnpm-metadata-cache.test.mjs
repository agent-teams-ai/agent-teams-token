import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fetchArtifacts, installArtifacts, loadLock, runPnpm } from "../toolchain.mjs";
import { makeFixture } from "./toolchain-fixture.mjs";
import { observeConsumerDescriptors } from "./rollback-consumer-close-fixture.mjs";

const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
const repository = new URL("../../", import.meta.url).pathname;
const packageName = "@agtmai/offline-metadata-fixture";
const installArgs = ["install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--package-import-method=copy"];

function installedFixture(context, realPnpm = false, customize) {
  const fixture = makeFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  customize?.(fixture);
  if (realPnpm) {
    fixture.lock.tools.pnpm = loadLock().tools.pnpm;
    const downloader = fixture.downloader;
    fixture.downloader = (url, fd) => {
      if (url !== fixture.lock.tools.pnpm.source) {return downloader(url, fd);}
      fs.writeSync(fd, fs.readFileSync(join(repository, ".tools/downloads", fixture.lock.tools.pnpm.archiveName)));
      return 0;
    };
  }
  fetchArtifacts({ ...fixture, platform });
  installArtifacts({ ...fixture, platform, offline: true });
  return fixture;
}

function pnpm(fixture, cwd, args) {
  return spawnSync(join(fixture.toolsRoot, "bin/pnpm"), args, {
    cwd, encoding: "utf8", timeout: 30_000,
    env: { PATH: "/usr/bin:/bin", HOME: fixture.root, npm_config_cache_dir: "/dev/null",
      NPM_CONFIG_CACHE_DIR: "/dev/null", XDG_CACHE_HOME: "/dev/null" },
  });
}

function succeeded(result) {assert.equal(result.status, 0, result.stdout + result.stderr);}

function writeMetadata(store, integrity, tarball) {
  const manifest = { name: packageName, version: "1.0.0", dist: { integrity, tarball } };
  const meta = { name: packageName, "dist-tags": { latest: "1.0.0" },
    time: { "1.0.0": "2020-01-01T00:00:00Z" }, versions: { "1.0.0": manifest } };
  for (const kind of ["metadata", "metadata-full", "metadata-full-filtered"]) {
    const path = join(store, "metadata-cache/v11", kind, "registry.npmjs.org", `${packageName}.jsonl`);
    fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path, `{}\n${JSON.stringify(meta)}`, { mode: 0o600 });
  }
}

function projectFixture(root) {
  const payload = join(root, "package");
  fs.mkdirSync(payload);
  fs.writeFileSync(join(payload, "package.json"), JSON.stringify({ name: packageName, version: "1.0.0",
    scripts: { install: "node -e \"require('node:fs').writeFileSync('LIFECYCLE_RAN','unsafe')\"" } }));
  fs.writeFileSync(join(payload, "index.js"), "module.exports = 42;\n");
  const tarball = join(root, "fixture.tgz");
  execFileSync("/usr/bin/tar", ["-czf", tarball, "-C", root, "package"]);
  const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
  const project = join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(join(project, "package.json"), JSON.stringify({ name: "metadata-consumer", private: true,
    packageManager: "pnpm@11.24.0", dependencies: { [packageName]: "1.0.0" } }));
  fs.writeFileSync(join(project, "pnpm-workspace.yaml"), "autoInstallPeers: false\nminimumReleaseAge: 1440\ntrustPolicy: no-downgrade\n");
  fs.writeFileSync(join(project, "pnpm-lock.yaml"), `lockfileVersion: '9.0'
settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies:
      '${packageName}':
        specifier: 1.0.0
        version: 1.0.0
packages:
  '${packageName}@1.0.0':
    resolution: {integrity: ${integrity}}
snapshots:
  '${packageName}@1.0.0': {}
`);
  return { project, integrity, tarball };
}

export function registerPnpmMetadataCacheTests() {
  registerPnpmOfflineMetadataTests();
  registerPnpmCacheAuthorityTests();
  registerPnpmCacheCreationTests();
  registerPnpmMetadataUmaskTests();
}

function registerPnpmOfflineMetadataTests() {
  test("pinned pnpm reuses offline policy metadata with each owned store across fetch and install", (context) => {
    // Install and authenticate under the same caller semantics. Darwin archive
    // symlinks are not normalized across independently chosen caller umasks.
    const previousUmask = process.umask(0o022);
    context.after(() => process.umask(previousUmask));
    const fixture = installedFixture(context, true);
    const { project, integrity, tarball } = projectFixture(fixture.root);
    const lockBytes = fs.readFileSync(join(project, "pnpm-lock.yaml"));
    for (const override of [false, true]) {
      const store = join(fixture.toolsRoot, override ? "rollback-store" : "pnpm-store");
      fs.mkdirSync(store, { mode: 0o700 });
      const prefix = override ? [`--agtmai-trusted-store=${store}`] : [];
      // Seed a synthetic package through real pnpm using only a local tarball.
      // This is an offline regression fixture, not registry/provenance evidence.
      writeMetadata(store, integrity, `file:${tarball}`);
      succeeded(pnpm(fixture, project, [...prefix, "store", "add", `${packageName}@1.0.0`,
        "--config.offline=true", "--config.ignore-scripts=true"]));
      writeMetadata(store, integrity, `https://registry.npmjs.org/${packageName}/-/offline-metadata-fixture-1.0.0.tgz`);
      const cache = join(store, "metadata-cache");
      // Leave the package bytes warm and remove only policy metadata.
      fs.renameSync(cache, `${cache}.held`);
      const missing = pnpm(fixture, project, [...prefix, ...installArgs]);
      assert.notEqual(missing.status, 0);
      assert.match(missing.stdout + missing.stderr, /ERR_PNPM_NO_OFFLINE_META|ERR_PNPM_LOCKFILE_POLICY_VIOLATION/u);
      fs.rmSync(cache, { recursive: true });
      fs.renameSync(`${cache}.held`, cache);
      succeeded(pnpm(fixture, project, [...prefix, "fetch", "--offline", "--frozen-lockfile", "--ignore-scripts"]));
      fs.rmSync(join(project, "node_modules"), { recursive: true, force: true });
      succeeded(pnpm(fixture, project, [...prefix, ...installArgs]));
      assert.equal(fs.readFileSync(join(project, "node_modules", packageName, "index.js"), "utf8"), "module.exports = 42;\n");
      assert.equal(fs.existsSync(join(project, "node_modules", packageName, "LIFECYCLE_RAN")), false);
      assert.equal(pnpm(fixture, project, [...prefix, "store", "path", "--silent"]).stdout.trim(), join(store, "v11"));
      assert.equal(fs.statSync(cache).mode & 0o777, 0o700);
      if (!override) {
        const cwd = process.cwd();
        const mask = process.umask(0o022);
        try {
          process.chdir(project);
          fs.rmSync(join(project, "node_modules"), { recursive: true });
          fs.unlinkSync(join(cache, "lockfile-verified.jsonl"));
          assert.equal(runPnpm({ ...fixture, platform, args: installArgs }), 0);
          assert.equal(process.umask(), 0o022);
          assert.equal(fs.statSync(join(cache, "lockfile-verified.jsonl")).mode & 0o777, 0o600);
        } finally { process.chdir(cwd); process.umask(mask); }
      }
      fs.rmSync(join(project, "node_modules"), { recursive: true });
    }
    assert.deepEqual(fs.readFileSync(join(project, "pnpm-lock.yaml")), lockBytes);
  });

}

function registerPnpmCacheAuthorityTests() {
  test("pnpm cache arguments and unsafe cache paths are rejected before child execution", (context) => {
    const fixture = installedFixture(context);
    const bin = join(fixture.toolsRoot, "bin");
    const marker = join(fixture.root, "executed");
    fs.writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
    for (const option of ["--cache-dir", "--config.cache-dir", "--cacheDir", "--config.cacheDir",
      "--config.cache_dir", "--config.CACHE-DIR", "--no-cache-dir"]) {
      for (const args of [[`${option}=/tmp`], [option, "/tmp"]]) {
        const result = pnpm(fixture, fixture.root, [...args, "--version"]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /TOOLCHAIN_PNPM_AUTHORITY_ARGUMENT_FORBIDDEN/u);
        assert.equal(fs.existsSync(marker), false);
        assert.throws(() => runPnpm({ ...fixture, platform, args }), /TOOLCHAIN_PNPM_AUTHORITY_ARGUMENT_FORBIDDEN/u);
      }
    }
    const store = join(fixture.toolsRoot, "pnpm-store");
    fs.mkdirSync(store, { mode: 0o700 });
    const cache = join(store, "metadata-cache");
    const foreign = join(fixture.root, "foreign");
    fs.mkdirSync(foreign, { mode: 0o700 });
    fs.writeFileSync(join(foreign, "sentinel"), "preserved", { mode: 0o600 });
    for (const kind of ["symlink", "writable", "file", "nested-symlink", "hardlink"]) {
      if (kind === "symlink") {fs.symlinkSync(foreign, cache);}
      else if (kind === "file") {fs.writeFileSync(cache, "invalid");}
      else {
        fs.mkdirSync(cache, { mode: 0o700 });
        if (kind === "writable") {fs.chmodSync(cache, 0o777);}
        if (kind === "nested-symlink") {fs.symlinkSync(foreign, join(cache, "v11"));}
        if (kind === "hardlink") {fs.linkSync(join(foreign, "sentinel"), join(cache, "metadata.jsonl"));}
      }
      const result = pnpm(fixture, fixture.root, ["--version"]);
      assert.equal(result.status, 1, kind);
      assert.match(result.stderr, /TOOLCHAIN_PNPM_CACHE_UNSAFE/u);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.readFileSync(join(foreign, "sentinel"), "utf8"), "preserved");
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

  test("authenticated pnpm rejects cache substitution and preserves a writable store", (context) => {
    const previousUmask = process.umask(0o022);
    context.after(() => process.umask(previousUmask));
    const fixture = installedFixture(context);
    const store = join(fixture.toolsRoot, "pnpm-store");
    fs.mkdirSync(store, { mode: 0o700 });
    fs.chmodSync(store, 0o755);
    assert.throws(() => runPnpm({ ...fixture, platform, args: ["--version"] }), /TOOLCHAIN_PNPM_STORE_UNSAFE/u);
    assert.equal(process.umask(), 0o022);
    assert.equal(fs.statSync(store).mode & 0o777, 0o755);
    fs.chmodSync(store, 0o700);
    const cache = join(store, "metadata-cache");
    const foreign = join(fixture.root, "foreign-cache");
    fs.mkdirSync(foreign, { mode: 0o700 });
    fs.writeFileSync(join(foreign, "sentinel"), "preserved", { mode: 0o600 });
    fs.symlinkSync(foreign, cache);
    assert.throws(() => runPnpm({ ...fixture, platform, args: ["--version"] }), /TOOLCHAIN_DIRECTORY_IDENTITY_INVALID/u);
    assert.equal(process.umask(), 0o022);
    assert.equal(fs.readFileSync(join(foreign, "sentinel"), "utf8"), "preserved");
    fs.unlinkSync(cache);
    fs.mkdirSync(cache, { mode: 0o700 });
    fs.symlinkSync(foreign, join(cache, "v11"));
    assert.throws(() => runPnpm({ ...fixture, platform, args: ["--version"] }), /TOOLCHAIN_PNPM_CACHE_UNSAFE/u);
    assert.equal(process.umask(), 0o022);
    fs.unlinkSync(join(cache, "v11"));
    const readDirectory = fs.readdirSync;
    let replaced = false;
    fs.readdirSync = (path, ...args) => {
      const entries = readDirectory(path, ...args);
      if (path === cache && !replaced) {
        replaced = true;
        fs.renameSync(cache, `${cache}.held`);
        fs.mkdirSync(cache, { mode: 0o700 });
        fs.writeFileSync(join(cache, "foreign"), "preserved", { mode: 0o600 });
      }
      return entries;
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => runPnpm({ ...fixture, platform, args: ["--version"] }), /TOOLCHAIN_PNPM_CACHE_UNSAFE/u);
      assert.equal(process.umask(), 0o022);
      assert.equal(replaced, true);
      assert.equal(fs.readFileSync(join(cache, "foreign"), "utf8"), "preserved");
    } finally { fs.readdirSync = readDirectory; syncBuiltinESMExports(); }
  });

}

function registerPnpmCacheCreationTests() {
  test("pnpm cache creation admits only a private concurrent winner", (context) => {
    const fixture = installedFixture(context);
    const bin = join(fixture.toolsRoot, "bin");
    const marker = join(fixture.root, "executed");
    fs.writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
    const wrapperPath = join(bin, "pnpm");
    const wrapper = fs.readFileSync(wrapperPath, "utf8");
    const store = join(fixture.toolsRoot, "pnpm-store");
    const cache = join(store, "metadata-cache");
    for (const kind of ["private", "writable", "substituted-store"]) {
      const competitor = kind === "substituted-store"
        ? `/bin/mv "$token_pnpm_store" "$token_pnpm_store.held"; /bin/mkdir -m 700 "$token_pnpm_store"; /bin/mkdir -m 700 "$token_pnpm_cache"`
        : `/bin/mkdir -m ${kind === "private" ? "700" : "777"} "$token_pnpm_cache"`;
      // Interpose after the absence test at the real shell mkdir boundary.
      const raced = wrapper.replace('/bin/mkdir -m 700 "$token_pnpm_cache"', `{ ${competitor}; false; }`);
      assert.notEqual(raced, wrapper);
      fs.writeFileSync(wrapperPath, raced);
      const result = pnpm(fixture, fixture.root, ["--version"]);
      assert.equal(result.status, kind === "private" ? 0 : 1, result.stderr);
      assert.equal(fs.existsSync(marker), kind === "private");
      fs.rmSync(marker, { force: true });
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

}

function registerPnpmMetadataUmaskTests() {
  for (const callerUmask of [0o022, 0o077]) {
    test(`authenticated pnpm metadata scopes private writes without changing authentication umask ${callerUmask.toString(8)}`, (context) => {
      const previousUmask = process.umask(callerUmask);
      context.after(() => process.umask(previousUmask));
      const fixture = installedFixture(context, false, customizeMetadataWriter);
      const node = join(fixture.toolsRoot, fixture.lock.tools.node.platforms[platform].installDirectory);
      const links = () => ["npm", "npx"].map((name) => ({
        mode: fs.lstatSync(join(node, "bin", name)).mode,
        target: fs.readlinkSync(join(node, "bin", name)),
      }));
      const before = links();
      for (const outcome of ["success", "nonzero", "throw", "cleanup-error"]) {
        assertMetadataInvocationUmask(context, fixture, callerUmask, outcome);
        assert.deepEqual(links(), before);
      }
      fs.unlinkSync(join(node, "bin/npm"));
      fs.symlinkSync("../lib/node_modules/npm/bin/npx-cli.js", join(node, "bin/npm"));
      assert.throws(() => runPnpm({ ...fixture, platform, args: ["--version"] }), /symlink-target:bin\/npm/u);
      assert.equal(process.umask(), callerUmask);
    });
  }
}

function customizeMetadataWriter(fixture) {
  const artifact = fixture.lock.tools.node.platforms[platform];
  const node = join(fixture.root, "node-payload", artifact.installDirectory);
  const npmBin = join(node, "lib/node_modules/npm/bin");
  fs.mkdirSync(npmBin, { recursive: true });
  fs.unlinkSync(join(node, "bin/npm"));
  for (const name of ["npm", "npx"]) {
    fs.writeFileSync(join(npmBin, `${name}-cli.js`), "#!/usr/bin/env node\n", { mode: 0o755 });
    fs.symlinkSync(`../lib/node_modules/npm/bin/${name}-cli.js`, join(node, "bin", name));
  }
  const pnpmRoot = join(fixture.root, "pnpm-payload/package");
  fs.writeFileSync(join(pnpmRoot, "dist/pnpm.mjs"), `import fs from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--metadata-probe')) {
  const cache = process.argv.find((arg) => arg.startsWith('--config.cache-dir=')).split('=')[1];
  fs.mkdirSync(join(cache, 'child'), { recursive: true });
  fs.writeFileSync(join(cache, 'child/metadata.json'), JSON.stringify({ umask: process.umask() }));
  fs.writeFileSync(join(process.env.HOME, 'child-metadata'), 'private invocation data');
  if (process.argv.includes('--metadata-nonzero')) { process.exitCode = 7; }
} else { process.stdout.write('11.24.0\\n'); }
`);
  for (const [entry, root, leaf] of [[artifact, join(fixture.root, "node-payload"), artifact.installDirectory],
    [fixture.lock.tools.pnpm, dirname(pnpmRoot), "package"]]) {
    const archive = join(fixture.root, "artifacts", entry.archiveName);
    execFileSync("/usr/bin/tar", ["-czf", archive, "-C", root, leaf]);
    entry.sha256 = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  }
}

function assertMetadataInvocationUmask(context, fixture, callerUmask, outcome) {
  const spawn = childProcess.spawnSync;
  const extractions = [];
  const invocations = [];
  const cleanups = [];
  let childRan = false;
  let privateRoot;
  childProcess.spawnSync = (command, args, options) => {
    if (command === "/usr/bin/tar" && args.includes("/dev/fd/3")) {
      // Observe real extraction, including both nested Node authentications.
      // Linux symlinks always use 0777, so check the actual extraction boundary.
      extractions.push(process.umask());
    }
    if (args[1] === "--agtmai-toolchain-process-supervisor") {
      const config = JSON.parse(Buffer.from(args[2], "base64url").toString());
      if (config.args.includes("--metadata-probe")) {
        invocations.push(process.umask());
        privateRoot = dirname(options.env.HOME);
        if (outcome === "throw") {throw new Error("injected pnpm spawn failure");}
        const result = spawn(command, args, options);
        childRan = true;
        return result;
      }
    }
    return spawn(command, args, options);
  };
  const observation = observeConsumerDescriptors({
    closeTarget(record) {
      if (!record.identity.isDirectory() || !basename(record.path).startsWith(".install-part-")) {return false;}
      cleanups.push(process.umask());
      return childRan && outcome === "cleanup-error";
    },
  });
  try {
    const run = () => runPnpm({ ...fixture, platform, args: ["--metadata-probe",
      ...(outcome === "nonzero" ? ["--metadata-nonzero"] : [])] });
    if (outcome === "throw") {assert.throws(run, /injected pnpm spawn failure/u);}
    else if (outcome === "cleanup-error") {
      assert.throws(run, /TOOLCHAIN_RUN_CLEANUP_FAILED/u);
      assert.ok(observation.state.closeErrors.length > 0);
    } else {assert.equal(run(), outcome === "nonzero" ? 7 : 0);}
    assert.equal(process.umask(), callerUmask);
    assert.ok(extractions.length >= 5, "core and nested Node archives were re-extracted");
    assert.deepEqual([...new Set(extractions)], [callerUmask]);
    assert.deepEqual(invocations, [0o077]);
    assert.ok(cleanups.length >= 5, "nested and outer prepared authorities were released");
    assert.deepEqual([...new Set(cleanups)], [callerUmask]);
    observation.restore();
    observation.assertReleased();
    if (childRan) {
      const cache = join(fixture.toolsRoot, "pnpm-store/metadata-cache");
      assert.equal(fs.statSync(join(cache, "child")).mode & 0o777, 0o700);
      assert.equal(fs.statSync(join(cache, "child/metadata.json")).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(fs.readFileSync(join(cache, "child/metadata.json"))), { umask: 0o077 });
      fs.rmSync(join(cache, "child"), { recursive: true });
      assert.equal(fs.existsSync(privateRoot), false, "private child metadata was cleaned up");
    }
    assert.deepEqual(fs.readdirSync(fixture.toolsRoot).filter((name) => name.startsWith(".install-part-")), []);
  } finally {
    childProcess.spawnSync = spawn;
    observation.restore();
    syncBuiltinESMExports();
    observation.cleanupLeakedTestDescriptors();
    // A pre-spawn exception intentionally leaves an unproven invocation behind.
    // No child started; this test owns that directory and can remove it.
    if (privateRoot) {context.after(() => fs.rmSync(privateRoot, { recursive: true, force: true }));}
  }
}
