import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeEvmCapture, decodeEvmRawLog, decodeErc20Transfer, parseEvmCapture, readEvmCaptureFile,
  compareEvmEventProvenance, DEV_EVM_INPUT_BOUNDS, DEV_EVM_TOPICS } from '../src/adapters/dev-evm-event-codec.mjs';

const goldens = JSON.parse(await readFile(new URL('fixtures/dev-evm-event-goldens.json', import.meta.url), 'utf8'));
const load = vector => ({ receipt: parseEvmCapture(vector.receiptResponse), transaction: parseEvmCapture(vector.transactionResponse), selection: structuredClone(vector.selection) });
const eventLog = input => input.receipt.logs.find(log => [DEV_EVM_TOPICS.request, DEV_EVM_TOPICS.execution].includes(log.topics[0]));
const effectLog = input => input.receipt.logs.find(log => log.address === input.selection.token && log.topics[0] === DEV_EVM_TOPICS.transfer);
const changedAddress = '0x' + '11'.repeat(20), changedHash = '0x' + '11'.repeat(32);
const expectedArgs = event => event.kind === 'execution' ?
  [event.sourceChainSelector, event.sequenceNumber, event.messageId, event.messageHash, event.state, event.returnData, event.gasUsed] :
  [event.destChainSelector, event.sequenceNumber, [[event.messageId, event.sourceChainSelector, event.destChainSelector, event.sequenceNumber, event.nonce],
    event.sender, event.data, event.receiver, event.extraArgs, event.feeToken, event.feeTokenAmount, event.feeValueJuels,
    event.tokenAmounts.map(t => [t.sourcePoolAddress, t.destTokenAddress, t.extraData, t.amount, t.destExecData])]];

// Explicit independently transcribed decoded values test orchestration, not ABI wire
// compatibility. The native suite supplies actual admitted ethers; Transfer below
// always uses the real narrow raw-byte reader, including in these orchestration cases.
function orchestrationProvider(vector, decoded = vector.expected.event) {
  const input = load(vector), raw = eventLog(input), expectedCall = vector.expected.call;
  return {
    decodeEvmEvent(wire) {
      assert.deepEqual(wire, { topics: raw.topics, data: raw.data });
      return { name: decoded.kind === 'request' ? 'CCIPMessageSent' : 'ExecutionStateChanged', args: expectedArgs(decoded) };
    },
    decodeEvmCall(wire) {
      assert.equal(wire, input.transaction.input);
      return { name: 'ccipSend', args: [expectedCall.destChainSelector,
        [expectedCall.receiver, expectedCall.data, expectedCall.tokenAmounts.map(t => [t.token, t.amount]), expectedCall.feeToken, expectedCall.extraArgs]] };
    },
    encodeCcipSend(selector, message) {
      assert.equal(selector, expectedCall.destChainSelector);
      const { name: _name, destChainSelector: _destChainSelector, svmExtraArgs: _svmExtraArgs, ...fields } = expectedCall;
      assert.deepEqual(message, fields);
      return input.transaction.input;
    },
  };
}
function refuses(vector, change, pattern) {
  const input = load(vector); change(input);
  assert.throws(() => decodeEvmCapture(input, orchestrationProvider(vector)), pattern);
}
function deeplyFrozen(value) {
  if (value && typeof value === 'object') { assert(Object.isFrozen(value)); for (const item of Object.values(value)) { deeplyFrozen(item); } }
}

