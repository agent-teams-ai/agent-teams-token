import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

// Local input bounds, not protocol limits or a finality/authorization policy.
export const DEV_EVM_INPUT_BOUNDS = Object.freeze({ captureBytes: 262144, logs: 1024, dataBytes: 65536, topics: 4, calldataBytes: 16384 });
export const DEV_EVM_TOPICS = Object.freeze({
  request: '0x192442a2b2adb6a7948f097023cb6b57d29d3a7a5dd33e6666d33c39cc456f32',
  execution: '0x05665fe9ad095383d018353f4cbcba77e84db27dd215081bbf7cdf9ae6fbe48b',
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
});
const fail = reason => { throw new Error('DEV EVM capture: ' + reason); };
const equal = (actual, expected, label) => { if (actual !== expected) { fail(label + ' mismatch'); } };
function object(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) { fail('record required'); }
  return value;
}
function uint(value, bits = 256) {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || value.length > 78 || !/^(0|[1-9][0-9]*)$/.test(value))) {
    fail('canonical uint' + bits + ' required');
  }
  const integer = BigInt(value);
  if (integer < 0n || integer >= 1n << BigInt(bits)) { fail('canonical uint' + bits + ' required'); }
  return integer.toString();
}
function quantity(value) {
  if (typeof value !== 'string' || value.length > 66 || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) { fail('canonical RPC quantity required'); }
  return BigInt(value).toString();
}
function hex(value, maximum = DEV_EVM_INPUT_BOUNDS.dataBytes, width) {
  if (typeof value !== 'string' || value.length > maximum * 2 + 2 || !/^0x(?:[a-fA-F0-9]{2})*$/.test(value) ||
      (width !== undefined && value.length !== width * 2 + 2)) { fail('byte width/bound'); }
  return value.toLowerCase();
}
const address = value => hex(value, 20, 20);
const hash = value => hex(value, 32, 32);
function tuple(value, size) {
  if (!Array.isArray(value) || value.length !== size) { fail('selected tuple/array cardinality'); }
  return value;
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) { freeze(child); } Object.freeze(value); }
  return value;
}

/** Read a regular local capture after checking its size, with a bounded read even
 * if it grows. This authenticates no RPC, chain, historical authority or finality. */
