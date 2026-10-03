import { solanaPublicKeyBytes, SPL_TOKEN_PROGRAM } from './solana-mint.ts';

export const PREVIEW_SOURCE = Object.freeze({
  sourceRevision: 'a46230b4cd46740223ca3904e0a1278ddd361cd6',
  sourceTree: '99253c2c24d67c96ca184555fd3d2a0954506b46',
});
export const PREVIEW_LANE = Object.freeze({
  chainId: '11155111', ethereumSelector: '16015286601757825753',
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', solanaSelector: '16423721717087811551',
  router: '0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59',
  rmn: '0xba3f6251de62ded61ff98590cb2fdf6871fbb991', registry: '0x95f29fee11c5c55d26cccf1db6772de953b37b82',
  routerProgram: 'Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C',
  rmnProgram: 'RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7',
  feeQuoterProgram: 'FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi',
  poolProgram: '41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB', tokenProgram: SPL_TOKEN_PROGRAM,
});
export const PREVIEW_PINS = Object.freeze({
  sdkVersion: '1.13.0', ethersVersion: '6.17.0', poolVersion: '1.6.1',
  configSha256: '1e5f163026be5ce0fb3aff47e654cd95e0bc180174b9f2d98a15505b19915940',
  poolArtifactSha256: '82dac8896b84a7abe909e076a4de830258e19f5aae50f48ce17cfe8305f74114',
  providerManifestSha256: '8cf7da517123c8be46f0a5fa14ef67904bf45bf4cfb972fc2c54be4b91cb56fb',
  providerLockSha256: '1477c1d04940f9556ff87eaf82de6f0f2eaa6f3585deea0f09bfdab8fba7f50f',
});
export const U64 = (1n << 64n) - 1n;
export function integer(value, bits = 64, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) {throw new Error('Canonical decimal integer required');}
  const n = BigInt(value);
  if (n >= 1n << BigInt(bits) || positive && n === 0n) {throw new Error('Integer outside range');}
  return n;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function validatePreviewMode(input) {
  if (input.schema !== 'agtmai-dev-transfer-input-v1' || input.schemaVersion !== 1 || input.testOnly !== true ||
    input.broadcastAllowed !== false || input.decimals !== 9 || !['fixture100', 'product100M'].includes(input.profile)) { throw new Error('Explicit offline TEST preview mode required'); }
}
function validateEvmActors(pair) {
  for (const name of ['token', 'pool', 'initialAdmin', 'registryAdmin', 'poolOwner', 'sender', 'recipient']) {
    if (typeof pair[name] !== 'string' || !/^0x[0-9a-f]{40}$/.test(pair[name]) || /^0x0{40}$/.test(pair[name])) { throw new Error('Nonzero normalized EVM actor required'); }
  }
}
export function validatePreviewRoute(input) {
  validatePreviewMode(input);
  validateEvmActors(input.pair.evm);
  for (const [k, v] of Object.entries(PREVIEW_SOURCE)) {if (input[k] !== v) {throw new Error('Unreviewed source binding');}}
  for (const [k, v] of Object.entries(PREVIEW_LANE)) {if (input.lane[k] !== v) {throw new Error('Only pinned Sepolia/Devnet lane allowed');}}
  const fixed = input.profile === 'fixture100' ? '100000000000' : '100000000000000000';
  if (input.fixedSupplyBaseUnits !== fixed || integer(input.amount, 64, true) > BigInt(fixed)) {throw new Error('Amount or fixed supply profile mismatch');}
  const s = input.pair.svm;
  if (s.sender !== s.recipient || s.payer !== s.recipient || s.sourceAta === s.poolAta) {throw new Error('Receive/return user or distinct token account binding mismatch');}
  for (const k of ['mint', 'pool', 'signer', 'sourceAta', 'poolAta', 'spender', 'sender', 'registry', 'registryAdmin', 'poolOwner', 'rateAdmin']) {
    if (solanaPublicKeyBytes(s[k]).equals(Buffer.alloc(32))) {throw new Error('Zero required Solana identity');}
  }
  validateLimiters(input.limiters);
  return input;
}

function validateLimiters(limiters) {
  for (const name of ['evmOutbound', 'evmInbound', 'svmOutbound', 'svmInbound']) {
    const l = limiters[name], bits = name.startsWith('evm') ? 128 : 64;
    const cap = integer(l.capacity, bits), rate = integer(l.rate, bits);
    if (!l.enabled || (cap === 0n ? rate !== 0n : rate === 0n || rate > cap)) {throw new Error('Active or explicit pause limiter required; disabled is unlimited');}
  }
  for (const [out, incoming] of [['evmOutbound', 'svmInbound'], ['svmOutbound', 'evmInbound']]) {
    for (const k of ['capacity', 'rate']) {if (BigInt(limiters[out][k]) > BigInt(limiters[incoming][k])) {throw new Error('Unpaired limiter policy');}}
  }
}

