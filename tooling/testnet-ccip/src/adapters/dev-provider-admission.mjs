import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { payloadHash, payloadPath, readDevProviderArchive } from './dev-provider-archive.mjs';
import { DEV_PROVIDER_AUTHORITY, ROOT_HASHES, SELECTED_PACKAGES, RESOLUTION_EDGES,
  OPTIONAL_BRANCHES, SOURCE_AUTHORITIES } from './dev-provider-policy.mjs';
import { unsignedDevPrimitives } from './dev-provider-primitives.mjs';

const fail = reason => { throw new Error('DEV provider admission: ' + reason); };
const modules = path => 'node_modules/' + path;
const nodeEnvironment = () => {
  if (process.version !== 'v24.20.0' || process.platform !== 'linux' || process.arch !== 'x64') {
    fail('requires pinned Linux x64 Node 24.20.0');
  }
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH ||
      process.execArgv.some(arg => !['--test', '--test-concurrency=1'].includes(arg))) {
    fail('unreviewed Node environment or conditions');
  }
};
async function physicalDirectory(path) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o7777) !== 0o700 ||
      s.uid !== process.getuid() || await realpath(path) !== path) { fail('physical directory/mode/owner: ' + path); }
}
async function bytes(path, limit = 32 * 1024 * 1024, expectedMode) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit ||
      (expectedMode !== undefined && ((before.mode & 0o7777) !== expectedMode || before.uid !== process.getuid()))) { fail('file type/mode/link: ' + path); }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size) { fail('file replaced'); }
    return await file.readFile();
  } finally { await file.close(); }
}
async function absent(path) {
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') { return; } throw error; }
  fail('unexpected installed path: ' + path);
}

// Exact installation placements come from the constant-authenticated lock, including
// declaration packages. Their bytes are not an executable closure or a code oracle.
async function inventory(root, packages) {
  const paths = Object.keys(packages).filter(path => path && !packages[path].optional && !packages[path].extraneous);
  if (paths.length !== 202) { fail('unexpected replay inventory'); }
  const directories = new Map();
  const expect = (parent, child, type) => {
    if (!directories.has(parent)) { directories.set(parent, new Map()); }
    const contents = directories.get(parent);
    if (contents.has(child) && contents.get(child) !== type) { fail('overlapping lock placements'); }
    contents.set(child, type);
  };
  for (const path of paths) {
    payloadPath(path);
    const record = packages[path];
    if (!path.startsWith('node_modules/') || record.link) { fail('unreviewed package placement'); }
    await physicalDirectory(join(root, path));
    const parent = posix.dirname(path), name = posix.basename(path);
    expect(parent, name, 'package');
    if (posix.basename(parent).startsWith('@')) {
      expect(posix.dirname(parent), posix.basename(parent), 'scope');
    }
  }
  expect('node_modules', '.package-lock.json', 'metadata');
  for (const [path, contents] of directories) {
    const directory = join(root, path);
    await physicalDirectory(directory);
    const actual = await readdir(directory);
    if (actual.length !== contents.size || actual.some(name => !contents.has(name))) { fail('injected/missing package inventory: ' + path); }
    for (const [name, type] of contents) {
      if (type === 'metadata') { await bytes(join(directory, name), 1024 * 1024, 0o600); }
      else { await physicalDirectory(join(directory, name)); }
    }
  }
  // No undeclared node_modules at ANY package root, not a wildcard directory exclusion.
  for (const path of paths) {
    const nested = path + '/node_modules';
    if (!directories.has(nested)) { await absent(join(root, nested)); }
  }
  return { paths, directories };
}

async function comparePackage(root, path, expected, placements) {
  const nestedRoots = new Set(placements.paths.filter(candidate => candidate.startsWith(path + '/node_modules/')));
  for (const candidate of nestedRoots) {
    // Add only the exact locked package boundary and its private implicit parents.
    const local = candidate.slice(path.length + 1);
    expected.set(local, { type: 'package', mode: 0o700 });
    let parent = posix.dirname(local);
    while (parent !== '.') {
      if (!expected.has(parent)) { expected.set(parent, { type: 'directory', mode: 0o700 }); }
      parent = posix.dirname(parent);
    }
  }
  const seen = new Set();
  async function walk(directory, prefix = '', depth = 0) {
    if (depth > 20) { fail('package depth exceeds bound'); }
    for (const name of await readdir(directory)) {
      const local = payloadPath(prefix ? prefix + '/' + name : name), wanted = expected.get(local);
      if (!wanted) { fail('injected file: ' + path + '/' + local); }
      const full = join(directory, name), s = await lstat(full);
      if (s.isSymbolicLink() || (s.mode & 0o7777) !== wanted.mode) { fail('package type/mode/link drift: ' + path + '/' + local); }
      seen.add(local);
      if (wanted.type === 'file') {
        if (payloadHash(await bytes(full, 32 * 1024 * 1024, wanted.mode)) !== wanted.sha256) { fail('package byte drift: ' + path + '/' + local); }
      } else {
        await physicalDirectory(full);
        if (wanted.type === 'directory') { await walk(full, local, depth + 1); }
      }
    }
  }
  await walk(join(root, path));
  // Deeper package descendants belong to their own locked package, checked in inventory.
  for (const name of expected.keys()) {
    if (!seen.has(name) && ![...nestedRoots].some(p => (path + '/' + name).startsWith(p + '/'))) {
      fail('missing file: ' + path + '/' + name);
    }
  }
  return seen.size;
}
function resolved(root, source, specifier, wanted) {
  const result = createRequire(join(root, source)).resolve(specifier);
  if (result !== join(root, wanted)) { fail('external/shadow resolution: ' + specifier + ' from ' + source); }
  return result;
}