export async function readEvmCaptureFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > DEV_EVM_INPUT_BOUNDS.captureBytes) { fail('capture file bound/type'); }
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) { break; } length += read.bytesRead;
    }
    if (length !== stat.size || (await file.stat()).size !== stat.size) { fail('capture changed during read'); }
    return parseEvmCapture(bytes.subarray(0, length));
  } finally { await file.close(); }
}
// Adapt the feature-local preview reader's bounded member walk, without its
// preview schema/cardinality rules. Validate every decoded name before JSON.parse
// can overwrite it; materialization retains ordinary capture record prototypes.
function validateCaptureJson(text) {
  let i = 0;
  const space = () => { while (i < text.length && /[ \t\r\n]/.test(text[i])) { i++; } };
  const str = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') { return JSON.parse(text.slice(start, i)); }
    }
    fail('unterminated JSON string');
  };
  const collection = (depth, ch) => {
    const record = ch === '{', end = record ? '}' : ']', seen = new Set(); i++; space();
    if (text[i] === end) { i++; return; }
    while (i < text.length) {
      space();
      if (record) {
        if (text[i] !== '"') { fail('JSON property required'); }
        const name = str(); space();
        if (seen.has(name)) { fail('duplicate JSON property'); } seen.add(name);
        if (text[i++] !== ':') { fail('JSON colon required'); }
      }
      value(depth + 1);
      space(); const next = text[i++]; if (next === end) { return; }
      if (next !== ',') { fail('JSON delimiter required'); }
    }
    fail('unterminated JSON collection');
  };
  const value = depth => {
    if (depth > 24) { fail('JSON nesting bound'); }
    space(); const ch = text[i];
    if (ch === '"') { str(); return; }
    if (ch === '{' || ch === '[') { collection(depth, ch); return; }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    if (!token) { fail('invalid JSON value'); }
    i += token[0].length; const result = JSON.parse(token[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) { fail('nonfinite JSON number'); }
  };
  value(0); space(); if (i !== text.length) { fail('trailing JSON bytes'); }
}
export function parseEvmCapture(raw) {
  if ((typeof raw !== 'string' && !Buffer.isBuffer(raw)) ||
      (typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length) > DEV_EVM_INPUT_BOUNDS.captureBytes) { fail('capture byte bound'); }
  const text = raw.toString(); validateCaptureJson(text);
  const envelope = object(JSON.parse(text));
  if (envelope.jsonrpc !== '2.0' || Object.hasOwn(envelope, 'error') || !Object.hasOwn(envelope, 'result')) { fail('RPC capture envelope'); }
  return object(envelope.result);
}
function logBytes(log) {
  object(log);
  if (log.removed !== false) { fail('removed or missing removal observation'); }
  if (!Array.isArray(log.topics) || !log.topics.length || log.topics.length > DEV_EVM_INPUT_BOUNDS.topics) { fail('log topic bound'); }
  return { topics: log.topics.map(hash), data: hex(log.data) };
}
function identity(log, chainId) {
  const transactionHash = hash(log.transactionHash), logIndex = quantity(log.logIndex);
  const chain = uint(chainId);
  return { physicalKey: chain + ':' + transactionHash + ':' + logIndex, chainId: chain, transactionHash, logIndex,
    blockHash: hash(log.blockHash), blockNumber: quantity(log.blockNumber), transactionIndex: quantity(log.transactionIndex), address: address(log.address) };
}
function addressWord(word) {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(word)) { fail('noncanonical address word'); }
  return '0x' + word.slice(-40);
}

/** Narrow ERC20 Transfer wire reader used by the default offline suite as well. */
export function decodeErc20Transfer(log, chainId) {
  const wire = logBytes(log);
  equal(wire.topics[0], DEV_EVM_TOPICS.transfer, 'Transfer topic');
  if (wire.topics.length !== 3 || wire.data.length !== 66) { fail('Transfer topic/data cardinality'); }
  return freeze({ kind: 'erc20-transfer', ...identity(log, chainId), from: addressWord(wire.topics[1]),
    to: addressWord(wire.topics[2]), amount: BigInt(wire.data).toString() });
}

/** The provider is the feature-private admitted primitive, not a client or SDK. */
export function decodeEvmRawLog(log, chainId, primitives) {
  const wire = logBytes(log), id = identity(log, chainId);
  if (wire.topics[0] === DEV_EVM_TOPICS.transfer) { return decodeErc20Transfer(log, chainId); }
  const kind = wire.topics[0] === DEV_EVM_TOPICS.request ? 'request' : wire.topics[0] === DEV_EVM_TOPICS.execution ? 'execution' : null;
  if (!kind) { fail('unknown event topic'); }
  if (wire.topics.length !== (kind === 'request' ? 3 : 4)) { fail('event topic cardinality'); }
  const decoded = primitives.decodeEvmEvent(wire);
  if (kind === 'execution') {
    equal(decoded.name, 'ExecutionStateChanged', 'event name');
    const a = tuple(decoded.args, 7), state = uint(a[4], 8);
    if (BigInt(state) > 3n) { fail('unknown execution state'); }
    return freeze({ kind, ...id, sourceChainSelector: uint(a[0], 64), sequenceNumber: uint(a[1], 64),
      messageId: hash(a[2]), messageHash: hash(a[3]), state, returnData: hex(a[5]), gasUsed: uint(a[6]) });
  }
  equal(decoded.name, 'CCIPMessageSent', 'event name');
  const a = tuple(decoded.args, 3), m = tuple(a[2], 9), h = tuple(m[0], 5), t = tuple(tuple(m[8], 1)[0], 5);
  equal(uint(a[0], 64), uint(h[2], 64), 'event/header destination selector');
  equal(uint(a[1], 64), uint(h[3], 64), 'event/header sequence');
  return freeze({ kind, ...id, messageId: hash(h[0]), sourceChainSelector: uint(h[1], 64), destChainSelector: uint(h[2], 64),
    sequenceNumber: uint(h[3], 64), nonce: uint(h[4], 64), sender: address(m[1]), data: hex(m[2]), receiver: hex(m[3]), extraArgs: hex(m[4]),
    feeToken: address(m[5]), feeTokenAmount: uint(m[6]), feeValueJuels: uint(m[7]),
    tokenAmounts: [{ sourcePoolAddress: address(t[0]), destTokenAddress: hex(t[1]), extraData: hex(t[2]), amount: uint(t[3]), destExecData: hex(t[4]) }] });
}

