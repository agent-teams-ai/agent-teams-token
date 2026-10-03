import assert from 'node:assert/strict';
import { test } from 'node:test';
import Module, { createRequire } from 'node:module';
import { mkdtemp, cp, readFile, writeFile, mkdir, rm, rename, chmod, symlink, link, rmdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { admitDevProvider, loadDevProvider } from '../src/adapters/dev-provider-admission.mjs';
import { readDevProviderArchive } from '../src/adapters/dev-provider-archive.mjs';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const prepared = join(repo, '.local/PREPARED-PROVIDER');
const retained = join(repo, '.local/CANDIDATE-AUTHORITY/archives');
const fixture = name => fileURLToPath(new URL('fixtures/dev-provider-' + name, import.meta.url));
const vectors = JSON.parse(await readFile(fixture('vectors.json'), 'utf8'));
const tarPin = JSON.parse(await readFile(fixture('safe-buffer.json'), 'utf8'));
const archive = await readFile(join(retained, tarPin.sha256 + '.tgz'));
const sha256 = b => createHash('sha256').update(b).digest('hex');
const integrity = b => 'sha512-' + createHash('sha512').update(b).digest('base64');

// Run with the raw pinned Node executable and this file as the script (node:test
// still runs every case). Node24 --test forwards default runtime options to its
// child, including addon/proxy flags, which the closed admission environment rejects.
// Required real preparation: absence is unmet acceptance, never an opt-in skip.
// All candidate mutation takes place in this exclusively owned, disposable copy.
const staging = await mkdtemp(join(tmpdir(), 'dev-provider-admission-'));
const root = join(staging, 'provider'), archives = join(staging, 'archives');
await cp(prepared, root, { recursive: true, preserveTimestamps: true });
await cp(retained, archives, { recursive: true, preserveTimestamps: true });
const options = { root, archives };
const abiEntry = join(root, 'node_modules/ethers/lib.commonjs/abi/index.js');
const web3Entry = join(root, 'node_modules/@solana/web3.js/lib/index.cjs.js');
const require = createRequire(import.meta.url);
let compilations = 0, sentinelEvaluations = 0, effects = 0;
// Transparent observation of actual Node CJS compilation, delegating to Node unchanged.
// Every selected first import is CJS, so this catches evaluation before any admission failure.
const compileKey = '_compile';
const originalCompile = Module.prototype[compileKey];
Module.prototype[compileKey] = function (content, filename, ...rest) {
  if (filename.startsWith(staging + '/') || filename.startsWith(prepared + '/')) { compilations++; }
  return originalCompile.call(this, content, filename, ...rest);
};
const effect = () => { effects++; throw new Error('offline test forbids network'); };
const originals = { http: http.request, https: https.request, connect: net.Socket.prototype.connect, fetch: globalThis.fetch };
http.request = effect; https.request = effect; net.Socket.prototype.connect = effect; globalThis.fetch = effect;
globalThis.devProviderHarmlessCounter = () => { sentinelEvaluations++; };
const sentinel = '\nglobalThis.devProviderHarmlessCounter();\n';

async function refuses(pattern, input = options) {
  const before = compilations;
  await assert.rejects(loadDevProvider(input), pattern);
  assert.equal(compilations, before, 'failed admission evaluated a real candidate module');
  assert.equal(sentinelEvaluations, 0, 'hostile package was evaluated');
  assert.equal(effects, 0, 'admission caused a network effect');
  assert.equal(Object.keys(require.cache).filter(path => path.startsWith(root + '/')).length, 0);
}
async function changedFile(path, change, run) {
  const original = await readFile(path);
  try { await writeFile(path, change(original)); await run(); }
  finally { await writeFile(path, original); }
}
async function injected(path, body, run) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try { await writeFile(join(path, 'index.js'), body, { mode: 0o600 }); await run(); }
  finally { await rm(path, { recursive: true }); }
}
function headerChecksum(tar) {
  tar.fill(32, 148, 156);
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  tar.write(checksum.toString(8).padStart(6, '0') + ' \0', 148, 'ascii');
  return tar;
}

