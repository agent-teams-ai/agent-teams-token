import { createHash } from 'node:crypto';
import { admitPartialDevSvmCallFacts, validateDevSvmRoute, validateDevSvmLookupTable } from './dev-svm-call-plan.mjs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { isEvmAddress } from '@agent-teams/supply/deployment';
import { integer, validatePreviewRoute, PREVIEW_LANE, assertReversePreviewBindings } from '../domain/dev-transfer-preview.mjs';
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
export function readPreviewInput(jsonText, reverseJsonText) {
  const parsed = parsePreviewJson(jsonText), embedded = parsed.reverseCall;
  if (Object.hasOwn(parsed, 'reverseCall')) {delete parsed.reverseCall;}
  if (embedded !== undefined && reverseJsonText !== undefined) {throw new Error('Duplicate explicit reverse input');}
  const input = validate(parsed);
  if (embedded !== undefined || reverseJsonText !== undefined) {
    input.reverseCall = readReversePreviewInput(reverseJsonText === undefined ? JSON.stringify(embedded) : reverseJsonText);
    // Validate separately supplied policy before binding the normalized consumer selection.
    assertReversePreviewBindings(input, input.reverseCall);
    const supplied = input.reverseCall.route.limiters;
    input.reverseCall.route.limiters = supplied === null ? null : {
      inbound: supplied?.inbound === null ? null : { ...input.limiters.svmInbound },
      outbound: supplied?.outbound === null ? null : { ...input.limiters.svmOutbound } };
    inspectReversePreviewInput(input);
  }
  for (const v of [input.pair.svm.alt]) {
    if (!v.addresses.length || new Set(v.addresses).size !== v.addresses.length || v.writableIndexes.some(i => i >= v.addresses.length)) {throw new Error('ALT inventory/index binding');}
  }
  return validatePreviewRoute(input);
}

// Only these local raw-account facts are admitted. Missing values remain null.
const base64 = v => {
  if (typeof v !== 'string' || v.length > 1644 || Buffer.from(v, 'base64').toString('base64') !== v) {throw new Error('Bounded canonical raw account bytes required');}
  return v;
};
const rawAccount = nullable(object({ address: key, owner: key, executable: literal(false), slot: decimal(64), dataBase64: base64, sha256: hex(32) }));
const observationFields = { lamports: nullable(decimal(64)), payer: key, snapshotSlot: decimal(64), validThroughSlot: decimal(64), source: text };
const observation = nullable(object(observationFields));
const rawFacts = object({ schema: literal('agtmai-dev-svm-call-input-v1'), testOnly: literal(true), broadcastAllowed: literal(false),
  evidenceClass: v => {if (!['fixture-only', 'capture-consistency-only'].includes(v)) {throw new Error('Unauthenticated DEV facts required');} return v;},
  snapshotSlot: decimal(64), observedSlot: decimal(64), validThroughSlot: decimal(64),
  state: nullable(object(Object.fromEntries(['mint', 'sourceAta', 'poolAta', 'routerConfig', 'registry', 'pool', 'chain', 'alt'].map(n => [n, rawAccount])))),
  before: nullable(object({ mintSupply: decimal(64), sourceBalance: decimal(64), poolBalance: decimal(64), delegate: nullable(key), delegatedAmount: decimal(64) })),
  fees: object({ quote: nullable(object({ ...observationFields, selector: decimal(64), mint: key, amount: decimal(64), feeToken: key })), networkFee: observation, rent: observation }),
  payerBalance: observation, blockhash: nullable(object({ value: nullable(key), snapshotSlot: decimal(64), validThroughSlot: decimal(64),
    lastValidBlockHeight: nullable(decimal(64)), observedBlockHeight: nullable(decimal(64)), source: text })), maxExposureLamports: decimal(64) });
