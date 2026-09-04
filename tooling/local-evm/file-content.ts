import {constants as bufferConstants} from "node:buffer";
import {lstat, type FileHandle} from "node:fs/promises";
import {LocalEvmError} from "./model.ts";
import {
  assertSameFile,
  assertSameMutableSnapshot,
  assertWithinBounds,
  mutableFileSnapshot,
  type FileMutableSnapshot,
  type FileSizeBounds,
  type RegularFileIdentity,
} from "./file-state.ts";

interface StableFileOptions {
  readonly label: string;
  readonly bounds?: FileSizeBounds;
  readonly expectedBytes?: Uint8Array;
  readonly expectedMutable?: FileMutableSnapshot;
  readonly expectedLinks?: bigint;
}

export async function observeNamedHeldFile(
  path: string,
  handle: FileHandle,
  identity: RegularFileIdentity,
  options: StableFileOptions,
): Promise<{readonly bytes: Buffer; readonly mutable: FileMutableSnapshot}> {
  const links = options.expectedLinks ?? 1n;
  const namedBefore = await lstat(path, {bigint: true});
  assertSameFile(identity, namedBefore, options.label, links);
  if (options.expectedMutable !== undefined) {
    assertSameMutableSnapshot(
      options.expectedMutable,
      namedBefore,
      options.label,
    );
  }
  const observed = await observeHeldFile(handle, identity, options);
  assertSameMutableSnapshot(observed.mutable, namedBefore, options.label);
  const namedAfter = await lstat(path, {bigint: true});
  assertSameFile(identity, namedAfter, options.label, links);
  assertSameMutableSnapshot(observed.mutable, namedAfter, options.label);
  return observed;
}

async function observeHeldFile(
  handle: FileHandle,
  identity: RegularFileIdentity,
  options: StableFileOptions,
): Promise<{readonly bytes: Buffer; readonly mutable: FileMutableSnapshot}> {
  const links = options.expectedLinks ?? 1n;
  const before = await handle.stat({bigint: true});
  assertSameFile(identity, before, options.label, links);
  assertWithinBounds(before, options.label, options.bounds);
  if (options.expectedMutable !== undefined) {
    assertSameMutableSnapshot(
      options.expectedMutable,
      before,
      options.label,
    );
  }
  const mutable = mutableFileSnapshot(before);
  const cap = readCap(before.size, options);
  const bytes = await positionedRead(handle, cap, options.label);
  const after = await handle.stat({bigint: true});
  assertSameFile(identity, after, options.label, links);
  assertWithinBounds(after, options.label, options.bounds);
  assertSameMutableSnapshot(mutable, after, options.label);
  if (after.size !== BigInt(bytes.byteLength)) {
    changed(options.label, "length changed while it was read");
  }
  if (options.expectedBytes !== undefined
    && !bytes.equals(Buffer.from(options.expectedBytes))) {
    changed(options.label, "does not contain the supplied bytes");
  }
  return {bytes, mutable};
}

function readCap(size: bigint, options: StableFileOptions): number {
  if (options.expectedBytes !== undefined) {
    return options.expectedBytes.byteLength;
  }
  if (options.bounds !== undefined) {
    return options.bounds.logicalBytes;
  }
  if (size < 0n || size >= BigInt(bufferConstants.MAX_LENGTH)
    || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LocalEvmError(
      `LOCAL_EVM_${options.label}_STAT_INVALID`,
      `${options.label} logical size cannot be buffered safely`,
    );
  }
  return Number(size);
}

async function positionedRead(
  handle: FileHandle,
  cap: number,
  label: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(cap) || cap < 0
    || cap >= bufferConstants.MAX_LENGTH) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_STAT_INVALID`,
      `${label} read bound is invalid`,
    );
  }
  const allocation = Buffer.alloc(cap + 1);
  let offset = 0;
  while (offset < allocation.length) {
    const result = await handle.read(
      allocation,
      offset,
      allocation.length - offset,
      offset,
    );
    if (!Number.isSafeInteger(result.bytesRead)
      || result.bytesRead < 0
      || result.bytesRead > allocation.length - offset) {
      throw new LocalEvmError(
        `LOCAL_EVM_${label}_STAT_INVALID`,
        `${label} returned an invalid read count`,
      );
    }
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  if (offset > cap) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_TOO_LARGE`,
      `${label} exceeds its logical byte limit`,
    );
  }
  return allocation.subarray(0, offset);
}

function changed(label: string, detail: string): never {
  throw new LocalEvmError(
    `LOCAL_EVM_${label}_CHANGED`,
    `${label} ${detail}`,
  );
}
