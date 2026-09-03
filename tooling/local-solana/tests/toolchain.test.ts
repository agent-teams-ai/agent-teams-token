import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PinnedToolResolver } from "../src/adapters/toolchain.ts";
import type { CommandPort, CommandResult } from "../src/application/ports.ts";

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

async function fixture(): Promise<{ readonly root: string; readonly binaries: Record<string, string>; readonly programs: Record<string, string>; readonly command: FakeCommand }> {
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
  return { root, binaries, programs, command: new FakeCommand() };
}

test("pinned resolver ignores hostile PATH and accepts warm verified binaries", async () => {
  const value = await fixture(); const original = process.env.PATH; process.env.PATH = "/hostile/decoy";
  try {
    const root = await realpath(value.root);
    const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
    const paths = await new PinnedToolResolver(value.root, value.command).resolve();
    assert.equal(paths.splToken.startsWith(`${root}/.tools/agave-v4.2.1-${platform}/.authenticated-tools-`), true);
    assert.equal(paths.tokenProgram.startsWith(`${root}/.tools/agave-v4.2.1-${platform}/.authenticated-tools-`), true);
    assert.equal(paths.associatedTokenProgram.startsWith(`${root}/.tools/agave-v4.2.1-${platform}/.authenticated-tools-`), true);
    assert.equal(value.command.calls.every((path) => path.startsWith(`${root}/.tools/agave-v4.2.1-${platform}/`)), true);
  }
  finally { process.env.PATH = original; await rm(value.root, { recursive: true, force: true }); }
});

test("pinned resolver rejects cold, tampered and symlinked binaries without fallback", async () => {
  const cold = await fixture(); try { await rm(cold.binaries.solana); await assert.rejects(new PinnedToolResolver(cold.root, cold.command).resolve(), /SOLANA_TOOL_MISSING/u); } finally { await rm(cold.root, { recursive: true, force: true }); }
  const tampered = await fixture(); try { await writeFile(tampered.binaries.solana, "tampered"); await assert.rejects(new PinnedToolResolver(tampered.root, tampered.command).resolve(), /SOLANA_TOOL_HASH/u); } finally { await rm(tampered.root, { recursive: true, force: true }); }
  const linked = await fixture(); try { const target = `${linked.binaries.solana}.target`; await writeFile(target, "fixture-solana"); await rm(linked.binaries.solana); await symlink(target, linked.binaries.solana); await assert.rejects(new PinnedToolResolver(linked.root, linked.command).resolve(), /SOLANA_TOOL_MISSING/u); } finally { await rm(linked.root, { recursive: true, force: true }); }
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
      await assert.rejects(new PinnedToolResolver(value.root, value.command).resolve(), /SOLANA_(?:TOOL_ARCHIVE_PIN|PROGRAM_PIN)/u);
      assert.deepEqual(value.command.calls, []);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});