// Fixed, bounded byte access for selected calldata; every pointer must equal the
// next canonical tail. OffRamp report type is Internal.ExecutionReport[] from
// the same authenticated OffRamp_1_6.ts manuallyExecute ABI (no SDK code).
function reader(raw) {
  const data = hex(raw, DEV_EVM_INPUT_BOUNDS.calldataBytes), size = (data.length - 2) / 2;
  const word = (at, bits = 256) => {
    if (!Number.isInteger(at) || at < 0 || at % 32 || at + 32 > size) { fail('calldata word bound'); }
    const value = BigInt('0x' + data.slice(2 + at * 2, 2 + (at + 32) * 2));
    if (value >= 1n << BigInt(bits)) { fail('noncanonical calldata uint width'); }
    return value;
  };
  const bytes = at => {
    const length = word(at);
    if (length > BigInt(size)) { fail('calldata bytes length bound'); }
    const end = at + 32 + Math.ceil(Number(length) / 32) * 32;
    if (end > size) { fail('calldata bytes range'); }
    const padding = data.slice(2 + (at + 32 + Number(length)) * 2, 2 + end * 2);
    if (/[^0]/.test(padding)) { fail('noncanonical calldata padding'); }
    return { value: '0x' + data.slice(2 + (at + 32) * 2, 2 + (at + 32 + Number(length)) * 2), end };
  };
  return { word, bytes, size,
    hash: at => { word(at); return '0x' + data.slice(2 + at * 2, 2 + (at + 32) * 2); },
    pointer: (at, base, expected) => equal(word(at), BigInt(expected - base), 'canonical calldata offset'),
    single: at => { equal(word(at), 1n, 'single calldata element'); equal(word(at + 32), 32n, 'single tuple offset'); return at + 64; } };
}
// SDK extra-args.ts selects the SVMExtraArgsV1 tuple; a dynamic tuple starts
// with its own offset word. Only this retained source-call layout is supported.
function svmExtraArgs(input) {
  const wire = hex(input, DEV_EVM_INPUT_BOUNDS.calldataBytes);
  equal(wire.slice(0, 10), '0x1f3b3aba', 'selected SVM extraArgs tag');
  const r = reader('0x' + wire.slice(10));
  r.pointer(0, 0, 32); r.pointer(160, 32, 192);
  const count = r.word(192);
  if (count > 64n) { fail('local SVM extraArgs account bound'); }
  equal(224 + Number(count) * 32, r.size, 'SVM extraArgs end');
  const bool = r.word(96, 8);
  if (bool > 1n) { fail('noncanonical SVM extraArgs bool'); }
  return { computeUnits: r.word(32, 32).toString(), accountIsWritableBitmap: r.word(64, 64).toString(),
    allowOutOfOrderExecution: bool === 1n, tokenReceiver: r.hash(128),
    accounts: Array.from({ length: Number(count) }, (_, i) => r.hash(224 + i * 32)) };
}
function sourceCall(input, primitives) {
  const wire = hex(input, DEV_EVM_INPUT_BOUNDS.calldataBytes);
  equal(wire.slice(0, 10), '0x96f4e9f9', 'ccipSend selector');
  const r = reader('0x' + wire.slice(10));
  r.word(0, 64); r.pointer(32, 0, 64);
  const offset = r.word(64 + 64);
  if (offset > BigInt(r.size) || offset % 32n) { fail('source token array bound'); }
  equal(r.word(64 + Number(offset)), 1n, 'single source token');
  const decoded = primitives.decodeEvmCall(wire);
  equal(decoded.name, 'ccipSend', 'source call');
  const args = tuple(decoded.args, 2), m = tuple(args[1], 5), t = tuple(tuple(m[2], 1)[0], 2);
  const message = { receiver: hex(m[0]), data: hex(m[1]), tokenAmounts: [{ token: address(t[0]), amount: uint(t[1]) }], feeToken: address(m[3]), extraArgs: hex(m[4]) };
  const selector = uint(args[0], 64);
  equal(primitives.encodeCcipSend(selector, message).toLowerCase(), wire, 'canonical source calldata');
  return { name: 'ccipSend', destChainSelector: selector, ...message, svmExtraArgs: svmExtraArgs(message.extraArgs) };
}
function executionCall(input) {
  const wire = hex(input, DEV_EVM_INPUT_BOUNDS.calldataBytes);
  equal(wire.slice(0, 10), '0xf58e03fc', 'selected OffRamp execute selector');
  const outer = reader('0x' + wire.slice(10));
  outer.pointer(64, 0, 96);
  const report = outer.bytes(96);
  equal(report.end, outer.size, 'execute calldata end');
  const r = reader(report.value);
  r.pointer(0, 0, 32);
  const base = r.single(32), source = r.word(base, 64).toString();
  r.pointer(base + 32, base, base + 160);
  const msg = r.single(base + 160);
  r.pointer(msg + 160, msg, msg + 320);
  const sender = r.bytes(msg + 320);
  r.pointer(msg + 192, msg, sender.end);
  const data = r.bytes(sender.end);
  r.pointer(msg + 288, msg, data.end);
  const token = r.single(data.end);
  r.pointer(token, token, token + 160);
  const pool = r.bytes(token + 160);
  r.pointer(token + 96, token, pool.end);
  const extra = r.bytes(pool.end);
  r.pointer(base + 64, base, extra.end);
  const offchain = r.single(extra.end), tokenData = r.single(offchain);
  const attestation = r.bytes(tokenData);
  r.pointer(base + 96, base, attestation.end);
  const proofCount = r.word(attestation.end);
  if (proofCount > 32n) { fail('local proof array bound'); }
  const end = attestation.end + 32 + Number(proofCount) * 32;
  equal(end, r.size, 'execution report end');
  const message = { messageId: r.hash(msg), sourceChainSelector: r.word(msg + 32, 64).toString(), destChainSelector: r.word(msg + 64, 64).toString(),
    sequenceNumber: r.word(msg + 96, 64).toString(), nonce: r.word(msg + 128, 64).toString(), sender: sender.value, data: data.value,
    receiver: addressWord(r.hash(msg + 224)), gasLimit: r.word(msg + 256).toString(),
    tokenAmounts: [{ sourcePoolAddress: pool.value, destTokenAddress: addressWord(r.hash(token + 32)), destGasAmount: r.word(token + 64, 32).toString(), extraData: extra.value, amount: r.word(token + 128).toString() }] };
  equal(source, message.sourceChainSelector, 'report/message source selector');
  return { name: 'execute', sourceChainSelector: source, message, offchainTokenData: [[attestation.value]],
    proofs: Array.from({ length: Number(proofCount) }, (_, i) => r.hash(attestation.end + 32 + i * 32)), proofFlagBits: r.word(base + 128).toString() };
}

