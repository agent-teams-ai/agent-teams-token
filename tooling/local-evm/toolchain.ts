import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LocalEvmError } from "./model.ts";

const PLATFORM_SHA256 = {
  "darwin-arm64": "d4abcf0b3e24b7948ddfd64c374d26c3214648717777790ecb936979054a129d",
  "linux-x64": "c8d35afdddc3cd2743ee88b8f25e0fecd16e2bdd5f2120f37e52cd9cc45ae0e6",
} as const;

export interface PinnedSolc {
  readonly path: string;
  assertReady(): void;
  close(): void;
}

export function pinnedSolc(repositoryRoot: string, custodyDirectory: string): PinnedSolc {
  const root = canonicalCallerPath(repositoryRoot, "LOCAL_EVM_REPOSITORY_PATH", "repository root");
  const custody = canonicalCallerPath(custodyDirectory, "LOCAL_EVM_SOLC_CUSTODY_INVALID", "solc snapshot custody");
  assertPrivateCustodyPreflight(custody);
  const platform = supportedPlatform();
  const lexicalToolsRoot = contained(root, ".tools", "LOCAL_EVM_TOOLS_PATH");
  assertDirectory(lexicalToolsRoot, "LOCAL_EVM_TOOLS_PATH");
  const toolsRoot = canonicalExistingPath(lexicalToolsRoot, "LOCAL_EVM_TOOLS_PATH", "persistent tool installation");
  if (custody === toolsRoot || custody.startsWith(`${toolsRoot}${sep}`)) {
    throw new LocalEvmError("LOCAL_EVM_SOLC_CUSTODY_INVALID", "solc snapshot custody cannot physically use the persistent tool installation");
  }
  const custodyFd = openSnapshotCustody(custody);
  try {
    const lock = parseLock(stableRead(join(root, "tooling/toolchain.lock.json")), platform);
    const install = contained(toolsRoot, lock.installDirectory, "LOCAL_EVM_SOLC_LOCK");
    assertDirectory(install, "LOCAL_EVM_SOLC_INSTALL");
    const installed = contained(install, "solc", "LOCAL_EVM_SOLC_LOCK");
    const bytes = stableRead(installed);
    assertPinnedSolcSha256(bytes, lock.sha256);
    assertSnapshotCustodyIdentity(custody, custodyFd);
    const snapshotRoot = mkdtempSync(join(custody, "authenticated-solc-"));
    chmodSync(snapshotRoot, 0o700);
    const snapshot = join(snapshotRoot, "solc");
    const writeFd = openSync(snapshot, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
    try {
      let offset = 0;
      while (offset < bytes.length) { offset += writeSync(writeFd, bytes, offset); }
    } finally { closeSync(writeFd); }
    chmodSync(snapshot, 0o500);
    const heldFd = openSync(snapshot, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const capability = heldPinnedSolc(snapshot, heldFd, fstatSync(heldFd), bytes, lock.sha256);
      capability.assertReady();
      assertSnapshotCustodyIdentity(custody, custodyFd);
      return capability;
    } catch (cause) {
      closeSync(heldFd);
      throw cause;
    }
  } finally {
    closeSync(custodyFd);
  }
}

function heldPinnedSolc(path: string, fd: number, identity: Stats, expectedBytes: Buffer, expectedSha256: string): PinnedSolc {
  let closed = false;
  return {
    path,
    assertReady(): void {
      if (closed) {snapshotInvalid("authenticated private solc snapshot capability is closed");}
      const held = fstatSync(fd);
      if (!sameSnapshotMetadata(identity, held) || !readDescriptor(fd, held.size).equals(expectedBytes)
        || !sameSnapshotMetadata(held, fstatSync(fd))) {snapshotInvalid();}
      let currentFd: number | undefined;
      try {
        currentFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(currentFd);
        const current = lstatSync(path);
        if (!sameSnapshotMetadata(identity, before) || !sameSnapshotMetadata(identity, current) || current.isSymbolicLink()) {snapshotInvalid();}
        const currentBytes = readDescriptor(currentFd, before.size);
        const after = fstatSync(currentFd);
        if (!sameSnapshotMetadata(before, after) || !currentBytes.equals(expectedBytes)
          || createHash("sha256").update(currentBytes).digest("hex") !== expectedSha256) {snapshotInvalid();}
      } catch (cause) {
        if (cause instanceof LocalEvmError) {throw cause;}
        snapshotInvalid();
      } finally {
        if (currentFd !== undefined) {closeSync(currentFd);}
      }
    },
    close(): void {
      if (!closed) {closed = true; closeSync(fd);}
    },
  };
}

function snapshotInvalid(message = "authenticated private solc snapshot identity or bytes changed before use"): never {
  throw new LocalEvmError("LOCAL_EVM_SOLC_SNAPSHOT_INVALID", message);
}

function readDescriptor(fd: number, size: number): Buffer {
  if (!Number.isSafeInteger(size) || size < 0) {snapshotInvalid();}
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) {snapshotInvalid();}
    offset += count;
  }
  return bytes;
}

