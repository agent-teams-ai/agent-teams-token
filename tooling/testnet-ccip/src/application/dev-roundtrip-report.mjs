import { admitEnvelope, admitOwnership, admitMoney, cutReasons, legacyEvents, legacyEventViews, legacyIdentity, ROLES, decimal, PROOF_SHA256 } from '../domain/dev-roundtrip-report.mjs';

const strings = value => {
  if (typeof value === 'bigint') { return value.toString(); }
  if (Array.isArray(value)) { return value.map(strings); }
  if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strings(v)])); }
  return value;
};
const identityEqual = (a, b) => ['messageId', 'direction', 'amount', 'sourceToken', 'destinationToken', 'recipient'].every(k => a[k] === b[k]);
function admitRecordedRoute(context) {
  const r = context.route, observed = context.proof.feeAndAuthorityEvidence;
  const mint = observed.postSettlementAuthorities.solana.account.value.data.parsed.info;
  const forward = observed.solana.find(v => v.label === 'forwardA_destination').tokenEffects[0].parsed.info;
  const burn = observed.solana.find(v => v.label === 'reverse_source').tokenEffects[0].parsed.info;
  const bindings = [
    [r.pair.evm.pool, observed.postSettlementAuthorities.ethereum.fields['owner()'].contract],
    [r.pair.evm.sender, observed.ethereum.transactions.find(v => v.label === 'forwardA_source').from],
    [r.pair.evm.recipient, context.proof.threeMessageStatus.transfers[1].identity.recipient],
    [r.pair.svm.signer, mint.mintAuthority], [r.pair.svm.sourceAta, forward.account], [r.pair.svm.poolAta, burn.account],
    [r.pair.svm.sender, observed.reverseNativePayment.transfer.source],
  ];
  if (bindings.some(([actual, expected]) => actual !== expected)) { throw new Error('Selected route differs from recorded historical bindings'); }
  // Comparing recorded identities to expectations does not turn the late account
  // observation into past authorization. Unrecorded context capabilities stay unknown.
}
function selectedProof(context) {
  if (!context.proof) { return null; }
  const p = context.proof.threeMessageStatus, r = context.route;
  admitRecordedRoute(context);
  if (context.hashes.proof !== PROOF_SHA256 || r.profile !== 'fixture100' || r.fixedSupplyBaseUnits !== p.accounting.snapshot.fixedSupply ||
      p.transfers.some(t => t.identity.sourceToken !== (t.identity.direction === 'ethereum-to-solana' ? r.pair.evm.token : r.pair.svm.mint) ||
        t.identity.destinationToken !== (t.identity.direction === 'ethereum-to-solana' ? r.pair.svm.mint : r.pair.evm.token))) {
    throw new Error('Immutable historical fixture/profile/token binding mismatch');
  }
  for (const m of context.input.messages) {
    if (!p.transfers.some(t => t.sourceHash === m.sourceTransaction && identityEqual(t.identity, m.identity))) { throw new Error('Selected historical proof identity/source mismatch'); }
  }
  return p;
}
function recordedSnapshot(proof) {
  const s = proof.accounting.snapshot;
  return { totalSupply: s.fixedSupply, lockedOnEthereum: s.lockedOnEthereum, supplyOnSolana: s.supplyOnSolana,
    pendingEthereumToSolana: '0', pendingSolanaToEthereum: '0',
    ethereum: { height: s.ethereumHeight, hash: s.ethereumBlock }, solana: { height: String(s.solanaSlot), hash: null },
    observedAt: s.observedAt, freshnessCheckedAt: s.freshnessCheckedAt ?? null, freshness: s.freshness,
    provenance: 'selected-immutable-recorded-proof', coherent: s.coherent, finalized: true };
}
function recordedMessage(m, proof) {
  const t = proof.transfers.find(record => record.identity.messageId === m.identity.messageId);
  return { ...m, events: t.events.map(e => ({ identity: t.identity, routeHash: m.routeHash, chain: e.chain, kind: e.kind,
    transactionId: e.transactionId, eventIndex: e.eventIndex, indexScheme: e.chain === 'solana' ? 'svm-recorded-legacy-v1' : 'evm-log-index-v1',
    instructionPath: null, owningInstructionPath: null, blockHash: e.blockHash, blockHeight: e.blockHeight, finality: e.finality })),
    diagnostics: [], captures: [], native: { availability: 'recorded-only', originalRawBytes: 'missing', reverified: false },
    qualification: 'recorded-settlement-at-original-time; legacy indices preserved' };
}
function unknownProjection(identity, reason) { return { identity, status: 'unknown', pendingAmount: null, reasons: [reason] }; }
async function collectMessages(context, proof, readCaptures) {
  const { input, route, routeHash } = context, messages = [];
  for (const m of input.messages) { admitEnvelope(route, routeHash, m, input.expected.receivers); }
  for (const m of input.messages) {
    if (input.mode === 'recorded-proof') { messages.push(recordedMessage(m, proof)); }
    else if (input.mode === 'historical-capture-replay') { messages.push(await readCaptures(route, input.expected, m)); }
    else { messages.push({ ...m, events: m.modeledEvents, diagnostics: [], native: { availability: 'modeled-only' }, captures: [], qualification: input.mode }); }
  }
  return messages;
}
function projectReportMessage(message, admission, mode, projectMessage) {
  const invalid = message.diagnostics.filter(d => d.status === 'inconsistent');
  const projection = message.events.some(e => !e.blockHash) ? unknownProjection(message.identity, 'original-block-provenance-missing') :
    projectMessage(legacyIdentity(message.identity), legacyEvents(message));
  const real = mode === 'historical-capture-replay', downgrade = real || mode === 'fixture-only';
  const mixed = admission.reasons.includes('mixed-index-schemes');
  const alternatives = mixed && projection.status === 'inconsistent' ?
    legacyEventViews(message).map(events => projectMessage(legacyIdentity(message.identity), events)) : [projection];
  const role = ROLES[message.identity.direction];
  const sourceObserved = message.events.some(e => e.chain === role.source && e.kind === role[role.source]);
  // A compatible view can prove distinct same-scheme effects. Dropping another
  // scheme's source observation cannot prove an orphan. No view admits pending.
  const conflicts = alternatives.filter(p => p.status === 'inconsistent' &&
    !(mixed && sourceObserved && p.reasons.includes('orphan-settlement')));
  const inconsistent = invalid.length || admission.status === 'inconsistent' || conflicts.length;
  const status = inconsistent ? 'inconsistent' : admission.status ?? (downgrade && projection.status !== 'inconsistent' ? 'unknown' : projection.status);
  const reasons = [...admission.reasons, ...invalid.map(d => d.reason), ...projection.reasons, ...conflicts.flatMap(p => p.reasons)];
  if (real) { reasons.push('capture-authenticity-event-time-authorization-and-chain-finality-unknown'); }
  if (mode === 'fixture-only') { reasons.push('fixture-is-not-authenticated-settlement'); }
  return { identity: message.identity, sourceTransaction: message.sourceTransaction, status,
    pendingAmount: status === 'inconsistent' || status === 'unknown' || real ? null : projection.pendingAmount,
    reasons: [...new Set(reasons)], projection: strings(projection), observations: message.events, native: message.native,
    captures: message.captures, diagnostics: message.diagnostics, qualification: message.qualification };
}
function inventoryAdmission(input, proof, messages, perMessage, snapshot) {
  const simulation = input.mode === 'local-event-simulation', recorded = input.mode === 'recorded-proof';
  const fullRecorded = recorded && proof && input.messages.length === proof.transfers.length;
  const cut = cutReasons(messages, snapshot), projectionKnown = perMessage.every(m => !['unknown', 'inconsistent'].includes(m.status));
  const inventoryKnown = Boolean((simulation || fullRecorded) && input.completeInventory && projectionKnown);
  const pendingAvailable = typeof snapshot?.pendingEthereumToSolana === 'string' && typeof snapshot?.pendingSolanaToEthereum === 'string';
  const modelCut = !simulation || snapshot?.coherent === true && snapshot?.finalized === true;
  const pendingKnown = inventoryKnown && !cut.length && pendingAvailable && modelCut && (simulation || perMessage.every(m => m.status === 'settled'));
  return { simulation, recorded, cut, inventoryKnown, projectionKnown, pendingKnown };
}
function modeledLedgerReasons(snapshot, perMessage) {
  let ES = 0n, SE = 0n;
  for (const message of perMessage) {
    if (message.pendingAmount === null) { return ['modeled-pending-unknown']; }
    if (message.identity.direction === 'ethereum-to-solana') { ES += BigInt(message.pendingAmount); } else { SE += BigInt(message.pendingAmount); }
  }
  return ES === decimal(snapshot.pendingEthereumToSolana) && SE === decimal(snapshot.pendingSolanaToEthereum) ? [] : ['modeled-pending-ledger-mismatch'];
}
function moneyIncidents(values, reconciliation) {
  const incidents = [];
  if (values.S !== null && decimal(values.S, 64) > decimal(values.F, 64)) { incidents.push('observed-solana-overissuance'); }
  if (values.S !== null && values.P_ES !== null && values.P_SE !== null &&
      decimal(values.S, 64) + decimal(values.P_ES) + decimal(values.P_SE) > decimal(values.F, 64)) { incidents.push('known-liabilities-exceed-fixed-supply'); }
  if (reconciliation?.status === 'under-backed') { incidents.push('under-backed'); }
  if (reconciliation?.status === 'surplus') { incidents.push('surplus-requires-classification'); }
  return incidents;
}
function reconcileReportMoney(route, snapshot, admission, perMessage, reconcileSupply) {
  const adjustedSnapshot = snapshot ? { ...snapshot, pendingEthereumToSolana: admission.pendingKnown ? snapshot.pendingEthereumToSolana : null,
    pendingSolanaToEthereum: admission.pendingKnown ? snapshot.pendingSolanaToEthereum : null } : null;
  const money = admitMoney(route, adjustedSnapshot), reasons = [...money.reasons, ...admission.cut];
  if (!admission.inventoryKnown) { reasons.push('complete-scoped-inventory-not-established'); }
  if (!admission.pendingKnown || money.missing) { reasons.push('pending-or-snapshot-inputs-unknown'); }
  if (!admission.projectionKnown) { reasons.push('message-reconciliation-required'); }
  if (admission.simulation && snapshot && (!snapshot.coherent || !snapshot.finalized)) { reasons.push('explicit-model-cut-incomplete'); }
  if (admission.simulation && admission.pendingKnown && perMessage.length && admission.projectionKnown) { reasons.push(...modeledLedgerReasons(snapshot, perMessage)); }
  const inconsistent = money.reasons.length > 0 || perMessage.some(m => m.status === 'inconsistent');
  let reconciliation = null;
  if (!reasons.length && !inconsistent) {
    reconciliation = strings(reconcileSupply({ fixedSupply: decimal(money.values.F), lockedOnEthereum: decimal(money.values.L), supplyOnSolana: decimal(money.values.S, 64),
      pendingEthereumToSolana: decimal(money.values.P_ES), pendingSolanaToEthereum: decimal(money.values.P_SE) }));
    reconciliation.qualification = admission.simulation ? 'exact-in-model; algebra does not prove inventory or authenticity' : 'recorded-at-original-time';
  }
  return { ...money.values, reconciliation, reasons: [...new Set(reasons)], incidents: moneyIncidents(money.values, reconciliation), inconsistent };
}
function evidenceClassFor(mode, proof, messages) {
  if (mode === 'recorded-proof') { return 'historical-real-testnet-proof'; }
  if (mode === 'local-event-simulation') { return 'local-event-simulation'; }
  const replayAvailable = messages.some(m => ['ethereum', 'solana'].some(chain => m.native[chain]?.availability === 'decoded'));
  return proof && replayAvailable ? 'historical-capture-replay' : 'fixture-only';
}
function aggregateStatus(money, simulation) {
  if (money.inconsistent) { return 'inconsistent'; }
  if (!money.reconciliation) { return 'unknown'; }
  if (!simulation) { return 'recorded-settled'; }
  return money.reconciliation.status === 'exact' ? 'exact-in-model' : money.reconciliation.status;
}
function proofSummary(context, proof) {
  if (!proof) { return null; }
  return { sha256: PROOF_SHA256, qualification: 'Recorded fixture100 settlement only; no new current/fresh claim',
    originalSnapshot: proof.accounting.snapshot, recordedAccounting: proof.accounting,
    originalRawFiles: context.proof.feeAndAuthorityEvidence.solana.map(v => ({ path: v.sourceFile, sha256: v.sourceSha256, availability: 'missing' })),
    postSettlementAuthorization: 'Late current readback does not prove event-time authorization' };
}
/** Narrow ports contain the unchanged compiled pure algorithms and finite capture
 * reads. Global ownership completes before any projection; no status lifecycle. */
