import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createForwardDecoder } from '../src/adapters/evm-forward-sdk.mjs';
import { FORWARD, FORWARD_RECIPIENT_B, forwardIntent } from '../src/domain/evm-forward.mjs';
import { transferEvmForward } from '../src/composition/transfer-evm-forward.mjs';
import { validateSepoliaIntent } from '../src/domain/evm-intent.ts';
const directory = process.env.AGTMAI_TEST_CCIP_PROVIDER;
test('native ABI A/B recipients remain disjoint and cross-journals fail before approval reconciliation', { skip: !directory }, async () => {
  const require = createRequire(resolve(directory, 'package.json')), ethers = require('ethers');
  const { PublicKey } = require('@solana/web3.js');
  const iface = new ethers.Interface(['function ccipSend(uint64,(bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs))']);
  const tx = recipient => ({ from: FORWARD.administrator, to: FORWARD.router, value: 5n,
    data: iface.encodeFunctionData('ccipSend', [FORWARD.selector,
      ['0x' + '00'.repeat(32), '0x', [[FORWARD.token, FORWARD.amount]], ethers.ZeroAddress,
        '0x1f3b3aba' + ethers.AbiCoder.defaultAbiCoder().encode(['tuple(uint32,uint64,bool,bytes32,bytes32[])'],
          [[0n, 0n, true, '0x' + new PublicKey(recipient).toBuffer().toString('hex'), []]]).slice(2)]]) });
  const a = tx(FORWARD.recipient), b = tx(FORWARD_RECIPIENT_B);
  assert.notEqual(a.data, b.data);
  const defaultA = createForwardDecoder(ethers), decoderB = createForwardDecoder(ethers, FORWARD_RECIPIENT_B);
  defaultA(a, 'send', 5n); decoderB(b, 'send', 5n);
  const approve = { from: FORWARD.administrator, to: FORWARD.token,
    data: new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [FORWARD.router, FORWARD.amount]) };
  defaultA(approve, 'approval', 0n); decoderB(approve, 'approval', 0n);

  assert.throws(() => defaultA(b, 'send', 5n), /decoded forward/);
  assert.throws(() => decoderB(a, 'send', 5n), /decoded forward/);
  for (const [stored, recipient] of [[a, FORWARD_RECIPIENT_B], [b, undefined]]) {
    const intent = forwardIntent(stored, '8');
    let executions = 0;
    const settings = { testOnly: true, signer: { testOnly: true }, recipient, approvalNonce: '7', sendNonce: '8',
      approvalJournal: '/tmp/test-only-cross/approval', sendJournal: '/tmp/test-only-cross/send' };
    const ports = { exclusive: async (_path, work) => work(),
      sdk: async (_directory, selected) => ({ verify: createForwardDecoder(ethers, selected), destroy: async () => {} }),
      read: async path => path === settings.sendJournal ? { intent: validateSepoliaIntent(intent, intent), phase: 'submitted' }
        : { phase: 'signed', intent: { value: '0' } },
      execute: async () => { executions++; throw new Error('must not reconcile or broadcast approval'); } };
    await assert.rejects(transferEvmForward(settings, ports), /decoded forward/);
    assert.equal(executions, 0);
  }
});
