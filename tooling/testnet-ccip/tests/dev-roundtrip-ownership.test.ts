import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { admitOwnership } from '../src/domain/dev-roundtrip-report.mjs';

type Chain = 'ethereum' | 'solana';
type IndexScheme = 'evm-log-index-v1' | 'svm-recorded-legacy-v1' | 'svm-physical-interleaved-v1';
type Destination = { chain: 'ethereum'; indexScheme: 'evm-log-index-v1' } |
  { chain: 'solana'; indexScheme: 'svm-recorded-legacy-v1' | 'svm-physical-interleaved-v1' };
type Identity = {
  messageId: string; direction: 'ethereum-to-solana' | 'solana-to-ethereum'; amount: string;
  sourceToken: string; destinationToken: string; recipient: string;
};
type Observation = {
  identity: Identity; routeHash: string; chain: Chain; kind: 'lock' | 'mint' | 'burn' | 'release';
  transactionId: string; eventIndex: number; indexScheme: IndexScheme;
  instructionPath: number[] | null; owningInstructionPath: number[] | null;
  blockHash: string; blockHeight: string; finality: 'finalized';
};
type Message = { identity: Identity; routeHash: string; sourceTransaction: string; events: Observation[] };
type Admission = { status: null | 'unknown' | 'inconsistent'; reasons: string[] };
type Fixture = {
  amount: string;
  pair: { evm: { token: string; recipient: string }; svm: { mint: string; recipient: string } };
};

// Reuse existing DEV token/amount/recipient data. Transaction, message, effect
// and block identifiers below model local observations only, never native proof.
const fixture: Fixture = JSON.parse(await readFile(new URL('fixtures/dev-transfer-preview.json', import.meta.url), 'utf8'));
const routeHash = 'a'.repeat(64), sharedTransaction = 'shared-local-destination';
const conflictReason = 'conflicting-transaction-block-provenance';
const clear: Admission = { status: null, reasons: [] };
const contradicted: Admission = { status: 'inconsistent', reasons: [conflictReason] };
const ambiguous: Admission = { status: 'unknown', reasons: ['mixed-index-schemes'] };
const destinations: Destination[] = [
  { chain: 'ethereum', indexScheme: 'evm-log-index-v1' },
  { chain: 'solana', indexScheme: 'svm-physical-interleaved-v1' },
  { chain: 'solana', indexScheme: 'svm-recorded-legacy-v1' },
];

function message(destination: Destination, ordinal: number): Message {
  const forward = destination.chain === 'solana';
  const identity: Identity = { messageId: '0x' + ordinal.toString(16).padStart(64, '0'),
    direction: forward ? 'ethereum-to-solana' : 'solana-to-ethereum', amount: fixture.amount,
    sourceToken: forward ? fixture.pair.evm.token : fixture.pair.svm.mint,
    destinationToken: forward ? fixture.pair.svm.mint : fixture.pair.evm.token,
    recipient: forward ? fixture.pair.svm.recipient : fixture.pair.evm.recipient };
  const sourceTransaction = 'local-source-' + ordinal;
  function event(chain: Chain, kind: Observation['kind'], transactionId: string, indexScheme: IndexScheme): Observation {
    const physicalSvm = indexScheme === 'svm-physical-interleaved-v1';
    return { identity: { ...identity }, routeHash, chain, kind, transactionId, eventIndex: ordinal, indexScheme,
      instructionPath: physicalSvm ? [1, ordinal] : null, owningInstructionPath: physicalSvm ? [1] : null,
      blockHash: 'local-block-A', blockHeight: '50', finality: 'finalized' };
  }
  return { identity, routeHash, sourceTransaction, events: [
    event(forward ? 'ethereum' : 'solana', forward ? 'lock' : 'burn', sourceTransaction,
      forward ? 'evm-log-index-v1' : 'svm-physical-interleaved-v1'),
    event(destination.chain, forward ? 'mint' : 'release', sharedTransaction, destination.indexScheme),
  ] };
}

