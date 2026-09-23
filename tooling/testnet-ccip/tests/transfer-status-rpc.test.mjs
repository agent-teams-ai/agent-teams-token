import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonRpc } from '../src/adapters/transfer-status-native.mjs';
import { accountTransfers } from '../src/domain/transfer-status.mjs';
import { projectMessage } from '../../../packages/domain/src/features/ccip-status/message.ts';

function rateResponse(id, status = 429, header = '10', extra = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 429, message: 'Connection rate limits exceeded' }, ...extra }),
    { status, headers: header === null ? {} : { 'Retry-After': header } });
}
function retryFixture(respond, waitError) {
  const requests = [], delays = [];
  const rpc = jsonRpc('https://rpc.invalid', async (_, options) => {
    requests.push(options);
    return respond(JSON.parse(options.body), requests.length);
  }, async delay => { delays.push(delay); if (waitError) { throw waitError; } });
  return { rpc, requests, delays };
}
test('native RPC retries HTTP and well-formed RPC 429 once with identical read arguments', async () => {
  for (const status of [429, 200]) {
    const f = retryFixture(({ id }, attempt) => attempt === 1 ? rateResponse(id, status) :
      new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { finalized: true } })));
    const params = ['Bsignature', { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }];
    assert.deepEqual(await f.rpc('getTransaction', params), { finalized: true });
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].body, f.requests[1].body);
    assert.deepEqual(JSON.parse(f.requests[1].body).params, params);
    assert.deepEqual(f.delays, [10000]);
    for (const request of f.requests) {
      assert.equal(request.redirect, 'error'); assert.equal(request.method, 'POST');
      assert.ok(request.signal instanceof AbortSignal);
    }
  }
});
test('native RPC repeated 429 stops at two requests and never returns error data', async () => {
  for (const status of [429, 200]) {
    const f = retryFixture(({ id }) => rateResponse(id, status, null));
    await assert.rejects(f.rpc('getTransaction', ['Bsignature']), /Invalid native RPC response/);
    assert.equal(f.requests.length, 2); assert.deepEqual(f.delays, [1000]);
  }
});
test('native RPC still validates retry response identity, version, HTTP and error', async () => {
  for (const [status, extra] of [[200, { id: 99, error: undefined, result: 'bad' }],
    [200, { jsonrpc: '1.0', error: undefined, result: 'bad' }], [503, { error: undefined, result: 'bad' }],
    [200, { error: { code: -1, message: 'failed' } }]]) {
    const f = retryFixture(({ id }, attempt) => attempt === 1 ? rateResponse(id) : rateResponse(id, status, null, extra));
    await assert.rejects(f.rpc('getTransaction', []), /Invalid native RPC response/);
    assert.equal(f.requests.length, 2);
  }
});
test('native RPC does not shorten excessive or invalid Retry-After', async () => {
  for (const header of ['11', '10.001', '-1', '', 'NaN', 'Infinity', 'tomorrow', '1e0']) {
    const f = retryFixture(({ id }) => rateResponse(id, 429, header));
    await assert.rejects(f.rpc('getTransaction', []));
    assert.equal(f.requests.length, 1); assert.deepEqual(f.delays, []);
  }
});
test('native RPC writes and unknown methods never retry', async () => {
  for (const method of ['sendTransaction', 'sendRawTransaction', 'eth_sendRawTransaction', 'unknown', 'getUnknown']) {
    for (const status of [429, 200]) {
      const f = retryFixture(({ id }) => rateResponse(id, status));
      await assert.rejects(f.rpc(method, ['unchanged']));
      assert.equal(f.requests.length, 1); assert.deepEqual(f.delays, []);
    }
  }
});
test('native RPC fetch errors and cancellation do not trigger another request', async () => {
  for (const method of ['getTransaction', 'sendTransaction', 'sendRawTransaction']) {
    for (const error of [new Error('fetch failed'), new DOMException('cancelled', 'AbortError')]) {
      const f = retryFixture(() => { throw error; });
      await assert.rejects(f.rpc(method, []), error);
      assert.equal(f.requests.length, 1); assert.deepEqual(f.delays, []);
    }
  }
  const error = new DOMException('cancelled', 'AbortError');
  const f = retryFixture(({ id }) => rateResponse(id), error);
  await assert.rejects(f.rpc('getTransaction', []), error);
  assert.equal(f.requests.length, 1);
});
test('native RPC rejects malformed RPC 429 envelopes and general server errors without retry', async () => {
  for (const [status, extra] of [[503, {}], [200, { id: 99 }], [200, { jsonrpc: '1.0' }],
    [200, { result: 'conflicting' }], [200, { error: { code: 429 } }], [200, { error: { code: '429', message: 'rate' } }]]) {
    const f = retryFixture(({ id }) => rateResponse(id, status, null, extra));
    await assert.rejects(f.rpc('getTransaction', []));
    assert.equal(f.requests.length, 1); assert.deepEqual(f.delays, []);
  }
});
test('native RPC retries plain HTTP 429 but propagates cancelled response reads', async () => {
  const f = retryFixture(({ id }, attempt) => attempt === 1 ? new Response('rate limited', { status: 429 }) :
    new Response(JSON.stringify({ jsonrpc: '2.0', id, result: null })));
  assert.equal(await f.rpc('getTransaction', []), null);
  assert.equal(f.requests.length, 2); assert.deepEqual(f.delays, [1000]);
  const error = new DOMException('cancelled', 'AbortError');
  const cancelled = retryFixture(() => ({ status: 429, json: async () => { throw error; } }));
  await assert.rejects(cancelled.rpc('getTransaction', []), error);
  assert.equal(cancelled.requests.length, 1); assert.deepEqual(cancelled.delays, []);
});

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
