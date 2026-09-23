import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildUnsignedSplFeeCapProof, compileUnsignedSplFeeCapProof,
  verifyUnsignedSplFeeCapProof } from '../src/adapters/solana-spl-fee-cap-proof.mjs';
import { REVERSE } from '../src/domain/solana-reverse.mjs';
import { ROUTER_PROGRAM } from '../src/domain/solana-registration.ts';
import { FEE_QUOTER_PROGRAM } from '../src/domain/solana-pool-config.ts';
import { SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM } from '../src/domain/solana-mint.ts';

// These are synthetic local account bytes. They never assert deployed Router behavior.
const providerDirectory = process.env.AGTMAI_TEST_SOLANA_PROVIDER;
let web3;
if (providerDirectory) {
  try { web3 = createRequire(resolve(providerDirectory, 'package.json'))('@solana/web3.js'); } catch { /* Explicitly pending provider prerequisite. */ }
}
const sha = b => createHash('sha256').update(b).digest('hex');
const k = (PublicKey, n) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const pda = (PublicKey, program, ...seeds) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58();
const ata = (PublicKey, mint, owner) => pda(PublicKey, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  new PublicKey(owner).toBuffer(), new PublicKey(SPL_TOKEN_PROGRAM).toBuffer(), new PublicKey(mint).toBuffer());
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const vec = b => Buffer.concat([u32(b.length), b]);
const meta = (address, isWritable = false, isSigner = false) => ({ address, isWritable, isSigner });
const raw = (address, owner, bytes) => ({ address, owner, executable: false,
  slot: 100, dataBase64: bytes.toString('base64'), sha256: sha(bytes) });
