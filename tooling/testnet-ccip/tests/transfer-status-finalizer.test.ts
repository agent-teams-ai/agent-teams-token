import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeStatusReport } from '../src/composition/transfer-status.mjs';
import { replacementFixture } from '../src/domain/replacement-fixture.ts';
import type { StatusSnapshot, StatusTransferReport } from '../src/domain/transfer-status.mjs';
import { projectMessage } from '../../../packages/domain/src/features/ccip-status/message.ts';
import type { Direction, TransferEvent, TransferIdentity } from '../../../packages/domain/src/features/ccip-status/message.ts';

// Synthetic domain observations exercise composition/accounting only. These
// addresses and effects are neither native captures nor public delivery proof.
const fixture = replacementFixture('0x812c4dCBC459A55F8517E87e825B8c728cee7316', '0x8472aA06661671E7E4af43048F0D0446Eff2e97D');
const A = 'BoiQxGHPgVaqxPn2TjqzmoHPd5toyfxxZ4wW2M7P3gK8';
const B = 'QBqP2WraLUKU1G6tohJusxQ7iG15utpXLVZvvks3sNV';
const time = 1_791_288_000_000;
const ethereumBlock = '0x' + 'ab'.repeat(32);
const solanaBlock = '1'.repeat(31) + '2';

function transfer(direction: Direction, recipient: string, byte: string, digit: string): StatusTransferReport {
  const forward = direction === 'ethereum-to-solana';
  const evmHash = '0x' + byte.repeat(32), solanaHash = '1'.repeat(63) + digit;
  const identity: TransferIdentity = { messageId: '0x' + digit.repeat(64), direction,
    amount: 1_000_000_000n, sourceToken: forward ? fixture.token : fixture.mint,
    destinationToken: forward ? fixture.mint : fixture.token, recipient: forward ? recipient : fixture.administrator };
  const event = (chain: TransferEvent['chain'], kind: TransferEvent['kind']): TransferEvent => ({
    ...identity, chain, kind, transactionId: chain === 'ethereum' ? evmHash : solanaHash,
    eventIndex: 0, blockHash: chain === 'ethereum' ? ethereumBlock : solanaBlock,
    blockHeight: 10n, finality: 'finalized',
  });
  const events = forward ? [event('ethereum', 'lock'), event('solana', 'mint')] :
    [event('solana', 'burn'), event('ethereum', 'release')];
  return { ...projectMessage(identity, events), events, sourceHash: forward ? evmHash : solanaHash,
    fixtureIdentity: fixture.identity, selectedRecipient: recipient,
    route: { sourceSelector: forward ? 16015286601757825753n : 16423721717087811551n,
      destinationSelector: forward ? 16423721717087811551n : 16015286601757825753n,
      sourcePool: forward ? fixture.pool : fixture.solanaPool, sender: forward ? fixture.administrator : A,
      receiver: forward ? '11111111111111111111111111111111' : fixture.administrator,
      ...(forward ? { tokenReceiver: recipient } : {}) } };
}

function inventory(): StatusTransferReport[] {
  return [transfer('ethereum-to-solana', A, '11', '2'), transfer('solana-to-ethereum', A, '22', '3'),
    transfer('ethereum-to-solana', B, '33', '4')];
}

function snapshot(): StatusSnapshot {
  const observed = { timestamp: time / 1000, maxAgeSeconds: 300, fresh: true, slot: 10 };
  return { coherent: true, fixedSupply: 100_000_000_000n, lockedOnEthereum: 1_000_000_000n,
    supplyOnSolana: 1_000_000_000n, fixtureIdentity: fixture.identity, decimals: 9,
    ethereumBlock, ethereumHeight: 10n, solanaSlot: 10, observedAt: new Date(time).toISOString(),
    freshness: { ethereum: { timestamp: time / 1000, maxAgeSeconds: 1800, fresh: true },
      solana: observed, solanaRepeated: observed } };
}

function refuse(accounting: Awaited<ReturnType<typeof finalizeStatusReport>>['accounting']): void {
  assert.equal(accounting.status, 'unknown');
  assert.equal('adjustedGlobalSupply' in accounting, false);
  assert.equal('backingSurplus' in accounting, false);
}

test('fifth fixture reaches replacement accounting; generic L=S alone cannot seal partial inventory', async () => {
  for (const count of [0, 1, 2]) {
    const transfers = inventory().slice(0, count), observed = snapshot();
    const collect = async () => ({ transfers, snapshot: observed });
    const generic = await finalizeStatusReport(collect, async () => {}, true, () => time);
    assert.equal(generic.accounting.status, 'exact');
    const replacement = await finalizeStatusReport(collect, async () => {}, true, () => time, fixture);
    refuse(replacement.accounting);
    assert.equal(replacement.transfers, transfers);
  }
});

