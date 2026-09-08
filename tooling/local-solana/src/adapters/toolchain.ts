import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LocalSolanaError } from "../domain/model.ts";
import { object, string } from "./rpc-parsers.ts";
import type { CommandPort, ToolPaths, ToolResolutionRequest, ToolResolverPort } from "../application/ports.ts";

import { AuthenticatedToolSnapshots, stableRead, throwErrors } from "./tool-snapshots.ts";

const EXPECTED_EXECUTABLES = ["bin/solana", "bin/solana-keygen", "bin/solana-test-validator", "bin/spl-token"] as const;

export class PinnedToolResolver implements ToolResolverPort {
  private readonly repositoryRoot: string;
  private readonly commands: CommandPort;
  public constructor(repositoryRoot: string, commands: CommandPort) { this.repositoryRoot = repositoryRoot; this.commands = commands; }
  public async resolve(request: ToolResolutionRequest): Promise<ToolPaths> {
    const repositoryRoot = await trustedRepositoryRoot(this.repositoryRoot);
    const lock = object(JSON.parse((await stableRead(join(repositoryRoot, "tooling/toolchain.lock.json"))).toString("utf8")), "toolchain lock");
    const tools = object(lock.tools, "toolchain tools");
    const agave = object(tools.agave, "Agave pin");
    if (agave.version !== "4.2.1" || agave.splTokenVersion !== "5.6.1") { throw new LocalSolanaError("SOLANA_TOOL_VERSION_PIN", "expected exact Agave 4.2.1 and SPL 5.6.1 pins"); }
    const platform = supportedPlatform();
    const artifact = object(object(agave.platforms, "Agave platforms")[platform], "Agave artifact");
    assertArtifactPin(artifact, platform);
    const toolsRoot = join(repositoryRoot, ".tools");
    await assertDirectory(toolsRoot, "SOLANA_TOOLS_ROOT");
    const install = contained(toolsRoot, string(artifact.installDirectory, "install directory"), "SOLANA_TOOL_INSTALL_PATH");
    await assertDirectory(install, "SOLANA_TOOL_INSTALL_PATH");
    const hashes = object(artifact.expectedFileSha256, "binary hashes");
    const programs = object(tools.splPrograms, "SPL program pins");
    const token = object(programs.token, "SPL Token program pin");
    const associated = object(programs.associatedToken, "associated token program pin");
    assertProgramPin(token, "9.0.0", "dfb260231c761be7d9c8b63728e770a102b86495", "https://github.com/solana-program/token", "tooling/local-solana/programs/spl_token-v9.0.0.so");
    assertProgramPin(associated, "8.0.0", "0b867b5340cd001e5980d8ca7928effc4e10015c", "https://github.com/solana-program/associated-token-account", "tooling/local-solana/programs/spl_associated_token_account-v8.0.0.so");
    const sources = {
      solana: { path: contained(install, "bin/solana", "SOLANA_TOOL_PATH"), hash: hashes["bin/solana"] },
      keygen: { path: contained(install, "bin/solana-keygen", "SOLANA_TOOL_PATH"), hash: hashes["bin/solana-keygen"] },
      validator: { path: contained(install, "bin/solana-test-validator", "SOLANA_TOOL_PATH"), hash: hashes["bin/solana-test-validator"] },
      splToken: { path: contained(install, "bin/spl-token", "SOLANA_TOOL_PATH"), hash: hashes["bin/spl-token"] },
      tokenProgram: { path: contained(repositoryRoot, string(token.path, "SPL Token program path"), "SOLANA_PROGRAM_PIN"), hash: token.sha256 },
      associatedTokenProgram: { path: contained(repositoryRoot, string(associated.path, "associated token program path"), "SOLANA_PROGRAM_PIN"), hash: associated.sha256 },
    };
    assertSnapshotLocation(toolsRoot, request.run.directory);
    const snapshots = new AuthenticatedToolSnapshots(request.run);
    request.own(snapshots);
    try {
      const paths = await snapshots.create(sources, request.signal);
      await verifyVersions(paths, this.commands, request.signal);
      return paths;
    } catch (cause) {
      // A command adapter's unconfirmed stop must retain files still in use.
      if (unconfirmedToolUser(cause)) { throw cause; }
      const errors = [cause];
      try { await snapshots.close(); } catch (cleanupCause) { errors.push(cleanupCause); }
      throwErrors(errors, "authenticated snapshots could not be closed");
      throw cause;
    }
  }
}