const splMint = (decimals, supply) => {
  const bytes = Buffer.alloc(82); bytes.writeBigUInt64LE(BigInt(supply), 36); bytes[44] = decimals; bytes[45] = 1; return bytes;
};
const splAccount = (PublicKey, mint, owner, balance) => {
  const bytes = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(bytes, 0);
  new PublicKey(owner).toBuffer().copy(bytes, 32);
  bytes.writeBigUInt64LE(BigInt(balance), 64); bytes[108] = 1;
  return bytes;
};
function fixture(PublicKey, cap = '500') {
  const payer = REVERSE.payer, feeMint = k(PublicKey, 44);
  const billingPda = pda(PublicKey, ROUTER_PROGRAM, Buffer.from('fee_billing_signer'));
  const routerConfig = pda(PublicKey, ROUTER_PROGRAM, Buffer.from('config'));
  const sourceAta = ata(PublicKey, REVERSE.mint, payer), feeAta = ata(PublicKey, feeMint, payer);
  const feeReceiverAta = ata(PublicKey, feeMint, billingPda);
  const feeTokenConfig = pda(PublicKey, FEE_QUOTER_PROGRAM, Buffer.from('fee_billing_token_config'), new PublicKey(feeMint).toBuffer());
  const addresses = Array.from({ length: 31 }, (_, i) => k(PublicKey, i + 60));
  const accounts = addresses.map(address => meta(address));
  accounts[0] = meta(routerConfig); accounts[3] = meta(payer, true, true);
  accounts[4] = meta(SYSTEM_PROGRAM); accounts[5] = meta(SPL_TOKEN_PROGRAM);
  accounts[6] = meta(feeMint); accounts[7] = meta(feeAta, true);
  accounts[8] = meta(feeReceiverAta, true); accounts[9] = meta(billingPda);
  accounts[10] = meta(FEE_QUOTER_PROGRAM); accounts[13] = meta(feeTokenConfig);
  accounts[18] = meta(sourceAta, true);
  const sendData = Buffer.concat([createHash('sha256').update('global:ccip_send').digest().subarray(0, 8),
    u64('5009297550715157269'), vec(Buffer.alloc(32, 9)), vec(Buffer.alloc(0)), u32(1),
    new PublicKey(REVERSE.mint).toBuffer(), u64('1000000000'), new PublicKey(feeMint).toBuffer(),
    vec(Buffer.from('181dcf100000000000000000000000000000000001', 'hex')), vec(Buffer.from([0]))]);
  const config = Buffer.alloc(210);
  createHash('sha256').update('account:Config').digest().subarray(0, 8).copy(config);
  config[8] = 1; config[9] = 1;
  new PublicKey(FEE_QUOTER_PROGRAM).toBuffer().copy(config, 82);
  const send = { programId: ROUTER_PROGRAM, accounts, dataBase64: sendData.toString('base64') };
  return { testOnly: true, routerProgram: ROUTER_PROGRAM, feeQuoterProgram: FEE_QUOTER_PROGRAM,
    tokenProgram: SPL_TOKEN_PROGRAM, feeTokenProgram: SPL_TOKEN_PROGRAM,
    payer, sourceMint: REVERSE.mint, sourceDecimals: 9, sourceAmount: '1000000000',
    feeMint, feeDecimals: 6, cap, billingPda, sourceAta, feeAta, feeReceiverAta,
    snapshotSlot: 100, observedSlot: 101, validThroughSlot: 120,
    state: { routerConfig: raw(routerConfig, ROUTER_PROGRAM, config),
      feeTokenConfig: raw(feeTokenConfig, FEE_QUOTER_PROGRAM, Buffer.alloc(64, 1)),
      sourceMint: raw(REVERSE.mint, SPL_TOKEN_PROGRAM, splMint(9, '1000000000')),
      feeMint: raw(feeMint, SPL_TOKEN_PROGRAM, splMint(6, '1000000')),
      sourceAta: raw(sourceAta, SPL_TOKEN_PROGRAM, splAccount(PublicKey, REVERSE.mint, payer, '1000000000')),
      feeAta: raw(feeAta, SPL_TOKEN_PROGRAM, splAccount(PublicKey, feeMint, payer, '1000000')),
      feeReceiverAta: raw(feeReceiverAta, SPL_TOKEN_PROGRAM, splAccount(PublicKey, feeMint, billingPda, '0')) },
    send, frozenSendDataBase64: send.dataBase64, frozenSendSha256: sha(sendData),
    frozenSendAccounts: structuredClone(accounts), frozenSendAccountsSha256: sha(Buffer.from(JSON.stringify(accounts))) };
}
const provider = web3 && { web3 };
test('synthetic SPL fee cap builds five exact instructions for below, equal and above illustrative quote',
  { skip: !provider }, () => {
    for (const cap of ['499', '500', '501']) {
      const input = fixture(web3.PublicKey, cap), proof = buildUnsignedSplFeeCapProof(provider, input);
      assert.equal(proof.qualification, 'local-instruction-candidate-only');
      assert.deepEqual(proof.instructions.map(ix => ix.programId),
        [SPL_TOKEN_PROGRAM, SPL_TOKEN_PROGRAM, ROUTER_PROGRAM, SPL_TOKEN_PROGRAM, SPL_TOKEN_PROGRAM]);
      const [source, fee, send, revokeFee, revokeSource] = proof.instructions;
      assert.deepEqual(source.accounts.map(a => a.address), [input.sourceAta, input.sourceMint, input.billingPda, input.payer]);
      assert.deepEqual(fee.accounts.map(a => a.address), [input.feeAta, input.feeMint, input.billingPda, input.payer]);
      assert.deepEqual(Buffer.from(source.dataBase64, 'base64'), Buffer.concat([Buffer.from([13]), u64('1000000000'), Buffer.from([9])]));
      assert.deepEqual(Buffer.from(fee.dataBase64, 'base64'), Buffer.concat([Buffer.from([13]), u64(cap), Buffer.from([6])]));
      assert.equal(send.dataBase64, input.frozenSendDataBase64);
      assert.deepEqual(revokeFee.accounts.map(a => a.address), [input.feeAta, input.payer]);
      assert.deepEqual(revokeSource.accounts.map(a => a.address), [input.sourceAta, input.payer]);
      assert.equal(revokeFee.dataBase64, 'BQ=='); assert.equal(revokeSource.dataBase64, 'BQ==');
      verifyUnsignedSplFeeCapProof(provider, input, proof);
      // 500 is an illustrative integer only; execution-time quote effects require a real bank.
      assert.equal(BigInt(cap) < 500n, cap === '499');
    }
  });
