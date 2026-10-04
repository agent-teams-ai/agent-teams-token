import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDevProvider } from '../src/adapters/dev-provider-admission.mjs';
import { readDevProviderArchive } from '../src/adapters/dev-provider-archive.mjs';
import { ROOT_HASHES, SELECTED_PACKAGES } from '../src/adapters/dev-provider-policy.mjs';
import { DEV_EVM_EVENT_FRAGMENTS } from '../src/adapters/dev-provider-primitives.mjs';
import { decodeEvmCapture, decodeEvmRawLog, parseEvmCapture, DEV_EVM_TOPICS } from '../src/adapters/dev-evm-event-codec.mjs';

// Standalone pinned Linux Node 24.20 script. No flags, skips, SDK/Anchor import,
// installation, RPC or live clients. Missing preparations fail before evaluation.
const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const goldens = JSON.parse(await readFile(new URL('fixtures/dev-evm-event-goldens.json', import.meta.url), 'utf8'));
const authority = goldens.authority, sha = bytes => createHash('sha256').update(bytes).digest('hex');
const lockBytes = await readFile(join(repo, authority.lockPath));
assert.equal(sha(lockBytes), ROOT_HASHES['package-lock.json']);
assert.equal(authority.lockSha256, ROOT_HASHES['package-lock.json']);
const locked = JSON.parse(lockBytes).packages['node_modules/@chainlink/ccip-sdk'];
assert.equal(locked.version, '1.13.0'); assert.equal(locked.integrity, authority.archiveIntegrity);
const sdkPin = SELECTED_PACKAGES.find(([name]) => name === '@chainlink/ccip-sdk')[1];
const archive = await readFile(join(repo, authority.archivePath));
assert.equal(sha(archive), sdkPin); assert.equal(authority.archiveSha256, sdkPin);
const payload = readDevProviderArchive(archive, locked.integrity);
for (const member of [...Object.values(authority.events), authority.sourceCall, authority.executionCall, ...authority.svmExtraArgs.members]) {
  assert.equal(payload.get(member.path.replace(/^package\//, '')).sha256, member.sha256);
}
// Authenticate source literal data before the first candidate import. This parser
// reads the retained ABI array, never evaluates source or an SDK/Anchor module.
function sourceAbi(member) {
  let text = payload.get(member.path.replace(/^package\//, '')).bytes.toString();
  text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  text = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)
    .replace(/'([^']*)'/g, (_, value) => JSON.stringify(value))
    .replace(/([,{]\s*)([A-Za-z][A-Za-z0-9]*):/g, '$1"$2":').replace(/,\s*([\]}])/g, '$1');
  return JSON.parse(text);
}
for (const [name, selected] of Object.entries(authority.events)) {
  assert.deepEqual(sourceAbi(selected).find(item => item.name === name), selected.fragment);
}
const offRamp = sourceAbi(authority.executionCall);
assert.deepEqual(offRamp.find(item => item.name === 'execute'), authority.executionCall.fragment);
assert.deepEqual(offRamp.find(item => item.name === 'manuallyExecute').inputs[0], authority.executionCall.reportsParameter);
assert.deepEqual(sourceAbi(authority.sourceCall).find(item => item.name === 'ccipSend'), authority.sourceCall.fragment);
const { primitives, evidence } = await loadDevProvider({ root: join(repo, '.local/PREPARED-PROVIDER'), archives: join(repo, '.local/CANDIDATE-AUTHORITY/archives') });
assert.equal(evidence.evaluated, true); assert.equal(evidence.qualification, 'offline-unsigned-primitives');
// Reuses only the already admitted selected ethers ABI closure for an independent
// compatibility oracle. This is not a new provider resolution or SDK entrypoint.
const { Interface, AbiCoder, ParamType } = await import(pathToFileURL(join(repo, '.local/PREPARED-PROVIDER/node_modules/ethers/lib.commonjs/abi/index.js')).href);
const native = new Interface(DEV_EVM_EVENT_FRAGMENTS), coder = AbiCoder.defaultAbiCoder();
const source = new Interface([authority.sourceCall.fragment]), destination = new Interface([authority.executionCall.fragment]);
const load = vector => ({ receipt: parseEvmCapture(vector.receiptResponse), transaction: parseEvmCapture(vector.transactionResponse), selection: structuredClone(vector.selection) });
const eventLog = input => input.receipt.logs.find(log => [DEV_EVM_TOPICS.request, DEV_EVM_TOPICS.execution].includes(log.topics[0]));
const effectLog = input => input.receipt.logs.find(log => log.address === input.selection.token && log.topics[0] === DEV_EVM_TOPICS.transfer);
const wire = log => ({ topics: log.topics, data: log.data });
const word = value => BigInt(value).toString(16).padStart(64, '0');
const replaceWord = (data, index, value, prefix = 2) => data.slice(0, prefix + index * 64) + word(value) + data.slice(prefix + (index + 1) * 64);

await test('constant fragments exactly match independently retained ABI and topic0', () => {
  for (const [name, selected] of Object.entries(authority.events)) {
    const oracle = new Interface([selected.fragment]).getEvent(name), event = native.getEvent(name);
    assert.equal(event.format('full'), oracle.format('full')); assert.equal(event.topicHash, selected.topic0);
  }
  assert.equal(source.getFunction('ccipSend').selector, '0x96f4e9f9');
  assert.equal(destination.getFunction('execute').selector, '0xf58e03fc');
});
for (const vector of goldens.captures) {
  await test(vector.label + ': actual native events/calldata/effects match explicit external semantic DTOs', () => {
    const input = load(vector), log = eventLog(input), parsed = native.parseLog(wire(log));
    const encoded = native.encodeEventLog(parsed.fragment, parsed.args);
    assert.deepEqual(encoded, wire(log));
    assert.deepEqual(decodeEvmCapture(input, primitives), vector.expected);
    const transfer = primitives.decodeEvmEvent(wire(effectLog(input)));
    assert.equal(transfer.name, 'Transfer'); assert.equal(transfer.args[2].toString(), '1000000000');
    if (vector.selection.kind === 'lock') {
      const call = source.decodeFunctionData('ccipSend', input.transaction.input);
      assert.equal(source.encodeFunctionData('ccipSend', call), input.transaction.input);
      assert.equal(call[0].toString(), vector.selection.destChainSelector);
      assert.equal(call[1][2][0][0].toLowerCase(), vector.selection.token);
      assert.equal(call[1][2][0][1].toString(), vector.selection.amount);
      const extra = coder.decode([authority.svmExtraArgs.tuple], call[1][4].slice(10).replace(/^/, '0x'));
      assert.equal(extra[0].tokenReceiver.toLowerCase(), vector.selection.tokenReceiver);
      assert.equal(authority.svmExtraArgs.tag + coder.encode([authority.svmExtraArgs.tuple], extra).slice(2), call[1][4]);
    } else {
      const call = destination.decodeFunctionData('execute', input.transaction.input), type = ParamType.from(authority.executionCall.reportsParameter);
      assert.equal(destination.encodeFunctionData('execute', call), input.transaction.input);
      const reports = coder.decode([type], call[1]); assert.equal(reports[0].length, 1);
      const report = reports[0][0], message = report.messages[0];
      assert.equal(coder.encode([type], reports), call[1]);
      assert.equal(report.messages.length, 1); assert.equal(message.tokenAmounts.length, 1);
      assert.equal(message.header.messageId, vector.selection.messageId);
      assert.equal(message.header.sourceChainSelector.toString(), vector.selection.sourceChainSelector);
      assert.equal(message.receiver.toLowerCase(), vector.selection.receiver);
      assert.equal(message.tokenAmounts[0].destTokenAddress.toLowerCase(), vector.selection.token);
      assert.equal(message.tokenAmounts[0].amount.toString(), vector.selection.amount);
    }
  });
}
// F1: contradictory raw observations previously produced the unchanged success
// DTO even with admitted native primitives. Escaped names collided only after
// JSON.parse had already erased the first result/status/removal observation.
for (const vector of [goldens.captures[0], goldens.captures[2]]) {
  for (const [label, original, contradictory] of [
    ['envelope result', '"result":', '"result":null,"result":'],
    ['escaped envelope result', '"result":', '"result":null,"res\\u0075lt":'],
    ['receipt status', '"status":"0x1"', '"status":"0x0","status":"0x1"'],
    ['escaped receipt status', '"status":"0x1"', '"status":"0x0","sta\\u0074us":"0x1"'],
    ['log removal', '"removed":false', '"removed":true,"removed":false'],
    ['escaped log removal', '"removed":false', '"removed":true,"rem\\u006fved":false'],
  ]) {
    await test(vector.label + ': native capture rejects duplicate ' + label, () => {
      const raw = vector.receiptResponse.replace(original, contradictory);
      assert.notEqual(raw, vector.receiptResponse);
      assert.throws(() => decodeEvmCapture({ receipt: parseEvmCapture(raw), transaction: parseEvmCapture(vector.transactionResponse),
        selection: structuredClone(vector.selection) }, primitives), /duplicate JSON property/);
    });
  }
}
// F2: the authenticated execute ABI is nonpayable, yet the release decoder never
// read transaction.value. Nonzero, missing and malformed observations all yielded
// the unchanged native success DTO. Zero must be present as a canonical quantity.
for (const [label, value] of [['nonzero', '0x1'], ['missing', undefined], ['leading zero', '0x00'], ['malformed', 'malformed'],
  ['number zero', 0], ['number one', 1], ['null', null], ['empty quantity', '0x']]) {
  await test('native nonpayable release rejects ' + label + ' transaction value', () => {
    assert.equal(destination.getFunction('execute').stateMutability, 'nonpayable');
    const input = load(goldens.captures[2]);
    if (value === undefined) { delete input.transaction.value; } else { input.transaction.value = value; }
    assert.throws(() => decodeEvmCapture(input, primitives), label === 'nonzero' ? /nonpayable execute value/ : /canonical RPC quantity/);
  });
}
await test('changed selectors and amounts above 2^53 preserve actual native precision', () => {
  const vector = goldens.captures[0], input = load(vector), event = eventLog(input), effect = effectLog(input);
  const selector = '18446744073709551615', amount = '9007199254740993';
  input.selection.destChainSelector = selector; input.selection.amount = amount;
  event.topics[1] = '0x' + word(selector); event.data = replaceWord(event.data, 3, selector);
  // External canonical tuple head selects token array at byte 832, single
  // dynamic element at byte 896; token amount is element word three (byte 992).
  event.data = replaceWord(event.data, 31, amount);
  effect.data = '0x' + word(amount);
  input.transaction.input = replaceWord(input.transaction.input, 0, selector, 10);
  input.transaction.input = replaceWord(input.transaction.input, 12, amount, 10);
  const dto = decodeEvmCapture(input, primitives);
  assert.equal(dto.event.destChainSelector, selector); assert.equal(dto.call.destChainSelector, selector);
  assert.equal(dto.event.tokenAmounts[0].amount, amount); assert.equal(dto.effect.amount, amount);
  assert.equal(dto.call.tokenAmounts[0].amount, amount);
  const execution = load(goldens.captures[2]), log = eventLog(execution);
  log.topics[1] = '0x' + word(selector);
  assert.equal(decodeEvmRawLog(log, '11155111', primitives).sourceChainSelector, selector);
  execution.selection.sourceChainSelector = selector; execution.selection.amount = amount;
  execution.transaction.input = replaceWord(execution.transaction.input, 7, selector, 10);
  execution.transaction.input = replaceWord(execution.transaction.input, 15, selector, 10);
  execution.transaction.input = replaceWord(execution.transaction.input, 33, amount, 10);
  effectLog(execution).data = '0x' + word(amount);
  const release = decodeEvmCapture(execution, primitives);
  assert.equal(release.call.message.sourceChainSelector, selector);
  assert.equal(release.call.message.tokenAmounts[0].amount, amount);
  assert.equal(release.effect.amount, amount);
});
await test('native event parser rejects trailing, aliased, dirty, unknown and overwide layouts', () => {
  const request = eventLog(load(goldens.captures[0])), execution = eventLog(load(goldens.captures[2]));
  const bad = [
    { ...wire(request), data: request.data + word(0) },
    { ...wire(execution), data: execution.data + '00' },
    { ...wire(request), data: replaceWord(request.data, 2, 1n << 64n) },
    { ...wire(request), data: replaceWord(request.data, 6, 1n << 160n) },
    { ...wire(request), data: replaceWord(request.data, 13, 0xffffffffffffffffn) },
    { ...wire(request), data: replaceWord(request.data, 26, 2) },
    { ...wire(request), topics: [request.topics[0], '0x' + word(1n << 64n), request.topics[2]] },
    { ...wire(request), topics: request.topics.slice(0, 2) },
    { ...wire(execution), data: replaceWord(execution.data, 1, 256) },
    { ...wire(execution), data: replaceWord(execution.data, 2, 0xa0) },
    { ...wire(request), topics: ['0x' + word(123), ...request.topics.slice(1)] },
  ];
  for (const raw of bad) { assert.throws(() => primitives.decodeEvmEvent(raw)); }
  const transfer = effectLog(load(goldens.captures[0]));
  assert.throws(() => primitives.decodeEvmEvent({ topics: [transfer.topics[0], '0x' + word(1n << 160n), transfer.topics[2]], data: transfer.data }));
});
await test('native capture rejects changed payloads, extra tokens, ABI suffixes and unbound execution', () => {
  const sourceMutations = [
    input => { input.transaction.input += word(0); },
    input => { input.transaction.input = replaceWord(input.transaction.input, 10, 2, 10); },
    input => { input.selection.messageId = '0x' + word(1); },
    input => { input.selection.destChainSelector = '1'; },
    input => { input.selection.tokenReceiver = '0x' + word(1); },
    input => { input.transaction.value = '0x0'; },
    input => { eventLog(input).topics[2] = '0x' + word(1); },
  ];
  for (const mutate of sourceMutations) { const input = load(goldens.captures[0]); mutate(input); assert.throws(() => decodeEvmCapture(input, primitives)); }
  const destinationMutations = [
    input => { input.transaction.input += word(0); },
    // OCR execute: four outer head/length words; reports start at argument word 4.
    input => { input.transaction.input = replaceWord(input.transaction.input, 5, 2, 10); },
    input => { input.transaction.input = replaceWord(input.transaction.input, 12, 2, 10); },
    input => { input.transaction.input = replaceWord(input.transaction.input, 27, 2, 10); },
    input => { input.transaction.input = replaceWord(input.transaction.input, 21, 1n << 160n, 10); },
    input => { input.transaction.input = replaceWord(input.transaction.input, 18, 1n << 64n, 10); },
    input => { input.transaction.to = input.selection.pool; input.receipt.to = input.selection.pool; },
    input => { eventLog(input).data = replaceWord(eventLog(input).data, 1, 3); },
  ];
  for (const mutate of destinationMutations) { const input = load(goldens.captures[2]); mutate(input); assert.throws(() => decodeEvmCapture(input, primitives)); }
});