function context(receipt, transaction, selection) {
  object(receipt); object(transaction); object(selection);
  equal(receipt.status, '0x1', 'successful receipt status');
  const chain = uint(selection.chainId);
  equal(quantity(transaction.chainId), chain, 'selected chain');
  for (const field of ['blockHash', 'blockNumber', 'transactionIndex']) {
    const decode = field === 'blockHash' ? hash : quantity;
    equal(decode(receipt[field]), decode(transaction[field]), 'receipt/transaction ' + field);
  }
  equal(hash(receipt.transactionHash), hash(transaction.hash), 'receipt transaction');
  equal(hash(transaction.hash), hash(selection.transactionHash), 'selected transaction');
  equal(address(receipt.from), address(transaction.from), 'receipt sender');
  equal(address(receipt.to), address(transaction.to), 'receipt target');
  // Separately supplied capture anchors bind this observation, without certifying them.
  for (const field of ['blockHash', 'blockNumber']) {
    if (selection[field] !== undefined) { equal(field === 'blockHash' ? hash(receipt[field]) : quantity(receipt[field]),
      field === 'blockHash' ? hash(selection[field]) : uint(selection[field]), 'selected ' + field); }
  }
  hex(transaction.input, DEV_EVM_INPUT_BOUNDS.calldataBytes);
  if (!Array.isArray(receipt.logs) || receipt.logs.length > DEV_EVM_INPUT_BOUNDS.logs) { fail('receipt log bound'); }
  const indexes = new Set();
  for (const log of receipt.logs) {
    logBytes(log); const id = identity(log, chain);
    equal(id.transactionHash, hash(transaction.hash), 'log transaction');
    equal(id.blockHash, hash(receipt.blockHash), 'log block hash');
    equal(id.blockNumber, quantity(receipt.blockNumber), 'log block height');
    equal(id.transactionIndex, quantity(receipt.transactionIndex), 'log transaction index');
    if (indexes.has(id.logIndex)) { fail('duplicate/conflicting physical log'); } indexes.add(id.logIndex);
  }
  return chain;
}

