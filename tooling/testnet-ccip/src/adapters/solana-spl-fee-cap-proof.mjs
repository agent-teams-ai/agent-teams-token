import { createHash } from 'node:crypto';
import { ROUTER_PROGRAM } from '../domain/solana-registration.ts';
import { FEE_QUOTER_PROGRAM } from '../domain/solana-pool-config.ts';
import { REVERSE } from '../domain/solana-reverse.mjs';
import { SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM } from '../domain/solana-mint.ts';
import { loadSolanaProvider } from './solana-transaction-sdk.mjs';

const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const U64_MAX = (1n << 64n) - 1n;
const fail = message => { throw new Error(`Unsigned SPL fee-cap proof: ${message}`); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const meta = (address, isWritable = false, isSigner = false) => ({ address, isWritable, isSigner });
const instruction = (programId, accounts, data) => ({ programId, accounts, dataBase64: data.toString('base64') });
const canonicalBytes = (value, label) => {
  if (typeof value !== 'string') fail(`${label} encoding missing`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail(`${label} encoding is noncanonical`);
  return bytes;
};
const decimal = (value, label, allowZero = false) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail(`${label} must be an integer decimal string`);
  const amount = BigInt(value);
  if (amount > U64_MAX || (!allowZero && amount === 0n)) fail(`${label} outside positive u64`);
  return amount;
};
const key = (PublicKey, address, label) => {
  try {
    const value = new PublicKey(address);
    if (value.toBase58() !== address) fail(`${label} is noncanonical`);
    return value;
  } catch { return fail(`${label} is not a public key`); }
};
const ata = (PublicKey, mint, owner) => PublicKey.findProgramAddressSync([
  key(PublicKey, owner, 'ATA owner').toBuffer(), key(PublicKey, SPL_TOKEN_PROGRAM, 'Token Program').toBuffer(),
  key(PublicKey, mint, 'ATA mint').toBuffer(),
], key(PublicKey, ATA_PROGRAM, 'ATA Program'))[0].toBase58();
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };

