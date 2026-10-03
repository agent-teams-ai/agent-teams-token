// Explicit opt-in native suite. Missing authority inputs FAIL; no skips or live fallback.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDevProvider } from '../src/adapters/dev-provider-admission.mjs';
import { buildDevSvmCallPlan, verifyDevSvmCallPlan } from '../src/adapters/dev-svm-call-plan.mjs';
import { deriveReverseAccounts, REVERSE } from '../src/domain/solana-reverse.mjs';
import { solanaPublicKeyBytes } from '../src/domain/solana-mint.ts';
const [root, archives, capture, ...extra] = process.argv.slice(2);
if (!root || !archives || !capture || extra.length) { throw new Error('Require explicit public provider root, authority archives directory and retained message2-burn-json capture'); }
globalThis.fetch = () => { throw new Error('Network forbidden in unsigned native suite'); };
const golden = JSON.parse(await readFile(new URL('./fixtures/dev-svm-call-plan-goldens.json', import.meta.url)));
const { primitives: p, evidence } = await loadDevProvider({ root: resolve(root), archives: resolve(archives) });
const fixture = () => structuredClone(golden);
const hash = b => createHash('sha256').update(b).digest('hex');
function rawEdit(f, name, edit) {
  const a = f.state[name], b = Buffer.from(a.dataBase64, 'base64'); edit(b);
  a.dataBase64 = b.toString('base64'); a.sha256 = hash(b);
}
const nativeInstructions = instructions => instructions.map(ix => ({ programId: ix.programId,
  keys: ix.accounts.map(a => ({ pubkey: a.address, isSigner: a.isSigner, isWritable: a.isWritable })),
  data: '0x' + Buffer.from(ix.dataBase64, 'base64').toString('hex') }));
const lookup = (r, f) => ({ key: r.alt, dataBase64: f.state.alt.dataBase64 });
const recompile = (r, f, candidate, mutate) => {
  const instructions = nativeInstructions(candidate.instructions); mutate(instructions);
  return { ...candidate, ...p.compileUnsignedV0({ payer: r.payer, recentBlockhash: f.blockhash.value,
    lookupTable: lookup(r, f), instructions }) };
};
const sourceBytes = await readFile(resolve(capture));
assert.equal(hash(sourceBytes), golden.source.sha256, 'Explicit external wire source must retain its independent selected digest');
const source = JSON.parse(sourceBytes).result;
const idlPath = join(resolve(root), golden.oracle.routerIdlPath);
assert.equal(hash(await readFile(idlPath)), golden.oracle.routerIdlSha256);
assert.equal(evidence.sources[golden.oracle.routerIdlPath], golden.oracle.routerIdlSha256);
// Pure, authenticated IDL DATA module; never SDK entry, Anchor or a client.
const { IDL } = await import(pathToFileURL(idlPath).href);