/** Decoded facts are hypothetical/captured consistency, never authenticated readiness. */
function admitEvmState(input, state, { check, missing, conflict }, approval) {
  const p = input.pair, amount = BigInt(input.amount);
  const e = p.evm;
  for (const k of ['token', 'pool', 'initialAdmin', 'registryAdmin', 'pendingAdmin', 'poolOwner', 'sender']) {check(state[k], e[k], 'EVM ' + k + ' binding');}
  for (const k of ['router', 'rmn', 'registry']) {check(state[k], input.lane[k], 'EVM ' + k + ' binding');}
  check(state.artifactSha256, PREVIEW_PINS.poolArtifactSha256, 'Pool artifact');
  check(state.decimals, 9, 'EVM decimals'); check(state.totalSupply, input.fixedSupplyBaseUnits, 'EVM totalSupply');
  check(state.backingHolder, e.pool, 'Canonical backing holder'); check(state.registeredPool, e.pool, 'Token registration');
  check(state.remoteSelector, input.lane.solanaSelector, 'Remote selector');
  check(state.remoteTokenHex, solanaPublicKeyBytes(p.svm.mint).toString('hex'), 'Remote token raw32');
  check(state.remotePoolHex, solanaPublicKeyBytes(p.svm.pool).toString('hex'), 'Remote pool raw32');
  if (state.balance === null) {missing('ERC20 sender balance is unknown');}
  else if (BigInt(state.balance) < amount) {missing('Insufficient ERC20 sender balance');}
  else if (BigInt(state.balance) > BigInt(state.totalSupply)) { conflict('ERC20 sender balance exceeds total supply'); }
  check(state.allowanceOwner, e.sender, 'Allowance owner'); check(state.allowanceSpender, input.lane.router, 'Allowance spender');
  if (state.allowance === null) {missing('Router allowance is unknown');}
  else if (BigInt(state.allowance) === 0n) {approval.required = true;}
  else if (BigInt(state.allowance) === amount) {approval.required = false;}
  else {missing('Positive partial or excess allowance requires reconciliation');}
}

function admitSvmState(input, state, { check, missing, conflict }, approval) {
  const p = input.pair, amount = BigInt(input.amount);
  const s = p.svm, m = state.mint, source = state.source, pool = state.poolAccount;
  check(m.address, s.mint, 'Mint identity'); check(m.program, input.lane.tokenProgram, 'Classic mint owner');
  check(m.length, 82, 'Classic mint layout'); check(m.initialized, true, 'Mint initialized'); check(m.decimals, 9, 'Mint decimals');
  check(m.authority, s.signer, 'Direct Pool Signer mint authority'); check(m.freezeAuthority, null, 'Freeze None');
  for (const [account, address, owner] of [[source, s.sourceAta, s.sender], [pool, s.poolAta, s.signer]]) {
    check(account.address, address, 'Token account identity'); check(account.program, input.lane.tokenProgram, 'Classic token owner');
    check(account.length, 165, 'Classic token layout'); check(account.mint, s.mint, 'Token mint'); check(account.owner, owner, 'Token user/Pool Signer');
    check(account.state, 'initialized', 'Initialized unfrozen token account'); check(account.native, false, 'Non-native token account');
    check(account.closeAuthority, null, 'Close authority None');
  }
  check(pool.delegate, null, 'Pool delegate None'); check(pool.delegatedAmount, '0', 'Pool delegation zero');
  if (!state.commonBeforeState) {missing('Common before-state not established');}
  else if (BigInt(source.balance) + BigInt(pool.balance) > BigInt(m.supply)) {conflict('Distinct account balances exceed mint supply');}
  if (BigInt(m.supply) > BigInt(input.fixedSupplyBaseUnits)) {conflict('Observed overissuance; raw supply retained');}
  if (BigInt(source.balance) < amount) {missing('Insufficient return balance');}
  if (BigInt(pool.balance) + amount > U64) {conflict('Pool balance addition overflows u64');}
  if (source.delegate !== null && source.delegate !== s.spender) {missing('Foreign delegate requires reconciliation, including amount zero');}
  else if (source.delegate === null && source.delegatedAmount !== '0') {conflict('Absent delegate with nonzero delegatedAmount');}
  else if (source.delegatedAmount === '0') {approval.required = true;}
  else if (BigInt(source.delegatedAmount) === amount) {approval.required = false;}
  else {missing('Positive partial or excess delegation requires reconciliation');}
  for (const k of ['poolOwner', 'pendingOwner', 'rateAdmin', 'registryAdmin', 'pendingAdmin', 'signer', 'registry']) {check(state[k], s[k], 'SVM ' + k + ' binding');}
  check(state.pool, s.pool, 'Pool identity'); check(state.registryVersion, 2, 'Registry v2'); check(state.registryLength, 170, 'Registry length');
  check(state.registryProgram, input.lane.routerProgram, 'Registry owner'); check(state.poolProgram, input.lane.poolProgram, 'Pool owner program');
  check(state.supportsAutoDerivation, false, 'Registry auto derivation');
  check(state.registryAlt, s.alt.key, 'Registry ALT'); check(state.writableIndexes, s.alt.writableIndexes, 'Registry writable bitmap');
  const alt = state.alt;
  if (!alt) {missing('Captured ALT is missing');}
  else {
    check(alt.key, s.alt.key, 'ALT identity'); check(alt.authority, s.alt.authority, 'Separate ALT authority');
    check(alt.program, 'AddressLookupTab1e1111111111111111111111111', 'ALT owner'); check(alt.addresses, s.alt.addresses, 'ALT ordered addresses');
    check(alt.deactivationSlot, U64.toString(), 'ALT active');
    if (BigInt(alt.lastExtendedSlot) >= BigInt(state.context.point)) {conflict('ALT extension not active at captured slot');}
  }
  check(state.router, input.lane.routerProgram, 'Router'); check(state.rmn, input.lane.rmnProgram, 'RMN');
  check(state.remoteSelector, input.lane.ethereumSelector, 'Remote selector');
  check(state.remoteTokenHex, '0'.repeat(24) + p.evm.token.slice(2), 'Remote EVM token ABI32');
  check(state.remotePoolHex, p.evm.pool.slice(2), 'Remote EVM pool raw20');
}

