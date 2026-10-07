import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { bindFixture } from '../src/adapters/fixture-binding.ts';
import { FORWARD, FORWARD_RECIPIENT_B, forwardRecipient, forwardRoute } from '../src/domain/evm-forward.mjs';
import { REPLACEMENT, fixtureNamespace, replacementFixture } from '../src/domain/replacement-fixture.ts';
import { accountTransfers, inspectTransfer, matchRequest, statusRecipient, validateStatusTransfers } from '../src/domain/transfer-status.mjs';
import type { StatusApiPort, StatusChainPort, StatusNativePort, StatusNativeProof, StatusRequest, StatusSnapshot, StatusTransferReport } from '../src/domain/transfer-status.mjs';
import { ROUTER_PROGRAM } from '../src/domain/solana-registration.ts';
import { projectMessage } from '../../../packages/domain/src/features/ccip-status/message.ts';
import type { Direction, TransferEvent, TransferIdentity } from '../../../packages/domain/src/features/ccip-status/message.ts';

// Public selection, not deployed-account or delivery evidence. Observations below
// are synthetic domain inputs; these tests qualify only the pure policy gate.
const fixture = replacementFixture('0x812c4dCBC459A55F8517E87e825B8c728cee7316', '0x8472aA06661671E7E4af43048F0D0446Eff2e97D');
const A = 'BoiQxGHPgVaqxPn2TjqzmoHPd5toyfxxZ4wW2M7P3gK8';
const B = 'QBqP2WraLUKU1G6tohJusxQ7iG15utpXLVZvvks3sNV';
const selection = { testOnly: true, fixture, fixtureIdentity: fixture.identity };
const hex = (byte: string): string => '0x' + byte.repeat(32);
const signature = (digit: string): string => '1'.repeat(63) + digit;
const solanaBlock = '1'.repeat(31) + '2';
const ethereumBlock = hex('ab');
const time = 1_791_288_000;

test('replacement A/B is a bounded forward choice and does not change hashed identity or route', () => {
  const before = JSON.stringify(fixture);
  assert.equal(fixture.identity, 'e0b6597cdd2f58af9a5240bee3ea2be144c4b3c438fbe5d16ddb7b059d7572a9');
  assert.equal(forwardRecipient(undefined, fixture), A);
  assert.equal(forwardRecipient(A, fixture), A);
  const selected: typeof A | typeof B = forwardRecipient(B, fixture);
  assert.equal(selected, B);
  assert.equal(forwardRoute(fixture).recipient, A);
  assert.equal(fixture.payer, A);
  assert.equal(REPLACEMENT.recipient, A);
  assert.equal(FORWARD_RECIPIENT_B, B);
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(createHash('sha256').update(before).digest('hex'), 'ea1672ab00238d65410bd2fbbc7fcb3bd1d8e7d957894c17f009ad421e591eed');
  for (const recipient of [null, '', 'A', 'B', FORWARD.recipient, fixture.administrator, A + '1', B + '1']) {
    assert.throws(() => forwardRecipient(recipient, fixture), /recipient/);
  }
  assert.equal(forwardRecipient(), FORWARD.recipient);
  assert.equal(forwardRecipient(B), B);
});

test('binder forward mode delegates bounded recipient policy; default and other invariants stay strict', () => {
  const journal = resolve('.local/review', fixtureNamespace(fixture), 'send.json');
  assert.equal(bindFixture({ ...selection, recipient: B }, [journal], 'forward')?.identity, fixture.identity);
  assert.equal(bindFixture(selection, [journal])?.recipient, A);
  assert.throws(() => bindFixture({ ...selection, recipient: B }, [journal]), /recipient/);
  for (const recipient of [null, '', FORWARD.recipient, fixture.administrator]) {
    assert.throws(() => bindFixture({ ...selection, recipient }, [journal], 'forward'), /recipient/);
  }
  for (const invalid of [
    { ...selection, chainId: '1' }, { ...selection, cluster: 'mainnet' }, { ...selection, testOnly: false },
    { ...selection, token: FORWARD.token }, { ...selection, pool: FORWARD.pool },
    { ...selection, administrator: FORWARD.administrator }, { ...selection, fixtureIdentity: hex('00') },
    { ...selection, expected: { testOnly: true, cluster: fixture.cluster, payer: B, mint: fixture.mint } },
    { ...selection, expected: { testOnly: true, cluster: fixture.cluster, payer: A, mint: FORWARD.recipient } },
  ]) {
    assert.throws(() => bindFixture({ ...invalid, recipient: B }, [journal], 'forward'));
  }
  assert.throws(() => bindFixture({ ...selection, recipient: B }, [resolve('.local/review/legacy/send')], 'forward'), /namespace/);
});

