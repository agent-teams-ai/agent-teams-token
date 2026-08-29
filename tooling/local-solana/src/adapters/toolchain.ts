import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LocalSolanaError } from "../domain/model.ts";
import { object, string } from "./rpc-parsers.ts";
import type { CommandPort, ToolPaths, ToolResolverPort } from "../application/ports.ts";

export class PinnedToolResolver implements ToolResolverPort {
  private readonly repositoryRoot: string;
  private readonly commands: CommandPort;
  public constructor(repositoryRoot: string, commands: CommandPort) { this.repositoryRoot = repositoryRoot; this.commands = commands; }
  public async resolve(): Promise<ToolPaths> {
    const repositoryRoot = await trustedRepositoryRoot(this.repositoryRoot);
    const lockPath = join(repositoryRoot, "tooling/toolchain.lock.json");
    const lock = object(JSON.parse(await readFile(lockPath, "utf8")), "toolchain lock");
    const tools = object(lock.tools, "toolchain tools");
    const agave = object(tools.agave, "Agave pin");
    if (agave.version !== "4.2.1" || agave.splTokenVersion !== "5.6.1") { throw new LocalSolanaError("SOLANA_TOOL_VERSION_PIN", "expected exact Agave 4.2.1 and SPL 5.6.1 pins"); }
    const platform = supportedPlatform();
    const artifact = object(object(agave.platforms, "Agave platforms")[platform], "Agave artifact");
    assertArtifactPin(artifact);
    const install = resolve(repositoryRoot, ".tools", string(artifact.installDirectory, "install directory"));
    const hashes = object(artifact.expectedFileSha256, "binary hashes");
    const programs = object(tools.splPrograms, "SPL program pins");
    const token = object(programs.token, "SPL Token program pin");
    const associated = object(programs.associatedToken, "associated token program pin");
    assertProgramPin(token, "9.0.0", "dfb260231c761be7d9c8b63728e770a102b86495", "https://github.com/solana-program/token");
    assertProgramPin(associated, "8.0.0", "0b867b5340cd001e5980d8ca7928effc4e10015c", "https://github.com/solana-program/associated-token-account");
    const paths: ToolPaths = {
      solana: join(install, "bin/solana"), keygen: join(install, "bin/solana-keygen"),
      validator: join(install, "bin/solana-test-validator"), splToken: join(install, "bin/spl-token"),
      tokenProgram: resolve(repositoryRoot, string(token.path, "SPL Token program path")),
      associatedTokenProgram: resolve(repositoryRoot, string(associated.path, "associated token program path")),
    };
    const executables = [["solana", paths.solana, "bin/solana"], ["keygen", paths.keygen, "bin/solana-keygen"], ["validator", paths.validator, "bin/solana-test-validator"], ["splToken", paths.splToken, "bin/spl-token"]] as const;
    for (const [name, path, relative] of executables) { await verifyFile(name, path, hashes[relative]); }
    await verifyFile("tokenProgram", paths.tokenProgram, token.sha256);
    await verifyFile("associatedTokenProgram", paths.associatedTokenProgram, associated.sha256);
    await verifyVersions(paths, this.commands);
    return paths;
  }
}

function assertProgramPin(value: Record<string, unknown>, version: string, commit: string, source: string): void {
  if (value.version !== version || value.commit !== commit || value.source !== source
    || typeof value.path !== "string" || !value.path.startsWith("tooling/local-solana/programs/")
    || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new LocalSolanaError("SOLANA_PROGRAM_PIN", "SPL program source, revision, path or hash is not exact");
  }
}

async function trustedRepositoryRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  const entry = await lstat(absolute).catch(() => null);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) { throw new LocalSolanaError("SOLANA_REPOSITORY_ROOT", "repository root is absent or substituted"); }
  return await realpath(absolute);
}

function supportedPlatform(): "linux-x64" | "darwin-arm64" {
  if (process.platform === "linux" && process.arch === "x64") { return "linux-x64"; }
  if (process.platform === "darwin" && process.arch === "arm64") { return "darwin-arm64"; }
  throw new LocalSolanaError("SOLANA_TOOL_PLATFORM", "supported platforms are linux-x64 and darwin-arm64");
}

function assertArtifactPin(artifact: Record<string, unknown>): void {
  const url = string(artifact.url, "Agave URL");
  const hash = string(artifact.sha256, "archive hash");
  if (artifact.archive !== "tar.bz2" || !url.startsWith("https://github.com/anza-xyz/agave/releases/download/v4.2.1/") || !/^[a-f0-9]{64}$/u.test(hash)) {
    throw new LocalSolanaError("SOLANA_TOOL_ARCHIVE_PIN", "Agave archive pin is not immutable");
  }
}

async function verifyFile(name: string, path: string, expectedHash: unknown): Promise<void> {
  const entry = await lstat(path).catch(() => null);
  if (!entry?.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || await realpath(path) !== path) {
    throw new LocalSolanaError("SOLANA_TOOL_MISSING", `${name} is absent or substituted`);
  }
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== expectedHash) { throw new LocalSolanaError("SOLANA_TOOL_HASH", `${name} binary hash mismatch`); }
}

async function verifyVersions(paths: ToolPaths, commands: CommandPort): Promise<void> {
  const env = { HOME: "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" };
  const expectations = [[paths.solana, /^solana-cli 4\.2\.1 /u], [paths.keygen, /^solana-keygen 4\.2\.1 /u], [paths.validator, /^solana-test-validator 4\.2\.1 /u], [paths.splToken, /^spl-token-cli 5\.6\.1\s*$/u]] as const;
  for (const [path, expected] of expectations) {
    const result = await commands.run(path, ["--version"], { env, timeoutMs: 10_000 });
    if (result.exitCode !== 0 || !expected.test(result.stdout)) { throw new LocalSolanaError("SOLANA_TOOL_VERSION", `${path.split("/").at(-1)} version mismatch`); }
  }
}