function inventory(destination: Destination): Message[] {
  return [1, 2, 3, 4].map(ordinal => message(destination, ordinal));
}

function contradict(messages: Message[], field: 'blockHash' | 'blockHeight'): void {
  if (field === 'blockHash') { messages[2]!.events[1]!.blockHash = 'local-block-B'; }
  else { messages[2]!.events[1]!.blockHeight = '51'; }
}

function recordedAlias(messages: Message[], ordinal: number): void {
  const event = messages[ordinal]!.events[1]!;
  event.indexScheme = 'svm-recorded-legacy-v1'; event.instructionPath = null; event.owningInstructionPath = null;
}

for (const destination of destinations) {
  for (const field of ['blockHash', 'blockHeight'] as const) {
    test(`CONTENT-P2-001 ${destination.chain}/${destination.indexScheme} ${field}: A/A/B/A contradicts every owner`, () => {
      const messages = inventory(destination); contradict(messages, field);
      assert.equal(new Set(messages.map(m => m.identity.messageId)).size, 4);
      assert.equal(new Set(messages.map(m => m.sourceTransaction)).size, 4);
      assert.equal(new Set(messages.map(m => m.events[1]!.eventIndex)).size, 4);
      const before = structuredClone(messages);
      assert.deepEqual(admitOwnership(messages.slice(0, 2)), [clear, clear]);
      assert.deepEqual(admitOwnership(messages.slice(0, 3)), [contradicted, contradicted, contradicted]);
      assert.deepEqual(admitOwnership(messages), [contradicted, contradicted, contradicted, contradicted]);
      assert.deepEqual(messages, before);
    });
  }

  test(`${destination.chain}/${destination.indexScheme}: coherent shared destination and identical replays stay admitted`, () => {
    const messages = inventory(destination);
    for (const m of messages) { m.events.push(...structuredClone(m.events)); }
    const before = structuredClone(messages);
    assert.deepEqual(admitOwnership(messages), [clear, clear, clear, clear]);
    assert.deepEqual(messages, before);
  });

  test(`${destination.chain}/${destination.indexScheme}: contradiction stays within chain:transaction`, () => {
    const messages = inventory(destination); contradict(messages, 'blockHash');
    const independentTransaction = message(destination, 5);
    independentTransaction.events[1]!.transactionId = 'independent-local-destination';
    const independentChain = message(destination.chain === 'ethereum' ? destinations[1]! : destinations[0]!, 6);
    // Same transaction text and ordinal on the other chain are independent.
    independentChain.events[1]!.eventIndex = messages[0]!.events[1]!.eventIndex;
    if (independentChain.events[1]!.instructionPath) { independentChain.events[1]!.instructionPath = [1, 1]; }
    messages.push(independentTransaction, independentChain);
    assert.deepEqual(admitOwnership(messages), [contradicted, contradicted, contradicted, contradicted, clear, clear]);
  });
}

test('coherent mixed SVM index schemes remain unknown for every transaction owner', () => {
  const messages = inventory(destinations[1]!); recordedAlias(messages, 2);
  assert.deepEqual(admitOwnership(messages), [ambiguous, ambiguous, ambiguous, ambiguous]);
});

for (const field of ['blockHash', 'blockHeight'] as const) {
  test(`SVM ${field} contradiction dominates mixed schemes before, during and after divergence`, () => {
    for (const aliasOwner of [1, 2, 3]) {
      const messages = inventory(destinations[1]!); contradict(messages, field); recordedAlias(messages, aliasOwner);
      const admissions: Admission[] = admitOwnership(messages);
      for (const admission of admissions) {
        assert.equal(admission.status, 'inconsistent');
        assert.deepEqual(admission.reasons.toSorted(), [conflictReason, 'mixed-index-schemes']);
      }
    }
  });
}
