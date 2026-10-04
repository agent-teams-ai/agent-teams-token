import { createHash } from 'node:crypto';
import { solanaPublicKeyBytes, SPL_TOKEN_PROGRAM, SYSTEM_PROGRAM } from '../domain/solana-mint.ts';
import { decodeDevSvmEvent } from './dev-svm-event-codec.mjs';

// Pure DEV replay only. The input port is independently selected lane/identity
// context, including derived addresses, NOT caller-decoded instructions/events.
// Runtime PDA/ATA derivation and historical authorization belong to the later
// application adapter. getTransaction has no mint/delegate or program account
// bytes and cannot establish those capabilities, binary ownership or finality.
export const DEV_SVM_CAPTURE_BOUNDS = Object.freeze({ transactionBytes: 262144,
  accounts: 256, instructions: 1024, logs: 2048, encodedInstructionBytes: 1232 });
export const DEV_SVM_CAPTURE_INDEX_SCHEME = 'svm-physical-interleaved-v1';
const BURNMINT = '41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const U64_MAX = (1n << 64n) - 1n;
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fail = reason => { throw new Error('DEV SVM capture: ' + reason); };
const check = (ok, reason) => { if (!ok) { fail(reason); } };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const disc = name => createHash('sha256').update('global:' + name).digest().subarray(0, 8).toString('hex');
// Authenticated archive, statically inspected; never import/evaluate SDK/Anchor.
// IDL directory is 1.6.0, metadata version 1.6.3; not deployed binary authority.
export const DEV_SVM_CAPTURE_AUTHORITY = Object.freeze({ sdkVersion: '1.13.0',
  archivePath: '.local/CANDIDATE-AUTHORITY/archives/caed2fefa8ccd9e31d0920dbdd7622ae8cb87d63efd178fe6a67425f9db709f6.tgz',
  archiveSha256: 'caed2fefa8ccd9e31d0920dbdd7622ae8cb87d63efd178fe6a67425f9db709f6',
  routerPath: 'package/dist/solana/idl/1.6.0/CCIP_ROUTER.js',
  routerSha256: '01c560fecef86ae86615dcd77dd1a8048e1a1373248f76781db4716d57aaa10f',
  offRampPath: 'package/dist/solana/idl/1.6.0/CCIP_OFFRAMP.js',
  offRampSha256: 'c0cb8c1c9de22fbb5efaf11171a27348eb376d030130cd4d28e84e465ca8bdf2',
  poolPath: 'package/dist/solana/idl/1.6.0/BURN_MINT_TOKEN_POOL.js',
  poolSha256: 'cada8ee40a749133342dd2831c347d4fbabbc9352f16fa5d513d353ff1a472a7',
  basePoolPath: 'package/dist/solana/idl/1.6.0/BASE_TOKEN_POOL.js',
  basePoolSha256: 'cd47e275e2b143624c2166df6fb51a32f5fa7c258bda97f76bbbe962e9b38735' });