test('native derivation reproduces externally retained PDA/ATA identities from public packet', () => {
  const { route } = fixture(), derived = deriveReverseAccounts(p, { alt: route.alt }, route.linkMint, route);
  for (const [name, address] of Object.entries(route.identities)) { assert.equal(derived[name], address, name); }
  const keys = [...source.transaction.message.accountKeys, ...source.meta.loadedAddresses.writable, ...source.meta.loadedAddresses.readonly];
  const accounts = source.transaction.message.instructions[1].accounts.map(i => keys[i]);
  for (const [i, name] of [[0,'routerConfig'],[1,'destChain'],[2,'nonce'],[8,'feeReceiver'],[9,'spender'],[11,'feeConfig'],
    [12,'feeDest'],[13,'nativeFeeConfig'],[16,'curses'],[17,'rmnConfig'],[18,'sourceAta'],[19,'perTokenConfig'],[20,'chain'],
    [22,'registry'],[24,'pool'],[25,'ata'],[26,'signer'],[29,'feeTokenConfig'],[30,'routerPoolSigner']]) {
    assert.equal(derived[name], accounts[i], name + ' external capture');
  }
  assert.deepEqual(golden.oracle.externalAltAddresses.slice(0, 8), [route.alt, derived.registry, route.poolProgram,
    derived.pool, derived.ata, derived.signer, route.tokenProgram, route.mint]);
});
test('actual native v0 has one registered ALT, sole zero-signature payer, correct duplicate global permissions', () => {
  const { route, facts } = fixture(), result = buildDevSvmCallPlan(p, route, facts);
  assert.equal(result.status, 'built'); assert.equal(result.broadcastAllowed, false);
  assert.ok(Buffer.from(result.transactionBase64, 'base64').length <= 1232);
  assert.equal(Buffer.from(result.instructions.at(-1).dataBase64, 'base64').toString('hex'), golden.oracle.historicalSendHex);
  const decoded = p.inspectUnsignedV0({ transactionBase64: result.transactionBase64, lookupTable: lookup(route, facts) });
  assert.deepEqual(decoded.signaturesBase64, [Buffer.alloc(64).toString('base64')]);
  assert.deepEqual(decoded.accounts.filter(k => k.isSigner).map(k => k.pubkey), [route.payer]);
  assert.equal(result.instructions[1].accounts[4].isWritable, false);
  assert.equal(decoded.instructions[1].keys[4].isWritable, true); // System Program also occurs at writable slot 7.
  assert.equal(decoded.instructions[0].keys[2].isWritable, true); // send promotes approve owner to payer globally.
  assert.equal(decoded.instructions[1].keys[7].isWritable, true);
  assert.equal(decoded.lookups.length, 1); assert.deepEqual(decoded.lookups[0].writableIndexes, [3,4,7]);
  assert.deepEqual(result.instructions[1].accounts.slice(0, 18).map(a => [a.isWritable,a.isSigner]),
    IDL.instructions.find(i => i.name === 'ccipSend').accounts.map(a => [a.isMut,a.isSigner]));
  assert.equal(verifyDevSvmCallPlan(p, route, facts, result), result);
});
test('changed recipient and amount above 2^53 preserve the final base unit against independent retained wire projection', () => {
  const { route, facts } = fixture();
  route.profile = 'product100M'; route.fixedSupplyBaseUnits = '100000000000000000';
  route.amount = golden.oracle.changedAmount; route.recipient = golden.oracle.changedRecipient;
  facts.fees.quote.amount = route.amount; facts.before.mintSupply = route.fixedSupplyBaseUnits; facts.before.sourceBalance = '90000000000000000';
  rawEdit(facts, 'mint', b => b.writeBigUInt64LE(100000000000000000n, 36));
  rawEdit(facts, 'sourceAta', b => b.writeBigUInt64LE(90000000000000000n, 64));
  // Explicit hypothetical larger bounded policies/availability for this codec vector, not Mainnet defaults.
  for (const [direction, offset] of [['inbound', 73], ['outbound', 106]]) {
    rawEdit(facts, 'chain', b => { b.writeBigUInt64LE(100000000000000000n, offset); b.writeBigUInt64LE(100000000000000000n, offset + 17); });
    if (route.limiters) { route.limiters[direction].capacity = '100000000000000000'; }
  }
  const result = buildDevSvmCallPlan(p, route, facts);
  assert.equal(Buffer.from(result.instructions.at(-1).dataBase64, 'base64').toString('hex'), golden.oracle.changedSendHex);
  assert.equal(result.modelledAfter.sourceBalance, '80992800745259007');
  assert.equal(result.modelledAfter.mintSupply, '90992800745259007');
  verifyDevSvmCallPlan(p, route, facts, result);
  // Keep golden equality out of runtime verification: different expected intent must reject unchanged bytes.
  const wrongAmount = { ...route, amount: '9007199254740992' }, wrongFacts = structuredClone(facts);
  wrongFacts.fees.quote.amount = wrongAmount.amount;
  assert.throws(() => verifyDevSvmCallPlan(p, wrongAmount, wrongFacts, result));
  assert.throws(() => verifyDevSvmCallPlan(p, { ...route, recipient: REVERSE.recipient }, facts, result));
});
test('nullable and non-payer ALT authorities compile without being promoted to signer or transfer authority', () => {
  for (const none of [false, true]) {
    const { route, facts } = fixture();
    assert.notEqual(route.lookupTableAuthority, route.payer);
    if (none) { route.lookupTableAuthority = null; rawEdit(facts, 'alt', b => b.fill(0, 21, 56)); }
    const state = p.deserializeLookupTable(facts.state.alt.dataBase64);
    assert.equal(state.authority, route.lookupTableAuthority); assert.deepEqual(state.addresses, golden.oracle.externalAltAddresses);
    verifyDevSvmCallPlan(p, route, facts, buildDevSvmCallPlan(p, route, facts));
  }
});
test('exact delegation omits approve; zero allowance uses one exact approve; consumed delegation models None', () => {
  for (const amount of ['0', '1000000000']) {
    const { route, facts } = fixture(); facts.before.delegate = route.identities.spender; facts.before.delegatedAmount = amount;
    rawEdit(facts, 'sourceAta', b => { b.writeUInt32LE(1, 72); solanaPublicKeyBytes(route.identities.spender).copy(b, 76); b.writeBigUInt64LE(BigInt(amount), 121); });
    const result = buildDevSvmCallPlan(p, route, facts);
    assert.equal(result.instructions.length, amount === '0' ? 2 : 1);
    assert.equal(result.modelledAfter.delegate, null); assert.equal(result.modelledAfter.delegatedAmount, '0');
    verifyDevSvmCallPlan(p, route, facts, result);
  }
});
test('wrong derivation/delegate/registry bitmap/ALT address/activation reject before any retained send bytes', () => {
  for (const mutate of [(r) => { r.identities.nonce = r.roles.poolOwner; },
    (r,f) => { f.before.delegate = r.roles.poolOwner; rawEdit(f,'sourceAta',b=>{b.writeUInt32LE(1,72);solanaPublicKeyBytes(r.roles.poolOwner).copy(b,76);}); },
    (_r,f) => rawEdit(f,'registry',b=>{b[120]^=1;}), (_r,f)=>rawEdit(f,'alt',b=>{b[56]^=1;}),
    (_r,f)=>rawEdit(f,'alt',b=>b.writeBigUInt64LE(100n,12)), (_r,f)=>rawEdit(f,'alt',b=>{b[21]=0;})]) {
    const { route, facts } = fixture(); mutate(route, facts); assert.throws(() => buildDevSvmCallPlan(p, route, facts));
  }
});
test('compiled account privilege, hidden instruction and instruction order mutants are independently rejected', () => {
  const { route, facts } = fixture(), result = buildDevSvmCallPlan(p, route, facts);
  for (const mutate of [ix => { ix[1].keys[11].isWritable = true; }, ix => { ix[1].keys[28].isSigner = true; },
    ix => { ix[1].keys[24].isWritable = false; }, ix => { ix.push(ix[0]); }, ix => { ix.reverse(); },
    ix => { ix[1].keys.push({ pubkey: route.roles.poolOwner, isWritable: false, isSigner: false }); }]) {
    const changed = recompile(route, facts, result, mutate);
    assert.throws(() => verifyDevSvmCallPlan(p, route, facts, changed));
  }
});
test('wire payload mutations in a real packet fail semantic binding even with coherent metadata', () => {
  const { route, facts } = fixture(), result = buildDevSvmCallPlan(p, route, facts);
  for (const offset of [51, 92, 100, 136, 156, 161]) {
    const changed = recompile(route, facts, result, ix => {
      const data = Buffer.from(ix[1].data.slice(2), 'hex'); data[offset] ^= 1; ix[1].data = '0x' + data.toString('hex');
    });
    const wire = Buffer.from(changed.transactionBase64, 'base64'); assert.ok(wire.length <= 1232);
    assert.throws(() => verifyDevSvmCallPlan(p, route, facts, changed));
  }
});
test('signature/header/lookup-index/packet-size mutants cannot acquire unsigned DEV qualification', () => {
  const { route, facts } = fixture(), result = buildDevSvmCallPlan(p, route, facts);
  for (const mutate of [b => { b[1] = 1; }, b => { b[66] = 2; }, b => { b[b.length-1] = 10; }]) {
    const b = Buffer.from(result.transactionBase64, 'base64'); mutate(b);
    assert.throws(() => verifyDevSvmCallPlan(p, route, facts, { ...result, transactionBase64: b.toString('base64') }));
  }
  assert.throws(() => verifyDevSvmCallPlan(p, route, facts, { ...result, transactionBase64: Buffer.alloc(1233).toString('base64') }));
});
test('native quote/cost route bounds reject and unknown or expired facts retain no send bytes', () => {
  for (const mutate of [f => { f.fees.quote.lamports='100000001'; }, f=>{f.fees.quote.amount='1';},
    f=>{f.maxExposureLamports='4';f.fees.rent=null;}, f=>{f.payerBalance.lamports='4';f.fees.networkFee=null;},
    f=>{f.maxExposureLamports='10000000001';}, f=>{f.fees.quote.lamports=5;}]) {
    const { route, facts } = fixture(); mutate(facts); assert.throws(() => buildDevSvmCallPlan(p, route, facts));
  }
  for (const mutate of [f=>{f.fees.quote=null;},f=>{f.fees.networkFee=null;},f=>{f.payerBalance=null;},f=>{f.blockhash=null;},
    f=>{f.blockhash.lastValidBlockHeight='1';}]) {
    const { route, facts } = fixture(); mutate(facts); const result=buildDevSvmCallPlan(p,route,facts);
    assert.equal(result.status,'prerequisites'); assert.equal(Object.hasOwn(result,'transactionBase64'),false);
    assert.equal(Object.hasOwn(result,'instructions'),false);
  }
});
test('large captured payer balance is not mistaken for the explicit task exposure limit; bigint selectors work', () => {
  const { route, facts } = fixture(); route.selector = 16015286601757825753n; route.solanaSelector = 16423721717087811551n;
  facts.fees.quote.selector = route.selector; facts.payerBalance.lamports = '10000000001';
  const result = buildDevSvmCallPlan(p, route, facts);
  assert.equal(result.knownCostLowerBoundLamports, '5005');
  verifyDevSvmCallPlan(p, route, facts, result);
});
test('existing three-field unsigned compiler output stays byte-identical to its independent public vector', async () => {
  const vectors=JSON.parse(await readFile(new URL('./fixtures/dev-provider-vectors.json',import.meta.url)));
  const result=p.compileUnsignedV0(vectors.svm.input);
  assert.equal(result.messageBase64,vectors.svm.messageBase64);
  assert.equal(result.transactionBase64,vectors.svm.transactionBase64);
  assert.equal(result.broadcastAllowed,false);
});
// BorshInstructionCoder remains UNQUALIFIED: Anchor is outside selected executable
// closure. Follow-up owner must admit its exact safe closure before running the
// official compatibility oracle. Retained external wire + IDL data are this slice's oracle.