function admitBuckets(input, direction, { check, missing, conflict }) {
  const p = input.pair, amount = BigInt(input.amount);
  for (const name of direction === 'forward' ? ['evmOutbound', 'svmInbound'] : ['svmOutbound', 'evmInbound']) {
    const bucket = input.buckets[name], expected = input.limiters[name];
    if (!bucket) { missing(name + ' bucket unknown'); continue; }
    for (const k of ['enabled', 'capacity', 'rate']) {check(bucket[k], expected[k], name + ' bucket policy');}
    check(bucket.owner, name.startsWith('evm') ? p.evm.pool : p.svm.pool, name + ' bucket owner');
    const context = input.states[name.startsWith('evm') ? 'forward' : 'reverse']?.context;
    if (!context) {missing(name + ' observation context missing');} else {check(bucket.context, context, name + ' bucket context');}
    if (BigInt(bucket.tokens) > BigInt(expected.capacity)) {conflict(name + ' tokens exceed capacity');}
    else if (expected.capacity === '0' || BigInt(bucket.tokens) < amount) {missing(name + ' paused or insufficient observed availability');}
  }
}

export function admitDevTransfer(input, direction) {
  const reasons = [], conflicts = [], state = input.states[direction], approval = { required: null, amount: input.amount };
  const checks = { missing: reason => reasons.push(reason), conflict: reason => conflicts.push(reason),
    check: (actual, expected, label) => { if (!same(actual, expected)) { conflicts.push(label); } } };
  if (!state) { checks.missing('Decoded before-state is missing'); }
  else if (direction === 'forward') { admitEvmState(input, state, checks, approval); }
  else { admitSvmState(input, state, checks, approval); }
  admitBuckets(input, direction, checks);
  return { status: conflicts.length ? 'inconsistent' : reasons.length ? 'prerequisite' : 'admitted-in-model', reasons, conflicts, approval,
    conditional: direction === 'reverse', condition: direction === 'reverse' ? 'Finalized receive and fresh return-state admission' : null };
}

/** Normalized, forward-only local codec intent. Model admission is not chain truth. */
export function forwardCallIntent(input, admission, quote) {
  validatePreviewRoute(input);
  const admitted = admission.status === 'admitted-in-model';
  // Native gas/rent/balance unknownness remains an execution prerequisite; a known
  // insufficient budget, expired quote or conflicting identity cannot supply send bytes.
  const quoteUsable = quote.value !== null && !quote.conflicts.length &&
    quote.reasons.every(reason => reason.startsWith('Native ') && reason.endsWith(' unknown'));
  const fee = quoteUsable ? quote.value.ccipFee : null;
  if (fee !== null && (integer(fee, 256, true) > 10000000000000000n)) {throw new Error('Forward native fee cap');}
  return Object.freeze({ chainId: PREVIEW_LANE.chainId, router: PREVIEW_LANE.router, selector: PREVIEW_LANE.solanaSelector,
    token: input.pair.evm.token, sender: input.pair.evm.sender, amount: input.amount,
    tokenReceiver: '0x' + solanaPublicKeyBytes(input.pair.svm.recipient).toString('hex'), fee,
    approve: admitted && admission.approval.required === true, send: admitted && quoteUsable });
}

