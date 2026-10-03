import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdtemp, rm, mkdir, rename, symlink, lstat, readdir, realpath, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { readPreviewInput } from '../src/adapters/dev-transfer-preview-input.mjs';
import { previewPorts, publishPreview, reopenPreview, readPreviewFile } from '../src/adapters/dev-transfer-preview-store.mjs';
import { prepareDevTransferPreview } from '../src/application/dev-transfer-preview.mjs';
const fixturePath = resolve('tooling/testnet-ccip/tests/fixtures/dev-transfer-preview.json');
const cli = resolve('tooling/testnet-ccip/src/composition/dev-transfer-preview.mjs');
const effectsGuard = resolve('tooling/testnet-ccip/tests/fixtures/dev-transfer-preview-no-effects.mjs');
const bytesHash = value => createHash('sha256').update(value).digest('hex');
// Failure caught: fresh checkouts have no .local; canonical OS temp paths also keep deliberate symlink rejection meaningful.
async function temporary(t) { const dir = await mkdtemp(join(await realpath(tmpdir()), 'pr1-preview-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function artifacts() { return prepareDevTransferPreview(readPreviewInput(await readFile(fixturePath, 'utf8')), previewPorts); }
function invoke(args) {
  return spawnSync(process.execPath, ['--import', effectsGuard, cli, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', TZ: 'UTC' } });
}

// Failure caught: a hidden network/fee lookup or subprocess, in-memory-only success, or stale output reuse breaks this real CLI run.
test('real offline CLI exclusively persists and independently reopens a complete intent-only diagnostic', async t => {
  const root = await temporary(t), output = join(root, 'preview');
  const result = invoke(['--input', fixturePath, '--output', output]);
  assert.equal(result.status, 2, result.stderr); assert.equal(result.error, undefined);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'intent-only'); assert.equal(receipt.unsignedAvailable, false); assert.equal(receipt.broadcastAllowed, false);
  const reopened = invoke(['--reopen', output]); assert.equal(reopened.status, 2, reopened.stderr);
  assert.deepEqual(JSON.parse(reopened.stdout), receipt);
  const plan = JSON.parse(await readFile(receipt.paths['plan.json'], 'utf8'));
  const facts = JSON.parse(await readFile(receipt.paths['facts.json'], 'utf8'));
  assert.equal(plan.route.amount, '1000000000'); assert.equal(facts.currentReadiness, null);
  assert.equal(plan.legs.reverse.hypotheticalAfter.poolBalance, '7');
  assert.match(plan.legs.reverse.condition, /Finalized receive/);
  assert.match(await readFile(receipt.paths['summary.md'], 'utf8'), /Conditional return.*Reviewed CCIP SDK 1.13.0/s);
  const complete = JSON.parse(await readFile(receipt.paths['complete.json'], 'utf8'));
  for (const [name, hash] of Object.entries(complete.inventory)) {assert.equal(bytesHash(await readFile(join(output, name))), hash);}
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(output)).toSorted(), ['complete.json', 'facts.json', 'plan.json', 'summary.md']);
  assert.equal(invoke(['--input', fixturePath, '--output', output]).status, 1);
});

// Failure caught: an actual partially written plan could acquire a completion marker or be accepted on reopen after storage fails.
test('partial-write failure publishes no completion and retains only diagnostic residue', async t => {
  const root = await temporary(t), output = join(root, 'partial');
  const probe = await open(root, 'r'), prototype = Object.getPrototypeOf(probe), realWrite = prototype.writeFile;
  await probe.close();
  let writes = 0;
  t.mock.method(prototype, 'writeFile', async function(data, options) {
    writes++; assert.equal(data[0], 123); // The JSON object starts with '{'.
    await realWrite.call(this, data.subarray(0, 1), options);
    throw Object.assign(new Error('Injected storage interruption'), { code: 'EIO' });
  });
  await assert.rejects(publishPreview(await artifacts(), output), { code: 'EIO' });
  assert.equal(writes, 1);
  assert.deepEqual(await readdir(output), ['plan.json']);
  assert.equal(await readFile(join(output, 'plan.json'), 'utf8'), '{');
  await assert.rejects(lstat(join(output, 'complete.json')), { code: 'ENOENT' });
  await assert.rejects(reopenPreview(output), /Incomplete/);
});

// Failure caught: file hashes alone could let coherent tampering relabel an intent-only diagnostic as readiness.
test('reopen rejects changed display bytes and coherent machine-fact tampering', async t => {
  const root = await temporary(t), output = join(root, 'tampered');
  await publishPreview(await artifacts(), output);
  await writeFile(join(output, 'summary.md'), 'claimed current readiness');
  await assert.rejects(reopenPreview(output), /byte hash/);
  const other = join(root, 'coherent'); await publishPreview(await artifacts(), other);
  const facts = JSON.parse(await readFile(join(other, 'facts.json'), 'utf8')); facts.currentReadiness = true;
  const bytes = JSON.stringify(facts); await writeFile(join(other, 'facts.json'), bytes);
  const complete = JSON.parse(await readFile(join(other, 'complete.json'), 'utf8'));
  complete.inventory['facts.json'] = bytesHash(bytes); await writeFile(join(other, 'complete.json'), JSON.stringify(complete));
  await assert.rejects(reopenPreview(other), /semantic cross-binding/);
});

// Failure caught: one new entry during artifact reads could escape the initial inventory check.
test('reopen rejects a single injected entry after reading completion without directory replacement', async t => {
  const root = await temporary(t), output = join(root, 'preview');
  await publishPreview(await artifacts(), output);
  const directory = await lstat(output), complete = await lstat(join(output, 'complete.json'));
  const probe = await open(output, 'r'), prototype = Object.getPrototypeOf(probe), realStat = prototype.stat;
  await probe.close();
  let completionStats = 0, injections = 0;
  t.mock.method(prototype, 'stat', async function(...args) {
    const held = await realStat.apply(this, args);
    if (held.dev === complete.dev && held.ino === complete.ino && ++completionStats === 2) {
      await writeFile(join(output, 'injected.txt'), 'single injection'); injections++;
    }
    return held;
  });
  await assert.rejects(reopenPreview(output), /Incomplete or injected artifact inventory/);
  assert.equal(injections, 1);
  const after = await lstat(output); assert.deepEqual([after.dev, after.ino], [directory.dev, directory.ino]);
  assert.deepEqual((await readdir(output)).toSorted(), ['complete.json', 'facts.json', 'injected.txt', 'plan.json', 'summary.md']);
  assert.equal(await readFile(join(output, 'injected.txt'), 'utf8'), 'single injection');
});

// Failure caught: growth after the initial real descriptor stat could allocate/read beyond the byte ceiling before rejection.
for (const name of ['input', 'complete.json', 'plan.json']) {
  test('descriptor reads cap post-stat growth for ' + name + ' at maximum plus one byte', async t => {
    const root = await temporary(t), output = join(root, 'preview'), maximum = name === 'input' ? 65536 : 1048576;
    const target = name === 'input' ? join(root, 'input.json') : join(output, name);
    if (name === 'input') {await writeFile(target, 'ten bytes!');} else {await publishPreview(await artifacts(), output);}
    const probe = await open(target, 'r'), initial = await probe.stat(), prototype = Object.getPrototypeOf(probe);
    const realStat = prototype.stat, realRead = prototype.read, realReadFile = prototype.readFile;
    await probe.close();
    let injections = 0, consumed = 0, growingHandle;
    t.mock.method(prototype, 'stat', async function(...args) {
      const held = await realStat.apply(this, args);
      if (!injections && held.dev === initial.dev && held.ino === initial.ino) {
        growingHandle = this;
        await appendFile(target, Buffer.alloc(maximum + 4096 - held.size, 120)); injections++;
      }
      return held;
    });
    t.mock.method(prototype, 'read', async function(...args) {
      const result = await realRead.apply(this, args);
      if (this === growingHandle) {consumed += result.bytesRead;}
      return result;
    });
    t.mock.method(prototype, 'readFile', async function(...args) {
      const bytes = await realReadFile.apply(this, args);
      if (this === growingHandle) {consumed += bytes.length;}
      return bytes;
    });
    await assert.rejects(name === 'input' ? readPreviewFile(target, maximum) : reopenPreview(output), /byte bound|changed while/);
    assert.equal(injections, 1);
    assert.equal((await lstat(target)).size, maximum + 4096);
    assert.equal(consumed, maximum + 1, 'real descriptor bytes consumed before overflow rejection');
  });
}

// Failure caught: replacing the directory during a real descriptor write could publish completion into, or delete, the foreign object.
test('directory substitution fails closed and preserves foreign identity and sentinel', async t => {
  const root = await temporary(t), output = join(root, 'preview'), moved = join(root, 'owned-moved');
  const prepared = await artifacts(), probe = await open(root, 'r'), prototype = Object.getPrototypeOf(probe), realWrite = prototype.writeFile;
  await probe.close();
  let writes = 0, foreign;
  t.mock.method(prototype, 'writeFile', async function(data, options) {
    await realWrite.call(this, data, options); writes++;
    const held = await this.stat(), named = await lstat(join(output, 'plan.json'));
    assert.deepEqual([held.dev, held.ino], [named.dev, named.ino]);
    await rename(output, moved); await mkdir(output); await writeFile(join(output, 'sentinel'), 'foreign');
    foreign = await lstat(output);
  });
  await assert.rejects(publishPreview(prepared, output), /substituted/);
  assert.equal(writes, 1);
  const remaining = await lstat(output); assert.deepEqual([remaining.dev, remaining.ino], [foreign.dev, foreign.ino]);
  assert.equal(await readFile(join(output, 'sentinel'), 'utf8'), 'foreign');
  assert.deepEqual(await readdir(output), ['sentinel']); assert.deepEqual(await readdir(moved), ['plan.json']);
  assert.deepEqual(JSON.parse(await readFile(join(moved, 'plan.json'), 'utf8')), prepared.plan);
  for (const directory of [output, moved]) {
    await assert.rejects(lstat(join(directory, 'complete.json')), { code: 'ENOENT' });
    await assert.rejects(reopenPreview(directory), /Incomplete/);
  }
});

// Failure caught: local inputs, aliases or reopened artifacts could follow links to overwrite or trust a foreign file.
test('input/output aliases and symlink files or ancestors cannot produce successful output', async t => {
  const root = await temporary(t), source = join(root, 'input.json'); await writeFile(source, await readFile(fixturePath));
  assert.equal(invoke(['--input', source, '--output', source]).status, 1);
  assert.equal(bytesHash(await readFile(source)), bytesHash(await readFile(fixturePath)));
  await symlink(source, join(root, 'linked.json')); await assert.rejects(readPreviewFile(join(root, 'linked.json')));
  await symlink(root, join(root, 'linked-dir')); await assert.rejects(readPreviewFile(join(root, 'linked-dir/input.json')), /ancestor/);
  const output = join(root, 'preview'); await publishPreview(await artifacts(), output);
  await rm(join(output, 'facts.json')); await symlink(source, join(output, 'facts.json')); await assert.rejects(reopenPreview(output));
});

// Failure caught: stopping input validation at shape checks could persist an altered wallet/state as unsigned-ready.
test('CLI persists changed endpoints and rejected state as explicit diagnostics without effects', async t => {
  const root = await temporary(t), source = join(root, 'changed.json'), value = JSON.parse(await readFile(fixturePath));
  value.pair.evm.recipient = '0x8888888888888888888888888888888888888888'; value.quotes.reverse.recipient = value.pair.evm.recipient;
  value.states.reverse.source.state = 'frozen'; await writeFile(source, JSON.stringify(value));
  const result = invoke(['--input', source, '--output', join(root, 'diagnostic')]); assert.equal(result.status, 2, result.stderr);
  const receipt = JSON.parse(result.stdout); assert.equal(receipt.status, 'inconsistent');
  const plan = JSON.parse(await readFile(receipt.paths['plan.json']));
  assert.equal(plan.legs.reverse.recipient, value.pair.evm.recipient); assert.equal(plan.legs.reverse.hypotheticalAfter, null);
  assert.equal(plan.legs.reverse.unsignedAvailable, false); assert.match(plan.legs.reverse.conflicts.join(' '), /unfrozen/);
});

// Failure caught: transport parsing or persistence may round a changed amount above MAX_SAFE_INTEGER or bind old wallets.
test('changed CLI route preserves the last base unit through fresh-process reopen', async t => {
  const root = await temporary(t), source = join(root, 'large.json'), v = JSON.parse(await readFile(fixturePath)), n = '9007199254740993';
  v.amount = n; v.pair.evm.sender = '0x8888888888888888888888888888888888888888'; v.states.forward.sender = v.pair.evm.sender;
  v.states.forward.allowanceOwner = v.pair.evm.sender; v.states.forward.balance = '9007199254740994';
  v.pair.evm.recipient = '0x9999999999999999999999999999999999999999'; v.quotes.reverse.recipient = v.pair.evm.recipient;
  v.states.reverse.source.balance = '9007199254740994'; v.states.reverse.mint.supply = '9007199254741001';
  for (const k of Object.keys(v.limiters)) { v.limiters[k].capacity = n; v.limiters[k].rate = n; v.buckets[k].capacity = n; v.buckets[k].rate = n; v.buckets[k].tokens = n; }
  for (const k of ['forward', 'reverse']) {v.quotes[k].amount = n;}
  await writeFile(source, JSON.stringify(v)); const output = join(root, 'large-preview');
  const created = invoke(['--input', source, '--output', output]); assert.equal(created.status, 2, created.stderr);
  const reopened = invoke(['--reopen', output]); assert.equal(reopened.status, 2, reopened.stderr);
  assert.deepEqual(JSON.parse(reopened.stdout), JSON.parse(created.stdout));
  const plan = JSON.parse(await readFile(join(output, 'plan.json')));
  assert.equal(plan.route.amount, n); assert.equal(plan.legs.reverse.hypotheticalAfter.sourceBalance, '1');
  assert.equal(plan.legs.reverse.hypotheticalAfter.supply, '8'); assert.equal(plan.legs.reverse.hypotheticalAfter.poolBalance, '7');
  assert.equal(plan.legs.forward.from, v.pair.evm.sender); assert.equal(plan.legs.reverse.recipient, v.pair.evm.recipient);
  assert.equal(plan.legs.forward.admission.status, 'admitted-in-model'); assert.equal(plan.legs.reverse.admission.status, 'admitted-in-model');
  assert.equal(plan.legs.reverse.unsignedAvailable, false);
});

// Failure caught: resolving first can turn URL-shaped or oversized CLI inputs into an existing valid local artifact directory.
test('reopening requires bounded local paths before pathname normalization', async t => {
  const root = await temporary(t), parent = join(root, 'https:'); await mkdir(parent);
  const output = join(parent, 'preview'); await publishPreview(await artifacts(), output);
  const urlShapedAlias = parent + '//preview', oversizedAlias = output + '/' + './'.repeat(2200);
  assert.equal((await reopenPreview(output)).status, 'intent-only');
  for (const alias of [urlShapedAlias, oversizedAlias, '']) {
    await assert.rejects(reopenPreview(alias), /Bounded local output path required/);
  }
  assert.equal(invoke(['--reopen', urlShapedAlias]).status, 1);
  assert.equal(invoke(['--reopen', oversizedAlias]).status, 1);
  assert.deepEqual((await readdir(output)).toSorted(), ['complete.json', 'facts.json', 'plan.json', 'summary.md']);
});
