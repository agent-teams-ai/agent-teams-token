import { createHash } from 'node:crypto';
import { loadDevProvider } from './dev-provider-admission.mjs';
import { createDevEvmCallPlanPort } from './dev-evm-call-plan.mjs';

// The DEV addendum is separate from immutable legacy PREVIEW_PINS below.
export async function loadForwardPreviewEncoding(options) {
  const { primitives } = await loadDevProvider(options);
  return createDevEvmCallPlanPort(primitives);
}
import { gunzipSync } from 'node:zlib';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, relative, join, posix } from 'node:path';
import { readPreviewFile, hashPreviewBytes } from './dev-transfer-preview-store.mjs';
import { parsePreviewJson } from './dev-transfer-preview-input.mjs';
import { PREVIEW_PINS } from '../domain/dev-transfer-preview.mjs';

const fail = reason => { throw new Error('Provider payload prerequisite: ' + reason); };
const bound = path => { if (typeof path !== 'string' || !path || path.length > 512 || path.includes('\\') || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) {fail('unsafe payload path');} return path; };
const ascii = b => b.toString('utf8').replace(/\0.*$/s, '');
const octal = b => { const s = ascii(b).trim(); if (!/^[0-7]+$/.test(s)) { fail('unsupported tar number'); } return Number.parseInt(s, 8); };
function tarEntry(header, tar, offset) {
  if (ascii(header.subarray(257, 263)) !== 'ustar') { fail('unsupported tar format'); }
    let checksum = 0;
    for (let i = 0; i < 512; i++) {checksum += i >= 148 && i < 156 ? 32 : header[i];}
    if (checksum !== octal(header.subarray(148, 156))) {fail('tar checksum mismatch');}
    const prefix = ascii(header.subarray(345, 500)), rawName = (prefix ? prefix + '/' : '') + ascii(header.subarray(0, 100));
    if (!rawName.startsWith('package/')) {fail('non-package or excessive tar entries');}
    const name = rawName.slice(8).replace(/\/$/, ''), type = String.fromCharCode(header[156]).replace('\0', '0');
    const mode = octal(header.subarray(100, 108)), size = octal(header.subarray(124, 136));
    if (mode > 0o777 || !['0', '2', '5'].includes(type) || offset + size > tar.length) {fail('unsupported tar type/mode/size');}
    if (name) {
      bound(name);
      const entry = { type: type === '0' ? 'file' : type === '5' ? 'directory' : 'symlink', mode };
      if (entry.type === 'file') {entry.sha256 = hashPreviewBytes(tar.subarray(offset, offset + size));}
      if (entry.type === 'symlink') {
        entry.target = ascii(header.subarray(157, 257));
        if (entry.target.startsWith('/') || entry.target.includes('\\')) {fail('unsafe tar symlink');}
        bound(posix.normalize(posix.join(posix.dirname(name), entry.target)));
      }
      return { name, entry, size };
    }
    if (type !== '5' || size !== 0) { fail('invalid package root'); }
    return { name: '', entry: { type: 'directory', mode }, size };
}

