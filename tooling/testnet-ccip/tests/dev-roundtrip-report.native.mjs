import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadDevProvider } from '../src/adapters/dev-provider-admission.mjs';
import { readDevProviderArchive } from '../src/adapters/dev-provider-archive.mjs';
import { compiledReportPorts, runDevRoundtripReport } from '../src/composition/dev-roundtrip-report.mjs';
import { prepareDevRoundtripReport } from '../src/application/dev-roundtrip-report.mjs';
import { prepareDevTransferPreview } from '../src/application/dev-transfer-preview.mjs';
import { previewPorts } from '../src/adapters/dev-transfer-preview-store.mjs';
import { loadReportInput, digestReport, hashReportBytes } from '../src/adapters/dev-roundtrip-report-input.mjs';
import { readMessageCaptures } from '../src/adapters/dev-roundtrip-report-captures.mjs';
import { PROOF_PATH, PROOF_SHA256 } from '../src/domain/dev-roundtrip-report.mjs';

await import('./fixtures/dev-transfer-preview-no-effects.mjs');

// Actual admitted ethers primitive, raw CPI decoder and unchanged compiled domain.
// No SDK/Anchor entry, installation, live RPC, signing, simulations or skips.
const args = process.argv.slice(2);
if (args.length && (args.length !== 4 || args[0] !== '--provider' || args[2] !== '--archives')) { throw new Error('Use [--provider <public-installation> --archives <pinned-tarballs>]'); }
const providerPath = resolve(args[1] ?? '.local/PREPARED-PROVIDER'), archivesPath = resolve(args[3] ?? '.local/CANDIDATE-AUTHORITY/archives');
const provider = await loadDevProvider({ root: providerPath, archives: archivesPath });
assert.equal(provider.evidence.evaluated, true);
const compiled = await compiledReportPorts(), fixture = JSON.parse(await readFile(new URL('fixtures/dev-roundtrip-report.json', import.meta.url)));
const evm = JSON.parse(await readFile(new URL('fixtures/dev-evm-event-goldens.json', import.meta.url)));
const svm = JSON.parse(await readFile(new URL('fixtures/dev-svm-cpi-capture-goldens.json', import.meta.url)));
const original = JSON.parse(await readFile(PROOF_PATH)), pr1 = JSON.parse(await readFile(new URL('fixtures/dev-transfer-preview.json', import.meta.url)));
const copy = v => structuredClone(v), ref = (path, bytes) => ({ path, sha256: hashReportBytes(bytes) });
// External retained authority: authenticate archive and IDL members as data only.
const authority = evm.authority, archive = await readFile(join(archivesPath, authority.archiveSha256 + '.tgz'));
assert.equal(hashReportBytes(archive), authority.archiveSha256);
const lock = JSON.parse(await readFile(join(providerPath, 'package-lock.json')));
const payload = readDevProviderArchive(archive, lock.packages['node_modules/@chainlink/ccip-sdk'].integrity);
for (const a of svm.idlAuthorities) { assert.equal(payload.get(a.path.replace(/^package\//, '')).sha256, a.sha256); }
for (const a of Object.values(authority.events)) { assert.equal(payload.get(a.path.replace(/^package\//, '')).sha256, a.sha256); }
const s = svm.vectors[0].expectedContext, evmSelection = evm.captures[0].selection;
Object.assign(pr1, { profile: 'fixture100', fixedSupplyBaseUnits: '100000000000' });
Object.assign(pr1.pair.evm, { token: evmSelection.token, pool: evmSelection.pool, sender: evmSelection.sourceSender, recipient: s.evmRecipient });
Object.assign(pr1.pair.svm, { mint: s.mint, pool: s.poolState, signer: s.poolSigner, poolAta: s.poolATA,
  sourceAta: s.recipientATA, sender: s.recipient, recipient: s.recipient, payer: s.recipient, spender: svm.vectors[1].expectedContext.spender });
// PR1 input keeps hypothetical unrelated readiness explicitly unavailable.
pr1.states = { forward: null, reverse: null }; pr1.quotes = { forward: null, reverse: null };
for (const key of Object.keys(pr1.buckets)) { pr1.buckets[key] = null; }
const prepared = prepareDevTransferPreview(pr1, previewPorts), dir = await mkdtemp('.local/report-native-');
const planBytes = Buffer.from(JSON.stringify(prepared.plan)), factsBytes = Buffer.from(JSON.stringify(prepared.facts));
await writeFile(join(dir, 'plan.json'), planBytes); await writeFile(join(dir, 'facts.json'), factsBytes);
const messages = original.threeMessageStatus.transfers.map(t => {
  const a = evm.captures.find(v => v.selection.messageId === t.identity.messageId), b = svm.vectors.find(v => v.expectedContext.messageId === t.identity.messageId), c = b.expectedContext;
  return { routeHash: prepared.plan.routeHash, sourceTransaction: t.sourceHash, identity: copy(t.identity), sequenceNumber: c.sequenceNumber, nonce: c.nonce,
    msgTotalNonce: c.msgTotalNonce ?? null, messageHash: c.messageHash ?? null,
    evm: { receipt: { path: a.receiptPath, sha256: a.receiptSha256 }, transaction: { path: a.transactionPath, sha256: a.transactionSha256 }, transactionId: a.selection.transactionHash },
    svm: { capture: { path: c.sourcePath, sha256: c.sourceSha256 }, transactionId: c.transactionId, slot: c.slot, blockHash: t.events.find(e => e.chain === 'solana').blockHash }, modeledEvents: [] };
});
const old = original.threeMessageStatus.accounting.snapshot;
const header = { schema: 'agtmai-dev-roundtrip-input-v1', testOnly: true, broadcastAllowed: false, mode: 'historical-capture-replay',
  pr1: { plan: ref(join(dir, 'plan.json'), planBytes), facts: ref(join(dir, 'facts.json'), factsBytes) }, proof: { path: PROOF_PATH, sha256: PROOF_SHA256 },
  expected: fixture.expected, messages, snapshot: { totalSupply: '100000000000', lockedOnEthereum: old.lockedOnEthereum, supplyOnSolana: old.supplyOnSolana,
    pendingEthereumToSolana: '0', pendingSolanaToEthereum: '0', ethereum: { height: old.ethereumHeight, hash: old.ethereumBlock },
    solana: { height: String(old.solanaSlot), hash: svm.vectors[2].expectedContext.offRamp }, observedAt: old.observedAt, freshnessCheckedAt: null,
    provenance: 'unverified-supplied-snapshot', coherent: true, finalized: true }, completeInventory: true, coherent: true, finalized: true, classifications: [] };
const path = join(dir, 'header.json'); await writeFile(path, JSON.stringify(header));
const context = await loadReportInput(path);
const run = c => prepareDevRoundtripReport(c, { ...compiled, digest: digestReport, readCaptures: (r, e, m) => readMessageCaptures(r, e, m, provider.primitives) });
try {
  await test('full external captures through the actual report consumer: red on lost effect ordinals or native stubs', async () => {
    const r = await run(context);
    assert.equal(r.evidenceClass, 'historical-capture-replay'); assert.equal(r.status, 'unknown'); assert.equal(r.pending.P_ES, null); assert.equal(r.monetary.reconciliation, null);
    assert.deepEqual(r.messages.map(m => m.native.ethereum.capturedConsistency), ['known', 'known', 'known']);
    assert.deepEqual(r.messages.map(m => m.native.solana.capturedConsistency), ['known', 'known', 'known']);
    assert.deepEqual(r.messages.map(m => m.observations.filter(e => e.chain === 'ethereum').map(e => e.eventIndex)), [[110], [152], [84]]);
    assert.deepEqual(r.messages.map(m => m.observations.filter(e => e.chain === 'solana').map(e => e.eventIndex)), [[5], [7, 10], [5]]);
    const reverse = r.messages[1].observations.filter(e => e.chain === 'solana');
    assert.deepEqual(reverse.map(e => e.kind), ['internal-transfer', 'burn']);
    assert.deepEqual(reverse[0].instructionPath, [1, 5]); assert.deepEqual(reverse[1].instructionPath, [1, 8]);
    assert.equal(r.messages[2].native.solana.decoded.capabilities.cpiSignerPrivilege, 'unknown');
    assert.equal(r.recordedProof.originalSnapshot.observedAt, '2026-09-08T05:04:14.470Z');
    assert.equal(r.messages[2].projection.status, 'unknown');
    assert.ok(r.messages.every(m => m.captures.every(c => c.authenticity === 'unknown')));
    // Exercise the combination with observations from the actual captured decoder.
    // Added effects/legacy representations are explicit model inputs, not raw facts.
    for (const variant of ['duplicate-release', 'orphan-release', 'duplicate-lock']) {
      const modeled = copy(context), i = variant === 'duplicate-lock' ? 0 : 1, a = copy(context.input.messages[i]);
      modeled.proof = null; modeled.hashes.proof = null; modeled.input.proof = null; modeled.input.mode = 'local-event-simulation';
      a.evm = null; a.svm = null; a.modeledEvents = copy(r.messages[i].observations);
      const evmEffect = a.modeledEvents.find(e => e.chain === 'ethereum');
      if (variant === 'orphan-release') { a.modeledEvents = a.modeledEvents.filter(e => e.kind !== 'burn'); }
      else { a.modeledEvents.push({ ...copy(evmEffect), eventIndex: evmEffect.eventIndex + 1 }); }
      const alias = a.modeledEvents.find(e => e.chain === 'solana' && e.kind !== 'internal-transfer') ?? a.modeledEvents.find(e => e.kind === 'internal-transfer');
      a.modeledEvents.push({ ...copy(alias), eventIndex: 6, indexScheme: 'svm-recorded-legacy-v1', instructionPath: null, owningInstructionPath: null });
      const b = copy(a); b.identity.messageId = '0x' + 'f'.repeat(64); b.modeledEvents = [];
      modeled.input.messages = [a, b]; const combined = await run(modeled);
      assert.equal(combined.status, 'inconsistent'); assert.equal(combined.messages[0].status, 'inconsistent');
      for (const reason of ['mixed-index-schemes', 'duplicate-inventory-source-transaction',
        variant === 'orphan-release' ? 'orphan-settlement' : 'duplicate-source-or-settlement']) { assert.ok(combined.messages[0].reasons.includes(reason), reason); }
      assert.deepEqual(combined.messages[0].observations, a.modeledEvents); assert.equal(combined.messages[1].status, 'unknown');
      assert.equal(combined.pending.P_ES, null); assert.equal(combined.pending.P_SE, null); assert.equal(combined.monetary.reconciliation, null);
      const control = copy(modeled), events = control.input.messages[0].modeledEvents;
      if (variant === 'orphan-release') { events.push(copy(r.messages[1].observations.find(e => e.kind === 'burn'))); }
      else { events.splice(events.findIndex(e => e.chain === 'ethereum' && e.eventIndex === evmEffect.eventIndex + 1), 1); }
      assert.equal((await run(control)).status, 'unknown');
    }
    const c = copy(context), sourceLock = r.messages[0].observations.find(e => e.chain === 'ethereum');
    c.input.snapshot.ethereum = { height: sourceLock.blockHeight, hash: sourceLock.blockHash };
    assert.ok(!(await run(c)).monetary.reasons.includes('event-block-hash-conflicts-with-snapshot-watermark'));
    c.input.snapshot.ethereum.hash = '0x' + 'b'.repeat(64);
    const contradicted = await run(c);
    assert.ok(contradicted.monetary.reasons.includes('event-block-hash-conflicts-with-snapshot-watermark'));
    assert.equal(contradicted.messages[0].native.ethereum.capturedConsistency, 'known');
    assert.deepEqual(contradicted.messages[0].observations, r.messages[0].observations);
    assert.equal(contradicted.pending.knownness, 'unknown'); assert.equal(contradicted.monetary.reconciliation, null);
  });
  await test('actual local CLI flow with explicit admitted installation: red if native availability substitutes a stub', async () => {
    const result = await runDevRoundtripReport(['--input', path, '--provider', providerPath, '--archives', archivesPath, '--output', join(dir, 'published')]);
    assert.equal(result.provider.evaluated, true); assert.equal(result.report.messages[0].native.ethereum.availability, 'decoded');
    assert.equal(result.report.messages[1].native.solana.availability, 'decoded'); assert.equal(result.report.capabilities.currentSettlement, 'unknown');
    const reopened = await runDevRoundtripReport(['--reopen', join(dir, 'published'), '--provider', providerPath, '--archives', archivesPath]);
    assert.equal(reopened.report.reportHash, result.report.reportHash);
    await assert.rejects(() => runDevRoundtripReport(['--reopen', join(dir, 'published')]), /same explicit provider/);
  });
  await test('recorded branch invokes unchanged compiled accounting at original F100: red on raw-finality promotion or refresh', async () => {
    const h = copy(header); h.mode = 'recorded-proof'; h.snapshot = null;
    for (const m of h.messages) { m.evm = null; m.svm = null; }
    await writeFile(join(dir, 'recorded.json'), JSON.stringify(h));
    const result = await runDevRoundtripReport(['--input', join(dir, 'recorded.json')]);
    assert.equal(result.report.status, 'recorded-settled'); assert.equal(result.report.monetary.reconciliation.adjustedGlobalSupply, '100000000000');
    assert.equal(result.report.monetary.reconciliation.backingSurplus, '0'); assert.equal(result.report.pending.P_ES, '0'); assert.equal(result.report.pending.P_SE, '0');
    assert.equal(result.report.snapshot.observedAt, '2026-09-08T05:04:14.470Z'); assert.equal(result.report.snapshot.freshnessCheckedAt, null);
    assert.equal(result.provider.evaluated, false); assert.equal(result.report.recordedProof.originalRawFiles[1].sha256, 'a98f06b0fb90aff51a98df6ced92dad14e8c068ba8704abe30972fc3a837c74b');
  });
  await test('native raw replay replaces historical B index6 with physical mint5: red on mixed schemes', async () => {
    const r = await run(context); assert.equal(r.messages[2].observations.length, 2);
    assert.equal(r.messages[2].observations[1].indexScheme, 'svm-physical-interleaved-v1'); assert.equal(r.messages[2].observations[1].eventIndex, 5);
    const c = copy(context); c.input.messages[2].modeledEvents = [{ eventIndex: 6 }];
    const ignored = await run(c); assert.deepEqual(ignored.messages[2].observations, r.messages[2].observations);
  });
  // Mutations are local test data, with updated integrity digests. This proves
  // semantic admission independently of hashes and self-asserted success flags.
  for (const [label, mutate] of [
    ['EVM request trailing bytes', raw => { raw.result.logs.find(l => l.topics[0].startsWith('0x1924')).data += '00'; }],
    ['EVM wrong token effect', raw => { raw.result.logs.find(l => l.logIndex === '0x6e').data = '0x' + '0'.repeat(63) + '1'; }],
    ['EVM removed receipt log', raw => { raw.result.logs[0].removed = true; }],
  ]) {
    await test(label + ': red if contradictory native observations retain captured consistency', async () => {
      const c = copy(context), raw = JSON.parse(await readFile(c.input.messages[0].evm.receipt.path)); mutate(raw);
      const bytes = Buffer.from(JSON.stringify(raw)), mutationPath = join(dir, label.replaceAll(' ', '-') + '.json'); await writeFile(mutationPath, bytes);
      c.input.messages[0].evm.receipt = ref(mutationPath, bytes);
      const r = await run(c); assert.equal(r.messages[0].status, 'inconsistent'); assert.equal(r.messages[0].native.ethereum.availability, 'invalid');
    });
  }
  await test('SVM CPI Pool Signer substitution: red if raw mint metas become trusted authorization', async () => {
    const c = copy(context); c.proof = null; c.hashes.proof = null; c.input.proof = null; c.route.pair.svm.signer = c.input.expected.routerPoolAuthority;
    const r = await run(c); assert.equal(r.messages[0].status, 'inconsistent'); assert.equal(r.messages[0].native.solana.availability, 'invalid');
  });
  await test('raw SVM matching mint in wrong CPI scope remains inconsistent: red if amount alone proves settlement', async () => {
    const c = copy(context), raw = JSON.parse(await readFile(c.input.messages[2].svm.capture.path));
    raw.result.meta.innerInstructions[0].instructions[3].stackHeight = 2;
    const bytes = Buffer.from(JSON.stringify(raw)), mutatedPath = join(dir, 'wrong-cpi-scope.json'); await writeFile(mutatedPath, bytes);
    c.input.messages[2].svm.capture = ref(mutatedPath, bytes);
    const r = await run(c); assert.equal(r.messages[2].status, 'inconsistent'); assert.equal(r.messages[2].native.solana.availability, 'invalid');
  });
  await test('arbitrary captured flags cannot promote proof; native file cap remains stricter: red on asserted evidence or widened reads', async () => {
    const c = copy(context); c.proof = null; c.hashes.proof = null; c.input.proof = null;
    const r = await run(c); assert.equal(r.evidenceClass, 'fixture-only'); assert.equal(r.observationClass, 'unverified-capture-replay');
    assert.equal(r.inventory.knownness, 'unknown'); assert.equal(r.pending.P_ES, null);
    const bytes = Buffer.alloc(262145, ' '), oversizedPath = join(dir, 'oversized-capture.json'); await writeFile(oversizedPath, bytes);
    c.input.messages[0].svm.capture = ref(oversizedPath, bytes);
    const oversized = await run(c); assert.equal(oversized.messages[0].native.solana.availability, 'invalid');
    assert.equal(oversized.messages[0].status, 'inconsistent');
  });
  await test('changed native burn balances preserve deltas without legacy A-to-zero assumptions: red on consumer fixture coupling', async () => {
    const c = copy(context); c.proof = null; c.hashes.proof = null; c.input.proof = null;
    const m = c.input.messages[1], raw = JSON.parse(await readFile(m.svm.capture.path)), meta = raw.result.meta;
    const sourceIndex = meta.preTokenBalances.find(b => b.owner === context.route.pair.svm.sender && b.mint === context.route.pair.svm.mint).accountIndex;
    const poolIndex = meta.preTokenBalances.find(b => b.owner === context.route.pair.svm.signer && b.mint === context.route.pair.svm.mint).accountIndex;
    for (const [side, amount, ui] of [['preTokenBalances', '3000000000', '3'], ['postTokenBalances', '2000000000', '2']]) {
      Object.assign(meta[side].find(b => b.accountIndex === sourceIndex).uiTokenAmount, { amount, uiAmount: null, uiAmountString: ui });
      Object.assign(meta[side].find(b => b.accountIndex === poolIndex).uiTokenAmount, { amount: '11', uiAmount: null, uiAmountString: '0.000000011' });
    }
    const mutatedPath = join(dir, 'changed-burn-balances.json'), bytes = Buffer.from(JSON.stringify(raw)); await writeFile(mutatedPath, bytes);
    m.svm.capture = ref(mutatedPath, bytes); const r = await run(c), delta = r.messages[1].native.solana.decoded.balanceDeltas;
    assert.equal(r.evidenceClass, 'fixture-only'); assert.equal(r.messages[1].native.solana.capturedConsistency, 'known');
    assert.deepEqual(delta.map(d => [d.pre, d.post, d.delta]), [['3000000000', '2000000000', '-1000000000'], ['11', '11', '0']]);
    meta.postTokenBalances.find(b => b.accountIndex === sourceIndex).uiTokenAmount.amount = '2000000001';
    const badBytes = Buffer.from(JSON.stringify(raw)); await writeFile(mutatedPath, badBytes); m.svm.capture = ref(mutatedPath, badBytes);
    assert.equal((await run(c)).messages[1].status, 'inconsistent');
  });
  await test('raw truncated/injected/duplicate captures reject before native facts: red on overwritten JSON success', async () => {
    for (const mutate of [raw => raw.trim().slice(0, -1), raw => raw.replace('"jsonrpc":', '"finalized":true,"jsonrpc":'),
      raw => raw.replace('"result":', '"result":null,"res\\u0075lt":')]) {
      const c = copy(context), raw = await readFile(c.input.messages[1].svm.capture.path, 'utf8');
      const bytes = Buffer.from(mutate(raw)); await writeFile(join(dir, 'bad-svm.json'), bytes);
      c.input.messages[1].svm.capture = ref(join(dir, 'bad-svm.json'), bytes);
      const r = await run(c); assert.equal(r.messages[1].status, 'inconsistent'); assert.equal(r.messages[1].native.solana.availability, 'invalid');
    }
  });
  await test('missing provider/file capabilities stay prerequisites: red on discovery/network or zero pending fallback', async () => {
    const m = copy(context.input.messages[0]); m.svm.capture.path = join(dir, 'not-supplied.json');
    const value = await readMessageCaptures(context.route, context.input.expected, m);
    assert.equal(value.native.ethereum.availability, 'prerequisite'); assert.equal(value.native.solana.availability, 'missing'); assert.equal(value.events.length, 0);
    assert.match(value.native.ethereum.prerequisite, /admitted public provider/);
    const bytes = Buffer.from('{"jsonrpc":"2.0","result":null}'); await writeFile(join(dir, 'missing-read.json'), bytes);
    m.svm.capture = ref(join(dir, 'missing-read.json'), bytes);
    assert.equal((await readMessageCaptures(context.route, context.input.expected, m)).native.solana.availability, 'missing');
  });
} finally { await rm(dir, { recursive: true, force: true }); }