export async function prepareDevRoundtripReport(context, { projectMessage, reconcileSupply, readCaptures, digest }) {
  const { input, route, routeHash } = context, proof = selectedProof(context);
  const messages = await collectMessages(context, proof, readCaptures), ownership = admitOwnership(messages);
  const perMessage = messages.map((m, i) => projectReportMessage(m, ownership[i], input.mode, projectMessage));
  const snapshot = input.mode === 'recorded-proof' ? recordedSnapshot(proof) : input.snapshot;
  const admission = inventoryAdmission(input, proof, messages, perMessage, snapshot);
  const { inconsistent: _inconsistent, ...monetary } = reconcileReportMoney(route, snapshot, admission, perMessage, reconcileSupply);
  const evidenceClass = evidenceClassFor(input.mode, proof, messages), knownness = admission.recorded ? 'recorded-known' : 'known-in-model';
  const body = strings({ schema: 'agtmai-dev-roundtrip-report-v1', testOnly: true, broadcastAllowed: false, readOnly: true,
    status: aggregateStatus({ ...monetary, inconsistent: _inconsistent }, admission.simulation),
    evidenceClass, profile: route.profile, routeHash, planHash: context.planHash, source: route.source,
    expectedContextHash: digest(input.expected), pinHashes: route.source.pins, inputHashes: context.hashes, messages: perMessage,
    inventory: { scope: admission.recorded ? 'operator-declared-complete-fixed-test-fixture' : admission.simulation ? 'explicit-bounded-model' : 'explicit-captures-only',
      knownness: admission.inventoryKnown ? knownness : 'unknown', count: messages.length, assertedComplete: input.completeInventory },
    pending: { knownness: admission.pendingKnown ? knownness : 'unknown', P_ES: monetary.P_ES, P_SE: monetary.P_SE },
    snapshot, monetary: { ...monetary, classifications: input.classifications }, recordedProof: proofSummary(context, proof),
    observationClass: input.mode === 'historical-capture-replay' ? 'unverified-capture-replay' : evidenceClass,
    capabilities: { currentSettlement: 'unknown', freshChainFinality: 'unknown', eventTimeAuthorization: 'unknown', programBinaryProvenance: 'unknown',
      cpiSignerDelegateAuthority: 'unknown', captureIntegrityIsChainTruth: false },
    qualifications: [admission.simulation ? 'Simulation algebra is exact only in the explicit model' : admission.recorded ? 'Historical qualification retained at original observation/check times' : 'Hashes and asserted complete/coherent/finalized flags do not authenticate observations',
      'Recovered recaptures are separate observations; original serialized source-hash bytes remain missing',
      'Voluntary wallet burn/backing donation are separate classifications, never CCIP return', 'Offline report only; no live CCIP E2E, production or Mainnet readiness'] });
  return { ...body, reportHash: digest(body) };
}
