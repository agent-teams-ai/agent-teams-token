import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createSolanaReverseSdk, type Candidate } from '../src/adapters/solana-reverse-sdk.mjs';
import { reverseInstructions } from '../src/domain/solana-reverse.mjs';
import { altAddresses } from '../src/domain/solana-pool-config.ts';
import type { MintInstruction } from '../src/domain/solana-mint.ts';
// Retained public generateUnsignedSendMessage payload, 2026-09-08T03:22:54.531Z.
// This legacy compiler/IDL unit is separate from admitted native SDK traffic qualification.
const capturedSendHex = '6cd886bff9ea2154d91ad9c94fba41de20000000000000000000000000000000275ee728c49100b56d4aa37c00e2dc8ffc5e5df60000000001000000009d49372ba9140a49e384e7a023a8f5273e7b1b9f87033ceb5ce59c116e900200ca9a3b00000000000000000000000000000000000000000000000000000000000000000000000015000000181dcf1000000000000000000000000000000000010100000000';
const provider = process.env.AGTMAI_TEST_SOLANA_PROVIDER, ccip = process.env.AGTMAI_TEST_CCIP_PROVIDER;
test('legacy native compiler rejects hidden instructions, lookup substitution, signer changes and invalid signatures', { skip: !provider || !ccip }, async () => {
  assert.ok(provider && ccip);
  const sdk = await createSolanaReverseSdk({ providerDirectory: provider, ccipProviderDirectory: ccip, recentSlot: '1' });
  const require = createRequire(resolve(provider, 'package.json'));
  const web3: typeof import('../../../.local/INPUT/provider/node_modules/@solana/web3.js/lib/index.js') = require('@solana/web3.js');
  const { PublicKey, TransactionInstruction, VersionedTransaction, AddressLookupTableAccount } = web3;
  const expected = sdk.derive('So11111111111111111111111111111111111111112', { approval: true, quotedFee: '5', sourceLamports: '1000000' });
  assert.ok(expected.alt);
  const native = (ix: MintInstruction) => new TransactionInstruction({ programId: new PublicKey(ix.programId), data: Buffer.from(ix.dataBase64, 'base64'),
    keys: ix.accounts.map(a => ({ pubkey: new PublicKey(a.address), isSigner: a.isSigner, isWritable: a.isWritable })) });
  const lookup = new AddressLookupTableAccount({ key: new PublicKey(expected.alt), state: { deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 1,
    lastExtendedSlotStartIndex: 0, authority: new PublicKey(expected.payer), addresses: altAddresses(expected).map(a => new PublicKey(a)) } });
  const candidate: Candidate = { family: 'SVM', mainIndex: 1, instructions: reverseInstructions(expected).map((ix: MintInstruction, i: number) =>
    native(i === 1 ? { ...ix, dataBase64: Buffer.from(capturedSendHex, 'hex').toString('base64') } : ix)), lookupTables: [lookup] };
  // Independently selected synthetic state for this compiler unit, not public TEST evidence.
  const snapshot = { slot: '2', lookupTable: new AddressLookupTableAccount({ key: new PublicKey(expected.alt), state: {
    deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0,
    authority: new PublicKey(expected.payer), addresses: altAddresses(expected).map(a => new PublicKey(a)),
  } }) };
  const ccipRequire = createRequire(resolve(ccip, 'package.json'));
  const anchor: typeof import('../../../.local/INPUT/provider/node_modules/@coral-xyz/anchor/dist/cjs/index.js') = ccipRequire('@coral-xyz/anchor');
  const { BorshInstructionCoder } = anchor;
  const BN: typeof anchor.BN = ccipRequire('bn.js');
  const official: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js') =
    await import(pathToFileURL(ccipRequire.resolve('@chainlink/ccip-sdk/dist/solana/index.js')).href);
  const idl: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js') =
    await import(pathToFileURL(resolve(ccip, 'node_modules/@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js')).href);
  const { IDL } = idl;
  const officialData = new BorshInstructionCoder(IDL).encode('ccipSend', { destChainSelector: new BN('16015286601757825753'),
    message: { receiver: Buffer.from('000000000000000000000000275ee728c49100b56d4aa37c00e2dc8ffc5e5df6', 'hex'), data: Buffer.alloc(0),
      tokenAmounts: [{ token: new PublicKey(expected.mint), amount: new BN('1000000000') }], feeToken: new PublicKey('11111111111111111111111111111111'),
      extraArgs: Buffer.from(official.SolanaChain.encodeExtraArgs({ gasLimit: 0n, allowOutOfOrderExecution: true }).slice(2), 'hex') }, tokenIndexes: Buffer.from([0]) });
  const send = candidate.instructions[1], approval = candidate.instructions[0]; assert.ok(send && approval);
  assert.deepEqual(send.data, officialData, 'Independent Borsh bytes must match pinned official SDK/IDL');
  const definition = IDL.instructions.find(ix => ix.name === 'ccipSend'); assert.ok(definition);
  assert.deepEqual(send.keys.slice(0, 18).map(k => [k.isWritable, k.isSigner]), definition.accounts.map(a => [a.isMut, a.isSigner]));
  const latest = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: '100' };
  const built = sdk.build(candidate, expected, latest, snapshot), bytes = Buffer.from(built.bytesBase64, 'base64');
  assert.ok(bytes.length <= 1232); assert.throws(() => sdk.inspectSigned(built.bytesBase64, expected, snapshot), /signature/);
  // Existing opt-in operator case. Worker execution must never enable this signing arm.
  const payerFile = process.env.AGTMAI_TEST_SOLANA_PAYER_FILE;
  if (payerFile) {
    assert.ok('sign' in sdk);
    const signed = await sdk.sign(built, expected, { testOnly: true, payerFile }, snapshot);
    const inspected = sdk.inspectSigned(signed.bytesBase64, expected, snapshot);
    assert.equal(inspected.signature, signed.signature); assert.equal(inspected.messageBase64, built.messageBase64);
    const corrupted = Buffer.from(signed.bytesBase64, 'base64'); const first = corrupted[1]; assert.ok(first !== undefined); corrupted[1] = first ^ 1;
    assert.throws(() => sdk.inspectSigned(corrupted.toString('base64'), expected, snapshot), /signature/);
  }
  const mutations: ((tx: InstanceType<typeof VersionedTransaction>) => void)[] = [
    tx => { const ix = tx.message.compiledInstructions[1]; assert.ok(ix); const first = ix.data[0]; assert.ok(first !== undefined); ix.data[0] = first ^ 1; },
    tx => { const table = tx.message.addressTableLookups[0]; assert.ok(table); const first = table.writableIndexes[0]; assert.ok(first !== undefined); table.writableIndexes[0] = first ^ 1; },
    tx => { tx.message.header.numRequiredSignatures = 2; },
    tx => { tx.message.staticAccountKeys[0] = new PublicKey(expected.mint); },
  ];
  for (const mutate of mutations) {
    const tx = VersionedTransaction.deserialize(bytes); mutate(tx);
    assert.throws(() => sdk.inspectSigned(Buffer.from(tx.serialize()).toString('base64'), expected, snapshot));
  }
  const captured = Buffer.from(capturedSendHex, 'hex');
  const raw20 = Buffer.concat([captured.subarray(0, 16), Buffer.from('14000000', 'hex'), captured.subarray(32)]);
  const tampered = Buffer.from(captured); const recipientByte = tampered[51]; assert.ok(recipientByte !== undefined); tampered[51] = recipientByte ^ 1;
  const padding = Buffer.from(captured); padding[20] = 1;
  for (const data of [raw20, tampered, padding]) {
    const instructions = candidate.instructions.map((ix, i) => i === 1 ? new TransactionInstruction({ ...ix, data }) : ix);
    assert.throws(() => sdk.build({ ...candidate, instructions }, expected, latest, snapshot), /payload/);
    const tx = VersionedTransaction.deserialize(bytes), ix = tx.message.compiledInstructions[1]; assert.ok(ix); ix.data = data;
    assert.throws(() => sdk.inspectSigned(Buffer.from(tx.serialize()).toString('base64'), expected, snapshot), /Unexpected v0/);
  }
  assert.throws(() => sdk.build({ ...candidate, instructions: [...candidate.instructions, approval] }, expected, latest, snapshot), /instruction list/);
  lookup.state.addresses[2] = new PublicKey(expected.payer);
  assert.throws(() => sdk.build(candidate, expected, latest, snapshot), /ALT/);
  assert.throws(() => sdk.validateExpected({ ...expected, spender: expected.payer }), /derived identity/);
});