// Real faults SVM-FORMAT-001/002: skipped limiter/tail admission let the actual native builder compile send packets.
// These wrappers count calls to the real admitted compiler; they never supply a codec/serialization stub.
function countedBuilder() {
  let calls = 0, constructions = 0;
  const sendDiscriminator = Buffer.from(golden.oracle.historicalSendHex.slice(0, 16), 'hex');
  return { build(r, f) {
    // Observe actual send/Approve byte construction; delegate every concat and compiler call unchanged.
    const concat = Buffer.concat;
    Buffer.concat = (parts, ...args) => {
      if (Buffer.isBuffer(parts[0]) && (parts[0].equals(sendDiscriminator) ||
          parts.length === 2 && parts[0].length === 1 && parts[0][0] === 4 && parts[1].length === 8)) { constructions++; }
      return concat(parts, ...args);
    };
    try { return buildDevSvmCallPlan({ ...p, compileUnsignedV0(input) { calls++; return p.compileUnsignedV0(input); } }, r, f); }
    finally { Buffer.concat = concat; }
  }, calls: () => calls, constructions: () => constructions };
}
const bucketOffsets = { inbound: 73, outbound: 106 };
function bucketEdit(r, f, direction, values, select = false) {
  const offset = bucketOffsets[direction];
  rawEdit(f, 'chain', b => {
    for (const [field, delta] of [['tokens', 0], ['lastUpdated', 8], ['capacity', 17], ['rate', 25]]) {
      if (Object.hasOwn(values, field)) { b.writeBigUInt64LE(BigInt(values[field]), offset + delta); }
    }
    if (Object.hasOwn(values, 'enabled')) { b[offset + 16] = values.enabled; }
  });
  if (select && r.limiters) { r.limiters[direction] = { enabled: values.enabled === 1, capacity: String(values.capacity), rate: String(values.rate) }; }
}
for (const direction of Object.keys(bucketOffsets)) {
  // Real fault: malformed bools, impossible config and tokens above capacity were admitted through compilation.
  for (const [label, values] of [['bool 2', { enabled: 2 }], ['bool 255', { enabled: 255 }],
    ['tokens above capacity', { tokens: 10000000001n }], ['rate above capacity', { rate: 10000000001n }],
    ['reviewer tokens 3 capacity 1 rate 2', { tokens: 3n, capacity: 1n, rate: 2n }],
    ['positive capacity zero rate', { rate: 0n }], ['zero capacity positive rate', { tokens: 0n, capacity: 0n }],
    ['disabled nonzero config', { enabled: 0 }]]) {
    test('native ' + direction + ' rejects ' + label + ' before compilation', () => {
      const { route, facts } = fixture(); bucketEdit(route, facts, direction, values); const counter = countedBuilder();
      assert.throws(() => counter.build(route, facts), /limiter/); assert.equal(counter.calls(), 0);
    });
  }
  // Real fault: unlimited, paused and insufficient known tokens all produced send/v0 bytes.
  for (const [label, values, reason] of [
    ['disabled unlimited', { enabled: 0, tokens: 0n, capacity: 0n, rate: 0n }, /disabled.*unlimited/],
    ['paused', { enabled: 1, tokens: 0n, capacity: 0n, rate: 0n }, /paused/],
    ['zero tokens', { tokens: 0n, lastUpdated: 100n }, /insufficient captured/],
    ['amount minus one', { tokens: 999999999n, lastUpdated: 0n }, /insufficient captured/]]) {
    test('native ' + direction + ' with ' + label + ' returns no send or v0 bytes', () => {
      const { route, facts } = fixture(), previous = buildDevSvmCallPlan(p, route, facts);
      bucketEdit(route, facts, direction, values, Object.hasOwn(values, 'enabled')); const counter = countedBuilder();
      const result = counter.build(route, facts); assert.equal(result.status, 'prerequisites'); assert.equal(counter.calls(), 0);
      assert.ok(result.reasons.some(r => r.includes(direction) && reason.test(r)));
      for (const field of ['instructions', 'messageBase64', 'transactionBase64']) { assert.equal(Object.hasOwn(result, field), false); }
      assert.throws(() => verifyDevSvmCallPlan(p, route, facts, previous), /unresolved prerequisites/);
    });
  }
}
// Real fault: missing independent policy never justified successful local compilation.
test('native absent selected policy and missing ChainConfig are prerequisites without compilation', () => {
  for (const mutate of [(r) => { delete r.limiters; }, (_r, f) => { f.state.chain = null; }]) {
    const { route, facts } = fixture(); mutate(route, facts); const counter = countedBuilder(), result = counter.build(route, facts);
    assert.equal(result.status, 'prerequisites'); assert.equal(counter.calls(), 0);
    for (const field of ['instructions', 'messageBase64', 'transactionBase64']) { assert.equal(Object.hasOwn(result, field), false); }
  }
});
// Real fault: arbitrary inert tail bytes acquired the selected format's native build qualification after rehash.
for (const [label, edit] of [['first ff', b => { b[139] = 255; }], ['all ff', b => b.fill(255, 139, 171)],
  ['near repair pattern', b => { Buffer.from('0200000000ca9a3b000000000000000000000000000000000000000000000000', 'hex').copy(b, 139); b[170] = 1; }]]) {
  test('native unknown allocation tail ' + label + ' refuses before compilation', () => {
    const { route, facts } = fixture(); rawEdit(facts, 'chain', edit); const counter = countedBuilder();
    assert.throws(() => counter.build(route, facts), /allocation tail/); assert.equal(counter.calls(), 0);
  });
}
test('native exact retained repair-pattern tail matches zero-tail packet with no chain-history assertion', () => {
  const { route, facts } = fixture(), zero = buildDevSvmCallPlan(p, route, facts);
  rawEdit(facts, 'chain', b => Buffer.from('0200000000ca9a3b000000000000000000000000000000000000000000000000', 'hex').copy(b, 139));
  const retained = buildDevSvmCallPlan(p, route, facts);
  assert.equal(retained.transactionBase64, zero.transactionBase64); assert.equal(retained.evidenceClass, 'fixture-only');
  assert.equal(retained.qualification, 'DEV-unsigned-captured-consistency-only');
  verifyDevSvmCallPlan(p, route, facts, retained);
});

