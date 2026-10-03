import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm, realpath, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPreviewInput } from '../src/adapters/dev-transfer-preview-input.mjs';
import { prepareDevTransferPreview } from '../src/application/dev-transfer-preview.mjs';
import { previewPorts, publishPreview, reopenPreview, canonicalPreview, hashPreviewBytes } from '../src/adapters/dev-transfer-preview-store.mjs';
import { inspectEvmForwardCalls, FORWARD_ENCODING_PROVENANCE } from '../src/adapters/dev-evm-call-plan.mjs';
import { runDevTransferPreview } from '../src/composition/dev-transfer-preview.mjs';

const golden = JSON.parse(await readFile(new URL('./fixtures/dev-evm-call-plan-goldens.json', import.meta.url)));
const fixture = JSON.parse(await readFile(new URL('./fixtures/dev-transfer-preview.json', import.meta.url)));
const read = value => readPreviewInput(JSON.stringify(value));
const word = value => BigInt(value).toString(16).padStart(64, '0');
const patch = (data, offset, hex) => data.slice(0, 2 + offset * 2) + hex + data.slice(2 + offset * 2 + hex.length);
async function temporary(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'forward-preview-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
// TEST port substitutes selected fields in retained public bytes. It does not
// load or qualify a provider; the separate native script owns that evidence.
const fixtureEncoding = { provenance: FORWARD_ENCODING_PROVENANCE,
  encodeForward(intent) {
    const envelope = (to, value, data) => ({ from: intent.sender, to, chainId: intent.chainId, value, data });
    let send = golden.historicalCalls[1].data;
    send = patch(send, 356, '0'.repeat(24) + intent.token.slice(2));
    send = patch(send, 388, word(intent.amount)); send = patch(send, 584, intent.tokenReceiver.slice(2));
    return [...(intent.approve ? [envelope(intent.token, '0', patch(golden.historicalCalls[0].data, 36, word(intent.amount)))] : []),
      ...(intent.send ? [envelope(intent.router, intent.fee, send)] : [])];
  },
  inspectForward: inspectEvmForwardCalls };
const preview = (value, encoding = fixtureEncoding) => prepareDevTransferPreview(read(value), { ...previewPorts, forwardEncoding: encoding });
function changed() {
  const v = structuredClone(fixture), expected = golden.changedIntent, amount = expected.amount;
  v.amount = amount; v.pair.evm.token = expected.token; v.states.forward.token = expected.token;
  v.states.reverse.remoteTokenHex = '0'.repeat(24) + expected.token.slice(2);
  v.pair.evm.sender = expected.sender; v.states.forward.sender = expected.sender; v.states.forward.allowanceOwner = expected.sender;
  v.states.forward.balance = (BigInt(amount) + 1n).toString();
  for (const name of ['sender', 'payer', 'recipient']) {v.pair.svm[name] = golden.changedRecipient;}
  v.states.reverse.source.owner = golden.changedRecipient; v.quotes.forward.recipient = golden.changedRecipient;
  v.states.reverse.source.balance = (BigInt(amount) + 1n).toString(); v.states.reverse.mint.supply = (BigInt(amount) + 8n).toString();
  for (const name of Object.keys(v.limiters)) {
    v.limiters[name].capacity = amount; v.limiters[name].rate = amount;
    v.buckets[name].capacity = amount; v.buckets[name].rate = amount; v.buckets[name].tokens = amount;
  }
  for (const name of ['forward', 'reverse']) {v.quotes[name].amount = amount;}
  v.quotes.forward.ccipFee = expected.fee; v.quotes.forward.payerBalance = '10000000000000000'; v.quotes.forward.exposureLimit = '10000000000000000';
  return v;
}

// Failure: canonical layout or token receiver policy drifts from retained PUBLIC bytes.
test('independent inspection accepts retained public 708-byte send and bounded 68-byte approval', () => {
  assert.equal((golden.historicalCalls[1].data.length - 2) / 2, golden.messageExpectations.sendBytes);
  assert.equal((golden.historicalCalls[0].data.length - 2) / 2, golden.messageExpectations.approveBytes);
  inspectEvmForwardCalls(golden.historicalIntent, golden.historicalCalls);
});

// Failure: an agreeing encoder/decoder or a success flag conceals a different operation.
test('independent inspection rejects envelope, tuple, extra-args, approval and order substitutions', () => {
  const cases = [
    ['wrong router', calls => {calls[1].to = golden.historicalIntent.token;}],
    ['wrong from', calls => {calls[1].from = golden.changedIntent.sender;}],
    ['wrong chain', calls => {calls[1].chainId = '1';}],
    ['wrong native fee', calls => {calls[1].value = '0';}],
    ['unsafe numeric fee', calls => {calls[1].value = Number(golden.historicalIntent.fee);}],
    ['nonce', calls => {calls[1].nonce = '0';}],
    ['encoder success flag', calls => {calls[1].verified = true;}],
    ['wrong selector', calls => {calls[1].data = patch(calls[1].data, 4, word('16015286601757825753'));}],
    ['wrong token', calls => {calls[1].data = patch(calls[1].data, 356, '0'.repeat(24) + golden.changedIntent.token.slice(2));}],
    ['wrong amount', calls => {calls[1].data = patch(calls[1].data, 388, word('1000000001'));}],
    ['outer receiver', calls => {calls[1].data = patch(calls[1].data, 260, '01'.repeat(32));}],
    ['nonempty data', calls => {calls[1].data = patch(calls[1].data, 292, word(1));}],
    ['fee token', calls => {calls[1].data = patch(calls[1].data, 164, '0'.repeat(24) + golden.historicalIntent.token.slice(2));}],
    ['extra-args tag', calls => {calls[1].data = patch(calls[1].data, 452, '1f3b3abb');}],
    ['compute units', calls => {calls[1].data = patch(calls[1].data, 488, word(1));}],
    ['bitmap', calls => {calls[1].data = patch(calls[1].data, 520, word(1));}],
    ['order flag', calls => {calls[1].data = patch(calls[1].data, 552, word(0));}],
    ['raw32 recipient', calls => {calls[1].data = patch(calls[1].data, 584, golden.changedIntent.tokenReceiver.slice(2));}],
    ['accounts', calls => {calls[1].data = patch(calls[1].data, 648, word(1));}],
    ['padding', calls => {calls[1].data = patch(calls[1].data, 707, '01');}],
    ['unlimited approval', calls => {calls[0].data = patch(calls[0].data, 36, 'f'.repeat(64));}],
    ['wrong spender', calls => {calls[0].data = patch(calls[0].data, 4, '0'.repeat(24) + golden.historicalIntent.token.slice(2));}],
    ['order', calls => {calls.reverse();}],
    ['hidden call', calls => {calls.push(calls[0]);}],
  ];
  for (const [label, mutate] of cases) {
    const calls = structuredClone(golden.historicalCalls); mutate(calls);
    assert.throws(() => inspectEvmForwardCalls(golden.historicalIntent, calls), /semantic mismatch/, label);
  }
});

// Failure: preview binds legacy actors/recipient or rounds the last base unit.
test('changed-route application preserves raw32 recipient and amount above 2^53 without promoting readiness', () => {
  const v = changed(), result = preview(v), leg = result.plan.legs.forward, calls = leg.operations.map(operation => operation.unsigned);
  assert.equal(leg.callPlan.availability, 'conditional-send'); assert.equal(leg.executable, false);
  inspectEvmForwardCalls(golden.changedIntent, calls);
  assert.equal(calls[1].data.slice(2 + 388 * 2, 2 + 420 * 2), golden.changedAmountWord);
  assert.equal(calls[1].data.slice(2 + 584 * 2, 2 + 616 * 2), golden.changedIntent.tokenReceiver.slice(2));
  assert.equal(calls[1].from, golden.changedIntent.sender); assert.equal(calls[0].to, golden.changedIntent.token);
  assert.equal(calls[1].value, golden.changedIntent.fee);
  assert.equal(result.plan.legs.reverse.unsignedAvailable, false); assert.equal(result.plan.legs.reverse.conditional, true);
  assert.equal(result.plan.legs.reverse.hypotheticalAfter.sourceBalance, '1');
  assert.equal(result.facts.currentReadiness, null); assert.equal(result.facts.evidenceClass, 'fixture-only');
  assert.equal(leg.quote.current, false); assert.match(result.summary, /local-codec-encoding/);
  assert.equal(result.plan.source.pins.providerManifestSha256, '8cf7da517123c8be46f0a5fa14ef67904bf45bf4cfb972fc2c54be4b91cb56fb');
  for (const operation of leg.operations) {
    assert.equal(operation.callHash, previewPorts.digest(operation.unsigned));
    assert.equal(operation.calldataSha256, hashPreviewBytes(Buffer.from(operation.unsigned.data.slice(2), 'hex')));
    assert.deepEqual(Object.keys(operation.unsigned).toSorted(), ['chainId', 'data', 'from', 'to', 'value']);
  }
});

// Failure: partial/excess/unknown allowance causes reset, unlimited approval or send fallback.
test('application allows only zero/exact allowance and distinguishes conditional approval-only bytes', () => {
  for (const [allowance, count, send] of [['0', 2, true], [fixture.amount, 1, true], ['1', 0, false], ['1000000001', 0, false], [null, 0, false]]) {
    const v = structuredClone(fixture); v.states.forward.allowance = allowance;
    const leg = preview(v).plan.legs.forward;
    assert.equal(leg.operations.filter(operation => operation.unsigned).length, count);
    assert.equal(leg.callPlan.sendAvailable, send); assert.equal(leg.unsignedAvailable, count > 0);
  }
  for (const quote of [null, { ...fixture.quotes.forward, checkedAt: fixture.quotes.forward.expiresAt }]) {
    const v = structuredClone(fixture); v.quotes.forward = quote;
    const leg = preview(v).plan.legs.forward;
    assert.equal(leg.callPlan.availability, 'conditional-approval-only');
    assert.equal(leg.operations[0].unsigned.value, '0'); assert.equal(leg.operations[0].conditional, true);
    assert.equal(leg.operations[1].kind, 'send-intent'); assert.equal(leg.operations[1].bytes, null);
    v.states.forward.allowance = v.amount;
    assert.equal(preview(v).plan.legs.forward.unsignedAvailable, false);
  }
  const unknown = structuredClone(fixture);
  for (const field of ['networkFee', 'rent', 'payerBalance']) {unknown.quotes.forward[field] = null;}
  const result = preview(unknown);
  assert.equal(result.plan.legs.forward.callPlan.sendAvailable, true);
  assert.match(result.plan.legs.forward.prerequisites.join('; '), /Native networkFee unknown/);
  assert.equal(result.plan.legs.forward.executable, false); assert.equal(result.facts.currentReadiness, null);
});

// Failure: unknown native facts conceal a minimum already above a budget or known balance.
for (const [label, costs] of [
  ['unknown rent', { networkFee: '10000000', rent: null }],
  ['unknown balance', { networkFee: '10000000', payerBalance: null }],
  ['payer insufficiency only', { networkFee: '10000000', rent: null, exposureLimit: '20000000' }],
  ['known rent with unknown network fee', { networkFee: null, rent: '10000000' }],
  ['one base unit above 2^53', { networkFee: '9007199253740994', rent: null, payerBalance: null, exposureLimit: '9007199254740993' }],
]) {
  test('known native minimum rejects before provider resolution or encoding: ' + label, async t => {
    const root = await temporary(t), source = join(root, 'input.json'), v = structuredClone(fixture);
    Object.assign(v.quotes.forward, costs);
    const legacy = prepareDevTransferPreview(read(v), previewPorts), forward = legacy.plan.legs.forward;
    assert.equal(forward.status, 'intent-only'); assert.equal(forward.quote.totalExposure, null);
    assert.equal(forward.operations.at(-1).bytes, null); assert.equal(legacy.facts.currentReadiness, null);
    assert.deepEqual(legacy.facts.knownness.quotes.forward, v.quotes.forward);
    await writeFile(source, JSON.stringify(v));
    await assert.rejects(runDevTransferPreview(['--input', source, '--output', join(root, 'output'),
      '--provider-root', join(root, 'missing-provider'), '--provider-archives', join(root, 'missing-archives')]),
    /Forward encoding input conflicts: Native quote exceeds declared budget or payer balance/);
    let encodes = 0;
    assert.throws(() => preview(v, { ...fixtureEncoding, encodeForward(intent) {encodes++; return fixtureEncoding.encodeForward(intent);} }),
      /Native quote exceeds declared budget or payer balance/);
    assert.equal(encodes, 0); assert.deepEqual(await readdir(root), ['input.json']);
  });
}

test('native minimum at the boundary preserves unknown facts, zero costs and conditional bytes', () => {
  for (const costs of [
    { networkFee: '0', rent: null, payerBalance: '1000000', exposureLimit: '1000000' },
    { networkFee: null, rent: '0', payerBalance: '1000000', exposureLimit: '1000000' },
    { networkFee: '9007199253740993', rent: null, payerBalance: '9007199254740993', exposureLimit: '9007199254740993' },
    { payerBalance: null },
  ]) {
    const v = structuredClone(fixture); Object.assign(v.quotes.forward, costs);
    const result = preview(v), forward = result.plan.legs.forward;
    assert.equal(forward.quote.totalExposure, null); assert.deepEqual(result.facts.knownness.quotes.forward, v.quotes.forward);
    assert.equal(forward.callPlan.availability, 'conditional-send'); assert.equal(forward.operations.at(-1).conditional, true);
    assert.equal(forward.executable, false); assert.equal(result.facts.currentReadiness, null);
  }
});

// Failure: application advertises availability before its separate inspector has accepted bytes.
test('application invokes inspection and refuses corrupted encoder output', () => {
  let inspections = 0;
  const encoding = { ...fixtureEncoding,
    encodeForward(intent) { const calls = fixtureEncoding.encodeForward(intent); calls[1].from = golden.changedIntent.sender; return calls; },
    inspectForward(intent, calls) {inspections++; inspectEvmForwardCalls(intent, calls);} };
  assert.throws(() => preview(fixture, encoding), /semantic mismatch: from/); assert.equal(inspections, 1);
});

// Failure: invalid lane, actors, budget or conflicts reach candidate resolution/evaluation first.
test('optional local CLI validates whole input before missing provider paths, with no output on rejection', async t => {
  const root = await temporary(t), source = join(root, 'input.json'), output = join(root, 'output');
  const args = ['--input', source, '--output', output, '--provider-root', join(root, 'missing-provider'), '--provider-archives', join(root, 'missing-archives')];
  for (const mutate of [
    v => {v.lane.chainId = '1';}, v => {v.pair.evm.sender = '0x' + '0'.repeat(40);},
    v => {v.states.forward.allowanceSpender = v.pair.evm.token;},
    v => {v.quotes.forward.ccipFee = '10000000000000001';},
    v => {v.quotes.forward.ccipFee = '10000001';},
    v => {v.quotes.forward.amount = '1';}, v => {v.states.reverse.source.state = 'frozen';},
  ]) {
    const v = structuredClone(fixture); mutate(v); await writeFile(source, JSON.stringify(v));
    await assert.rejects(runDevTransferPreview(args), /pinned|Zero|required|conflicts/);
  }
  await writeFile(source, JSON.stringify(fixture));
  await assert.rejects(runDevTransferPreview(args.slice(0, 6)), /Use --input/);
  for (const path of ['https://provider.invalid/', 'relative-root']) {
    const unsafe = args.slice(); unsafe[5] = path;
    await assert.rejects(runDevTransferPreview(unsafe), /absolute local provider path/);
  }
  assert.deepEqual(await readdir(root), ['input.json']);
});

// Failure: forward provenance is conflated with legacy installation or persisted bytes change on reopen.
test('fixture-port persistence independently reopens deterministically without candidate loading', async t => {
  const root = await temporary(t), result = preview(changed());
  const first = await publishPreview(result, join(root, 'one'));
  const second = await publishPreview(preview(changed()), join(root, 'two'));
  assert.deepEqual(first.plan, second.plan); assert.deepEqual(first.facts, second.facts);
  assert.deepEqual((await reopenPreview(first.directory)).plan, first.plan);
  assert.equal(first.plan.legs.forward.callPlan.provenance.authority, 'agtmai-public-only-dev-provider-v1');
  for (const name of ['plan.json', 'facts.json', 'summary.md', 'complete.json']) {
    assert.deepEqual(await readFile(first.paths[name]), await readFile(second.paths[name]));
  }
});

async function rewriteHashes(output, mutate) {
  const plan = JSON.parse(await readFile(join(output, 'plan.json'))), facts = JSON.parse(await readFile(join(output, 'facts.json')));
  mutate(plan, facts);
  for (const operation of plan.legs.forward.operations.filter(item => item.unsigned)) {
    operation.callHash = previewPorts.digest(operation.unsigned);
    operation.calldataSha256 = hashPreviewBytes(Buffer.from(operation.unsigned.data.slice(2), 'hex'));
  }
  const body = { ...plan }; delete body.planHash; plan.planHash = previewPorts.digest(body); facts.planHash = plan.planHash;
  const complete = JSON.parse(await readFile(join(output, 'complete.json'))); complete.planHash = plan.planHash;
  const contents = { 'plan.json': canonicalPreview(plan) + '\n', 'facts.json': canonicalPreview(facts) + '\n', 'summary.md': previewPorts.render(plan) };
  for (const [name, content] of Object.entries(contents)) {
    await writeFile(join(output, name), content); complete.inventory[name] = hashPreviewBytes(content);
  }
  await writeFile(join(output, 'complete.json'), canonicalPreview(complete) + '\n');
}
// Failure: recalculated agreeing hashes suffice without independently checking semantics.
for (const [label, mutate] of [
  ['unsigned identity', plan => {plan.legs.forward.operations[1].unsigned.from = golden.changedIntent.sender;}],
  ['calldata recipient', plan => {const call = plan.legs.forward.operations[1].unsigned; call.data = patch(call.data, 584, golden.changedIntent.tokenReceiver.slice(2));}],
  ['provider identity', (plan, facts) => {plan.legs.forward.callPlan.provenance.providerManifestSha256 = plan.source.pins.providerManifestSha256; facts.forwardEncoding = plan.legs.forward.callPlan;}],
  ['unknown unsigned field', plan => {plan.legs.forward.operations[1].unsigned.gas = '1';}],
]) {
  test('reopen rejects rehashed ' + label, async t => {
    const root = await temporary(t), output = join(root, 'tampered'); await publishPreview(preview(fixture), output);
    await rewriteHashes(output, mutate);
    await assert.rejects(reopenPreview(output), /semantic mismatch|semantic cross-binding/);
    assert.deepEqual((await readdir(output)).toSorted(), ['complete.json', 'facts.json', 'plan.json', 'summary.md']);
  });
}
