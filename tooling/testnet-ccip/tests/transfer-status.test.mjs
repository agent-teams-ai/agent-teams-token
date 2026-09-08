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
  const { FORWARD_RECIPIENT_B } = await import('../src/domain/evm-forward.mjs');
  assert.equal(matchRequest(request, 'ethereum-to-solana', hash, FORWARD_RECIPIENT_B), false);
  const bRequest = { ...request, message: { ...request.message, tokenReceiver: FORWARD_RECIPIENT_B } };
  assert.equal(matchRequest(bRequest, 'ethereum-to-solana', hash), false);
  assert.equal(matchRequest(bRequest, 'ethereum-to-solana', hash, FORWARD_RECIPIENT_B), true);
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
test('Solana offRamp marker rejects wrong owner, discriminator and executable program', async () => {
  const { createNativeStatus } = await import('../src/adapters/transfer-status-native.mjs');
  const { createHash } = await import('node:crypto');
  const { ROUTER_PROGRAM } = await import('../src/domain/solana-registration.ts');
  const marker = { owner: ROUTER_PROGRAM, executable: false, data: [createHash('sha256').update('account:AllowedOfframp').digest().subarray(0, 8).toString('base64'), 'base64'] };
  const program = { executable: true };
  const fetcher = async (_, options) => { const { id, params } = JSON.parse(options.body); return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { value: params[0] === 'marker' ? marker : program } })); };
  const native = createNativeStatus('https://sepolia.invalid', 'https://solana.invalid', { allowedOffRamp: () => 'marker' }, fetcher);
  await native.authorizeOffRamp('solana', 'offramp', 1n);
  marker.owner = 'attacker'; await assert.rejects(native.authorizeOffRamp('solana', 'offramp', 1n), /Unauthorized/);
  marker.owner = ROUTER_PROGRAM; marker.executable = true; await assert.rejects(native.authorizeOffRamp('solana', 'offramp', 1n), /Unauthorized/);
  marker.executable = false; program.executable = false; await assert.rejects(native.authorizeOffRamp('solana', 'offramp', 1n), /Unauthorized/);
  program.executable = true; marker.data[0] = Buffer.alloc(8).toString('base64'); await assert.rejects(native.authorizeOffRamp('solana', 'offramp', 1n), /Unauthorized/);
});
test('snapshot pins mint authority while finalized heads may advance', async () => {
  const { createNativeStatus } = await import('../src/adapters/transfer-status-native.mjs');
  const mint = { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { decimals: 9, isInitialized: true, freezeAuthority: null, mintAuthority: 'pool-signer' } } } };
  let supplySlot = 10;
  const fetcher = async (_, options) => {
    const { id, method, params } = JSON.parse(options.body);
    const results = { eth_chainId: '0xaa36a7', getGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      eth_getBlockByNumber: { hash: 'block', number: '0xa', timestamp: '0x6553f100' }, getBlockTime: 1700000000, getSlot: 10, getAccountInfo: { value: mint } };
    let result = results[method];
    if (method === 'eth_call') { result = params[0].data === '0x18160ddd' ? '0x174876e800' : '0x0'; }
    if (method === 'getTokenSupply') { result = { context: { slot: supplySlot++ }, value: { decimals: 9, amount: '0' } }; }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const native = createNativeStatus('https://sepolia.invalid', 'https://solana.invalid', { solanaSigner: 'pool-signer' }, fetcher, () => 1700000000000);
  assert.equal((await native.snapshot()).coherent, true);
  mint.data.parsed.info.mintAuthority = 'attacker'; await assert.rejects(native.snapshot(), /mint identity/);
});
test('SDK diagnostic logger sends all levels to its dedicated stream', async () => {
  const { statusLogger } = await import('../src/composition/transfer-status.mjs');
  const diagnostics = [];
  const logger = statusLogger(text => diagnostics.push(text));
  for (const level of ['debug', 'info', 'warn', 'error']) { logger[level]('fetched %d', 200); }
  assert.deepEqual(diagnostics, Array(4).fill('fetched 200\n'));
});
test('fixed three-message inventory preserves historical A and excludes B reverse', async () => {
  const { validateStatusTransfers, statusRecipient } = await import('../src/domain/transfer-status.mjs');
  const { FORWARD, FORWARD_RECIPIENT_B } = await import('../src/domain/evm-forward.mjs');
  const entries = [{ direction: 'ethereum-to-solana', sourceHash: 'a-forward' },
    { direction: 'solana-to-ethereum', sourceHash: 'a-reverse' },
    { direction: 'ethereum-to-solana', recipient: FORWARD_RECIPIENT_B, sourceHash: 'b-forward' }];
  validateStatusTransfers(entries);
  assert.equal(statusRecipient('ethereum-to-solana'), FORWARD.recipient);
  assert.throws(() => validateStatusTransfers([...entries, entries[0]]), /three/);
  assert.throws(() => validateStatusTransfers([entries[0], { ...entries[0], sourceHash: 'another' }]), /Duplicate/);
  assert.throws(() => statusRecipient('solana-to-ethereum', FORWARD_RECIPIENT_B), /only recipient A/);
  assert.throws(() => statusRecipient('ethereum-to-solana', 'arbitrary'), /fixed forward/);
  const settled = entries.map((entry, i) => ({ identity: { messageId: String(i), direction: entry.direction }, pendingAmount: 0n, events: [] }));
  const result = accountTransfers(settled, { ...snapshot, supplyOnSolana: 1_000_000_000n }, true);
  assert.equal(result.status, 'exact'); assert.equal(result.adjustedGlobalSupply, 100_000_000_000n);
});
test('recipient B mint requires B owner and canonical B ATA; A cannot satisfy it', async () => {
  const { FORWARD_RECIPIENT_B, FORWARD_RECIPIENT_B_ATA, FORWARD } = await import('../src/domain/evm-forward.mjs');
  const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const tx = { transaction: { message: { accountKeys: [FORWARD_RECIPIENT_B_ATA], instructions: [] } }, meta: {
    innerInstructions: [{ instructions: [{ programId: token, parsed: { type: 'mintTo', info: { mint: REVERSE.mint, account: FORWARD_RECIPIENT_B_ATA, amount: '1000000000' } } }] }],
    postTokenBalances: [{ accountIndex: 0, mint: REVERSE.mint, owner: FORWARD_RECIPIENT_B, programId: token, uiTokenAmount: { amount: '1000000000' } }] } };
  assert.equal(solanaEffect(tx, 'mint', FORWARD_RECIPIENT_B, FORWARD_RECIPIENT_B_ATA), 0);
  assert.throws(() => solanaEffect(tx, 'mint', FORWARD.recipient, FORWARD_RECIPIENT_B_ATA), /ownership/);
  assert.throws(() => solanaEffect(tx, 'mint', FORWARD_RECIPIENT_B, 'wrong-ata'), /canonical/);
  assert.throws(() => solanaEffect(tx, 'burn', FORWARD_RECIPIENT_B, FORWARD_RECIPIENT_B_ATA), /B reverse/);
  tx.meta.postTokenBalances[0].owner = FORWARD.recipient;
  assert.throws(() => solanaEffect(tx, 'mint', FORWARD_RECIPIENT_B, FORWARD_RECIPIENT_B_ATA), /ownership/);
});

