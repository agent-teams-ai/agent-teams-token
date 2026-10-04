// TEST only. Run directly with the pinned Node binary and explicit root/archives/capture/receipt.
// No skip, provisioning, client construction or production admission changes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync,
  readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
import { createRequire, registerHooks, isBuiltin } from 'node:module';
import { join, resolve, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admitDevProvider } from '../src/adapters/dev-provider-admission.mjs';
import { ROOT_HASHES } from '../src/adapters/dev-provider-policy.mjs';
import { readDevProviderArchive, payloadHash, payloadPath } from '../src/adapters/dev-provider-archive.mjs';
import { reverseInstructions } from '../src/domain/solana-reverse.mjs';
import { inspectSendData } from '../src/adapters/solana-spl-fee-cap-proof.mjs';

const [rootArg, archiveArg, captureArg, receiptArg, ...extra] = process.argv.slice(2);
if (!rootArg || !archiveArg || !captureArg || !receiptArg || extra.length) {
  throw new Error('Require explicit public provider root, retained archives, historical capture and ignored .local receipt');
}
const root = resolve(rootArg), archives = resolve(archiveArg), receipt = resolve(receiptArg);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert.ok(receipt.startsWith(join(repo, '.local') + '/'), 'Evidence must remain in ignored .local');
assert.equal(process.version, 'v24.20.0'); assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
assert.equal(payloadHash(readFileSync('/proc/self/exe')), '89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7');
assert.equal(realpathSync(process.execPath), realpathSync('/proc/self/exe'));
assert.ok(!process.env.NODE_OPTIONS && !process.env.NODE_PATH && process.execArgv.length === 0);
let networkEffects = 0;
const forbiddenNetwork = () => { networkEffects++; throw new Error('Network forbidden in TEST oracle'); };
globalThis.fetch = http.request = https.request = net.Socket.prototype.connect = forbiddenNetwork;
const golden = JSON.parse(readFileSync(new URL('./fixtures/dev-svm-call-plan-goldens.json', import.meta.url)));
const sdk = 'node_modules/@chainlink/ccip-sdk/', anchor = 'node_modules/@coral-xyz/anchor/';
const entries = [sdk + 'dist/solana/index.js', anchor + 'dist/cjs/coder/borsh/instruction.js',
  golden.oracle.routerIdlPath, 'node_modules/bn.js/lib/bn.js', 'node_modules/@solana/web3.js/lib/index.cjs.js'];
