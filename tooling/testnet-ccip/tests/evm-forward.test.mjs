import assert from 'node:assert/strict';
import test from 'node:test';
import { transferEvmForward } from '../src/composition/transfer-evm-forward.mjs';
import { FORWARD, FORWARD_RECIPIENT_B, forwardRecipient, boundedAllowance, forwardIntent, forwardTarget } from '../src/domain/evm-forward.mjs';
import { validateSepoliaIntent } from '../src/domain/evm-intent.ts';
import { SOLANA_REMOTE } from '../src/domain/evm-remote-config.ts';
const settings = { testOnly: true, signer: { testOnly: true }, approvalNonce: '7', sendNonce: '8',
  approvalJournal: '/tmp/test/approval', sendJournal: '/tmp/test/send' };
const rate = { enabled: true, capacity: SOLANA_REMOTE.capacity, rate: SOLANA_REMOTE.rate };
const snapshot = { registration: { chainId: '11155111', finalizedBlockHash: '0x' + 'aa'.repeat(32),
  token: FORWARD.token, tokenAdmin: FORWARD.administrator, administrator: FORWARD.administrator,
  pendingAdministrator: '0x' + '00'.repeat(20), tokenPool: FORWARD.pool, poolToken: FORWARD.token,
  poolOwner: FORWARD.administrator }, supported: true, pools: [SOLANA_REMOTE.pool], token: SOLANA_REMOTE.token,
  inbound: rate, outbound: rate };
const send = { from: FORWARD.administrator, to: FORWARD.router, data: '0x12345678', value: 5n };
const approval = { ...send, to: FORWARD.token, value: 0n };
function fixture(allowance = FORWARD.amount) {
  const executed = [], records = new Map();
  const sdk = { allowance: async () => allowance, verify: () => {},
    prepare: async () => ({ fee: 5n, send, approval: allowance < FORWARD.amount ? approval : null }), destroy: async () => {} };
  const ports = { sdk: async () => sdk, snapshot: async () => snapshot, read: async file => records.get(file) ?? null,
    exclusive: async (_file, work) => work(), execute: async (intent, config) => {
      executed.push({ intent, config }); return { status: 'unresolved', reason: 'submitted-awaiting-observation', transactionHash: '0x123' };
    } };
  return { ports, sdk, executed, records };
}
test('rejects unbounded allowance, unsafe settings, alias paths', async () => {
  assert.throws(() => boundedAllowance(FORWARD.amount + 1n));
  assert.throws(() => forwardTarget({ ...settings, sendNonce: '7' }));
  await assert.rejects(transferEvmForward({ ...settings, sendJournal: '/tmp/test/../test/approval' }), /alias/);
  const f = fixture(FORWARD.amount + 1n);
  await assert.rejects(transferEvmForward(settings, f.ports), /Unbounded/);
  assert.equal(f.executed.length, 0);
});
test('approval is separate checkpoint and send requires bounded allowance', async () => {
  const f = fixture(0n);
  assert.equal((await transferEvmForward(settings, f.ports)).step, 'approval');
  assert.equal(f.executed.length, 1);
  assert.equal(f.executed[0].intent.nonce, '7');
  const g = fixture();
  assert.equal((await transferEvmForward(settings, g.ports)).step, 'send');
  assert.equal(g.executed[0].intent.nonce, '8');
});
test('submitted send retains fee/calldata and reconciles without fresh quote or prerequisites', async () => {
  const f = fixture();
  const intent = forwardIntent(send, settings.sendNonce);
  f.records.set(settings.sendJournal, { intent: validateSepoliaIntent(intent, intent), phase: 'submitted' });
  f.ports.snapshot = f.sdk.prepare = f.sdk.allowance = async () => { throw new Error('must not call'); };
  await transferEvmForward(settings, f.ports);
  assert.deepEqual(f.executed[0].intent, intent);
});
test('signed send still requires current prerequisites and exact allowance', async () => {
  const f = fixture(0n), intent = forwardIntent(send, settings.sendNonce);
  f.records.set(settings.sendJournal, { intent: validateSepoliaIntent(intent, intent), phase: 'signed' });
  await assert.rejects(transferEvmForward(settings, f.ports), /allowance required/);
  assert.equal(f.executed.length, 0);
});
test('registered remote state is mandatory before preparing operations', async () => {
  const f = fixture(); f.ports.snapshot = async () => ({ ...snapshot, token: '0x' });
  await assert.rejects(transferEvmForward(settings, f.ports), /Conflicting/);
  assert.equal(f.executed.length, 0);
});

test('recipient B is explicit opt-in; default remains A and other recipients fail before provider access', async () => {
  assert.equal(forwardRecipient(), FORWARD.recipient);
  assert.equal(forwardRecipient(FORWARD_RECIPIENT_B), FORWARD_RECIPIENT_B);
  for (const recipient of [null, '', 'A', 'B', FORWARD.router, FORWARD.recipient + '1']) {
    assert.throws(() => forwardRecipient(recipient), /fixed forward recipients/);
    await assert.rejects(transferEvmForward({ ...settings, recipient }, { sdk: async () => { throw new Error('must not call'); } }), /fixed forward recipients/);
  }
  const f = fixture();
  f.ports.sdk = async (_directory, selected) => { assert.equal(selected, FORWARD_RECIPIENT_B); return f.sdk; };
  assert.equal((await transferEvmForward({ ...settings, recipient: FORWARD_RECIPIENT_B }, f.ports)).step, 'send');
});
