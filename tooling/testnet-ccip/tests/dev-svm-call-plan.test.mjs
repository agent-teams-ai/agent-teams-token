import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { admitDevSvmCallFacts, validateDevSvmRoute, verifyDevSvmInstructions, buildDevSvmCallPlan } from '../src/adapters/dev-svm-call-plan.mjs';
import { reverseInstructions } from '../src/domain/solana-reverse.mjs';
import { inspectSendData } from '../src/adapters/solana-spl-fee-cap-proof.mjs';
import { solanaPublicKeyBytes } from '../src/domain/solana-mint.ts';
const golden = JSON.parse(readFileSync(new URL('./fixtures/dev-svm-call-plan-goldens.json', import.meta.url)));
const fixture = () => structuredClone(golden);
function editRaw(facts, name, edit) {
  const raw = facts.state[name], data = Buffer.from(raw.dataBase64, 'base64'); edit(data);
  raw.dataBase64 = data.toString('base64'); raw.sha256 = createHash('sha256').update(data).digest('hex');
}
// These are provider-free admission/semantic tests, not stubbed native v0 tests.
const admit = (r, f) => admitDevSvmCallFacts(r, f, r.identities);
const e = route => ({ ...route.identities, alt: route.alt, payer: route.payer, mint: route.mint });
// Independent retained BaseChain IDL order: inbound at 73, outbound at 106.
const bucketOffsets = { inbound: 73, outbound: 106 };
function editBucket(route, facts, direction, values, select = false) {
  const offset = bucketOffsets[direction];
  editRaw(facts, 'chain', b => {
    for (const [field, delta] of [['tokens', 0], ['lastUpdated', 8], ['capacity', 17], ['rate', 25]]) {
      if (Object.hasOwn(values, field)) { b.writeBigUInt64LE(BigInt(values[field]), offset + delta); }
    }
    if (Object.hasOwn(values, 'enabled')) { b[offset + 16] = values.enabled; }
  });
  if (select && route.limiters) {
    route.limiters[direction] = { enabled: values.enabled === 1, capacity: String(values.capacity), rate: String(values.rate) };
  }
}
function noBytes(result) {
  assert.equal(result.status, 'prerequisites'); assert.equal(result.broadcastAllowed, false);
  for (const field of ['instructions', 'transactionBase64', 'messageBase64']) { assert.equal(Object.hasOwn(result, field), false); }
}
// Real fault SVM-FORMAT-001: live typed bytes were skipped, accepting invalid bools/configs and overfilled buckets.
for (const direction of Object.keys(bucketOffsets)) {
  for (const [label, values] of [['bool 2', { enabled: 2 }], ['bool 255', { enabled: 255 }],
    ['tokens above capacity', { tokens: 10000000001n }], ['rate above capacity', { rate: 10000000001n }],
    ['reviewer tokens 3 capacity 1 rate 2', { tokens: 3n, capacity: 1n, rate: 2n }],
    ['positive capacity with zero rate', { rate: 0n }], ['zero capacity with positive rate', { tokens: 0n, capacity: 0n }],
    ['disabled nonzero config', { enabled: 0 }]]) {
    test(direction + ' rejects ' + label + ' even after caller rehash', () => {
      const { route, facts } = fixture(); editBucket(route, facts, direction, values);
      assert.throws(() => admit(route, facts), /limiter/);
    });
  }
  // Real fault: disabled/unlimited, pause and insufficient captured tokens crossed the available-send boundary.
  for (const [label, values, reason] of [
    ['disabled unlimited', { enabled: 0, tokens: 0n, capacity: 0n, rate: 0n }, /disabled.*unlimited/],
    ['enabled pause', { enabled: 1, tokens: 0n, capacity: 0n, rate: 0n }, /paused/],
    ['zero tokens without refill context', { tokens: 0n, lastUpdated: 100n }, /insufficient captured/],
    ['amount minus one without refill context', { tokens: 999999999n, lastUpdated: 0n }, /insufficient captured/]]) {
    test(direction + ' leaves ' + label + ' as a prerequisite with no bytes', () => {
      const { route, facts } = fixture(); editBucket(route, facts, direction, values, Object.hasOwn(values, 'enabled'));
      const result = admit(route, facts); noBytes(result);
      assert.ok(result.reasons.some(r => r.includes(direction) && reason.test(r)));
    });
  }
}
// Real fault: no expected policy or ChainConfig capture still must not authorize available bytes.
test('unknown selected limiter policies and missing ChainConfig remain prerequisites', () => {
  for (const change of [r => { delete r.limiters; }, r => { r.limiters = null; }]) {
    const { route, facts } = fixture(); change(route); noBytes(admit(route, facts));
  }
  const { route, facts } = fixture(); facts.state.chain = null; noBytes(admit(route, facts));
});
// Real fault SVM-FORMAT-002: rehashing arbitrary allocation bytes broadened the retained selected format.
for (const [label, edit] of [['first ff', b => { b[139] = 255; }], ['all ff', b => b.fill(255, 139, 171)],
  ['near repair pattern', b => { Buffer.from('0200000000ca9a3b000000000000000000000000000000000000000000000000', 'hex').copy(b, 139); b[170] = 1; }]]) {
  test('unknown allocation tail ' + label + ' refuses even after caller rehash', () => {
    const { route, facts } = fixture(); editRaw(facts, 'chain', edit);
    assert.throws(() => admit(route, facts), /allocation tail/);
  });
}
test('zero and exact retained repair-pattern tails only establish format consistency', () => {
  for (const hex of ['00'.repeat(32), '0200000000ca9a3b000000000000000000000000000000000000000000000000']) {
    const { route, facts } = fixture(); editRaw(facts, 'chain', b => Buffer.from(hex, 'hex').copy(b, 139));
    assert.equal(admit(route, facts).status, 'admitted'); assert.equal(facts.evidenceClass, 'fixture-only');
  }
});
test('fixture admission retains positive pool balance and hypothetical full-delegation consumption', () => {
  const { route, facts } = fixture(), result = admit(route, facts);
  assert.equal(result.approval, true);
  assert.deepEqual(result.modelledAfter, { qualification: 'hypothetical-success-only', mintSupply: '19000000000',
    sourceBalance: '9000000000', poolBalance: '3000000000', delegate: null, delegatedAmount: '0' });
  assert.notEqual(route.payer, route.roles.poolOwner);
});
test('foreign zero, partial, excess, unknown and malformed delegation never overwrite authority', () => {
  for (const [delegate, amount, ok, approval] of [[null, '0', true, true], ['spender', '0', true, true],
    ['spender', '1000000000', true, false], ['foreign', '0', false], ['spender', '1', false],
    ['spender', '1000000001', false], [null, '1', false], ['spender', '00', false], [undefined, '0', false]]) {
    const { route, facts } = fixture();
    const address = delegate === 'spender' ? route.identities.spender : delegate === 'foreign' ? route.roles.poolOwner : delegate;
    facts.before.delegate = address; facts.before.delegatedAmount = amount;
    editRaw(facts, 'sourceAta', b => { b.writeUInt32LE(address === null || address === undefined ? 0 : 1, 72); if (address) { solanaPublicKeyBytes(address).copy(b, 76); }
      b.writeBigUInt64LE(BigInt(amount), 121); });
    if (ok) { assert.equal(admit(route, facts).approval, approval); } else { assert.throws(() => admit(route, facts)); }
  }
});
test('strict classic accounts reject frozen/native/close-authority and incoherent balances', () => {
  for (const mutate of [f => editRaw(f, 'sourceAta', b => { b[108] = 2; }),
    f => editRaw(f, 'poolAta', b => { b.writeUInt32LE(1, 109); }),
    f => editRaw(f, 'sourceAta', b => { b.writeUInt32LE(1, 129); }),
    f => editRaw(f, 'mint', b => { b.writeUInt32LE(1, 46); }),
    f => editRaw(f, 'mint', b => { b[4] ^= 1; }),
    f => { f.before.mintSupply = '10000000000'; editRaw(f, 'mint', b => b.writeBigUInt64LE(10000000000n, 36)); },
    f => { f.before.sourceBalance = '1'; editRaw(f, 'sourceAta', b => b.writeBigUInt64LE(1n, 64)); },
    f => editRaw(f, 'poolAta', b => b.writeUInt32LE(1, 72))]) {
    const { route, facts } = fixture(); mutate(facts); assert.throws(() => admit(route, facts));
  }
});
test('known cost lower bounds reject budget or balance violations despite an unknown component', () => {
  for (const change of [f => { f.maxExposureLamports = '4'; }, f => { f.payerBalance.lamports = '4'; }]) {
    const { route, facts } = fixture(); facts.fees.networkFee = null; change(facts);
    assert.throws(() => admit(route, facts), /known cost lower bound/);
  }
  const { route, facts } = fixture(); facts.fees.quote = null; facts.fees.networkFee.lamports = '1000001';
  assert.throws(() => admit(route, facts), /known cost lower bound/);
});
test('missing or expired captured fees/balance/blockhash yield prerequisites with no bytes', () => {
  for (const change of [f => { f.fees.quote = null; }, f => { f.payerBalance = null; }, f => { f.blockhash = null; },
    f => { f.fees.rent = null; }, f => { f.fees.rent.lamports = null; }, f => { f.payerBalance.lamports = null; }, f => { f.fees.quote.validThroughSlot = '100'; },
    f => { f.blockhash.lastValidBlockHeight = '98'; }, f => { f.state = null; }, f => { f.before = null; }, f => { f.observedSlot = '121'; }]) {
    const { route, facts } = fixture(); change(facts); const result = admit(route, facts);
    assert.equal(result.status, 'prerequisites'); assert.ok(result.reasons.length); assert.equal(result.broadcastAllowed, false);
    for (const field of ['instructions', 'transactionBase64', 'messageBase64']) { assert.equal(Object.hasOwn(result, field), false); }
  }
});
test('route rejects mainnet, rounded amounts, over-supply and administrative signers before primitive calls', () => {
  for (const change of [r => { r.selector = '5009297550715157269'; }, r => { r.selector = Number('16015286601757825753'); },
    r => { r.amount = 1000000000; }, r => { r.amount = '01'; }, r => { r.amount = '100000000001'; },
    r => { r.roles.poolOwner = r.payer; }, r => { r.forwardRecipient = r.roles.poolOwner; },
    r => { r.recipient = '0x' + '0'.repeat(40); }, r => { r.decimals = 8; }, r => { r.fixedSupplyBaseUnits = '100'; },
    r => { r.rpcUrl = 'forbidden'; }]) {
    const { route, facts } = fixture(); change(route);
    assert.throws(() => buildDevSvmCallPlan({ derivePda() { assert.fail('invalid route evaluated primitives'); } }, route, facts));
  }
});
test('registry, raw20 peers, captured owners and ALT activation/authority/order are enforced', () => {
  for (const change of [f => editRaw(f, 'registry', b => { b[120] ^= 1; }),
    f => editRaw(f, 'registry', b => { b[169] = 2; }), f => editRaw(f, 'chain', b => { b[16] ^= 1; }),
    f => { f.state.pool.owner = f.state.mint.owner; }, f => { f.state.sourceAta.slot = '99'; },
    f => editRaw(f, 'alt', b => b.writeBigUInt64LE(100n, 12)), f => editRaw(f, 'alt', b => b.writeBigUInt64LE(0n, 4)),
    f => editRaw(f, 'alt', b => { b[22] ^= 1; }), f => editRaw(f, 'alt', b => { b[56] ^= 1; })]) {
    const { route, facts } = fixture(); change(facts); assert.throws(() => admit(route, facts));
  }
  const { route, facts } = fixture(); route.lookupTableAuthority = null;
  editRaw(facts, 'alt', b => { b.fill(0, 21, 56); }); assert.equal(admit(route, facts).status, 'admitted');
});
test('retained public wire is semantically checked for all native fields, beyond golden equality', () => {
  const { route, facts } = fixture(), admission = admit(route, facts);
  const instructions = reverseInstructions({ ...e(route), testOnly: true, cluster: route.cluster, approval: true,
    quotedFee: '5', sourceLamports: '1000000' }, route);
  assert.equal(Buffer.from(instructions.at(-1).dataBase64, 'base64').toString('hex'), golden.oracle.historicalSendHex);
  verifyDevSvmInstructions(route, e(route), admission.approval, instructions);
  for (const field of ['quotedFee', 'sourceLamports']) {
    const input = { ...e(route), testOnly: true, cluster: route.cluster, approval: true, quotedFee: '5', sourceLamports: '1000000' };
    input[field] = 5; assert.throws(() => reverseInstructions(input, route));
  }
  for (const offset of [0, 8, 20, 51, 52, 56, 60, 92, 100, 132, 136, 156, 161]) {
    const changed = structuredClone(instructions), data = Buffer.from(changed.at(-1).dataBase64, 'base64'); data[offset] ^= 1;
    changed.at(-1).dataBase64 = data.toString('base64');
    assert.throws(() => verifyDevSvmInstructions(route, e(route), true, changed));
  }
  for (const change of [ix => { ix[1].accounts[4].isWritable = true; }, ix => { ix[1].accounts[30].isSigner = true; },
    ix => { ix.reverse(); }, ix => { ix.push(ix[0]); }]) {
    const changed = structuredClone(instructions); change(changed); assert.throws(() => verifyDevSvmInstructions(route, e(route), true, changed));
  }
});
test('reader default remains mainnet SPL, while explicit native selector/recipient is strict', () => {
  const { route } = fixture(), wire = Buffer.from(golden.oracle.historicalSendHex, 'hex');
  assert.throws(() => inspectSendData(null, wire, route.mint, '11111111111111111111111111111111', 1000000000n), /destination/);
  const result = inspectSendData(null, wire, route.mint, '11111111111111111111111111111111', { amount: 1000000000n, selector: route.selector, nativeExpected: { receiver: wire.subarray(20, 52) } });
  assert.equal(result.selector, 16015286601757825753n); assert.equal(result.data.length, 0); assert.equal(result.extraArgs.length, 21);
  validateDevSvmRoute(route);
});

