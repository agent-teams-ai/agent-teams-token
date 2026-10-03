// Actual admitted codecs only. Explicit local public authority paths; no skips.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm, realpath, lstat, chmod, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { loadBidirectionalPreviewEncoding } from '../src/adapters/dev-transfer-preview-provider.mjs';
import { readPreviewInput } from '../src/adapters/dev-transfer-preview-input.mjs';
import { prepareDevTransferPreview } from '../src/application/dev-transfer-preview.mjs';
import { previewPorts, publishPreview, reopenPreview, renderPreview, canonicalPreview, hashPreviewBytes } from '../src/adapters/dev-transfer-preview-store.mjs';
import { runDevTransferPreview, completeDevUnsignedEncoding } from '../src/composition/dev-transfer-preview.mjs';
import { solanaPublicKeyBytes } from '../src/domain/solana-mint.ts';
const [root, archives, ...extra] = process.argv.slice(2);
if (!root || !archives || extra.length) {throw new Error('Require explicit public provider root and independent retained archive directory');}
const fixture = JSON.parse(await readFile(new URL('./fixtures/dev-bidirectional-preview.json', import.meta.url)));
const evm = JSON.parse(await readFile(new URL('./fixtures/dev-evm-call-plan-goldens.json', import.meta.url)));
let effects = 0;
const forbidden = () => {effects++; throw new Error('Offline consumer attempted network effect');};
for (const [object, names] of [[globalThis, ['fetch']], [http, ['request', 'get', 'createServer']], [https, ['request', 'get', 'createServer']],
  [net, ['connect', 'createConnection', 'createServer']], [tls, ['connect', 'createServer']]]) {for (const name of names) {object[name] = forbidden;}}