function assertReverseCostRoute(r, f, check) {
  for (const [name, fact] of Object.entries({ ...f.fees, payerBalance: f.payerBalance })) {
    if (!fact) {continue;}
    check(fact.payer, r.payer, name + ' payer'); check(fact.snapshotSlot, f.snapshotSlot, name + ' snapshot');
  }
  if (f.fees.quote) {
    check(f.fees.quote.selector, r.selector, 'quoted selector'); check(f.fees.quote.mint, r.mint, 'quoted mint');
    check(f.fees.quote.amount, r.amount, 'quoted amount'); check(f.fees.quote.feeToken, '11111111111111111111111111111111', 'quoted fee token');
  }
  if (f.blockhash) {check(f.blockhash.snapshotSlot, f.snapshotSlot, 'raw blockhash snapshot');}
}

function assertReverseLimiterBindings(input, r, check) {
  for (const [direction, name] of [['inbound', 'svmInbound'], ['outbound', 'svmOutbound']]) {
    const supplied = r.limiters?.[direction];
    if (supplied) {
      for (const field of ['enabled', 'capacity', 'rate']) {check(supplied[field], input.limiters[name][field], direction + ' limiter ' + field);}
    }
  }
}

/** The independently selected native route must describe this consumer's pair. */
export function assertReversePreviewBindings(input, { route: r, facts: f }) {
  const s = input.pair.svm, e = input.pair.evm, state = input.states.reverse;
  const check = (actual, expected, name) => {
    if (!same(actual, expected)) {throw new Error('Reverse preview binding: ' + name);}
  };
  for (const name of ['profile', 'fixedSupplyBaseUnits', 'decimals', 'amount']) {check(r[name], input[name], name);}
  for (const [name, expected] of Object.entries({ selector: input.lane.ethereumSelector, solanaSelector: input.lane.solanaSelector,
    genesisHash: input.lane.genesisHash, routerProgram: input.lane.routerProgram, feeQuoterProgram: input.lane.feeQuoterProgram,
    poolProgram: input.lane.poolProgram, tokenProgram: input.lane.tokenProgram, rmn: input.lane.rmnProgram,
    mint: s.mint, evmToken: e.token, evmPool: e.pool, payer: s.payer, sender: s.sender,
    forwardRecipient: s.recipient, recipient: e.recipient, alt: s.alt.key, lookupTableAuthority: s.alt.authority })) {check(r[name], expected, name);}
  for (const [name, expected] of Object.entries({ pool: s.pool, signer: s.signer, ata: s.poolAta,
    sourceAta: s.sourceAta, registry: s.registry, spender: s.spender })) {check(r.identities[name], expected, name);}
  for (const [name, expected] of Object.entries({ poolOwner: s.poolOwner, pendingPoolOwner: s.pendingOwner,
    rateAdmin: s.rateAdmin, registryAdmin: s.registryAdmin, pendingRegistryAdmin: s.pendingAdmin })) {check(r.roles[name], expected, name);}
  check(s.alt.addresses, [r.alt, r.identities.registry, r.poolProgram, r.identities.pool, r.identities.ata,
    r.identities.signer, r.tokenProgram, r.mint, r.identities.feeTokenConfig, r.identities.routerPoolSigner], 'selected ALT inventory');
  if (state) {
    check(f.snapshotSlot, state.context.point, 'hypothetical snapshot slot');
    if (f.before) {
      for (const [name, expected] of Object.entries({ mintSupply: state.mint.supply, sourceBalance: state.source.balance,
        poolBalance: state.poolAccount.balance, delegate: state.source.delegate, delegatedAmount: state.source.delegatedAmount })) {check(f.before[name], expected, name);}
    }
  }
  assertReverseLimiterBindings(input, r, check);
  assertReverseCostRoute(r, f, check);
  const q = input.quotes.reverse;
  if (q) {
    check(f.maxExposureLamports, q.exposureLimit, 'explicit exposure limit');
    for (const [name, expected] of Object.entries({ quote: q.ccipFee, networkFee: q.networkFee, rent: q.rent, payerBalance: q.payerBalance })) {
      const fact = name === 'payerBalance' ? f.payerBalance : f.fees[name];
      if (fact && fact.lamports !== null && expected !== null) {check(fact.lamports, expected, name);}
    }
  }
  if (input.blockhash && f.blockhash) {
    if (f.blockhash.value !== null) {check(f.blockhash.value, input.blockhash.value, 'blockhash');}
    if (f.blockhash.lastValidBlockHeight !== null) {check(f.blockhash.lastValidBlockHeight, input.blockhash.lastValidBlockHeight, 'blockhash validity');}
    check(f.blockhash.snapshotSlot, input.blockhash.provenance.point, 'blockhash snapshot');
  }
}