for (const vector of goldens.captures) {
  test(vector.label + ': complete immutable external response bytes and native ERC20 DTO', () => {
    for (const part of ['receipt', 'transaction']) {
      assert.equal(createHash('sha256').update(vector[part + 'Response']).digest('hex'), vector[part + 'Sha256']);
    }
    const input = load(vector), dto = decodeErc20Transfer(effectLog(input), '11155111');
    const { messageId: _messageId, ...expected } = vector.expected.effect;
    assert.deepEqual(dto, { ...expected, kind: 'erc20-transfer' }); deeplyFrozen(dto);
  });
  test(vector.label + ': generic orchestration matches independent expected DTOs', () => {
    const decoded = decodeEvmCapture(load(vector), orchestrationProvider(vector));
    assert.deepEqual(decoded, vector.expected); deeplyFrozen(decoded);
    assert(decoded.unknown.includes('historical-authorization')); assert(decoded.unknown.includes('fresh-finalized-state'));
  });
}
const lock = goldens.captures[0], release = goldens.captures[2];
// F1: JSON.parse used to discard the first observation. These contradictory raw
// envelopes, receipt statuses and log removal flags therefore passed admission;
// escaped spellings name the same property after JSON string decoding.
const duplicateObservations = [
  ['envelope result', '"result":', '"result":null,"result":'],
  ['escaped envelope result', '"result":', '"result":null,"res\\u0075lt":'],
  ['receipt status', '"status":"0x1"', '"status":"0x0","status":"0x1"'],
  ['escaped receipt status', '"status":"0x1"', '"status":"0x0","sta\\u0074us":"0x1"'],
  ['log removal', '"removed":false', '"removed":true,"removed":false'],
  ['escaped log removal', '"removed":false', '"removed":true,"rem\\u006fved":false'],
];
for (const [label, original, contradictory] of duplicateObservations) {
  test('raw capture rejects duplicate ' + label + ' observations', () => {
    for (const vector of [lock, release]) {
      const raw = vector.receiptResponse.replace(original, contradictory);
      assert.notEqual(raw, vector.receiptResponse);
      for (const input of [raw, Buffer.from(raw)]) { assert.throws(() => parseEvmCapture(input), /duplicate JSON property/); }
    }
  });
}
// F1 also discarded contradictory transaction values and duplicate names in
// nested objects unrelated to selected logs; rejecting only known fields is unsafe.
test('raw transaction rejects an escaped duplicate value observation', () => {
  const raw = release.transactionResponse.replace('"value":"0x0"', '"value":"0x1","val\\u0075e":"0x0"');
  assert.notEqual(raw, release.transactionResponse);
  assert.throws(() => parseEvmCapture(raw), /duplicate JSON property/);
});
test('raw capture rejects duplicate names in every nested object', () => {
  for (const members of ['"x":1,"\\u0078":2', '"__proto__":null,"__proto__":{}', '"":1,"":2']) {
    const raw = '{"jsonrpc":"2.0","result":{"extra":[{"child":{' + members + '}}]}}';
    assert.throws(() => parseEvmCapture(raw), /duplicate JSON property/);
  }
});
// The old raw parser also allowed arbitrarily deep ignored metadata and numeric
// overflow to Infinity. The duplicate-name traversal must keep admission bounded.
test('raw capture rejects excessive metadata depth', () => {
  assert.throws(() => parseEvmCapture('{"jsonrpc":"2.0","result":{"extra":' + '['.repeat(25) + '0' + ']'.repeat(25) + '}}'), /JSON nesting bound/);
});
test('raw capture rejects nonfinite metadata numbers', () => {
  for (const value of ['1e400', '-1e400']) {
    assert.throws(() => parseEvmCapture('{"jsonrpc":"2.0","result":{"extra":' + value + '}}'), /nonfinite JSON number/);
  }
});
// Companion controls: names repeat across object scopes, not within one object;
// quotes, braces and escaped backslashes inside values are ordinary string data.
test('raw capture preserves JSON string values, independent scopes and finite metadata', () => {
  const result = { extra: [{ status: 'quotes " braces {} backslash \\ and literal \\u0074' }, { status: 'other' }], value: 1.5, tiny: 1e-9 };
  const raw = JSON.stringify({ jsonrpc: '2.0', result });
  assert.deepEqual(parseEvmCapture(raw), result);
  assert.deepEqual(parseEvmCapture(Buffer.from(raw)), result);
  const atBound = raw + ' '.repeat(DEV_EVM_INPUT_BOUNDS.captureBytes - Buffer.byteLength(raw));
  assert.deepEqual(parseEvmCapture(atBound), result);
  assert.throws(() => parseEvmCapture(atBound + ' '), /capture byte bound/);
  for (const malformed of ['{"jsonrpc":"2.0","result":{"extra":truefalse}}', '{"jsonrpc":"2.0","result":{"extra":[1,]}}',
    '{"jsonrpc":"2.0","result":{"extra":"\\uZZZZ"}}', raw + '{}']) { assert.throws(() => parseEvmCapture(malformed)); }
});
test('identical amount and recipient in an unrelated token or wrong receipt is not selected', () => {
  for (const vector of [lock, release]) {
    refuses(vector, input => { effectLog(input).address = changedAddress; }, /selected ERC20 effect missing/);
    refuses(vector, input => { effectLog(input).transactionHash = changedHash; }, /log transaction mismatch/);
    refuses(vector, input => { effectLog(input).topics[1] = '0x' + changedAddress.slice(2).padStart(64, '0'); }, /selected ERC20 effect missing/);
    refuses(vector, input => { effectLog(input).topics[2] = '0x' + changedAddress.slice(2).padStart(64, '0'); }, /selected ERC20 effect missing/);
    refuses(vector, input => { effectLog(input).data = '0x' + '0'.repeat(63) + '1'; }, /selected ERC20 amount/);
    refuses(vector, input => { const copy = structuredClone(effectLog(input)); copy.logIndex = '0xffff'; input.receipt.logs.push(copy); }, /selected ERC20 effect missing\/conflicting/);
  }
});
test('CCIP physical duplicates, missing events and unselected emitters fail closed', () => {
  for (const vector of [lock, release]) {
    refuses(vector, input => { const copy = structuredClone(eventLog(input)); input.receipt.logs.push(copy); }, /duplicate\/conflicting physical log/);
    refuses(vector, input => { const copy = structuredClone(eventLog(input)); copy.logIndex = '0xffff'; input.receipt.logs.push(copy); }, /unique CCIP event/);
    refuses(vector, input => { input.receipt.logs = input.receipt.logs.filter(log => log !== eventLog(input)); }, /unique CCIP event/);
    refuses(vector, input => { input.selection[input.selection.kind === 'lock' ? 'onRamp' : 'offRamp'] = changedAddress; }, /selected OnRamp\/OffRamp/);
  }
});
test('failed/removed/unbound receipt observations cannot become captured consistency', () => {
  const mutations = [
    [input => { input.receipt.status = '0x0'; }, /receipt status/],
    [input => { effectLog(input).removed = true; }, /removed/],
    [input => { delete effectLog(input).removed; }, /removal observation/],
    [input => { input.transaction.hash = changedHash; }, /receipt transaction/],
    [input => { input.selection.transactionHash = changedHash; }, /selected transaction/],
    [input => { input.transaction.blockHash = changedHash; }, /receipt\/transaction blockHash/],
    [input => { effectLog(input).blockHash = changedHash; }, /log block hash/],
    [input => { effectLog(input).blockNumber = '0x1'; }, /log block height/],
    [input => { effectLog(input).transactionIndex = '0x1'; }, /log transaction index/],
    [input => { input.selection.blockHash = changedHash; }, /selected blockHash/],
    [input => { input.transaction.chainId = '0x1'; }, /selected chain/],
    [input => { input.receipt.from = changedAddress; }, /receipt sender/],
    [input => { effectLog(input).logIndex = '0x01'; }, /RPC quantity/],
    [input => { effectLog(input).logIndex = 1; }, /RPC quantity/],
  ];
  for (const [change, pattern] of mutations) { refuses(lock, change, pattern); }
});
test('source sender/router and selected receiver are bound independently of discovery', () => {
  for (const [field, pattern] of [['sourceSender', /selected source sender/], ['router', /selected router/]]) {
    refuses(lock, input => { input.selection[field] = changedAddress; }, pattern);
  }
  refuses(lock, input => { input.selection.receiver = changedHash; }, /selected receiver/);
  refuses(lock, input => { input.selection.extraArgs = '0x'; }, /selected receiver extraArgs/);
  refuses(release, input => { input.selection.receiver = changedAddress; }, /selected release receiver/);
  refuses(release, input => { input.selection.remotePool = changedHash; }, /remote pool/);
  refuses(release, input => { input.selection.executor = changedAddress; }, /executor/);
});
test('provider decoded fields still require exact message, width, token and state bindings', () => {
  for (const [field, value, pattern] of [['messageId', changedHash, /selected messageId/], ['sender', changedAddress, /request sender/],
    ['sourceChainSelector', '18446744073709551616', /uint64/]]) {
    const event = { ...lock.expected.event, [field]: value };
    assert.throws(() => decodeEvmCapture(load(lock), orchestrationProvider(lock, event)), pattern);
  }
  const extraToken = structuredClone(lock.expected.event); extraToken.tokenAmounts.push(extraToken.tokenAmounts[0]);
  assert.throws(() => decodeEvmCapture(load(lock), orchestrationProvider(lock, extraToken)), /cardinality/);
  const failed = { ...release.expected.event, state: '3' };
  assert.throws(() => decodeEvmCapture(load(release), orchestrationProvider(release, failed)), /execution state/);
});
test('strict raw Transfer widths, unknown event topics and local input bounds', () => {
  const original = effectLog(load(lock));
  for (const change of [log => { log.topics.push(changedHash); }, log => { log.data += '00'; },
    log => { log.topics[1] = '0x1' + log.topics[1].slice(3); }, log => { log.address = '0x1234'; }]) {
    const log = structuredClone(original); change(log); assert.throws(() => decodeErc20Transfer(log, '11155111'));
  }
  const unknown = structuredClone(original); unknown.topics[0] = changedHash;
  assert.throws(() => decodeEvmRawLog(unknown, '11155111', {}), /unknown event/);
  refuses(lock, input => { effectLog(input).topics = Array(5).fill(changedHash); }, /topic bound/);
  refuses(lock, input => { effectLog(input).data = '0x' + '00'.repeat(DEV_EVM_INPUT_BOUNDS.dataBytes + 1); }, /byte width\/bound/);
  refuses(lock, input => { input.receipt.logs = Array(1025).fill(effectLog(input)); }, /log bound/);
  assert.throws(() => parseEvmCapture(' '.repeat(DEV_EVM_INPUT_BOUNDS.captureBytes + 1)), /capture byte bound/);
  assert.throws(() => parseEvmCapture('{"jsonrpc":"2.0","result":null}'), /record required/);
  assert.throws(() => parseEvmCapture('{"jsonrpc":"2.0","result":{},"error":{}}'), /capture envelope/);
});
test('physical identity is independent of block provenance and exposes conflicts', () => {
  const log = effectLog(load(lock)), first = decodeErc20Transfer(log, '11155111');
  const replay = decodeErc20Transfer(log, '11155111'); assert.equal(compareEvmEventProvenance(first, replay), null);
  const moved = decodeErc20Transfer({ ...log, blockHash: changedHash, blockNumber: '0x1' }, '11155111');
  assert.equal(moved.physicalKey, first.physicalKey);
  assert.deepEqual(compareEvmEventProvenance(first, moved).changed, ['blockHash', 'blockNumber']);
});
test('file bound precedes allocation and captured file parser uses complete bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-evm-capture-'));
  try {
    const path = join(root, 'receipt.json'); await writeFile(path, lock.receiptResponse);
    assert.deepEqual(await readEvmCaptureFile(path), parseEvmCapture(lock.receiptResponse));
    await writeFile(path, ' '.repeat(DEV_EVM_INPUT_BOUNDS.captureBytes + 1));
    await assert.rejects(readEvmCaptureFile(path), /file bound\/type/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
// F1 reached the descriptor-based file path as well: contradictory removal
// observations on disk were silently reduced to the final false value.
test('capture file rejects contradictory escaped removal observations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-evm-duplicate-'));
  try {
    const raw = lock.receiptResponse.replace('"removed":false', '"removed":true,"rem\\u006fved":false');
    assert.notEqual(raw, lock.receiptResponse);
    const path = join(root, 'receipt.json'); await writeFile(path, raw);
    await assert.rejects(readEvmCaptureFile(path), /duplicate JSON property/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
