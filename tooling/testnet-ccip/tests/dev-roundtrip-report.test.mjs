import assert from 'node:assert/strict';
import { test } from 'node:test';
import fsPromises, { readFile, writeFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { compiledReportPorts, runDevRoundtripReport } from '../src/composition/dev-roundtrip-report.mjs';
import { prepareDevRoundtripReport } from '../src/application/dev-roundtrip-report.mjs';
import { prepareDevTransferPreview } from '../src/application/dev-transfer-preview.mjs';
import { previewPorts } from '../src/adapters/dev-transfer-preview-store.mjs';
import { parseReportHeader, checkCaptureJson, readReportFile, digestReport, hashReportBytes, publishReport } from '../src/adapters/dev-roundtrip-report-input.mjs';
import { PROOF_SHA256, PROOF_PATH } from '../src/domain/dev-roundtrip-report.mjs';

const fixture = JSON.parse(await readFile(new URL('fixtures/dev-roundtrip-report.json', import.meta.url)));
const pr1 = JSON.parse(await readFile(new URL('fixtures/dev-transfer-preview.json', import.meta.url)));
const compiled = await compiledReportPorts(); // Actual unchanged compiled functions, not accounting stubs.
const copy = value => structuredClone(value);
const ref = { path: 'explicit-local-file.json', sha256: 'a'.repeat(64) };
function context(mode = 'local-event-simulation') {
  const prepared = prepareDevTransferPreview(copy(pr1), previewPorts), route = prepared.plan.route;
  const expected = { ...copy(fixture.expected), receivers: [{ recipient: route.pair.svm.recipient, ata: route.pair.svm.sourceAta }] };
  const input = { schema: 'agtmai-dev-roundtrip-input-v1', testOnly: true, broadcastAllowed: false, mode,
    pr1: { plan: ref, facts: ref }, proof: null, expected, messages: [],
    snapshot: { totalSupply: fixture.F, lockedOnEthereum: '0', supplyOnSolana: '0', pendingEthereumToSolana: '0', pendingSolanaToEthereum: '0',
      ethereum: { height: '100', hash: '0x' + 'b'.repeat(64) }, solana: { height: '100', hash: expected.svmOffRamp },
      observedAt: '2026-09-08T05:04:14.470Z', freshnessCheckedAt: null, provenance: 'explicit-simulation', coherent: true, finalized: true },
    completeInventory: true, coherent: true, finalized: true, classifications: [] };
  return { input, route, routeHash: prepared.plan.routeHash, planHash: prepared.plan.planHash, proof: null,
    hashes: { header: ref.sha256, plan: ref.sha256, facts: ref.sha256, proof: null } };
}
function message(c, reverse = false, id = '1') {
  const r = c.route, identity = { messageId: '0x' + id.repeat(64), direction: reverse ? 'solana-to-ethereum' : 'ethereum-to-solana', amount: r.amount,
    sourceToken: reverse ? r.pair.svm.mint : r.pair.evm.token, destinationToken: reverse ? r.pair.evm.token : r.pair.svm.mint,
    recipient: reverse ? r.pair.evm.recipient : r.pair.svm.recipient };
  const m = { routeHash: c.routeHash, sourceTransaction: '0x' + id.repeat(64), identity, sequenceNumber: '1', nonce: '0', msgTotalNonce: '1', messageHash: '0x' + 'c'.repeat(64),
    evm: null, svm: null, modeledEvents: [] };
  const event = (chain, kind, index) => ({ identity: copy(identity), routeHash: c.routeHash, chain, kind, transactionId: chain === (reverse ? 'solana' : 'ethereum') ? m.sourceTransaction : 'destination-' + id,
    eventIndex: index, indexScheme: chain === 'solana' ? 'svm-physical-interleaved-v1' : 'evm-log-index-v1',
    instructionPath: chain === 'solana' ? [1, index] : null, owningInstructionPath: chain === 'solana' ? [1] : null,
    blockHash: 'block-' + chain, blockHeight: '50', finality: 'finalized' });
  m.modeledEvents = reverse ? [event('solana', 'burn', 10), event('ethereum', 'release', 152)] : [event('ethereum', 'lock', 110), event('solana', 'mint', 5)];
  return m;
}
const run = c => prepareDevRoundtripReport(c, { ...compiled, digest: digestReport, readCaptures: async (_r, _e, m) => ({ ...m, events: m.modeledEvents, diagnostics: [], native: { availability: 'test-port-stub' }, captures: [] }) });
async function cliReport(c) {
  const dir = await mkdtemp('.local/report-findings-');
  try {
    const prepared = prepareDevTransferPreview(copy(pr1), previewPorts);
    for (const name of ['plan', 'facts']) {
      const bytes = Buffer.from(JSON.stringify(prepared[name])), path = join(dir, name + '.json');
      await writeFile(path, bytes); c.input.pr1[name] = { path, sha256: hashReportBytes(bytes) };
    }
    const path = join(dir, 'header.json'); await writeFile(path, JSON.stringify(c.input));
    const child = spawnSync(process.execPath, ['--import', './tooling/testnet-ccip/tests/fixtures/dev-transfer-preview-no-effects.mjs',
      'tooling/testnet-ccip/src/composition/dev-roundtrip-report.mjs', '--input', path], { encoding: 'utf8' });
    assert.equal(child.signal, null, child.stderr); assert.ok(child.stdout, child.stderr);
    return { exit: child.status, report: JSON.parse(child.stdout) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
for (const chain of ['ethereum', 'solana']) {
  test('R1 equal-height ' + chain + ' block contradiction with complete flags cannot reconcile or exit0', async () => {
    const c = context(), m = message(c), event = m.modeledEvents.find(e => e.chain === chain);
    c.input.messages = [m]; Object.assign(c.input.snapshot, { lockedOnEthereum: '1000000000', supplyOnSolana: '1000000000' });
    event.blockHeight = '100'; event.blockHash = '0x' + 'c'.repeat(64); c.input.snapshot[chain].hash = '0x' + 'b'.repeat(64);
    const { exit, report: r } = await cliReport(c);
    assert.equal(exit, 2); assert.equal(r.status, 'unknown'); assert.equal(r.pending.knownness, 'unknown');
    assert.equal(r.pending.P_ES, null); assert.equal(r.pending.P_SE, null); assert.equal(r.monetary.reconciliation, null);
    assert.ok(r.monetary.reasons.includes('event-block-hash-conflicts-with-snapshot-watermark'));
    assert.equal(r.snapshot[chain].hash, c.input.snapshot[chain].hash);
    assert.deepEqual(r.messages[0].observations, m.modeledEvents);
    if (chain === 'ethereum') { assert.ok(r.monetary.reasons.includes('destination-before-included-finalized-source')); }
  });
}
test('R1 matching/absent watermark hash preserves model knownness; unfinalized events and fixture flags stay unknown', async () => {
  for (const variant of ['matching', 'absent-watermark', 'absent-watermark-fixture', 'unfinalized-event', 'fixture-only']) {
    const c = context(), m = message(c); c.input.messages = [m];
    Object.assign(c.input.snapshot, { lockedOnEthereum: '1000000000', supplyOnSolana: '1000000000' });
    m.modeledEvents[0].blockHeight = '100'; m.modeledEvents[0].blockHash = c.input.snapshot.ethereum.hash;
    if (variant.startsWith('absent-watermark')) { c.input.snapshot.ethereum.hash = null; }
    if (variant === 'unfinalized-event') { m.modeledEvents[0].finality = 'unfinalized'; }
    if (variant === 'fixture-only' || variant === 'absent-watermark-fixture') { c.input.mode = 'fixture-only'; }
    const known = ['matching', 'absent-watermark'].includes(variant); let r;
    if (variant.startsWith('absent-watermark')) {
      // The file schema requires a hash; internal/recorded snapshots can lack one.
      assert.throws(() => parseReportHeader(Buffer.from(JSON.stringify(c.input))), /bounded text/); r = await run(c);
    } else { const result = await cliReport(c); assert.equal(result.exit, known ? 0 : 2); r = result.report; }
    assert.equal(r.status, known ? 'exact-in-model' : 'unknown');
    assert.equal(r.pending.knownness, known ? 'known-in-model' : 'unknown');
    assert.equal(r.pending.P_ES, known ? '0' : null); assert.equal(r.pending.P_SE, known ? '0' : null);
    assert.equal(r.monetary.reconciliation?.adjustedGlobalSupply ?? null, known ? '100000000000000000' : null);
    assert.equal(r.capabilities.freshChainFinality, 'unknown');
  }
});
for (const conflict of ['orphan-settlement', 'duplicate-source-or-settlement']) {
  test('R2 ' + conflict + ' dominates duplicate source inventory and exits1', async () => {
    const c = context(), a = message(c), b = message(c, false, '2');
    b.sourceTransaction = a.sourceTransaction; b.modeledEvents = []; c.input.messages = [a, b];
    if (conflict === 'orphan-settlement') { a.modeledEvents.shift(); }
    else { a.modeledEvents.push({ ...copy(a.modeledEvents[1]), eventIndex: 6, instructionPath: [1, 6] }); }
    const { exit, report: r } = await cliReport(c);
    assert.equal(exit, 1); assert.equal(r.status, 'inconsistent'); assert.equal(r.monetary.reconciliation, null);
    assert.equal(r.messages[0].status, 'inconsistent'); assert.equal(r.messages[0].projection.status, 'inconsistent');
    assert.ok(r.messages[0].reasons.includes(conflict)); assert.ok(r.messages[0].reasons.includes('duplicate-inventory-source-transaction'));
    assert.equal(r.messages[1].status, 'unknown'); assert.equal(r.pending.knownness, 'unknown');
  });
}
test('R2 inventory alone and alternative recorded/physical ordinals remain unknown and exit2', async () => {
  for (const variant of ['duplicate-inventory', 'mixed-schemes', 'mixed-plus-inventory']) {
    const c = context(), a = message(c), b = message(c, false, '2'), mixed = variant !== 'duplicate-inventory';
    b.sourceTransaction = a.sourceTransaction; b.modeledEvents = []; c.input.messages = variant === 'mixed-schemes' ? [a] : [a, b];
    if (mixed) { a.modeledEvents.push({ ...copy(a.modeledEvents[1]), eventIndex: 6, indexScheme: 'svm-recorded-legacy-v1' }); }
    const { exit, report: r } = await cliReport(c);
    assert.equal(exit, 2); assert.equal(r.status, 'unknown'); assert.equal(r.monetary.reconciliation, null);
    assert.ok(r.messages.every(m => m.status === 'unknown')); assert.equal(r.pending.knownness, 'unknown');
    if (mixed) { assert.ok(r.messages[0].reasons.includes('mixed-index-schemes')); }
  }
});
for (const variant of ['duplicate-release', 'orphan-release', 'duplicate-lock']) {
  test('R2 combined ' + variant + ' survives unrelated ordinal ambiguity and inventory uncertainty', async () => {
    const c = context(), reverse = variant !== 'duplicate-lock', a = message(c, reverse), b = message(c, reverse, '2');
    b.sourceTransaction = a.sourceTransaction; b.modeledEvents = []; c.input.messages = [a, b];
    const svm = a.modeledEvents.find(e => e.chain === 'solana'), evm = a.modeledEvents.find(e => e.chain === 'ethereum');
    if (variant === 'orphan-release') { svm.kind = 'internal-transfer'; }
    else { a.modeledEvents.push({ ...copy(evm), eventIndex: evm.eventIndex + 1 }); }
    a.modeledEvents.push({ ...copy(svm), eventIndex: 6, indexScheme: 'svm-recorded-legacy-v1', instructionPath: null, owningInstructionPath: null });
    const conflict = variant === 'orphan-release' ? 'orphan-settlement' : 'duplicate-source-or-settlement';
    const { exit, report: r } = await cliReport(copy(c));
    assert.equal(exit, 1); assert.equal(r.status, 'inconsistent'); assert.equal(r.messages[0].status, 'inconsistent');
    for (const reason of [conflict, 'mixed-index-schemes', 'duplicate-inventory-source-transaction']) { assert.ok(r.messages[0].reasons.includes(reason), reason); }
    assert.deepEqual(r.messages[0].observations, a.modeledEvents); assert.equal(r.messages[1].status, 'unknown');
    assert.equal(r.pending.knownness, 'unknown'); assert.equal(r.pending.P_ES, null); assert.equal(r.pending.P_SE, null);
    assert.equal(r.messages[0].pendingAmount, null); assert.equal(r.monetary.reconciliation, null);
    assert.equal(r.capabilities.currentSettlement, 'unknown');
    // Removing only the alternate representation preserves the independent conflict.
    const single = copy(c); single.input.messages[0].modeledEvents.pop();
    const control = await cliReport(single); assert.equal(control.exit, 1); assert.equal(control.report.messages[0].status, 'inconsistent');
    assert.ok(control.report.messages[0].reasons.includes(conflict));
    // Removing only the conflict leaves an alias/inventory uncertainty, never settlement.
    const aliases = copy(c), events = aliases.input.messages[0].modeledEvents;
    if (variant === 'orphan-release') { events[0].kind = 'burn'; events.at(-1).kind = 'burn'; }
    else { events.splice(2, 1); }
    const positive = await cliReport(aliases); assert.equal(positive.exit, 2); assert.equal(positive.report.status, 'unknown');
    assert.ok(positive.report.messages.every(m => m.status === 'unknown')); assert.equal(positive.report.pending.P_ES, null);
    assert.equal(positive.report.pending.P_SE, null); assert.equal(positive.report.monetary.reconciliation, null);
  });
}
test('R2 two burns in one scheme remain confirmed alongside a recorded alias of that transaction', async () => {
  const c = context(), m = message(c, true); c.input.messages = [m];
  m.modeledEvents.push({ ...copy(m.modeledEvents[0]), eventIndex: 11, instructionPath: [1, 11] },
    { ...copy(m.modeledEvents[0]), eventIndex: 6, indexScheme: 'svm-recorded-legacy-v1' });
  const { exit, report: r } = await cliReport(c);
  assert.equal(exit, 1); assert.equal(r.messages[0].status, 'inconsistent');
  assert.ok(r.messages[0].reasons.includes('mixed-index-schemes')); assert.ok(r.messages[0].reasons.includes('duplicate-source-or-settlement'));
  assert.equal(r.messages[0].pendingAmount, null); assert.equal(r.monetary.reconciliation, null);
});
test('R2 ordinal ambiguity belongs to a transaction, not every effect on its chain', async () => {
  const c = context(), m = message(c); c.input.messages = [m];
  m.modeledEvents.push({ ...copy(m.modeledEvents[1]), eventIndex: 6, indexScheme: 'svm-recorded-legacy-v1' },
    { ...copy(m.modeledEvents[1]), transactionId: 'independent-destination', eventIndex: 6, indexScheme: 'svm-recorded-legacy-v1' });
  const { exit, report: r } = await cliReport(c);
  assert.equal(exit, 1); assert.equal(r.status, 'inconsistent'); assert.equal(r.messages[0].status, 'inconsistent');
  assert.ok(r.messages[0].reasons.includes('duplicate-source-or-settlement')); assert.ok(r.messages[0].reasons.includes('mixed-index-schemes'));
  assert.deepEqual(r.messages[0].observations, m.modeledEvents); assert.equal(r.pending.knownness, 'unknown');
  assert.equal(r.monetary.reconciliation, null);
});
for (const v of fixture.vectors) {
  test(v.name + ': red if compiled accounting loses a unit or accepts impossible backing', async () => {
    const c = context(), s = c.input.snapshot;
    Object.assign(s, { lockedOnEthereum: v.L, supplyOnSolana: v.S, pendingEthereumToSolana: v.P_ES, pendingSolanaToEthereum: v.P_SE });
    if (v.name === 'extra-mint-one') { c.input.classifications = ['unexplained-extra-mint']; }
    if (v.name === 'donation-one') { c.input.classifications = ['backing-donation']; }
    const r = await run(c), money = r.monetary;
    assert.equal(r.evidenceClass, 'local-event-simulation');
    if (v.status === 'inconsistent') {
      assert.equal(r.status, 'inconsistent'); assert.equal(money.reconciliation, null);
      assert.equal(money.L, '100000000000000001'); assert.equal(money.S, '100000000000000001');
      assert.ok(money.reasons.includes('locked-backing-exceeds-fixed-supply'));
    } else {
      assert.equal(money.reconciliation.adjustedGlobalSupply, v.adjusted); assert.equal(money.reconciliation.backingSurplus, v.surplus);
      assert.equal(money.reconciliation.status, v.status); assert.match(money.reconciliation.qualification, /in-model/);
    }
  });
}
test('changed consumer preserves 9007199254740993: red on Number rounding before projection', async () => {
  const c = context(), largeInput = copy(pr1); largeInput.amount = '9007199254740993';
  for (const limiter of Object.values(largeInput.limiters)) { limiter.capacity = '9007199254740993'; }
  const selected = prepareDevTransferPreview(largeInput, previewPorts);
  c.route = selected.plan.route; c.routeHash = selected.plan.routeHash; c.planHash = selected.plan.planHash;
  c.input.snapshot.lockedOnEthereum = '9007199254740993'; c.input.snapshot.pendingEthereumToSolana = '9007199254740993';
  const m = message(c); m.modeledEvents.pop(); c.input.messages = [m];
  const r = await run(c);
  assert.equal(r.messages[0].identity.amount, '9007199254740993'); assert.equal(r.messages[0].pendingAmount, '9007199254740993');
  assert.equal(r.monetary.reconciliation.adjustedGlobalSupply, '100000000000000000');
});
test('cross-message physical ownership: red if either identity settles with a shared effect', async () => {
  const c = context(), a = message(c), b = message(c, false, '2');
  b.modeledEvents[1].transactionId = a.modeledEvents[1].transactionId; c.input.messages = [a, b];
  const r = await run(c); assert.equal(r.status, 'inconsistent'); assert.equal(r.monetary.reconciliation, null);
  assert.ok(r.messages.every(m => m.status === 'inconsistent' && m.reasons.includes('cross-message-effect-ownership')));
});
test('identical replay is idempotent; changed block fingerprint is inconsistent: red on block-key deduplication', async () => {
  const c = context(), m = message(c); c.input.messages = [m];
  m.modeledEvents.push(copy(m.modeledEvents[1]));
  const repeated = await run(c); assert.equal(repeated.messages[0].status, 'settled');
  m.modeledEvents[2].blockHash = 'another-block';
  assert.equal((await run(c)).messages[0].status, 'inconsistent');
});
test('duplicate inventory IDs/source tx stay unknown: red on double inventory admission', async () => {
  for (const field of ['messageId', 'sourceTransaction']) {
    const c = context(), a = message(c), b = message(c, false, '2');
    a.modeledEvents = []; b.modeledEvents = [];
    if (field === 'messageId') { b.identity.messageId = a.identity.messageId; } else { b.sourceTransaction = a.sourceTransaction; }
    c.input.messages = [a, b]; const r = await run(c);
    assert.equal(r.status, 'unknown'); assert.ok(r.messages.every(m => m.reasons.some(reason => reason.startsWith('duplicate-inventory'))));
  }
});
test('mixed SVM recorded/physical schemes stay unknown: red if matching ordinal is reinterpreted', async () => {
  const c = context(), m = message(c); c.input.messages = [m];
  m.modeledEvents.push({ ...copy(m.modeledEvents[1]), indexScheme: 'svm-recorded-legacy-v1' });
  const r = await run(c); assert.equal(r.messages[0].status, 'unknown');
  assert.ok(r.messages[0].reasons.includes('mixed-index-schemes')); assert.equal(r.monetary.reconciliation, null);
});
test('reorg then finalized stays unknown: red if a later flag restores success', async () => {
  const c = context(), m = message(c); c.input.messages = [m];
  m.modeledEvents.push({ ...copy(m.modeledEvents[1]), finality: 'reorged' }, copy(m.modeledEvents[1]));
  const r = await run(c); assert.equal(r.messages[0].status, 'unknown'); assert.equal(r.messages[0].pendingAmount, null);
  assert.ok(r.messages[0].reasons.includes('reorg-reconciliation-required')); assert.equal(r.monetary.reconciliation, null);
});
test('source-only real and arbitrary asserted flags do not prove pending zero: red on class promotion', async () => {
  const c = context('historical-capture-replay'), m = message(c); m.modeledEvents.pop(); c.input.messages = [m];
  const r = await run(c); assert.equal(r.evidenceClass, 'fixture-only'); assert.equal(r.observationClass, 'unverified-capture-replay'); assert.equal(r.status, 'unknown');
  assert.equal(r.messages[0].pendingAmount, null); assert.equal(r.pending.P_ES, null); assert.equal(r.pending.P_SE, null);
  assert.equal(r.inventory.knownness, 'unknown'); assert.equal(r.monetary.reconciliation, null);
});
test('settlement after watermark cannot settle the earlier cut: red on retrospective pending zero', async () => {
  const c = context(), m = message(c); m.modeledEvents[1].blockHeight = '101'; c.input.messages = [m];
  const r = await run(c); assert.equal(r.status, 'unknown'); assert.equal(r.pending.P_ES, null);
  assert.ok(r.monetary.reasons.includes('settlement-after-snapshot-watermark')); assert.equal(r.monetary.reconciliation, null);
});
test('source after cut and destination without finalized source remain unreconciled: red on causal cut omission', async () => {
  for (const mutation of [e => { e.blockHeight = '101'; }, e => { e.finality = 'unfinalized'; }]) {
    const c = context(), m = message(c); mutation(m.modeledEvents[0]); c.input.messages = [m];
    const r = await run(c); assert.equal(r.monetary.reconciliation, null);
    assert.ok(r.monetary.reasons.includes('destination-before-included-finalized-source'));
  }
});
test('incomplete inventory keeps both pending directions null: red on unknown-to-zero coercion', async () => {
  const c = context(); c.input.completeInventory = false; const r = await run(c);
  assert.equal(r.pending.P_ES, null); assert.equal(r.pending.P_SE, null); assert.equal(r.monetary.reconciliation, null);
});
test('overissuance retains negative surplus and incident: red if range admission hides under-backing', async () => {
  const c = context(); c.input.snapshot.supplyOnSolana = '100000000000000001';
  const r = await run(c); assert.equal(r.status, 'under-backed');
  assert.equal(r.monetary.reconciliation.backingSurplus, '-100000000000000001');
  assert.ok(r.monetary.incidents.includes('observed-solana-overissuance'));
});
test('wallet burn is separate from return; changed envelope rejects before projection: red on unauthenticated mapping', async () => {
  const c = context(); c.input.classifications = ['voluntary-wallet-burn']; c.input.snapshot.lockedOnEthereum = '1000000001'; c.input.snapshot.supplyOnSolana = '1000000000';
  const r = await run(c); assert.deepEqual(r.monetary.classifications, ['voluntary-wallet-burn']); assert.equal(r.messages.length, 0);
  const m = message(c); m.identity.destinationToken = 'wrong-token'; c.input.messages = [m];
  let calls = 0; await assert.rejects(() => prepareDevRoundtripReport(c, { ...compiled, projectMessage: () => { calls++; }, digest: digestReport }), /envelope mismatch/);
  assert.equal(calls, 0);
});
test('wrong chain/kind and orphan settlement are inconsistent: red if an unrelated effect is admitted', async () => {
  for (const mutate of [m => { m.modeledEvents.shift(); }, m => { m.modeledEvents[1].kind = 'burn'; }]) {
    const c = context(), m = message(c); mutate(m); c.input.messages = [m];
    assert.equal((await run(c)).messages[0].status, 'inconsistent');
  }
});
test('header duplicate/unknown/unsafe/size/truncation reject: red on JSON overwrite or silent schema widening', () => {
  const h = JSON.stringify(context().input);
  for (const raw of [h.replace('"testOnly":true', '"testOnly":false,"testOnl\\u0079":true'), h.replace('"testOnly":true', '"privateKey":"forbidden","testOnly":true'),
    h.replace('"totalSupply":"100000000000000000"', '"totalSupply":100000000000000000'), h.slice(0, -1), h + ' '.repeat(65536)]) {
    assert.throws(() => parseReportHeader(Buffer.from(raw)));
  }
  assert.equal(parseReportHeader(Buffer.from(h)).mode, 'local-event-simulation');
  assert.throws(() => checkCaptureJson(Buffer.from('{"jsonrpc":"2.0","result":null,"res\\u0075lt":{}}')), /duplicate/);
});
async function captureReportInput(dir, sizes) {
  const c = context('historical-capture-replay'), prepared = prepareDevTransferPreview(copy(pr1), previewPorts);
  const save = async (name, bytes) => {
    const path = join(dir, name); await writeFile(path, bytes);
    return { path, sha256: hashReportBytes(bytes) };
  };
  for (const name of ['plan', 'facts']) { c.input.pr1[name] = await save(name + '.json', Buffer.from(JSON.stringify(prepared[name]))); }
  c.input.snapshot = null; c.input.completeInventory = false; c.input.coherent = false; c.input.finalized = false;
  for (let i = 0; i < sizes.length; i += 2) {
    const m = message(c, false, String(i / 2 + 1)); m.modeledEvents = []; m.msgTotalNonce = null; m.messageHash = null;
    const captures = [];
    for (const [j, size] of sizes.slice(i, i + 2).entries()) {
      const raw = Buffer.alloc(size, ' '); Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}').copy(raw);
      captures.push(await save('capture-' + (i + j) + '.json', raw));
    }
    m.evm = { receipt: captures[0], transaction: captures[1], transactionId: m.sourceTransaction }; c.input.messages.push(m);
  }
  const path = join(dir, 'header.json'); await writeFile(path, JSON.stringify(c.input));
  return { path, input: c.input };
}
test('report capture budget rejects six individually valid captures and a one-byte aggregate excess', async () => {
  for (const sizes of [Array(6).fill(262144), [262144, 262144, 131072, 131072, 131072, 131073]]) {
    const dir = await mkdtemp('.local/report-capture-budget-');
    try {
      const { path } = await captureReportInput(dir, sizes);
      await assert.rejects(() => runDevRoundtripReport(['--input', path]), /report capture byte budget/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
test('report capture budget precedes capture JSON decoding and optional provider admission', async () => {
  const dir = await mkdtemp('.local/report-capture-budget-');
  try {
    const { path, input } = await captureReportInput(dir, Array(6).fill(262144));
    const raw = Buffer.alloc(262144, 0xff); await writeFile(input.messages[0].evm.receipt.path, raw);
    input.messages[0].evm.receipt.sha256 = hashReportBytes(raw); await writeFile(path, JSON.stringify(input));
    for (const options of [[], ['--provider', join(dir, 'absent-provider'), '--archives', join(dir, 'absent-archives')]]) {
      await assert.rejects(() => runDevRoundtripReport(['--input', path, ...options]), /report capture byte budget/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('report capture budget counts every selected role, including repeated paths and SVM captures', async () => {
  for (const variant of ['repeated-paths', 'svm']) {
    const dir = await mkdtemp('.local/report-capture-budget-');
    try {
      const { path, input } = await captureReportInput(dir, Array(6).fill(262144));
      if (variant === 'repeated-paths') {
        for (const m of input.messages.slice(1)) { m.evm.receipt = input.messages[0].evm.receipt; m.evm.transaction = input.messages[0].evm.transaction; }
      } else {
        const m = input.messages[2]; m.svm = { capture: m.evm.receipt, transactionId: 'selected-svm-capture', slot: '100', blockHash: null }; m.evm = null;
      }
      await writeFile(path, JSON.stringify(input));
      await assert.rejects(() => runDevRoundtripReport(['--input', path]), /report capture byte budget/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
test('report capture budget admits exact and within limits with separate header/PR1 bytes and unknown provider', async () => {
  for (const lastSize of [131071, 131072]) {
    const dir = await mkdtemp('.local/report-capture-budget-');
    try {
      const { path, input } = await captureReportInput(dir, [262144, 262144, 131072, 131072, 131072, lastSize]);
      const result = await runDevRoundtripReport(['--input', path]), r = result.report;
      assert.equal(result.provider.evaluated, false); assert.equal(r.status, 'unknown'); assert.equal(r.messages.length, 3);
      assert.equal(r.pending.P_ES, null); assert.equal(r.pending.P_SE, null); assert.equal(r.monetary.reconciliation, null);
      for (const [i, m] of r.messages.entries()) {
        assert.equal(m.native.ethereum.availability, 'prerequisite'); assert.equal(m.pendingAmount, null); assert.deepEqual(m.diagnostics, []);
        assert.equal(m.captures[0].integrity, 'selected-digest-match'); assert.deepEqual(m.captures[0].receipt, input.messages[i].evm.receipt);
        assert.deepEqual(m.captures[0].transaction, input.messages[i].evm.transaction);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
test('report capture budget preserves missing, digest and per-file reader guards within the aggregate', async () => {
  for (const variant of ['missing', 'digest', 'oversized']) {
    const dir = await mkdtemp('.local/report-capture-budget-');
    try {
      const { path, input } = await captureReportInput(dir, [128, 128]), receipt = input.messages[0].evm.receipt;
      if (variant === 'missing') { await rm(receipt.path); }
      if (variant === 'digest') { receipt.sha256 = '0'.repeat(64); }
      if (variant === 'oversized') { const raw = Buffer.alloc(262145, ' '); await writeFile(receipt.path, raw); receipt.sha256 = hashReportBytes(raw); }
      await writeFile(path, JSON.stringify(input));
      const result = await runDevRoundtripReport(['--input', path]), m = result.report.messages[0];
      assert.equal(result.provider.evaluated, false); assert.equal(result.report.status, variant === 'missing' ? 'unknown' : 'inconsistent');
      assert.equal(m.native.ethereum.availability, variant === 'missing' ? 'missing' : 'invalid'); assert.equal(m.pendingAmount, null);
      assert.match(m.diagnostics[0].reason, variant === 'missing' ? /explicit-capture-read-missing/ : variant === 'digest' ? /digest mismatch/ : /bounded regular file/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
test('report capture budget retains the real bounded file reader at its exact and max+1 capture limits', async () => {
  const dir = await mkdtemp('.local/report-capture-budget-');
  try {
    const path = join(dir, 'capture.json'), raw = Buffer.alloc(262144, ' ');
    Buffer.from('{"jsonrpc":"2.0","result":{}}').copy(raw); await writeFile(path, raw);
    assert.deepEqual(await readReportFile(path, 262144), raw);
    await writeFile(path, Buffer.concat([raw, Buffer.from(' ')]));
    await assert.rejects(() => readReportFile(path, 262144), /bounded regular file/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('actual CLI/file flow has zero network/client/key effects and conservative knownness: red on effectful fallback', async () => {
  const dir = await mkdtemp('.local/report-boundary-');
  try {
    const c = context('historical-capture-replay'), prepared = prepareDevTransferPreview(copy(pr1), previewPorts);
    for (const name of ['plan', 'facts']) {
      const bytes = Buffer.from(JSON.stringify(prepared[name])); const path = join(dir, name + '.json'); await writeFile(path, bytes);
      c.input.pr1[name] = { path, sha256: hashReportBytes(bytes) };
    }
    const path = join(dir, 'header.json'); await writeFile(path, JSON.stringify(c.input));
    const result = await runDevRoundtripReport(['--input', path]);
    assert.equal(result.report.status, 'unknown'); assert.equal(result.report.pending.P_ES, null); assert.equal(result.provider.evaluated, false);
    const child = spawnSync(process.execPath, ['--import', './tooling/testnet-ccip/tests/fixtures/dev-transfer-preview-no-effects.mjs',
      'tooling/testnet-ccip/src/composition/dev-roundtrip-report.mjs', '--input', path], { encoding: 'utf8' });
    assert.equal(child.status, 2, child.stderr); assert.equal(JSON.parse(child.stdout).status, 'unknown'); assert.match(child.stderr, /F=100000000000000000/);
    const output = join(dir, 'published');
    const published = await runDevRoundtripReport(['--input', path, '--output', output]);
    const completion = JSON.parse(await readFile(join(output, 'complete.json')));
    assert.deepEqual(Object.keys(completion.inventory).toSorted(), ['input.json', 'report.json', 'summary.md']);
    assert.equal(await readFile(join(output, 'summary.md'), 'utf8'), published.summary);
    assert.equal((await runDevRoundtripReport(['--reopen', output])).report.reportHash, published.report.reportHash);
    await assert.rejects(() => runDevRoundtripReport(['--input', path, '--output', output]), /EEXIST/);
    const reportPath = join(output, 'report.json'), changed = JSON.parse(await readFile(reportPath)); changed.status = 'recorded-settled';
    const changedBytes = Buffer.from(JSON.stringify(changed)); await writeFile(reportPath, changedBytes);
    const completePath = join(output, 'complete.json'), complete = JSON.parse(await readFile(completePath)); complete.inventory['report.json'] = hashReportBytes(changedBytes);
    await writeFile(completePath, JSON.stringify(complete));
    await assert.rejects(() => runDevRoundtripReport(['--reopen', output]), /semantic cross-binding/);
    await symlink(path, join(dir, 'alias.json')); await assert.rejects(() => readReportFile(join(dir, 'alias.json')));
    await writeFile(join(dir, 'oversized'), Buffer.alloc(65537)); await assert.rejects(() => readReportFile(join(dir, 'oversized')), /bounded/);
    await assert.rejects(() => runDevRoundtripReport(['--input', 'https://invalid.example']), /local path/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
// Immutable proof branch uses the canonical report, not stubs, discovery or APIs.
test('selected recorded proof preserves fixture F100/three settled/original freshness: red on relabel or refresh', async () => {
  const c = context('recorded-proof'); c.proof = JSON.parse(await readFile(PROOF_PATH)); c.hashes.proof = PROOF_SHA256;
  c.route.profile = 'fixture100'; c.route.fixedSupplyBaseUnits = '100000000000';
  c.route.pair.evm.recipient = '0x275ee728c49100b56d4aa37c00e2dc8ffc5e5df6';
  c.route.pair.evm.token = '0xbee91ba3ca94dd7c639ee6c1b1c2fc1a1996cdc9'; c.route.pair.svm.mint = '13Q74er9thh3my9oACjChDhtn4znJibWBp1u8q1rAYau';
  Object.assign(c.route.pair.evm, { pool: '0x24508e2eb3bedc086318abc054153fd83823a4e2', sender: '0x275ee728c49100b56d4aa37c00e2dc8ffc5e5df6' });
  Object.assign(c.route.pair.svm, { signer: '8NGr2WFh3JrC1UzmB3iifESF7W5wf3CBPWguJayuXmkX', sourceAta: fixture.expected.receivers[0].ata,
    poolAta: 'ETmid1DpsTNnZGueaiK68hWqfcs6rJii1YFgjKxrcVzF', sender: fixture.expected.receivers[0].recipient });
  c.input.expected = copy(fixture.expected); c.input.snapshot = null;
  c.input.messages = c.proof.threeMessageStatus.transfers.map(t => ({ ...message(c), sourceTransaction: t.sourceHash, identity: t.identity, modeledEvents: [] }));
  const r = await run(c); assert.equal(r.evidenceClass, 'historical-real-testnet-proof'); assert.equal(r.profile, 'fixture100');
  assert.deepEqual(r.messages.map(m => m.status), ['settled', 'settled', 'settled']); assert.equal(r.monetary.F, '100000000000');
  assert.equal(r.monetary.L, '1000000000'); assert.equal(r.monetary.S, '1000000000'); assert.equal(r.pending.P_ES, '0'); assert.equal(r.pending.P_SE, '0');
  assert.equal(r.snapshot.observedAt, '2026-09-08T05:04:14.470Z'); assert.equal(r.snapshot.freshnessCheckedAt, null);
  assert.equal(r.capabilities.currentSettlement, 'unknown'); assert.ok(r.recordedProof.originalRawFiles.every(f => f.availability === 'missing'));
  c.route.profile = 'product100M'; await assert.rejects(() => run(c), /fixture\/profile/);
});

test('total supply mismatch, missing cut and unknown pending never reconcile: red on numeric/default admission shortcuts', async () => {
  for (const mutate of [s => { s.totalSupply = '100000000000000001'; }, s => { s.solana = null; }, s => { s.pendingSolanaToEthereum = null; }]) {
    const c = context(); mutate(c.input.snapshot); const r = await run(c);
    assert.equal(r.monetary.reconciliation, null);
    if (c.input.snapshot.pendingSolanaToEthereum === null) { assert.equal(r.pending.knownness, 'unknown'); }
  }
});
test('internal reverse transfer ownership is retained alongside burn: red if transfer ordinal is silently discarded', async () => {
  const c = context(), a = message(c, true), b = message(c, true, '2');
  const transfer = { ...copy(a.modeledEvents[0]), kind: 'internal-transfer', eventIndex: 7, instructionPath: [1, 5] };
  a.modeledEvents.push(transfer); b.modeledEvents.push({ ...copy(transfer), identity: b.identity }); c.input.messages = [a, b];
  const r = await run(c); assert.ok(r.messages.every(m => m.status === 'inconsistent'));
  assert.ok(r.messages.every(m => m.reasons.includes('cross-message-effect-ownership')));
});

test('publication failure after the first file leaves no complete marker: red on partially published success', async () => {
  const dir = await mkdtemp('.local/report-publication-'), savedOpen = fsPromises.open;
  try {
    const c = context(), report = await run(c);
    fsPromises.open = async (filePath, ...args) => {
      if (String(filePath).endsWith('/report.json')) { throw new Error('Injected second-file write failure'); }
      return savedOpen(filePath, ...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(() => publishReport(join(dir, 'output'), Buffer.from(JSON.stringify(c.input)), { report, summary: 'bounded summary' }), /Injected second-file/);
    assert.equal(JSON.parse(await readFile(join(dir, 'output/input.json'))).schema, 'agtmai-dev-roundtrip-input-v1');
    await assert.rejects(() => readFile(join(dir, 'output/complete.json')), { code: 'ENOENT' });
    await assert.rejects(() => runDevRoundtripReport(['--reopen', join(dir, 'output')]), /incomplete output inventory/);
  } finally { fsPromises.open = savedOpen; syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});
