import { constants as bufferConstants } from "node:buffer";
import type { BigIntStats } from "node:fs";
import { LocalEvmError } from "./model.ts";

export interface FileSizeBounds {
  readonly logicalBytes: number;
  readonly allocatedBytes: number;
}

export interface RegularFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
}

export interface FileMutableSnapshot {
  readonly size: bigint;
  readonly blocks: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface RegularFileObservation {
  readonly bytes: Buffer;
  readonly identity: RegularFileIdentity;
  readonly mutable: FileMutableSnapshot;
}

export function assertPolicyInteger(
  value: number,
  label: string,
  kind: string,
  bufferBound = false,
): void {
  if (!Number.isSafeInteger(value)
    || value < 0
    || (bufferBound && value >= bufferConstants.MAX_LENGTH)) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_POLICY_INVALID`,
      `${label} ${kind} limit is invalid`,
    );
  }
}

export function allocatedBytesFromStatBlocks(
  blocks: unknown,
  label: string,
): bigint {
  if (typeof blocks !== "bigint" || blocks < 0n) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_STAT_INVALID`,
      `${label} allocated block count is invalid`,
    );
  }
  // POSIX st_blocks is expressed in 512-byte units regardless of the
  // filesystem's allocation-block size.
  return blocks * 512n;
}

export function assertWithinBounds(
  stat: BigIntStats,
  label: string,
  bounds: FileSizeBounds | undefined,
): void {
  if (bounds === undefined) {return;}
  assertPolicyInteger(bounds.logicalBytes, label, "logical byte", true);
  assertPolicyInteger(bounds.allocatedBytes, label, "allocated byte");
  if (typeof stat.size !== "bigint" || stat.size < 0n) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_STAT_INVALID`,
      `${label} logical size is invalid`,
    );
  }
  const allocated = allocatedBytesFromStatBlocks(stat.blocks, label);
  if (stat.size > BigInt(bounds.logicalBytes)) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_TOO_LARGE`,
      `${label} exceeds its logical byte limit`,
    );
  }
  if (allocated > BigInt(bounds.allocatedBytes)) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_TOO_LARGE`,
      `${label} exceeds its allocated byte limit`,
    );
  }
}

export function fileIdentity(stat: BigIntStats): RegularFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
  };
}

export function mutableFileSnapshot(
  stat: BigIntStats,
): FileMutableSnapshot {
  return {
    size: stat.size,
    blocks: stat.blocks,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

export function assertSameMutableSnapshot(
  expected: FileMutableSnapshot,
  actual: BigIntStats,
  label: string,
): void {
  if (actual.size !== expected.size
    || actual.blocks !== expected.blocks
    || actual.mtimeNs !== expected.mtimeNs
    || actual.ctimeNs !== expected.ctimeNs) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_CHANGED`,
      `${label} content metadata changed`,
    );
  }
}

export function assertRegularFile(
  stat: BigIntStats,
  label: string,
  ownedMode?: number,
): void {
  if (!stat.isFile() || stat.nlink !== 1n) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_NOT_REGULAR`,
      `${label} must be a singly linked regular file`,
    );
  }
  const expectedOwner = process.getuid?.();
  if (ownedMode !== undefined
    && ((expectedOwner !== undefined && stat.uid !== BigInt(expectedOwner))
      || (stat.mode & 0o777n) !== BigInt(ownedMode))) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_NOT_PRIVATE`,
      `${label} must be an owned mode-${ownedMode.toString(8)} file`,
    );
  }
}

export function assertSameFile(
  expected: RegularFileIdentity,
  actual: BigIntStats,
  label: string,
  expectedLinks = 1n,
): void {
  if (actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.uid !== expected.uid
    || actual.mode !== expected.mode
    || actual.nlink !== expectedLinks) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_CHANGED`,
      `${label} identity changed`,
    );
  }
}
