import test from 'node:test';
import assert from 'node:assert/strict';
import { accountTransfers, matchRequest } from '../src/domain/transfer-status.mjs';
import { solanaEffect, evmEffect } from '../src/adapters/transfer-status-native.mjs';
import { REVERSE } from '../src/domain/solana-reverse.mjs';
const snapshot = { coherent: true, solanaSlot: 10, ethereumHeight: 10n, fixedSupply: 100_000_000_000n, lockedOnEthereum: 1_000_000_000n, supplyOnSolana: 0n };
const pending = direction => ({ identity: { messageId: 'id', direction }, pendingAmount: 1_000_000_000n, events: [] });
test('both pending directions preserve conserved supply', () => {
  for (const direction of ['ethereum-to-solana', 'solana-to-ethereum']) {
    const result = accountTransfers([pending(direction)], snapshot, true);
    assert.equal(result.status, 'exact'); assert.equal(result.adjustedGlobalSupply, snapshot.fixedSupply);
  }
});
test('unknown inventory, pending, stale snapshot and duplicate cannot be green', () => {
  const transfer = pending('ethereum-to-solana');
  assert.equal(accountTransfers([transfer], snapshot).status, 'unknown');
  assert.equal(accountTransfers([{ ...transfer, pendingAmount: null }], snapshot, true).status, 'unknown');
  assert.equal(accountTransfers([transfer, transfer], snapshot, true).status, 'unknown');
  assert.equal(accountTransfers([transfer], { ...snapshot, coherent: false }, true).status, 'unknown');
  assert.equal(accountTransfers([{ ...transfer, events: [{ chain: 'ethereum', blockHeight: 11n }] }], snapshot, true).status, 'unknown');
  assert.equal(accountTransfers([{ ...transfer, events: [{ chain: 'solana', blockHeight: 11n }] }], snapshot, true).status, 'unknown');
});
test('missing effects cannot manufacture domain events', () => {
  assert.throws(() => evmEffect({ logs: [] }, 'lock'));
  assert.throws(() => solanaEffect({ transaction: { message: { instructions: [] } }, meta: {} }, 'mint'));
});
test('native parsed mint requires exact owner and real account delta', () => {
  const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const tx = { transaction: { message: { accountKeys: [{ pubkey: 'ata' }], instructions: [] } }, meta: {
    innerInstructions: [{ instructions: [{ programId: token, parsed: { type: 'mintTo', info: { mint: REVERSE.mint, account: 'ata', amount: '1000000000' } } }] }],
    postTokenBalances: [{ accountIndex: 0, mint: REVERSE.mint, owner: REVERSE.payer, programId: token, uiTokenAmount: { amount: '1000000000' } }] } };
  assert.equal(solanaEffect(tx, 'mint'), 0);
  tx.meta.postTokenBalances[0].owner = 'attacker'; assert.throws(() => solanaEffect(tx, 'mint'));
});
test('malformed source identity rejected', () => {
  assert.equal(matchRequest({ tx: { hash: 'wrong' }, log: {}, message: {} }, 'ethereum-to-solana', 'expected'), false);
});
test('API SUCCESS and execution Success cannot settle without native destination effect', async () => {
  const { inspectTransfer } = await import('../src/domain/transfer-status.mjs');
  const { FORWARD } = await import('../src/domain/evm-forward.mjs');
  const hash = '0x' + '11'.repeat(32), messageId = '0x' + '22'.repeat(32);
  const request = { tx: { hash }, lane: { sourceChainSelector: 16015286601757825753n, destChainSelector: FORWARD.selector, onRamp: '0xabc' },
    log: { transactionHash: hash, index: 1, address: '0xabc', data: '0x1234', topics: [] },
    message: { data: '0x', messageId, sourceChainSelector: 16015286601757825753n, destChainSelector: FORWARD.selector,
      sender: FORWARD.administrator, receiver: '11111111111111111111111111111111', tokenReceiver: FORWARD.recipient,
      sequenceNumber: 7n, tokenAmounts: [{ amount: FORWARD.amount, destTokenAddress: REVERSE.mint, sourcePoolAddress: FORWARD.pool }] } };
  const native = { authorizeOffRamp: async () => {}, ethereum: async () => ({ transaction: { to: FORWARD.router, from: FORWARD.administrator },
    logs: [{ logIndex: '0x1', address: '0xabc', data: '0x1234', topics: [] }], eventIndex: 0, blockHash: hash, blockHeight: 1n }),
    solana: async () => { throw new Error('Not finalized'); } };
  const chains = { ethereum: { getMessagesInTx: async () => [request] }, solana: { getExecutionReceiptInTx: async () => ({
    receipt: { messageId, sequenceNumber: 7n, state: 2 }, log: { transactionHash: 'destination' } }) } };
  const api = { getMessageById: async () => ({ metadata: { status: 'SUCCESS', offRamp: 'offramp', receiptTransactionHash: 'destination' } }) };
  const result = await inspectTransfer({ sourceHash: hash, direction: 'ethereum-to-solana' }, chains, native, api, 2);
  assert.equal(result.status, 'pending'); assert.equal(result.pendingAmount, FORWARD.amount);
  assert.match(result.destinationError, /unproven/);
  const encoded = Buffer.from('12345678event').toString('base64');
  chains.solana.getExecutionReceiptInTx = async () => ({ receipt: { messageId, sequenceNumber: 7n, state: 2 },
    log: { transactionHash: 'destination', address: 'offramp', index: 1, data: encoded, topics: ['0x3132333435363738'] } });
  native.solana = async () => ({ transaction: {}, eventIndex: 0, blockHash: 'destination-block', blockHeight: 2n,
    programLogs: ['Program offramp invoke [1]', 'Program data: ' + encoded, 'Program offramp success'] });
  assert.equal((await inspectTransfer({ sourceHash: hash, direction: 'ethereum-to-solana' }, chains, native, api, 2)).status, 'settled');
  native.solana = async () => ({ transaction: {}, eventIndex: 0, blockHash: 'destination-block', blockHeight: 2n,
    programLogs: ['Program impostor invoke [1]', 'Program data: ' + encoded, 'Program impostor success'] });
  assert.equal((await inspectTransfer({ sourceHash: hash, direction: 'ethereum-to-solana' }, chains, native, api, 2)).status, 'pending');
  chains.ethereum.getMessagesInTx = async () => [request, request];
  await assert.rejects(inspectTransfer({ sourceHash: hash, direction: 'ethereum-to-solana' }, chains, native, api, 2), /unique/);
});
test('native finalized devnet mint succeeds, wrong cluster and receipt failures reject', async () => {
  const { createNativeStatus } = await import('../src/adapters/transfer-status-native.mjs');
  const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const results = {
    getGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    getTransaction: { slot: 10, transaction: { signatures: ['signature'], message: { accountKeys: [{ pubkey: 'ata' }], instructions: [] } },
      meta: { err: null, innerInstructions: [{ instructions: [{ programId: token, parsed: { type: 'mintTo', info: { mint: REVERSE.mint, account: 'ata', amount: '1000000000' } } }] }],
        postTokenBalances: [{ accountIndex: 0, mint: REVERSE.mint, owner: REVERSE.payer, programId: token, uiTokenAmount: { amount: '1000000000' } }] } },
    getSignatureStatuses: { value: [{ slot: 10, err: null, confirmationStatus: 'finalized' }] },
    getBlock: { signatures: ['signature'], blockhash: 'block' },
  };
  const fetcher = async (_, options) => { const { id, method } = JSON.parse(options.body); return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: results[method] })); };
  const native = createNativeStatus('https://sepolia.invalid', 'https://solana.invalid', {}, fetcher);
  assert.equal((await native.solana('signature', 'mint')).blockHeight, 10n);
  results.getSignatureStatuses.value[0].confirmationStatus = 'confirmed';
  await assert.rejects(native.solana('signature', 'mint'), /not successful finalized/);
  results.getSignatureStatuses.value[0].confirmationStatus = 'finalized';
  results.getBlock.signatures = []; await assert.rejects(native.solana('signature', 'mint'), /canonical block/);
  results.getGenesisHash = 'mainnet'; await assert.rejects(native.solana('signature', 'mint'), /Wrong Solana cluster/);
});
test('discovery offRamp is rejected unless trusted native router authorizes it', async () => {
  const { createNativeStatus } = await import('../src/adapters/transfer-status-native.mjs');
  let allowed = false;
  const fetcher = async (_, options) => {
    const { id, method } = JSON.parse(options.body);
    assert.equal(method, 'eth_call');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: allowed ? '0x1' : '0x0' }));
  };
  const native = createNativeStatus('https://sepolia.invalid', 'https://solana.invalid', { isOffRampData: () => '0xverified' }, fetcher);
  await assert.rejects(native.authorizeOffRamp('ethereum', 'offramp', 1n), /Unauthorized/);
  allowed = true; await native.authorizeOffRamp('ethereum', 'offramp', 1n);
});