test('captured reverse native transfer-to-pool then burn reconciles strict A and pool balances', async () => {
  const { readFile } = await import('node:fs/promises');
  const { tx } = JSON.parse(await readFile(new URL('./fixtures/reverse-native-burn.json', import.meta.url), 'utf8'));
  const ata = 'BDW4fQh6QGDnTbZATEjTCcu1PQaKvKSE5GzmQTGe9Kvh';
  const lane = { solanaPoolAta: 'ETmid1DpsTNnZGueaiK68hWqfcs6rJii1YFgjKxrcVzF',
    solanaSigner: '8NGr2WFh3JrC1UzmB3iifESF7W5wf3CBPWguJayuXmkX', solanaSpender: '2AjuzTy6z2webxEUu7eZ1DkAyLagZaqH2dgzhbBYjJiG' };
  const prove = (value, bindings = lane) => solanaEffect(value, 'burn', REVERSE.payer, ata, bindings);
  assert.equal(tx.slot, 494910753);
  assert.equal(prove(tx), 3);
  const cases = {
    transferAuthority: value => { value.meta.innerInstructions[0].instructions[0].parsed.info.authority = REVERSE.payer; },
    burnAuthority: value => { value.meta.innerInstructions[0].instructions[1].parsed.info.authority = REVERSE.payer; },
    transferSource: value => { value.meta.innerInstructions[0].instructions[0].parsed.info.source = lane.solanaPoolAta; },
    transferDestination: value => { value.meta.innerInstructions[0].instructions[0].parsed.info.destination = ata; },
    directUserBurn: value => { value.meta.innerInstructions[0].instructions[1].parsed.info.account = ata; },
    missingTransfer: value => { value.meta.innerInstructions[0].instructions.shift(); },
    duplicateTransfer: value => { value.meta.innerInstructions[0].instructions.unshift(value.meta.innerInstructions[0].instructions[0]); },
    duplicateBurn: value => { value.meta.innerInstructions[0].instructions.push(value.meta.innerInstructions[0].instructions[1]); },
    reversedOrder: value => { value.meta.innerInstructions[0].instructions.reverse(); },
    transferDecimals: value => { value.meta.innerInstructions[0].instructions[0].parsed.info.tokenAmount.decimals = 8; },
    transferAmount: value => { value.meta.innerInstructions[0].instructions[0].parsed.info.tokenAmount.amount = '1'; },
    burnAmount: value => { value.meta.innerInstructions[0].instructions[1].parsed.info.amount = '1'; },
    burnMint: value => { value.meta.innerInstructions[0].instructions[1].parsed.info.mint = 'wrong'; },
    tokenProgram: value => { value.meta.innerInstructions[0].instructions[1].programId = 'wrong'; },
    duplicateGroup: value => { value.meta.innerInstructions.push(value.meta.innerInstructions[0]); },
  };
  for (const [name, change] of Object.entries(cases)) {
    const changed = structuredClone(tx); change(changed); assert.throws(() => prove(changed), undefined, name);
  }
  for (const phase of ['preTokenBalances', 'postTokenBalances']) {
    for (const index of [0, 1]) {
      for (const field of ['owner', 'mint', 'programId', 'amount', 'decimals', 'missing', 'duplicate']) {
        const changed = structuredClone(tx), balances = changed.meta[phase], balance = balances[index];
        if (field === 'amount') { balance.uiTokenAmount.amount = '7'; }
        else if (field === 'decimals') { balance.uiTokenAmount.decimals = 8; }
        else if (field === 'missing') { balances.splice(index, 1); }
        else if (field === 'duplicate') { balances.push(structuredClone(balance)); }
        else { balance[field] = 'wrong'; }
        assert.throws(() => prove(changed), undefined, `${phase}/${index}/${field}`);
      }
    }
  }
  for (const field of Object.keys(lane)) {
    assert.throws(() => prove(tx, { ...lane, [field]: undefined }));
    assert.throws(() => prove(tx, { ...lane, [field]: 'wrong' }));
  }
  assert.throws(() => solanaEffect(tx, 'burn', REVERSE.payer, 'wrong', lane));
});

