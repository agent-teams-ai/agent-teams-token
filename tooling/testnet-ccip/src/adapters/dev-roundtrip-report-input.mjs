import { constants } from 'node:fs';
import { open, lstat, mkdir, link, unlink, opendir } from 'node:fs/promises';
import { resolve, parse, relative, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { parsePreviewJson, readPreviewInput, normalizePreviewEvm } from './dev-transfer-preview-input.mjs';
import { canonicalPreview, digestPreview, hashPreviewBytes, previewPorts, reconstructPersistedPreview } from './dev-transfer-preview-store.mjs';
import { prepareDevTransferPreview, assertForwardEncodingInput } from '../application/dev-transfer-preview.mjs';
import { decimal, PROOF_PATH, PROOF_SHA256 } from '../domain/dev-roundtrip-report.mjs';
import { solanaPublicKeyBytes } from '../domain/solana-mint.ts';
import { DEV_EVM_INPUT_BOUNDS } from './dev-evm-event-codec.mjs';
import { DEV_SVM_CAPTURE_BOUNDS } from './dev-svm-cpi-capture.mjs';

export { digestPreview as digestReport, canonicalPreview as canonicalReport, hashPreviewBytes as hashReportBytes };
const fail = reason => { throw new Error('DEV report input: ' + reason); };
const id = stat => [stat.dev, stat.ino].join(':');
// Each selected reference owns its exact admitted bytes/errors as private,
// non-enumerable state: no rereads between admission and decoding, no shared
// registry/path deduplication and no change to serialized reference hashes.
const admittedCaptureRead = Symbol('admitted report capture read');
// Bounded regular files, no symlink in any component, unchanged identity/size/time
// across read. OS/kernel and absence of same-UID final-syscall races are trusted.
function localFilePath(path) {
  if (typeof path !== 'string' || !path.length || path.length > 4096 || path.includes('://') || path.includes('\0')) { fail('explicit local path required'); }
  return path;
}
export async function readReportFile(path, maximum = 65536, captureBudget = null) {
  const absolute = resolve(localFilePath(path)), root = parse(absolute).root, ancestors = []; let current = root;
  for (const part of relative(root, absolute).split('/').slice(0, -1)) {
    current = join(current, part); const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) { fail('real directory ancestor required'); }
    ancestors.push([current, id(s)]);
  }
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || id(before) !== id(await lstat(absolute))) { fail('bounded regular file required'); }
    if (captureBudget) {
      if (before.size > captureBudget.remaining) {
        const error = new Error('DEV report input: report capture byte budget exceeds 1048576 bytes');
        error.code = 'DEV_REPORT_CAPTURE_BUDGET'; throw error;
      }
      captureBudget.remaining -= before.size;
    }
    if (before.size > maximum) { fail('bounded regular file required'); }
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) { break; } length += read.bytesRead;
    }
    const after = await file.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        id(after) !== id(await lstat(absolute))) { fail('file substituted/truncated/changed'); }
    for (const [ancestor, identity] of ancestors) { if (id(await lstat(ancestor)) !== identity) { fail('ancestor substituted'); } }
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const boundedText = v => { if (typeof v !== 'string' || !v.length || v.length > 512) { fail('bounded text'); } return v; };
const lit = expected => v => { if (v !== expected) { fail('schema/flag'); } return v; };
const choice = options => v => { if (!options.includes(v)) { fail('unsupported value'); } return v; };
const uint = bits => v => { decimal(v, bits); return v; };
const hex = width => v => { if (typeof v !== 'string' || !new RegExp('^[0-9a-f]{' + width * 2 + '}$').test(v)) { fail('digest/hex'); } return v; };
const key = v => { solanaPublicKeyBytes(v); return v; };
const evm = v => normalizePreviewEvm(v);
const hash = v => { if (!/^0x[0-9a-f]{64}$/.test(v)) { fail('message/block hash'); } return v; };
const nullable = validate => v => v === null ? null : validate(v);
const object = spec => v => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== Object.keys(spec).length || Object.keys(v).some(k => !Object.hasOwn(spec, k))) { fail('unknown/missing fields'); }
  return Object.fromEntries(Object.entries(spec).map(([k, validate]) => [k, validate(v[k])]));
};
const array = (validate, maximum) => v => { if (!Array.isArray(v) || v.length > maximum) { fail('array bound'); } return v.map(validate); };
const index = v => { if (!Number.isSafeInteger(v) || v < 0 || v > 2147483647) { fail('physical index'); } return v; };
const utc = v => { boundedText(v); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) || !Number.isFinite(Date.parse(v)) || ![new Date(v).toISOString(), new Date(v).toISOString().replace('.000Z', 'Z')].includes(v)) { fail('UTC time'); } return v; };
const bool = choice([true, false]);
const reference = object({ path: boundedText, sha256: hex(32) });
const transferIdentity = object({ messageId: hash, direction: choice(['ethereum-to-solana', 'solana-to-ethereum']), amount: uint(64), sourceToken: boundedText, destinationToken: boundedText, recipient: boundedText });
const event = object({ identity: transferIdentity, routeHash: hex(32), chain: choice(['ethereum', 'solana']), kind: choice(['lock', 'mint', 'burn', 'release', 'internal-transfer']),
  transactionId: boundedText, eventIndex: index, indexScheme: choice(['evm-log-index-v1', 'svm-physical-interleaved-v1', 'svm-recorded-legacy-v1']),
  instructionPath: nullable(array(index, 16)), owningInstructionPath: nullable(array(index, 16)), blockHash: boundedText, blockHeight: uint(64),
  finality: choice(['finalized', 'unfinalized', 'reorged']) });