net.Socket.prototype.connect = forbidden; syncBuiltinESMExports();
const cli = resolve('tooling/testnet-ccip/src/composition/dev-transfer-preview.mjs');
const clone = () => structuredClone(fixture);
const normalized = f => readPreviewInput(JSON.stringify(f.input), JSON.stringify(f.reverseCall));
async function temporary(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'bidirectional-native-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function paths(directory, f) {
  const source = join(directory, 'input.json'), reverse = join(directory, 'reverse.json');
  await writeFile(source, JSON.stringify(f.input)); await writeFile(reverse, JSON.stringify(f.reverseCall));
  return ['--input', source, '--output', join(directory, 'output'), '--reverse-input', reverse, '--provider-root', root, '--provider-archives', archives];
}
const invokeCli = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', TMPDIR: tmpdir() } });
const cliReopenArgs = directory => ['--reopen', directory, '--provider-root', root, '--provider-archives', archives];
function corruptRaw(f, name) {
  const raw = f.reverseCall.facts.state[name], b = Buffer.from(raw.dataBase64, 'base64');
  if (name === 'mint') {b[45] = 0;}
  else if (name === 'sourceAta' || name === 'poolAta') {b[108] = 2;}
  else {b[0] ^= 1;}
  raw.dataBase64 = b.toString('base64'); raw.sha256 = hashPreviewBytes(b);
}
async function tamperArtifact(directory, change) {
  const plan = JSON.parse(await readFile(join(directory, 'plan.json'))), facts = JSON.parse(await readFile(join(directory, 'facts.json')));
  change(plan); plan.route.reverseRoute = plan.input.reverseCall.route; facts.knownness.reverseCall = plan.input.reverseCall;
  plan.routeHash = previewPorts.digest(plan.route);
  plan.planHash = previewPorts.digest(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planHash')));
  facts.routeHash = plan.routeHash; facts.planHash = plan.planHash; facts.reverseEncoding = plan.legs.reverse.callPlan;
  const bytes = { 'plan.json': canonicalPreview(plan) + '\n', 'facts.json': canonicalPreview(facts) + '\n', 'summary.md': renderPreview(plan) };
  const complete = JSON.parse(await readFile(join(directory, 'complete.json'))); complete.planHash = plan.planHash; complete.routeHash = plan.routeHash;
  for (const [name, data] of Object.entries(bytes)) {await writeFile(join(directory, name), data); complete.inventory[name] = hashPreviewBytes(data);}
  await writeFile(join(directory, 'complete.json'), canonicalPreview(complete) + '\n');
}
await test('known consumer/raw minimum rejects before actual native candidate evaluation', async t => {
  const directory = await temporary(t), f = clone(); f.input.quotes.reverse.exposureLimit = '4'; f.reverseCall.facts.maxExposureLamports = '4';
  f.reverseCall.facts.fees.networkFee = null;
  await assert.rejects(runDevTransferPreview(await paths(directory, f)), /known cost lower bound/);
  assert.equal(Object.keys(createRequire(import.meta.url).cache).some(p => p.startsWith(root + '/')), false);
});
const encoding = await loadBidirectionalPreviewEncoding({ root, archives });
const preview = f => prepareDevTransferPreview(normalized(f), { ...previewPorts, ...encoding });
await test('actual consumer builds both retained public callplans with one sole zero-signature payer and no readiness claim', () => {
  const result = preview(fixture), reverse = result.plan.legs.reverse, candidate = reverse.callPlan.candidate;
  assert.deepEqual(result.plan.legs.forward.operations.map(o => o.unsigned), fixture.expectedForwardCalls);
  assert.equal(Buffer.from(candidate.instructions.at(-1).dataBase64, 'base64').toString('hex'), fixture.expectedSendHex);
  const packet = Buffer.from(candidate.transactionBase64, 'base64');
  assert.ok(packet.length <= 1232); assert.equal(packet[0], 1); assert.deepEqual(packet.subarray(1, 65), Buffer.alloc(64));
  assert.equal(packet[65], 0x80); assert.equal(packet[66], 1);
  assert.deepEqual(packet.subarray(70, 102), solanaPublicKeyBytes(fixture.input.pair.svm.payer));
  assert.equal(candidate.instructions.at(-1).accounts[3].address, fixture.input.pair.svm.recipient);
  assert.equal(reverse.callPlan.transactionSha256, hashPreviewBytes(packet));
  assert.deepEqual(candidate.modelledAfter, { qualification: 'hypothetical-success-only', mintSupply: '19000000000', sourceBalance: '9000000000',
    poolBalance: '3000000000', delegate: null, delegatedAmount: '0' });
  assert.deepEqual(result.facts.unsignedAvailable, { forward: true, reverse: true }); assert.equal(result.facts.currentReadiness, null);
  assert.equal(result.plan.broadcastAllowed, false); assert.equal(candidate.broadcastAllowed, false);
  assert.equal(result.facts.evidenceClass, 'fixture-only'); assert.equal(completeDevUnsignedEncoding(result), true);
  assert.match(result.summary, /hypothetical common before-state/); assert.match(result.summary, /Unsigned v0 transaction/);
  for (const entry of Object.keys(createRequire(import.meta.url).cache)) {
    assert.equal(entry.startsWith(join(root, 'node_modules/@chainlink/ccip-sdk') + '/'), false);
    assert.equal(entry.startsWith(join(root, 'node_modules/@coral-xyz/anchor') + '/'), false);
  }
});
await test('changed return receiver and exact large amount match independent retained SVM and EVM wire expectations', () => {
  const f = clone(), amount = fixture.changedAmount;
  for (const target of [f.input, f.reverseCall.route]) {target.profile = 'product100M'; target.fixedSupplyBaseUnits = '100000000000000000'; target.amount = amount;}
  f.input.states.forward.totalSupply = f.input.fixedSupplyBaseUnits; f.input.states.forward.balance = '90000000000000000';
  f.input.pair.evm.recipient = fixture.changedRecipient; f.reverseCall.route.recipient = fixture.changedRecipient; f.input.quotes.reverse.recipient = fixture.changedRecipient;
  f.input.states.reverse.mint.supply = f.input.fixedSupplyBaseUnits; f.input.states.reverse.source.balance = '90000000000000000';
  f.reverseCall.facts.before.mintSupply = f.input.fixedSupplyBaseUnits; f.reverseCall.facts.before.sourceBalance = '90000000000000000';
  for (const [name, value, offset] of [['mint', f.input.fixedSupplyBaseUnits, 36], ['sourceAta', '90000000000000000', 64]]) {
    const raw = f.reverseCall.facts.state[name], b = Buffer.from(raw.dataBase64, 'base64'); b.writeBigUInt64LE(BigInt(value), offset);
    raw.dataBase64 = b.toString('base64'); raw.sha256 = hashPreviewBytes(b);
  }
  for (const name of Object.keys(f.input.limiters)) {
    Object.assign(f.input.limiters[name], fixture.changedLimiterPolicy);
    Object.assign(f.input.buckets[name], fixture.changedLimiterPolicy, { tokens: fixture.changedLimiterTokens });
  }
  // RED: large-amount main policies alone leave raw captured availability below the selected amount.
  const raw = f.reverseCall.facts.state.chain, b = Buffer.from(raw.dataBase64, 'base64');
  for (const offset of [73, 106]) {
    b.writeBigUInt64LE(BigInt(fixture.changedLimiterTokens), offset);
    b.writeBigUInt64LE(BigInt(fixture.changedLimiterPolicy.capacity), offset + 17);
    b.writeBigUInt64LE(BigInt(fixture.changedLimiterPolicy.rate), offset + 25);
  }
  raw.dataBase64 = b.toString('base64'); raw.sha256 = hashPreviewBytes(b);
  for (const q of Object.values(f.input.quotes)) {q.amount = amount;} f.reverseCall.facts.fees.quote.amount = amount;
  const result = preview(f), calls = result.plan.legs.forward.operations.map(o => o.unsigned);
  const patch = (data, offset) => data.slice(0, 2 + offset * 2) + evm.changedAmountWord + data.slice(2 + (offset + 32) * 2);
  assert.deepEqual(calls, fixture.expectedForwardCalls.map((call, i) => ({ ...call, data: patch(call.data, i === 0 ? 36 : 388) })));
  const candidate = result.plan.legs.reverse.callPlan.candidate;
  assert.equal(Buffer.from(candidate.instructions.at(-1).dataBase64, 'base64').toString('hex'), fixture.changedSendHex);
  assert.equal(candidate.modelledAfter.sourceBalance, '80992800745259007'); assert.equal(candidate.modelledAfter.mintSupply, '90992800745259007');
});
await test('partial raw facts or main input prerequisites never get reverse send bytes from the actual port', () => {
  for (const change of [f => {f.reverseCall.facts.state.alt = null;}, f => {f.reverseCall.facts.state.chain = null;},
    f => {f.reverseCall.facts.before = null;}, f => {f.reverseCall.route.limiters = null;}, f => {f.reverseCall.facts.fees.quote = null;},
    f => {f.reverseCall.facts.blockhash = null;}, f => {f.reverseCall.facts.payerBalance.lamports = null;},
    f => {f.reverseCall.facts.fees.quote.validThroughSlot = '100';}, f => {f.input.states.reverse.commonBeforeState = false;},
    f => {f.input.quotes.reverse.checkedAt = f.input.quotes.reverse.expiresAt;}, f => {f.input.buckets.svmOutbound = null;},
    f => {f.input.states.reverse = null;}]) {
    const f = clone(); change(f); const result = preview(f), reverse = result.plan.legs.reverse;
    assert.equal(reverse.unsignedAvailable, false); assert.equal(reverse.callPlan.candidate, null);
    assert.equal(reverse.operations.at(-1).bytes, null); assert.equal(result.facts.currentReadiness, null); assert.equal(completeDevUnsignedEncoding(result), false);
  }
  for (const [direction, offset] of [['inbound', 73], ['outbound', 106]]) {
    for (const tokens of ['0', (BigInt(fixture.input.amount) - 1n).toString(), null]) {
      const f = clone();
      if (tokens === null) {f.reverseCall.route.limiters = { inbound: { ...f.input.limiters.svmInbound }, outbound: { ...f.input.limiters.svmOutbound }, [direction]: null };}
      else {
        const raw = f.reverseCall.facts.state.chain, b = Buffer.from(raw.dataBase64, 'base64');
        b.writeBigUInt64LE(BigInt(tokens), offset); b.writeBigUInt64LE(0n, offset + 8);
        raw.dataBase64 = b.toString('base64'); raw.sha256 = hashPreviewBytes(b);
      }
      const result = preview(f), reverse = result.plan.legs.reverse;
      assert.equal(reverse.callPlan.candidate, null); assert.equal(reverse.callPlan.sendAvailable, false);
      assert.equal(reverse.operations.at(-1).bytes, null); assert.equal(completeDevUnsignedEncoding(result), false);
      assert.match(reverse.prerequisites.join('; '), new RegExp(direction + ' limiter'));
    }
  }
});
await test('actual selected provider CLI persist/reopen is deterministic and private; complete encoding alone exits zero', async t => {
  const directory = await temporary(t), args = await paths(directory, fixture), result = await runDevTransferPreview(args);
  assert.equal(completeDevUnsignedEncoding(result), true);
  assert.deepEqual((await reopenPreview(result.directory, encoding)).plan, result.plan);
  await assert.rejects(reopenPreview(result.directory), /explicitly admitted local provider/);
  const reopenArgs = ['--reopen', result.directory, '--provider-root', root, '--provider-archives', archives];
  assert.deepEqual((await runDevTransferPreview(reopenArgs)).facts, result.facts);
  for (const path of Object.values(result.paths)) {assert.equal((await lstat(path)).mode & 0o7777, 0o600);}
  assert.equal((await lstat(result.directory)).mode & 0o7777, 0o700);
  await chmod(result.paths['facts.json'], 0o2600);
  await assert.rejects(reopenPreview(result.directory, encoding), /Invalid artifact file/);
  await chmod(result.paths['facts.json'], 0o600);
  const env = { PATH: '/usr/bin:/bin', TMPDIR: await realpath(tmpdir()) };
  const invoke = arguments_ => spawnSync(process.execPath, [cli, ...arguments_], { encoding: 'utf8', env });
  const fresh = [...args]; fresh[3] = join(directory, 'cli');
  const success = invoke(fresh); assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).qualification, 'DEV-unsigned-local-encoding-only');
  assert.equal(invoke(reopenArgs).status, 0); assert.equal(invoke(['--reopen', result.directory]).status, 2);
  assert.equal(invoke(args).status, 1); // Exclusive collision.
  const partial = clone(); partial.reverseCall.facts.fees.quote = null;
  const partialDir = join(directory, 'partial'); await import('node:fs/promises').then(fs => fs.mkdir(partialDir, { mode: 0o700 }));
  assert.equal(invoke(await paths(partialDir, partial)).status, 2);
  const unknown = clone(); unknown.reverseCall.facts.state.chain = null;
  const unknownDir = join(directory, 'unknown-chain'); await import('node:fs/promises').then(fs => fs.mkdir(unknownDir, { mode: 0o700 }));
  assert.equal(invoke(await paths(unknownDir, unknown)).status, 2);
  for (const direction of ['forward', 'reverse']) {
    const missing = clone(); missing.input.states[direction] = null;
    const missingDir = join(directory, 'missing-' + direction);
    await import('node:fs/promises').then(fs => fs.mkdir(missingDir, { mode: 0o700 }));
    const unavailable = invoke(await paths(missingDir, missing));
    assert.equal(unavailable.status, 2, unavailable.stderr);
    const plan = JSON.parse(await readFile(join(missingDir, 'output', 'plan.json')));
    assert.deepEqual(plan.legs[direction].conflicts, []); assert.equal(plan.legs[direction].callPlan.sendAvailable, false);
    assert.match(plan.legs[direction].prerequisites.join('; '), /Quote before-state provenance unavailable/);
    assert.equal(invoke(['--reopen', join(missingDir, 'output'), '--provider-root', root, '--provider-archives', archives]).status, 2);
  }
});
await test('coherently rehashed reopened candidate tampering cannot gain unsigned availability', async t => {
  const directory = await temporary(t);
  const changes = [p => {p.legs.reverse.callPlan.candidate.modelledAfter.delegate = p.input.pair.svm.spender;},
    p => {p.legs.reverse.callPlan.candidate.knownCostLowerBoundLamports = '0';},
    p => {p.legs.reverse.callPlan.candidate.instructions.at(-1).accounts[3].address = p.input.pair.svm.poolOwner;},
    p => {const c = p.legs.reverse.callPlan.candidate, b = Buffer.from(c.transactionBase64, 'base64'); b[1] = 1; c.transactionBase64 = b.toString('base64'); p.legs.reverse.callPlan.transactionSha256 = hashPreviewBytes(b);},
    p => {const c = p.legs.reverse.callPlan.candidate, b = Buffer.from(c.instructions.at(-1).dataBase64, 'base64'); b[92] ^= 1; c.instructions.at(-1).dataBase64 = b.toString('base64');},
    p => {p.legs.reverse.callPlan.provenance.authority = 'forged';}, p => {p.input.reverseCall.facts.before.delegatedAmount = '1';},
    // Rehashed native policy/capture changes cannot replace normalized selection or grant availability.
    p => {p.input.reverseCall.route.limiters.inbound.capacity = (BigInt(p.input.limiters.svmInbound.capacity) + 1n).toString();},
    p => {const raw = p.input.reverseCall.facts.state.chain, b = Buffer.from(raw.dataBase64, 'base64'); b.writeBigUInt64LE(0n, 106);
      raw.dataBase64 = b.toString('base64'); raw.sha256 = hashPreviewBytes(b);}];
  for (let i = 0; i < changes.length; i++) {
    const result = await publishPreview(preview(fixture), join(directory, String(i)), encoding);
    await tamperArtifact(result.directory, changes[i]);
    await assert.rejects(reopenPreview(result.directory, encoding));
  }
});
await test('CLI rejects each supplied malformed raw record despite another missing record and unknown costs/before-state', async t => {
  const directory = await temporary(t), exits = [];
  const complete = clone(); corruptRaw(complete, 'chain');
  const completeDir = join(directory, 'complete-malformed'); await mkdir(completeDir, { mode: 0o700 });
  const rejected = invokeCli(await paths(completeDir, complete)); assert.equal(rejected.error, undefined);
  assert.equal(rejected.status, 1, rejected.stderr); assert.match(rejected.stderr, /chain captured layout or integrity/);
  for (const [label, name, missing, offset, value] of [
    ['known insufficient source', 'sourceAta', 'mint', 64, BigInt(fixture.input.amount) - 1n],
    ['known overissuance', 'mint', 'sourceAta', 36, BigInt(fixture.input.fixedSupplyBaseUnits) + 1n],
    ['known pool overflow', 'poolAta', 'sourceAta', 64, (1n << 64n) - 1n]]) {
    const f = clone(); f.reverseCall.facts.state[missing] = null;
    f.reverseCall.facts.before = null; f.reverseCall.facts.fees.networkFee = null; f.input.states.reverse = null;
    const raw = f.reverseCall.facts.state[name], bytes = Buffer.from(raw.dataBase64, 'base64'); bytes.writeBigUInt64LE(value, offset);
    raw.dataBase64 = bytes.toString('base64'); raw.sha256 = hashPreviewBytes(bytes);
    const child = join(directory, label); await mkdir(child, { mode: 0o700 });
    const result = invokeCli(await paths(child, f)); assert.equal(result.error, undefined); exits.push([label, result.status]);
  }
  for (const name of Object.keys(fixture.reverseCall.facts.state)) {
    const f = clone(); f.reverseCall.facts.state[name === 'alt' ? 'chain' : 'alt'] = null;
    f.reverseCall.facts.before = null; f.reverseCall.facts.fees.networkFee = null; f.input.states.reverse = null;
    corruptRaw(f, name);
    const child = join(directory, name); await mkdir(child, { mode: 0o700 });
    const result = invokeCli(await paths(child, f)); assert.equal(result.error, undefined);
    exits.push([name, result.status]);
    if (result.status === 1) {assert.match(result.stderr, /DEV_PREVIEW_REJECTED/); assert.doesNotMatch(result.stderr, /ENOENT|byte hash mismatch|semantic cross-binding/);}
  }
  assert.deepEqual(exits, ['known insufficient source', 'known overissuance', 'known pool overflow',
    ...Object.keys(fixture.reverseCall.facts.state)].map(name => [name, 1]));
});
await test('CLI rejects coherently rehashed malformed-plus-missing artifacts made from independently valid persisted partial output', async t => {
  const directory = await temporary(t), exits = [];
  for (const name of ['routerConfig', 'registry', 'pool', 'chain']) {
    const f = clone(); f.reverseCall.facts.state.alt = null;
    const child = join(directory, name); await mkdir(child, { mode: 0o700 });
    const created = invokeCli(await paths(child, f)); assert.equal(created.error, undefined); assert.equal(created.status, 2, created.stderr);
    const output = join(child, 'output'); assert.equal(invokeCli(cliReopenArgs(output)).status, 2);
    await tamperArtifact(output, plan => corruptRaw({ reverseCall: plan.input.reverseCall }, name));
    const reopened = invokeCli(cliReopenArgs(output)); assert.equal(reopened.error, undefined); exits.push([name, reopened.status]);
    if (reopened.status === 1) {assert.match(reopened.stderr, /captured layout or integrity/);}
  }
  assert.deepEqual(exits, ['routerConfig', 'registry', 'pool', 'chain'].map(name => [name, 1]));
});
await test('valid partial CLI create/reopen retains every supplied raw fact and unknown costs/before-state without reverse bytes', async t => {
  const directory = await temporary(t), f = clone(); f.reverseCall.facts.state.alt = null;
  f.reverseCall.facts.before = null; f.reverseCall.facts.fees.networkFee = null;
  const created = invokeCli(await paths(directory, f)); assert.equal(created.error, undefined); assert.equal(created.status, 2, created.stderr);
  const output = join(directory, 'output'), reopened = invokeCli(cliReopenArgs(output));
  assert.equal(reopened.error, undefined); assert.equal(reopened.status, 2, reopened.stderr);
  const plan = JSON.parse(await readFile(join(output, 'plan.json'))), facts = JSON.parse(await readFile(join(output, 'facts.json')));
  assert.deepEqual(plan.input.reverseCall.facts, f.reverseCall.facts);
  assert.deepEqual(facts.knownness.reverseCall.facts, f.reverseCall.facts);
  assert.equal(plan.legs.reverse.callPlan.sendAvailable, false); assert.equal(plan.legs.reverse.callPlan.candidate, null);
  assert.equal(plan.legs.reverse.operations.at(-1).bytes, null); assert.equal(facts.currentReadiness, null); assert.equal(plan.broadcastAllowed, false);
  assert.match(plan.legs.reverse.prerequisites.join('; '), /Raw alt missing/);
});
await test('finite consumer made no network requests', () => {assert.equal(effects, 0);});
// Official SDK/Borsh compatibility and independent source reviews remain separately owned and OPEN.