try {
  await test('wrong manifest or lock bytes reject before any real provider compilation', async () => {
    for (const name of ['package.json', 'package-lock.json']) {
      await changedFile(join(root, name), b => Buffer.concat([b, Buffer.from('\n')]), () => refuses(/wrong root\/lock identity/));
    }
  });
  await test('caller expected pins, CLI-style options and receipt authority are rejected', async () => {
    for (const key of ['pins', 'expectedManifestSha256', 'receipt', 'tarballSource']) {
      await refuses(/caller pins\/receipts forbidden/, { ...options, [key]: {} });
    }
  });
  await test('symlinked root and non-private root permissions are refused', async () => {
    const alias = join(staging, 'provider-alias');
    try {
      await symlink(root, alias);
      await refuses(/non-physical root/, { ...options, root: alias });
    } finally { await rm(alias); }
    try { await chmod(root, 0o755); await refuses(/physical directory/); }
    finally { await chmod(root, 0o700); }
  });
  await test('unevaluated SDK resolver bytes cannot supply a changed owner context', async () => {
    const entry = join(root, 'node_modules/@chainlink/ccip-sdk/dist/index.js');
    await changedFile(entry, b => Buffer.concat([b, Buffer.from(sentinel)]), () => refuses(/package byte drift/));
  });
  await test('same-version ABI module tampering rejects with a zero harmless counter', async () => {
    await changedFile(abiEntry, b => Buffer.concat([b, Buffer.from(sentinel)]), () => refuses(/package byte drift/));
  });
  await test('web3 tampering rejects before the first ethers import', async () => {
    await changedFile(web3Entry, b => Buffer.concat([b, Buffer.from(sentinel)]), () => refuses(/package byte drift/));
  });
  await test('injected package and nested dependency shadow never evaluate', async () => {
    await injected(join(root, 'node_modules/dev-provider-injected'), sentinel, () => refuses(/package inventory/));
    await injected(join(root, 'node_modules/ethers/node_modules/tslib'), sentinel, () => refuses(/package inventory/));
  });
  await test('an injected selected-package JS file is not hidden by directory exclusions', async () => {
    const path = join(root, 'node_modules/ethers/lib.commonjs/dev-provider-extra.js');
    try { await writeFile(path, sentinel, { mode: 0o600 }); await refuses(/injected file/); }
    finally { await rm(path); }
  });
  await test('exact nested dependency placement is required', async () => {
    const path = join(root, 'node_modules/ethers/node_modules/@noble/hashes'), moved = path + '-moved';
    try { await rename(path, moved); await refuses(/ENOENT|package inventory/); }
    finally { await rename(moved, path); }
  });
  await test('external package resolution through a symlink is rejected', async () => {
    const path = join(root, 'node_modules/ethers/node_modules/@noble/hashes'), held = path + '-held';
    await rename(path, held);
    try { await symlink(join(prepared, 'node_modules/ethers/node_modules/@noble/hashes'), path); await refuses(/physical directory|package inventory/); }
    finally { await rm(path); await rename(held, path); }
  });
  await test('outside-root encoding and native shadow packages are refused at source owners', async () => {
    const parentModules = join(staging, 'node_modules');
    for (const name of ['encoding', 'bufferutil', 'utf-8-validate']) {
      await injected(join(parentModules, name), sentinel, async () => {
        const source = name === 'encoding' ? 'node-fetch/lib/index.js' : 'jayson/node_modules/ws/lib/validation.js';
        const resolved = createRequire(join(root, 'node_modules', source)).resolve(name);
        assert.equal(resolved, join(parentModules, name, 'index.js'), 'real Node resolution did not reach the external shadow');
        await refuses(/optional\/native branch reachable/);
      });
    }
    await rmdir(parentModules);
  });
  await test('unguarded ws7 nested native injection is rejected even with ws8 flags set', async () => {
    const oldBuffer = process.env.WS_NO_BUFFER_UTIL, oldUtf8 = process.env.WS_NO_UTF_8_VALIDATE;
    process.env.WS_NO_BUFFER_UTIL = '1'; process.env.WS_NO_UTF_8_VALIDATE = '1';
    try {
      await injected(join(root, 'node_modules/jayson/node_modules/ws/node_modules/bufferutil'), sentinel, () => refuses(/unexpected installed path/));
    } finally {
      await rmdir(join(root, 'node_modules/jayson/node_modules/ws/node_modules'));
      if (oldBuffer === undefined) { delete process.env.WS_NO_BUFFER_UTIL; } else { process.env.WS_NO_BUFFER_UTIL = oldBuffer; }
      if (oldUtf8 === undefined) { delete process.env.WS_NO_UTF_8_VALIDATE; } else { process.env.WS_NO_UTF_8_VALIDATE = oldUtf8; }
    }
  });
  await test('an injected native file is refused without executing a native loader', async () => {
    const path = join(root, 'node_modules/ws/lib/dev-provider-injected.node');
    try { await writeFile(path, Buffer.alloc(32), { mode: 0o600 }); await refuses(/injected file/); }
    finally { await rm(path); }
  });
  await test('reviewed npm gitignore rename and private executable mode stay exact', async () => {
    const normalized = join(root, 'node_modules/jayson/.npmignore');
    await changedFile(normalized, b => Buffer.concat([b, Buffer.from('injected')]), () => refuses(/package byte drift/));
    const path = join(root, 'node_modules/jayson/bin/jayson.js');
    try { await chmod(path, 0o600); await refuses(/mode\/link drift/); }
    finally { await chmod(path, 0o700); }
  });
  await test('mode and directory drift reject private-install substitution', async () => {
    try { await chmod(abiEntry, 0o644); await refuses(/mode\/link drift/); }
    finally { await chmod(abiEntry, 0o600); }
    const path = join(root, 'node_modules/ethers/lib.commonjs/abi');
    try { await chmod(path, 0o755); await refuses(/mode\/link drift/); }
    finally { await chmod(path, 0o700); }
  });
  await test('regular file substituted by directory, symlink or hardlink is refused', async () => {
    const held = join(staging, 'held-module');
    await rename(abiEntry, held);
    try {
      await mkdir(abiEntry, { mode: 0o700 }); await refuses(/type\/mode\/link/); await rm(abiEntry, { recursive: true });
      await symlink(held, abiEntry); await refuses(/type\/mode\/link/); await rm(abiEntry);
      await link(held, abiEntry); await refuses(/file type\/mode\/link/); await rm(abiEntry);
    } finally { await rename(held, abiEntry); }
  });
  await test('wrong retained archive cannot replace independently frozen byte authority', async () => {
    const path = join(archives, '17355f81284ba8431953c77af803b122baf4670cdbf84907adf7cafcd745052b.tgz');
    await changedFile(path, b => { const changed = Buffer.from(b); changed[20] ^= 1; return changed; }, () => refuses(/wrong retained archive identity/));
  });
  await test('unreviewed preloads, NODE_PATH and conditions fail before import', async () => {
    for (const name of ['NODE_OPTIONS', 'NODE_PATH']) {
      const old = process.env[name]; process.env[name] = name === 'NODE_OPTIONS' ? '--conditions=browser' : staging;
      try { await refuses(/unreviewed Node environment/); }
      finally { if (old === undefined) { delete process.env[name]; } else { process.env[name] = old; } }
    }
    process.execArgv.push('--conditions=browser');
    try { await refuses(/unreviewed Node environment/); } finally { process.execArgv.pop(); }
  });
  await test('missing prepared real provider is a failure, never skipped acceptance', async () => {
    await refuses(/ENOENT/, { ...options, root: join(staging, 'missing') });
  });

  await test('retained ustar fixture authenticates bytes independently of installed state', () => {
    assert.equal(sha256(archive), tarPin.sha256);
    assert.equal(integrity(archive), tarPin.integrity);
    const payload = readDevProviderArchive(archive, tarPin.integrity);
    assert.equal(payload.get('index.js').type, 'file');
    assert.equal(payload.get('index.js').mode, 0o600);
    assert.equal(JSON.parse(payload.get('package.json').bytes).version, '5.2.1');
  });
  async function malformed(name, change, pattern) {
    await test(name, () => {
      const raw = change(Buffer.from(gunzipSync(archive))), bad = gzipSync(raw);
      assert.throws(() => readDevProviderArchive(bad, integrity(bad)), pattern);
      assert.equal(compilations, 0);
    });
  }
  await test('archive transport tampering fails SHA512 before parsing', () => {
    const bad = Buffer.from(archive); bad[20] ^= 1;
    assert.throws(() => readDevProviderArchive(bad, tarPin.integrity), /integrity mismatch/);
  });
  await malformed('tar traversal with a valid checksum is refused', b => {
    b.fill(0, 0, 100); b.write('package/../dev-provider-escape', 0, 'ascii'); return headerChecksum(b);
  }, /unsafe path/);
  await malformed('tar checksum drift is refused', b => { b[10] ^= 1; return b; }, /checksum mismatch/);
  await malformed('truncated tar payload and missing terminators are refused', b => b.subarray(0, 1024), /truncated|termination/);
  for (const type of ['1', '2', '3', '5', 'x', 'g', 'L']) {
    await malformed('unsupported tar type ' + type + ' cannot admit links or extensions', b => {
      b[156] = type.charCodeAt(0); return headerChecksum(b);
    }, /unsupported type/);
  }
  await malformed('duplicate archive paths are refused', b => {
    const size = Number.parseInt(b.subarray(124, 136).toString('ascii'), 8);
    const end = 512 + Math.ceil(size / 512) * 512;
    return Buffer.concat([b.subarray(0, end), b]);
  }, /duplicate/);
  await malformed('bytes after termination are refused', b => { b[b.length - 1] = 1; return b; }, /termination/);
  await malformed('nonzero file padding cannot hide unauthenticated archive data', b => {
    const size = Number.parseInt(b.subarray(124, 136).toString('ascii'), 8);
    assert.notEqual(size % 512, 0);
    b[512 + size] = 1;
    return b;
  }, /nonzero padding/);
  await malformed('unsupported archive prefix cannot become package authority', b => {
    b.fill(0, 0, 100); b.write('other/index.js', 0, 'ascii'); return headerChecksum(b);
  }, /unreviewed archive prefix/);

  await malformed('missing complete two-block tar termination is refused', b => b.subarray(0, b.length - 1024), /termination/);
  await malformed('forged excessive file size cannot overrun archive bounds', b => {
    b.write((32 * 1024 * 1024 + 1).toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    return headerChecksum(b);
  }, /excessive file/);
  await test('bounded gzip rejects truncation and expansion beyond 64 MiB', () => {
    const truncated = archive.subarray(0, archive.length - 8);
    assert.throws(() => readDevProviderArchive(truncated, integrity(truncated)), /invalid or excessive gzip/);
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024 + 512));
    assert.throws(() => readDevProviderArchive(bomb, integrity(bomb)), /invalid or excessive gzip/);
    assert.equal(compilations, 0);
  });

  await test('REAL positive admission and unsigned EVM/SVM goldens on fresh offline provider', async () => {
    // Recapture hashes identify these NEW public files, not historical serialized hashes.
    for (const vector of [vectors.evm, vectors.svm]) {
      assert.equal(sha256(await readFile(join(repo, '.local/PUBLIC-RECAPTURE', vector.sourceFile))), vector.sourceSha256);
    }
    // Node caches resolution of the negative shadow fixtures even after removal.
    // Use the untouched fresh preparation, a distinct physical owner context;
    // never clear Node caches or weaken optional admission to obtain a pass.
    const realOptions = { root: prepared, archives: retained };
    const admitted = await admitDevProvider(realOptions);
    assert.equal(admitted.authority, 'agtmai-public-only-dev-provider-v1');
    assert.equal(admitted.evaluated, false); assert.equal(compilations, 0);
    const { primitives, evidence } = await loadDevProvider(realOptions);
    assert.equal(evidence.evaluated, true); assert.ok(compilations > 50);
    assert.equal(process.env.WS_NO_BUFFER_UTIL, '1'); assert.equal(process.env.WS_NO_UTF_8_VALIDATE, '1');
    assert.equal(primitives.encodeApprove(vectors.approve.spender, vectors.approve.amount), vectors.approve.data);
    assert.equal(primitives.encodeCcipSend(vectors.evm.selector, vectors.evm.message), vectors.evm.data);
    assert.equal(primitives.decodeEvmCall(vectors.evm.data).name, 'ccipSend');
    assert.equal(primitives.decodeEvmCall(vectors.evm.data).args[0].toString(), vectors.evm.selector);
    const unsigned = primitives.compileUnsignedV0(vectors.svm.input);
    assert.equal(unsigned.messageBase64, vectors.svm.messageBase64, 'actual v0 account order/header/instruction bytes drift');
    assert.equal(unsigned.transactionBase64, vectors.svm.transactionBase64, 'zero-signature envelope differs from independent wire oracle');
    assert.equal(unsigned.requiredSignatures, 1); assert.equal(unsigned.broadcastAllowed, false);
    assert.equal(Buffer.from(unsigned.transactionBase64, 'base64').subarray(1, 65).every(byte => byte === 0), true);
    assert.equal(Object.keys(require.cache).some(p => /\/(?:@chainlink\/ccip-sdk|@coral-xyz\/anchor|bigint-buffer|@solana\/spl-token)\//.test(p)), false);
    assert.equal(Object.hasOwn(primitives, 'Connection'), false); assert.equal(Object.hasOwn(primitives, 'sign'), false);
    assert.throws(() => primitives.encodeCcipSend(Number(vectors.evm.selector), vectors.evm.message), /integer must/);
    assert.throws(() => primitives.encodeApprove(vectors.approve.spender, '01'), /integer must/);
    assert.throws(() => primitives.encodeCcipSend('18446744073709551616', vectors.evm.message), /integer range/);
    assert.throws(() => primitives.compileUnsignedV0({ ...vectors.svm.input, secretKey: [] }), /invalid fields/);
    const altered = structuredClone(vectors.svm.input); altered.instructions[0].keys[1].isWritable = true;
    assert.notEqual(primitives.compileUnsignedV0(altered).messageBase64, vectors.svm.messageBase64, 'permissions must affect real message bytes');
    assert.equal(effects, 0); assert.equal(sentinelEvaluations, 0);
    console.log(JSON.stringify({ evidence, candidateCompilations: compilations, harmlessCounter: sentinelEvaluations,
      networkEffects: effects, realUnsignedGoldens: ['approve', 'historical-ccipSend-calldata', 'captured-SPL-approve-v0-zero-signature'] }));
  });
  await test('nested superstruct tampering rejects before any candidate compilation', async () => {
    // A fresh physical owner avoids both positive module caches and negative
    // optional-resolution caches; only this private, quiescent copy is mutated.
    const tamperedRoot = join(staging, 'superstruct-provider');
    await cp(prepared, tamperedRoot, { recursive: true, preserveTimestamps: true });
    const entry = join(tamperedRoot, 'node_modules/@solana/web3.js/node_modules/superstruct/dist/index.cjs');
    const original = await lstat(entry), before = compilations, counterBefore = sentinelEvaluations;
    await changedFile(entry, b => Buffer.concat([b, Buffer.from(sentinel)]), async () => {
      const changed = await lstat(entry);
      assert.equal(changed.isFile(), true);
      for (const field of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink']) {
        assert.equal(changed[field], original[field], 'sentinel mutation changed file ' + field);
      }
      try {
        await refuses(/package byte drift: node_modules\/@solana\/web3\.js\/node_modules\/superstruct\/dist\/index\.cjs/,
          { root: tamperedRoot, archives });
        assert.equal(sentinelEvaluations, counterBefore, 'nested superstruct sentinel changed');
        assert.equal(Object.keys(require.cache).filter(path => path.startsWith(tamperedRoot + '/')).length, 0);
      } finally {
        console.log(JSON.stringify({ regression: 'nested-superstruct-tampering', candidateCompilations: compilations - before,
          harmlessCounterBefore: counterBefore, harmlessCounterAfter: sentinelEvaluations, networkEffects: effects }));
      }
    });
  });
} finally {
  Module.prototype[compileKey] = originalCompile;
  http.request = originals.http; https.request = originals.https; net.Socket.prototype.connect = originals.connect; globalThis.fetch = originals.fetch;
  delete globalThis.devProviderHarmlessCounter;
  await rm(staging, { recursive: true });
}