function sameSnapshotMetadata(expected: Stats, actual: Stats): boolean {
  return expected.isFile() && actual.isFile() && expected.dev === actual.dev && expected.ino === actual.ino
    && expected.uid === actual.uid && expected.size === actual.size && expected.nlink === 1 && actual.nlink === 1 && expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs
    && (expected.mode & 0o777) === 0o500 && (actual.mode & 0o777) === 0o500;
}

export function assertPinnedSolcSha256(bytes: Uint8Array, expectedSha256: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new LocalEvmError("LOCAL_EVM_SOLC_CHECKSUM_MISMATCH", "repository-pinned solc differs from the exact platform lock SHA-256");
  }
}

export function assertPinnedSolcVersionOutput(output: string): string {
  const version = output.trim().split(/\r?\n/u).find((line) => line.startsWith("Version:")) ?? "";
  if (!/^Version: 0\.8\.36\+commit\.8a079791\.(?:Linux\.g\+\+|Darwin\.appleclang)$/u.test(version)) {
    throw new LocalEvmError("LOCAL_EVM_SOLC_VERSION_MISMATCH", "repository-pinned solc must be exactly 0.8.36+commit.8a079791");
  }
  return version;
}

export function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) { return true; }
  }
  return false;
}

function supportedPlatform(): keyof typeof PLATFORM_SHA256 {
  if (process.platform === "linux" && process.arch === "x64") { return "linux-x64"; }
  if (process.platform === "darwin" && process.arch === "arm64") { return "darwin-arm64"; }
  throw new LocalEvmError("LOCAL_EVM_PLATFORM_UNSUPPORTED", `unsupported local EVM platform ${process.platform}-${process.arch}`);
}

function parseLock(bytes: Buffer, platform: keyof typeof PLATFORM_SHA256): { readonly installDirectory: string; readonly sha256: string } {
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  const lock = record(parsed, "LOCAL_EVM_TOOLCHAIN_LOCK");
  const tools = record(lock.tools, "LOCAL_EVM_TOOLCHAIN_LOCK");
  const solc = record(tools.solc, "LOCAL_EVM_SOLC_LOCK");
  const platforms = record(solc.platforms, "LOCAL_EVM_SOLC_LOCK");
  const artifact = record(platforms[platform], "LOCAL_EVM_SOLC_LOCK");
  const installDirectory = string(artifact.installDirectory, "LOCAL_EVM_SOLC_LOCK");
  const sha256 = string(artifact.sha256, "LOCAL_EVM_SOLC_LOCK");
  if (solc.version !== "0.8.36" || artifact.archive !== "executable"
    || installDirectory !== `solc-v0.8.36-${platform}`
    || JSON.stringify(artifact.expectedFiles) !== JSON.stringify(["solc"])
    || sha256 !== PLATFORM_SHA256[platform]) {
    throw new LocalEvmError("LOCAL_EVM_SOLC_LOCK", "solc platform lock must match the exact 0.8.36 artifact and SHA-256");
  }
  return { installDirectory, sha256 };
}

