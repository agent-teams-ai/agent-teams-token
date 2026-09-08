import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonRpc } from '../src/adapters/transfer-status-native.mjs';

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
