import { createHash } from "node:crypto";
import { fail } from "./model.ts";
export const PLAN_ID_DOMAIN = "AGTMAI_UNSIGNED_DEPLOYMENT_PLAN_V1";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("UNSAFE_NUMBER", "canonical numbers must be safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right));
    const properties = entries.map(
      ([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`,
    );
    return `{${properties.join(",")}}`;
  }
  fail("CANONICAL_TYPE", "unsupported canonical value");
}

export function sha256Hex(value: string | Uint8Array): `0x${string}` {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export function computePlanId(identity: Record<string, unknown>): `0x${string}` {
  return sha256Hex(`${PLAN_ID_DOMAIN}\0${canonicalJson(identity)}`);
}

const MASK_64 = (1n << 64n) - 1n;
const KECCAK_ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
] as const;
const KECCAK_ROTATIONS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
] as const;

function rotateLeft64(value: bigint, count: number): bigint {
  if (count === 0) {
    return value & MASK_64;
  }
  const bits = BigInt(count);
  return ((value << bits) | (value >> (64n - bits))) & MASK_64;
}

function keccakPermutation(state: bigint[]): void {
  for (const roundConstant of KECCAK_ROUND_CONSTANTS) {
    const column = Array.from(
      { length: 5 },
      (_, x) => state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20],
    );
    const delta = Array.from(
      { length: 5 },
      (_, x) => column[(x + 4) % 5] ^ rotateLeft64(column[(x + 1) % 5], 1),
    );
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        state[x + 5 * y] ^= delta[x];
      }
    }
    const moved = Array.from<bigint>({ length: 25 }).fill(0n);
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotateLeft64(
          state[x + 5 * y],
          KECCAK_ROTATIONS[x + 5 * y],
        );
      }
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        state[x + 5 * y] = moved[x + 5 * y]
          ^ ((~moved[(x + 1) % 5 + 5 * y]) & moved[(x + 2) % 5 + 5 * y]);
      }
    }
    state[0] ^= roundConstant;
  }
}

/** Ethereum Keccak-256 (legacy 0x01 domain, not standardized SHA3-256). */
export function keccak256(bytes: Uint8Array): `0x${string}` {
  const input = Buffer.from(bytes);
  const rate = 136;
  const paddedLength = Math.ceil((input.length + 1) / rate) * rate;
  const padded = Buffer.alloc(paddedLength);
  input.copy(padded);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  const state = Array.from<bigint>({ length: 25 }).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      state[lane] ^= padded.readBigUInt64LE(offset + lane * 8);
    }
    keccakPermutation(state);
  }
  const output = Buffer.alloc(32);
  for (let lane = 0; lane < 4; lane += 1) {
    output.writeBigUInt64LE(state[lane] & MASK_64, lane * 8);
  }
  return `0x${output.toString("hex")}`;
}

/** Derives the CREATE address from RLP([sender, nonce]) using canonical uint256 nonce encoding. */
export function deriveCreateAddress(sender: string, nonce: bigint): `0x${string}` {
  if (!/^0x[0-9a-f]{40}$/u.test(sender)) {
    fail("CREATE_SENDER_INVALID", "CREATE sender must be a lowercase address");
  }
  if (nonce < 0n || nonce >= (1n << 256n)) {
    fail("CREATE_NONCE_INVALID", "CREATE nonce is outside uint256");
  }
  const senderBytes = Buffer.from(sender.slice(2), "hex");
  const encodedSender = Buffer.concat([Buffer.from([0x80 + senderBytes.length]), senderBytes]);
  const encodedNonce = encodeRlpNonce(nonce);
  const payload = Buffer.concat([encodedSender, encodedNonce]);
  const encoded = Buffer.concat([Buffer.from([0xc0 + payload.length]), payload]);
  return `0x${keccak256(encoded).slice(-40)}`;
}

function encodeRlpNonce(nonce: bigint): Uint8Array {
  if (nonce === 0n) {
    return Buffer.from([0x80]);
  }
  let hex = nonce.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  const bytes = Buffer.from(hex, "hex");
  return bytes.length === 1 && bytes[0] < 0x80
    ? bytes
    : Buffer.concat([Buffer.from([0x80 + bytes.length]), bytes]);
}