function assertSnapshotLocation(toolsRoot: string, runDirectory: string): void {
  const location = relative(toolsRoot, resolve(dirname(runDirectory)));
  if (location === "" || (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`))) {
    throw new LocalSolanaError("SOLANA_TOOL_SNAPSHOT_LOCATION", "authenticated snapshots must be outside the pinned tools tree");
  }
}

function assertProgramPin(value: Record<string, unknown>, version: string, commit: string, source: string, path: string): void {
  if (value.version !== version || value.commit !== commit || value.source !== source || value.path !== path
    || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new LocalSolanaError("SOLANA_PROGRAM_PIN", "SPL program source, revision, path or hash is not exact");
  }
  contained("/program-root", path, "SOLANA_PROGRAM_PIN");
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

function assertArtifactPin(artifact: Record<string, unknown>, platform: "linux-x64" | "darwin-arm64"): void {
  const url = string(artifact.url, "Agave URL");
  const hash = string(artifact.sha256, "archive hash");
  const expectedInstall = `agave-v4.2.1-${platform}`;
  const expectedArchive = platform === "linux-x64" ? "solana-release-x86_64-unknown-linux-gnu.tar.bz2" : "solana-release-aarch64-apple-darwin.tar.bz2";
  const expectedUrl = `https://github.com/anza-xyz/agave/releases/download/v4.2.1/${expectedArchive}`;
  if (artifact.archive !== "tar.bz2" || artifact.installDirectory !== expectedInstall || artifact.archiveName !== expectedArchive
    || url !== expectedUrl || !/^[a-f0-9]{64}$/u.test(hash)
    || JSON.stringify(artifact.expectedFiles) !== JSON.stringify(EXPECTED_EXECUTABLES)
    || !validExpectedHashes(artifact.expectedFileSha256)) {
    throw new LocalSolanaError("SOLANA_TOOL_ARCHIVE_PIN", "Agave archive and executable pins are not exact");
  }
}

function validExpectedHashes(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { return false; }
  const hashes = value as Record<string, unknown>;
  return JSON.stringify(Object.keys(hashes)) === JSON.stringify(EXPECTED_EXECUTABLES)
    && EXPECTED_EXECUTABLES.every((path) => typeof hashes[path] === "string" && /^[a-f0-9]{64}$/u.test(hashes[path] as string));
}

async function assertDirectory(path: string, code: string): Promise<void> {
  const entry = await lstat(path).catch(() => null);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) { throw new LocalSolanaError(code, "toolchain directory is absent or substituted"); }
}

function contained(root: string, value: string, code: string): string {
  if (value.length === 0 || hasAsciiControlCharacter(value) || value.includes("\\") || isAbsolute(value)
    || value.split("/").some((part) => part === "" || part === "." || part === ".." || part.startsWith("-"))) {
    throw new LocalSolanaError(code, "toolchain path is not a safe relative path");
  }
  const target = resolve(root, value);
  const fromRoot = relative(resolve(root), target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new LocalSolanaError(code, "toolchain path escapes its trusted root");
  }
  return target;
}

export function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) { return true; }
  }
  return false;
}

async function verifyVersions(paths: ToolPaths, commands: CommandPort, signal?: AbortSignal): Promise<void> {
  const env = { HOME: "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "" };
  const expectations = [[paths.solana, /^solana-cli 4\.2\.1 /u], [paths.keygen, /^solana-keygen 4\.2\.1 /u], [paths.validator, /^solana-test-validator 4\.2\.1 /u], [paths.splToken, /^spl-token-cli 5\.6\.1\s*$/u]] as const;
  for (const [path, expected] of expectations) {
    if (signal?.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "tool resolution interrupted"); }
    const result = await commands.run(path, ["--version"], { env, timeoutMs: 10_000, signal });
    if (signal?.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "tool resolution interrupted"); }
    if (result.exitCode !== 0 || !expected.test(result.stdout)) { throw new LocalSolanaError("SOLANA_TOOL_VERSION", `${path.split("/").at(-1)} version mismatch`); }
  }
}

function unconfirmedToolUser(cause: unknown): boolean {
  if (cause instanceof AggregateError) { return cause.errors.some(unconfirmedToolUser); }
  return cause instanceof LocalSolanaError && ["SOLANA_CHILD_STOP_TIMEOUT", "SOLANA_CHILD_IDENTITY"].includes(cause.code);
}
