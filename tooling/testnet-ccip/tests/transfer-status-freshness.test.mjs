import test from 'node:test';
import assert from 'node:assert/strict';
import { accountTransfers } from '../src/domain/transfer-status.mjs';
import { projectMessage } from '../../../packages/domain/src/features/ccip-status/message.ts';

const observed = (direction, messageId = 'id', amount = 1_000_000_000n) => {
  const identity = { messageId, direction, amount, sourceToken: 'source', destinationToken: 'destination', recipient: 'recipient' };
  const [sourceChain, sourceKind, destinationChain, destinationKind] = direction === 'ethereum-to-solana' ?
    ['ethereum', 'lock', 'solana', 'mint'] : ['solana', 'burn', 'ethereum', 'release'];
  const event = (chain, kind) => ({ ...identity, chain, kind, transactionId: `${messageId}-${chain}`,
    eventIndex: 0, blockHash: `${messageId}-${chain}-block`, blockHeight: 1n, finality: 'finalized' });
  return { identity, source: event(sourceChain, sourceKind), destination: event(destinationChain, destinationKind) };
};
const settledTransfer = (direction, messageId = 'id') => {
  const { identity, source, destination } = observed(direction, messageId);
  return { ...projectMessage(identity, [source, destination]), events: [source, destination] };
};