function capturedAccount(PublicKey, raw, address, length, label) {
  if (!raw || raw.address !== address || raw.owner !== SPL_TOKEN_PROGRAM || raw.executable !== false ||
      raw.slot !== undefined && (!Number.isSafeInteger(raw.slot) || raw.slot < 1)) fail(`${label} identity, program or slot mismatch`);
  const bytes = canonicalBytes(raw.dataBase64, label);
  if (bytes.length !== length || raw.sha256 !== digest(bytes)) fail(`${label} length or raw hash mismatch`);
  key(PublicKey, address, label);
  return bytes;
}
function mintState(PublicKey, raw, address, expectedDecimals, minimumSupply, label) {
  const bytes = capturedAccount(PublicKey, raw, address, 82, label);
  if (bytes.readUInt32LE(0) > 1 || bytes.readUInt32LE(0) === 1 && bytes.subarray(4, 36).equals(Buffer.alloc(32)) ||
      bytes[45] !== 1 || bytes[44] !== expectedDecimals || bytes.readUInt32LE(46) > 1 ||
      bytes.readBigUInt64LE(36) < minimumSupply) fail(`${label} invalid classic SPL mint`);
}
function routerState(PublicKey, raw, address) {
  if (!raw || raw.address !== address || raw.owner !== ROUTER_PROGRAM || raw.executable !== false) fail('Router config owner mismatch');
  const bytes = canonicalBytes(raw.dataBase64, 'Router config');
  const discriminator = createHash('sha256').update('account:Config').digest().subarray(0, 8);
  if (bytes.length !== 210 || raw.sha256 !== digest(bytes) || !bytes.subarray(0, 8).equals(discriminator) ||
      bytes[8] !== 1 || bytes[9] !== 1 ||
      !bytes.subarray(82, 114).equals(key(PublicKey, FEE_QUOTER_PROGRAM, 'Fee Quoter').toBuffer())) {
    fail('Router config layout or Fee Quoter mismatch');
  }
}
function feeConfigState(raw, address) {
  if (!raw || raw.address !== address || raw.owner !== FEE_QUOTER_PROGRAM || raw.executable !== false) {
    fail('fee-token config identity or owner mismatch');
  }
  const bytes = canonicalBytes(raw.dataBase64, 'fee-token config');
  if (bytes.length <= 8 || raw.sha256 !== digest(bytes)) fail('fee-token config raw bytes or hash missing');
  // Fee Quoter binary attribution and config layout remain unqualified. An
  // existing account is necessary evidence, not proof that this mint is enabled.
}
function tokenState(PublicKey, raw, address, mint, owner, amount, label) {
  const bytes = capturedAccount(PublicKey, raw, address, 165, label);
  if (!bytes.subarray(0, 32).equals(key(PublicKey, mint, `${label} mint`).toBuffer()) ||
      !bytes.subarray(32, 64).equals(key(PublicKey, owner, `${label} owner`).toBuffer()) ||
      bytes[108] !== 1 || bytes.readUInt32LE(72) !== 0 || bytes.readBigUInt64LE(121) !== 0n ||
      bytes.readUInt32LE(109) !== 0 || bytes.readUInt32LE(129) !== 0 || bytes.readBigUInt64LE(64) < amount) {
    fail(`${label} mint, owner, balance or delegation invalid`);
  }
}
function inspectSendData(PublicKey, data, sourceMint, feeMint, sourceAmount) {
  const discriminator = createHash('sha256').update('global:ccip_send').digest().subarray(0, 8);
  if (!data.subarray(0, 8).equals(discriminator)) fail('wrong ccip_send discriminator');
  let offset = 16;
  const take = size => {
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > data.length) fail('truncated ccip_send');
    const chunk = data.subarray(offset, offset + size); offset += size; return chunk;
  };
  const vec = () => { const size = take(4).readUInt32LE(0); return take(size); };
  const receiver = vec();
  if (receiver.length !== 32 || receiver.equals(Buffer.alloc(32))) fail('receiver must be ABI32');
  vec(); // Payload is frozen by the exact send-data hash below.
  if (take(4).readUInt32LE(0) !== 1 || !take(32).equals(key(PublicKey, sourceMint, 'AGTMAI mint').toBuffer()) ||
      take(8).readBigUInt64LE(0) !== sourceAmount || !take(32).equals(key(PublicKey, feeMint, 'fee mint').toBuffer())) {
    fail('ccip_send token amount or fee mint mismatch');
  }
  vec(); // Extra args are frozen by the exact send-data hash.
  const tokenIndexes = vec();
  if (offset !== data.length || !tokenIndexes.equals(Buffer.from([0]))) fail('ccip_send token indexes or trailing data invalid');
}

/**
 * Instruction-only, local preparation profile. `send` and `accounts` must come from
 * a separately captured exact SDK candidate; this function makes no deployed-code claim.
 * It never accepts keys, signs, simulates, or submits a transaction.
 */
