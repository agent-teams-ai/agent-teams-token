import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAbi32EvmReceiver, buildUnsignedSplFeeCapProof,
  compileUnsignedSplFeeCapProof, splFeeCapInstructions,
  verifyUnsignedSplFeeCapProof } from '../src/adapters/solana-spl-fee-cap-proof.mjs';
import { SPL_TOKEN_PROGRAM } from '../src/domain/solana-mint.ts';

// These tests cover the public classic SPL Token instruction encoding only.
// Sample account keys come from the retained reverse-native-burn.json record;
// no fee ATA association is inferred from those sample keys.
// An authenticated 31-account SDK send candidate and deployed fee behavior
// remain pending; neither is synthesized as a passing fixture here.
const input = Object.freeze({
  payer: '8T13W72sSEKmBpEv1FpUM7nJRatnChEfPSjkbSpdUn9t',
  sourceMint: '13Q74er9thh3my9oACjChDhtn4znJibWBp1u8q1rAYau',
  sourceAta: 'BDW4fQh6QGDnTbZATEjTCcu1PQaKvKSE5GzmQTGe9Kvh',
  feeMint: 'ESAj1fV8Wb72XU2haE2nbrc46wL3gHpwWQfoVsPnzrTY',
  feeAta: '5GoY6aNRFwQonLxjScU9jJC3BbzGFiQup2CSGiJkBJsQ',
  billingPda: '2AjuzTy6z2webxEUu7eZ1DkAyLagZaqH2dgzhbBYjJiG',
  sourceAmount: '1000000000', feeDecimals: 6, cap: '500',
});
const account = (address, isWritable = false, isSigner = false) => ({ address, isWritable, isSigner });

test('classic SPL ApproveChecked and Revoke use fixed public bytes, order and privileges', () => {
  const [source, fee, revokeFee, revokeSource] = splFeeCapInstructions(input);
  assert.deepEqual([source, fee, revokeFee, revokeSource].map(ix => ix.programId),
    [SPL_TOKEN_PROGRAM, SPL_TOKEN_PROGRAM, SPL_TOKEN_PROGRAM, SPL_TOKEN_PROGRAM]);
  assert.deepEqual(source.accounts, [account(input.sourceAta, true), account(input.sourceMint),
    account(input.billingPda), account(input.payer, false, true)]);
  assert.deepEqual(fee.accounts, [account(input.feeAta, true), account(input.feeMint),
    account(input.billingPda), account(input.payer, false, true)]);
  assert.deepEqual(revokeFee.accounts, [account(input.feeAta, true), account(input.payer, false, true)]);
  assert.deepEqual(revokeSource.accounts, [account(input.sourceAta, true), account(input.payer, false, true)]);
  // SPL Token instruction enum: ApproveChecked = 13, Revoke = 5;
  // amounts are independently written here as little-endian u64 vectors.
  assert.equal(Buffer.from(source.dataBase64, 'base64').toString('hex'), '0d00ca9a3b0000000009');
  assert.equal(Buffer.from(fee.dataBase64, 'base64').toString('hex'), '0df40100000000000006');
  assert.equal(Buffer.from(revokeFee.dataBase64, 'base64').toString('hex'), '05');
  assert.equal(Buffer.from(revokeSource.dataBase64, 'base64').toString('hex'), '05');
});

test('illustrative fee caps change only the delegated u64 and invalid caps fail', () => {
  for (const [cap, bytes] of [['499', '0df30100000000000006'],
    ['500', '0df40100000000000006'], ['501', '0df50100000000000006']]) {
    const [source, fee, revokeFee, revokeSource] = splFeeCapInstructions({ ...input, cap });
    assert.equal(Buffer.from(fee.dataBase64, 'base64').toString('hex'), bytes);
    assert.equal(Buffer.from(source.dataBase64, 'base64').toString('hex'), '0d00ca9a3b0000000009');
    assert.equal(revokeFee.dataBase64, 'BQ==');
    assert.equal(revokeSource.dataBase64, 'BQ==');
  }
  for (const cap of ['0', '-1', '01', '18446744073709551616', 500]) {
    assert.throws(() => splFeeCapInstructions({ ...input, cap }), /fee cap/);
  }
  assert.throws(() => splFeeCapInstructions({ ...input, feeDecimals: 256 }), /fee decimals/);
});

test('receiver is a zero-padded nonzero 20-byte EVM address', () => {
  const address = Buffer.from('275ee728c49100b56d4aa37c00e2dc8ffc5e5df6', 'hex');
  const receiver = Buffer.concat([Buffer.alloc(12), address]);
  assert.doesNotThrow(() => assertAbi32EvmReceiver(receiver));
  const padding = Buffer.from(receiver); padding[0] = 1;
  for (const wrong of [padding, Buffer.alloc(32, 9), address, Buffer.alloc(32), '0x275ee728']) {
    assert.throws(() => assertAbi32EvmReceiver(wrong), /receiver/);
  }
});

test('full send and packet preparation fail closed without an authenticated pinned provider', () => {
  assert.throws(() => buildUnsignedSplFeeCapProof(undefined, input), /pinned Solana provider required/);
  assert.throws(() => verifyUnsignedSplFeeCapProof(undefined, input, {}), /pinned Solana provider required/);
  assert.throws(() => compileUnsignedSplFeeCapProof(undefined, input, input.payer, {}), /pinned Solana provider required/);
});