// Real fault: missing/config-conflicting expected policies were not part of admission before native compilation.
for (const direction of Object.keys(bucketOffsets)) {
  for (const [label, edit] of [['unknown policy', r => { r.limiters[direction] = null; }],
    ['policy mismatch', r => { r.limiters[direction].capacity = '2000000000'; }]]) {
    test('native ' + direction + ' ' + label + ' preserves prerequisites with zero compiler calls', () => {
      const { route, facts } = fixture(); edit(route); const counter = countedBuilder(), result = counter.build(route, facts);
      assert.equal(result.status, 'prerequisites'); assert.equal(counter.calls(), 0);
      for (const field of ['instructions', 'transactionBase64', 'messageBase64']) { assert.equal(Object.hasOwn(result, field), false); }
    });
  }
}
// Real fault: lower-bound availability was omitted, while captured u64 lastUpdated has no supplied refill-time context.
test('native exact captured tokens with Unix seconds far above snapshot slot retain unchanged wire and packet', () => {
  const { route, facts } = fixture(), original = buildDevSvmCallPlan(p, route, facts);
  for (const direction of Object.keys(bucketOffsets)) { bucketEdit(route, facts, direction, { tokens: 1000000000n, lastUpdated: 1700000000n }); }
  const result = buildDevSvmCallPlan(p, route, facts);
  assert.equal(result.status, 'built'); assert.equal(result.transactionBase64, original.transactionBase64);
  verifyDevSvmCallPlan(p, route, facts, result);
});
// Real fault: unknown costs must not hide known invalid ChainConfig bytes.
test('native unknown quote cannot mask known malformed limiters or unsupported tail', () => {
  for (const edit of [b => { b[89] = 2; }, b => { b[122] = 2; }, b => { b[139] = 255; }]) {
    const { route, facts } = fixture(); facts.fees.quote = null; rawEdit(facts, 'chain', edit); const counter = countedBuilder();
    assert.throws(() => counter.build(route, facts), /limiter|allocation tail/); assert.equal(counter.calls(), 0);
  }
});
// Real fault: original both-disabled hypothetical fixture passed through actual native send compilation.
test('native original disabled hypothetical bucket bytes retain two explicit unavailable reasons', () => {
  const { route, facts } = fixture(); rawEdit(facts, 'chain', b => b.fill(0, 73, 139)); const counter = countedBuilder(), result = counter.build(route, facts);
  assert.equal(result.status, 'prerequisites'); assert.equal(counter.calls(), 0);
  assert.equal(result.reasons.filter(r => /disabled.*unlimited/.test(r)).length, 2);
  for (const field of ['instructions', 'transactionBase64', 'messageBase64']) { assert.equal(Object.hasOwn(result, field), false); }
});

