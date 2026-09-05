import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { hasAsciiControlCharacter, PinnedToolResolver } from "../src/adapters/toolchain.ts";
import { LocalSolanaError } from "../src/domain/model.ts";
import type { CommandPort, CommandResult, ToolLease, ToolResolutionRequest } from "../src/application/ports.ts";

interface MutableToolchainLock {
  tools: {
    agave: { platforms: Record<string, { installDirectory: string }> };
    splPrograms: {
      token: { path: string };
      associatedToken: { path: string };
    };
  };
}

type LockMutation = (lock: MutableToolchainLock, platform: string) => void;

class FakeCommand implements CommandPort {
  public readonly calls: string[] = [];
  public async run(executable: string): Promise<CommandResult> {
    this.calls.push(executable);
    const name = executable.split("/").at(-1) ?? "";
    const command = name.endsWith("-spl-token") ? "spl-token" : name.endsWith("-solana-keygen") ? "solana-keygen"
      : name.endsWith("-solana-test-validator") ? "solana-test-validator" : "solana";
    const stdout = command === "spl-token" ? "spl-token-cli 5.6.1\n" : `${command === "solana" ? "solana-cli" : command} 4.2.1 (src:fixture; feat:fixture, client:Agave)\n`;
    return { stdout, stderr: "", exitCode: 0 };
  }
}

async function fixture(): Promise<{ readonly root: string; readonly binaries: Record<string, string>; readonly programs: Record<string, string>; readonly command: FakeCommand; readonly request: ToolResolutionRequest; readonly leases: ToolLease[] }> {
  const root = await mkdtemp(join(tmpdir(), "agtmai-tools-")); const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64"; const install = `agave-v4.2.1-${platform}`;
  const bin = join(root, ".tools", install, "bin"); await mkdir(bin, { recursive: true, mode: 0o700 }); await mkdir(join(root, "tooling"), { mode: 0o700 });
  const names = ["solana", "solana-keygen", "solana-test-validator", "spl-token"] as const; const binaries: Record<string, string> = {}; const hashes: Record<string, string> = {};
  for (const name of names) { const path = join(bin, name); const bytes = `fixture-${name}`; await writeFile(path, bytes, { mode: 0o700 }); binaries[name] = path; hashes[`bin/${name}`] = createHash("sha256").update(bytes).digest("hex"); }
  const programDirectory = join(root, "tooling/local-solana/programs"); await mkdir(programDirectory, { recursive: true, mode: 0o700 });
  const programs = { token: join(programDirectory, "spl_token-v9.0.0.so"), associatedToken: join(programDirectory, "spl_associated_token_account-v8.0.0.so") };
  const programBytes = { token: "fixture-token-program", associatedToken: "fixture-associated-token-program" };
  await writeFile(programs.token, programBytes.token); await writeFile(programs.associatedToken, programBytes.associatedToken);
  const archiveName = platform === "linux-x64" ? "solana-release-x86_64-unknown-linux-gnu.tar.bz2" : "solana-release-aarch64-apple-darwin.tar.bz2";
  const artifact = { url: `https://github.com/anza-xyz/agave/releases/download/v4.2.1/${archiveName}`, sha256: "a".repeat(64), archive: "tar.bz2", archiveName, installDirectory: install, expectedFiles: names.map((name) => `bin/${name}`), expectedFileSha256: hashes };
  await writeFile(join(root, "tooling/toolchain.lock.json"), JSON.stringify({ tools: {
    agave: { version: "4.2.1", splTokenVersion: "5.6.1", platforms: { [platform]: artifact } },
    splPrograms: {
      token: { version: "9.0.0", commit: "dfb260231c761be7d9c8b63728e770a102b86495", source: "https://github.com/solana-program/token", path: "tooling/local-solana/programs/spl_token-v9.0.0.so", sha256: createHash("sha256").update(programBytes.token).digest("hex") },
      associatedToken: { version: "8.0.0", commit: "0b867b5340cd001e5980d8ca7928effc4e10015c", source: "https://github.com/solana-program/associated-token-account", path: "tooling/local-solana/programs/spl_associated_token_account-v8.0.0.so", sha256: createHash("sha256").update(programBytes.associatedToken).digest("hex") },
    },
  } }));
  const directory = join(await realpath(root), "run"); await mkdir(directory, { mode: 0o700 });
  const identity = await lstat(directory, { bigint: true });
  const rootIdentity = await lstat(root, { bigint: true });
  const leases: ToolLease[] = [];
  const request = { run: { directory, directoryIdentity: { dev: String(identity.dev), ino: String(identity.ino) }, rootIdentity: { dev: String(rootIdentity.dev), ino: String(rootIdentity.ino) } }, own: (lease: ToolLease) => { leases.push(lease); } };
  return { root, binaries, programs, command: new FakeCommand(), request, leases };
}

