import { keccak_256 } from '@noble/hashes/sha3.js';
import { isEvmAddress } from '@agent-teams/supply/deployment';
import { integer, validatePreviewRoute, PREVIEW_LANE } from '../domain/dev-transfer-preview.mjs';
import { solanaPublicKeyBytes } from '../domain/solana-mint.ts';

// Private bounded JSON reader: duplicate names, including escaped names, never disappear.
export function parsePreviewJson(text, maximumBytes = 65536) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximumBytes) {throw new Error('Preview JSON exceeds byte bound');}
  let i = 0;
  const space = () => { while (/[ \t\r\n]/.test(text[i] ?? '') && i < text.length) {i++;} };
  const str = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') {return JSON.parse(text.slice(start, i));}
    }
    throw new Error('Unterminated JSON string');
  };
  const collection = (depth, ch) => {
      const object = ch === '{', out = object ? Object.create(null) : [], seen = new Set(); i++; space();
      const end = object ? '}' : ']';
      if (text[i] === end) { i++; return out; }
      let count = 0;
      while (i < text.length) {
        if (++count > 256) {throw new Error('Preview JSON collection exceeds bound');}
        space(); let name;
        if (object) {
          if (text[i] !== '"') {throw new Error('JSON property required');}
          name = str(); space();
          if (seen.has(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) {throw new Error('Duplicate or forbidden JSON property');}
          seen.add(name); if (text[i++] !== ':') {throw new Error('JSON colon required');}
        }
        const item = value(depth + 1); if (object) {out[name] = item;} else {out.push(item);}
        space(); const next = text[i++]; if (next === end) {return out;}
        if (next !== ',') {throw new Error('JSON delimiter required');}
      }
      throw new Error('Unterminated JSON collection');
  };
  const value = depth => {
    if (depth > 24) {throw new Error('Preview JSON nesting exceeds bound');}
    space(); const ch = text[i];
    if (ch === '"') {return str();}
    if (ch === '{' || ch === '[') { return collection(depth, ch); }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    if (!token) {throw new Error('Invalid JSON value');}
    i += token[0].length; const result = JSON.parse(token[0]);
    if (typeof result === 'number' && (!Number.isSafeInteger(result) || /[.eE]/.test(token[0]))) {throw new Error('Unsafe JSON number');}
    return result;
  };
  const result = value(0); space(); if (i !== text.length) {throw new Error('Trailing JSON bytes');} return result;
}
export function normalizePreviewEvm(value, allowZero = false) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {throw new Error('Invalid EVM address');}
  const raw = value.slice(2), lower = raw.toLowerCase();
  if (raw !== lower && raw !== raw.toUpperCase()) {
    const hash = Buffer.from(keccak_256(Buffer.from(lower))).toString('hex');
    for (let i = 0; i < 40; i++) {
      if (/[a-f]/.test(lower[i]) && raw[i] !== (parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i])) {throw new Error('Invalid EIP55 checksum');}
    }
  }
  const normalized = '0x' + lower;
  if (/^0x0{40}$/.test(normalized)) { if (allowZero) {return normalized;} throw new Error('Zero required EVM actor'); }
  if (!isEvmAddress(normalized)) {throw new Error('Invalid EVM actor');}
  return normalized;
}
const text = v => { if (typeof v !== 'string' || !v.length || v.length > 256) {throw new Error('Bounded text required');} return v; };
const hex = bytes => v => { if (typeof v !== 'string' || !new RegExp('^[0-9a-f]{' + bytes * 2 + '}$').test(v)) {throw new Error('Canonical hex required');} return v; };
const literal = expected => v => { if (v !== expected) {throw new Error('Unexpected preview schema or flag');} return v; };
const decimal = bits => v => { integer(v, bits); return v; };
const nullable = validate => v => v === null ? null : validate(v);
const boolean = v => { if (typeof v !== 'boolean') {throw new Error('Explicit boolean required');} return v; };
const key = v => { solanaPublicKeyBytes(v); return v; };
const evm = v => normalizePreviewEvm(v), pendingEvm = v => normalizePreviewEvm(v, true);
const object = spec => v => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== Object.keys(spec).length || Object.keys(v).some(k => !Object.hasOwn(spec, k))) {throw new Error('Unknown or missing preview fields');}
  return Object.fromEntries(Object.entries(spec).map(([k, validate]) => [k, validate(v[k])]));
};
const array = validate => v => { if (!Array.isArray(v) || v.length > 32) {throw new Error('Bounded array required');} return v.map(validate); };
const index = v => { if (!Number.isInteger(v) || v < 0 || v > 31) {throw new Error('ALT index outside bound');} return v; };
const indexes = v => { const a = array(index)(v); if (new Set(a).size !== a.length) {throw new Error('Duplicate ALT index');} return a; };
const context = object({ kind: v => { if (!['hypothetical', 'unverified-capture'].includes(v)) {throw new Error('Decoded state cannot authenticate a chain');} return v; }, point: decimal(64), hash: hex(32), sourceSha256: hex(32) });
const altExpected = object({ key, authority: nullable(key), addresses: array(key), writableIndexes: indexes });
const evmPair = object(Object.fromEntries(['token', 'pool', 'initialAdmin', 'registryAdmin', 'poolOwner', 'sender', 'recipient'].map(k => [k, evm]).concat([['pendingAdmin', pendingEvm]])));
const svmPair = object(Object.fromEntries(['mint', 'pool', 'signer', 'poolAta', 'sourceAta', 'registry', 'registryAdmin', 'poolOwner', 'rateAdmin', 'spender', 'sender', 'recipient', 'payer'].map(k => [k, key]).concat([['pendingAdmin', nullable(key)], ['pendingOwner', nullable(key)], ['alt', altExpected]])));
const limiter = object({ enabled: boolean, capacity: decimal(128), rate: decimal(128) });
const mint = object({ address: key, program: key, length: indexLength, initialized: boolean, decimals: index, supply: decimal(64), authority: nullable(key), freezeAuthority: nullable(key) });
function indexLength(v) { if (!Number.isInteger(v) || v < 0 || v > 4096) {throw new Error('Account layout length');} return v; }
const account = object({ address: key, program: key, length: indexLength, mint: key, owner: key, balance: decimal(64), state: text, native: boolean, closeAuthority: nullable(key), delegate: nullable(key), delegatedAmount: decimal(64) });
const forward = object({ context, ...Object.fromEntries(['token', 'pool', 'initialAdmin', 'registryAdmin', 'poolOwner', 'sender', 'router', 'rmn', 'registry', 'backingHolder', 'registeredPool', 'allowanceOwner', 'allowanceSpender'].map(k => [k, evm])), pendingAdmin: pendingEvm,
  artifactSha256: hex(32), decimals: index, totalSupply: decimal(256), balance: nullable(decimal(256)), allowance: nullable(decimal(256)), remoteSelector: decimal(64), remoteTokenHex: hex(32), remotePoolHex: hex(32) });
