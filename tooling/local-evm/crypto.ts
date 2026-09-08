import { createHash } from "node:crypto";

export function sha256(bytes: Uint8Array | string): `0x${string}` {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

/** SHA-256 of decoded 0x-prefixed bytes, never of their hexadecimal text. */
export function sha256HexBytes(value: string): `0x${string}` {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) {
    throw new TypeError("hex bytes must be an even-length 0x-prefixed string");
  }
  return sha256(Buffer.from(value.slice(2), "hex"));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {return JSON.stringify(value);}
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {throw new TypeError("canonical JSON accepts only safe integers");}
    return String(value);
  }
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(",")}]`;}
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).toSorted().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("unsupported canonical JSON value");
}

export function bytes32Uint(value: string): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

export function strip0x(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
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
const KECCAK_ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14] as const;

function rotateLeft64(value: bigint, count: number): bigint {
  if (count === 0) {return value & MASK_64;}
  const bits = BigInt(count);
  return ((value << bits) | (value >> (64n - bits))) & MASK_64;
}

function keccakPermutation(state: bigint[]): void {
  for (const roundConstant of KECCAK_ROUND_CONSTANTS) {
    const column = Array.from({ length: 5 }, (_, x) => state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]);
    const delta = Array.from({ length: 5 }, (_, x) => column[(x + 4) % 5] ^ rotateLeft64(column[(x + 1) % 5], 1));
    for (let y = 0; y < 5; y += 1) {for (let x = 0; x < 5; x += 1) {state[x + 5 * y] ^= delta[x];}}
    const moved = Array.from<bigint>({ length: 25 }).fill(0n);
    for (let y = 0; y < 5; y += 1) {for (let x = 0; x < 5; x += 1) {
      moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotateLeft64(state[x + 5 * y], KECCAK_ROTATIONS[x + 5 * y]);
    }}
    for (let y = 0; y < 5; y += 1) {for (let x = 0; x < 5; x += 1) {
      state[x + 5 * y] = moved[x + 5 * y] ^ ((~moved[(x + 1) % 5 + 5 * y]) & moved[(x + 2) % 5 + 5 * y]);
    }}
    state[0] ^= roundConstant;
  }
}

/** Ethereum Keccak-256 (legacy 0x01 domain, not SHA3-256). */
export function keccak256(bytes: Uint8Array | string): `0x${string}` {
  const input = typeof bytes === "string"
    ? Buffer.from(strip0x(bytes), bytes.startsWith("0x") ? "hex" : "utf8")
    : Buffer.from(bytes);
  const rate = 136;
  const paddedLength = Math.ceil((input.length + 1) / rate) * rate;
  const padded = Buffer.alloc(paddedLength);
  input.copy(padded);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  const state = Array.from<bigint>({ length: 25 }).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {state[lane] ^= padded.readBigUInt64LE(offset + lane * 8);}
    keccakPermutation(state);
  }
  const output = Buffer.alloc(32);
  for (let lane = 0; lane < 4; lane += 1) {output.writeBigUInt64LE(state[lane] & MASK_64, lane * 8);}
  return `0x${output.toString("hex")}`;
}
