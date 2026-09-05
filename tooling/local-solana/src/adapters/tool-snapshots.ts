import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FileIdentity, ToolLease, ToolPaths, ToolResolutionRequest } from "../application/ports.ts";
import { LocalSolanaError } from "../domain/model.ts";

export type ToolSources = Record<keyof ToolPaths, { readonly path: string; readonly hash: unknown }>;

/** One run's six snapshots. No discovery, recursive deletion or legacy recovery. */
export class AuthenticatedToolSnapshots implements ToolLease {
  private readonly run: ToolResolutionRequest["run"];
  private directory: { readonly path: string; identity: BigIntStats | undefined } | undefined;
  private rootFd: number | undefined;
  private directoryFd: number | undefined;
  private readonly files = new Map<string, BigIntStats>();
  private closing: Promise<void> | undefined;
  public constructor(run: ToolResolutionRequest["run"]) { this.run = run; }

  public async create(sources: ToolSources, signal?: AbortSignal): Promise<ToolPaths> {
    ensureActive(signal);
    if (this.rootFd !== undefined || this.directory !== undefined || this.closing !== undefined) { throw identityError(); }
    assertDirectory(this.run.directory, this.run.directoryIdentity);
    const root = dirname(this.run.directory);
    this.rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    assertDirectory(root, this.run.rootIdentity, this.rootFd);
    // A sibling lease stays outside both the immutable install and the run
    // store's recursive deletion/recovery authority over run-* directories.
    const path = mkdtempSync(join(root, ".authenticated-tools-"));
    this.directory = { path, identity: undefined };
    this.directoryFd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    this.directory.identity = fstatSync(this.directoryFd, { bigint: true });
    this.assertOwnedDirectory();
    const entries: Array<readonly [string, string]> = [];
    for (const [name, source] of Object.entries(sources)) {
      ensureActive(signal);
      if (typeof source.hash !== "string" || !/^[a-f0-9]{64}$/u.test(source.hash)) { throw new LocalSolanaError("SOLANA_TOOL_HASH", `${name} hash pin is invalid`); }
      const bytes = await stableRead(source.path);
      if (hash(bytes) !== source.hash) { throw new LocalSolanaError("SOLANA_TOOL_HASH", `${name} binary hash mismatch`); }
      ensureActive(signal);
      const target = this.write(`${name}-${basename(source.path)}`, bytes);
      if (hash(await stableRead(target)) !== source.hash) { throw new LocalSolanaError("SOLANA_TOOL_HASH", `${name} authenticated snapshot changed`); }
      entries.push([name, target]);
    }
    ensureActive(signal);
    return Object.fromEntries(entries) as unknown as ToolPaths;
  }

  public close(): Promise<void> {
    // A failed close is terminal: neither file descriptors nor uncertain objects
    // may be retried after an OS close could already have consumed ownership.
    this.closing ??= Promise.resolve().then(() => { this.finalize(); });
    return this.closing;
  }

  private finalize(): void {
    const errors: unknown[] = [];
    try { this.removeOwnedSnapshots(); } catch (cause) { errors.push(cause); }
    const handles = [this.directoryFd, this.rootFd];
    this.directoryFd = undefined; this.rootFd = undefined;
    for (const fd of handles) {
      if (fd !== undefined) { try { closeSync(fd); } catch (cause) { errors.push(cause); } }
    }
    throwErrors(errors, "authenticated snapshot cleanup or directory close failed");
  }

  private write(name: string, bytes: Buffer): string {
    const directory = this.assertOwnedDirectory();
    const target = join(directory, name);
    const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o700);
    const errors: unknown[] = [];
    try {
      this.files.set(name, fstatSync(fd, { bigint: true }));
      writeFileSync(fd, bytes); fchmodSync(fd, 0o500);
    } catch (cause) { errors.push(cause); }
    // Capture even a partially written owned file before releasing its handle.
    try { this.files.set(name, fstatSync(fd, { bigint: true })); } catch (cause) { errors.push(cause); }
    try { closeSync(fd); } catch (cause) { errors.push(cause); }
    throwErrors(errors, "authenticated snapshot write or close failed");
    return target;
  }

  private assertOwnedDirectory(): string {
    if (this.rootFd === undefined || this.directoryFd === undefined || this.directory?.identity === undefined) { throw identityError(); }
    assertDirectory(dirname(this.run.directory), this.run.rootIdentity, this.rootFd);
    assertDirectory(this.directory.path, this.directory.identity, this.directoryFd);
    return this.directory.path;
  }

  private removeOwnedSnapshots(): void {
    if (this.directory === undefined) { return; }
    const directory = this.assertOwnedDirectory();
    const names = readdirSync(directory);
    if (names.length !== this.files.size || names.some((name) => !this.files.has(name))) { throw identityError(); }
    // Validate the entire inventory before deleting any member. Synchronous
    // checks keep scheduled JS substitutions out of each final syscall window.
    for (const [name, expected] of this.files) { assertFile(join(directory, name), expected); }
    for (const [name, expected] of this.files) {
      this.assertOwnedDirectory();
      assertFile(join(directory, name), expected);
      unlinkSync(join(directory, name));
      this.files.delete(name);
    }
    this.assertOwnedDirectory();
    rmdirSync(directory);
    this.directory = undefined;
  }
}

function assertDirectory(path: string, expected: FileIdentity | BigIntStats, fd?: number): void {
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink() || !sameIdentity(entry, expected)
    || (entry.mode & 0o777n) !== 0o700n || !ownedUid(entry) || realpathSync(path) !== path) { throw identityError(); }
  if (fd !== undefined && !sameIdentity(fstatSync(fd, { bigint: true }), entry)) { throw identityError(); }
}

function assertFile(path: string, expected: BigIntStats): void {
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || !ownedUid(entry) || !sameMetadata(entry, expected)) { throw identityError(); }
}

function ownedUid(entry: BigIntStats): boolean { return process.getuid === undefined || entry.uid === BigInt(process.getuid()); }
function sameIdentity(entry: BigIntStats, expected: FileIdentity | BigIntStats): boolean { return String(entry.dev) === String(expected.dev) && String(entry.ino) === String(expected.ino); }
function sameMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function identityError(): LocalSolanaError { return new LocalSolanaError("SOLANA_TOOL_SNAPSHOT_IDENTITY", "authenticated snapshot ownership changed; retaining uncertain objects"); }
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function ensureActive(signal?: AbortSignal): void { if (signal?.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "tool resolution interrupted"); } }

export async function stableRead(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new LocalSolanaError("SOLANA_TOOL_MISSING", "tool is absent or substituted");
  });
  const errors: unknown[] = [];
  let bytes: Buffer | undefined;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) { throw new LocalSolanaError("SOLANA_TOOL_MISSING", "tool is absent or substituted"); }
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !sameMetadata(before, after) || !sameMetadata(before, current)) {
      throw new LocalSolanaError("SOLANA_TOOL_IDENTITY", "tool identity or metadata changed while it was read");
    }
  } catch (cause) { errors.push(cause); }
  try { await handle.close(); } catch (cause) { errors.push(cause); }
  throwErrors(errors, "authenticated tool read or close failed");
  if (bytes === undefined) { throw new LocalSolanaError("SOLANA_TOOL_MISSING", "tool bytes are absent"); }
  return bytes;
}

export function throwErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) { throw errors[0]; }
  if (errors.length > 1) { throw new AggregateError(errors, `${errors[0] instanceof Error ? errors[0].message : "tool failure"}; ${message}`, { cause: errors[0] }); }
}
