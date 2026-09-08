import assert from 'node:assert/strict';
import test from 'node:test';
import { createSolanaTransactionRpc } from '../src/adapters/solana-transaction-rpc.ts';

for (const retries of [undefined, 0, 3] as const) {
  test(`forward exact bytes with maxRetries ${String(retries)}`, async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    const fetcher: typeof fetch = async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      calls.push(request);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: request.method === 'getGenesisHash' ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' : '1'.repeat(88) }));
    };
    const rpc = createSolanaTransactionRpc(() => 'BAUG', async () => null, fetcher, retries);
    assert.equal(await rpc.broadcast('AQID'), '1'.repeat(88));
    assert.deepEqual(calls.map(c => [c.method, c.params]), [
      ['getGenesisHash', []], ['sendTransaction', ['AQID', {
        encoding: 'base64', skipPreflight: false, preflightCommitment: 'finalized', maxRetries: retries ?? 0,
      }]],
    ]);
  });
}
test('reject unsupported retry options before RPC effects', () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('forbidden'); };
  for (const invalid of [-1, 1, 2, 4, 3.5, NaN, Infinity, '3', '0', null, true, {}, []]) {
    assert.throws(() => createSolanaTransactionRpc(() => 'BAUG', async () => null, fetcher,
      invalid as 0 | 3), /Invalid Solana maxRetries/);
  }
  assert.equal(calls, 0);
});