async function admitSelectedPackages(root, archives, lock, placements) {
  let entryCount = 0;
  const sources = {};
  for (const [name, archiveHash] of SELECTED_PACKAGES) {
    const path = modules(name), record = lock.packages[path];
    const archive = await bytes(join(archives, archiveHash + '.tgz'));
    if (payloadHash(archive) !== archiveHash) { fail('wrong retained archive identity: ' + name); }
    const payload = readDevProviderArchive(archive, record.integrity);
    if (name === 'jayson') {
      const original = payload.get('.gitignore');
      if (original?.sha256 !== 'b2d141921f6d7fbfa6a5e0b0145fae2992c27343b7fb2f58e9ac4521fcb5f48b' || payload.has('.npmignore')) { fail('unreviewed npm rename'); }
      payload.delete('.gitignore'); payload.set('.npmignore', original);
    }
    for (const [source, digest] of SOURCE_AUTHORITIES) {
      if (source.startsWith(path + '/') && payload.has(source.slice(path.length + 1))) {
        if (payload.get(source.slice(path.length + 1)).sha256 !== digest) { fail('source authority drift'); }
        sources[source] = digest;
      }
    }
    entryCount += await comparePackage(root, path, payload, placements);
  }
  if (Object.keys(sources).length !== SOURCE_AUTHORITIES.length) { fail('missing ABI source authority'); }
  return { entryCount, sources };
}

async function admit(options) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).length !== 2 || !Object.hasOwn(options, 'root') || !Object.hasOwn(options, 'archives')) {
    fail('only root and archives accepted; caller pins/receipts forbidden');
  }
  nodeEnvironment();
  for (const path of [options.root, options.archives]) {
    if (typeof path !== 'string' || resolve(path) !== path || await realpath(path) !== path) { fail('non-physical root/archive path'); }
  }
  const { root, archives } = options;
  await physicalDirectory(root);
  const rootFiles = await readdir(root);
  if (rootFiles.length !== 3 || rootFiles.some(name => !['package.json', 'package-lock.json', 'node_modules'].includes(name))) { fail('injected root entry'); }
  const rootBytes = {};
  for (const [name, digest] of Object.entries(ROOT_HASHES)) {
    rootBytes[name] = await bytes(join(root, name), 1024 * 1024, 0o600);
    if (payloadHash(rootBytes[name]) !== digest) { fail('wrong root/lock identity: ' + name); }
  }
  const lock = JSON.parse(rootBytes['package-lock.json']);
  const placements = await inventory(root, lock.packages);
  const { entryCount, sources } = await admitSelectedPackages(root, archives, lock, placements);
  for (const [source, specifier, target] of RESOLUTION_EDGES) { resolved(root, source, specifier, target); }
  // Clean offline replay omitted bufferutil, both utf8 variants, and node-gyp-build.
  // ws7 and node-fetch have UNGUARDED try-requires; flags alone cannot close them.
  for (const [source, specifier] of OPTIONAL_BRANCHES) {
    try { createRequire(join(root, source)).resolve(specifier); }
    catch (error) { if (error.code === 'MODULE_NOT_FOUND') { continue; } throw error; }
    fail('optional/native branch reachable: ' + specifier + ' from ' + source);
  }
  nodeEnvironment();
  return { root, evidence: Object.freeze({ authority: DEV_PROVIDER_AUTHORITY,
    packageCount: SELECTED_PACKAGES.length, entryCount, sources: Object.freeze(sources),
    evaluated: false, qualification: 'offline-byte-admission' }) };
}

/** No candidate evaluation. Root must remain quiescent through subsequent import;
 * equivalent-privilege concurrent writers and hostile runtimes are outside this boundary.
 */
export async function admitDevProvider(options) { return (await admit(options)).evidence; }

/** Both selected package closures pass before the FIRST candidate import. */
export async function loadDevProvider(options) {
  const { root, evidence } = await admit(options);
  process.env.WS_NO_BUFFER_UTIL = '1';
  process.env.WS_NO_UTF_8_VALIDATE = '1';
  const abi = await import(pathToFileURL(join(root, modules('ethers/lib.commonjs/abi/index.js'))).href);
  const web3 = await import(pathToFileURL(join(root, modules('@solana/web3.js/lib/index.cjs.js'))).href);
  return Object.freeze({ primitives: unsignedDevPrimitives(abi, web3),
    evidence: Object.freeze({ ...evidence, evaluated: true, qualification: 'offline-unsigned-primitives' }) });
}