const reverse = object({ context, commonBeforeState: boolean, mint, source: account, poolAccount: account,
  ...Object.fromEntries(['pool', 'poolOwner', 'rateAdmin', 'registryAdmin', 'signer', 'registry', 'registryProgram', 'poolProgram', 'registryAlt', 'router', 'rmn'].map(k => [k, key])), pendingOwner: nullable(key), pendingAdmin: nullable(key),
  registryVersion: index, registryLength: indexLength, supportsAutoDerivation: boolean, writableIndexes: indexes,
  alt: nullable(object({ key, authority: nullable(key), addresses: array(key), program: key, deactivationSlot: decimal(64), lastExtendedSlot: decimal(64) })),
  remoteSelector: decimal(64), remoteTokenHex: hex(32), remotePoolHex: hex(20) });
const bucket = object({ enabled: boolean, capacity: decimal(128), rate: decimal(128), tokens: decimal(128), owner: v => v.startsWith('0x') ? evm(v) : key(v), context });
const utc = v => { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().replace('.000Z', 'Z') !== v) {throw new Error('Canonical UTC seconds required');} return v; };
const quote = object({ amount: decimal(64), selector: decimal(64), recipient: v => v.startsWith('0x') ? evm(v) : key(v), feeToken: text, ccipFee: decimal(256), networkFee: nullable(decimal(256)), rent: nullable(decimal(64)), payerBalance: nullable(decimal(256)), exposureLimit: decimal(256), sourceSha256: hex(32), context, observedAt: utc, expiresAt: utc, checkedAt: utc });
const validate = object({ schema: literal('agtmai-dev-transfer-input-v1'), schemaVersion: literal(1), testOnly: literal(true), broadcastAllowed: literal(false),
  sourceRevision: hex(20), sourceTree: hex(20), lane: object(Object.fromEntries(Object.keys(PREVIEW_LANE).map(k => [k, text]))),
  profile: v => { if (!['fixture100', 'product100M'].includes(v)) {throw new Error('Explicit supply profile required');} return v; }, fixedSupplyBaseUnits: decimal(64), decimals: literal(9), amount: decimal(64), pair: object({ evm: evmPair, svm: svmPair }),
  limiters: object({ evmOutbound: limiter, evmInbound: limiter, svmOutbound: limiter, svmInbound: limiter }),
  states: object({ forward: nullable(forward), reverse: nullable(reverse) }), buckets: object({ evmOutbound: nullable(bucket), evmInbound: nullable(bucket), svmOutbound: nullable(bucket), svmInbound: nullable(bucket) }),
  quotes: object({ forward: nullable(quote), reverse: nullable(quote) }), blockhash: nullable(object({ value: key, lastValidBlockHeight: decimal(64), provenance: context })),
  recipientAta: nullable(object({ address: key, exists: boolean, payer: key, rent: nullable(decimal(64)) })) });
export function readPreviewInput(jsonText) {
  const input = validate(parsePreviewJson(jsonText));
  for (const v of [input.pair.svm.alt]) {
    if (!v.addresses.length || new Set(v.addresses).size !== v.addresses.length || v.writableIndexes.some(i => i >= v.addresses.length)) {throw new Error('ALT inventory/index binding');}
  }
  return validatePreviewRoute(input);
}