// Real fault: skipped config checks had no independent expected policy binding; unknowns became available sends.
for (const direction of Object.keys(bucketOffsets)) {
  test(direction + ' selected policy unknown retains known raw observations', () => {
    const { route, facts } = fixture(); route.limiters[direction] = null;
    const result = admit(route, facts); noBytes(result);
    assert.ok(result.reasons.includes(direction + ' limiter selected policy unknown'));
    assert.equal(result.limiterObservations[direction].tokens, direction === 'inbound' ? '2000000000' : '3000000000');
  });
  test(direction + ' captured config cannot replace independently selected capacity or rate', () => {
    for (const field of ['capacity', 'rate']) {
      const { route, facts } = fixture(); route.limiters[direction][field] = '2000000000';
      const result = admit(route, facts); noBytes(result);
      assert.ok(result.reasons.includes(direction + ' limiter captured config differs from selected policy'));
      assert.equal(route.limiters[direction][field], '2000000000');
    }
  });
}
// Real fault: availability had no checked lower bound, and lastUpdated carried time rather than slot authority.
test('exact captured availability suffices without refill or any inferred slot/time relation', () => {
  for (const lastUpdated of [0n, 1700000000n, 9007199254740993n]) {
    const { route, facts } = fixture();
    for (const direction of Object.keys(bucketOffsets)) { editBucket(route, facts, direction, { tokens: 1000000000n, lastUpdated }); }
    const result = admit(route, facts); assert.equal(result.status, 'admitted');
    for (const observation of Object.values(result.limiterObservations)) {
      assert.equal(observation.tokens, route.amount); assert.equal(observation.lastUpdatedUnixSeconds, lastUpdated.toString());
      assert.equal(Object.hasOwn(observation, 'lastUpdatedSlot'), false);
    }
  }
});
// Real fault: early unknown-cost return could hide the same known invalid ChainConfig state.
test('unknown costs cannot mask malformed live fields or unknown allocation tails', () => {
  for (const mutate of [b => { b[89] = 2; }, b => { b[122] = 2; }, b => { b[139] = 255; }]) {
    const { route, facts } = fixture(); facts.fees.quote = null; editRaw(facts, 'chain', mutate);
    assert.throws(() => admit(route, facts), /limiter|allocation tail/);
  }
});
// Real fault: the original hypothetical golden had both buckets disabled/unlimited and was admitted.
test('historical hypothetical disabled buckets never gain bounded active availability', () => {
  const { route, facts } = fixture(); editRaw(facts, 'chain', b => b.fill(0, 73, 139));
  const result = admit(route, facts); noBytes(result);
  assert.equal(result.reasons.filter(r => /disabled.*unlimited/.test(r)).length, 2);
  assert.equal(result.limiterObservations.inbound.tokens, '0'); assert.equal(result.limiterObservations.outbound.enabled, false);
});
test('selected policies retain strict boolean/u64 and bounded configuration rules', () => {
  for (const value of [{ enabled: 2, capacity: '1', rate: '1' }, { enabled: true, capacity: '01', rate: '1' },
    { enabled: true, capacity: 1, rate: '1' }, { enabled: true, capacity: '18446744073709551616', rate: '1' },
    { enabled: true, capacity: '1', rate: '2' }, { enabled: false, capacity: '1', rate: '0' },
    { enabled: true, capacity: '1', rate: '0' }, undefined]) {
    const { route } = fixture(); route.limiters.inbound = value; assert.throws(() => validateDevSvmRoute(route), /limiter/);
  }
});
test('hypothetical raw limiter declarations match fixture bytes and remain separate from external wire authority', () => {
  const { route, facts, hypotheticalChainConfig } = fixture(), result = admit(route, facts);
  assert.deepEqual(result.limiterObservations, hypotheticalChainConfig.buckets);
  assert.equal(hypotheticalChainConfig.allocationTailHex, '00'.repeat(32));
  assert.equal(createHash('sha256').update(Buffer.from(facts.state.chain.dataBase64, 'base64')).digest('hex'), facts.state.chain.sha256);
  assert.match(hypotheticalChainConfig.qualification, /hypothetical/);
  assert.equal(facts.snapshotSlot, '100'); assert.equal(result.limiterObservations.inbound.lastUpdatedUnixSeconds, '1700000000');
});