const watermark = object({ height: uint(64), hash: boundedText });
const snapshot = object({ totalSupply: nullable(uint(256)), lockedOnEthereum: nullable(uint(256)), supplyOnSolana: nullable(uint(64)),
  pendingEthereumToSolana: nullable(uint(256)), pendingSolanaToEthereum: nullable(uint(256)), ethereum: nullable(watermark), solana: nullable(watermark),
  observedAt: utc, freshnessCheckedAt: nullable(utc), provenance: boundedText, coherent: bool, finalized: bool });
const message = object({ routeHash: hex(32), sourceTransaction: boundedText, identity: transferIdentity, sequenceNumber: uint(64), nonce: uint(64), msgTotalNonce: nullable(uint(64)), messageHash: nullable(hash),
  evm: nullable(object({ receipt: reference, transaction: reference, transactionId: hash })),
  svm: nullable(object({ capture: reference, transactionId: boundedText, slot: uint(64), blockHash: nullable(key) })), modeledEvents: array(event, 12) });
const header = object({ schema: lit('agtmai-dev-roundtrip-input-v1'), testOnly: lit(true), broadcastAllowed: lit(false),
  mode: choice(['fixture-only', 'local-event-simulation', 'historical-capture-replay', 'recorded-proof']),
  pr1: object({ plan: reference, facts: reference }), proof: nullable(reference),
  expected: object({ onRamp: evm, offRamp: evm, svmOffRamp: key, nativeFeeToken: evm, poolChainConfig: key, allowedOffRamp: key, offRampPoolAuthority: key, routerPoolAuthority: key,
    receivers: array(object({ recipient: key, ata: key }), 3) }), messages: array(message, 3), snapshot: nullable(snapshot),
  completeInventory: bool, coherent: bool, finalized: bool,
  classifications: array(choice(['unexplained-extra-mint', 'backing-donation', 'voluntary-wallet-burn']), 3) });
