import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runStatus } from '../../src/composition/transfer-status.mjs';
import { inspectTransfer, matchRequest } from '../../src/domain/transfer-status.mjs';
import { createTestSdkStatus } from '../../src/adapters/test-sdk-status.ts';
import { testSdkCounters } from '../../src/adapters/test-sdk-admission.ts';
import { authenticatedSolanaEffect, type InvocationLog } from '../../src/adapters/transfer-status-native.mjs';
import { DEFAULT_SEPOLIA_RPC, DEFAULT_SOLANA_RPC, TEST_RPC_RESPONSE_LIMIT } from '../../src/adapters/test-rpc.ts';
import { BURNMINT_PROGRAM } from '../../src/domain/solana-pool-init.ts';
import { FORWARD_RECIPIENT_B, FORWARD_RECIPIENT_B_ATA } from '../../src/domain/evm-forward.mjs';
import { TEST_SDK_PROFILE, type ExplicitTestSdkSelection } from '../../src/adapters/test-sdk-policy.ts';
import { fixture, root, archives, time, hash, logger, svmOffRamp, token, present, ticks, type MintTransaction, createScenarioState, type ScenarioState, createFetcher } from './native-status-controls.mts';
type Ports = Awaited<ReturnType<typeof createTestSdkStatus>>;
async function checkReverse(s: ScenarioState, ports: Ports): Promise<void> {
    const transfer = { direction: 'solana-to-ethereum' as const, sourceHash: '1'.repeat(64), recipient: fixture.recipient,
      destinationReceipt: { transactionHash: s.executionHash, offRamp: s.offRamp } };
    await ports.native.authorizeOffRamp('ethereum', s.offRamp, BigInt(fixture.forwardSelector));
    assert.equal((await ports.chains.ethereum.getExecutionReceiptInTx(s.executionHash, { offRamp: s.offRamp, messageId: s.messageId, sourceChainSelector: BigInt(fixture.forwardSelector) })).receipt.state, ports.successState);
    assert.equal((await ports.native.ethereum(s.executionHash, 'release')).eventIndex, 1);
    const positive = await inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState);
    assert.equal(positive.status, 'settled'); assert.equal(positive.pendingAmount, 0n); assert.equal(positive.events[0]?.eventIndex, 3);
    for (const mutant of ['parent', 'split']) {
      s.cpiMutant = mutant;
      await assert.rejects(ports.native.solana(transfer.sourceHash, 'burn', fixture.recipient), /invocation|coordinates|execution/);
      await assert.rejects(inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState), /invocation|coordinates|execution/);
      process.stdout.write(JSON.stringify({ probe: 'U2-reverse', mutant, positive: positive.status, rejected: true }) + '\n');
    }
    s.cpiMutant = '';
    await assert.rejects(ports.native.solana(transfer.sourceHash, 'burn', FORWARD_RECIPIENT_B), /B reverse/);
    assert.equal((await inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState)).status, 'settled');
}
async function checkCausal(s: ScenarioState, ports: Ports): Promise<boolean> {
    const transfer = { direction: 'ethereum-to-solana' as const, sourceHash: s.sourceHash, recipient: FORWARD_RECIPIENT_B,
      destinationReceipt: { transactionHash: '1'.repeat(64), offRamp: svmOffRamp } };
    const positive = await inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState);
    assert.equal(positive.status, 'settled'); assert.equal(positive.pendingAmount, 0n); assert.equal(positive.events[1]?.eventIndex, 2);
    assert.equal((await ports.native.solana('1'.repeat(64), 'mint', FORWARD_RECIPIENT_B)).eventIndex, 2);
    if (s.name === 'causal-cpi') {
      for (const mutant of ['parent', 'split', 'depth', 'missing-height', 'trace-truncated']) {
        s.cpiMutant = mutant;
        await assert.rejects(ports.native.solana('1'.repeat(64), 'mint', FORWARD_RECIPIENT_B), /invocation|coordinates|ancestry|execution/);
        const rejected = await inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState);
        assert.equal(rejected.status, 'pending'); assert.equal(rejected.pendingAmount, null); assert.equal(rejected.events.length, 1);
        process.stdout.write(JSON.stringify({ probe: 'U2', mutant, positive: positive.status, rejected: rejected.status, pendingUnknown: rejected.pendingAmount === null }) + '\n');
      }
      s.cpiMutant = '';
      assert.equal((await inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState)).status, 'settled');
    } else {
      s.failedCancellation = true;
      const inspection = inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState);
      await s.entered.promise;
      // Refusal must already be latched while the physical cancel is still pending.
      const before = s.calls;
      assert.throws(() => ports.native.snapshot(), /byte bound|over-bound/); assert.equal(s.calls, before);
      s.body.resolve();
      const rejected = await inspection;
      assert.equal(rejected.status, 'pending'); assert.equal(rejected.pendingAmount, null); assert.equal(s.physicalReleased, false);
      const close = ports.destroy(); assert.equal(close, ports.destroy());
      await assert.rejects(close, /physical cancellation/);
      assert.equal(testSdkCounters()?.closed, false); assert.equal(s.evmDestroyed, 1); assert.equal(s.svmDestroyed, 1); assert.equal(s.globalFetchAttempts, 0);
      process.stdout.write(JSON.stringify({ probe: 'U1', scenario: s.name, qualification: 'UNQUALIFIED', positive: positive.status, rejected: rejected.status,
        physicalReleased: s.physicalReleased, cleanupRejected: true, hooksClosed: testSdkCounters()?.closed, bodyCancelled: s.bodyCancelled }) + '\n'); return true;
    }
  return false;
}
async function checkEvmDecoders(s: ScenarioState, ports: Ports): Promise<void> {
    const messages = await ports.chains.ethereum.getMessagesInTx(s.sourceHash);
    assert.equal(messages.length, 1); const request = present(messages[0]);
    assert.equal(request.message.tokenReceiver, FORWARD_RECIPIENT_B); assert.equal(request.message.sequenceNumber, 7n);
    assert.equal(request.message.tokenAmounts[0]?.amount, 1000000000n);
    assert.equal(matchRequest(request, 'ethereum-to-solana', s.sourceHash, FORWARD_RECIPIENT_B, fixture), true);
    assert.equal(matchRequest({ ...request, message: { ...request.message, tokenReceiver: fixture.recipient } }, 'ethereum-to-solana', s.sourceHash, FORWARD_RECIPIENT_B, fixture), false);
    const receipt = await ports.chains.ethereum.getExecutionReceiptInTx(s.executionHash, { offRamp: s.offRamp, messageId: s.messageId, sourceChainSelector: BigInt(fixture.forwardSelector) });
    assert.equal(receipt.receipt.sequenceNumber, 7n); assert.equal(receipt.receipt.state, ports.successState);
    assert.equal(receipt.log.transactionHash, s.executionHash);
    await assert.rejects(ports.chains.ethereum.getExecutionReceiptInTx(s.executionHash, { offRamp: s.offRamp, messageId: '0x' + 'ff'.repeat(32), sourceChainSelector: BigInt(fixture.forwardSelector) }));
    const found = await ports.api.getMessageById(s.messageId, { signal: new AbortController().signal }); assert.equal(found.metadata?.status, 'SUCCESS');
    const result = await inspectTransfer({ direction: 'ethereum-to-solana', sourceHash: s.sourceHash, recipient: FORWARD_RECIPIENT_B }, ports.chains, ports.native, ports.api, ports.successState);
    assert.equal(result.status, 'pending'); assert.equal(result.pendingAmount, null); assert.equal(result.events.length, 1); assert.match(result.destinationError ?? '', /unproven/);
}
async function checkSvmDecoders(s: ScenarioState, ports: Ports): Promise<void> {
    const messages = await ports.chains.solana.getMessagesInTx('1'.repeat(64));
    assert.equal(messages.length, 1); const message = present(messages[0]);
    assert.equal(message.message.sourceChainSelector, BigInt(fixture.forwardSelector)); assert.equal(message.message.sequenceNumber, 7n);
    assert.equal(message.message.tokenAmounts[0]?.sourcePoolAddress, fixture.solanaPool);
    assert.equal(matchRequest(message, 'solana-to-ethereum', '1'.repeat(64), fixture.recipient, fixture), true);
    const filters = { offRamp: BURNMINT_PROGRAM, messageId: s.messageId, sourceChainSelector: BigInt(fixture.reverseSelector) };
    const receipt = await ports.chains.solana.getExecutionReceiptInTx('2'.repeat(87), filters);
    assert.equal(receipt.receipt.state, ports.successState); assert.equal(receipt.receipt.sequenceNumber, 7n); assert.equal(receipt.log.address, BURNMINT_PROGRAM);
    await assert.rejects(ports.chains.solana.getExecutionReceiptInTx('2'.repeat(87), { ...filters, messageId: '0x' + 'ff'.repeat(32) }));
    assert.equal(s.requests.filter(row => row.request.method === 'simulateTransaction').length, 1);
}
async function checkObserver(s: ScenarioState, ports: Ports): Promise<void> {
  const { lane, parseLogs } = s;
  assert.ok(lane?.recipientAtas);
    const result = await ports.native.snapshot();
    assert.equal(result.coherent, true); assert.equal(result.fixtureIdentity, fixture.identity); assert.equal(result.decimals, 9);
    assert.equal(result.ethereumBlock, hash); assert.equal(result.observedAt, new Date(time).toISOString());
    assert.equal(result.fixedSupply, 100000000000n); assert.equal(result.lockedOnEthereum, 1000000000n); assert.equal(result.supplyOnSolana, 1000000000n);
    assert.notEqual(lane.recipientAtas[fixture.recipient], lane.recipientAtas[FORWARD_RECIPIENT_B]);
    assert.notEqual(lane.recipientAtas[FORWARD_RECIPIENT_B], FORWARD_RECIPIENT_B_ATA);
    const accountRequests = s.requests.filter(row => row.request.method === 'getAccountInfo').map(row => row.request.params);
    assert.ok(accountRequests.some(params => Array.isArray(params) && params[0] === lane?.recipientAtas?.[FORWARD_RECIPIENT_B]));
    for (const recipient of [fixture.recipient, FORWARD_RECIPIENT_B]) {
      const ata: string | undefined = lane.recipientAtas[recipient]; assert.ok(ata);
      const data = Buffer.alloc(16).toString('base64');
      const tx: MintTransaction = { transaction: { message: { accountKeys: [ata], instructions: [{ programId: svmOffRamp }, { programId: fixture.payer }] } }, meta: {
        logMessages: ['Program ' + svmOffRamp + ' invoke [1]', 'Program ' + BURNMINT_PROGRAM + ' invoke [2]', 'Program ' + token + ' invoke [3]', 'Program ' + token + ' success', 'Program ' + BURNMINT_PROGRAM + ' success', 'Program data: ' + data, 'Program ' + svmOffRamp + ' success'],
        innerInstructions: [{ index: 0, instructions: [{ programId: BURNMINT_PROGRAM, stackHeight: 2 }, { programId: token, stackHeight: 3, parsed: { type: 'mintTo', info: { mint: fixture.mint, account: ata, amount: '1000000000', mintAuthority: present(lane.solanaSigner) } } }] }],
        preTokenBalances: [{ accountIndex: 0, mint: fixture.mint, owner: recipient, programId: token, uiTokenAmount: { amount: '0', decimals: 9 } }],
        postTokenBalances: [{ accountIndex: 0, mint: fixture.mint, owner: recipient, programId: token, uiTokenAmount: { amount: '1000000000', decimals: 9 } }] } };
      const event = present(present(parseLogs)(tx.meta.logMessages).find(log => log.type === 'data'));
      const invocation: InvocationLog = { ...event, transactionHash: '1'.repeat(64) };
      assert.equal(authenticatedSolanaEffect(tx, 'mint', recipient, ata, { lane, event: invocation }), 2);
      const early = structuredClone(tx); early.meta.logMessages.splice(5, 1); early.meta.logMessages.splice(1, 0, 'Program data: ' + data);
      const earlyEvent = present(present(parseLogs)(early.meta.logMessages).find(log => log.type === 'data'));
      assert.throws(() => authenticatedSolanaEffect(early, 'mint', recipient, ata, { lane, event: { ...earlyEvent, transactionHash: '1'.repeat(64) } }), /effect\/event order/);
      for (const mutate of [
        (t: typeof tx) => { present(t.meta.postTokenBalances[0]).owner = 'wrong'; },
        (t: typeof tx) => { present(present(t.meta.innerInstructions[0]).instructions[0]).programId = 'wrong'; },
        (t: typeof tx) => { present(present(present(t.meta.innerInstructions[0]).instructions[1]).parsed).info.mint = '13Q74er9thh3my9oACjChDhtn4znJibWBp1u8q1rAYau'; },
        (t: typeof tx) => { present(t.meta.preTokenBalances[0]).uiTokenAmount.decimals = 8; },
        (t: typeof tx) => { present(t.meta.postTokenBalances[0]).programId = 'wrong'; },
        (t: typeof tx) => { present(t.meta.postTokenBalances[0]).uiTokenAmount.decimals = 8; },
        (t: typeof tx) => { present(present(present(t.meta.innerInstructions[0]).instructions[1]).parsed).info.mintAuthority = 'wrong'; },
        (t: typeof tx) => { present(present(present(t.meta.innerInstructions[0]).instructions[1]).parsed).info.account = FORWARD_RECIPIENT_B_ATA; },
        (t: typeof tx) => { present(t.meta.innerInstructions[0]).instructions.push(present(present(t.meta.innerInstructions[0]).instructions[1])); },
        (t: typeof tx) => { present(t.meta.innerInstructions[0]).index = 9; },
        (t: typeof tx) => { present(t.meta.postTokenBalances[0]).uiTokenAmount.amount = '2000000000'; },
        (t: typeof tx) => { t.meta.postTokenBalances.push(present(t.meta.postTokenBalances[0])); },
      ]) { const changed = structuredClone(tx); mutate(changed); assert.throws(() => authenticatedSolanaEffect(changed, 'mint', recipient, ata, { lane, event: invocation })); }
    }
    s.mutations.endHash = '0x' + 'cd'.repeat(32); assert.equal((await ports.native.snapshot()).coherent, false); s.mutations.endHash = hash;
    s.mutations.endTimestamp = time / 1000 - 1; assert.equal((await ports.native.snapshot()).coherent, false); delete s.mutations.endTimestamp;
    s.mutations.endSupply = '2000000000'; assert.equal((await ports.native.snapshot()).coherent, false); delete s.mutations.endSupply;
    s.accountMetadata.amountA = '1000000000'; assert.equal((await ports.native.snapshot()).coherent, false);
    delete s.accountMetadata.amountA; assert.equal((await ports.native.snapshot()).coherent, true);
    s.mutations.mintContext = 19; assert.equal((await ports.native.snapshot()).coherent, false); s.mutations.mintContext = 20;
    s.mutations.timestamp = undefined; assert.equal((await ports.native.snapshot()).coherent, false);
    s.mutations.timestamp = null; assert.equal((await ports.native.snapshot()).coherent, false);
    s.mutations.timestamp = time / 1000 + 1; assert.equal((await ports.native.snapshot()).coherent, false);
    s.mutations.timestamp = time / 1000 - 301; assert.equal((await ports.native.snapshot()).coherent, false); s.mutations.timestamp = time / 1000;
    s.mutations.mintDecimals = 8; await assert.rejects(ports.native.snapshot(), /mint identity/); s.mutations.mintDecimals = 9;
    s.mutations.freezeAuthority = fixture.payer; await assert.rejects(ports.native.snapshot(), /mint identity/); s.mutations.freezeAuthority = null;
    s.mutations.mintAuthority = fixture.payer; await assert.rejects(ports.native.snapshot(), /mint identity/); s.mutations.mintAuthority = lane.solanaSigner ?? '';
    for (const changed of [
      { program: BURNMINT_PROGRAM }, { mint: fixture.payer }, { owner: FORWARD_RECIPIENT_B },
      { state: 'frozen' }, { decimals: 8 }, { slot: 19 },
    ]) {
      const original = { ...s.accountMetadata };
      Object.assign(s.accountMetadata, changed);
      await assert.rejects(ports.native.snapshot(), /recipient account metadata/);
      Object.assign(s.accountMetadata, original); delete s.accountMetadata.owner;
    }
    assert.equal((await ports.native.snapshot()).coherent, true, 'Metadata controls recover after each independent mutation');
    await assert.rejects(ports.api.getMessageById('0x' + '11'.repeat(32), { signal: new AbortController().signal }), error => error instanceof Error && 'code' in error && error.code === 'MESSAGE_ID_NOT_FOUND');
    await assert.rejects(ports.api.getMessageById('0x' + '11'.repeat(32), { signal: new AbortController().signal }), error => error instanceof Error && 'code' in error && error.code === 'MESSAGE_ID_NOT_FOUND');
    assert.equal(s.apiCalls, 2, 'Fresh API discovery must not hit SDK memoization');
    assert.ok(s.supplyReads >= 2);
}
async function checkDrain(s: ScenarioState, ports: Ports): Promise<void> {
    s.held = true;
    const operation = s.name === 'native-body' ? ports.native.snapshot() : s.name === 'sdk-body' ? ports.chains.ethereum.getMessagesInTx('0x' + '11'.repeat(32)) :
      ports.api.getMessageById('0x' + '11'.repeat(32), { signal: new AbortController().signal });
    const operationOutcome = operation.then(() => 'resolved', () => 'rejected');
    await s.entered.promise;
    if (s.name === 'deadline') { mock.timers.enable({ apis: ['setTimeout'] }); }
    const close = ports.destroy(); assert.equal(ports.destroy(), close);
    const closedCalls = s.calls;
    assert.throws(() => ports.native.snapshot(), /lifetime closed/); assert.equal(s.calls, closedCalls);
    let settled = false; void close.then(() => { settled = true; return 'settled'; }, () => { settled = true; });
    await ticks(); assert.equal(settled, false); assert.equal(testSdkCounters()?.closed, false);
    assert.equal(s.evmDestroyed, 1); assert.equal(s.svmDestroyed, 1); assert.ok(s.signals.every(signal => signal.aborted));
    if (s.name === 'deadline') { mock.timers.tick(20_000); await assert.rejects(close, /Unresolved TEST status drain/); assert.equal(testSdkCounters()?.closed, false); mock.timers.reset(); }
    s.held = false; s.header.resolve(new Response('{}', { status: 404 })); s.body.resolve();
    await operationOutcome;
    if (s.name !== 'deadline') { await close; } else { await ticks(); assert.equal(testSdkCounters()?.closed, true); }
}
async function checkErrorBody(s: ScenarioState, ports: Ports): Promise<void> {
    await assert.rejects(ports.api.getMessageById(s.messageId, { signal: new AbortController().signal }), error => error instanceof Error && 'code' in error && error.code === 'MESSAGE_ID_NOT_FOUND');
    s.held = true;
    const operation = ports.api.getMessageById(s.messageId, { signal: new AbortController().signal });
    const outcome = operation.then(() => { throw new Error('Over-bound API error body accepted'); }, error => error);
    await s.entered.promise; assert.equal(s.bodyCancelled, 1);
    const close = ports.destroy(); let settled = false; void close.then(() => { settled = true; return 'settled'; });
    await ticks(); assert.equal(settled, false); assert.equal(testSdkCounters()?.closed, false);
    s.body.resolve(); const error: unknown = await outcome; assert.ok(error instanceof Error); assert.match(error.message, /response exceeds byte bound/);
    await close;
}
async function checkTransport(s: ScenarioState, ports: Ports, delays: number[]): Promise<void> {
  if (s.name === 'byte-utf8' || s.name === 'byte-limit') {
    // The ESM SDK imports ethers' ESM public entry, so mutate that actual class
    // rather than the separate CommonJS class selected by require.resolve.
    const utils: typeof import('../../../../.local/INPUT/provider/node_modules/ethers/lib.esm/utils/index.js') = await import(pathToFileURL(root + '/node_modules/ethers/lib.esm/utils/index.js').href);
    const original = Object.getOwnPropertyDescriptor(utils.FetchRequest.prototype, 'body'); assert.ok(original);
    Object.defineProperty(utils.FetchRequest.prototype, 'body', { ...original, get() { return s.name === 'byte-utf8' ? new Uint8Array([0xc3, 0x28]) : new Uint8Array(TEST_RPC_RESPONSE_LIMIT + 1); } });
    const previous = s.calls;
    try { await assert.rejects(ports.chains.ethereum.getMessagesInTx(s.sourceHash), s.name === 'byte-utf8' ? /UTF-8/ : /bytes exceed bound/); assert.equal(s.calls, previous); }
    finally { Object.defineProperty(utils.FetchRequest.prototype, 'body', original); }
  } else if (s.name === 'retry') {
    assert.equal((await ports.native.snapshot()).coherent, true); assert.deepEqual(delays, [10000]);
    const retried = s.requests.filter(row => row.request.method === 'getSlot'); assert.equal(retried.length, 2);
    assert.deepEqual(retried[0]?.request, retried[1]?.request);
  } else if (['rpc-reply-id', 'rpc-reply-batch', 'rpc-redirect'].includes(s.name)) {
    assert.equal((await ports.native.snapshot()).coherent, true);
    s.mutateReply = true;
    await assert.rejects(ports.native.snapshot(), s.name === 'rpc-reply-id' ? /response envelope/ : s.name === 'rpc-reply-batch' ? /response batch/ : /redirected/);
  } else if (s.name === 'api-error-body') { await checkErrorBody(s, ports); }
  else { throw new Error('Unknown transport unit scenario'); }
}
function observeBorrowedPorts(s: ScenarioState, ports: Ports): void {
  assert.ok(s.native && s.lane?.recipientAtas); assert.equal(s.evms.length, 1); assert.equal(s.svms.length, 1);
  const evm = s.evms[0], svm = s.svms[0]; assert.ok(evm && svm);
  assert.equal(evm.apiClient, svm.apiClient); assert.equal(evm.apiClient?.timeoutMs, 20000);
  const evmDestroy = evm.destroy, svmDestroy = svm.destroy;
  evm.destroy = () => { s.evmDestroyed++; evmDestroy(); if (s.name === 'cleanup-failure') { throw new Error('Controlled acquired chain cleanup failure'); } };
  svm.destroy = () => { s.svmDestroyed++; svmDestroy(); };
  assert.equal('destroy' in ports.chains.ethereum, false); assert.equal('provider' in ports.chains.ethereum, false);
  assert.equal('sign' in ports.native, false); assert.equal('web3' in ports.native, false); assert.equal('Keypair' in ports, false);
}
export async function scenario(name: string): Promise<void> {
  const s = createScenarioState(name), fetcher = createFetcher(s);
  globalThis.fetch = () => { s.globalFetchAttempts++; throw new Error('Uninjected global fetch forbidden'); };
  const selection: ExplicitTestSdkSelection = { providerProfile: TEST_SDK_PROFILE, testOnly: true, fixture, fixtureIdentity: fixture.identity, providerArchives: archives };
  const delays: number[] = [];
  const wait = async (delay: number, signal?: AbortSignal) => { assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false); delays.push(delay); };
  const options = { wait, directory: root, selection,
    sepolia: DEFAULT_SEPOLIA_RPC, solana: DEFAULT_SOLANA_RPC, fetcher, now: () => time, logger };
  if (s.name === 'partial') {
    await assert.rejects(createTestSdkStatus(options), /second-constructor/);
    assert.equal(s.evmDestroyed, 1); assert.equal(s.evms[0]?.abort.aborted, true); assert.equal(testSdkCounters()?.closed, true); process.stdout.write(JSON.stringify({ scenario: s.name, qualification: 'UNQUALIFIED', evidence: 'controlled-native-unit' }) + '\n'); return;
  }
  if (s.name === 'composition') {
    const phases: (boolean | undefined)[] = [];
    const result = await runStatus({ ...selection, sdkDirectory: root, replayFetch: fetcher, transfers: [], completeFixtureInventory: true }, () => { phases.push(testSdkCounters()?.closed); return time; });
    assert.deepEqual(phases, [false, true]); assert.equal(result.readOnly, true); assert.equal(result.accounting.status, 'unknown');
    assert.equal(s.evmDestroyed, 1); assert.equal(s.svmDestroyed, 1); assert.equal(s.globalFetchAttempts, 0);
    process.stdout.write(JSON.stringify({ scenario: s.name, qualification: 'UNQUALIFIED', evidence: 'controlled-native-unit' }) + '\n'); return;
  }
  const ports = await createTestSdkStatus(options);
  observeBorrowedPorts(s, ports);
  if (['byte-utf8', 'byte-limit', 'retry', 'rpc-reply-id', 'rpc-reply-batch', 'rpc-redirect', 'api-error-body'].includes(name)) { await checkTransport(s, ports, delays); }
  else if (s.reverseCausal) { await checkReverse(s, ports); }
  else if (s.causal) { if (await checkCausal(s, ports)) { return; } }
  else if (name === 'decoders') { await checkEvmDecoders(s, ports); }
  else if (name === 'svm-decoders') { await checkSvmDecoders(s, ports); }
  else if (name === 'observer') { await checkObserver(s, ports); }
  else if (['api-headers', 'api-body', 'native-body', 'sdk-body', 'deadline'].includes(name)) { await checkDrain(s, ports); }
  else if (s.name === 'cleanup-failure') {
    await assert.rejects(ports.destroy(), /chain cleanup failed/); assert.equal(s.evmDestroyed, 1); assert.equal(s.svmDestroyed, 1);
  } else if (s.name === 'unexpected') {
    const previous = s.calls;
    await assert.rejects(ports.api.getMessageById('../execution-inputs', { signal: new AbortController().signal }), /Unexpected TEST status API/);
    assert.equal(s.calls, previous);
  } else { throw new Error('Unknown native unit scenario'); }
  if (s.name !== 'deadline' && s.name !== 'cleanup-failure') { const close = ports.destroy(); assert.equal(ports.destroy(), close); await close; }
  assert.equal(testSdkCounters()?.closed, true); assert.equal(s.evmDestroyed, 1); assert.equal(s.svmDestroyed, 1);
  assert.equal(s.globalFetchAttempts, 0);
  process.stdout.write(JSON.stringify({ scenario: s.name, qualification: 'UNQUALIFIED', evidence: 'controlled-native-unit', networkEffects: 0, signingEffects: 0, calls: s.calls }) + '\n');
}