function decimal(value, positive = false) {
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20,
    'canonical u64 decimal string required');
  const n = BigInt(value);
  check(n <= U64_MAX && (!positive || n > 0n), 'u64 range'); return n;
}
function boundedArray(value, cap, label) {
  check(Array.isArray(value) && value.length <= cap, label + ' capacity/type'); return value;
}
function base58(value, cap) {
  check(typeof value === 'string' && value.length <= cap, 'encoded instruction capacity/type');
  let n = 0n;
  for (const c of value) {
    const digit = alphabet.indexOf(c); check(digit >= 0, 'invalid base58'); n = n * 58n + BigInt(digit);
  }
  const significant = n === 0n ? Buffer.alloc(0) : Buffer.from(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0'), 'hex');
  const zeroes = value.match(/^1*/)[0].length;
  check(zeroes + significant.length <= cap, 'decoded instruction capacity');
  return Buffer.concat([Buffer.alloc(zeroes), significant]);
}
function jsonFrame(c, parent, accountArrays) {
  const name = parent?.key ?? parent?.name ?? '';
  const cap = accountArrays.has(name) ? 256 : ['instructions', 'innerInstructions'].includes(name) ? 1024 : 2048;
  const label = name === 'accountKeys' ? 'static accounts' : name === 'logMessages' ? 'complete logs' : name === 'instructions' && parent?.name === 'message' ? 'top instructions' : name;
  const globalAccounts = name === 'accountKeys' || parent?.name === 'loadedAddresses' && ['writable', 'readonly'].includes(name);
  return c === '{' ? { name, keys: new Set() } : { name, label, array: true, globalAccounts, cap, count: 0, ready: true };
}
// JSON.parse alone silently overwrites duplicate keys. This bounded lexical pass
// rejects excessive nesting and capture array capacities BEFORE JSON allocation.
function parseResponse(raw) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw), stack = [];
  let instructionCount = 0, accountCount = 0;
  const accountArrays = new Set(['accountKeys', 'writable', 'readonly', 'writableIndexes', 'readonlyIndexes',
    'accounts', 'signatures', 'preBalances', 'postBalances', 'preTokenBalances', 'postTokenBalances', 'addressTableLookups']);
  function item() {
    const frame = stack.at(-1);
    if (frame?.array && frame.ready) {
      frame.ready = false; frame.count++;
      check(frame.count <= frame.cap, frame.label + ' capacity before JSON parse');
      if (frame.name === 'instructions') { instructionCount++; check(instructionCount <= 1024, 'combined instructions capacity before JSON parse'); }
      if (frame.globalAccounts) { accountCount++; check(accountCount <= 256, 'combined accounts capacity before JSON parse'); }
    }
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      for (; i < text.length; i++) { if (text[i] === '\\') { i++; } else if (text[i] === '"') { break; } }
      let after = i + 1; while (/\s/.test(text[after] ?? '') && after < text.length) { after++; }
      if (text[after] === ':') {
        const key = JSON.parse(text.slice(start, i + 1)), frame = stack.at(-1);
        check(frame?.keys instanceof Set && !frame.keys.has(key), 'duplicate JSON key'); frame.keys.add(key); frame.key = key;
      } else { item(); }
    } else if (c === '{' || c === '[') {
      item(); check(stack.length < 64, 'JSON nesting capacity');
      stack.push(jsonFrame(c, stack.at(-1), accountArrays));
    } else if (c === '}' || c === ']') { stack.pop(); }
    else if (c === ',') { const frame = stack.at(-1); if (frame?.array) { frame.ready = true; } }
    else if (!/\s/.test(c)) { item(); }
  }
  return JSON.parse(text);
}
function reader(data) {
  let offset = 0;
  const fixed = size => {
    check(Number.isInteger(size) && size >= 0 && size <= data.length - offset, 'truncated instruction layout');
    const result = data.subarray(offset, offset + size); offset += size; return result;
  };
  const u32 = () => fixed(4).readUInt32LE();
  const u64 = () => fixed(8).readBigUInt64LE();
  const amount = () => { let n = 0n; const b = fixed(32); for (let i = 31; i >= 0; i--) { n = n * 256n + BigInt(b[i]); } return n; };
  return { fixed, u32, u64, amount, bytes: () => fixed(u32()),
    count: (width, max) => { const n = u32(); check(n <= max && n * width <= data.length - offset, 'instruction vector capacity'); return n; },
    end: () => check(offset === data.length, 'trailing instruction layout') };
}
const hexKey = address => solanaPublicKeyBytes(address).toString('hex');
const location = n => ({ ordinal: n.ordinal, instructionPath: n.path, owningInstructionPath: n.parent?.path ?? null, program: n.program });
function publicDto(value) {
  if (Buffer.isBuffer(value)) { return value.toString('hex'); }
  if (typeof value === 'bigint') { return value.toString(); }
  if (Array.isArray(value)) { return Object.freeze(value.map(publicDto)); }
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, publicDto(v)])));
  }
  return value;
}
function context(e) {
  check(e?.testOnly === true && ['mint', 'burn'].includes(e.direction) && e.decimals === 9, 'explicit DEV direction/decimals required');
  check(typeof e.sourcePath === 'string' && e.sourcePath.length <= 512 && /^[0-9a-f]{64}$/.test(e.sourceSha256), 'selected source binding');
  check(base58(e.transactionId, 88).length === 64, 'selected transaction signature');
  for (const field of ['slot', 'amount', 'sourceChainSelector', 'destChainSelector', 'sequenceNumber', 'nonce', ...(e.direction === 'burn' ? ['msgTotalNonce'] : [])]) { decimal(e[field], field === 'amount'); }
  check(/^0x[0-9a-f]{64}$/.test(e.messageId), 'selected message ID');
  for (const field of ['router', 'offRamp', 'poolProgram', 'mint', 'poolSigner', 'poolATA', 'poolState', 'poolChainConfig',
    ...(e.direction === 'mint' ? ['allowedOffRamp', 'offRampPoolAuthority'] : ['routerPoolAuthority']),
    ...(e.direction === 'mint' ? ['recipient', 'recipientATA'] : ['sourceOwner', 'sourceATA', 'spender'])]) { solanaPublicKeyBytes(e[field]); }
  check(e.poolProgram === BURNMINT, 'official BurnMint program required');
  check(new Set([e.router, e.offRamp, e.poolProgram, SPL_TOKEN_PROGRAM, e.mint, e.poolSigner, e.poolATA,
    e.direction === 'mint' ? e.recipientATA : e.sourceATA]).size === 8, 'repeated selected identities');
  for (const field of ['evmToken', 'evmPool', 'evmSender', 'evmRecipient']) { check(/^0x[0-9a-f]{40}$/.test(e[field]), 'selected EVM context'); }
  if (e.direction === 'mint') { check(/^0x[0-9a-f]{64}$/.test(e.messageHash), 'selected execution hash'); }
}
function nativeBalanceCounts(meta, keys) {
  for (const name of ['preBalances', 'postBalances']) {
    if (meta[name] !== undefined && meta[name] !== null) { check(boundedArray(meta[name], 256, name).length === keys.length, 'native balance/account counts'); }
  }
}
function accounts(message, meta, version, signatures) {
  const staticKeys = boundedArray(message.accountKeys, 256, 'static accounts');
  const loaded = meta.loadedAddresses ?? (version === 'legacy' ? { writable: [], readonly: [] } : null);
  check(loaded && typeof loaded === 'object', 'missing loaded addresses');
  const writable = boundedArray(loaded.writable, 256, 'loaded writable'), readonly = boundedArray(loaded.readonly, 256, 'loaded readonly');
  check(staticKeys.length + writable.length + readonly.length <= 256, 'combined accounts capacity');
  const h = message.header;
  for (const n of [h?.numRequiredSignatures, h?.numReadonlySignedAccounts, h?.numReadonlyUnsignedAccounts]) { check(Number.isInteger(n) && n >= 0, 'header roles'); }
  check(h.numRequiredSignatures > 0 && h.numRequiredSignatures === signatures.length && h.numRequiredSignatures <= staticKeys.length &&
    h.numReadonlySignedAccounts < h.numRequiredSignatures && h.numReadonlyUnsignedAccounts <= staticKeys.length - h.numRequiredSignatures, 'header role range');
  const keys = [...staticKeys, ...writable, ...readonly]; keys.forEach(solanaPublicKeyBytes);
  check(new Set(keys).size === keys.length, 'repeated global account identity');
  const lookups = boundedArray(message.addressTableLookups ?? [], 256, 'address lookups');
  let w = 0, r = 0; const tables = new Set();
  for (const lookup of lookups) {
    solanaPublicKeyBytes(lookup.accountKey); check(!tables.has(lookup.accountKey), 'duplicate lookup identity'); tables.add(lookup.accountKey);
    const wi = boundedArray(lookup.writableIndexes, 256, 'lookup writable indexes'), ri = boundedArray(lookup.readonlyIndexes, 256, 'lookup readonly indexes');
    const indexes = [...wi, ...ri]; check(indexes.every(i => Number.isInteger(i) && i >= 0 && i <= 255) && new Set(indexes).size === indexes.length, 'lookup index range/duplicates');
    w += wi.length; r += ri.length;
  }
  check(w === writable.length && r === readonly.length && (version !== 'legacy' || lookups.length === 0), 'lookup/loaded address counts');
  nativeBalanceCounts(meta, keys);
  return keys.map((address, i) => ({ address, accountIndex: i,
    isSigner: i < h.numRequiredSignatures,
    isWritable: i < staticKeys.length ? i < h.numRequiredSignatures ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < staticKeys.length - h.numReadonlyUnsignedAccounts : i < staticKeys.length + writable.length,
    origin: i < staticKeys.length ? 'static' : i < staticKeys.length + writable.length ? 'loaded-writable' : 'loaded-readonly' }));
}
function instructions(message, meta, metas) {
  const top = boundedArray(message.instructions, 1024, 'top instructions'), groups = boundedArray(meta.innerInstructions, 1024, 'inner groups');
  let count = top.length, previous = -1;
  for (const g of groups) {
    check(Number.isInteger(g.index) && g.index > previous && g.index < top.length, 'inner group index/duplicate/order'); previous = g.index;
    count += boundedArray(g.instructions, 1024, 'inner instructions').length;
    check(count <= 1024 && g.instructions.length > 0, 'combined instructions capacity/empty group');
  }
  const result = [], byTop = new Map(groups.map(g => [g.index, g.instructions]));
  function add(ix, path, depth, parent) {
    check(ix && typeof ix === 'object' && !('parsed' in ix) && !('programId' in ix), 'raw compiled instruction required');
    check(Number.isInteger(ix.programIdIndex) && metas[ix.programIdIndex], 'program index range');
    const indexes = boundedArray(ix.accounts, 256, 'instruction accounts');
    check(indexes.every(i => Number.isInteger(i) && i >= 0 && metas[i]), 'account index range');
    check(depth === 1 ? ix.stackHeight === undefined || ix.stackHeight === null || ix.stackHeight === 1 : ix.stackHeight === depth, 'instruction stack height');
    const node = { ordinal: result.length, path, parent, depth, program: metas[ix.programIdIndex].address,
      accounts: indexes.map(i => metas[i]), data: base58(ix.data, 1232) };
    if (parent) {
      const admitted = new Set(parent.accounts.map(a => a.address)); admitted.add(parent.program);
      check([node.program, ...node.accounts.map(a => a.address)].every(a => admitted.has(a)), 'CPI account membership');
    }
    result.push(node); return node;
  }
  for (let t = 0; t < top.length; t++) {
    const root = add(top[t], [t], 1, null), stack = [root];
    for (const [i, ix] of (byTop.get(t) ?? []).entries()) {
      const depth = ix.stackHeight;
      check(Number.isInteger(depth) && depth >= 2 && depth <= stack.length + 1, 'contradictory inner stack');
      stack.length = depth - 1; const parent = stack.at(-1);
      stack.push(add(ix, [t, i], depth, parent));
    }
  }
  return result;
}
function logs(meta, nodes) {
  const lines = boundedArray(meta.logMessages, 2048, 'complete logs'); check(lines.length > 0, 'missing logs');
  const stack = [], events = []; let next = 0;
  for (const [index, line] of lines.entries()) {
    check(typeof line === 'string' && !/^Log truncated|^Program log:.*truncated/i.test(line), 'missing/truncated log');
    let m = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[([1-9][0-9]*)\]$/.exec(line);
    if (m) {
      const node = nodes[next++];
      check(node && node.program === m[1] && node.depth === Number(m[2]) && node.depth === stack.length + 1 && node.parent === (stack.at(-1) ?? null), 'invoke log/stack/instruction membership');
      node.invokeLogIndex = index; stack.push(node); continue;
    }
    m = /^Program ([1-9A-HJ-NP-Za-km-z]+) success$/.exec(line);
    if (m) {
      check(stack.at(-1)?.program === m[1], 'success log membership'); stack.pop().successLogIndex = index; continue;
    }
    check(!/^Program \S+ failed/.test(line), 'failed invocation');
    const owner = stack.at(-1); check(owner, 'log outside invocation');
    if (line.startsWith('Program data: ')) {
      const encoded = line.slice(14); check(encoded.length <= 87384, 'event capacity');
      const raw = Buffer.from(encoded, 'base64'); check(raw.length <= 65536 && raw.toString('base64') === encoded, 'canonical event base64');
      events.push({ owner, logIndex: index, raw }); continue;
    }
    m = /^Program (\S+) consumed \d+ of \d+ compute units$/.exec(line);
    const ret = /^Program return: (\S+) ([A-Za-z0-9+/=]*)$/.exec(line);
    if (m || ret) {
      check((m ?? ret)[1] === owner.program, 'runtime log owner');
      // The admitted transaction byte ceiling also bounds return decoding.
      if (ret) { check(ret[0] === line && Buffer.from(ret[2], 'base64').toString('base64') === ret[2], 'canonical return base64'); }
      continue;
    }
    check(line.startsWith('Program log: '), 'unsupported/malformed runtime log');
  }
  check(next === nodes.length && stack.length === 0 && nodes.every(n => Number.isInteger(n.successLogIndex)), 'incomplete instruction/log coverage');
  return events;
}
function role(node, index, expected, writable = false) {
  const a = node.accounts[index]; check(a?.address === expected && (!writable || a.isWritable), 'instruction account/authority/metas binding');
}
function rootRoles(node, e) {
  if (e.direction === 'mint') {
    check(node.accounts.length === 26 && new Set(node.accounts.map(a => a.address)).size === 26, 'OffRamp accounts layout/repeated identity');
    role(node, 4, e.offRamp); role(node, 5, e.allowedOffRamp); role(node, 7, SYSTEM_PROGRAM); role(node, 12, e.offRampPoolAuthority);
    role(node, 13, e.recipientATA, true); role(node, 15, e.poolChainConfig, true); role(node, 18, BURNMINT);
    role(node, 19, e.poolState); role(node, 20, e.poolATA, true); role(node, 21, e.poolSigner); role(node, 22, SPL_TOKEN_PROGRAM); role(node, 23, e.mint, true);
    check(node.accounts[3].isWritable && node.accounts[6].isWritable && (node.parent || node.accounts[6].isSigner), 'OffRamp authority/header roles');
  } else {
    check(node.accounts.length === 31 && new Set(node.accounts.filter((_a, i) => ![7, 27].includes(i)).map(a => a.address)).size === 29, 'Router accounts layout/repeated identity');
    // Minimum IDL privileges use the global union; readonly occurrences may
    // have extra writable privilege. This does not establish CPI signer roles.
    check([1, 2, 8].every(i => node.accounts[i].isWritable), 'Router mandatory writable destChainState/nonce/feeTokenReceiver');
    role(node, 3, e.sourceOwner, true);
    role(node, 4, SYSTEM_PROGRAM); role(node, 5, SPL_TOKEN_PROGRAM); role(node, 9, e.spender);
    role(node, 7, SYSTEM_PROGRAM, true); role(node, 18, e.sourceATA, true); role(node, 20, e.poolChainConfig, true);
    role(node, 23, BURNMINT); role(node, 24, e.poolState); role(node, 25, e.poolATA, true); role(node, 26, e.poolSigner); role(node, 27, SPL_TOKEN_PROGRAM); role(node, 28, e.mint, true); role(node, 30, e.routerPoolAuthority);
    check(node.parent || node.accounts[3].isSigner, 'Router authority/header role');
  }
}
function rootWire(node, e) {
  const r = reader(node.data), discriminator = r.fixed(8).toString('hex');
  const eq = (actual, expected, label) => check(actual === expected, 'raw ' + label + ' binding');
  if (e.direction === 'burn') {
    eq(discriminator, disc('ccip_send'), 'Router discriminator'); eq(r.u64(), decimal(e.destChainSelector), 'destination selector');
    const receiver = r.bytes(), data = r.bytes(); eq(receiver.toString('hex'), e.evmRecipient.slice(2).padStart(64, '0'), 'receiver ABI32');
    eq(data.length, 0, 'token-only data'); eq(r.count(40, 1), 1, 'token count'); eq(r.fixed(32).toString('hex'), hexKey(e.mint), 'mint');
    eq(r.u64(), decimal(e.amount), 'amount'); eq(r.fixed(32).toString('hex'), hexKey(SYSTEM_PROGRAM), 'native fee token');
    const extraArgs = r.bytes(); eq(extraArgs.toString('hex'), '181dcf10' + '00'.repeat(16) + '01', 'EVM extra args');
    eq(r.bytes().toString('hex'), '00', 'token indexes'); r.end();
    return { instructionName: 'ccip_send', receiver, data, extraArgs };
  }
  const manual = discriminator === disc('manually_execute');
  check(manual || discriminator === disc('execute'), 'raw OffRamp discriminator');
  const report = reader(r.bytes()); if (!manual) { r.fixed(64); }
  // Both official arguments must be fully consumed. Buffered/unknown layouts fail.
  eq(r.bytes().toString('hex'), '00', 'token indexes'); r.end();
  eq(report.u64(), decimal(e.sourceChainSelector), 'outer source selector');
  eq('0x' + report.fixed(32).toString('hex'), e.messageId, 'message ID');
  eq(report.u64(), decimal(e.sourceChainSelector), 'header source selector'); eq(report.u64(), decimal(e.destChainSelector), 'header destination selector');
  eq(report.u64(), decimal(e.sequenceNumber), 'sequence'); eq(report.u64(), decimal(e.nonce), 'nonce');
  eq(report.bytes().toString('hex'), e.evmSender.slice(2), 'source sender raw20'); eq(report.bytes().length, 0, 'token-only data');
  eq(report.fixed(32).toString('hex'), hexKey(e.recipient), 'token recipient'); eq(report.count(76, 1), 1, 'token count');
  eq(report.bytes().toString('hex'), e.evmPool.slice(2), 'source pool raw20'); eq(report.fixed(32).toString('hex'), hexKey(e.mint), 'destination mint');
  const destGasAmount = report.u32();
  eq(report.bytes().toString('hex'), '00'.repeat(31) + '09', 'source decimals'); eq(report.amount(), decimal(e.amount), 'amount');
  const computeUnits = report.u32(); eq(report.u64(), 0n, 'writable bitmap');
  eq(report.count(4, 1), 1, 'offchain token data count'); const offchainTokenData = report.bytes();
  const proofCount = report.count(32, 32); const proofs = report.fixed(proofCount * 32); report.end();
  return { instructionName: manual ? 'manually_execute' : 'execute', destGasAmount, computeUnits, offchainTokenData, proofs };
}
function poolRoles(pool, root, e, wire) {
  check(pool.parent === root && pool.program === BURNMINT, 'selected direct BurnMint invocation');
  const forward = e.direction === 'mint';
  check(pool.data.length >= 8 && pool.data.subarray(0, 8).toString('hex') === disc(forward ? 'release_or_mint_tokens' : 'lock_or_burn_tokens'), 'BurnMint discriminator');
  check(pool.accounts.length === (forward ? 13 : 10), 'BurnMint accounts layout');
  check(new Set(pool.accounts.map(a => a.address)).size === pool.accounts.length, 'repeated pool role identity');
  if (forward) { role(pool, 0, e.offRampPoolAuthority); role(pool, 1, e.offRamp); role(pool, 2, e.allowedOffRamp); role(pool, 3, e.poolState); role(pool, 4, SPL_TOKEN_PROGRAM); role(pool, 5, e.mint, true); role(pool, 6, e.poolSigner); role(pool, 7, e.poolATA, true); role(pool, 8, e.poolChainConfig, true); role(pool, 12, e.recipientATA, true); }
  else { role(pool, 0, e.routerPoolAuthority); role(pool, 1, e.poolState); role(pool, 2, SPL_TOKEN_PROGRAM); role(pool, 3, e.mint, true); role(pool, 4, e.poolSigner); role(pool, 5, e.poolATA, true); role(pool, 9, e.poolChainConfig, true); }
  // BurnMint references the official BASE_TOKEN_POOL shared types. Read their
  // exact wire order, including RemoteAddress{address:bytes}, without evaluation.
  const r = reader(pool.data); r.fixed(8);
  const eq = (a, b, label) => check(a === b, 'raw pool ' + label + ' binding');
  if (forward) {
    eq(r.bytes().toString('hex'), e.evmSender.slice(2), 'original sender'); eq(r.u64(), decimal(e.sourceChainSelector), 'source selector');
    eq(r.fixed(32).toString('hex'), hexKey(e.recipient), 'receiver'); eq(r.amount(), decimal(e.amount), 'amount');
    eq(r.fixed(32).toString('hex'), hexKey(e.mint), 'local token'); eq(r.bytes().toString('hex'), e.evmPool.slice(2), 'source pool raw20');
    eq(r.bytes().toString('hex'), '00'.repeat(31) + '09', 'source pool decimals'); eq(r.bytes().toString('hex'), wire.offchainTokenData.toString('hex'), 'offchain token data');
  } else {
    eq(r.bytes().toString('hex'), wire.receiver.toString('hex'), 'receiver'); eq(r.u64(), decimal(e.destChainSelector), 'destination selector');
    eq(r.fixed(32).toString('hex'), hexKey(e.sourceOwner), 'original sender'); eq(r.u64(), decimal(e.amount), 'amount');
    eq(r.fixed(32).toString('hex'), hexKey(e.mint), 'local token'); eq(r.u64(), decimal(e.msgTotalNonce), 'total nonce');
  }
  r.end();
}
function splEffect(n, opcode) {
  const checked = [12, 14, 15].includes(opcode);
  check(n.data.length === (checked ? 10 : 9), 'SPL effect length');
  if (checked) { check(n.data[9] === 9, 'SPL checked decimals'); }
  const kind = opcode === 12 ? 'transferChecked' : [7, 14].includes(opcode) ? 'mint' : 'burn';
  const authorityIndex = kind === 'transferChecked' ? 3 : 2;
  // A retained SDK mint repeats the SAME PDA as its one extra authority meta.
  // This does not prove SPL multisig; arbitrary/multiple extra identities fail.
  check(n.accounts.length === authorityIndex + 1 || kind === 'mint' && n.accounts.length === 4 && n.accounts[3].address === n.accounts[2].address, 'SPL authority metas/multisig unsupported');
  const distinct = n.accounts.slice(0, authorityIndex + 1).map(a => a.address);
  check(new Set(distinct).size === distinct.length, 'repeated SPL role identities');
  return { node: n, kind, opcode, amount: n.data.readBigUInt64LE(1), checked };
}
function splEffects(nodes, e) {
  const watched = new Set([e.mint, e.poolATA, e.direction === 'mint' ? e.recipientATA : e.sourceATA]), effects = [];
  for (const n of nodes) {
    if (n.program !== SPL_TOKEN_PROGRAM || !n.accounts.some(a => watched.has(a.address))) { continue; }
    const opcode = n.data[0];
    if ([7, 8, 12, 14, 15].includes(opcode)) {
      effects.push(splEffect(n, opcode));
    } else if (opcode === 4 && e.direction === 'burn') {
      check(n.data.length === 9 && n.accounts.length === 3, 'SPL approve layout');
      role(n, 0, e.sourceATA, true); role(n, 1, e.spender); role(n, 2, e.sourceOwner);
      check(n.depth === 1 && n.accounts[2].isSigner && n.data.readBigUInt64LE(1) === decimal(e.amount), 'SPL approve authority/amount');
    } else if ([18, 21, 22].includes(opcode)) {
      check(e.direction === 'mint' && n.parent?.program === ATA_PROGRAM, 'unowned ATA initialization');
      check(n.data.length === (opcode === 18 ? 33 : 1) && n.accounts.length === (opcode === 18 ? 2 : 1), 'classic ATA initialization layout');
      role(n, 0, opcode === 21 ? e.mint : e.recipientATA, opcode !== 21);
      if (opcode === 18) { role(n, 1, e.mint); check(n.data.subarray(1).toString('hex') === hexKey(e.recipient), 'ATA initialized owner'); }
    } else { fail('unsupported selected SPL opcode'); }
  }
  return effects;
}
function balances(meta, metas) {
  const sides = [];
  for (const name of ['preTokenBalances', 'postTokenBalances']) {
    if (meta[name] === undefined || meta[name] === null) { sides.push(null); continue; }
    const map = new Map();
    for (const b of boundedArray(meta[name], 256, name)) {
      check(Number.isInteger(b.accountIndex) && b.accountIndex >= 0 && metas[b.accountIndex] && !map.has(b.accountIndex), 'token balance index/duplicate');
      solanaPublicKeyBytes(b.mint); if (b.owner !== undefined && b.owner !== null) { solanaPublicKeyBytes(b.owner); }
      if (b.programId !== undefined && b.programId !== null) { solanaPublicKeyBytes(b.programId); }
      const amount = decimal(b.uiTokenAmount?.amount);
      check(Number.isInteger(b.uiTokenAmount.decimals) && b.uiTokenAmount.decimals >= 0 && b.uiTokenAmount.decimals <= 255, 'balance decimals');
      map.set(b.accountIndex, { ...b, amount });
    }
    sides.push(map);
  }
  return sides;
}
function createdATA(meta, nodes, metas, e, effect) {
  const index = metas.findIndex(a => a.address === e.recipientATA);
  if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances) || meta.preBalances[index] !== 0 || !Number.isSafeInteger(meta.postBalances[index]) || meta.postBalances[index] <= 0) { return false; }
  const creates = nodes.filter(n => n.program === ATA_PROGRAM && n.ordinal < effect.ordinal && n.accounts.length === 6 &&
    (n.data.length === 0 || n.data.length === 1 && [0, 1].includes(n.data[0])) && n.accounts[1].address === e.recipientATA &&
    n.accounts[2].address === e.recipient && n.accounts[3].address === e.mint && n.accounts[4].address === SYSTEM_PROGRAM && n.accounts[5].address === SPL_TOKEN_PROGRAM);
  if (creates.length !== 1) { return false; }
  const children = nodes.filter(n => n.parent === creates[0]), allocated = children.filter(n => n.program === SYSTEM_PROGRAM && n.accounts.length === 2 &&
    n.accounts[0].address === creates[0].accounts[0].address && n.accounts[1].address === e.recipientATA && n.data.length === 52 && n.data.readUInt32LE() === 0 &&
    n.data.readBigUInt64LE(4) > 0n && n.data.readBigUInt64LE(12) === 165n && n.data.subarray(20).toString('hex') === hexKey(SPL_TOKEN_PROGRAM));
  const initialized = children.filter(n => n.program === SPL_TOKEN_PROGRAM && n.accounts.length === 2 && n.accounts[0].address === e.recipientATA && n.accounts[1].address === e.mint &&
    n.data.length === 33 && n.data[0] === 18 && n.data.subarray(1).toString('hex') === hexKey(e.recipient));
  return allocated.length === 1 && initialized.length === 1 && allocated[0].ordinal < initialized[0].ordinal && initialized[0].ordinal < effect.ordinal && creates[0].accounts[0].isWritable && creates[0].accounts[1].isWritable;
}
function balanceRoles(pre, post, e, owner) {
  for (const b of [pre, post]) {
    if (!b) { continue; }
    check(b.mint === e.mint && b.uiTokenAmount.decimals === 9 && (b.owner === undefined || b.owner === null || b.owner === owner) &&
      (b.programId === undefined || b.programId === null || b.programId === SPL_TOKEN_PROGRAM), 'balance mint/owner/program/decimals');
  }
}
function balanceEvidenceMissing(pre, post) {
  return !pre || !post || pre.owner === undefined || pre.owner === null || post.owner === undefined || post.owner === null ||
    pre.programId === undefined || pre.programId === null || post.programId === undefined || post.programId === null;
}
function delta({ sides, meta, nodes, metas, e }, address, owner, expectedDelta, effect) {
  const index = metas.findIndex(a => a.address === address); let pre = sides[0]?.get(index), post = sides[1]?.get(index);
  balanceRoles(pre, post, e, owner);
  let preEvidence = 'captured';
  if (!pre && sides[0] && address === e.recipientATA && createdATA(meta, nodes, metas, e, effect)) {
    pre = { amount: 0n, owner, programId: SPL_TOKEN_PROGRAM }; preEvidence = 'created-ATA-zero';
  }
  if (pre && post) { check(post.amount - pre.amount === expectedDelta, 'exact token balance delta'); }
  if (pre && address === e.poolATA && e.direction === 'burn') { check(pre.amount + decimal(e.amount) <= U64_MAX, 'intermediate pool balance u64 overflow'); }
  if (balanceEvidenceMissing(pre, post)) {
    return { address, status: 'unknown', reason: 'Missing token balance/owner/classic-program evidence' };
  }
  return { address, status: 'known', pre: pre.amount, post: post.amount, delta: expectedDelta, preEvidence };
}