export function parseReportHeader(bytes) {
  const value = header(parsePreviewJson(utf8(bytes), 65536));
  if (new Set(value.expected.receivers.map(r => r.recipient)).size !== value.expected.receivers.length) { fail('duplicate selected receiver'); }
  if (value.mode === 'recorded-proof' && (!value.proof || value.snapshot !== null || value.messages.some(m => m.evm || m.svm || m.modeledEvents.length))) { fail('recorded proof uses only selected immutable report'); }
  if (value.mode === 'historical-capture-replay' && value.messages.some(m => m.modeledEvents.length)) { fail('raw replay replaces all recorded events'); }
  if (['fixture-only', 'local-event-simulation'].includes(value.mode) && (value.proof || value.messages.some(m => m.evm || m.svm))) { fail('modeled evidence is explicit and separate'); }
  return value;
}
export async function readReference(ref, maximum = 1048576) {
  const admitted = ref[admittedCaptureRead];
  if (admitted && (admitted.path !== ref.path || admitted.sha256 !== ref.sha256)) { fail('selected capture reference changed after admission'); }
  if (admitted?.error) { throw admitted.error; }
  const bytes = admitted?.bytes ?? await readReportFile(ref.path, maximum);
  if (bytes.length > maximum) { fail('bounded regular file required'); }
  if (hashPreviewBytes(bytes) !== ref.sha256) { fail('selected file digest mismatch'); }
  return bytes;
}
async function admitReportCaptures(messages) {
  const budget = { remaining: 1048576 };
  for (const m of messages) {
    const selected = [
      ...(m.evm ? [[m.evm.receipt, DEV_EVM_INPUT_BOUNDS.captureBytes], [m.evm.transaction, DEV_EVM_INPUT_BOUNDS.captureBytes]] : []),
      ...(m.svm ? [[m.svm.capture, DEV_SVM_CAPTURE_BOUNDS.transactionBytes]] : []),
    ];
    for (const [ref, maximum] of selected) {
      const admitted = { path: ref.path, sha256: ref.sha256 };
      try { admitted.bytes = await readReportFile(ref.path, maximum, budget); }
      catch (error) {
        if (error.code === 'DEV_REPORT_CAPTURE_BUDGET') { throw error; }
        // Preserve existing missing/invalid capture diagnostics, with no retry
        // or replacement. Selected file sizes count even if their read fails.
        admitted.error = error;
      }
      Object.defineProperty(ref, admittedCaptureRead, { value: admitted });
    }
  }
}
export async function loadReportInput(path, loadEncoding) {
  const bytes = await readReportFile(path), input = parseReportHeader(bytes);
  // One report-wide budget, before capture JSON/decoding or provider loading.
  // Header, PR1 plan/facts and the historical proof retain separate limits.
  await admitReportCaptures(input.messages);
  const planBytes = await readReference(input.pr1.plan), factsBytes = await readReference(input.pr1.facts);
  const plan = parsePreviewJson(utf8(planBytes), 1048576), facts = parsePreviewJson(utf8(factsBytes), 1048576);
  // Known input/cost conflicts precede loading the optional admitted native capability.
  const normalized = readPreviewInput(canonicalPreview(plan.input));
  if (plan.legs?.reverse?.callPlan) { assertForwardEncodingInput(prepareDevTransferPreview(normalized, previewPorts).plan); }
  const encoding = plan.legs?.reverse?.callPlan && loadEncoding ? await loadEncoding() : undefined;
  const expected = reconstructPersistedPreview(plan, encoding);
  if (canonicalPreview(plan) !== canonicalPreview(expected.plan) || canonicalPreview(facts) !== canonicalPreview(expected.facts)) { fail('PR1 route/plan/facts semantic binding'); }
  let proof = null;
  if (input.proof) {
    if (input.proof.sha256 !== PROOF_SHA256 || resolve(input.proof.path) !== resolve(PROOF_PATH)) { fail('only selected canonical historical proof allowed'); }
    // Only immutable, hash-verified historical bytes may use their original float
    // freshness telemetry/legacy numeric slots. Monetary fields remain strings.
    proof = JSON.parse(utf8(await readReference(input.proof)));
  }
  return { input, headerBytes: bytes, route: plan.route, routeHash: plan.routeHash, planHash: plan.planHash, proof,
    hashes: { header: hashPreviewBytes(bytes), plan: hashPreviewBytes(planBytes), facts: hashPreviewBytes(factsBytes), proof: input.proof?.sha256 ?? null } };
}
// Validate decoded member names before either native parser materializes JSON.
// Unlike the header, full public captures contain nonmonetary RPC UI floats.
export function checkCaptureJson(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > 1048576) { fail('capture byte bound'); }
  const text = utf8(raw); let i = 0;
  const space = () => { while (/[ \t\r\n]/.test(text[i] ?? '') && i < text.length) { i++; } };
  const str = () => { const start = i++; while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; } if (text[i++] === '"') { return JSON.parse(text.slice(start, i)); }
  } fail('truncated JSON string'); };
  const value = depth => {
    if (depth > 64) { fail('capture nesting bound'); } space();
    if (text[i] === '"') { str(); return; }
    if (text[i] === '{' || text[i] === '[') {
      const record = text[i++] === '{', end = record ? '}' : ']', seen = new Set(); space();
      if (text[i] === end) { i++; return; }
      let count = 0;
      for (;;) {
        if (++count > 4096) { fail('capture collection bound'); } space();
        if (record) {
          if (text[i] !== '"') { fail('JSON member'); } const name = str(); space();
          if (seen.has(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) { fail('duplicate/unsafe decoded JSON member'); }
          seen.add(name); if (text[i++] !== ':') { fail('JSON colon'); }
        }
        value(depth + 1); space(); const next = text[i++]; if (next === end) { return; } if (next !== ',') { fail('truncated JSON collection'); }
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    if (!token) { fail('JSON value'); } i += token[0].length;
    if (!Number.isFinite(Number(token[0])) && !['true', 'false', 'null'].includes(token[0])) { fail('nonfinite JSON number'); }
  };
  value(0); space(); if (i !== text.length) { fail('trailing JSON bytes'); }
  const result = JSON.parse(text);
  if (!result || Object.keys(result).some(k => !['jsonrpc', 'result', 'id', 'error'].includes(k)) || result.jsonrpc !== '2.0' ||
      !Object.hasOwn(result, 'result') && !Object.hasOwn(result, 'error')) { fail('RPC envelope'); }
  if (Object.hasOwn(result, 'error') && result.result) { fail('contradictory RPC success/error'); }
  if (result.result === null || !Object.hasOwn(result, 'result')) {
    const missing = new Error('Explicit captured RPC read unavailable'); missing.code = 'DEV_CAPTURE_MISSING'; throw missing;
  }
  if (!result.result || typeof result.result !== 'object' || Array.isArray(result.result)) { fail('RPC result record'); }
  return result;
}

const reportArtifacts = ['input.json', 'report.json', 'summary.md'];
async function reportDirectoryIdentity(directory, identity) {
  if (id(await lstat(directory)) !== identity) { fail('output directory substituted; foreign object preserved'); }
}
async function reportInventory(directory) {
  const remaining = new Set([...reportArtifacts, 'complete.json']);
  for await (const entry of await opendir(directory, { bufferSize: remaining.size + 1 })) {
    if (!remaining.delete(entry.name)) { fail('injected output inventory'); }
  }
  if (remaining.size) { fail('incomplete output inventory'); }
}
async function reportWrite(owner, name, bytes) {
  const { fd, directory, identity } = owner;
  await reportDirectoryIdentity(directory, identity);
  const file = await open('/proc/self/fd/' + fd.fd + '/' + name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await reportDirectoryIdentity(directory, identity);
}
/** Exclusive, READY-last local publication; failed owned residue is diagnostic.
 * Reopening additionally re-runs the entire report from the persisted exact header. */
export async function publishReport(output, headerBytes, result) {
  const directory = resolve(localFilePath(output)), parent = resolve(directory, '..');
  // Reuse the reader's component policy without opening a caller-selected file.
  let current = parse(parent).root;
  for (const part of relative(current, parent).split('/').filter(Boolean)) {
    current = join(current, part); const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) { fail('real output parent required'); }
  }
  const bytes = [headerBytes, Buffer.from(canonicalPreview(result.report) + '\n'), Buffer.from(result.summary)];
  if (bytes[0].length > 65536 || bytes[1].length > 8388608 || bytes[2].length > 65536) { fail('output capacity'); }
  await mkdir(directory, { mode: 0o700 });
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = id(await fd.stat()), inventory = {};
    for (const [i, name] of reportArtifacts.entries()) {
      await reportWrite({ fd, directory, identity }, name, bytes[i]); inventory[name] = hashPreviewBytes(bytes[i]);
    }
    const complete = { schema: 'agtmai-dev-roundtrip-complete-v1', reportHash: result.report.reportHash, inventory };
    await reportWrite({ fd, directory, identity }, '.complete.tmp', Buffer.from(canonicalPreview(complete) + '\n'));
    const anchored = '/proc/self/fd/' + fd.fd;
    await link(join(anchored, '.complete.tmp'), join(anchored, 'complete.json')); await unlink(join(anchored, '.complete.tmp'));
    await fd.sync(); await reportDirectoryIdentity(directory, identity);
  } finally { await fd.close(); }
  return reopenReportFiles(directory);
}
export async function reopenReportFiles(output) {
  const directory = resolve(localFilePath(output)), stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) { fail('real report directory required'); }
  const identity = id(stat); await reportInventory(directory);
  const complete = parsePreviewJson(utf8(await readReportFile(join(directory, 'complete.json'))));
  if (Object.keys(complete).toSorted().join(',') !== 'inventory,reportHash,schema' || complete.schema !== 'agtmai-dev-roundtrip-complete-v1' ||
      Object.keys(complete.inventory).toSorted().join(',') !== reportArtifacts.toSorted().join(',')) { fail('completion schema/inventory'); }
  const paths = reportArtifacts.map(name => join(directory, name)), bytes = [];
  for (const [i, name] of reportArtifacts.entries()) {
    bytes[i] = await readReportFile(paths[i], i === 1 ? 8388608 : 65536);
    if (hashPreviewBytes(bytes[i]) !== complete.inventory[name]) { fail('persisted artifact hash mismatch'); }
  }
  await reportInventory(directory); await reportDirectoryIdentity(directory, identity);
  return { headerPath: paths[0], reportBytes: bytes[1], summary: utf8(bytes[2]), reportHash: complete.reportHash, directory };
}
export function verifyReopenedReport(files, result) {
  if (utf8(files.reportBytes) !== canonicalPreview(result.report) + '\n' || files.summary !== result.summary || files.reportHash !== result.report.reportHash) {
    fail('persisted semantic cross-binding/recomputation mismatch; use the same explicit provider/archive capabilities');
  }
}