test('replacement accepts actual supplied three-message/six-effect F100/L1/S1 domain observations', async () => {
  const transfers = inventory(), observed = snapshot(), original = structuredClone(observed);
  const report = await finalizeStatusReport(async () => ({ transfers, snapshot: observed }), async () => {}, true, () => time, fixture);
  assert.equal(report.readOnly, true);
  assert.equal(report.transfers, transfers);
  assert.equal(report.accounting.status, 'exact');
  assert.ok('adjustedGlobalSupply' in report.accounting);
  assert.equal(report.accounting.adjustedGlobalSupply, 100_000_000_000n);
  assert.equal(report.accounting.backingSurplus, 0n);
  assert.equal(report.accounting.snapshot.freshnessCheckedAt, new Date(time).toISOString());
  assert.deepEqual(observed, original);
  for (const value of [0n, 2_000_000_000n]) {
    const collect = async () => ({ transfers, snapshot: { ...observed, lockedOnEthereum: value, supplyOnSolana: value } });
    assert.equal((await finalizeStatusReport(collect, async () => {}, true, () => time)).accounting.status, 'exact');
    refuse((await finalizeStatusReport(collect, async () => {}, true, () => time, fixture)).accounting);
  }
  refuse((await finalizeStatusReport(async () => ({ transfers, snapshot: observed }), async () => {}, false, () => time, fixture)).accounting);
});

test('missing native observation metadata remains unknown and is never filled from fixture expectations', async () => {
  for (const field of ['fixtureIdentity', 'decimals', 'ethereumBlock', 'observedAt']) {
    const observed = snapshot();
    Reflect.deleteProperty(observed, field);
    const original = structuredClone(observed);
    const report = await finalizeStatusReport(async () => ({ transfers: inventory(), snapshot: observed }), async () => {}, true, () => time, fixture);
    refuse(report.accounting);
    assert.deepEqual(observed, original);
    assert.equal(Object.hasOwn(observed, field), false);
  }
});

test('three message labels cannot make a reused physical mint effect qualify', async () => {
  const transfers = inventory(), first = transfers[0], last = transfers[2];
  assert.ok(first && last);
  const reused = first.events[1], source = last.events[0], destination = last.events[1];
  assert.ok(reused && source && destination);
  transfers[2] = { ...last, events: [source, { ...destination, transactionId: reused.transactionId, eventIndex: reused.eventIndex }] };
  const collect = async () => ({ transfers, snapshot: snapshot() });
  assert.equal((await finalizeStatusReport(collect, async () => {}, true, () => time)).accounting.status, 'exact');
  refuse((await finalizeStatusReport(collect, async () => {}, true, () => time, fixture)).accounting);
});

test('fourth clock runs after cleanup; replacement freshness expires at the same retained boundary', async () => {
  for (const delay of [300_000, 300_001]) {
    let clock = time;
    const order: string[] = [];
    const report = await finalizeStatusReport(async () => {
      order.push('collect');
      return { transfers: inventory(), snapshot: snapshot() };
    }, async () => {
      order.push('cleanup');
      await Promise.resolve();
      clock += delay;
      order.push('cleaned');
    }, true, () => { order.push('clock'); return clock; }, fixture);
    assert.deepEqual(order, ['collect', 'cleanup', 'cleaned', 'clock']);
    assert.equal(report.accounting.status, delay === 300_000 ? 'exact' : 'unknown');
  }
});

test('cleanup failure refuses publication and collect failure still cleans up without reading the clock', async () => {
  const collectError = new Error('collection failed'), cleanupError = new Error('cleanup unresolved');
  for (const collectionFails of [false, true]) {
    for (const cleanupFails of [false, true]) {
      if (!collectionFails && !cleanupFails) { continue; }
      const order: string[] = [];
      await assert.rejects(finalizeStatusReport(async () => {
        order.push('collect');
        if (collectionFails) { throw collectError; }
        return { transfers: inventory(), snapshot: snapshot() };
      }, async () => {
        order.push('cleanup');
        if (cleanupFails) { throw cleanupError; }
      }, true, () => { order.push('clock'); return time; }, fixture), cleanupFails ? cleanupError : collectError);
      assert.deepEqual(order, ['collect', 'cleanup']);
    }
  }
});
