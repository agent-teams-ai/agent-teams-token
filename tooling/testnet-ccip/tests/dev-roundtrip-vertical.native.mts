// Regression boundary: encoded saved preview must reach the report and reopen without losing exact amounts or knownness.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordJson = { [key: string]: Json };
function object(value: Json | undefined): RecordJson {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value;
}
function field(value: Json, ...keys: string[]): Json {
  let result = value;
  for (const key of keys) { const next = object(result)[key]; assert.notEqual(next, undefined, key); result = next!; }
  return result;
}
function text(value: Json): string { assert.equal(typeof value, 'string'); return value as string; }
function array(value: Json): Json[] { assert.ok(Array.isArray(value)); return value; }
function put(value: Json, keys: string[], next: Json): void {
  assert.ok(keys.length); const parent = keys.length === 1 ? value : field(value, ...keys.slice(0, -1));
  const key = keys.at(-1)!; assert.ok(Object.hasOwn(object(parent), key)); object(parent)[key] = next;
}
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
async function json(path: string): Promise<RecordJson> { return object(JSON.parse(await readFile(path, 'utf8')) as Json); }
const [provider, archives, workspace, ...extra] = process.argv.slice(2);
assert.ok(provider && archives && workspace && !extra.length && [provider, archives, workspace].every(isAbsolute), 'Require three explicit absolute provider/archive/new-output paths');
const root = resolve('tooling/testnet-ccip'), amount = '9007199254740993', fixedSupply = '100000000000000000';
const initialAndFinalBacking = '90992800745259007', receiver = '0x7777777777777777777777777777777777777777';
function cli(name: string, arguments_: string[]): RecordJson {
  const result = spawnSync(process.execPath, [join(root, 'src/composition', name + '.mjs'), ...arguments_], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', TMPDIR: '/tmp' }, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.signal, null, result.stderr); assert.equal(result.status, 0, result.stderr);
  return object(JSON.parse(result.stdout) as Json);
}
await test('saved bidirectional native preview feeds exact product100M roundtrip report and both CLI reopens', async () => {
  await mkdir(workspace, { mode: 0o700 }); // Exclusive, retained test evidence; no discovery/cleanup.
  const fixture = await json(join(root, 'tests/fixtures/dev-bidirectional-preview.json'));
  const input = object(fixture.input), reverse = object(fixture.reverseCall), route = object(reverse.route), facts = object(reverse.facts);
  for (const target of [input, route]) { put(target, ['profile'], 'product100M'); put(target, ['fixedSupplyBaseUnits'], fixedSupply); put(target, ['amount'], amount); }
  put(input, ['states', 'forward', 'totalSupply'], fixedSupply); put(input, ['states', 'forward', 'balance'], amount);
  put(input, ['pair', 'evm', 'recipient'], receiver); put(route, ['recipient'], receiver); put(input, ['quotes', 'reverse', 'recipient'], receiver);
  put(input, ['states', 'reverse', 'mint', 'supply'], fixedSupply); put(input, ['states', 'reverse', 'source', 'balance'], '90000000000000000');
  put(facts, ['before', 'mintSupply'], fixedSupply); put(facts, ['before', 'sourceBalance'], '90000000000000000');
  function raw(name: string, edit: (bytes: Buffer) => void): void {
    const capture = field(facts, 'state', name), bytes = Buffer.from(text(field(capture, 'dataBase64')), 'base64'); edit(bytes);
    put(capture, ['dataBase64'], bytes.toString('base64')); put(capture, ['sha256'], hash(bytes));
  }
  raw('mint', bytes => bytes.writeBigUInt64LE(BigInt(fixedSupply), 36)); raw('sourceAta', bytes => bytes.writeBigUInt64LE(90000000000000000n, 64));
  const policy = object(fixture.changedLimiterPolicy), tokens = text(field(fixture, 'changedLimiterTokens'));
  for (const name of Object.keys(object(input.limiters))) {
    Object.assign(object(field(input, 'limiters', name)), policy); Object.assign(object(field(input, 'buckets', name)), policy, { tokens });
  }
  raw('chain', bytes => { for (const offset of [73, 106]) {
    bytes.writeBigUInt64LE(BigInt(tokens), offset); bytes.writeBigUInt64LE(BigInt(text(field(policy, 'capacity'))), offset + 17);
    bytes.writeBigUInt64LE(BigInt(text(field(policy, 'rate'))), offset + 25);
  } });
  for (const quote of Object.values(object(input.quotes))) { put(quote, ['amount'], amount); } put(facts, ['fees', 'quote', 'amount'], amount);
  const inputPath = join(workspace, 'input.json'), reversePath = join(workspace, 'reverse.json'), previewPath = join(workspace, 'preview');
  await writeFile(inputPath, JSON.stringify(input)); await writeFile(reversePath, JSON.stringify(reverse));
  const previewArgs = ['--input', inputPath, '--reverse-input', reversePath, '--output', previewPath, '--provider-root', provider, '--provider-archives', archives];
  assert.equal(cli('dev-transfer-preview', previewArgs).qualification, 'DEV-unsigned-local-encoding-only');
  cli('dev-transfer-preview', ['--reopen', previewPath, '--provider-root', provider, '--provider-archives', archives]);
  const plan = await json(join(previewPath, 'plan.json')), savedFacts = await json(join(previewPath, 'facts.json'));
  assert.deepEqual(savedFacts.unsignedAvailable, { forward: true, reverse: true }); assert.equal(savedFacts.currentReadiness, null);
  const candidate = field(plan, 'legs', 'reverse', 'callPlan', 'candidate'), instructions = array(field(candidate, 'instructions'));
  assert.equal(Buffer.from(text(field(instructions.at(-1)!, 'dataBase64')), 'base64').toString('hex'), fixture.changedSendHex);
  const packet = Buffer.from(text(field(candidate, 'transactionBase64')), 'base64');
  assert.ok(packet.length <= 1232); assert.equal(packet[0], 1); assert.deepEqual(packet.subarray(1, 65), Buffer.alloc(64));
  assert.equal(packet[65], 0x80); assert.equal(packet[66], 1);
  assert.deepEqual(field(candidate, 'modelledAfter'), { qualification: 'hypothetical-success-only', mintSupply: initialAndFinalBacking,
    sourceBalance: '80992800745259007', poolBalance: '3000000000', delegate: null, delegatedAmount: '0' });
  const expectedCalls = array(fixture.expectedForwardCalls!), word = BigInt(amount).toString(16).padStart(64, '0');
  const calls = array(field(plan, 'legs', 'forward', 'operations')).map(operation => field(operation, 'unsigned'));
  assert.deepEqual(calls, expectedCalls.map((value, index) => { const call = object(value), offset = index === 0 ? 36 : 388, data = text(call.data!);
    return { ...call, data: data.slice(0, 2 + offset * 2) + word + data.slice(2 + (offset + 32) * 2) }; }));
  const expected = object((await json(join(root, 'tests/fixtures/dev-roundtrip-report.json'))).expected);
  const pair = field(plan, 'route', 'pair'); expected.receivers = [{ recipient: field(pair, 'svm', 'recipient'), ata: field(pair, 'svm', 'sourceAta') }];
  const routeHash = text(plan.routeHash!), messages: Json[] = [];
  for (const reverseDirection of [false, true]) {
    const id = '0x' + (reverseDirection ? '2' : '1').repeat(64), direction = reverseDirection ? 'solana-to-ethereum' : 'ethereum-to-solana';
    const identity = { messageId: id, direction, amount, sourceToken: field(pair, reverseDirection ? 'svm' : 'evm', reverseDirection ? 'mint' : 'token'),
      destinationToken: field(pair, reverseDirection ? 'evm' : 'svm', reverseDirection ? 'token' : 'mint'), recipient: field(pair, reverseDirection ? 'evm' : 'svm', 'recipient') };
    function event(chain: string, kind: string, height: string, ordinal: number): Json {
      return { identity, routeHash, chain, kind, transactionId: chain === (reverseDirection ? 'solana' : 'ethereum') ? id : 'destination-' + id,
        eventIndex: ordinal, indexScheme: chain === 'solana' ? 'svm-physical-interleaved-v1' : 'evm-log-index-v1',
        instructionPath: chain === 'solana' ? [1, ordinal] : null, owningInstructionPath: chain === 'solana' ? [1] : null,
        blockHash: 'block-' + chain + '-' + height, blockHeight: height, finality: 'finalized' };
    }
    messages.push({ routeHash, sourceTransaction: id, identity, sequenceNumber: reverseDirection ? '2' : '1', nonce: '0', msgTotalNonce: '1',
      messageHash: '0x' + 'c'.repeat(64), evm: null, svm: null,
      modeledEvents: reverseDirection ? [event('solana', 'burn', '101', 10), event('ethereum', 'release', '202', 152)] :
        [event('ethereum', 'lock', '201', 110), event('solana', 'mint', '100', 5)] });
  }
  const reference = async (name: string): Promise<RecordJson> => { const path = join(previewPath, name + '.json'); return { path, sha256: hash(await readFile(path)) }; };
  const header = { schema: 'agtmai-dev-roundtrip-input-v1', testOnly: true, broadcastAllowed: false, mode: 'local-event-simulation',
    pr1: { plan: await reference('plan'), facts: await reference('facts') }, proof: null, expected, messages,
    snapshot: { totalSupply: fixedSupply, lockedOnEthereum: initialAndFinalBacking, supplyOnSolana: initialAndFinalBacking,
      pendingEthereumToSolana: '0', pendingSolanaToEthereum: '0', ethereum: { height: '300', hash: 'block-ethereum-300' },
      solana: { height: '300', hash: 'block-solana-300' }, observedAt: '2026-09-08T05:04:14.470Z', freshnessCheckedAt: null,
      provenance: 'explicit-simulation', coherent: true, finalized: true }, completeInventory: true, coherent: true, finalized: true, classifications: [] };
  const headerPath = join(workspace, 'report-input.json'), reportPath = join(workspace, 'report'); await writeFile(headerPath, JSON.stringify(header));
  const report = cli('dev-roundtrip-report', ['--input', headerPath, '--output', reportPath, '--provider', provider, '--archives', archives]);
  const reopened = cli('dev-roundtrip-report', ['--reopen', reportPath, '--provider', provider, '--archives', archives]); assert.deepEqual(reopened, report);
  assert.equal(report.status, 'exact-in-model'); assert.equal(report.routeHash, plan.routeHash); assert.equal(report.planHash, plan.planHash);
  assert.equal(field(report, 'monetary', 'reconciliation', 'adjustedGlobalSupply'), fixedSupply); assert.equal(field(report, 'monetary', 'reconciliation', 'backingSurplus'), '0');
  assert.equal(field(report, 'pending', 'P_ES'), '0'); assert.equal(field(report, 'pending', 'P_SE'), '0');
  assert.equal(field(report, 'snapshot', 'freshnessCheckedAt'), null); assert.equal(report.broadcastAllowed, false);
  assert.match(await readFile(join(reportPath, 'summary.md'), 'utf8'), /exact-in-model/);
  async function rejectedReport(arguments_: string[], output: string, reason: RegExp): Promise<void> {
    const result = spawnSync(process.execPath, [join(root, 'src/composition/dev-roundtrip-report.mjs'), ...arguments_, '--output', output], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', TMPDIR: '/tmp' }, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.signal, null); assert.equal(result.status, 1); assert.match(result.stderr, reason); assert.equal(result.stdout, '');
    await assert.rejects(lstat(output), { code: 'ENOENT' });
  }
  await rejectedReport(['--input', headerPath], join(workspace, 'missing-provider-rejected'), /explicitly admitted local provider/);
  // Matching file hashes cannot authorize changed encoded transaction bytes.
  const changed = structuredClone(plan), changedPacket = Buffer.from(text(field(changed, 'legs', 'reverse', 'callPlan', 'candidate', 'transactionBase64')), 'base64');
  changedPacket[65] = 0x81;
  put(changed, ['legs', 'reverse', 'callPlan', 'candidate', 'transactionBase64'], changedPacket.toString('base64'));
  const changedPath = join(workspace, 'changed-plan.json'), changedBytes = JSON.stringify(changed); await writeFile(changedPath, changedBytes);
  const changedHeader = structuredClone(header); changedHeader.pr1.plan = { path: changedPath, sha256: hash(changedBytes) };
  const changedHeaderPath = join(workspace, 'changed-report-input.json'); await writeFile(changedHeaderPath, JSON.stringify(changedHeader));
  await rejectedReport(['--input', changedHeaderPath, '--provider', provider, '--archives', archives], join(workspace, 'changed-bytes-rejected'), /PR1 route\/plan\/facts semantic binding|Reverse encoding/);
});