function transfer(direction: Direction, recipient: string, id: string, sourceHash: string, destinationHash: string): StatusTransferReport {
  const forward = direction === 'ethereum-to-solana';
  const identity: TransferIdentity = { messageId: hex(id), direction, amount: 1_000_000_000n,
    sourceToken: forward ? fixture.token : fixture.mint, destinationToken: forward ? fixture.mint : fixture.token,
    recipient: forward ? recipient : fixture.administrator };
  const event = (chain: 'ethereum' | 'solana', kind: TransferEvent['kind'], transactionId: string): TransferEvent => ({
    ...identity, chain, kind, transactionId, eventIndex: 0, blockHash: chain === 'ethereum' ? ethereumBlock : solanaBlock,
    blockHeight: 10n, finality: 'finalized',
  });
  const events = forward ? [event('ethereum', 'lock', sourceHash), event('solana', 'mint', destinationHash)] :
    [event('solana', 'burn', sourceHash), event('ethereum', 'release', destinationHash)];
  return { ...projectMessage(identity, events), sourceHash, events, fixtureIdentity: fixture.identity, selectedRecipient: recipient,
    route: { sourceSelector: forward ? 16015286601757825753n : 16423721717087811551n,
      destinationSelector: forward ? 16423721717087811551n : 16015286601757825753n,
      sourcePool: forward ? fixture.pool : fixture.solanaPool, sender: forward ? fixture.administrator : A,
      receiver: forward ? '11111111111111111111111111111111' : fixture.administrator,
      ...(forward ? { tokenReceiver: recipient } : {}) } };
}
function inventory(): StatusTransferReport[] {
  return [transfer('ethereum-to-solana', A, '01', hex('11'), signature('2')),
    transfer('solana-to-ethereum', A, '02', signature('3'), hex('22')),
    transfer('ethereum-to-solana', B, '03', hex('33'), signature('4'))];
}
function snapshot(): StatusSnapshot {
  const observation = { timestamp: time, maxAgeSeconds: 300, fresh: true };
  return { coherent: true, fixedSupply: 100_000_000_000n, lockedOnEthereum: 1_000_000_000n, supplyOnSolana: 1_000_000_000n,
    decimals: 9, fixtureIdentity: fixture.identity, ethereumBlock, ethereumHeight: 10n, solanaSlot: 10,
    observedAt: new Date(time * 1000).toISOString(), freshnessCheckedAt: new Date(time * 1000).toISOString(),
    freshness: { ethereum: { ...observation, maxAgeSeconds: 1800 }, solana: { ...observation, slot: 10 },
      solanaRepeated: { ...observation, slot: 10 } } };
}
function changeFirst(rows: readonly StatusTransferReport[], change: (row: StatusTransferReport) => StatusTransferReport): StatusTransferReport[] {
  const first = rows[0]; assert.ok(first);
  return [change(first), ...rows.slice(1)];
}
function changeEffect(row: StatusTransferReport, change: (event: TransferEvent) => TransferEvent): StatusTransferReport {
  const event = row.events[0]; assert.ok(event);
  return { ...row, events: [change(event), ...row.events.slice(1)] };
}
function relabel(row: StatusTransferReport, changed: Partial<TransferIdentity>): StatusTransferReport {
  return { ...row, identity: { ...row.identity, ...changed }, events: row.events.map(event => ({ ...event, ...changed })) };
}
function rowAt(rows: readonly StatusTransferReport[], index: number): StatusTransferReport {
  const row = rows[index]; assert.ok(row); return row;
}
function effectAt(row: StatusTransferReport, index: number): TransferEvent {
  const event = row.events[index]; assert.ok(event); return event;
}
function routeOf(row: StatusTransferReport) {
  const route = row.route; assert.ok(route); return route;
}
function refuse(rows: readonly StatusTransferReport[], observed = snapshot()): void {
  const result = accountTransfers(rows, observed, true, fixture);
  assert.equal(result.status, 'unknown');
  assert.equal('adjustedGlobalSupply' in result, false);
  assert.equal('backingSurplus' in result, false);
}