// SVM-FINAL-001: this exact rehashed registry/ALT alias previously built an actual 1030-byte packet.
test('native SVM-FINAL-001 coherent registry/ALT alias refuses before construction or compilation', () => {
  const { route, facts } = fixture(); route.alt = route.identities.registry; facts.state.alt.address = route.alt;
  rawEdit(facts, 'registry', b => solanaPublicKeyBytes(route.alt).copy(b, 73));
  rawEdit(facts, 'alt', b => solanaPublicKeyBytes(route.alt).copy(b, 56));
  const counter = countedBuilder();
  assert.throws(() => counter.build(route, facts), /conflicting captured account identities/);
  assert.equal(counter.calls(), 0); assert.equal(counter.constructions(), 0);
});
// SVM-FINAL-002: identical known raw defects must reject with either known or missing quote.
const suppliedFailures = [
  ['frozen source', f => rawEdit(f, 'sourceAta', b => { b[108] = 2; }), /initialized unfrozen/],
  ['mint freeze option', f => rawEdit(f, 'mint', b => b.writeUInt32LE(1, 46)), /mint authority.*freeze layout/],
  ['supply above F', f => { f.before.mintSupply = '100000000001'; rawEdit(f, 'mint', b => b.writeBigUInt64LE(100000000001n, 36)); }, /overissuance.*100000000001/],
  ['inactive ALT', f => rawEdit(f, 'alt', b => b.writeBigUInt64LE(100n, 12)), /ALT active metadata/]];
