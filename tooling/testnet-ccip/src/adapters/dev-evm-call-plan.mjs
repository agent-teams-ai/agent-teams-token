import { PREVIEW_LANE, integer } from '../domain/dev-transfer-preview.mjs';
import { DEV_PROVIDER_AUTHORITY, ROOT_HASHES } from './dev-provider-policy.mjs';

const fail = field => {throw new Error('Forward callplan semantic mismatch: ' + field);};
const equal = (actual, expected, field) => {if (actual !== expected) {fail(field);}};
const zeroAddress = '0x' + '0'.repeat(40), zeroReceiver = '0x' + '0'.repeat(64);
export const FORWARD_ENCODING_PROVENANCE = Object.freeze({ kind: 'local-codec-encoding', authority: DEV_PROVIDER_AUTHORITY,
  providerManifestSha256: ROOT_HASHES['package.json'], providerLockSha256: ROOT_HASHES['package-lock.json'] });
function fields(value, names, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length ||
    names.some(name => !Object.hasOwn(value, name))) {fail(label + ' fields');}
}
function validateIntent(intent) {
  fields(intent, ['chainId', 'router', 'selector', 'token', 'sender', 'amount', 'tokenReceiver', 'fee', 'approve', 'send'], 'intent');
  equal(intent.chainId, PREVIEW_LANE.chainId, 'chainId'); equal(intent.router, PREVIEW_LANE.router, 'Router');
  equal(intent.selector, PREVIEW_LANE.solanaSelector, 'selector'); integer(intent.amount, 64, true);
  for (const name of ['token', 'sender']) {
    if (typeof intent[name] !== 'string' || !/^0x[0-9a-f]{40}$/.test(intent[name]) || intent[name] === zeroAddress) {fail(name);}
  }
  if (typeof intent.tokenReceiver !== 'string' || !/^0x[0-9a-f]{64}$/.test(intent.tokenReceiver) || intent.tokenReceiver === zeroReceiver) {fail('tokenReceiver');}
  if (typeof intent.approve !== 'boolean' || typeof intent.send !== 'boolean') {fail('availability');}
  if (intent.fee !== null && integer(intent.fee, 256, true) > 10000000000000000n || intent.send && intent.fee === null) {fail('native fee');}
}
const word = n => BigInt(n).toString(16).padStart(64, '0');
// Only the selected SVMExtraArgsV1 tuple. No generic ABI implementation.
function extraArgs(tokenReceiver) {
  return '0x1f3b3aba' + word(32) + word(0) + word(0) + word(1) + tokenReceiver.slice(2) + word(160) + word(0);
}
function bytes(data, length, label) {
  if (typeof data !== 'string' || !/^0x[0-9a-f]+$/.test(data) || data.length !== 2 + length * 2) {fail(label + ' canonical bytes/length');}
}
function uintWord(hex, index, expected, label) {
  const actual = hex.slice(index * 64, (index + 1) * 64);
  equal(BigInt('0x' + actual).toString(), String(expected), label);
}
function addressWord(hex, index, expected, label) {
  const actual = hex.slice(index * 64, (index + 1) * 64);
  equal(actual.slice(0, 24), '0'.repeat(24), label + ' padding'); equal('0x' + actual.slice(24), expected, label);
}
export function inspectForwardExtraArgs(data, tokenReceiver) {
  bytes(data, 228, 'extraArgs'); equal(data.slice(0, 10), '0x1f3b3aba', 'extraArgs tag');
  const tuple = data.slice(10);
  uintWord(tuple, 0, 32, 'extraArgs tuple offset'); uintWord(tuple, 1, 0, 'computeUnits');
  uintWord(tuple, 2, 0, 'accountIsWritableBitmap'); uintWord(tuple, 3, 1, 'allowOutOfOrderExecution');
  equal('0x' + tuple.slice(256, 320), tokenReceiver, 'extraArgs tokenReceiver');
  uintWord(tuple, 5, 160, 'accounts offset'); uintWord(tuple, 6, 0, 'empty accounts');
}
function inspectApprove(data, intent) {
  bytes(data, 68, 'approve'); equal(data.slice(0, 10), '0x095ea7b3', 'approve selector');
  addressWord(data.slice(10), 0, intent.router, 'approve spender'); uintWord(data.slice(10), 1, intent.amount, 'approve amount');
}
function inspectSend(data, intent) {
  bytes(data, 708, 'ccipSend'); equal(data.slice(0, 10), '0x96f4e9f9', 'ccipSend selector');
  const tuple = data.slice(10);
  // Fixed canonical layout of this ONE token/native-fee/empty-data message.
  for (const [index, expected, label] of [[0, intent.selector, 'destination selector'], [1, 64, 'message offset'],
    [2, 160, 'receiver offset'], [3, 224, 'data offset'], [4, 256, 'tokenAmounts offset'], [6, 352, 'extraArgs offset'],
    [7, 32, 'receiver length'], [9, 0, 'empty data'], [10, 1, 'one token'], [12, intent.amount, 'send amount'], [13, 228, 'extraArgs length']]) {
    uintWord(tuple, index, expected, label);
  }
  addressWord(tuple, 5, zeroAddress, 'native feeToken'); equal('0x' + tuple.slice(512, 576), zeroReceiver, 'outer receiver');
  addressWord(tuple, 11, intent.token, 'selected token');
  const extra = '0x' + tuple.slice(448 * 2, (448 + 228) * 2);
  inspectForwardExtraArgs(extra, intent.tokenReceiver);
  equal(tuple.slice(676 * 2), '0'.repeat(56), 'extraArgs trailing padding');
  return extra;
}
function inspectDecoded(decoded, approval, intent, extra) {
  equal(decoded.name, approval ? 'approve' : 'ccipSend', 'decoded operation');
  const args = decoded.args;
  equal(args.length, 2, 'decoded argument count');
  equal(String(args[0]).toLowerCase(), approval ? intent.router : intent.selector, 'decoded spender/selector');
  if (approval) {equal(String(args[1]), intent.amount, 'decoded approval amount'); return;}
  const message = args[1]; equal(args.length, 2, 'decoded argument count'); equal(message.length, 5, 'decoded message fields');
  equal(message[0], zeroReceiver, 'decoded receiver'); equal(message[1], '0x', 'decoded data');
  equal(message[2].length, 1, 'decoded token count'); equal(message[2][0].length, 2, 'decoded token fields');
  equal(message[2][0][0].toLowerCase(), intent.token, 'decoded token'); equal(String(message[2][0][1]), intent.amount, 'decoded amount');
  equal(message[3].toLowerCase(), zeroAddress, 'decoded feeToken'); equal(message[4], extra, 'decoded extraArgs');
}
/** Independent bounded wire inspection works on reopen without any provider.
 * Native decoding is an additional check when the admitted codec is present.
 */