test("pinned resolver ignores hostile PATH and accepts warm verified binaries", async () => {
  const value = await fixture(); const original = process.env.PATH; process.env.PATH = "/hostile/decoy";
  try {
    const install = dirname(dirname(value.binaries.solana));
    const before = await inventory(install);
    const installStat = await lstat(install, { bigint: true });
    const paths = await new PinnedToolResolver(value.root, value.command).resolve(value.request);
    for (const path of Object.values(paths)) { assert.equal(path.startsWith(`${await realpath(value.root)}/.authenticated-tools-`), true); }
    assert.equal(value.command.calls.every((path) => Object.values(paths).includes(path)), true);
    assert.deepEqual(await inventory(install), before, "resolution must not change immutable installation inventory or metadata");
    assert.equal(value.leases.length, 1);
    await value.leases[0]!.close(); await value.leases[0]!.close();
    assert.deepEqual(await snapshotNames(value.root), []);
    assert.deepEqual(await inventory(install), before);
    const after = await lstat(install, { bigint: true });
    assert.equal(after.mtimeNs, installStat.mtimeNs); assert.equal(after.ctimeNs, installStat.ctimeNs);

  }
  finally { process.env.PATH = original; await rm(value.root, { recursive: true, force: true }); }
});

test("pinned resolver rejects cold, tampered and symlinked binaries without fallback", async () => {
  const cold = await fixture(); try { await rm(cold.binaries.solana); await assert.rejects(new PinnedToolResolver(cold.root, cold.command).resolve(cold.request), /SOLANA_TOOL_MISSING/u); } finally { await rm(cold.root, { recursive: true, force: true }); }
  const tampered = await fixture(); try { await writeFile(tampered.binaries.solana, "tampered"); await assert.rejects(new PinnedToolResolver(tampered.root, tampered.command).resolve(tampered.request), /SOLANA_TOOL_HASH/u); } finally { await rm(tampered.root, { recursive: true, force: true }); }
  const linked = await fixture(); try { const target = `${linked.binaries.solana}.target`; await writeFile(target, "fixture-solana"); await rm(linked.binaries.solana); await symlink(target, linked.binaries.solana); await assert.rejects(new PinnedToolResolver(linked.root, linked.command).resolve(linked.request), /SOLANA_TOOL_MISSING/u); } finally { await rm(linked.root, { recursive: true, force: true }); }
});