function stableRead(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) { throw new LocalEvmError("LOCAL_EVM_TOOL_IDENTITY", "toolchain file is not stable and regular"); }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || before.dev !== after.dev || before.ino !== after.ino || before.dev !== current.dev || before.ino !== current.ino) {
      throw new LocalEvmError("LOCAL_EVM_TOOL_IDENTITY", "toolchain file identity changed while it was read");
    }
    return bytes;
  } finally { closeSync(fd); }
}

function assertDirectory(path: string, code: string): void {
  const value = lstatSync(path);
  if (!value.isDirectory() || value.isSymbolicLink()) { throw new LocalEvmError(code, "toolchain directory is absent or substituted"); }
}

function assertPrivateCustodyPreflight(path: string): void {
  const value = lstatSync(path);
  const expectedOwner = process.getuid?.();
  if (!value.isDirectory() || value.isSymbolicLink()
    || (expectedOwner !== undefined && value.uid !== expectedOwner) || (value.mode & 0o777) !== 0o700) {
    throw new LocalEvmError("LOCAL_EVM_SOLC_CUSTODY_INVALID", "solc snapshot custody must be caller-owned, canonical, real, stable, and mode 0700");
  }
}

function openSnapshotCustody(path: string): number {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    assertSnapshotCustodyIdentity(path, fd);
    return fd;
  } catch (cause) {
    if (fd !== undefined) { closeSync(fd); }
    if (cause instanceof LocalEvmError) { throw cause; }
    throw new LocalEvmError("LOCAL_EVM_SOLC_CUSTODY_INVALID", "solc snapshot custody must already exist as a safe real directory");
  }
}

function assertSnapshotCustodyIdentity(path: string, fd: number): void {
  const held = fstatSync(fd);
  const current = lstatSync(path);
  const expectedOwner = process.getuid?.();
  if (!held.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
    || held.dev !== current.dev || held.ino !== current.ino
    || (expectedOwner !== undefined && (held.uid !== expectedOwner || current.uid !== expectedOwner))
    || (held.mode & 0o777) !== 0o700 || (current.mode & 0o777) !== 0o700) {
    throw new LocalEvmError("LOCAL_EVM_SOLC_CUSTODY_INVALID", "solc snapshot custody must be caller-owned, canonical, real, stable, and mode 0700");
  }
}

function canonicalCallerPath(path: string, code: string, label: string): string {
  const lexical = resolve(path);
  const canonical = canonicalExistingPath(lexical, code, label);
  if (lexical !== canonical) {throw new LocalEvmError(code, `${label} must be supplied as its canonical real path`);}
  return canonical;
}

function canonicalExistingPath(path: string, code: string, label: string): string {
  try {return realpathSync(path);}
  catch {throw new LocalEvmError(code, `${label} must already exist as a real path`);}
}

function contained(root: string, value: string, code: string): string {
  if (value.length === 0 || value === "." || value === ".." || value.startsWith("-")
    || containsAsciiControlCharacter(value) || value.includes("\\") || isAbsolute(value)) {
    throw new LocalEvmError(code, "toolchain path is not a safe relative path");
  }
  const target = resolve(root, value);
  const fromRoot = relative(resolve(root), target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new LocalEvmError(code, "toolchain path escapes its trusted root");
  }
  return target;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { throw new LocalEvmError(code, "toolchain lock object is invalid"); }
  return value as Record<string, unknown>;
}

function string(value: unknown, code: string): string {
  if (typeof value !== "string") { throw new LocalEvmError(code, "toolchain lock string is invalid"); }
  return value;
}