export function inspectEvmForwardCalls(intent, calls, decodeEvmCall) {
  validateIntent(intent);
  if (!Array.isArray(calls) || calls.length !== Number(intent.approve) + Number(intent.send)) {fail('call count/order');}
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i], approval = intent.approve && i === 0;
    fields(call, ['from', 'to', 'chainId', 'value', 'data'], 'unsigned call');
    equal(call.from, intent.sender, 'from'); equal(call.to, approval ? intent.token : intent.router, 'to');
    equal(call.chainId, intent.chainId, 'chainId'); equal(call.value, approval ? '0' : intent.fee, 'value');
    const extra = approval ? inspectApprove(call.data, intent) : inspectSend(call.data, intent);
    if (decodeEvmCall) {inspectDecoded(decodeEvmCall(call.data), approval, intent, extra);}
  }
}
/** Capture only three admitted primitives; no provider DTO leaves this adapter. */
export function createDevEvmCallPlanPort({ encodeApprove, encodeCcipSend, decodeEvmCall }) {
  return Object.freeze({ provenance: FORWARD_ENCODING_PROVENANCE,
    encodeForward(intent) {
      validateIntent(intent);
      const calls = [], envelope = (to, value, data) => ({ from: intent.sender, to, chainId: intent.chainId, value, data });
      if (intent.approve) {calls.push(envelope(intent.token, '0', encodeApprove(intent.router, intent.amount)));}
      if (intent.send) {calls.push(envelope(intent.router, intent.fee, encodeCcipSend(intent.selector, {
        receiver: zeroReceiver, data: '0x', tokenAmounts: [{ token: intent.token, amount: intent.amount }],
        feeToken: zeroAddress, extraArgs: extraArgs(intent.tokenReceiver) })));}
      return calls;
    },
    inspectForward: (intent, calls) => inspectEvmForwardCalls(intent, calls, decodeEvmCall) });
}
/** Persisted provenance is a historical encoding label, not re-admission or state truth. */
export function reopenDevEvmCallPlanPort(callPlan, operations) {
  fields(callPlan, ['provenance', 'availability', 'sendAvailable'], 'callPlan');
  fields(callPlan.provenance, Object.keys(FORWARD_ENCODING_PROVENANCE), 'encoding provenance');
  for (const [name, expected] of Object.entries(FORWARD_ENCODING_PROVENANCE)) {equal(callPlan.provenance[name], expected, 'encoding provenance ' + name);}
  if (!Array.isArray(operations) || operations.length > 2) {fail('operations');}
  const calls = operations.filter(operation => Object.hasOwn(operation, 'unsigned')).map(operation => operation.unsigned);
  return Object.freeze({ provenance: FORWARD_ENCODING_PROVENANCE, encodeForward: () => calls, inspectForward: inspectEvmForwardCalls });
}