test("partial authenticated snapshot failure preserves validation error and removes fallback", async () => {
  const value = await fixture();
  try {
    await writeFile(value.binaries["solana-keygen"], "tampered");
    await assert.rejects(new PinnedToolResolver(value.root, value.command).resolve(value.request), /SOLANA_TOOL_HASH: keygen binary hash mismatch/u);
    const install = dirname(dirname(value.binaries.solana));
    assert.deepEqual((await readdir(install)).filter((name) => name.startsWith(".authenticated-tools-")), []);
    assert.deepEqual(value.command.calls, []);
    assert.deepEqual(await snapshotNames(value.root), []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});


test("mutated Agave install and SPL program paths fail before command execution", async () => {
  for (const mutation of [
    (lock, platform) => { lock.tools.agave.platforms[platform].installDirectory = "../agave"; },
    (lock) => { lock.tools.splPrograms.token.path = "/tmp/program.so"; },
    (lock) => { lock.tools.splPrograms.associatedToken.path = "tooling/local-solana/programs/../escape.so"; },
  ] as LockMutation[]) {
    const value = await fixture();
    try {
      const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
      const lockPath = join(value.root, "tooling/toolchain.lock.json");
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as MutableToolchainLock;
      mutation(lock, platform);
      await writeFile(lockPath, JSON.stringify(lock));
      await assert.rejects(new PinnedToolResolver(value.root, value.command).resolve(value.request), /SOLANA_(?:TOOL_ARCHIVE_PIN|PROGRAM_PIN)/u);
      assert.deepEqual(value.command.calls, []);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});

test("ASCII control validation covers control and printable boundaries", () => {
  for (const code of [0, 31, 127]) { assert.equal(hasAsciiControlCharacter(String.fromCharCode(code)), true); }
  for (const code of [32, 126, 128]) { assert.equal(hasAsciiControlCharacter(String.fromCharCode(code)), false); }
});

async function inventory(directory: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const name of (await readdir(directory)).toSorted()) {
    const path = join(directory, name); const entry = await lstat(path, { bigint: true });
    entries.push({ name, dev: entry.dev, ino: entry.ino, mode: entry.mode, size: entry.size, mtime: entry.mtimeNs, ctime: entry.ctimeNs,
      content: entry.isDirectory() ? await inventory(path) : await readFile(path, "utf8") });
  }
  return entries;
}

test("version mismatch and command rejection close exactly the acquired snapshots", async () => {
  for (const reject of [false, true]) {
    const value = await fixture(); const primary = new Error("synthetic version command failure");
    try {
      const before = await inventory(dirname(dirname(value.binaries.solana)));
      await writeFile(join(value.request.run.directory, "foreign"), "retain");
      let calls = 0;
      const commands = { async run() { calls += 1; if (reject) { throw primary; } return { stdout: "wrong version", stderr: "", exitCode: 0 }; } };
      await assert.rejects(new PinnedToolResolver(value.root, commands).resolve(value.request), reject ? (cause) => cause === primary : /SOLANA_TOOL_VERSION/u);
      assert.equal(calls, 1);
      assert.deepEqual(await readdir(value.request.run.directory), ["foreign"]);
      assert.deepEqual(await snapshotNames(value.root), []);
      assert.deepEqual(await inventory(dirname(dirname(value.binaries.solana))), before);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});

test("concurrent resolutions have isolated lifetimes within the same run", async () => {
  const value = await fixture();
  try {
    const resolver = new PinnedToolResolver(value.root, value.command);
    const [first, second] = await Promise.all([resolver.resolve(value.request), resolver.resolve(value.request)]);
    assert.notEqual(dirname(first.solana), dirname(second.solana));
    await value.leases[0]!.close();
    const remaining = await snapshotNames(value.root);
    assert.equal(remaining.length, 1);
    const live = remaining[0] === dirname(first.solana).split("/").at(-1) ? first : second;
    assert.equal(await readFile(live.solana, "utf8"), "fixture-solana");
    await value.leases[1]!.close();
    assert.deepEqual(await snapshotNames(value.root), []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("cancellation during version verification closes all snapshots before rejection", async () => {
  const value = await fixture(); const controller = new AbortController();
  try {
    const commands: CommandPort = { async run(path, _args, options) { assert.equal(options?.signal, controller.signal); controller.abort(); return await value.command.run(path); } };
    await assert.rejects(new PinnedToolResolver(value.root, commands).resolve({ ...value.request, signal: controller.signal }), /SOLANA_COMMAND_ABORTED/u);
    assert.equal(value.command.calls.length, 1);
    assert.deepEqual(await snapshotNames(value.root), []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

for (const substitution of ["file", "symlink", "hardlink", "modified", "directory", "root", "extra"] as const) {
  test(`snapshot close retains ${substitution} substitution and rejects repeated close`, async () => {
    const value = await fixture(); const movedRoot = `${value.root}-moved`;
    try {
      const paths = await new PinnedToolResolver(value.root, value.command).resolve(value.request);
      const directory = dirname(paths.solana); const moved = join(value.root, "moved");
      let retained = paths.solana;
      if (substitution === "directory" || substitution === "root") {
        const target = substitution === "directory" ? directory : value.root;
        await rename(target, substitution === "root" ? movedRoot : moved); await mkdir(target, { mode: 0o700 });
        retained = join(target, "foreign"); await writeFile(retained, "foreign");
      } else if (substitution === "extra") {
        retained = join(directory, "foreign"); await writeFile(retained, "foreign");
      } else if (substitution === "modified") {
        await chmod(paths.solana, 0o700); await writeFile(paths.solana, "foreign"); await chmod(paths.solana, 0o500);
      } else {
        await rename(paths.solana, moved);
        if (substitution === "symlink") { await symlink(moved, paths.solana); }
        else if (substitution === "hardlink") { await link(moved, paths.solana); }
        else { await writeFile(paths.solana, "foreign", { mode: 0o500 }); }
      }
      const close = value.leases[0]!.close();
      await assert.rejects(close, /SOLANA_TOOL_SNAPSHOT_IDENTITY/u);
      assert.equal(value.leases[0]!.close(), close, "a failed close is terminal");
      await assert.rejects(value.leases[0]!.close(), /SOLANA_TOOL_SNAPSHOT_IDENTITY/u);
      await lstat(retained);
      if (substitution !== "directory" && substitution !== "root") { assert.equal(await readFile(paths.keygen, "utf8"), "fixture-solana-keygen"); }
    } finally { await rm(value.root, { recursive: true, force: true }); await rm(movedRoot, { recursive: true, force: true }); }
  });
}

test("version failure remains primary when snapshot cleanup detects substitution", async () => {
  const value = await fixture(); const primary = new Error("primary version failure"); let retained = "";
  try {
    const commands: CommandPort = { async run(path) {
      retained = join(dirname(path), "foreign"); await writeFile(retained, "retain"); throw primary;
    } };
    await assert.rejects(new PinnedToolResolver(value.root, commands).resolve(value.request), (cause) => {
      assert.ok(cause instanceof AggregateError); assert.equal(cause.cause, primary); assert.equal(cause.errors[0], primary);
      assert.match(String(cause.errors[1]), /SOLANA_TOOL_SNAPSHOT_IDENTITY/u); return true;
    });
    assert.equal(await readFile(retained, "utf8"), "retain");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("a late program hash failure removes all already authenticated binary snapshots", async () => {
  const value = await fixture();
  try {
    await writeFile(value.programs.associatedToken, "tampered late source");
    await assert.rejects(new PinnedToolResolver(value.root, value.command).resolve(value.request), /SOLANA_TOOL_HASH: associatedTokenProgram binary hash mismatch/u);
    assert.deepEqual(await snapshotNames(value.root), []); assert.deepEqual(value.command.calls, []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("commands use authenticated snapshot bytes even if original sources change afterwards", async () => {
  const value = await fixture(); let calls = 0;
  try {
    const command: CommandPort = { async run(path) {
      calls += 1;
      if (calls === 1) { await writeFile(value.binaries.solana, "changed original source"); }
      assert.match(await readFile(path, "utf8"), /^fixture-/u);
      return await value.command.run(path);
    } };
    const paths = await new PinnedToolResolver(value.root, command).resolve(value.request);
    assert.equal(await readFile(paths.solana, "utf8"), "fixture-solana");
    assert.equal(calls, 4); await value.leases[0]!.close();
    assert.deepEqual(await snapshotNames(value.root), []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

async function snapshotNames(root: string): Promise<string[]> { return (await readdir(root)).filter((name) => name.startsWith(".authenticated-tools-")); }

test("resolver rejects snapshot storage inside the pinned tools tree before acquisition", async () => {
  for (const underInstall of [true, false]) {
    const value = await fixture();
    try {
      const install = dirname(dirname(value.binaries.solana));
      const root = underInstall ? install : dirname(install);
      const directory = join(root, "synthetic-run"); await mkdir(directory, { mode: 0o700 });
      const rootEntry = await lstat(root, { bigint: true }); const entry = await lstat(directory, { bigint: true });
      const request = { ...value.request, run: {
        directory, directoryIdentity: { dev: String(entry.dev), ino: String(entry.ino) },
        rootIdentity: { dev: String(rootEntry.dev), ino: String(rootEntry.ino) },
      } };
      const before = await inventory(root);
      await assert.rejects(new PinnedToolResolver(value.root, value.command).resolve(request), /SOLANA_TOOL_SNAPSHOT_LOCATION/u);
      assert.deepEqual(await inventory(root), before);
      assert.deepEqual(value.command.calls, []); assert.equal(value.leases.length, 0);
    } finally {
      for (const lease of value.leases) { await lease.close(); }
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("version command with unconfirmed termination retains every snapshot until the owner can close", async () => {
  const value = await fixture(); let executable = "";
  const primary = new LocalSolanaError("SOLANA_CHILD_STOP_TIMEOUT", "synthetic command still using snapshots");
  try {
    const commands: CommandPort = { async run(path) { executable = path; throw primary; } };
    await assert.rejects(new PinnedToolResolver(value.root, commands).resolve(value.request), (cause) => cause === primary);
    assert.equal(await readFile(executable, "utf8"), "fixture-solana");
    assert.equal((await readdir(dirname(executable))).length, 6);
    await value.leases[0]!.close();
    assert.deepEqual(await snapshotNames(value.root), []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
