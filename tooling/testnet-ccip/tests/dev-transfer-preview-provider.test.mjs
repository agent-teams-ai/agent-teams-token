import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, mkdtemp, rm, chmod, symlink, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { admitPreviewProviders } from '../src/adapters/dev-transfer-preview-provider.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
// Independent minimal ustar writer for TEST immutable payload authority, not the verifier under test.
function archive(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content), h = Buffer.alloc(512); h.write('package/' + name);
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.fill(32, 148, 156); h[156] = 48; h.write('ustar\0', 257); h.write('00', 263);
    const sum = [...h].reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
// Failure caught: provider admission tests must work without a prepared .local and must not inherit symlinked temp ancestors.
async function miniClosure(t, forbiddenRuntime = null) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pr1-provider-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'EVALUATED'), source = 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "side effect");';
  const payloads = new Map(), lock = { lockfileVersion: 3, packages: {} };
  const dependencies = { 'codec-support': '1.0.0' };
  if (forbiddenRuntime) {dependencies[forbiddenRuntime] = forbiddenRuntime === '@chainlink/ccip-sdk' ? '1.13.0' : '0.30.1';}
  const packages = [['@chainlink/ccip-sdk', '1.13.0', {}], ['ethers', '6.17.0', dependencies], ['@solana/web3.js', '1.98.4', {}], ['codec-support', '1.0.0', {}]];
  if (forbiddenRuntime === '@coral-xyz/anchor') {packages.push(['@coral-xyz/anchor', '0.30.1', {}]);}
  for (const [name, version, deps] of packages) {
    const rel = 'node_modules/' + name, directory = join(root, rel); await mkdir(directory, { recursive: true, mode: 0o755 }); await chmod(directory, 0o755);
    const main = name === 'ethers' ? 'lib/index.js' : 'index.js';
    const files = { 'package.json': JSON.stringify({ name, version, main, dependencies: deps }), [main]: source, 'idl.json': '{"synthetic":true}' };
    if (name === 'ethers') {files['lib/package.json'] = '{"type":"commonjs"}';}
    for (const [file, content] of Object.entries(files)) {
      if (file.startsWith('lib/')) {await mkdir(join(directory, 'lib'), { recursive: true, mode: 0o755 }); await chmod(join(directory, 'lib'), 0o755);}
      await writeFile(join(directory, file), content, { mode: 0o644 }); await chmod(join(directory, file), 0o644);
    }
    const bytes = archive(files); payloads.set(rel, bytes); lock.packages[rel] = { version, integrity: integrity(bytes), dependencies: deps };
  }
  const manifest = '{"private":true,"dependencies":{"@chainlink/ccip-sdk":"1.13.0"}}', lockBytes = JSON.stringify(lock);
  await writeFile(join(root, 'package.json'), manifest); await writeFile(join(root, 'package-lock.json'), lockBytes);
  const pins = { providerManifestSha256: hash(manifest), providerLockSha256: hash(lockBytes), ethersVersion: '6.17.0' };
  return { root, marker, payloads, pins, tarballSource: async rel => payloads.get(rel) };
}

// Failure caught: evaluating before payload comparison runs malicious code; treating module-format metadata as an npm root rejects the real resolver layout.
test('synthetic closure is admitted from independent lock-integrity archives without any evaluation', async t => {
  const mini = await miniClosure(t), result = await admitPreviewProviders(mini);
  assert.equal(result.entries.ethers, join(mini.root, 'node_modules/ethers/lib/index.js'));
  assert.equal(result.evaluated, false); assert.equal(result.qualification, 'payload-admission-only');
  assert.deepEqual(Object.keys(result.packages).toSorted(), ['node_modules/@solana/web3.js', 'node_modules/codec-support', 'node_modules/ethers']);
  await assert.rejects(lstat(mini.marker), { code: 'ENOENT' });
});

// Failure caught: unchanged root hashes can hide changed code/IDL, an injected file, altered mode or symlink, or a missing payload.
for (const mutation of ['code', 'idl', 'sdk-idl', 'sdk-metadata', 'transitive', 'missing', 'injected', 'mode', 'symlink', 'archive', 'unavailable']) {
  test('synthetic provider payload rejects ' + mutation + ' before evaluation', async t => {
    const mini = await miniClosure(t), directory = join(mini.root, 'node_modules/ethers');
    if (mutation === 'code') {await writeFile(join(directory, 'lib/index.js'), 'throw new Error("substituted")');}
    if (mutation === 'idl') {await writeFile(join(directory, 'idl.json'), '{"synthetic":false}');}
    if (mutation === 'sdk-idl') { await writeFile(join(mini.root, 'node_modules/@chainlink/ccip-sdk/idl.json'), 'changed'); }
    if (mutation === 'sdk-metadata') { await writeFile(join(mini.root, 'node_modules/@chainlink/ccip-sdk/package.json'), '{}'); }
    if (mutation === 'transitive') {await writeFile(join(mini.root, 'node_modules/codec-support/index.js'), 'changed');}
    if (mutation === 'missing') {await rm(join(directory, 'idl.json'));}
    if (mutation === 'injected') {await writeFile(join(directory, 'injected.js'), 'changed');}
    if (mutation === 'mode') {await chmod(join(directory, 'lib/index.js'), 0o755);}
    if (mutation === 'symlink') { await rm(join(directory, 'lib/index.js')); await symlink('../idl.json', join(directory, 'lib/index.js')); }
    if (mutation === 'archive') {mini.payloads.set('node_modules/ethers', Buffer.from('not pinned'));}
    if (mutation === 'unavailable') {mini.payloads.delete('node_modules/ethers');}
    await assert.rejects(admitPreviewProviders(mini), /Provider payload prerequisite/);
    await assert.rejects(lstat(mini.marker), { code: 'ENOENT' });
  });
}

// Failure caught: masking special permission bits could admit modes forbidden by the integrity-bound tar payload.
for (const [path, mode, reason] of [
  ['lib/index.js', 0o4644, /changed installed package entry: lib\/index.js/],
  ['lib', 0o2755, /changed installed package entry: lib/],
  ['', 0o1755, /changed package directory mode/],
]) {
  test('synthetic provider rejects special permissions on ' + (path || 'package root') + ' before evaluation', async t => {
    const mini = await miniClosure(t), target = join(mini.root, 'node_modules/ethers', path);
    assert.equal((await admitPreviewProviders(mini)).evaluated, false);
    await chmod(target, mode);
    assert.equal((await lstat(target)).mode & 0o7777, mode);
    await assert.rejects(admitPreviewProviders(mini), reason);
    await assert.rejects(lstat(mini.marker), { code: 'ENOENT' });
  });
}

// Failure caught: complete lock-integrity payloads must not authorize a runtime closure that reaches SDK/anchor.
for (const forbiddenRuntime of ['@chainlink/ccip-sdk', '@coral-xyz/anchor']) {
  test('synthetic authenticated closure excludes executable ' + forbiddenRuntime, async t => {
    const mini = await miniClosure(t, forbiddenRuntime);
    await assert.rejects(admitPreviewProviders(mini), /SDK\/anchor evaluation outside minimal runtime closure/);
    await assert.rejects(lstat(mini.marker), { code: 'ENOENT' });
  });
}