test('status accepts bounded partial A/B inventory, rejects unknown direction/reverse B and canonical EVM duplicates', () => {
  assert.equal(statusRecipient('ethereum-to-solana', B, fixture), B);
  assert.equal(statusRecipient('solana-to-ethereum', undefined, fixture), A);
  assert.throws(() => statusRecipient('solana-to-ethereum', B, fixture), /only recipient A/);
  assert.throws(() => statusRecipient('other', A, fixture), /direction/);
  const rows = inventory().map(row => ({ sourceHash: row.sourceHash, direction: row.identity.direction, recipient: row.selectedRecipient }));
  for (let length = 0; length <= 3; length++) { validateStatusTransfers(rows.slice(0, length), fixture); }
  const first = rows[0]; assert.ok(first);
  assert.throws(() => validateStatusTransfers([...rows, first], fixture), /three/);
  assert.throws(() => validateStatusTransfers([first, { ...first, sourceHash: hex('55') }], fixture), /Duplicate/);
  assert.throws(() => validateStatusTransfers([{ ...first, sourceHash: hex('ab') }, { ...first, recipient: B, sourceHash: hex('AB') }], fixture), /Duplicate/);
  validateStatusTransfers([{ direction: 'solana-to-ethereum', sourceHash: signature('A') },
    { direction: 'ethereum-to-solana', recipient: B, sourceHash: hex('aa') }], fixture);
  for (const sourceHash of [undefined, null, '', 'hash', 1]) {
    assert.throws(() => validateStatusTransfers([{ ...first, sourceHash }], fixture));
  }
});

test('exact replacement gate accepts only three distinct slots/messages and six finalized physical effects at F100/L1/S1', () => {
  const rows = inventory(), observed = snapshot();
  const result = accountTransfers(rows, observed, true, fixture);
  assert.equal(result.status, 'exact');
  assert.ok('adjustedGlobalSupply' in result);
  assert.equal(result.adjustedGlobalSupply, 100_000_000_000n);
  assert.equal(result.backingSurplus, 0n);
  assert.equal(accountTransfers(rows, observed, false, fixture).status, 'unknown');
  for (let length = 0; length < 3; length++) { refuse(rows.slice(0, length)); }
  const first = rows[0]; assert.ok(first);
  refuse([...rows, first]);
  refuse([first, first, first]);
  for (const value of [0n, 2_000_000_000n]) { refuse(rows, { ...observed, lockedOnEthereum: value, supplyOnSolana: value }); }
  refuse(rows, { ...observed, fixedSupply: 99_000_000_000n });
  refuse(rows, { ...observed, decimals: 8 });
  refuse(rows, { ...observed, fixtureIdentity: 'different-fixture' });
  for (const pending of [null, 1_000_000_000n]) {
    refuse(rows, { ...observed, pendingEthereumToSolana: pending });
    refuse(rows, { ...observed, pendingSolanaToEthereum: pending });
  }
  for (const field of ['decimals', 'fixtureIdentity', 'freshness', 'observedAt', 'ethereumBlock', 'solanaSlot']) {
    const missing = snapshot(); Reflect.deleteProperty(missing, field); refuse(rows, missing);
  }
});

