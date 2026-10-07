// This feature admits evidence before the unchanged compiled projection/accounting.
// Physical ownership is global to this bounded report; block provenance is not a key.
export const PROOF_SHA256 = 'b694d89230f8726d244781661765c91739f4820f03c8682f52f91245b2a03e0a';
export const PROOF_PATH = 'docs/reports/AGTMAI-TESTNET-E2E-2026-09-08.json';
export const ROLES = Object.freeze({
  'ethereum-to-solana': { ethereum: 'lock', solana: 'mint', source: 'ethereum' },
  'solana-to-ethereum': { ethereum: 'release', solana: 'burn', source: 'solana' },
});
export function decimal(value, bits = 256) {
  if (typeof value !== 'string' || value.length > 78 || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= 1n << BigInt(bits)) {
    throw new Error('Canonical bounded monetary/height string required');
  }
  return BigInt(value);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function expectedIdentity(route, message) {
  const forward = message.identity.direction === 'ethereum-to-solana';
  return { messageId: message.identity.messageId, direction: message.identity.direction, amount: route.amount,
    sourceToken: forward ? route.pair.evm.token : route.pair.svm.mint,
    destinationToken: forward ? route.pair.svm.mint : route.pair.evm.token,
    recipient: forward ? message.identity.recipient : route.pair.evm.recipient };
}
export function admitEnvelope(route, routeHash, message, receivers) {
  if (!ROLES[message.identity.direction] || message.routeHash !== routeHash || !same(message.identity, expectedIdentity(route, message)) ||
      decimal(message.identity.amount, 64) === 0n || decimal(message.identity.amount, 64) > decimal(route.fixedSupplyBaseUnits, 64)) {
    throw new Error('Report route/direction/token/amount/recipient envelope mismatch');
  }
  if (message.identity.direction === 'ethereum-to-solana' && !receivers.some(r => r.recipient === message.identity.recipient)) {
    throw new Error('Recipient absent from independently selected expected route');
  }
}
function claimInventory(message, owner, tables, mark) {
  for (const [map, key, reason] of [[tables.ids, message.identity.messageId, 'duplicate-inventory-message-id'],
    [tables.sources, message.sourceTransaction, 'duplicate-inventory-source-transaction']]) {
    if (map.has(key)) { mark([owner, map.get(key)], 'unknown', reason); } else { map.set(key, owner); }
  }
}
function claimTransaction(event, owner, tables, mark) {
  const tx = event.chain + ':' + event.transactionId, block = JSON.stringify([event.blockHash, event.blockHeight]);
  let previousBlock = tables.blocks.get(tx);
  if (!previousBlock) {
    previousBlock = { fingerprint: block, owners: new Set(), contradicted: false };
    tables.blocks.set(tx, previousBlock);
  }
  previousBlock.owners.add(owner);
  if (previousBlock.fingerprint !== block) { previousBlock.contradicted = true; }
  if (previousBlock.contradicted) { mark([...previousBlock.owners], 'inconsistent', 'conflicting-transaction-block-provenance'); }
  const previousScheme = tables.schemes.get(tx);
  if (previousScheme && previousScheme.scheme !== event.indexScheme) { mark([owner, ...previousScheme.owners], 'unknown', 'mixed-index-schemes'); }
  if (previousScheme) { previousScheme.owners.add(owner); }
  else { tables.schemes.set(tx, { scheme: event.indexScheme, owners: new Set([owner]) }); }
}
function claimPhysical(event, owner, effects, mark) {
  const key = event.chain + ':' + event.transactionId + ':' + event.eventIndex;
  const fingerprint = JSON.stringify({ ...event, finality: undefined }), old = effects.get(key);
  if (old && old.owner !== owner) { mark([owner, old.owner], 'inconsistent', 'cross-message-effect-ownership'); }
  else if (old && old.indexScheme === event.indexScheme && old.fingerprint !== fingerprint) { mark([owner], 'inconsistent', 'conflicting-physical-observation'); }
  else if (!old) { effects.set(key, { owner, fingerprint, indexScheme: event.indexScheme }); }
  if (event.finality === 'reorged') { mark([owner], 'unknown', 'reorg-reconciliation-required'); }
}
function admitObservationRole(event, message, owner, mark) {
  const role = ROLES[message.identity.direction];
  const validScheme = event.chain === 'ethereum' ? event.indexScheme === 'evm-log-index-v1' :
    ['svm-recorded-legacy-v1', 'svm-physical-interleaved-v1'].includes(event.indexScheme);
  if (!validScheme) { mark([owner], 'unknown', 'wrong-chain-index-scheme'); }
  const allowed = role && (event.kind === role[event.chain] || event.kind === 'internal-transfer' && event.chain === 'solana' && role.solana === 'burn');
  if (!allowed || !same(event.identity, message.identity) || event.routeHash !== message.routeHash) { mark([owner], 'inconsistent', 'wrong-chain-kind-or-identity'); }
  if (event.chain === role?.source && event.transactionId !== message.sourceTransaction) { mark([owner], 'inconsistent', 'source-transaction-mismatch'); }
}
export function admitOwnership(messages) {
  const reasons = messages.map(() => []), status = messages.map(() => null);
  const tables = { effects: new Map(), schemes: new Map(), ids: new Map(), sources: new Map(), blocks: new Map() };
  const mark = (indices, level, reason) => { for (const i of indices) {
    if (status[i] !== 'inconsistent') { status[i] = level; }
    if (!reasons[i].includes(reason)) { reasons[i].push(reason); }
  } };
  for (const [owner, message] of messages.entries()) {
    claimInventory(message, owner, tables, mark);
    for (const event of message.events) {
      claimTransaction(event, owner, tables, mark);
      admitObservationRole(event, message, owner, mark);
      claimPhysical(event, owner, tables.effects, mark);
    }
  }
  for (const group of tables.schemes.values()) {
    if ([...group.owners].some(i => reasons[i].includes('mixed-index-schemes'))) { mark([...group.owners], 'unknown', 'mixed-index-schemes'); }
  }
  return messages.map((_message, i) => ({ status: status[i], reasons: reasons[i] }));
}
export function legacyIdentity(identity) { return { ...identity, amount: decimal(identity.amount, 64) }; }
export function legacyEvents(message) {
  return message.events.filter(e => e.kind !== 'internal-transfer').map(e => ({ ...legacyIdentity(e.identity),
    chain: e.chain, kind: e.kind, transactionId: e.transactionId, eventIndex: e.eventIndex,
    blockHash: e.blockHash, blockHeight: decimal(e.blockHeight, 64), finality: e.finality }));
}
// Each view contains one observed scheme per chain:transaction. These are
// conflict witnesses, never a choice of canonical ordinals or settlement facts.
export function legacyEventViews(message) {
  const transactions = new Map();
  for (const e of message.events.filter(event => event.kind !== 'internal-transfer')) {
    const key = e.chain + ':' + e.transactionId;
    if (!transactions.has(key)) { transactions.set(key, new Map()); }
    const schemes = transactions.get(key);
    if (!schemes.has(e.indexScheme)) { schemes.set(e.indexScheme, []); }
    schemes.get(e.indexScheme).push(e);
  }
  let views = [[]];
  for (const schemes of transactions.values()) {
    views = views.flatMap(view => [...schemes.values()].map(events => [...view, ...events]));
  }
  return views.map(events => legacyEvents({ events }));
}
function observationCutReason(event, watermark, source) {
  const height = decimal(event.blockHeight, 64), cut = decimal(watermark.height, 64);
  if (height > cut) { return event.chain === source ? 'source-after-snapshot-watermark' : 'settlement-after-snapshot-watermark'; }
  if (height === cut && typeof watermark.hash === 'string' && typeof event.blockHash === 'string' && event.blockHash !== watermark.hash) {
    return 'event-block-hash-conflicts-with-snapshot-watermark';
  }
  return null;
}
export function cutReasons(messages, snapshot) {
  if (!snapshot?.ethereum || !snapshot?.solana) { return ['snapshot-watermarks-missing']; }
  const reasons = [];
  for (const m of messages) {
    const source = ROLES[m.identity.direction].source;
    const includedSource = m.events.some(observed => observed.chain === source && observed.kind !== 'internal-transfer' && observed.finality === 'finalized' && !observationCutReason(observed, snapshot[observed.chain], source));
    for (const e of m.events.filter(observation => observation.kind !== 'internal-transfer')) {
      const reason = observationCutReason(e, snapshot[e.chain], source);
      if (reason) { reasons.push(reason); }
      if (!reason && e.chain !== source && !includedSource) { reasons.push('destination-before-included-finalized-source'); }
    }
  }
  return [...new Set(reasons)];
}
export function admitMoney(route, snapshot) {
  const reasons = [], values = { F: route.fixedSupplyBaseUnits, totalSupply: snapshot?.totalSupply ?? null,
    L: snapshot?.lockedOnEthereum ?? null, S: snapshot?.supplyOnSolana ?? null,
    P_ES: snapshot?.pendingEthereumToSolana ?? null, P_SE: snapshot?.pendingSolanaToEthereum ?? null };
  const F = decimal(values.F, 64);
  if (F === 0n) { reasons.push('fixed-supply-must-be-positive'); }
  if (values.totalSupply !== null && decimal(values.totalSupply) !== F) { reasons.push('immutable-evm-total-supply-mismatch'); }
  if (values.L !== null && decimal(values.L) > F) { reasons.push('locked-backing-exceeds-fixed-supply'); }
  if (values.S !== null) { decimal(values.S, 64); }
  for (const v of [values.P_ES, values.P_SE]) { if (v !== null) { decimal(v); } }
  return { values, reasons, missing: Object.values(values).some(v => v === null) };
}
