import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, mkdir, link, unlink, opendir } from 'node:fs/promises';
import { resolve, dirname, join, parse, relative } from 'node:path';
import { parsePreviewJson, readPreviewInput, inspectReversePreviewInput } from './dev-transfer-preview-input.mjs';
import { prepareDevTransferPreview, assertForwardEncodingInput } from '../application/dev-transfer-preview.mjs';
import { reopenDevEvmCallPlanPort } from './dev-evm-call-plan.mjs';

export function canonicalPreview(value) {
  if (Array.isArray(value)) {return '[' + value.map(canonicalPreview).join(',') + ']';}
  if (value && typeof value === 'object') {return '{' + Object.keys(value).toSorted().map(k => JSON.stringify(k) + ':' + canonicalPreview(value[k])).join(',') + '}';}
  return JSON.stringify(value);
}
export const hashPreviewBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const digestPreview = value => hashPreviewBytes(canonicalPreview(value));
function renderReversePreview(leg) {
  const lines = [];
  const candidate = leg.callPlan.candidate;
  lines.push(candidate ? 'Return bytes: admitted local v0 encoding; hypothetical common before-state, conditional on finalized receive.' : 'Return bytes unavailable; explicit raw facts and main-input prerequisites must both be complete.',
    'Reopen requires explicit local provider root and archives; current readiness remains null.', '');
  if (candidate) {
    lines.push('Unsigned v0 transaction (one zero signature): ' + candidate.transactionBase64,
      'Message: ' + candidate.messageBase64, 'Transaction SHA256: ' + leg.callPlan.transactionSha256, '');
    for (const operation of leg.operations) {
      lines.push('- Conditional ' + operation.kind + ': program ' + operation.instruction.programId,
        '  Instruction bytes: ' + operation.instruction.dataBase64, '  Instruction SHA256: ' + operation.instructionHash);
      for (const a of operation.instruction.accounts) {lines.push('  Account: ' + a.address + '; writable: ' + a.isWritable + '; signer: ' + a.isSigner);}
    }
  }
  return lines;
}
export function renderPreview(plan) {
  const encoded = plan.legs.forward.callPlan;
  const lines = [encoded ? '# Offline DEV transfer preview' : '# Offline DEV transfer intent', '', 'Evidence: fixture-only; ' + plan.status + '; broadcastAllowed: false.',
    encoded ? 'Forward bytes: local-codec-encoding, DEV addendum only. Decoded prerequisites remain unauthenticated; executable: false.' : 'No CCIP delivery, current readiness, signing or unsigned bytes are claimed.', '',
    'Source: ' + plan.source.sourceRevision, 'Route SHA256: ' + plan.routeHash, 'Plan SHA256: ' + plan.planHash,
    'Profile: ' + plan.route.profile + '; amount: ' + plan.route.amount + ' base units (decimals 9).',
    'Lane: Ethereum Sepolia (' + plan.route.lane.chainId + ') → Solana Devnet; conditional return to Sepolia.',
    'Selectors: ' + plan.route.lane.ethereumSelector + ' / ' + plan.route.lane.solanaSelector,
    'EVM token / pool: ' + plan.route.pair.evm.token + ' / ' + plan.route.pair.evm.pool,
    'SVM mint / pool: ' + plan.route.pair.svm.mint + ' / ' + plan.route.pair.svm.pool,
    'Expected direct Pool Signer: ' + plan.route.pair.svm.signer + (plan.legs.reverse.callPlan?.candidate ? '; derived and bound by admitted local codec; chain authority remains unauthenticated.' : '; cryptographic derivation remains a prerequisite.'),
    'EVM initial / current registry admin: ' + plan.route.pair.evm.initialAdmin + ' / ' + plan.route.pair.evm.registryAdmin,
    'SVM payer / registry admin: ' + plan.route.pair.svm.payer + ' / ' + plan.route.pair.svm.registryAdmin,
    'Registered ALT / separate authority: ' + plan.route.pair.svm.alt.key + ' / ' + String(plan.route.pair.svm.alt.authority), ''];
  for (const [direction, leg] of Object.entries(plan.legs)) {
    lines.push('## ' + (direction === 'forward' ? 'Receive on Solana' : 'Conditional return to Ethereum'), '',
      'From: ' + leg.from, 'Recipient: ' + leg.recipient, 'Admission: ' + leg.admission.status,
      'Unsigned availability: ' + (leg.callPlan?.availability ?? 'unavailable') + '; executable: false.', '');
    if (leg.callPlan && direction === 'forward') {
      lines.push('Encoding authority: ' + leg.callPlan.provenance.authority,
        'DEV provider manifest / lock SHA256: ' + leg.callPlan.provenance.providerManifestSha256 + ' / ' + leg.callPlan.provenance.providerLockSha256, '');
      for (const operation of leg.operations.filter(item => item.unsigned)) {
        const call = operation.unsigned;
        lines.push('- Conditional ' + operation.kind + ': from ' + call.from + '; to ' + call.to + '; chainId ' + call.chainId + '; value ' + call.value + ' wei',
          '  Calldata: ' + call.data, '  Call SHA256: ' + operation.callHash);
      }
    }
    if (direction === 'reverse' && leg.callPlan) {lines.push(...renderReversePreview(leg));}
    for (const item of [...leg.conflicts, ...leg.prerequisites, ...leg.executionPrerequisites]) {lines.push('- ' + item);}
    if (leg.condition) {lines.push('- Condition: ' + leg.condition);}
    lines.push('');
  }
  return lines.join('\n');
}
export const previewPorts = Object.freeze({ digest: digestPreview, render: renderPreview,
  hashCalldata: data => hashPreviewBytes(Buffer.from(data.slice(2), 'hex')),
  hashBase64: data => hashPreviewBytes(Buffer.from(data, 'base64')), inspectReverseInput: inspectReversePreviewInput });