function selectedEffects(effects, root, pool, e, amount) {
  if (e.direction === 'mint') {
    check(effects.length === 1 && effects[0].kind === 'mint', 'unique selected mint effect required'); const mint = effects[0];
    check(mint.node.parent === pool && mint.amount === amount, 'mint owning invocation/amount');
    role(mint.node, 0, e.mint, true); role(mint.node, 1, e.recipientATA, true); role(mint.node, 2, e.poolSigner); return [mint];
  } else {
    check(effects.length === 2 && effects[0].kind === 'transferChecked' && effects[1].kind === 'burn', 'transferChecked before unique Burn required');
    const [transfer, burn] = effects;
    check(transfer.node.parent === root && burn.node.parent === pool && transfer.node.ordinal < pool.ordinal && transfer.amount === amount && burn.amount === amount, 'reverse owning invocation/order/amount');
    role(transfer.node, 0, e.sourceATA, true); role(transfer.node, 1, e.mint); role(transfer.node, 2, e.poolATA, true); role(transfer.node, 3, e.spender);
    role(burn.node, 0, e.poolATA, true); role(burn.node, 1, e.mint, true); role(burn.node, 2, e.poolSigner); return effects;
  }
}
function requestEvent(events, root, wire, e, amount) {
  const d = events[0].decoded, h = d.message.header, token = d.message.tokenAmounts[0];
  check(h.messageId === e.messageId && h.sourceChainSelector === decimal(e.sourceChainSelector) && h.destChainSelector === decimal(e.destChainSelector) &&
    h.sequenceNumber === decimal(e.sequenceNumber) && h.nonce === decimal(e.nonce) && d.message.tokenAmounts.length === 1 &&
    d.message.sender.toString('hex') === hexKey(e.sourceOwner) && d.message.receiver.equals(wire.receiver) && d.message.data.equals(wire.data) && d.message.extraArgs.equals(wire.extraArgs) &&
    token.sourcePoolAddress.toString('hex') === hexKey(e.poolState) && token.destTokenAddress.toString('hex') === e.evmToken.slice(2).padStart(64, '0') &&
    d.message.feeToken.toString('hex') === hexKey(root.accounts[6].address) && token.destExecData.length === 4 &&
    token.extraData.toString('hex') === '00'.repeat(31) + '09' && token.amount === amount, 'request event selected identity/route/amount');
}
function selectedEvents(emitted, { root, pool, wire }, e, amount) {
  const events = [];
  for (const event of emitted) {
    const discriminator = event.raw.subarray(0, 8).toString('hex');
    if (['174d49b77bb97339', 'b9b08c70ef4e1ff9'].includes(discriminator)) {
      check(event.owner === root, 'CCIP event wrong owning invocation/program');
      events.push({ ...event, decoded: decodeDevSvmEvent(event.raw) });
    }
  }
  if (e.direction === 'mint') {
    check(events.length === 2, 'execution events missing/ambiguous');
    for (const [i, event] of events.entries()) {
      const d = event.decoded;
      check(d.eventName === 'ExecutionStateChanged' && d.messageId === e.messageId && d.sourceChainSelector === decimal(e.sourceChainSelector) &&
        d.sequenceNumber === decimal(e.sequenceNumber) && d.messageHash === e.messageHash && d.state === i + 1, 'execution event identity/state');
    }
    check(events[0].logIndex < pool.invokeLogIndex && events[1].logIndex > pool.successLogIndex, 'execution event/effect order');
  } else {
    check(events.length === 1 && events[0].decoded.eventName === 'CCIPMessageSent' && events[0].logIndex > pool.successLogIndex, 'request event owning invocation/order');
    requestEvent(events, root, wire, e, amount);
  }
  return events;
}

