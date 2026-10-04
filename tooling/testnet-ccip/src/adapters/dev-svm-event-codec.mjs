// Fixed raw Borsh layouts, @chainlink/ccip-sdk 1.13.0, gitHead
// cff6b398a0d3214037acc8f85ad243608e9b779c. Archive SHA-256:
// caed2fefa8ccd9e31d0920dbdd7622ae8cb87d63efd178fe6a67425f9db709f6.
// Reference paths within that archive (1.6.0 directory, IDL metadata 1.6.3):
// src/solana/idl/1.6.0/CCIP_ROUTER.ts SHA-256:
// f201586eb91dd738a9aad430584cac68bdc42b2687d0ba822f82257839f0ad66
// dist/solana/idl/1.6.0/CCIP_ROUTER.js SHA-256:
// 01c560fecef86ae86615dcd77dd1a8048e1a1373248f76781db4716d57aaa10f
// src/solana/idl/1.6.0/CCIP_OFFRAMP.ts SHA-256:
// 137555981b98f42d253432ccb1a78a7a6a9228fc2237b0e87cc138d90430e068
// dist/solana/idl/1.6.0/CCIP_OFFRAMP.js SHA-256:
// c0cb8c1c9de22fbb5efaf11171a27348eb376d030130cd4d28e84e465ca8bdf2
// These source mappings do not qualify any deployed program. The outer adapter
// owns independent provider/IDL admission, event-time authorization, invocation
// and physical effect/CPI validation, and finality. State 2 alone is not settlement.

const MAX_EVENT_BYTES = 64 * 1024;
// Legacy Anchor SHA-256('event:<Name>')[0..8], checked against retained wires.
const SENT_DISCRIMINATOR = '174d49b77bb97339';
const EXECUTION_DISCRIMINATOR = 'b9b08c70ef4e1ff9';

/**
 * Decode exactly one raw event Buffer, including its eight-byte discriminator.
 * Returns { eventName, destChainSelector: bigint, sequenceNumber: bigint,
 *   message: { header: { messageId: hex, sourceChainSelector: bigint,
 *     destChainSelector: bigint, sequenceNumber: bigint, nonce: bigint },
 *     sender: Buffer32, data: Buffer, receiver: Buffer, extraArgs: Buffer,
 *     feeToken: Buffer32, tokenAmounts: [{ sourcePoolAddress: Buffer32,
 *       destTokenAddress: Buffer, extraData: Buffer, amount: bigint,
 *       destExecData: Buffer }], feeTokenAmount: bigint, feeValueJuels: bigint } }
 * or { eventName, sourceChainSelector: bigint, sequenceNumber: bigint,
 *   messageId: hex, messageHash: hex, state: 0|1|2|3 }.
 * Byte buffers are owned copies; variable bytes have no route/padding policy.
 * Throws on unsupported or malformed input. Returns raw fields only.
 */
export function decodeDevSvmEvent(rawBuffer) {
  if (!Buffer.isBuffer(rawBuffer)) {
    throw new TypeError('Raw SVM event must be a Buffer');
  }
  if (rawBuffer.length > MAX_EVENT_BYTES) {
    throw new RangeError('Raw SVM event exceeds 64 KiB');
  }

  let offset = 0;
  function requireBytes(length) {
    if (length > rawBuffer.length - offset) {
      throw new RangeError('Truncated raw SVM event');
    }
  }
  function fixed(length) {
    requireBytes(length);
    const value = Buffer.from(rawBuffer.subarray(offset, offset + length));
    offset += length;
    return value;
  }
  function u32() {
    requireBytes(4);
    const value = rawBuffer.readUInt32LE(offset);
    offset += 4;
    return value;
  }
  function u64() {
    requireBytes(8);
    const value = rawBuffer.readBigUInt64LE(offset);
    offset += 8;
    return value;
  }
  function amountLE() {
    requireBytes(32);
    let value = 0n;
    for (let i = 31; i >= 0; i--) {
      value = (value << 8n) | BigInt(rawBuffer[offset + i]);
    }
    offset += 32;
    return value;
  }
  function bytes() {
    const length = u32();
    // Check the declared length against available wire bytes BEFORE copying.
    requireBytes(length);
    return fixed(length);
  }
  function finish() {
    if (offset !== rawBuffer.length) {
      throw new RangeError('Trailing raw SVM event data');
    }
  }

  const discriminator = fixed(8).toString('hex');
  if (discriminator === EXECUTION_DISCRIMINATOR) {
    if (rawBuffer.length !== 89) {
      throw new RangeError('ExecutionStateChanged requires exactly 89 bytes');
    }
    const sourceChainSelector = u64(), sequenceNumber = u64();
    const messageId = '0x' + fixed(32).toString('hex');
    const messageHash = '0x' + fixed(32).toString('hex');
    const state = fixed(1)[0];
    if (state > 3) {
      throw new RangeError('Unknown MessageExecutionState tag');
    }
    finish();
    return { eventName: 'ExecutionStateChanged', sourceChainSelector,
      sequenceNumber, messageId, messageHash, state };
  }
  if (discriminator !== SENT_DISCRIMINATOR) {
    throw new Error('Unsupported raw SVM event discriminator');
  }

  const destChainSelector = u64(), sequenceNumber = u64();
  const header = {
    messageId: '0x' + fixed(32).toString('hex'),
    sourceChainSelector: u64(), destChainSelector: u64(),
    sequenceNumber: u64(), nonce: u64(),
  };
  if (destChainSelector !== header.destChainSelector || sequenceNumber !== header.sequenceNumber) {
    throw new Error('CCIPMessageSent outer selector/sequence disagrees with header');
  }
  const sender = fixed(32), data = bytes(), receiver = bytes(), extraArgs = bytes();
  const feeToken = fixed(32), count = u32();
  // Every token needs at least 76 bytes (two raw32s and three u32 lengths).
  // Reserve the final two u256 fee amounts before allocating/iterating a Vec.
  requireBytes(64);
  if (count > Math.floor((rawBuffer.length - offset - 64) / 76)) {
    throw new RangeError('Token vector length exceeds available raw SVM event bytes');
  }
  const tokenAmounts = [];
  for (let i = 0; i < count; i++) {
    tokenAmounts.push({
      sourcePoolAddress: fixed(32), destTokenAddress: bytes(), extraData: bytes(),
      amount: amountLE(), destExecData: bytes(),
    });
  }
  const message = { header, sender, data, receiver, extraArgs, feeToken, tokenAmounts,
    feeTokenAmount: amountLE(), feeValueJuels: amountLE() };
  finish();
  return { eventName: 'CCIPMessageSent', destChainSelector, sequenceNumber, message };
}