const identity = s => [s.dev, s.ino].join(':');
async function noLinkAncestors(path) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split('/').filter(Boolean)) {
    current = join(current, part); const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) {throw new Error('Local directory ancestor is not a real directory');}
  }
}
// Include only one overflow byte, even if a file grows after its initial stat.
async function readBounded(file, maximum) {
  const chunks = [], buffer = Buffer.alloc(Math.min(65536, maximum + 1)); let total = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, maximum + 1 - total), null);
    if (!bytesRead) {return Buffer.concat(chunks, total);}
    total += bytesRead;
    if (total > maximum) {throw new Error('Local file exceeds byte bound');}
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
}
export async function readPreviewFile(path, maximum = 65536) {
  const absolute = resolve(path);
  if (typeof path !== 'string' || path.length > 4096 || path.includes('://')) {throw new Error('Bounded local file path required');}
  await noLinkAncestors(dirname(absolute));
  const fd = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size > maximum || identity(before) !== identity(await lstat(absolute))) {throw new Error('Bounded regular local file required');}
    const bytes = await readBounded(fd, maximum);
    const after = await fd.stat();
    if (bytes.length > maximum || after.size !== before.size || after.mtimeMs !== before.mtimeMs || identity(after) !== identity(await lstat(absolute))) {throw new Error('Local file changed while reading');}
    return bytes;
  } finally { await fd.close(); }
}
const artifactNames = ['plan.json', 'facts.json', 'summary.md'];
function artifactBytes(artifacts) {
  return [Buffer.from(canonicalPreview(artifacts.plan) + '\n'), Buffer.from(canonicalPreview(artifacts.facts) + '\n'), Buffer.from(artifacts.summary)];
}
async function assertDirectory(path, id) { const s = await lstat(path); if (identity(s) !== id || !s.isDirectory() || (s.mode & 0o7777) !== 0o700 || s.uid !== process.getuid()) {throw new Error('Output directory substituted or private mode changed; foreign object preserved');} }
/** Reserved directory and descriptor-anchored writes. Failed output remains diagnostic; never recursively cleaned. */
export async function publishPreview(artifacts, output, encoding = {}) {
  if (artifacts.plan.legs.reverse.callPlan && !encoding.reverseEncoding) {throw new Error('Reverse encoding prerequisite: publication needs the admitted inspection port');}
  const directory = resolve(output);
  if (typeof output !== 'string' || output.length > 4096 || output.includes('://')) {throw new Error('Bounded local output path required');}
  await noLinkAncestors(dirname(directory));
  await mkdir(directory, { mode: 0o700 }); // Existing target is a conflict, including an input alias.
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const id = identity(await fd.stat()), anchored = '/proc/self/fd/' + fd.fd;
  const bytes = artifactBytes(artifacts), inventory = {};
  const write = async (name, data) => {
    await assertDirectory(directory, id);
    const file = await open(join(anchored, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await assertDirectory(directory, id);
  };
  try {
    for (let i = 0; i < artifactNames.length; i++) {
      await write(artifactNames[i], bytes[i]); inventory[artifactNames[i]] = hashPreviewBytes(bytes[i]);
    }
    const completion = { schema: 'agtmai-dev-transfer-complete-v1', source: artifacts.plan.source,
      planHash: artifacts.plan.planHash, routeHash: artifacts.plan.routeHash, evidenceClass: 'fixture-only', status: artifacts.plan.status, inventory };
    await write('.complete.tmp', Buffer.from(canonicalPreview(completion) + '\n'));
    await link(join(anchored, '.complete.tmp'), join(anchored, 'complete.json')); // Atomic, no replacement.
    await unlink(join(anchored, '.complete.tmp')); await fd.sync(); await assertDirectory(directory, id);
  } finally { await fd.close(); }
  return reopenPreview(directory, encoding);
}
function persistedForwardEncoding(plan) {
  const forward = plan.legs?.forward;
  return forward?.callPlan ? reopenDevEvmCallPlanPort(forward.callPlan, forward.operations) : undefined;
}
/** Re-admit persisted input and reconstruct encoded semantics for preview/report readers. */
export function reconstructPersistedPreview(plan, { reverseEncoding } = {}) {
  const forwardEncoding = persistedForwardEncoding(plan);
  const normalized = readPreviewInput(canonicalPreview(plan.input));
  if (plan.legs?.reverse?.callPlan) {assertForwardEncodingInput(prepareDevTransferPreview(normalized, previewPorts).plan);}
  if (plan.legs?.reverse?.callPlan && !reverseEncoding) {throw new Error('Reverse encoding prerequisite: reopen needs explicitly admitted local provider root and archives');}
  if (!plan.legs?.reverse?.callPlan) {reverseEncoding = undefined;}
  return prepareDevTransferPreview(normalized, { ...previewPorts, forwardEncoding, reverseEncoding });
}
function validateCompletion(complete) {
  if (Object.keys(complete).toSorted().join(',') !== 'evidenceClass,inventory,planHash,routeHash,schema,source,status' || complete.schema !== 'agtmai-dev-transfer-complete-v1' || Object.keys(complete.inventory).toSorted().join(',') !== artifactNames.slice().toSorted().join(',')) {throw new Error('Invalid completion schema');}
}
function assertReconstructedPreview(plan, facts, complete, bytes, expected) {
  if (canonicalPreview(plan) !== canonicalPreview(expected.plan) || canonicalPreview(facts) !== canonicalPreview(expected.facts) || bytes[2].toString() !== expected.summary ||
    complete.planHash !== plan.planHash || complete.routeHash !== plan.routeHash || canonicalPreview(complete.source) !== canonicalPreview(plan.source) || complete.evidenceClass !== plan.evidenceClass || complete.status !== plan.status) {throw new Error('Artifact semantic cross-binding mismatch');}
}
async function readReopenedArtifact(anchored, name) {
  const path = join(anchored, name);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || (before.mode & 0o7777) !== 0o600 || before.uid !== process.getuid() || before.size > 1048576 || identity(before) !== identity(await lstat(path))) {throw new Error('Invalid artifact file');}
    const bytes = await readBounded(file, 1048576), after = await file.stat();
    if (bytes.length > 1048576 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || identity(after) !== identity(await lstat(path))) {throw new Error('Artifact changed while reopening');}
    return bytes;
  }
  finally { await file.close(); }
}
export async function reopenPreview(output, { reverseEncoding } = {}) {
  if (typeof output !== 'string' || !output.length || output.length > 4096 || output.includes('://')) {throw new Error('Bounded local output path required');}
  const directory = resolve(output); await noLinkAncestors(directory);
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const id = identity(await fd.stat()), anchored = '/proc/self/fd/' + fd.fd;
    const read = name => readReopenedArtifact(anchored, name);
    const assertInventory = async () => {
      const remaining = new Set([...artifactNames, 'complete.json']);
      for await (const entry of await opendir(anchored, { bufferSize: remaining.size + 1 })) {
        if (!remaining.delete(entry.name)) {throw new Error('Incomplete or injected artifact inventory');}
      }
      if (remaining.size) {throw new Error('Incomplete or injected artifact inventory');}
    };
    await assertInventory();
    await assertDirectory(directory, id);
    const complete = parsePreviewJson((await read('complete.json')).toString(), 1048576);
    validateCompletion(complete);
    const bytes = await Promise.all(artifactNames.map(read));
    for (let i = 0; i < artifactNames.length; i++) {if (hashPreviewBytes(bytes[i]) !== complete.inventory[artifactNames[i]]) {throw new Error('Artifact byte hash mismatch');}}
    const plan = parsePreviewJson(bytes[0].toString(), 1048576), facts = parsePreviewJson(bytes[1].toString(), 1048576);
    // Reconstruct all semantics from strictly re-admitted persisted input, rather than trusting agreeing hashes.
    const expected = reconstructPersistedPreview(plan, { reverseEncoding });
    assertReconstructedPreview(plan, facts, complete, bytes, expected);
    await assertInventory();
    await assertDirectory(directory, id);
    return { directory, status: plan.status, evidenceClass: plan.evidenceClass, planHash: plan.planHash, routeHash: plan.routeHash,
      paths: Object.fromEntries([...artifactNames, 'complete.json'].map(name => [name, join(directory, name)])), plan, facts };
  } finally { await fd.close(); }
}