async function freshnessFixture({ ethereum = '0x6553f100', solana = 1700000000, repeated = solana, endSlot = 21, missing } = {}) {
  const { createNativeStatus } = await import('../src/adapters/transfer-status-native.mjs');
  const calls = [];
  let supplies = 0;
  const fetcher = async (_, options) => {
    const { id, method, params } = JSON.parse(options.body);
    calls.push({ method, params });
    const results = { eth_chainId: '0xaa36a7', getGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      eth_getBlockByNumber: { hash: 'block', number: '0xa', timestamp: ethereum }, getSlot: 10,
      getAccountInfo: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint',
        info: { decimals: 9, isInitialized: true, freezeAuthority: null, mintAuthority: 'pool-signer' } } } } } };
    let result = results[method];
    if (method === 'eth_call') {
      assert.deepEqual(params[1], { blockHash: 'block', requireCanonical: true });
      result = params[0].data === '0x18160ddd' ? '0x174876e800' : '0x0';
    }
    if (method === 'getTokenSupply') { result = { context: { slot: supplies++ === 0 ? 20 : endSlot }, value: { decimals: 9, amount: '0' } }; }
    if (method === 'getBlockTime') {
      assert.ok(params[0] === 20 || params[0] === endSlot);
      result = params[0] === 20 ? solana : repeated;
    }
    if (missing === 'ethereum' && method === 'eth_getBlockByNumber') { delete result.timestamp; }
    if (missing === 'solana' && method === 'getBlockTime') { result = undefined; }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const native = createNativeStatus('https://sepolia.invalid', 'https://solana.invalid', { solanaSigner: 'pool-signer' }, fetcher, () => 1700000000000);
  return { snapshot: await native.snapshot(), calls };
}
test('current supply freshness accepts inclusive boundaries and audits actual supply slots', async () => {
  const { snapshot: value, calls } = await freshnessFixture({ ethereum: '0x' + (1700000000 - 1800).toString(16), solana: 1700000000 - 300 });
  assert.equal(accountTransfers([], value, true).status, 'exact');
  assert.equal(value.observedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(value.freshness.ethereum.ageSeconds, 1800);
  assert.equal(value.freshness.solana.ageSeconds, 300);
  assert.equal(value.freshness.solana.timestamp, 1699999700);
  assert.equal(value.freshness.solanaRepeated.slot, 21);
  assert.deepEqual(calls.filter(call => call.method === 'getBlockTime').map(call => call.params), [[20], [21]]);
  const frozen = await freshnessFixture({ endSlot: 20 });
  assert.equal(accountTransfers([], frozen.snapshot, true).status, 'exact');
  assert.deepEqual(frozen.calls.filter(call => call.method === 'getBlockTime').map(call => call.params), [[20]]);
});
test('frozen old RPC supply cannot be exact despite a fresh local observation', async () => {
  const { snapshot: value } = await freshnessFixture({ ethereum: '0x1', solana: 1, endSlot: 20 });
  assert.equal(value.coherent, false);
  assert.equal(accountTransfers([], value, true).status, 'unknown');
  assert.equal(value.freshness.ethereum.timestamp, 1);
  assert.equal(value.freshness.solana.fresh, false);
});
test('expired, future, missing and malformed current block times cannot be exact', async () => {
  for (const ethereum of ['0x' + (1700000000 - 1801).toString(16), '0x6553f101', null, '', '1700000000', 1700000000,
    '0x', '0x01', '-0x1', '0x1.1', ' 0x6553f100', '0x20000000000000', true, {}]) {
    const { snapshot: value } = await freshnessFixture({ ethereum });
    assert.equal(accountTransfers([], value, true).status, 'unknown', JSON.stringify(ethereum));
    assert.equal(value.freshness.ethereum.fresh, false);
  }
  for (const time of [1699999699, 1700000001, null, -1, 1700000000.5, '1700000000', '', true, {}, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ['solana', 'repeated']) {
      const { snapshot: value } = await freshnessFixture({ [field]: time });
      assert.equal(accountTransfers([], value, true).status, 'unknown', `${field}: ${JSON.stringify(time)}`);
    }
  }
});

test('missing Ethereum timestamp or unavailable Solana block time fails safely', async () => {
  const { snapshot: value } = await freshnessFixture({ missing: 'ethereum' });
  assert.equal(accountTransfers([], value, true).status, 'unknown');
  assert.equal(value.freshness.ethereum.timestamp, null);
  await assert.rejects(freshnessFixture({ missing: 'solana' }), /Invalid native RPC response/);
});

test('report finalization rechecks all observation ages after inspection and cleanup', async () => {
  const { finalizeStatusReport } = await import('../src/composition/transfer-status.mjs');
  for (const [field, limit] of [['ethereum', 1800], ['solana', 300], ['repeated', 300]]) {
    for (const phase of ['inspection', 'cleanup']) {
      for (const delay of [5000, 6000]) {
        let clock = 1700000000000;
        const timestamp = clock / 1000 - limit + 5;
        const options = { [field]: field === 'ethereum' ? '0x' + timestamp.toString(16) : timestamp };
        // Keep the other Solana observation independently fresh.
        if (field === 'solana') { options.repeated = 1700000000; }
        const { snapshot: value } = await freshnessFixture(options);
        assert.equal(accountTransfers([], value, true).status, 'exact');
        const original = structuredClone(value);
        const transfers = [settledTransfer('ethereum-to-solana', 'settled')];
        const order = [];
        const report = await finalizeStatusReport(async () => {
          order.push('inspect');
          await Promise.resolve();
          if (phase === 'inspection') { clock += delay; }
          return { transfers, snapshot: value };
        }, async () => {
          await Promise.resolve();
          order.push('cleanup');
          if (phase === 'cleanup') { clock += delay; }
        }, true, () => { order.push('clock'); return clock; });
        assert.deepEqual(order, ['inspect', 'cleanup', 'clock']);
        assert.equal(report.accounting.status, delay === 5000 ? 'exact' : 'unknown', `${field}/${phase}/${delay}`);
        assert.deepEqual(report.transfers, transfers);
        assert.deepEqual(value, original);
        if (delay === 5000) {
          const audited = report.accounting.snapshot;
          assert.equal(audited.observedAt, original.observedAt);
          assert.equal(audited.freshnessCheckedAt, new Date(clock).toISOString());
          assert.equal(audited.freshness[field === 'repeated' ? 'solanaRepeated' : field].ageSeconds, limit);
        }
      }
    }
  }
});

test('report finalization never restores incoherent or initially untrusted snapshots', async () => {
  const { finalizeStatusReport } = await import('../src/composition/transfer-status.mjs');
  for (const options of [{}, { ethereum: null }, { solana: null }, { repeated: null },
    { ethereum: '0x6553f101' }, { solana: 1700000001 }, { repeated: 1700000001 }]) {
    const { snapshot: value } = await freshnessFixture(options);
    value.coherent = false;
    const report = await finalizeStatusReport(async () => ({ transfers: [], snapshot: value }),
      async () => {}, true, () => 1700000006000);
    assert.equal(report.accounting.status, 'unknown');
  }
});