test('rejects mutation of order, bytes, authority, mint, ATA, PDA, stale inputs and pre-existing delegation',
  { skip: !provider }, () => {
    const input = fixture(web3.PublicKey), proof = buildUnsignedSplFeeCapProof(provider, input);
    for (const mutate of [
      p => p.instructions.reverse(), p => p.instructions.push(p.instructions[0]),
      p => p.instructions[0].accounts[2].address = input.payer,
      p => p.instructions[1].dataBase64 = 'AA==',
      p => p.instructions[2].accounts[8].address = input.payer,
      p => p.instructions[3].accounts[0].address = input.sourceAta,
      p => p.instructions[4].programId = ROUTER_PROGRAM,
    ]) {
      const changed = structuredClone(proof); mutate(changed);
      assert.throws(() => verifyUnsignedSplFeeCapProof(provider, input, changed));
    }
    const invalid = [
      i => i.feeTokenProgram = k(web3.PublicKey, 22),
      i => i.feeMint = REVERSE.nativeMint,
      i => i.feeMint = REVERSE.mint,
      i => i.billingPda = i.payer,
      i => i.feeAta = i.sourceAta,
      i => i.send.accounts[7].address = i.payer,
      i => i.send.accounts[13].address = i.payer,
      i => i.send.dataBase64 = 'AA==',
      i => i.observedSlot = 133,
      i => i.state.feeMint.owner = k(web3.PublicKey, 19),
      i => i.state.feeTokenConfig.owner = k(web3.PublicKey, 19),
      i => delete i.state.feeTokenConfig,
      i => delete i.state.feeReceiverAta,
      i => i.state.sourceAta.owner = k(web3.PublicKey, 19),
      i => { const b = Buffer.from(i.state.feeAta.dataBase64, 'base64'); b.writeUInt32LE(1, 72); i.state.feeAta.dataBase64 = b.toString('base64'); i.state.feeAta.sha256 = sha(b); },
      i => { const b = Buffer.from(i.state.sourceAta.dataBase64, 'base64'); b.writeUInt32LE(1, 72); i.state.sourceAta.dataBase64 = b.toString('base64'); i.state.sourceAta.sha256 = sha(b); },
      i => { const b = Buffer.from(i.state.routerConfig.dataBase64, 'base64'); b[82] ^= 1; i.state.routerConfig.dataBase64 = b.toString('base64'); i.state.routerConfig.sha256 = sha(b); },
    ];
    for (const mutate of invalid) {
      const changed = structuredClone(input); mutate(changed);
      assert.throws(() => buildUnsignedSplFeeCapProof(provider, changed));
    }
  });
test('compilation is one unsigned packet with one signer and exact ALT', { skip: !provider }, () => {
  const input = fixture(web3.PublicKey);
  const { AddressLookupTableAccount, VersionedTransaction } = web3;
  const addresses = input.send.accounts.slice(21).map(a => new web3.PublicKey(a.address));
  const table = new AddressLookupTableAccount({ key: addresses[0], state: {
    deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0,
    authority: new web3.PublicKey(input.payer), addresses,
  } });
  const packet = compileUnsignedSplFeeCapProof(provider, input, SYSTEM_PROGRAM, table);
  const tx = VersionedTransaction.deserialize(Buffer.from(packet.bytesBase64, 'base64'));
  assert.equal(packet.qualification, 'local-simulation-only');
  assert.equal(tx.message.compiledInstructions.length, 5);
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  assert.deepEqual(Buffer.from(tx.signatures[0]), Buffer.alloc(64));
  assert.ok(packet.packetBytes <= 1232);
  const wrong = new AddressLookupTableAccount({ key: addresses[0], state: { ...table.state, addresses: addresses.slice(1) } });
  assert.throws(() => compileUnsignedSplFeeCapProof(provider, input, SYSTEM_PROGRAM, wrong));
});