export function buildUnsignedSplFeeCapProof(provider, input) {
  const { PublicKey } = provider?.web3 ?? {};
  if (typeof PublicKey?.findProgramAddressSync !== 'function') fail('pinned Solana provider required');
  if (input?.testOnly !== true || input.routerProgram !== ROUTER_PROGRAM || input.feeQuoterProgram !== FEE_QUOTER_PROGRAM ||
      input.tokenProgram !== SPL_TOKEN_PROGRAM || input.sourceMint !== REVERSE.mint ||
      input.feeMint === input.sourceMint || input.feeMint === SYSTEM_PROGRAM || input.feeMint === REVERSE.nativeMint ||
      input.feeTokenProgram !== SPL_TOKEN_PROGRAM || input.sourceDecimals !== 9 ||
      !Number.isInteger(input.feeDecimals) || input.feeDecimals < 0 || input.feeDecimals > 18) {
    fail('unsupported program, source token or fee mint');
  }
  const sourceAmount = decimal(input.sourceAmount, 'AGTMAI amount');
  const cap = decimal(input.cap, 'fee cap');
  if (!Number.isSafeInteger(input.snapshotSlot) || input.snapshotSlot < 1 ||
      !Number.isSafeInteger(input.observedSlot) || input.observedSlot < input.snapshotSlot ||
      input.observedSlot - input.snapshotSlot > 32 ||
      !Number.isSafeInteger(input.validThroughSlot) || input.observedSlot > input.validThroughSlot ||
      input.validThroughSlot - input.snapshotSlot > 32) fail('stale or inconsistent snapshot');
  for (const [name, account] of Object.entries(input.state ?? {})) {
    if (account?.slot !== input.snapshotSlot) fail(`${name} was not captured at the same slot`);
  }
  const billingPda = PublicKey.findProgramAddressSync([Buffer.from('fee_billing_signer')],
    key(PublicKey, ROUTER_PROGRAM, 'Router'))[0].toBase58();
  if (input.billingPda !== billingPda || input.sourceAta !== ata(PublicKey, input.sourceMint, input.payer) ||
      input.feeAta !== ata(PublicKey, input.feeMint, input.payer) ||
      input.feeReceiverAta !== ata(PublicKey, input.feeMint, billingPda)) fail('PDA or ATA derivation mismatch');
  if (new Set([input.sourceMint, input.feeMint, input.sourceAta, input.feeAta, input.feeReceiverAta,
    input.payer, billingPda]).size !== 7) fail('conflicting account identity');
  const routerConfig = PublicKey.findProgramAddressSync([Buffer.from('config')],
    key(PublicKey, ROUTER_PROGRAM, 'Router'))[0].toBase58();
  routerState(PublicKey, input.state?.routerConfig, routerConfig);
  mintState(PublicKey, input.state?.sourceMint, input.sourceMint, 9, sourceAmount, 'AGTMAI mint');
  mintState(PublicKey, input.state?.feeMint, input.feeMint, input.feeDecimals, cap, 'fee mint');
  tokenState(PublicKey, input.state?.sourceAta, input.sourceAta, input.sourceMint, input.payer, sourceAmount, 'AGTMAI ATA');
  tokenState(PublicKey, input.state?.feeAta, input.feeAta, input.feeMint, input.payer, cap, 'fee ATA');
  tokenState(PublicKey, input.state?.feeReceiverAta, input.feeReceiverAta, input.feeMint, billingPda, 0n, 'fee receiver ATA');

  const send = input.send;
  if (!send || send.programId !== ROUTER_PROGRAM || !Array.isArray(send.accounts) || send.accounts.length !== 31 ||
      send.dataBase64 !== input.frozenSendDataBase64 || !Array.isArray(input.frozenSendAccounts) ||
      JSON.stringify(send.accounts) !== JSON.stringify(input.frozenSendAccounts)) fail('missing exact frozen SDK ccip_send');
  const sendBytes = canonicalBytes(send.dataBase64, 'ccip_send');
  if (digest(sendBytes) !== input.frozenSendSha256 ||
      digest(Buffer.from(JSON.stringify(send.accounts))) !== input.frozenSendAccountsSha256) fail('ccip_send hash mismatch');
  inspectSendData(PublicKey, sendBytes, input.sourceMint, input.feeMint, sourceAmount);
  const feeTokenConfig = PublicKey.findProgramAddressSync([Buffer.from('fee_billing_token_config'),
    key(PublicKey, input.feeMint, 'fee mint').toBuffer()], key(PublicKey, FEE_QUOTER_PROGRAM, 'Fee Quoter'))[0].toBase58();
  feeConfigState(input.state?.feeTokenConfig, feeTokenConfig);
  const anchors = new Map([[0, meta(routerConfig)], [3, meta(input.payer, true, true)], [4, meta(SYSTEM_PROGRAM)],
    [5, meta(SPL_TOKEN_PROGRAM)], [6, meta(input.feeMint)], [7, meta(input.feeAta, true)],
    [8, meta(input.feeReceiverAta, true)], [9, meta(billingPda)], [10, meta(FEE_QUOTER_PROGRAM)],
    [13, meta(feeTokenConfig)], [18, meta(input.sourceAta, true)]]);
  for (const [index, expected] of anchors) {
    if (JSON.stringify(send.accounts[index]) !== JSON.stringify(expected)) fail(`ccip_send account ${index} mismatch`);
  }
  for (const account of send.accounts) {
    key(PublicKey, account?.address, 'ccip_send account');
    if (typeof account.isWritable !== 'boolean' || typeof account.isSigner !== 'boolean') fail('invalid ccip_send privileges');
  }
  const approve = (tokenAta, mint, amount, decimals) => instruction(SPL_TOKEN_PROGRAM,
    [meta(tokenAta, true), meta(mint), meta(billingPda), meta(input.payer, false, true)],
    Buffer.concat([Buffer.from([13]), u64(amount), Buffer.from([decimals])]));
  const revoke = tokenAta => instruction(SPL_TOKEN_PROGRAM,
    [meta(tokenAta, true), meta(input.payer, false, true)], Buffer.from([5]));
  const instructions = [approve(input.sourceAta, input.sourceMint, sourceAmount, 9),
    approve(input.feeAta, input.feeMint, cap, input.feeDecimals),
    structuredClone(send), revoke(input.feeAta), revoke(input.sourceAta)];
  return Object.freeze({ schema: 'agtmai-unsigned-spl-fee-cap-proof-v1', qualification: 'local-instruction-candidate-only',
    payer: input.payer, snapshotSlot: input.snapshotSlot, validThroughSlot: input.validThroughSlot,
    instructions: Object.freeze(instructions.map(ix => Object.freeze({ ...ix, accounts: Object.freeze(ix.accounts.map(a => Object.freeze(a))) }))) });
}