test('caller labels cannot replace route, token, recipient, source, message or observed amount association', () => {
  const rows = inventory();
  for (const change of [
    (row: StatusTransferReport): StatusTransferReport => ({ ...row, fixtureIdentity: 'wrong' }),
    (row: StatusTransferReport): StatusTransferReport => ({ ...row, selectedRecipient: B }),
    (row: StatusTransferReport): StatusTransferReport => ({ ...row, sourceHash: hex('44') }),
    (row: StatusTransferReport): StatusTransferReport => relabel(row, { sourceToken: FORWARD.token }),
    (row: StatusTransferReport): StatusTransferReport => relabel(row, { destinationToken: fixture.token }),
    (row: StatusTransferReport): StatusTransferReport => relabel(row, { recipient: B }),
    (row: StatusTransferReport): StatusTransferReport => relabel(row, { amount: 1n }),
    (row: StatusTransferReport): StatusTransferReport => ({ ...row, route: { ...routeOf(row), sourcePool: FORWARD.pool } }),
    (row: StatusTransferReport): StatusTransferReport => ({ ...row, route: { ...routeOf(row), destinationSelector: 1n } }),
    (row: StatusTransferReport): StatusTransferReport => ({ ...row, route: { ...routeOf(row), sender: B } }),
    (row: StatusTransferReport): StatusTransferReport => ({ ...row, route: { ...routeOf(row), tokenReceiver: B } }),
    (row: StatusTransferReport): StatusTransferReport => ({ ...row, route: { ...routeOf(row), receiver: fixture.administrator } }),
  ]) { refuse(changeFirst(rows, change)); }
  for (const field of ['fixtureIdentity', 'selectedRecipient', 'sourceHash', 'route']) {
    const missing = changeFirst(rows, row => { const copy = structuredClone(row); Reflect.deleteProperty(copy, field); return copy; });
    refuse(missing);
  }
  const reverse = rows[1]; assert.ok(reverse);
  refuse([rowAt(rows, 0), { ...reverse, selectedRecipient: B }, rowAt(rows, 2)]);
  refuse([rowAt(rows, 0), relabel(reverse, { recipient: A }), rowAt(rows, 2)]);
  const repeated = transfer('ethereum-to-solana', A, 'ab', hex('11'), signature('2'));
  refuse([repeated, reverse, transfer('ethereum-to-solana', B, 'AB', hex('33'), signature('4'))]);
  refuse([rowAt(rows, 0), reverse, transfer('ethereum-to-solana', B, '03', hex('11'), signature('4'))]);
});

test('replacement B source decoder association requires the actual selected receiver, pools, pair and selectors', () => {
  const hash = hex('ab');
  const request: StatusRequest = { tx: { hash }, log: { transactionHash: hash, index: 0, address: fixture.pool, data: '0x', topics: [] },
    lane: { sourceChainSelector: 16015286601757825753n, destChainSelector: 16423721717087811551n, onRamp: fixture.pool },
    message: { data: '0x', messageId: hex('01'), sequenceNumber: 1n, sourceChainSelector: 16015286601757825753n,
      destChainSelector: 16423721717087811551n, sender: fixture.administrator, receiver: '11111111111111111111111111111111',
      tokenReceiver: B, tokenAmounts: [{ amount: 1_000_000_000n, sourcePoolAddress: fixture.pool, destTokenAddress: fixture.mint }] } };
  assert.equal(matchRequest(request, 'ethereum-to-solana', hash, B, fixture), true);
  assert.equal(matchRequest(request, 'ethereum-to-solana', hex('AB'), B, fixture), true);
  assert.equal(matchRequest(request, 'ethereum-to-solana', hash, undefined, fixture), false);
  const message = request.message, token = message.tokenAmounts[0]; assert.ok(token);
  for (const changed of [
    { ...message, tokenReceiver: A }, { ...message, receiver: fixture.administrator },
    { ...message, sender: FORWARD.administrator }, { ...message, destChainSelector: 1n },
    { ...message, tokenAmounts: [{ ...token, amount: 2_000_000_000n }] },
    { ...message, tokenAmounts: [{ ...token, sourcePoolAddress: FORWARD.pool }] },
    { ...message, tokenAmounts: [{ ...token, destTokenAddress: fixture.token }] },
  ]) { assert.equal(matchRequest({ ...request, message: changed }, 'ethereum-to-solana', hash, B, fixture), false); }
});

