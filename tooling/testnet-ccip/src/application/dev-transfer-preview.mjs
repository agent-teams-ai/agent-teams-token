import { admitDevTransfer, PREVIEW_SOURCE, PREVIEW_PINS, validatePreviewRoute, U64 } from '../domain/dev-transfer-preview.mjs';

export const PROVIDER_PREREQUISITE = 'Reviewed CCIP SDK 1.13.0 npm installation with root manifest SHA256 ' + PREVIEW_PINS.providerManifestSha256 + ' and package-lock.json SHA256 ' + PREVIEW_PINS.providerLockSha256 + '; lock-integrity tarballs for SDK resolver metadata/IDL, ethers 6.17.0, @solana/web3.js and their resolved runtime closure; independently admitted entries before evaluation. No provider is loaded by this checkpoint.';
function quoteIdentityMatches(input, reverse, quote) {
  const recipient = reverse ? input.pair.evm.recipient : input.pair.svm.recipient;
  const selector = reverse ? input.lane.ethereumSelector : input.lane.solanaSelector;
  const feeToken = reverse ? '11111111111111111111111111111111' : '0x' + '0'.repeat(40);
  return quote.amount === input.amount && quote.selector === selector && quote.recipient === recipient && quote.feeToken === feeToken;
}
function quoteFacts(input, direction) {
  const quote = input.quotes[direction], reasons = [], conflicts = [];
  if (!quote) {return { value: null, reasons: ['Native CCIP quote missing'], conflicts };}
  const reverse = direction === 'reverse', maximum = reverse ? 100000000n : 10000000000000000n;
  if (!quoteIdentityMatches(input, reverse, quote)) { conflicts.push('Quote amount/route/native fee token mismatch'); }
  const fee = BigInt(quote.ccipFee);
  if (fee <= 0n || fee > maximum) {conflicts.push('Quote outside retained DEV CCIP fee cap');}
  if (reverse && [quote.networkFee, quote.rent, quote.payerBalance, quote.exposureLimit].some(v => v !== null && BigInt(v) > U64)) {conflicts.push('Native lamports overflow u64');}
  if (Date.parse(quote.observedAt) > Date.parse(quote.checkedAt) || Date.parse(quote.expiresAt) <= Date.parse(quote.checkedAt) || Date.parse(quote.observedAt) >= Date.parse(quote.expiresAt)) {reasons.push('Quote expired or inconsistent at declared check time');}
  if (JSON.stringify(quote.context) !== JSON.stringify(input.states[direction]?.context)) {conflicts.push('Quote before-state provenance mismatch');}
  if (reverse && BigInt(quote.exposureLimit) > 10000000000n) {conflicts.push('Declared SOL exposure exceeds DEV bound');}
  const missingComponents = ['networkFee', 'rent', 'payerBalance'].filter(k => quote[k] === null);
  reasons.push(...missingComponents.map(k => 'Native ' + k + ' unknown'));
  const totalExposure = missingComponents.length ? null : (fee + BigInt(quote.networkFee) + BigInt(quote.rent)).toString();
  if (totalExposure !== null && (BigInt(totalExposure) > BigInt(quote.exposureLimit) || BigInt(totalExposure) > BigInt(quote.payerBalance))) {reasons.push('Insufficient balance or declared native exposure budget');}
  return { value: quote, totalExposure, reasons, conflicts, current: false, executionTimeCeilingProven: false };
}
/** Consumer-owned digest/render ports have no filesystem, provider, signer or network capability. */
export function prepareDevTransferPreview(input, { digest, render }) {
  validatePreviewRoute(input);
  const source = { ...PREVIEW_SOURCE, pins: PREVIEW_PINS };
  const route = { source, lane: input.lane, pair: input.pair, profile: input.profile, fixedSupplyBaseUnits: input.fixedSupplyBaseUnits,
    decimals: 9, amount: input.amount, limiters: input.limiters };
  const routeHash = digest(route), legs = {};
  for (const direction of ['forward', 'reverse']) {
    const admission = admitDevTransfer(input, direction), quote = quoteFacts(input, direction), reverse = direction === 'reverse';
    const prerequisites = [...admission.reasons, ...quote.reasons, PROVIDER_PREREQUISITE];
    if (reverse && !input.blockhash) {prerequisites.push('Captured canonical blockhash and validity context missing');}
    if (!reverse && (!input.recipientAta || !input.recipientAta.exists)) {prerequisites.push('Separate standard recipient ATA creation with explicit payer/rent required before receive');}
    if (input.recipientAta && input.recipientAta.address !== input.pair.svm.sourceAta) {admission.conflicts.push('Recipient ATA binding mismatch');}
    const conflicts = [...admission.conflicts, ...quote.conflicts];
    const user = reverse ? input.pair.svm.payer : input.pair.evm.sender;
    const recipient = reverse ? input.pair.evm.recipient : input.pair.svm.recipient;
    const operations = [];
    if (admission.approval.required === true) {operations.push({ kind: 'bounded-approval-intent', from: user,
      token: reverse ? input.pair.svm.mint : input.pair.evm.token, spender: reverse ? input.pair.svm.spender : input.lane.router,
      amount: input.amount, conditional: true, bytes: null, byteSha256: null });}
    operations.push({ kind: 'send-intent', from: user, recipient, amount: input.amount, conditional: reverse,
      bytes: null, byteSha256: null, availability: 'unavailable' });
    let hypotheticalAfter = null;
    if (reverse && admission.status === 'admitted-in-model' && !conflicts.length) {
      const state = input.states.reverse;
      hypotheticalAfter = { sourceBalance: (BigInt(state.source.balance) - BigInt(input.amount)).toString(), poolBalance: state.poolAccount.balance,
        supply: (BigInt(state.mint.supply) - BigInt(input.amount)).toString(), delegate: null, delegatedAmount: '0',
        provenance: 'hypothetical; exhausted classic SPL delegation resets None' };
    }
    legs[direction] = { from: user, recipient, amount: input.amount, admission, quote, operations, prerequisites, conflicts, hypotheticalAfter,
      status: conflicts.length ? 'inconsistent' : 'intent-only', unsignedAvailable: false, executable: false,
      conditional: reverse, condition: admission.condition, executionPrerequisites: ['Fresh authenticated state, quotes, native gas/rent/balance and finality',
        ...(reverse ? ['Finalized receive; native serialized send has no proven execution-time fee ceiling'] : ['A failed send does not undo a finalized ERC20 approval'])] };
  }
  const status = Object.values(legs).some(l => l.conflicts.length) ? 'inconsistent' : 'intent-only';
  const planBody = { schema: 'agtmai-dev-transfer-plan-v1', schemaVersion: 1, testOnly: true, broadcastAllowed: false,
    source, route, routeHash, evidenceClass: 'fixture-only', status, input, legs };
  const plan = { ...planBody, planHash: digest(planBody) };
  const facts = { schema: 'agtmai-dev-transfer-facts-v1', schemaVersion: 1, testOnly: true, broadcastAllowed: false,
    source, routeHash, planHash: plan.planHash, evidenceClass: 'fixture-only', status, currentReadiness: null,
    knownness: { reason: 'Hypothetical/unauthenticated decoded input; no fresh native observations or provider encoding',
      forwardState: input.states.forward, conditionalReturnState: input.states.reverse, buckets: input.buckets,
      quotes: input.quotes, blockhash: input.blockhash, recipientAta: input.recipientAta },
    fixedSupplyBaseUnits: input.fixedSupplyBaseUnits, profile: input.profile, unsignedAvailable: { forward: false, reverse: false },
    historicalProofReferences: [], providerPrerequisite: PROVIDER_PREREQUISITE };
  return { plan, facts, summary: render(plan, facts) };
}
