// Required REAL admitted codec validation. Run as a script with raw pinned Node,
// without --test/--import flags. Missing preparation fails; there are no skips.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { loadForwardPreviewEncoding } from '../src/adapters/dev-transfer-preview-provider.mjs';
import { prepareDevTransferPreview } from '../src/application/dev-transfer-preview.mjs';
import { readPreviewInput } from '../src/adapters/dev-transfer-preview-input.mjs';
import { previewPorts, reopenPreview } from '../src/adapters/dev-transfer-preview-store.mjs';
import { inspectEvmForwardCalls } from '../src/adapters/dev-evm-call-plan.mjs';
import { runDevTransferPreview } from '../src/composition/dev-transfer-preview.mjs';

const [root, archives, ...extra] = process.argv.slice(2);
if (!root || !archives || extra.length) {throw new Error('Require fresh public-only DEV provider root and independent retained archive directory');}
const golden = JSON.parse(await readFile(new URL('./fixtures/dev-evm-call-plan-goldens.json', import.meta.url)));
const fixture = JSON.parse(await readFile(new URL('./fixtures/dev-transfer-preview.json', import.meta.url)));
let effects = 0;
const forbidden = () => {effects++; throw new Error('Unexpected offline effect capability');};
for (const [object, names] of [[globalThis, ['fetch']], [http, ['request', 'get', 'createServer']],
  [https, ['request', 'get', 'createServer']], [net, ['connect', 'createConnection', 'createServer']],
  [tls, ['connect', 'createServer']], [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']]]) {
  for (const name of names) {object[name] = forbidden;}
}
net.Socket.prototype.connect = forbidden;
syncBuiltinESMExports();
await test('REAL provider CLI refuses known native minimum before candidate evaluation', async t => {
  const directory = await temporary(t), source = join(directory, 'input.json');
  for (const costs of [
    { networkFee: '10000000', rent: null },
    { networkFee: '10000000', payerBalance: null },
    { networkFee: '10000000', rent: null, exposureLimit: '20000000' },
  ]) {
    const v = structuredClone(fixture); Object.assign(v.quotes.forward, costs);
    await writeFile(source, JSON.stringify(v));
    await assert.rejects(runDevTransferPreview(['--input', source, '--output', join(directory, 'output'),
      '--provider-root', root, '--provider-archives', archives]), /Native quote exceeds declared budget or payer balance/);
    await assert.rejects(readFile(join(directory, 'output/complete.json')), { code: 'ENOENT' });
  }
  assert.equal(Object.keys(createRequire(import.meta.url).cache).some(entry => entry.startsWith(root + '/')), false);
  assert.equal(effects, 0);
});
const encoding = await loadForwardPreviewEncoding({ root, archives });
const read = value => readPreviewInput(JSON.stringify(value));
const preview = value => prepareDevTransferPreview(read(value), { ...previewPorts, forwardEncoding: encoding });
async function temporary(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'forward-native-test-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

await test('REAL admitted encodeApprove/encodeCcipSend/decodeEvmCall matches retained public golden envelopes and bytes', () => {
  const calls = encoding.encodeForward(golden.historicalIntent);
  encoding.inspectForward(golden.historicalIntent, calls);
  assert.deepEqual(calls, golden.historicalCalls);
  assert.deepEqual(Object.keys(encoding).toSorted(), ['encodeForward', 'inspectForward', 'provenance']);
  assert.equal(encoding.provenance.authority, 'agtmai-public-only-dev-provider-v1');
  const cache = createRequire(import.meta.url).cache;
  assert.ok(cache[join(root, 'node_modules/ethers/lib.commonjs/abi/index.js')]);
  assert.ok(cache[join(root, 'node_modules/@solana/web3.js/lib/index.cjs.js')]);
  for (const entry of Object.keys(cache)) {
    assert.equal(entry.startsWith(join(root, 'node_modules/@chainlink/ccip-sdk') + '/'), false, 'SDK entry evaluated');
    assert.equal(entry.startsWith(join(root, 'node_modules/@coral-xyz/anchor') + '/'), false, 'Anchor entry evaluated');
    assert.equal(entry.startsWith(join(root, 'node_modules/@solana/spl-token') + '/'), false, 'SPL entry evaluated');
  }
});

await test('REAL native minimum at the boundary preserves bytes and unknown exposure', () => {
  for (const costs of [
    { networkFee: '0', rent: null, payerBalance: '1000000', exposureLimit: '1000000' },
    { networkFee: '9007199253740993', rent: null, payerBalance: '9007199254740993', exposureLimit: '9007199254740993' },
    { payerBalance: null },
  ]) {
    const v = structuredClone(fixture); Object.assign(v.quotes.forward, costs);
    const result = preview(v), forward = result.plan.legs.forward;
    inspectEvmForwardCalls({ ...golden.historicalIntent, sender: fixture.pair.evm.sender, token: fixture.pair.evm.token,
      fee: '1000000', tokenReceiver: '0x' + '0c'.repeat(32) }, forward.operations.map(operation => operation.unsigned));
    assert.equal(forward.quote.totalExposure, null); assert.deepEqual(result.facts.knownness.quotes.forward, v.quotes.forward);
    assert.equal(forward.callPlan.availability, 'conditional-send'); assert.equal(forward.operations.at(-1).conditional, true);
    assert.equal(forward.executable, false); assert.equal(result.facts.currentReadiness, null);
  }
});

await test('REAL optional local-provider CLI persists changed forward route/large amount and independently reopens deterministically', async t => {
  const directory = await temporary(t), source = join(directory, 'input.json'), v = structuredClone(fixture), expected = golden.changedIntent;
  v.amount = expected.amount; v.pair.evm.token = expected.token; v.states.forward.token = expected.token;
  v.states.reverse.remoteTokenHex = '0'.repeat(24) + expected.token.slice(2);
  v.pair.evm.sender = expected.sender; v.states.forward.sender = expected.sender; v.states.forward.allowanceOwner = expected.sender;
  v.states.forward.balance = '9007199254740994';
  for (const name of ['sender', 'recipient', 'payer']) {v.pair.svm[name] = golden.changedRecipient;}
  v.states.reverse.source.owner = golden.changedRecipient; v.quotes.forward.recipient = golden.changedRecipient;
  v.states.reverse.source.balance = '9007199254740994'; v.states.reverse.mint.supply = '9007199254741001';
  for (const name of Object.keys(v.limiters)) {
    v.limiters[name].capacity = expected.amount; v.limiters[name].rate = expected.amount;
    v.buckets[name].capacity = expected.amount; v.buckets[name].rate = expected.amount; v.buckets[name].tokens = expected.amount;
  }
  for (const name of ['forward', 'reverse']) {v.quotes[name].amount = expected.amount;}
  v.quotes.forward.ccipFee = expected.fee; v.quotes.forward.payerBalance = '10000000000000000'; v.quotes.forward.exposureLimit = '10000000000000000';
  v.quotes.forward.networkFee = null; v.quotes.forward.rent = null;
  await writeFile(source, JSON.stringify(v));
  const create = output => runDevTransferPreview(['--input', source, '--output', output, '--provider-root', root, '--provider-archives', archives]);
  const first = await create(join(directory, 'one')), second = await create(join(directory, 'two'));
  assert.deepEqual(first.plan, second.plan);
  assert.deepEqual((await runDevTransferPreview(['--reopen', first.directory])).plan, first.plan);
  assert.deepEqual((await reopenPreview(first.directory)).facts, first.facts);
  const calls = first.plan.legs.forward.operations.map(operation => operation.unsigned);
  inspectEvmForwardCalls(expected, calls);
  assert.equal(calls[1].data.slice(2 + 388 * 2, 2 + 420 * 2), golden.changedAmountWord);
  assert.equal(calls[1].data.slice(2 + 584 * 2, 2 + 616 * 2), expected.tokenReceiver.slice(2));
  assert.equal(calls[1].value, expected.fee);
  assert.equal(first.plan.legs.forward.callPlan.availability, 'conditional-send');
  assert.equal(first.plan.legs.forward.executable, false); assert.equal(first.facts.currentReadiness, null);
  assert.equal(first.plan.legs.reverse.unsignedAvailable, false); assert.equal(first.plan.legs.reverse.conditional, true);
  assert.match(first.plan.legs.forward.prerequisites.join('; '), /Native networkFee unknown/);
  assert.equal(first.plan.source.pins.providerLockSha256, '1477c1d04940f9556ff87eaf82de6f0f2eaa6f3585deea0f09bfdab8fba7f50f');
  for (const name of ['plan.json', 'facts.json', 'summary.md', 'complete.json']) {
    assert.deepEqual(await readFile(first.paths[name]), await readFile(second.paths[name]));
  }
});

await test('REAL expired quote yields only conditional bounded approval bytes and no send fallback', () => {
  const v = structuredClone(fixture); v.quotes.forward.checkedAt = v.quotes.forward.expiresAt;
  const result = preview(v), forward = result.plan.legs.forward;
  assert.equal(forward.callPlan.availability, 'conditional-approval-only'); assert.equal(forward.callPlan.sendAvailable, false);
  assert.equal(forward.operations[0].unsigned.data, golden.historicalCalls[0].data);
  assert.equal(forward.operations[1].kind, 'send-intent'); assert.equal(forward.operations[1].bytes, null);
  assert.equal(forward.executable, false); assert.equal(result.facts.currentReadiness, null);
});

await test('REAL exact allowance omits approval; missing native quote with exact allowance has no bytes', () => {
  const v = structuredClone(fixture); v.states.forward.allowance = v.amount;
  const forward = preview(v).plan.legs.forward;
  assert.equal(forward.operations.length, 1); assert.equal(forward.operations[0].kind, 'ccip-send');
  assert.equal((forward.operations[0].unsigned.data.length - 2) / 2, 708);
  v.quotes.forward = null;
  const unavailable = preview(v).plan.legs.forward;
  assert.equal(unavailable.unsignedAvailable, false); assert.equal(unavailable.callPlan.availability, 'unavailable');
});

await test('REAL admitted preview attempted no network, listener or subprocess effects', () => {assert.equal(effects, 0);});