// Concrete consuming-port inputs exercise the existing inspection boundary.
// They are controlled unit observations, not captures or authenticated delivery.
function inspection(row: StatusTransferReport) {
  const forward = row.identity.direction === 'ethereum-to-solana', route = routeOf(row);
  const source = effectAt(row, 0), destination = effectAt(row, 1);
  const selectedRecipient = row.selectedRecipient; assert.ok(selectedRecipient);
  const onRamp = forward ? '0x' + '44'.repeat(20) : ROUTER_PROGRAM;
  const offRamp = forward ? '1'.repeat(31) + '3' : '0x' + '55'.repeat(20);
  const encoded = Buffer.from('12345678event').toString('base64');
  const request: StatusRequest = { tx: { hash: source.transactionId, from: forward ? fixture.administrator : A },
    log: { transactionHash: source.transactionId, index: 1, address: onRamp, data: encoded, topics: ['0x3132333435363738'] },
    lane: { sourceChainSelector: route.sourceSelector, destChainSelector: route.destinationSelector, onRamp },
    message: { data: '0x', messageId: row.identity.messageId, sourceChainSelector: route.sourceSelector,
      destChainSelector: route.destinationSelector, sender: route.sender, receiver: route.receiver,
      ...(forward ? { tokenReceiver: selectedRecipient } : {}), sequenceNumber: 7n,
      tokenAmounts: [{ amount: row.identity.amount, sourcePoolAddress: route.sourcePool, destTokenAddress: row.identity.destinationToken }] } };
  const programLogs = (program: string): string[] => [`Program ${program} invoke [1]`, 'Program data: ' + encoded, `Program ${program} success`];
  const sourceProof: StatusNativeProof = { eventIndex: source.eventIndex, blockHash: source.blockHash, blockHeight: source.blockHeight,
    transaction: forward ? { to: forwardRoute(fixture).router, from: fixture.administrator } :
      { message: { accountKeys: [{ pubkey: A, signer: true }], instructions: [{ programId: ROUTER_PROGRAM }] } },
    ...(forward ? { logs: [{ logIndex: '0x1', address: onRamp, data: encoded, topics: request.log.topics }] } : { programLogs: programLogs(onRamp) }) };
  const destinationProof: StatusNativeProof = { eventIndex: destination.eventIndex, blockHash: destination.blockHash,
    blockHeight: destination.blockHeight, transaction: {}, ...(forward ? { programLogs: programLogs(offRamp) } :
      { logs: [{ logIndex: '0x1', address: offRamp, data: encoded, topics: request.log.topics }] }) };
  const chain = (name: TransferEvent['chain']): StatusChainPort => ({
    async getMessagesInTx(hash) {
      assert.equal(name, source.chain); assert.equal(hash, source.transactionId); return [request];
    },
    async getExecutionReceiptInTx(hash, filters) {
      assert.equal(name, destination.chain); assert.equal(hash, destination.transactionId);
      assert.equal(filters.offRamp, offRamp); assert.equal(filters.messageId, row.identity.messageId);
      assert.equal(filters.sourceChainSelector, route.sourceSelector);
      return { receipt: { messageId: row.identity.messageId, sequenceNumber: 7n, sourceChainSelector: route.sourceSelector, state: 2 },
        log: { transactionHash: hash, index: 1, address: offRamp, data: encoded, topics: request.log.topics } };
    },
  });
  const observe = async (name: TransferEvent['chain'], hash: string, kind: TransferEvent['kind'], recipient?: string): Promise<StatusNativeProof> => {
    if (name === source.chain) {
      assert.equal(hash, source.transactionId); assert.equal(kind, source.kind); return sourceProof;
    }
    assert.equal(hash, destination.transactionId); assert.equal(kind, destination.kind);
    assert.equal(recipient, selectedRecipient); return destinationProof;
  };
  const native: StatusNativePort = { lane: { fixture, solanaPool: fixture.solanaPool },
    ethereum: (hash, kind, recipient) => observe('ethereum', hash, kind, recipient),
    solana: (hash, kind, recipient) => observe('solana', hash, kind, recipient),
    async authorizeOffRamp(name, address, selector) {
      assert.equal(name, destination.chain); assert.equal(address, offRamp); assert.equal(selector, route.sourceSelector);
    },
  };
  const api: StatusApiPort = { async getMessageById(messageId) {
    assert.equal(messageId, row.identity.messageId);
    return { metadata: { status: 'SUCCESS', offRamp, receiptTransactionHash: destination.transactionId } };
  } };
  const inspect = () => inspectTransfer({ sourceHash: source.transactionId, direction: row.identity.direction, recipient: selectedRecipient },
    { ethereum: chain('ethereum'), solana: chain('solana') }, native, api, 2);
  return { inspect, request, sourceProof, destinationProof };
}