// SVM-FINAL-001: two rehashed differently owned captures claimed the same registry/ALT key and slot.
test('SVM-FINAL-001 coherent registry/ALT alias rejects before admission', () => {
  const { route, facts } = fixture(); route.alt = route.identities.registry; facts.state.alt.address = route.alt;
  editRaw(facts, 'registry', b => solanaPublicKeyBytes(route.alt).copy(b, 73));
  editRaw(facts, 'alt', b => solanaPublicKeyBytes(route.alt).copy(b, 56));
  assert.equal(facts.state.alt.slot, facts.state.registry.slot);
  assert.notEqual(facts.state.alt.owner, facts.state.registry.owner);
  assert.throws(() => admit(route, facts), /conflicting captured account identities/);
});
// The finite captured account types must be disjoint; authority aliases and repeated program metas are compatible.
test('SVM-FINAL-001 ALT is disjoint from all selected differently typed captures', () => {
  const { route } = fixture();
  for (const address of [route.mint, ...['sourceAta', 'ata', 'routerConfig', 'registry', 'pool', 'chain'].map(k => route.identities[k])]) {
    assert.throws(() => validateDevSvmRoute({ ...route, alt: address }), /conflicting captured account identities/);
  }
});
test('compatible selected role and payer/ALT-authority aliases remain admitted', () => {
  const { route, facts } = fixture(); route.lookupTableAuthority = route.payer; route.roles.rateAdmin = route.roles.poolOwner;
  editRaw(facts, 'alt', b => solanaPublicKeyBytes(route.payer).copy(b, 22));
  editRaw(facts, 'pool', b => solanaPublicKeyBytes(route.roles.rateAdmin).copy(b, 202));
  assert.equal(admit(route, facts).status, 'admitted');
});
// SVM-FINAL-002: missing quote concealed these already supplied invalid SPL facts and ALT metadata.
const suppliedFailures = [
  ['frozen source', f => editRaw(f, 'sourceAta', b => { b[108] = 2; }), /initialized unfrozen/],
  ['mint freeze option', f => editRaw(f, 'mint', b => b.writeUInt32LE(1, 46)), /mint authority.*freeze layout/],
  ['supply above F', f => { f.before.mintSupply = '100000000001'; editRaw(f, 'mint', b => b.writeBigUInt64LE(100000000001n, 36)); }, /overissuance.*100000000001/],
  ['inactive ALT', f => editRaw(f, 'alt', b => b.writeBigUInt64LE(100n, 12)), /ALT active metadata/]];
