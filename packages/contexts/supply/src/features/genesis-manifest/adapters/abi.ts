import { keccak_256 } from "@noble/hashes/sha3.js";
import { ALLOCATION_DOMAIN, type NormalizedAllocation } from "../domain/model.js";

export function encodeAllocationCommitment(source: { readonly network: { readonly chainId: string }; readonly token: { readonly name: string; readonly symbol: string; readonly decimals: number; readonly initialSupplyBaseUnits: string } }, allocations: readonly NormalizedAllocation[]): { rawAbi: `0x${string}`; hash: `0x${string}` } {
  // This fixed encoder mirrors abi.encode for the normative v1 tuple. It is
  // intentionally not a reusable ABI framework; Keccak is supplied by the
  // exact-pinned, maintained @noble/hashes implementation.
  const words: Uint8Array[] = [
    hexBytes(ALLOCATION_DOMAIN), uintWord(BigInt(source.network.chainId)), keccak_256(new TextEncoder().encode(source.token.name)),
    keccak_256(new TextEncoder().encode(source.token.symbol)), uintWord(BigInt(source.token.decimals)),
    uintWord(BigInt(source.token.initialSupplyBaseUnits)), uintWord(7n * 32n), uintWord(BigInt(allocations.length)),
  ];
  for (const allocation of allocations) {words.push(hexBytes(allocation.idBytes32), addressWord(allocation.recipient), uintWord(BigInt(allocation.amountBaseUnits)));}
  const bytes = concat(words), rawAbi = hex(bytes); return { rawAbi, hash: hex(keccak_256(bytes)) };
}

function uintWord(value: bigint): Uint8Array { const output = new Uint8Array(32); for (let index = 31; index >= 0; index -= 1) { output[index] = Number(value & 0xffn); value >>= 8n; } if (value !== 0n) {throw new RangeError("uint256 overflow");} return output; }
function addressWord(value: `0x${string}`): Uint8Array { const address = hexBytes(value); if (address.length !== 20) {throw new TypeError("address must be 20 bytes");} const output = new Uint8Array(32); output.set(address, 12); return output; }
function hexBytes(value: `0x${string}`): Uint8Array { const body = value.slice(2); if (body.length % 2 !== 0 || !/^[0-9a-f]*$/.test(body)) {throw new TypeError("invalid lowercase hex");} return Uint8Array.from(body.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16)); }
function concat(parts: readonly Uint8Array[]): Uint8Array { const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output; }
function hex(value: Uint8Array): `0x${string}` { return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`; }