// Literal package placements from inspection of these entries' retained source imports.
// SolanaChain imports Anchor/SPL and fetch.js -> axios: their eager dependencies are required
// even though this test calls only the static extraArgs encoder. No SDK root/all-chains entry.
const packages = [
  '@adraffy/ens-normalize', '@chainlink/ccip-sdk', '@coral-xyz/anchor',
  '@coral-xyz/anchor/node_modules/@noble/hashes', '@coral-xyz/anchor/node_modules/base-x',
  '@coral-xyz/anchor/node_modules/bs58', '@coral-xyz/anchor/node_modules/eventemitter3', '@coral-xyz/borsh',
  '@noble/curves', '@noble/curves/node_modules/@noble/hashes', '@solana/buffer-layout', '@solana/buffer-layout-utils',
  '@solana/codecs', '@solana/codecs-core', '@solana/codecs-data-structures', '@solana/codecs-numbers',
  '@solana/codecs-strings', '@solana/errors', '@solana/options', '@solana/spl-token',
  '@solana/spl-token-group', '@solana/spl-token-metadata', '@solana/web3.js',
  '@solana/web3.js/node_modules/@noble/hashes', '@solana/web3.js/node_modules/@solana/codecs-core',
  '@solana/web3.js/node_modules/@solana/codecs-numbers', '@solana/web3.js/node_modules/@solana/errors',
  '@solana/web3.js/node_modules/base-x', '@solana/web3.js/node_modules/borsh', '@solana/web3.js/node_modules/bs58',
  '@solana/web3.js/node_modules/superstruct', 'abitype', 'aes-js', 'agent-base', 'asynckit', 'axios', 'base-x',
  'bigint-buffer', 'bignumber.js', 'bindings', 'bn.js', 'borsh', 'bs58', 'buffer-layout',
  'call-bind-apply-helpers', 'camelcase', 'combined-stream', 'cross-fetch', 'debug', 'delayed-stream',
  'dot-case', 'dunder-proto', 'es-define-property', 'es-errors', 'es-object-atoms', 'es-set-tostringtag',
  'ethers', 'ethers/node_modules/@noble/curves', 'ethers/node_modules/@noble/hashes', 'eventemitter3',
  'fast-equals', 'fast-stringify', 'file-uri-to-path', 'follow-redirects', 'form-data', 'function-bind',
  'get-intrinsic', 'get-proto', 'gopd', 'has-symbols', 'has-tostringtag', 'hasown', 'https-proxy-agent',
  'jayson', 'lower-case', 'math-intrinsics', 'micro-memoize', 'mime-db', 'mime-types', 'ms', 'no-case',
  'node-fetch', 'pako', 'proxy-from-env', 'rpc-websockets', 'rpc-websockets/node_modules/uuid',
  'safe-buffer', 'snake-case', 'superstruct', 'text-encoding-utf-8', 'toml', 'tr46', 'tslib', 'uuid',
  'webidl-conversions', 'whatwg-url', 'ws', 'yaml',
].map(name => 'node_modules/' + name);
// These three locked archives have formats outside the production reader. Exact
// immutable member tables avoid widening it or adding a general tar reader.
const fixedMembers = {
  'node_modules/combined-stream': { archive: 'b6be5aabe53e90635beb77cd0e0ba7ae6a25c8cf903b15fcc342353e732e1512', size: 16896, rows: [
    [0,"package/package.json",640,388,48], [1536,"package/License",1085,388,48],
    [3584,"package/Readme.md",4551,388,48], [8704,"package/yarn.lock",551,388,48],
    [10240,"package/lib/combined_stream.js",4687,420,48],
  ] },
  'node_modules/proxy-from-env': { archive: 'e9c52dbf1e382319d5da00b8d964805859b7eb1424450e049d12743d7e19fc9a', size: 20992, rows: [
    [0,"package/LICENSE",1087,416,48], [2048,"package/index.cjs",3195,420,48],
    [6144,"package/index.js",3160,420,48], [10240,"package/package.json",1263,420,48],
    [12288,"package/README.md",6938,416,48],
  ] },
  'node_modules/superstruct': { archive: '0113644dd4429d6e3b61d9ccdf1f490e2728ceb4a248bb6ef034b84c2506782d', size: 534016, rows: [
    [0,"package",0,493,53], [512,"package/Changelog.md",21480,420,48],
    [22528,"package/License.md",1111,420,48], [24576,"package/Readme.md",9487,420,48],
    [34816,"package/lib",0,493,53], [35328,"package/package.json",3335,420,48],
    [39424,"package/umd",0,493,53], [39936,"package/lib/coercions.d.ts",756,420,48],
    [41472,"package/lib/coercions.d.ts.map",688,420,48], [43008,"package/lib/error.d.ts",998,420,48],
    [44544,"package/lib/error.d.ts.map",753,420,48], [46080,"package/lib/index.cjs",28832,420,48],
    [75776,"package/lib/index.cjs.d.ts",21017,420,48], [97792,"package/lib/index.cjs.map",75417,420,48],
    [174080,"package/lib/index.d.cts",20941,420,48], [195584,"package/lib/index.d.ts",232,420,48],
    [196608,"package/lib/index.d.ts.map",236,420,48], [197632,"package/lib/index.es.d.ts",21017,420,48],
    [219648,"package/lib/index.es.js",27904,420,48], [248320,"package/lib/index.es.js.map",75365,420,48],
    [324608,"package/lib/refinements.d.ts",817,420,48], [326144,"package/lib/refinements.d.ts.map",765,420,48],
    [327680,"package/lib/struct.d.ts",4045,420,48], [332288,"package/lib/struct.d.ts.map",2983,420,48],
    [335872,"package/lib/structs",0,493,53], [336384,"package/lib/types.d.ts",12801,420,48],
    [350208,"package/lib/types.d.ts.map",21824,420,48], [372736,"package/lib/typings.d.ts",1318,420,48],
    [374784,"package/lib/typings.d.ts.map",1016,420,48], [376320,"package/lib/utilities.d.ts",3216,420,48],
    [380416,"package/lib/utilities.d.ts.map",2476,420,48], [383488,"package/lib/utils.d.ts",5781,420,48],
    [390144,"package/lib/utils.d.ts.map",5810,420,48], [396800,"package/lib/xtras.d.ts",1899,420,48],
    [399360,"package/lib/xtras.d.ts.map",1107,420,48], [401408,"package/umd/coercions.d.ts",735,420,48],
    [402944,"package/umd/index.d.ts",115,420,48], [403968,"package/umd/refinements.d.ts",631,420,48],
    [405504,"package/umd/struct.d.ts",3042,420,48], [409088,"package/umd/superstruct.d.ts",21017,420,48],
    [431104,"package/umd/superstruct.js",31290,420,48], [463360,"package/umd/superstruct.min.d.ts",21017,420,48],
    [485376,"package/umd/superstruct.min.js",10537,420,48], [496640,"package/umd/types.d.ts",5328,420,48],
    [502784,"package/umd/utils.d.ts",403,420,48], [503808,"package/lib/structs/coercions.d.ts",1278,420,48],
    [505856,"package/lib/structs/coercions.d.ts.map",753,420,48], [507392,"package/lib/structs/refinements.d.ts",1828,420,48],
    [509952,"package/lib/structs/refinements.d.ts.map",1771,420,48], [512512,"package/lib/structs/types.d.ts",5515,420,48],
    [518656,"package/lib/structs/types.d.ts.map",4105,420,48], [523776,"package/lib/structs/utilities.d.ts",3982,420,48],
    [528384,"package/lib/structs/utilities.d.ts.map",3688,420,48],
  ] },
};
const evidence = { classification: 'TEST-only', qualification: 'UNQUALIFIED', rootHashes: ROOT_HASHES,
  selectedEntries: entries, packages: [], admissionFailures: [], admittedSources: {}, loadedSources: {},
  resolutionEdges: [], tests: { passed: 0, failed: 0, skipped: 0 }, testResults: [], officialVectorsExecuted: 0,
  limits: ['Selected legacy/changed receiver and amount wire vectors only; no CCIP execution or production acceptance.',
    'Quiescent reviewed installation and trusted pinned runtime; no same-UID writer or privileged adversary proof.',
    'Production archive reader is unchanged; three locked tarballs use exact TEST-only member tables, with no generic format fallback.'] };