for (const [label, mutate, reason] of suppliedFailures) {
  for (const missingQuote of [false, true]) {
    test('SVM-FINAL-002 ' + label + ' with ' + (missingQuote ? 'unknown' : 'known') + ' quote rejects', () => {
      const { route, facts } = fixture(); mutate(facts); if (missingQuote) { facts.fees.quote = null; }
      assert.throws(() => admit(route, facts), reason);
    });
  }
}
// Unavailable typed before-state cannot make an already observed raw layout valid.
test('SVM-FINAL-002 missing before-state cannot hide known raw SPL or ALT defects', () => {
  for (const [, mutate, reason] of suppliedFailures) {
    for (const missingQuote of [false, true]) {
      const { route, facts } = fixture(); mutate(facts); facts.before = null; if (missingQuote) { facts.fees.quote = null; }
      assert.throws(() => admit(route, facts), reason); assert.equal(facts.before, null);
    }
  }
});
// Absence remains absence: no invented before numbers or quote, no hypothetical-after or wire fields.
test('unavailable before-state and quote retain null inputs and no bytes', () => {
  for (const missingState of [false, true]) {
    const { route, facts } = fixture(); facts.before = null; facts.fees.quote = null; if (missingState) { facts.state = null; }
    const result = admit(route, facts); noBytes(result);
    assert.ok(result.reasons.includes('quote missing')); assert.ok(result.reasons.includes('common captured before-state missing'));
    assert.equal(result.knownCostLowerBoundLamports, '5000'); assert.equal(Object.hasOwn(result, 'modelledAfter'), false);
    assert.equal(facts.before, null); assert.equal(facts.fees.quote, null);
    if (missingState) { assert.equal(result.limiterObservations, null); }
  }
});
