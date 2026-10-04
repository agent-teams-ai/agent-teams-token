import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { readPreviewInput, inspectReversePreviewInput } from '../src/adapters/dev-transfer-preview-input.mjs';
import { prepareDevTransferPreview, assertForwardEncodingInput } from '../src/application/dev-transfer-preview.mjs';
import { previewPorts } from '../src/adapters/dev-transfer-preview-store.mjs';
import { runDevTransferPreview } from '../src/composition/dev-transfer-preview.mjs';
const fixture = JSON.parse(await readFile(new URL('./fixtures/dev-bidirectional-preview.json', import.meta.url)));
const input = f => readPreviewInput(JSON.stringify(f.input), JSON.stringify(f.reverseCall));
const clone = () => structuredClone(fixture);
function rawEdit(f, name, edit) {
  const a = f.reverseCall.facts.state[name], b = Buffer.from(a.dataBase64, 'base64'); edit(b);
  a.dataBase64 = b.toString('base64'); a.sha256 = createHash('sha256').update(b).digest('hex');
}
test('selected pair admits the hypothetical common return state without claiming bytes or current readiness', () => {
  const normalized = input(fixture), admission = inspectReversePreviewInput(normalized);
  // RED: the old consumer omits the independently selected policies required by native admission.
  assert.deepEqual(normalized.reverseCall.route.limiters, { inbound: normalized.limiters.svmInbound, outbound: normalized.limiters.svmOutbound });
  assert.equal(admission.status, 'admitted');
  for (const [direction, name] of [['inbound', 'svmInbound'], ['outbound', 'svmOutbound']]) {
    assert.deepEqual(admission.limiterObservations[direction], { ...normalized.limiters[name], tokens: normalized.buckets[name].tokens, lastUpdatedUnixSeconds: '1700000000' });
  }
  assert.deepEqual(admission.modelledAfter, { qualification: 'hypothetical-success-only', mintSupply: '19000000000', sourceBalance: '9000000000',
    poolBalance: '3000000000', delegate: null, delegatedAmount: '0' });
  const result = prepareDevTransferPreview(normalized, previewPorts);
  assert.equal(result.plan.legs.reverse.unsignedAvailable, false);
  assert.equal(result.facts.currentReadiness, null); assert.equal(result.facts.evidenceClass, 'fixture-only');
  assert.equal(result.plan.legs.reverse.conditional, true); assert.equal(result.plan.legs.reverse.operations.at(-1).bytes, null);
});
test('independent reverse route cannot change payer, amount, fixed supply, pair, receiver or administrative bindings', () => {
  for (const change of [r => {r.payer = r.roles.poolOwner;}, r => {r.amount = '1';},
    r => {r.profile = 'product100M'; r.fixedSupplyBaseUnits = '100000000000000000';}, r => {r.evmToken = fixture.input.pair.evm.initialAdmin;},
    r => {r.recipient = fixture.input.pair.evm.initialAdmin;}, r => {r.roles.registryAdmin = r.roles.poolOwner;},
    r => {r.identities.sourceAta = r.linkMint;}, r => {r.lookupTableAuthority = r.payer;}]) {
    const f = clone(); change(f.reverseCall.route); assert.throws(() => input(f));
  }
  // RED: a separately supplied valid native policy could disagree with normalized consumer selection.
  for (const direction of ['inbound', 'outbound']) {
    for (const field of ['enabled', 'capacity', 'rate']) {
      const f = clone(); f.reverseCall.route.limiters = { inbound: { ...f.input.limiters.svmInbound }, outbound: { ...f.input.limiters.svmOutbound } };
      const policy = f.reverseCall.route.limiters[direction];
      if (field === 'enabled') {Object.assign(policy, { enabled: false, capacity: '0', rate: '0' });}
      else {policy[field] = field === 'capacity' ? (BigInt(policy.capacity) + 1n).toString() : '1';}
      f.reverseCall.facts.fees.quote = null;
      assert.throws(() => input(f), /Reverse preview binding:.*limiter/);
    }
  }
});
test('contradictory raw observations reject even when a quote is missing', () => {
  for (const change of [f => {f.reverseCall.facts.before.sourceBalance = '1';},
    f => rawEdit(f, 'sourceAta', b => b.writeBigUInt64LE(1n, 64)), f => rawEdit(f, 'registry', b => {b[9] ^= 1;}),
    f => rawEdit(f, 'pool', b => {b[138] ^= 1;}), f => rawEdit(f, 'registry', b => {b[120] ^= 1;}), f => rawEdit(f, 'alt', b => {b[56] ^= 1;}),
    f => {f.reverseCall.facts.blockhash.value = f.reverseCall.route.linkMint;}]) {
    const f = clone(); f.reverseCall.facts.fees.quote = null; change(f); assert.throws(() => input(f));
  }
  for (const change of [b => {b.mintSupply = '1';}, b => {b.sourceBalance = '1';}, b => {b.poolBalance = '1';},
    b => {b.delegate = fixture.reverseCall.route.payer;}, b => {b.delegatedAmount = '1';}]) {
    const f = clone(); f.input.states.reverse = null; f.reverseCall.facts.fees.quote = null;
    change(f.reverseCall.facts.before); assert.throws(() => input(f), /Reverse raw\/decoded observation conflict/);
  }
  for (const decoded of [true, false]) {
    for (const [name, offset] of [['mint', 4], ['mint', 44], ['sourceAta', 0], ['sourceAta', 32], ['poolAta', 32],
      ['pool', 9], ['pool', 73], ['chain', 8], ['chain', 12], ['chain', 36], ['chain', 72], ['routerConfig', 10]]) {
      const f = clone(); f.reverseCall.facts.fees.quote = null;
      if (!decoded) {f.input.states.reverse = null;}
      rawEdit(f, name, b => {b[offset] ^= 1;});
      assert.throws(() => input(f), /Reverse raw\/decoded observation conflict/);
    }
  }
});
test('partial raw snapshots and unknown or expired costs retain prerequisites and their original nulls', () => {
  for (const change of [f => {f.state = null;}, f => {f.state.alt = null;}, f => {f.state.chain = null;}, f => {f.before = null;},
    f => {f.fees.quote = null;}, f => {f.fees.rent.lamports = null;}, f => {f.payerBalance = null;},
    f => {f.blockhash = null;}, f => {f.fees.quote.validThroughSlot = '100';}]) {
    const f = clone(); change(f.reverseCall.facts); const normalized = input(f), result = prepareDevTransferPreview(normalized, previewPorts);
    assert.equal(inspectReversePreviewInput(normalized).status, 'prerequisites');
    assert.equal(result.plan.legs.reverse.unsignedAvailable, false); assert.equal(result.facts.currentReadiness, null);
    assert.deepEqual(result.facts.knownness.reverseCall.facts, f.reverseCall.facts);
    assert.ok(result.plan.legs.reverse.prerequisites.length);
  }
  for (const direction of ['inbound', 'outbound']) {
    const offset = direction === 'inbound' ? 73 : 106;
    for (const change of [f => {f.reverseCall.route.limiters = null;},
      f => {f.reverseCall.route.limiters = { inbound: { ...f.input.limiters.svmInbound }, outbound: { ...f.input.limiters.svmOutbound }, [direction]: null };},
      f => rawEdit(f, 'chain', b => b.writeBigUInt64LE(BigInt(f.input.amount) - 1n, offset)),
      f => rawEdit(f, 'chain', b => b.writeBigUInt64LE(BigInt(f.input.limiters.svmInbound.capacity) + 1n, offset + 17))]) {
      const f = clone(); change(f); const normalized = input(f), admission = inspectReversePreviewInput(normalized);
      assert.equal(admission.status, 'prerequisites');
      assert.equal(prepareDevTransferPreview(normalized, previewPorts).plan.legs.reverse.operations.at(-1).bytes, null);
    }
  }
  const f = clone(); f.input.states.reverse = null; f.reverseCall.facts.fees.quote = null;
  const result = prepareDevTransferPreview(input(f), previewPorts);
  assert.equal(result.plan.legs.reverse.unsignedAvailable, false); assert.equal(result.facts.currentReadiness, null);
  assert.equal(result.facts.knownness.conditionalReturnState, null);
  assert.deepEqual(result.plan.legs.reverse.conflicts, []);
  assert.match(result.plan.legs.reverse.prerequisites.join('; '), /Quote before-state provenance unavailable/);
  assert.doesNotThrow(() => assertForwardEncodingInput(result.plan));
});
test('known raw cost lower bounds reject before the actual provider can be resolved', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'bidirectional-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const balance of [false, true]) {
    const f = clone(); f.reverseCall.facts.fees.networkFee = null;
    if (balance) {f.reverseCall.facts.payerBalance.lamports = '4'; f.input.quotes.reverse.payerBalance = '4';}
    else {f.reverseCall.facts.maxExposureLamports = '4'; f.input.quotes.reverse.exposureLimit = '4';}
    const source = join(directory, 'input.json'), reverse = join(directory, 'reverse.json');
    await writeFile(source, JSON.stringify(f.input)); await writeFile(reverse, JSON.stringify(f.reverseCall));
    await assert.rejects(runDevTransferPreview(['--input', source, '--output', join(directory, 'output'), '--reverse-input', reverse,
      '--provider-root', join(directory, 'absent'), '--provider-archives', join(directory, 'archives')]), /known cost lower bound/);
  }
  assert.equal(Object.keys(createRequire(import.meta.url).cache).some(p => p.includes('/.local/PREPARED-PROVIDER/')), false);
});
test('bounded reverse payload refuses duplicate names, unselected fields, selectors as numbers and path flags without pairs', async () => {
  const f = clone(); f.reverseCall.route.selector = Number('16015286601757825753'); assert.throws(() => input(f));
  await assert.rejects(runDevTransferPreview(['--reverse-input']), /flag\/path/);
  await assert.rejects(runDevTransferPreview(['--input', 'x', '--output', 'y', '--rpc', 'x']), /Unknown/);
  assert.throws(() => readPreviewInput(JSON.stringify(fixture.input), '{"route":{},"route":{},"facts":{}}'), /Duplicate/);
});