const admitted = new Map();
function bytes(path, mode) {
  const s = lstatSync(path);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= 32 * 1024 * 1024, path);
  assert.equal(s.uid, process.getuid(), path);
  if (mode !== undefined) { assert.equal(s.mode & 0o7777, mode, path); }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = fstatSync(fd);
    assert.equal(held.dev, s.dev); assert.equal(held.ino, s.ino); assert.equal(held.size, s.size);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function directory(path) {
  const s = lstatSync(path);
  assert.ok(s.isDirectory() && !s.isSymbolicLink()); assert.equal(realpathSync(path), path);
  assert.equal(s.uid, process.getuid()); assert.equal(s.mode & 0o7777, 0o700);
}
// Private fixed-oracle comparator: same exact inventory/mode/link/byte and locked nested
// package boundary semantics as DEV admission. No wildcard node_modules exclusion.
function compare(path, payload, placements) {
  const expected = new Map(payload), nested = placements.filter(p => p.startsWith(path + '/node_modules/'));
  for (const p of nested) {
    const local = p.slice(path.length + 1); expected.set(local, { type: 'package', mode: 0o700 });
    let parent = posix.dirname(local);
    while (parent !== '.') {
      if (!expected.has(parent)) { expected.set(parent, { type: 'directory', mode: 0o700 }); }
      parent = posix.dirname(parent);
    }
  }
  const seen = new Set();
  function walk(full, prefix = '', depth = 0) {
    assert.ok(depth <= 20); directory(full);
    for (const name of readdirSync(full)) {
      const local = payloadPath(prefix ? prefix + '/' + name : name), wanted = expected.get(local);
      assert.ok(wanted, 'Injected oracle entry: ' + path + '/' + local); seen.add(local);
      const target = join(full, name), s = lstatSync(target);
      assert.ok(!s.isSymbolicLink()); assert.equal(s.mode & 0o7777, wanted.mode);
      if (wanted.type === 'file') {
        assert.equal(payloadHash(bytes(target, wanted.mode)), wanted.sha256, 'Changed oracle entry: ' + target);
      } else {
        directory(target);
        if (wanted.type === 'directory') { walk(target, local, depth + 1); }
      }
    }
  }
  walk(join(root, path));
  for (const local of expected.keys()) {
    assert.ok(seen.has(local) || nested.some(p => (path + '/' + local).startsWith(p + '/')), 'Missing oracle entry: ' + local);
  }
}
function oraclePayload(path, archive, integrity) {
  const table = fixedMembers[path];
  if (!table) { return readDevProviderArchive(archive, integrity); }
  assert.equal('sha512-' + createHash('sha512').update(archive).digest('base64'), integrity, 'Retained lock integrity');
  assert.ok(archive.length <= 32 * 1024 * 1024);
  const tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 });
  assert.equal(tar.length, table.size);
  const payload = new Map(); let cursor = 0;
  for (const [offset, name, size, mode, type] of table.rows) {
    assert.equal(offset, cursor); const h = tar.subarray(offset, offset + 512);
    const field = (a, b) => h.subarray(a, b).toString('ascii').split('\0')[0];
    assert.equal((field(345, 500) ? field(345, 500) + '/' : '') + field(0, 100), name);
    assert.equal(h.subarray(257, 265).toString('hex'), '7573746172003030'); assert.equal(field(157, 257), '');
    assert.equal(parseInt(field(100, 108), 8), mode); assert.equal(parseInt(field(124, 136), 8), size); assert.equal(h[156], type);
    assert.equal([...h].reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0), parseInt(field(148, 156), 8));
    cursor = offset + 512 + Math.ceil(size / 512) * 512;
    assert.ok(tar.subarray(offset + 512 + size, cursor).every(b => b === 0));
    if (name === 'package') { assert.equal(type, 53); assert.equal(size, 0); continue; }
    const local = payloadPath(name.slice(8)); assert.ok(name.startsWith('package/') && !payload.has(local));
    if (type === 53) { assert.equal(size, 0); payload.set(local, { type: 'directory', mode: 0o700 }); }
    else {
      assert.equal(type, 48); const data = tar.subarray(offset + 512, offset + 512 + size);
      payload.set(local, { type: 'file', mode: mode & 0o700, bytes: data, sha256: payloadHash(data) });
    }
  }
  assert.ok(tar.length - cursor >= 1024 && tar.subarray(cursor).every(b => b === 0));
  for (const [local, entry] of payload) {
    if (entry.type !== 'file') { continue; }
    for (let parent = posix.dirname(local); parent !== '.'; parent = posix.dirname(parent)) {
      if (!payload.has(parent)) { payload.set(parent, { type: 'directory', mode: 0o700 }); }
      assert.equal(payload.get(parent).type, 'directory');
    }
  }
  return payload;
}
async function admitOracle() {
  // Reuse the existing non-evaluating root/lock, all 202 placements and optional-branch gate.
  evidence.devProvider = await admitDevProvider({ root, archives });
  assert.equal(evidence.devProvider.evaluated, false);
  const lock = JSON.parse(bytes(join(root, 'package-lock.json'), 0o600));
  const placements = Object.keys(lock.packages).filter(p => p && !lock.packages[p].optional && !lock.packages[p].extraneous);
  const index = new Map(); // Archive root physical identity was checked by admitDevProvider.
  const names = readdirSync(archives);
  assert.equal(names.length, 198, 'Require the retained immutable archive inventory');
  for (const name of names) {
    assert.match(name, /^[a-f0-9]{64}\.tgz$/);
    const data = bytes(join(archives, name)); assert.equal(payloadHash(data) + '.tgz', name);
    index.set('sha512-' + createHash('sha512').update(data).digest('base64'), { name, data });
  }
  for (const path of packages) {
    const record = lock.packages[path], retained = index.get(record?.integrity);
    try {
      assert.ok(record && !record.optional && !record.link && retained, 'Missing locked retained oracle payload: ' + path);
      const payload = oraclePayload(path, retained.data, record.integrity);
      if (path === 'node_modules/jayson') {
        const original = payload.get('.gitignore');
        assert.equal(original?.sha256, 'b2d141921f6d7fbfa6a5e0b0145fae2992c27343b7fb2f58e9ac4521fcb5f48b');
        assert.ok(!payload.has('.npmignore')); payload.delete('.gitignore'); payload.set('.npmignore', original);
      }
      compare(path, payload, placements);
      for (const [local, entry] of payload) {
        if (entry.type === 'file') { admitted.set(join(root, path, local), entry); }
      }
      evidence.packages.push({ path, version: record.version, integrity: record.integrity,
        reader: fixedMembers[path] ? 'exact-TEST-member-table' : 'readDevProviderArchive',
        archiveSha256: payloadHash(retained.data), entries: payload.size });
    } catch (error) {
      evidence.admissionFailures.push({ path, version: record?.version, integrity: record?.integrity,
        archive: retained?.name, reason: error.message });
    }
  }
  for (const [path, entry] of admitted) { evidence.admittedSources[path.slice(root.length + 1)] = entry.sha256; }
  assert.equal(evidence.admissionFailures.length, 0,
    'Missing prerequisite: reviewed archive-payload admission for required oracle dependencies: ' + JSON.stringify(evidence.admissionFailures));
  assert.equal(JSON.parse(admitted.get(join(root, anchor, 'package.json')).bytes).version, '0.29.0');
  assert.equal(JSON.parse(admitted.get(join(root, sdk, 'package.json')).bytes).version, '1.13.0');
  assert.equal(admitted.get(join(root, golden.oracle.routerIdlPath))?.sha256, golden.oracle.routerIdlSha256);
  const req = createRequire(join(root, 'package.json'));
  for (const [specifier, expected] of [['@chainlink/ccip-sdk/dist/solana/index.js', entries[0]],
    ['@coral-xyz/anchor/dist/cjs/coder/borsh/instruction.js', entries[1]], ['bn.js', entries[3]], ['@solana/web3.js', entries[4]]]) {
    assert.equal(req.resolve(specifier), join(root, expected));
  }
  for (const entry of entries) { assert.ok(admitted.has(join(root, entry))); }
  assert.ok(!Object.keys(req.cache).some(path => path.startsWith(root + '/')), 'Fresh isolated process required');
  return req;
}
// Actual Node resolution remains authoritative. Every resolved file must be an exact
// pre-admitted archive member; source is held archive bytes, never an install receipt.
function guard(url) {
  if (url.startsWith('node:') && isBuiltin(url)) { return; }
  assert.ok(url.startsWith('file:') && !new URL(url).search && !new URL(url).hash, 'Unadmitted oracle URL: ' + url);
  const path = fileURLToPath(url), entry = admitted.get(path);
  assert.ok(entry && !path.endsWith('.node'), 'Unadmitted oracle module: ' + path);
  return entry;
}
const legacy = Buffer.from(golden.oracle.historicalSendHex, 'hex'), changed = Buffer.from(golden.oracle.changedSendHex, 'hex');
const receiver = route => Buffer.from(route.recipient.slice(2).padStart(64, '0'), 'hex');
const changedRoute = { ...golden.route, recipient: golden.oracle.changedRecipient, amount: golden.oracle.changedAmount };
const decode = (data, route) => inspectSendData(null, data, route.mint, '11111111111111111111111111111111',
  { amount: BigInt(route.amount), selector: route.selector, nativeExpected: { receiver: receiver(route) } });