/** Validate selected captured consistency only. Route selection is caller context;
 * it never becomes SDK discovery, historical authorization, or fresh finality. */
export function decodeEvmCapture({ receipt, transaction, selection }, primitives) {
  const chain = context(receipt, transaction, selection);
  if (!['lock', 'release'].includes(selection.kind)) { fail('selected effect kind'); }
  const topic = selection.kind === 'lock' ? DEV_EVM_TOPICS.request : DEV_EVM_TOPICS.execution;
  const logs = receipt.logs.filter(log => log.topics[0].toLowerCase() === topic);
  if (logs.length !== 1) { fail('exact unique CCIP event missing/conflicting'); }
  const event = decodeEvmRawLog(logs[0], chain, primitives), expectedEmitter = selection.kind === 'lock' ? selection.onRamp : selection.offRamp;
  equal(event.address, address(expectedEmitter), 'selected OnRamp/OffRamp');
  for (const field of ['messageId', 'sourceChainSelector', 'sequenceNumber']) {
    equal(event[field], field === 'messageId' ? hash(selection[field]) : uint(selection[field], 64), 'selected ' + field);
  }
  const pool = address(selection.pool), token = address(selection.token), amount = uint(selection.amount);
  let call, from, to;
  if (selection.kind === 'lock') {
    from = address(selection.sourceSender); to = pool;
    equal(address(transaction.from), from, 'selected source sender');
    equal(address(transaction.to), address(selection.router), 'selected router');
    equal(event.sender, from, 'request sender');
    call = sourceCall(transaction.input, primitives);
    equal(call.destChainSelector, uint(selection.destChainSelector, 64), 'selected destination selector');
    for (const field of ['destChainSelector', 'receiver', 'data', 'extraArgs']) { equal(event[field], call[field], 'request/calldata ' + field); }
    equal(event.receiver, hex(selection.receiver), 'selected receiver');
    if (selection.tokenReceiver !== undefined) { equal(call.svmExtraArgs.tokenReceiver, hash(selection.tokenReceiver), 'selected SVM token receiver'); }
    if (selection.extraArgs !== undefined) { equal(call.extraArgs, hex(selection.extraArgs), 'selected receiver extraArgs'); }
    if (call.feeToken === '0x' + '0'.repeat(40)) {
      equal(event.feeTokenAmount, quantity(transaction.value), 'native fee value');
      if (selection.nativeFeeToken !== undefined) { equal(event.feeToken, address(selection.nativeFeeToken), 'selected wrapped native fee token'); }
    } else {
      equal(event.feeToken, call.feeToken, 'selected fee token');
      equal(quantity(transaction.value), '0', 'token fee call value');
    }
    equal(call.tokenAmounts[0].token, token, 'selected source token');
    equal(call.tokenAmounts[0].amount, amount, 'selected calldata amount');
    equal(event.tokenAmounts[0].sourcePoolAddress, pool, 'selected request pool');
    equal(event.tokenAmounts[0].amount, amount, 'selected request amount');
    if (selection.remoteToken !== undefined) { equal(event.tokenAmounts[0].destTokenAddress, hex(selection.remoteToken), 'selected remote token'); }
  } else {
    from = pool; to = address(selection.receiver);
    equal(address(transaction.to), address(selection.offRamp), 'selected destination call target');
    equal(quantity(transaction.value), '0', 'nonpayable execute value');
    if (selection.executor !== undefined) { equal(address(transaction.from), address(selection.executor), 'selected executor'); }
    equal(event.state, '2', 'successful execution state');
    equal(event.returnData, '0x', 'successful execution return data');
    call = executionCall(transaction.input);
    for (const field of ['messageId', 'sourceChainSelector', 'sequenceNumber']) { equal(call.message[field], event[field], 'execution/calldata ' + field); }
    equal(call.message.destChainSelector, uint(selection.destChainSelector, 64), 'selected destination selector');
    equal(call.message.receiver, to, 'selected release receiver');
    equal(call.message.tokenAmounts[0].destTokenAddress, token, 'selected release token');
    equal(call.message.tokenAmounts[0].amount, amount, 'selected release amount');
    if (selection.sourceSender !== undefined) { equal(call.message.sender, hex(selection.sourceSender), 'selected remote sender'); }
    if (selection.remotePool !== undefined) { equal(call.message.tokenAmounts[0].sourcePoolAddress, hex(selection.remotePool), 'selected remote pool'); }
  }
  const candidates = receipt.logs.filter(log => log.address.toLowerCase() === token && log.topics[0].toLowerCase() === DEV_EVM_TOPICS.transfer)
    .map(log => decodeErc20Transfer(log, chain)).filter(effect => effect.from === from && effect.to === to);
  if (candidates.length !== 1) { fail('exact unique selected ERC20 effect missing/conflicting'); }
  const effect = candidates[0]; equal(effect.amount, amount, 'selected ERC20 amount');
  if (BigInt(effect.logIndex) >= BigInt(event.logIndex)) { fail('selected effect must precede CCIP event'); }
  return freeze({ scope: 'captured-consistency-only', event, effect: { ...effect, kind: selection.kind, messageId: event.messageId }, call,
    unknown: ['capture-authenticity', 'independent-route-selection', 'historical-authorization', 'fresh-finalized-state'] });
}

/** Stable physical identity exposes reorg provenance conflicts to the report owner. */
export function compareEvmEventProvenance(before, after) {
  equal(before.physicalKey, after.physicalKey, 'physical event key');
  const fields = ['blockHash', 'blockNumber', 'transactionIndex'];
  const changed = fields.filter(field => before[field] !== after[field]);
  return changed.length ? freeze({ kind: 'block-provenance-conflict', physicalKey: before.physicalKey,
    changed, before: Object.fromEntries(fields.map(field => [field, before[field]])), after: Object.fromEntries(fields.map(field => [field, after[field]])) }) : null;
}