test('replacement inspection binds logical A/B to actual wire route and never fills missing physical observations', async () => {
  const scenarios = inventory().map(inspection), reports: StatusTransferReport[] = [];
  for (const scenario of scenarios) {
    const report = await scenario.inspect(); reports.push(report);
    assert.equal(report.status, 'settled'); assert.equal(report.pendingAmount, 0n);
    assert.equal(report.fixtureIdentity, fixture.identity);
    assert.equal(routeOf(report).sourcePool, scenario.request.message.tokenAmounts[0]?.sourcePoolAddress);
  }
  const first = rowAt(reports, 0), reverse = rowAt(reports, 1), last = rowAt(reports, 2);
  assert.equal(first.selectedRecipient, A); assert.equal(last.selectedRecipient, B);
  assert.equal(routeOf(last).tokenReceiver, B); assert.equal(last.identity.recipient, B);
  assert.equal(reverse.selectedRecipient, A); assert.equal(reverse.identity.recipient, fixture.administrator);
  assert.equal(accountTransfers(reports, snapshot(), true, fixture).status, 'exact');
  const bScenario = scenarios[2]; assert.ok(bScenario);
  bScenario.request.message.tokenReceiver = A;
  await assert.rejects(bScenario.inspect(), /unique\/exact/);
  bScenario.request.message.tokenReceiver = B;
  Reflect.deleteProperty(bScenario.destinationProof, 'eventIndex');
  const missing = await bScenario.inspect();
  assert.equal(missing.pendingAmount, null);
  refuse([first, reverse, missing]);
});

test('physical uniqueness ignores message and kind labels, normalizes EVM case, keeps Solana case distinct', () => {
  const rows = inventory(), first = rows[0], reverse = rows[1], last = rows[2];
  assert.ok(first && reverse && last);
  const lock = first.events[0], mint = first.events[1]; assert.ok(lock && mint);
  refuse([first, reverse, { ...last, events: [effectAt(last, 0), { ...effectAt(last, 1), transactionId: mint.transactionId }] }]);
  // Same physical log, different token-effect kind, direction and message label.
  refuse([first, { ...reverse, events: [effectAt(reverse, 0), { ...effectAt(reverse, 1), transactionId: lock.transactionId }] }, last]);
  const mixed = transfer('ethereum-to-solana', A, '01', hex('ab'), signature('2'));
  refuse([mixed, { ...reverse, events: [effectAt(reverse, 0), { ...effectAt(reverse, 1), transactionId: hex('AB') }] }, last]);
  const distinctCase = [transfer('ethereum-to-solana', A, '01', hex('11'), signature('A')), reverse,
    transfer('ethereum-to-solana', B, '03', hex('33'), signature('a'))];
  assert.equal(accountTransfers(distinctCase, snapshot(), true, fixture).status, 'exact');
  // Multiple effects in one transaction are physical peers, not automatically duplicates.
  const peer = { ...effectAt(last, 1), transactionId: mint.transactionId, eventIndex: 1 };
  assert.equal(accountTransfers([first, reverse, { ...last, events: [effectAt(last, 0), peer] }], snapshot(), true, fixture).status, 'exact');
});