async function checked(name, fn) {
  await test(name, async () => {
    try { await fn(); evidence.tests.passed++; evidence.testResults.push({ name, status: 'passed' }); }
    catch (error) { evidence.tests.failed++; evidence.testResults.push({ name, status: 'failed', reason: error.message }); throw error; }
  });
}
await checked('external capture digest and independently recorded changed-route literal offsets', () => {
  assert.equal(payloadHash(bytes(resolve(captureArg))), golden.source.sha256);
  assert.deepEqual(golden.oracle.changedOffsets, { receiver: [20, 52], amount: [92, 100] });
  assert.equal(legacy.length, 162); assert.equal(changed.length, 162);
  assert.equal(changed.subarray(20, 52).toString('hex'), '0000000000000000000000007777777777777777777777777777777777777777');
  assert.equal(changed.subarray(92, 100).toString('hex'), '0100000000002000');
  assert.equal(changed.readBigUInt64LE(92), 9007199254740993n);
  for (let i = 0; i < legacy.length; i++) {
    if (!(i >= 20 && i < 52 || i >= 92 && i < 100)) { assert.equal(changed[i], legacy[i], 'Unrecorded wire change at ' + i); }
  }
});
await checked('independent fixed decoder accepts both retained vectors without rounding amounts', () => {
  assert.equal(decode(legacy, golden.route).tokenAmounts[0].amount, 1000000000n);
  const result = decode(changed, changedRoute);
  assert.equal(result.tokenAmounts[0].amount, 9007199254740993n); assert.deepEqual(result.receiver, receiver(changedRoute));
});
await checked('independent decoder rejects changed receiver and rounded changed amount intent', () => {
  assert.throws(() => decode(changed, { ...changedRoute, amount: '9007199254740992' }), /mismatch/);
  assert.throws(() => decode(changed, { ...changedRoute, recipient: golden.route.recipient }), /receiver/);
  assert.throws(() => decode(legacy, changedRoute), /mismatch|receiver/);
});
await checked('independent decoder rejects truncation, trailing bytes, receiver padding and extraArgs changes', () => {
  for (const length of [0, 15, 19, 51, 91, 99, 135, 140, 156, 161]) { assert.throws(() => decode(changed.subarray(0, length), changedRoute)); }
  assert.throws(() => decode(Buffer.concat([changed, Buffer.from([0])]), changedRoute));
  for (const offset of [0, 8, 20, 60, 92, 100, 136, 140, 156, 161]) {
    const mutant = Buffer.from(changed); mutant[offset] ^= 1;
    assert.throws(() => decode(mutant, changedRoute), 'Wire mutant at ' + offset);
  }
});
await checked('loader refuses an unadmitted entry before evaluating any candidate source', () => {
  assert.throws(() => guard(pathToFileURL(join(root, 'node_modules/unadmitted/index.js')).href), /Unadmitted/);
  assert.throws(() => guard('data:text/javascript,throw%20new%20Error()'), /Unadmitted/);
  assert.equal(Object.keys(evidence.loadedSources).length, 0);
});
await checked('fixed TEST member tables reject changed tarballs against independently pinned lock integrity', () => {
  const raw = bytes(join(root, 'package-lock.json'), 0o600); assert.equal(payloadHash(raw), ROOT_HASHES['package-lock.json']);
  const locked = JSON.parse(raw).packages;
  for (const [path, table] of Object.entries(fixedMembers)) {
    const bad = Buffer.from(bytes(join(archives, table.archive + '.tgz'))); bad[0] ^= 1;
    assert.throws(() => oraclePayload(path, bad, locked[path].integrity), /Retained lock integrity/);
  }
});
await checked('actual pinned Anchor Router coder and SDK SolanaChain extraArgs match legacy and changed route', async () => {
  const req = await admitOracle(); // Entire selected package payload closure, BEFORE the first import.
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context); guard(result.url);
      evidence.resolutionEdges.push([context.parentURL ?? null, specifier, result.url]); return result;
    },
    load(url, context, next) {
      const entry = guard(url), result = next(url, context);
      if (!entry) { return result; }
      evidence.loadedSources[fileURLToPath(url).slice(root.length + 1)] = entry.sha256;
      return { ...result, source: entry.bytes };
    },
  });
  try {
    const { BorshInstructionCoder } = req(join(root, entries[1])), anchorEncode = Reflect.get(BorshInstructionCoder.prototype, '_encode');
    const { PublicKey } = req('@solana/web3.js'), BN = req('bn.js');
    const { IDL } = await import(pathToFileURL(join(root, entries[2])).href);
    const coder = new BorshInstructionCoder(IDL);
    Object.defineProperty(coder, '_encode', { value: anchorEncode }); // Isolate original Anchor from SDK prototype patches.
    const { SolanaChain } = await import(pathToFileURL(join(root, entries[0])).href);
    const base58 = req('bs58'), capture = JSON.parse(bytes(resolve(captureArg))).result;
    assert.deepEqual(Buffer.from((base58.default ?? base58).decode(capture.transaction.message.instructions[golden.source.instructionIndex].data)), legacy);
    assert.equal(Reflect.get(coder, '_encode'), anchorEncode); const extraArgs = Buffer.from(SolanaChain.encodeExtraArgs({ gasLimit: 0n, allowOutOfOrderExecution: true }).slice(2), 'hex');
    assert.equal(extraArgs.toString('hex'), '181dcf100000000000000000000000000000000001');
    for (const [route, expected] of [[golden.route, legacy], [changedRoute, changed]]) {
      const official = coder.encode('ccipSend', { destChainSelector: new BN(route.selector), message: {
        receiver: receiver(route), data: Buffer.alloc(0), tokenAmounts: [{ token: new PublicKey(route.mint), amount: new BN(route.amount) }],
        feeToken: new PublicKey('11111111111111111111111111111111'), extraArgs }, tokenIndexes: Buffer.from([0]) });
      assert.deepEqual(official, expected); decode(official, route);
      const inputs = { ...route.identities, alt: route.alt, payer: route.payer, mint: route.mint,
        testOnly: true, cluster: 'solana-devnet', approval: true, quotedFee: '5', sourceLamports: '1000000' };
      assert.deepEqual(Buffer.from(reverseInstructions(inputs, route).at(-1).dataBase64, 'base64'), expected);
      evidence.officialVectorsExecuted++;
    }
    assert.equal(networkEffects, 0); evidence.qualification = 'SELECTED-WIRE-COMPATIBILITY';
  } finally { hooks.deregister(); }
});
evidence.networkEffects = networkEffects;
writeFileSync(receipt, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