async function receiptHintFixture(forward = false) {
  const { inspectTransfer } = await import('../src/domain/transfer-status.mjs');
  const { FORWARD } = await import('../src/domain/evm-forward.mjs');
  const { ROUTER_PROGRAM } = await import('../src/domain/solana-registration.ts');
  const sourceHash = 'source', messageId = '0x' + '22'.repeat(32), encoded = Buffer.from('12345678event').toString('base64');
  const hint = forward ? { transactionHash: '1'.repeat(64), offRamp: '1'.repeat(32) } :
    { transactionHash: '0x' + '33'.repeat(32), offRamp: '0x' + '44'.repeat(20) };
  const source = forward ? 'ethereum' : 'solana', destination = forward ? 'solana' : 'ethereum';
  const log = { transactionHash: sourceHash, index: 1, address: forward ? '0xabc' : ROUTER_PROGRAM,
    data: forward ? '0x1234' : encoded, topics: forward ? [] : ['0x3132333435363738'] };
  const request = { tx: { hash: sourceHash, from: REVERSE.payer }, log,
    lane: { sourceChainSelector: forward ? 16015286601757825753n : FORWARD.selector,
      destChainSelector: forward ? FORWARD.selector : 16015286601757825753n, onRamp: '0xabc' },
    message: { data: '0x', messageId, sequenceNumber: 7n,
      sender: forward ? FORWARD.administrator : REVERSE.payer,
      receiver: forward ? '11111111111111111111111111111111' : REVERSE.recipient,
      tokenReceiver: FORWARD.recipient,
      tokenAmounts: [{ amount: FORWARD.amount, destTokenAddress: forward ? REVERSE.mint : FORWARD.token,
        sourcePoolAddress: forward ? FORWARD.pool : 'pool' }] } };
  Object.assign(request.message, { sourceChainSelector: request.lane.sourceChainSelector, destChainSelector: request.lane.destChainSelector });
  const execution = { receipt: { messageId, sequenceNumber: 7n, sourceChainSelector: request.lane.sourceChainSelector, state: 2 },
    log: { transactionHash: hint.transactionHash, address: hint.offRamp, index: 1,
      data: forward ? encoded : '0xab', topics: forward ? ['0x3132333435363738'] : [] } };
  const calls = [];
  const native = { lane: { solanaPool: 'pool' },
    authorizeOffRamp: async (...args) => { calls.push('authorize'); assert.deepEqual(args, [destination, hint.offRamp, request.lane.sourceChainSelector]); },
    [source]: async () => ({ eventIndex: 0, blockHeight: 1n, blockHash: 'source-block',
      transaction: { to: FORWARD.router, from: FORWARD.administrator,
        message: { accountKeys: [{ pubkey: REVERSE.payer, signer: true }], instructions: [{ programId: ROUTER_PROGRAM }] } },
      logs: [{ logIndex: '0x1', address: log.address, data: log.data, topics: log.topics }],
      programLogs: [`Program ${ROUTER_PROGRAM} invoke [1]`, 'Program data: ' + encoded, `Program ${ROUTER_PROGRAM} success`] }),
    [destination]: async () => { calls.push('effect'); return { eventIndex: 0, blockHeight: 2n, blockHash: 'destination-block',
      logs: [{ logIndex: '0x1', address: hint.offRamp, data: '0xab', topics: [] }],
      programLogs: [`Program ${hint.offRamp} invoke [1]`, 'Program data: ' + encoded, `Program ${hint.offRamp} success`] }; } };
  const chains = { [source]: { getMessagesInTx: async () => [request] },
    [destination]: { getExecutionReceiptInTx: async (hash, options) => {
      calls.push('sdk'); assert.equal(hash, hint.transactionHash);
      assert.deepEqual(options, { offRamp: hint.offRamp, messageId, sourceChainSelector: request.lane.sourceChainSelector });
      return execution;
    } } };
  const api = { getMessageById: async () => { throw new Error('MESSAGE_ID_NOT_FOUND secret diagnostic'); } };
  const transfer = { sourceHash, direction: forward ? 'ethereum-to-solana' : 'solana-to-ethereum', destinationReceipt: hint };
  return { hint, transfer, api, native, execution, calls, destination, chains, run: () => inspectTransfer(transfer, chains, native, api, 2) };
}
test('operator receipt discovery settles both chains only through native verification during API absence', async () => {
  for (const forward of [false, true]) {
    for (const metadata of [undefined, {}, { status: 'PROCESSING', offRamp: 'incomplete' }]) {
      const f = await receiptHintFixture(forward);
      if (metadata) { f.api.getMessageById = async () => ({ metadata }); }
      const result = await f.run();
      assert.equal(result.status, 'settled'); assert.equal(result.pendingAmount, 0n);
      assert.equal(result.discoveryOrigin, 'operator-receipt-hint');
      assert.equal(result.discoveryStatus, metadata?.status ?? 'UNKNOWN');
      assert.deepEqual(f.calls, ['authorize', 'sdk', 'effect']);
    }
  }
});
test('hint cannot bypass authorization, SDK identity, native finality/effects or log binding', async () => {
  for (const forward of [false, true]) {
    for (const failure of ['offRamp', 'messageId', 'sequenceNumber', 'sourceChainSelector', 'state', 'transactionHash', 'finality', 'token', 'binding']) {
      const f = await receiptHintFixture(forward);
      if (failure === 'offRamp') { f.native.authorizeOffRamp = async () => { throw new Error('private detail'); }; }
      else if (['finality', 'token'].includes(failure)) { f.native[f.destination] = async () => { throw new Error('private detail'); }; }
      else if (failure === 'binding') { f.execution.log.data = 'tampered'; }
      else if (failure === 'transactionHash') { f.execution.log.transactionHash = 'wrong'; }
      else { f.execution.receipt[failure] = 'wrong'; }
      const result = await f.run();
      assert.equal(result.status, 'pending', failure); assert.equal(result.events.length, 1);
      assert.match(result.destinationError, /unproven/); assert.doesNotMatch(result.destinationError, /private/);
    }
  }
});
test('complete API and hint conflicts fail closed; matching receipts remain verifiable', async () => {
  for (const forward of [false, true]) {
    for (const field of ['transactionHash', 'offRamp']) {
      const f = await receiptHintFixture(forward);
      const receipt = { ...f.hint, [field]: 'different' };
      f.api.getMessageById = async () => ({ metadata: { status: 'SUCCESS', receiptTransactionHash: receipt.transactionHash, offRamp: receipt.offRamp } });
      const result = await f.run();
      assert.equal(result.status, 'pending'); assert.match(result.destinationError, /conflict/); assert.deepEqual(f.calls, []);
    }
  }
  const f = await receiptHintFixture();
  f.api.getMessageById = async () => ({ metadata: { receiptTransactionHash: f.hint.transactionHash, offRamp: f.hint.offRamp } });
  const result = await f.run();
  assert.equal(result.discoveryOrigin, 'ccip-api'); assert.equal(result.status, 'settled');
});
test('API outage without hint preserves pending and malformed hints never read destination', async () => {
  const absent = await receiptHintFixture(); delete absent.transfer.destinationReceipt;
  const pendingResult = await absent.run();
  assert.equal(pendingResult.status, 'pending'); assert.equal(pendingResult.discoveryStatus, 'UNKNOWN');
  assert.equal(pendingResult.destinationError, undefined); assert.deepEqual(absent.calls, []);
  for (const forward of [false, true]) {
    const f = await receiptHintFixture(forward);
    for (const hint of [null, [], {}, 'receipt', { ...f.hint, extra: true },
      ...['transactionHash', 'offRamp'].flatMap(field => [0, '', '0', ' ' + f.hint[field], f.hint[field] + '1', f.hint[field].slice(1), '1'.repeat(10000)].map(value => ({ ...f.hint, [field]: value })))]) {
      f.transfer.destinationReceipt = hint;
      const result = await f.run();
      assert.equal(result.status, 'pending'); assert.match(result.destinationError, /malformed/);
      assert.deepEqual(f.calls, []);
    }
  }
});