/**
 * decodeDevSvmCpiCapture(rawResponseBuffer, expectedContext) -> deeply frozen
 * public DTO. Malformed/contradictory captures throw; absent account capabilities
 * remain unknown. All selector/amount inputs are decimal strings. No IO/effects.
 * Capacities above are DEV admission bounds, not Solana/CCIP guarantees.
 */
export function decodeDevSvmCpiCapture(raw, expected) {
  check(Buffer.isBuffer(raw) && raw.length <= 262144, 'transaction capacity/raw Buffer required'); context(expected); const e = expected;
  check(hash(raw) === e.sourceSha256, 'selected raw digest mismatch');
  const response = parseResponse(raw), t = response?.result;
  check(response?.jsonrpc === '2.0' && response.error === undefined && t?.meta?.err === null, 'missing/failed transaction');
  check(Number.isSafeInteger(t.slot) && t.slot >= 0 && String(t.slot) === e.slot, 'selected slot');
  check(t.version === 0 || t.version === 'legacy', 'unsupported transaction version');
  const signatures = boundedArray(t.transaction?.signatures, 256, 'signatures');
  check(signatures[0] === e.transactionId && new Set(signatures).size === signatures.length, 'selected transaction/repeated signature');
  for (const signature of signatures) { check(base58(signature, 88).length === 64, 'signature bytes'); }
  const m = t.transaction.message; solanaPublicKeyBytes(m.recentBlockhash);
  const metas = accounts(m, t.meta, t.version, signatures), nodes = instructions(m, t.meta, metas), emitted = logs(t.meta, nodes);
  const roots = nodes.filter(n => n.program === (e.direction === 'mint' ? e.offRamp : e.router));
  check(roots.length === 1, 'missing/ambiguous selected Router/OffRamp invocation'); const root = roots[0]; rootRoles(root, e);
  const wire = rootWire(root, e), pools = nodes.filter(n => n.program === BURNMINT && n.parent === root);
  check(pools.length === 1, 'missing/ambiguous selected BurnMint invocation'); const pool = pools[0]; poolRoles(pool, root, e, wire);
  const effects = splEffects(nodes, e), amount = decimal(e.amount);
  const selected = selectedEffects(effects, root, pool, e, amount), events = selectedEvents(emitted, { root, pool, wire }, e, amount);
  const sides = balances(t.meta, metas), balanceContext = { sides, meta: t.meta, nodes, metas, e }, balanceDeltas = e.direction === 'mint' ?
    [delta(balanceContext, e.recipientATA, e.recipient, amount, selected[0].node)] :
    [delta(balanceContext, e.sourceATA, e.sourceOwner, -amount, selected[0].node), delta(balanceContext, e.poolATA, e.poolSigner, 0n, selected[1].node)];
  return publicDto({ schema: 'agtmai-dev-svm-cpi-capture-v1', testOnly: true, broadcastAllowed: false, evidenceClass: 'unverified-capture-replay',
    claim: 'captured-consistency-only', capturedConsistency: balanceDeltas.every(b => b.status === 'known') ? 'known' : 'unknown',
    sourcePath: e.sourcePath, sourceSha256: e.sourceSha256, transactionId: e.transactionId, slot: e.slot,
    indexScheme: DEV_SVM_CAPTURE_INDEX_SCHEME, direction: e.direction, messageId: e.messageId,
    instructionAuthority: DEV_SVM_CAPTURE_AUTHORITY, selectedInvocation: location(root), selectedInstruction: wire, selectedPoolInvocation: location(pool),
    accounts: metas, logs: t.meta.logMessages, instructions: nodes.map(n => ({ ...location(n), stackHeight: n.depth, accountIndexes: n.accounts.map(a => a.accountIndex),
      dataHex: n.data.toString('hex'), invokeLogIndex: n.invokeLogIndex, successLogIndex: n.successLogIndex })),
    effects: selected.map(f => ({ ...location(f.node), kind: f.kind, opcode: f.opcode, amount: f.amount, decimals: f.checked ? 9 : null,
      mint: f.node.accounts[f.kind === 'mint' ? 0 : 1].address,
      sourceAccount: f.kind === 'mint' ? null : f.node.accounts[0].address,
      destinationAccount: f.kind === 'burn' ? null : f.node.accounts[f.kind === 'mint' ? 1 : 2].address,
      authority: f.node.accounts[f.kind === 'transferChecked' ? 3 : 2].address })),
    // Logs are binding evidence for a physical instruction/effect, not a second
    // ordinal scheme or multiple effects at the owning invocation's ordinal.
    events: events.map(v => ({ owningInstructionOrdinal: v.owner.ordinal, instructionPath: v.owner.path,
      program: v.owner.program, logIndex: v.logIndex, rawSha256: hash(v.raw), decoded: v.decoded })), balanceDeltas,
    capabilities: { pdaAndAtaDerivation: 'unknown', historicalRouteAuthorization: 'unknown', programBinaryOwnership: 'unknown',
      mintAuthorityAndDelegateState: 'unknown', cpiSignerPrivilege: 'unknown', poolArgumentLayout: 'known', captureAuthenticity: 'unknown',
      historicalCommitAndMerkleProofAuthorization: 'unknown', unselectedInstructionSemantics: 'unknown',
      freshFinality: 'unknown', currentSettlement: 'unknown', completeInventory: 'unknown', commonBackingSupplySnapshot: 'unknown' } });
}