for (const [label, mutate, reason] of suppliedFailures) {
  for (const missingQuote of [false, true]) {
    test('native SVM-FINAL-002 ' + label + ' with ' + (missingQuote ? 'unknown' : 'known') + ' quote rejects before construction', () => {
      const { route, facts } = fixture(); mutate(facts); if (missingQuote) { facts.fees.quote = null; }
      const counter = countedBuilder(); assert.throws(() => counter.build(route, facts), reason);
      assert.equal(counter.calls(), 0); assert.equal(counter.constructions(), 0);
    });
  }
}
// Missing typed before-state cannot erase already observed raw SPL/ALT incompatibilities.
test('native SVM-FINAL-002 raw defects reject even without before-state and costs', () => {
  for (const [, mutate, reason] of suppliedFailures) {
    for (const missingQuote of [false, true]) {
      const { route, facts } = fixture(); mutate(facts); facts.before = null; if (missingQuote) { facts.fees.quote = null; }
      const counter = countedBuilder(); assert.throws(() => counter.build(route, facts), reason);
      assert.equal(counter.calls(), 0); assert.equal(counter.constructions(), 0); assert.equal(facts.before, null);
    }
  }
});
test('native same-slot raw balances exceeding supply reject with known or missing before-state and quote', () => {
  const { route, facts } = fixture(), supply = Buffer.from(facts.state.mint.dataBase64, 'base64').readBigUInt64LE(36);
  rawEdit(facts, 'poolAta', b => b.writeBigUInt64LE(supply, 64)); facts.before.poolBalance = supply.toString();
  for (const missing of [false, true]) {
    const paired = structuredClone(facts); if (missing) { paired.before = null; paired.fees.quote = null; }
    const counter = countedBuilder();
    assert.throws(() => counter.build(route, paired), /captured source\/pool balances or pool delegation/);
    assert.equal(counter.calls(), 0); assert.equal(counter.constructions(), 0);
    if (missing) { assert.equal(paired.before, null); assert.equal(paired.fees.quote, null); }
  }
});
// Positive unavailable controls preserve unknowns without send/Approve construction or native compilation.
test('native unavailable before-state and quote remain null with zero construction and compilation', () => {
  for (const missingState of [false, true]) {
    const { route, facts } = fixture(); facts.before = null; facts.fees.quote = null; if (missingState) { facts.state = null; }
    const counter = countedBuilder(), result = counter.build(route, facts);
    assert.equal(result.status, 'prerequisites'); assert.equal(result.broadcastAllowed, false);
    assert.equal(counter.calls(), 0); assert.equal(counter.constructions(), 0);
    assert.ok(result.reasons.includes('quote missing')); assert.ok(result.reasons.includes('common captured before-state missing'));
    assert.equal(result.knownCostLowerBoundLamports, '5000'); assert.equal(facts.before, null); assert.equal(facts.fees.quote, null);
    for (const field of ['instructions', 'messageBase64', 'transactionBase64', 'modelledAfter']) { assert.equal(Object.hasOwn(result, field), false); }
  }
});
// The construction/compile observers must see real positive work, with compatible authority aliases and duplicate program metas.
test('native compatible aliases build with live construction and compiler observers', () => {
  const { route, facts } = fixture(); route.lookupTableAuthority = route.payer; route.roles.rateAdmin = route.roles.poolOwner;
  rawEdit(facts, 'alt', b => solanaPublicKeyBytes(route.payer).copy(b, 22));
  rawEdit(facts, 'pool', b => solanaPublicKeyBytes(route.roles.rateAdmin).copy(b, 202));
  const counter = countedBuilder(), result = counter.build(route, facts);
  assert.equal(result.status, 'built'); assert.equal(counter.calls(), 1); assert.equal(counter.constructions(), 2);
  const send = result.instructions.at(-1);
  assert.equal(send.accounts[4].address, send.accounts[7].address);
  assert.equal(send.accounts[5].address, send.accounts[27].address);
  verifyDevSvmCallPlan(p, route, facts, result);
});