test('EVM adapter normalizes lower/checksummed hints while preserving native checks and SDK receiver', async () => {
  const { evmStatusChain } = await import('../src/composition/transfer-status.mjs');
  const canonical = '0x0820f975ce90EE5c508657F0C58b71D1fcc85cE0';
  for (const address of [canonical.toLowerCase(), canonical]) {
    const f = await receiptHintFixture();
    f.hint.offRamp = address;
    f.execution.log.address = canonical;
    const raw = Object.freeze({
      getMessagesInTx(hash) { assert.equal(this, raw); return hash; },
      getExecutionReceiptInTx(hash, filters) {
        assert.equal(this, raw); assert.equal(hash, f.hint.transactionHash);
        assert.deepEqual(filters, { offRamp: canonical, messageId: f.execution.receipt.messageId,
          sourceChainSelector: f.execution.receipt.sourceChainSelector });
        f.calls.push('sdk'); return f.execution;
      },
      destroy() { assert.equal(this, raw); return 'destroyed'; },
    });
    const normalized = [];
    f.chains.ethereum = evmStatusChain(raw, value => {
      normalized.push(value); assert.equal(value.toLowerCase(), canonical.toLowerCase()); return canonical;
    });
    assert.equal(f.chains.ethereum.getMessagesInTx('source'), 'source');
    assert.equal((await f.run()).status, 'settled');
    assert.deepEqual(normalized, [address]);
    assert.deepEqual(f.calls, ['authorize', 'sdk', 'effect']);
    f.execution.log.data = 'tampered';
    assert.equal((await f.run()).status, 'pending');
    f.native.authorizeOffRamp = async () => { throw new Error('Unauthorized'); };
    const count = normalized.length;
    assert.equal((await f.run()).status, 'pending');
    assert.equal(normalized.length, count);
    assert.equal(f.chains.ethereum.destroy(), 'destroyed');
    assert.equal(f.hint.offRamp, address);
  }
});

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
        const transfers = [{ status: 'settled', identity: { messageId: 'settled' }, pendingAmount: 0n, events: [] }];
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
