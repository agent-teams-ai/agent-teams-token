import type { FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { LocalSolanaError } from "../domain/model.ts";

const LIMIT = 16_384;
export function assertMarkerBounds(entry: BigIntStats): void {
  if (entry.size < 0n || entry.size > BigInt(LIMIT) || entry.blocks < 0n || entry.blocks * 512n > BigInt(LIMIT)) {
    throw new LocalSolanaError("SOLANA_LEASE_INVALID", "lease exceeds its logical or allocated size bound");
  }
}

/** Fixed allocation, including one byte to detect growth beyond the limit. */
export async function readBoundedMarker(handle: FileHandle): Promise<string> {
  const before = await handle.stat({ bigint: true }); assertMarkerBounds(before);
  const buffer = Buffer.alloc(LIMIT + 1); let length = 0;
  while (length < buffer.length) {
    const result = await handle.read(buffer, length, buffer.length - length, length);
    if (result.bytesRead === 0) { break; }
    length += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true }); assertMarkerBounds(after);
  if (length > LIMIT || BigInt(length) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new LocalSolanaError("SOLANA_LEASE_INVALID", "lease changed during bounded acquisition");
  }
  return buffer.subarray(0, length).toString("utf8");
}