export function readReversePreviewInput(jsonText) {
  const parsed = parsePreviewJson(jsonText);
  if (!parsed || Object.keys(parsed).toSorted().join(',') !== 'facts,route') {throw new Error('Explicit reverse route and facts required');}
  // Builder contract uses plain records; the bounded parser has already rejected duplicate/prototype names.
  const route = JSON.parse(JSON.stringify(parsed.route));
  for (const name of ['recipient', 'evmToken', 'evmPool']) {route[name] = normalizePreviewEvm(route[name]);}
  for (const name of ['amount', 'fixedSupplyBaseUnits', 'selector', 'solanaSelector']) {decimal(64)(route[name]);}
  validateDevSvmRoute(route);
  return { route, facts: rawFacts(parsed.facts) };
}
const checkRaw = (actual, expected, name) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {throw new Error('Reverse raw/decoded observation conflict: ' + name);}
};
const bindRawKey = (b, offset, expected, name) => checkRaw(b.subarray(offset, offset + 32).toString('hex'), solanaPublicKeyBytes(expected ?? '11111111111111111111111111111111').toString('hex'), name);
function bindRawSelected(route, facts, name, a) {
  const b = Buffer.from(a.dataBase64, 'base64');
  checkRaw(createHash('sha256').update(b).digest('hex'), a.sha256, name + ' bytes hash');
  checkRaw(a.slot, facts.snapshotSlot, name + ' snapshot');
  const address = { mint: route.mint, sourceAta: route.identities.sourceAta, poolAta: route.identities.ata,
    routerConfig: route.identities.routerConfig, registry: route.identities.registry, pool: route.identities.pool, chain: route.identities.chain, alt: route.alt }[name];
  const owner = ['mint', 'sourceAta', 'poolAta'].includes(name) ? route.tokenProgram : ['pool', 'chain'].includes(name) ? route.poolProgram
    : name === 'alt' ? 'AddressLookupTab1e1111111111111111111111111' : route.routerProgram;
  checkRaw(a.address, address, name + ' selected address'); checkRaw(a.owner, owner, name + ' selected program');
  checkRaw(b.length, { mint: 82, sourceAta: 165, poolAta: 165, routerConfig: 210, registry: 170, pool: 368, chain: 171, alt: 376 }[name], name + ' layout');
  if (name === 'alt') {validateDevSvmLookupTable(route, facts, route.identities);}
  if (name === 'mint') {
    bindRawKey(b, 4, route.identities.signer, 'selected mint authority'); checkRaw(b[44], route.decimals, 'selected mint decimals');
  }
  if (name === 'sourceAta' || name === 'poolAta') {
    bindRawKey(b, 0, route.mint, name + ' selected mint');
    bindRawKey(b, 32, name === 'sourceAta' ? route.payer : route.identities.signer, name + ' selected owner');
  }
  if (name === 'pool') {
    checkRaw(b[73], route.decimals, 'selected pool decimals');
    for (const [offset, expected] of [[9, route.tokenProgram], [41, route.mint], [74, route.identities.signer], [106, route.identities.ata],
      [138, route.roles.poolOwner], [170, route.roles.pendingPoolOwner], [202, route.roles.rateAdmin],
      [234, route.identities.routerPoolSigner], [266, route.routerProgram], [336, route.rmn]]) {bindRawKey(b, offset, expected, 'pool binding');}
  }
  if (name === 'registry') {
    for (const [offset, expected] of [[9, route.roles.registryAdmin], [41, route.roles.pendingRegistryAdmin], [73, route.alt], [137, route.mint]]) {bindRawKey(b, offset, expected, 'registry binding');}
  }
  if (name === 'chain') {
    checkRaw([b.readUInt32LE(8), b.readUInt32LE(12), b.readUInt32LE(36), b[72]], [1, 20, 32, route.decimals], 'selected remote pair layout');
    checkRaw(b.subarray(16, 36).toString('hex'), route.evmPool.slice(2), 'remote pool raw20');
    checkRaw(b.subarray(40, 72).toString('hex'), route.evmToken.slice(2).padStart(64, '0'), 'remote token ABI32');
  }
  if (name === 'routerConfig') {
    checkRaw(b.readBigUInt64LE(10).toString(), route.solanaSelector, 'selected source selector');
    bindRawKey(b, 82, route.feeQuoterProgram, 'Fee Quoter'); bindRawKey(b, 114, route.rmn, 'RMN'); bindRawKey(b, 146, route.linkMint, 'LINK mint');
  }
  return b;
}
function bindRawBefore(before, name, b) {
  if (!before) {return;}
  if (name === 'mint') {checkRaw(b.readBigUInt64LE(36).toString(), before.mintSupply, 'raw before supply');}
  if (name === 'poolAta') {checkRaw(b.readBigUInt64LE(64).toString(), before.poolBalance, 'raw before pool balance');}
  if (name === 'sourceAta') {
    checkRaw(b.readBigUInt64LE(64).toString(), before.sourceBalance, 'raw before source balance');
    checkRaw(b.readUInt32LE(72), Number(before.delegate !== null), 'raw before delegate option');
    if (before.delegate !== null) {bindRawKey(b, 76, before.delegate, 'raw before delegate');}
    checkRaw(b.readBigUInt64LE(121).toString(), before.delegatedAmount, 'raw before delegation');
  }
}
function bindRawToken(a, b, d, name) {
  checkRaw(a.address, d.address, name + ' address'); checkRaw(a.owner, d.program, name + ' program'); checkRaw(b.length, d.length, name + ' layout');
  bindRawKey(b, 0, d.mint, name + ' mint'); bindRawKey(b, 32, d.owner, name + ' owner');
  checkRaw(b.readBigUInt64LE(64).toString(), d.balance, name + ' balance');
  checkRaw(b[108], { initialized: 1, frozen: 2, uninitialized: 0 }[d.state], name + ' state');
  checkRaw(b.readUInt32LE(109), Number(d.native), name + ' native'); checkRaw(b.readUInt32LE(129), Number(d.closeAuthority !== null), name + ' close option');
  checkRaw(b.readUInt32LE(72), Number(d.delegate !== null), name + ' delegate option');
  if (d.delegate !== null) {bindRawKey(b, 76, d.delegate, name + ' delegate');}
  if (d.closeAuthority !== null) {bindRawKey(b, 133, d.closeAuthority, name + ' close authority');}
  checkRaw(b.readBigUInt64LE(121).toString(), d.delegatedAmount, name + ' delegation');
}
function bindRawDecoded(decoded, name, a, b) {
  if (!decoded) {return;}
  if (name === 'registry') {
    checkRaw(b[8], decoded.registryVersion, 'registry version'); checkRaw(b.length, decoded.registryLength, 'registry layout');
    checkRaw(b[169], Number(decoded.supportsAutoDerivation), 'registry derivation mode');
    checkRaw(decoded.writableIndexes, [3, 4, 7], 'registered writable indexes');
    checkRaw(b.subarray(105, 137).toString('hex'), '00'.repeat(15) + '19' + '00'.repeat(16), 'registered writable bitmap');
  }
  if (name === 'mint') {
    const d = decoded.mint;
    checkRaw(a.address, d.address, 'mint address'); checkRaw(a.owner, d.program, 'mint owner'); checkRaw(b.length, d.length, 'mint layout');
    checkRaw(b.readBigUInt64LE(36).toString(), d.supply, 'supply'); bindRawKey(b, 4, d.authority, 'mint authority');
    checkRaw(b.readUInt32LE(0), Number(d.authority !== null), 'mint authority option');
    checkRaw(b[44], d.decimals, 'mint decimals'); checkRaw(b[45], Number(d.initialized), 'mint initialized');
    checkRaw(b.readUInt32LE(46), Number(d.freezeAuthority !== null), 'mint freeze option');
    if (d.freezeAuthority !== null) {bindRawKey(b, 50, d.freezeAuthority, 'mint freeze authority');}
  }
  if (name === 'sourceAta' || name === 'poolAta') {bindRawToken(a, b, name === 'sourceAta' ? decoded.source : decoded.poolAccount, name);}
  if (name === 'alt' && decoded.alt) {
    const d = decoded.alt;
    checkRaw(a.address, d.key, 'ALT key'); checkRaw(a.owner, d.program, 'ALT program');
    checkRaw(b.readBigUInt64LE(4).toString(), d.deactivationSlot, 'ALT deactivation');
    checkRaw(b.readBigUInt64LE(12).toString(), d.lastExtendedSlot, 'ALT extension');
    checkRaw(b[21], Number(d.authority !== null), 'ALT authority option');
    if (d.authority !== null) {bindRawKey(b, 22, d.authority, 'ALT authority');}
    checkRaw(b.length, 56 + d.addresses.length * 32, 'ALT inventory length');
    d.addresses.forEach((address, i) => bindRawKey(b, 56 + 32 * i, address, 'ALT inventory'));
  }
}
export function inspectReversePreviewInput(input) {
  const { route, facts } = input.reverseCall;
  assertReversePreviewBindings(input, input.reverseCall);
  for (const [name, a] of Object.entries(facts.state ?? {})) {
    if (a) {
      const b = bindRawSelected(route, facts, name, a);
      bindRawBefore(facts.before, name, b); bindRawDecoded(input.states.reverse, name, a, b);
    }
  }
  // The backend owns protocol validation, including each supplied partial record.
  const admission = admitPartialDevSvmCallFacts(route, facts, route.identities);
  return { ...admission, reasons: admission.reasons ?? [] };
}