/** Only npm package/ ustar payloads; unsupported archive layouts fail before evaluation. */
function npmPayload(archive, integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? '');
  if (!match || archive.length > 33554432 || createHash('sha512').update(archive).digest('base64') !== match[1]) {fail('archive integrity mismatch or unavailable');}
  const tar = gunzipSync(archive, { maxOutputLength: 67108864 }), entries = new Map();
  let offset = 0, ended = false, rootMode = 0o755;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.equals(Buffer.alloc(512))) { ended = true; break; }
    const { name, entry, size } = tarEntry(header, tar, offset);
    if (entries.size > 4096 || entries.has(name)) { fail('duplicate or excessive tar entries'); }
    if (name) { entries.set(name, entry); } else { rootMode = entry.mode; }
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || !tar.subarray(offset).equals(Buffer.alloc(tar.length - offset))) {fail('trailing or unterminated tar payload');}
  // npm commonly omits directory headers; only exact payload ancestor directories are implied.
  for (const name of entries.keys()) {
    let ancestor = posix.dirname(name);
    while (ancestor !== '.') {
      if (!entries.has(ancestor)) {entries.set(ancestor, { type: 'directory', mode: 0o755 });}
      if (entries.get(ancestor).type !== 'directory') {fail('payload ancestor is not a directory');}
      ancestor = posix.dirname(ancestor);
    }
  }
  return { entries, rootMode };
}
async function comparePackage(directory, { entries: expected, rootMode }) {
  if (((await lstat(directory)).mode & 0o7777) !== rootMode) { fail('changed package directory mode'); }
  const actual = new Map();
  const walk = async (path, prefix = '', depth = 0) => {
    if (depth > 16) {fail('installed package depth exceeds bound');}
    const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) {fail('installed package directory substituted');}
    for (const name of (await readdir(path)).toSorted()) {
      const rel = prefix ? prefix + '/' + name : name; bound(rel);
      const full = join(path, name), s = await lstat(full);
      const type = s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'unsupported';
      if (actual.size >= 4096 || !expected.has(rel)) {fail('injected installed package entry: ' + rel);}
      const entry = { type, mode: s.mode & 0o7777 };
      if (type === 'file') {entry.sha256 = hashPreviewBytes(await readPreviewFile(full, 33554432));}
      if (type === 'symlink') {entry.target = await readlink(full);}
      actual.set(rel, entry);
      if (JSON.stringify(entry) !== JSON.stringify(expected.get(rel))) {fail('changed installed package entry: ' + rel);}
      if (type === 'directory') {await walk(full, rel, depth + 1);}
    }
  };
  await walk(directory);
  if (actual.size !== expected.size) {fail('missing installed package entry');}
}
/** Resolve without evaluating SDK/anchor. Tarball source supplies already retained public bytes, never fetches. */
export async function admitPreviewProviders({ root, tarballSource, pins = PREVIEW_PINS }) {
  const providerRoot = resolve(root), manifestBytes = await readPreviewFile(join(providerRoot, 'package.json'));
  const lockBytes = await readPreviewFile(join(providerRoot, 'package-lock.json'), 1048576);
  if (hashPreviewBytes(manifestBytes) !== pins.providerManifestSha256 || hashPreviewBytes(lockBytes) !== pins.providerLockSha256) {fail('reviewed root hashes mismatch');}
  const lock = parsePreviewJson(lockBytes.toString(), 1048576);
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages) {fail('npm integrity graph missing');}
  const sdkRelative = 'node_modules/@chainlink/ccip-sdk', sdkDirectory = join(providerRoot, sdkRelative), sdkRecord = lock.packages[sdkRelative];
  if (sdkRecord?.version !== '1.13.0' || !sdkRecord.integrity) { fail('SDK resolver payload authority missing'); }
  const sdkArchive = await tarballSource(sdkRelative, sdkRecord.integrity);
  if (!Buffer.isBuffer(sdkArchive)) { fail('SDK resolver tarball unavailable'); }
  await comparePackage(sdkDirectory, npmPayload(sdkArchive, sdkRecord.integrity));
  const fromRoot = createRequire(join(providerRoot, 'package.json')), sdkEntry = fromRoot.resolve('@chainlink/ccip-sdk');
  if (!sdkEntry.startsWith(sdkDirectory + '/')) { fail('SDK resolver context mismatch'); }
  const sdkRequire = createRequire(sdkEntry), entries = { ethers: sdkRequire.resolve('ethers'), web3: sdkRequire.resolve('@solana/web3.js') };
  const admitted = new Map();
  async function visit(entry) {
    let directory = dirname(entry);
    // Package-local module-format metadata is payload, not a separately installed npm package.
    while (directory !== providerRoot) {
      const candidate = relative(providerRoot, directory).split('\\').join('/');
      if (lock.packages[candidate]) {break;}
      const parent = dirname(directory); if (parent === directory) {fail('resolved entry escaped provider root');} directory = parent;
    }
    const rel = relative(providerRoot, directory).split('\\').join('/'); bound(rel);
    if (!rel.startsWith('node_modules/') || !entry.startsWith(directory + '/')) {fail('resolved entry outside npm installation');}
    if (admitted.has(rel)) {return rel;}
    if (admitted.size >= 64) {fail('runtime closure exceeds bounded preview');}
    const record = lock.packages[rel]; if (!record?.integrity || record.link) {fail('missing lock integrity for ' + rel);}
    const archive = await tarballSource(rel, record.integrity);
    if (!Buffer.isBuffer(archive)) {fail('retained tarball unavailable for ' + rel);}
    await comparePackage(directory, npmPayload(archive, record.integrity));
    const pkg = parsePreviewJson((await readPreviewFile(join(directory, 'package.json'))).toString());
    if (pkg.version !== record.version) {fail('package version mismatch');}
    if (['@chainlink/ccip-sdk', '@coral-xyz/anchor'].includes(pkg.name)) { fail('SDK/anchor evaluation outside minimal runtime closure'); }
    admitted.set(rel, { version: pkg.version, integrity: record.integrity });
    const require = createRequire(join(directory, 'package.json'));
    for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])) {await visit(require.resolve(name));}
    return rel;
  }
  const resolved = {};
  for (const [label, entry] of Object.entries(entries)) { resolved[label] = await visit(entry); }
  if (admitted.get(resolved.ethers).version !== pins.ethersVersion) { fail('ethers version mismatch'); }
  return { entries, resolverAuthority: { package: sdkRelative, integrity: sdkRecord.integrity, evaluated: false }, packages: Object.fromEntries(admitted), evaluated: false, qualification: 'payload-admission-only' };
}