export function verifyUnsignedSplFeeCapProof(provider, input, candidate) {
  const expected = buildUnsignedSplFeeCapProof(provider, input);
  if (JSON.stringify(candidate) !== JSON.stringify(expected)) fail('alternate instruction, target, order or envelope');
  return expected;
}

/** Compile the five instructions as one unsigned v0 packet for local simulation only. */
export function compileUnsignedSplFeeCapProof(provider, input, blockhash, lookupTable) {
  const proof = buildUnsignedSplFeeCapProof(provider, input);
  const { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } = provider.web3;
  key(PublicKey, blockhash, 'recent blockhash');
  const addresses = proof.instructions[2].accounts.slice(21).map(account => account.address);
  if (!lookupTable || lookupTable.key?.toBase58() !== addresses[0] ||
      JSON.stringify(lookupTable.state?.addresses?.map(address => address.toBase58())) !== JSON.stringify(addresses) ||
      lookupTable.state?.deactivationSlot !== U64_MAX ||
      lookupTable.state?.authority?.toBase58() !== input.payer ||
      !Number.isSafeInteger(lookupTable.state?.lastExtendedSlot) ||
      lookupTable.state.lastExtendedSlot >= input.snapshotSlot) fail('missing exact active ALT');
  const native = proof.instructions.map(ix => new TransactionInstruction({
    programId: key(PublicKey, ix.programId, 'instruction program'), data: canonicalBytes(ix.dataBase64, 'instruction'),
    keys: ix.accounts.map(account => ({ pubkey: key(PublicKey, account.address, 'instruction account'),
      isSigner: account.isSigner, isWritable: account.isWritable })),
  }));
  const message = new TransactionMessage({ payerKey: key(PublicKey, input.payer, 'payer'),
    recentBlockhash: blockhash, instructions: native }).compileToV0Message([lookupTable]);
  if (message.header.numRequiredSignatures !== 1 || message.staticAccountKeys[0].toBase58() !== input.payer) {
    fail('unexpected signer privilege');
  }
  const transaction = new VersionedTransaction(message);
  const bytes = Buffer.from(transaction.serialize());
  if (bytes.length > 1232 || transaction.signatures.length !== 1 ||
      !Buffer.from(transaction.signatures[0]).equals(Buffer.alloc(64))) fail('oversized or signed transaction');
  return Object.freeze({ schema: 'agtmai-unsigned-spl-fee-cap-packet-v1',
    qualification: 'local-simulation-only', bytesBase64: bytes.toString('base64'),
    messageSha256: digest(Buffer.from(message.serialize())), packetBytes: bytes.length,
    snapshotSlot: proof.snapshotSlot, validThroughSlot: proof.validThroughSlot });
}

/** Public entrypoint for this proof slice: load the existing hash-pinned provider. */
export async function createPinnedUnsignedSplFeeCapProof(providerDirectory) {
  const provider = await loadSolanaProvider(providerDirectory);
  return Object.freeze({
    build: input => buildUnsignedSplFeeCapProof(provider, input),
    verify: (input, candidate) => verifyUnsignedSplFeeCapProof(provider, input, candidate),
    compile: (input, blockhash, lookupTable) => compileUnsignedSplFeeCapProof(provider, input, blockhash, lookupTable),
  });
}
