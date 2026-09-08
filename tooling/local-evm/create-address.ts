import { keccak256, strip0x } from "./crypto.ts";
import { LocalEvmError } from "./model.ts";

const CANONICAL_ADDRESS = /^0x[0-9a-f]{40}$/u;
const CANONICAL_QUANTITY = /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/u;
const UINT256_MAX = (1n << 256n) - 1n;

/** Parse the exact JSON-RPC quantity form accepted for a transaction nonce. */
export function parseTransactionNonce(value: unknown): bigint {
  if (typeof value !== "string" || !CANONICAL_QUANTITY.test(value)) {
    throw new LocalEvmError("VERIFY_TRANSACTION_NONCE_INVALID", "transaction nonce must be a canonical lowercase Ethereum hex quantity");
  }
  const nonce = BigInt(value);
  if (nonce > UINT256_MAX) {
    throw new LocalEvmError("VERIFY_TRANSACTION_NONCE_INVALID", "transaction nonce exceeds uint256");
  }
  return nonce;
}

/** RLP([sender, nonce]) for the direct CREATE address preimage. */
export function encodeCreateAddressPreimage(sender: string, nonce: bigint): Uint8Array {
  if (!CANONICAL_ADDRESS.test(sender)) {
    throw new LocalEvmError("VERIFY_CREATE_SENDER_INVALID", "CREATE sender must be a canonical lowercase 20-byte address");
  }
  if (nonce < 0n || nonce > UINT256_MAX) {
    throw new LocalEvmError("VERIFY_TRANSACTION_NONCE_INVALID", "transaction nonce must fit uint256");
  }

  // A 20-byte address is always 0x94 || address. Ethereum encodes integer zero
  // as the empty RLP scalar (0x80), not as the single byte 0x00.
  const senderItem = Buffer.concat([Buffer.from([0x94]), Buffer.from(strip0x(sender), "hex")]);
  const nonceItem = encodeNonceScalar(nonce);
  const payload = Buffer.concat([senderItem, nonceItem]);
  // senderItem <= 21 and uint256 nonceItem <= 33, so the list is always short.
  if (payload.length > 55) {throw new LocalEvmError("LOCAL_EVM_INTERNAL_FAILURE", "CREATE address RLP payload exceeded its uint256 bound");}
  return Buffer.concat([Buffer.from([0xc0 + payload.length]), payload]);
}

export function deriveCreateAddress(sender: string, nonce: bigint): `0x${string}` {
  return `0x${strip0x(keccak256(encodeCreateAddressPreimage(sender, nonce))).slice(-40)}`;
}

function encodeNonceScalar(nonce: bigint): Uint8Array {
  if (nonce === 0n) {return Buffer.from([0x80]);}
  if (nonce <= 0x7fn) {return Buffer.from([Number(nonce)]);}
  const unpadded = nonce.toString(16);
  const hex = unpadded.length % 2 === 0 ? unpadded : `0${unpadded}`;
  const bytes = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.from([0x80 + bytes.length]), bytes]);
}