test('missing actual physical metadata, nonfinality, reorg, conflicting blocks and out-of-snapshot effects refuse exact', () => {
  const rows = inventory();
  for (const field of ['transactionId', 'eventIndex', 'blockHash', 'blockHeight', 'finality']) {
    refuse(changeFirst(rows, row => changeEffect(row, event => { const copy = structuredClone(event); Reflect.deleteProperty(copy, field); return copy; })));
  }
  for (const change of [
    (event: TransferEvent): TransferEvent => ({ ...event, eventIndex: -1 }),
    (event: TransferEvent): TransferEvent => ({ ...event, eventIndex: 0.5 }),
    (event: TransferEvent): TransferEvent => ({ ...event, eventIndex: Number.MAX_SAFE_INTEGER + 1 }),
    (event: TransferEvent): TransferEvent => ({ ...event, transactionId: 'discovery-hint' }),
    (event: TransferEvent): TransferEvent => ({ ...event, blockHeight: 11n }),
    (event: TransferEvent): TransferEvent => ({ ...event, blockHeight: 9n }),
    (event: TransferEvent): TransferEvent => ({ ...event, blockHeight: -1n }),
    (event: TransferEvent): TransferEvent => ({ ...event, blockHash: hex('ff') }),
    (event: TransferEvent): TransferEvent => ({ ...event, finality: 'unfinalized' }),
    (event: TransferEvent): TransferEvent => ({ ...event, finality: 'reorged' }),
  ]) { refuse(changeFirst(rows, row => changeEffect(row, change))); }
  const first = rows[0]; assert.ok(first);
  refuse(changeFirst(rows, row => ({ ...row, events: [...row.events, effectAt(row, 0)] })));
  const unknown = { ...first, events: first.events.slice(0, 1), pendingAmount: null };
  refuse([unknown, ...rows.slice(1)]);
  refuse(changeFirst(rows, row => ({ ...row, pendingAmount: null })));
  refuse(changeFirst(rows, row => ({ ...row, pendingAmount: 1_000_000_000n })));
  const higherSnapshot = { ...snapshot(), ethereumHeight: 20n };
  refuse(changeFirst(rows, row => changeEffect(row, event => ({ ...event, blockHash: hex('ff') }))), higherSnapshot);
  refuse(changeFirst(rows, row => ({ ...row, events: [effectAt(row, 0), { ...effectAt(row, 1), blockHeight: 11n }] })));
  const olderSource = changeFirst(rows, row => changeEffect(row, event => ({ ...event, blockHeight: 9n, blockHash: hex('cc') })));
  assert.equal(accountTransfers(olderSource, snapshot(), true, fixture).status, 'exact');
});

test('freshness and coherence remain prerequisites even with complete observed inventory', () => {
  const rows = inventory(), observed = snapshot();
  const freshness = observed.freshness; assert.ok(freshness);
  refuse(rows, { ...observed, coherent: false });
  for (const chain of ['ethereum', 'solana', 'solanaRepeated'] as const) {
    const observation = freshness[chain]; assert.ok(observation);
    for (const timestamp of [time + 1, time - (chain === 'ethereum' ? 1801 : 301), -1, NaN]) {
      refuse(rows, { ...observed, freshness: { ...freshness, [chain]: { ...observation, timestamp } } });
    }
    refuse(rows, { ...observed, freshness: { ...freshness, [chain]: { ...observation, fresh: false } } });
  }
  refuse(rows, { ...observed, freshnessCheckedAt: new Date((time + 301) * 1000).toISOString() });
  refuse(rows, { ...observed, observedAt: 'invalid' });
});

test('omitting selected fixture preserves generic historical exact reconciliation outside the three-message seal', () => {
  for (const value of [0n, 2_000_000_000n]) {
    const observed = { ...snapshot(), lockedOnEthereum: value, supplyOnSolana: value };
    assert.equal(accountTransfers([], observed, true).status, 'exact');
    refuse([], observed);
  }
  const first = inventory()[0]; assert.ok(first);
  assert.equal(accountTransfers([first], snapshot(), true).status, 'exact');
  refuse([first]);
});
