import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeDevSvmCpiCapture, DEV_SVM_CAPTURE_AUTHORITY, DEV_SVM_CAPTURE_INDEX_SCHEME } from '../src/adapters/dev-svm-cpi-capture.mjs';
import { solanaPublicKeyBytes, SPL_TOKEN_PROGRAM, SYSTEM_PROGRAM } from '../src/domain/solana-mint.ts';

const goldens = JSON.parse(readFileSync(new URL('./fixtures/dev-svm-cpi-capture-goldens.json', import.meta.url)));
const [mintA, reverse, mintB] = goldens.vectors;
const sha = b => createHash('sha256').update(b).digest('hex');
const original = v => ({ raw: Buffer.from(v.rawResponseUtf8), e: structuredClone(v.expectedContext) });
const decode = ({ raw, e }) => decodeDevSvmCpiCapture(raw, e);
const inspect = o => { if (o && typeof o === 'object') { assert.ok(Object.isFrozen(o)); assert.equal(Buffer.isBuffer(o), false); Object.values(o).forEach(inspect); } };
function changed(v, mutation) {
  const response = JSON.parse(v.rawResponseUtf8), e = structuredClone(v.expectedContext);
  mutation(response.result, e, response);
  const raw = Buffer.from(JSON.stringify(response)); e.sourceSha256 = sha(raw);
  return { raw, e };
}
const keys = t => [...t.transaction.message.accountKeys, ...t.meta.loadedAddresses.writable, ...t.meta.loadedAddresses.readonly];
const inner = t => t.meta.innerInstructions[0].instructions;
const top = t => t.transaction.message.instructions;
// Independent transport primitives for fixture MUTATIONS only. No positive
// golden is encoded by these or by the new capture decoder.
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function from58(s) {
  let n = 0n; for (const c of s) { n = n * 58n + BigInt(alphabet.indexOf(c)); }
  return Buffer.concat([Buffer.alloc(s.match(/^1*/)[0].length), n ? Buffer.from(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0'), 'hex') : Buffer.alloc(0)]);
}
function to58(b) {
  let n = BigInt('0x' + (b.toString('hex') || '0')), out = '';
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  let zeroes = 0; while (zeroes < b.length && b[zeroes] === 0) { zeroes++; }
  return '1'.repeat(zeroes) + out;
}
function ixMutation(ix, mutate) { const data = from58(ix.data); ix.data = to58(mutate(data) ?? data); }
function rejection(name, v, mutation, reason) {
  test(name, () => assert.throws(() => decode(changed(v, mutation)), reason));
}

// Regression: complete external source bytes, RPC encoding choice and original
// source digest cannot be replaced by a lossy fixture with a borrowed digest.
test('full three external json captures retain exact receipt bytes and selected authority', () => {
  assert.equal(goldens.vectors.length, 3);
  for (const v of goldens.vectors) {
    assert.equal(sha(Buffer.from(v.rawResponseUtf8)), v.receiptRecord.sha256);
    assert.equal(Buffer.byteLength(v.rawResponseUtf8), v.receiptRecord.bytes);
    assert.equal(v.receiptRecord.method, 'getTransaction');
    assert.equal(v.receiptRecord.params[1].encoding, 'json');
    assert.equal(v.expectedContext.sourceSha256, v.receiptRecord.sha256);
    const raw = JSON.parse(v.rawResponseUtf8).result;
    assert.ok(raw.transaction.message.header);
    assert.ok(raw.meta.loadedAddresses);
    assert.ok(raw.meta.preTokenBalances.length > 0 && raw.meta.postTokenBalances.length > 0);
  }
  assert.equal(DEV_SVM_CAPTURE_AUTHORITY.archiveSha256, goldens.sdkArchive.sha256);
  for (const [prefix, name] of [['router', 'CCIP_ROUTER'], ['offRamp', 'CCIP_OFFRAMP'], ['pool', 'BURN_MINT_TOKEN_POOL'], ['basePool', 'BASE_TOKEN_POOL']]) {
    const idl = goldens.idlAuthorities.find(a => a.path.endsWith('/' + name + '.js'));
    assert.equal(DEV_SVM_CAPTURE_AUTHORITY[prefix + 'Path'], idl.path);
    assert.equal(DEV_SVM_CAPTURE_AUTHORITY[prefix + 'Sha256'], idl.sha256);
  }
  assert.deepEqual(goldens.idlAuthorities[0].instructions[0].args.map(a => a.name), ['destChainSelector', 'message', 'tokenIndexes']);
  assert.ok(goldens.idlAuthorities[3].types.some(t => t.name === 'ReleaseOrMintInV1'));
});

// Regression: all three actual external transactions must decode against an
// independently selected oracle, including event ownership and physical indexes.
for (const v of goldens.vectors) {
  test('external raw selected facts: ' + v.label, () => {
    const got = decode(original(v)), expected = v.expectedFacts;
    assert.equal(got.capturedConsistency, 'known');
    assert.equal(got.sourceSha256, v.receiptRecord.sha256);
    assert.equal(got.transactionId, v.receiptRecord.params[0]);
    assert.equal(got.slot, v.expectedContext.slot);
    assert.equal(got.indexScheme, DEV_SVM_CAPTURE_INDEX_SCHEME);
    assert.equal(got.selectedInstruction.instructionName, expected.instructionName);
    assert.equal(got.selectedInvocation.ordinal, expected.rootOrdinal);
    assert.equal(got.selectedPoolInvocation.ordinal, expected.poolOrdinal);
    assert.equal(got.accounts.length, expected.accountCount);
    assert.equal(got.instructions.length, expected.instructionCount);
    assert.deepEqual(got.effects.map(({ kind, opcode, ordinal, instructionPath, owningInstructionPath }) => ({ kind, opcode, ordinal, instructionPath, owningInstructionPath })), expected.effects);
    assert.ok(got.effects.every(e => e.amount === '1000000000'));
    assert.ok(got.effects.every(e => e.mint === v.expectedContext.mint));
    assert.equal(got.effects.at(-1).authority, v.expectedContext.poolSigner);
    if (v === reverse) {
      assert.equal(got.effects[0].sourceAccount, v.expectedContext.sourceATA);
      assert.equal(got.effects[0].destinationAccount, v.expectedContext.poolATA);
      assert.equal(got.effects[0].authority, v.expectedContext.spender);
      assert.equal(got.effects[1].sourceAccount, v.expectedContext.poolATA);
    } else { assert.equal(got.effects[0].destinationAccount, v.expectedContext.recipientATA); }
    assert.deepEqual(got.events.map(e => e.logIndex), expected.eventLogIndexes);
    assert.deepEqual(got.events.map(e => e.decoded), expected.events);
    assert.ok(got.events.every(e => e.instructionPath[0] === 1 && e.instructionPath.length === 1));
    assert.equal(got.accounts.find(a => a.address === v.expectedContext.poolSigner).isSigner, false);
    assert.equal(got.capabilities.cpiSignerPrivilege, 'unknown');
    assert.equal(got.capabilities.historicalRouteAuthorization, 'unknown');
    assert.equal(got.capabilities.freshFinality, 'unknown');
    assert.equal(got.capabilities.poolArgumentLayout, 'known');
  });
}

// Regression: SDK 1.13.0 CCIP_ROUTER ccipSend requires writable positions
// 1/2/8. Reindex every reference before changing only that global privilege;
// instruction bytes, address bindings, events and balance observations survive.
function swapStaticAccounts(t, a, b) {
  const staticKeys = t.transaction.message.accountKeys;
  [staticKeys[a], staticKeys[b]] = [staticKeys[b], staticKeys[a]];
  const remap = i => i === a ? b : i === b ? a : i;
  for (const ix of [...top(t), ...t.meta.innerInstructions.flatMap(g => g.instructions)]) {
    ix.programIdIndex = remap(ix.programIdIndex); ix.accounts = ix.accounts.map(remap);
  }
  for (const side of ['preTokenBalances', 'postTokenBalances']) {
    for (const balance of t.meta[side]) { balance.accountIndex = remap(balance.accountIndex); }
  }
  for (const side of ['preBalances', 'postBalances']) {
    [t.meta[side][a], t.meta[side][b]] = [t.meta[side][b], t.meta[side][a]];
  }
}
for (const [position, name, retainedSha] of [
  [1, 'destChainState', '3647c18e98ad23124d06e770258326686d80eae38c51970452f6136987d5e0e8'],
  [2, 'nonce', '979e842265d4933a02c208a752eb9585601c8daa287376b72e15c641baf8de91'],
  [8, 'feeTokenReceiver', '834f031137017a1bf1fe444c59b2ea68b314fad765f56a17ad991a68bca3e46f'],
]) {
  test('Router rejects readonly ' + name + ' at position ' + position, () => {
    const reindex = t => swapStaticAccounts(t, top(t)[1].accounts[position], 6);
    const control = decode(changed(reverse, reindex)), baseline = decode(original(reverse));
    assert.deepEqual(control.effects, baseline.effects);
    assert.deepEqual(control.events, baseline.events);
    assert.deepEqual(control.balanceDeltas, baseline.balanceDeltas);
    const input = changed(reverse, t => { reindex(t); t.transaction.message.header.numReadonlyUnsignedAccounts++; });
    assert.equal(input.e.sourceSha256, retainedSha);
    assert.throws(() => decode(input), /Router mandatory writable/);
  });
}
test('Router allows extra global writable privilege on readonly IDL config', () => {
  const got = decode(changed(reverse, t => {
    swapStaticAccounts(t, top(t)[1].accounts[0], 7);
    t.transaction.message.header.numReadonlyUnsignedAccounts--;
  }));
  const root = got.instructions.find(n => n.ordinal === got.selectedInvocation.ordinal);
  assert.equal(got.accounts[root.accountIndexes[0]].isWritable, true);
  assert.equal(got.capturedConsistency, 'known');
  assert.equal(got.capabilities.cpiSignerPrivilege, 'unknown');
  assert.deepEqual(got.effects, decode(original(reverse)).effects);
});

// Regression: only the actual anchored runtime return grammar and canonical
// base64 are admissible. Change one active pool return line, retaining every
// instruction, event and balance. No return-value business policy is inferred.
for (const [name, line] of [
  ['non-runtime program return grammar', 'Program ' + mintA.expectedContext.poolProgram + ' return: !!!'],
  ['non-runtime grammar with canonical payload', 'Program ' + mintA.expectedContext.poolProgram + ' return: AA=='],
  ...[
    ['single base64 character', 'A'],
    ['missing padding', 'AA'],
    ['interior padding', 'A=AA'],
    ['excess padding', 'A==='],
    ['nonzero pad bits for one byte', 'AB=='],
    ['nonzero pad bits for two bytes', 'AAB='],
    ['invalid base64 alphabet', '!!!'],
    ['trailing text', 'AA== tail'],
    ['trailing newline', 'AA==\n'],
  ].map(([caseName, payload]) => [caseName, 'Program return: ' + mintA.expectedContext.poolProgram + ' ' + payload]),
]) {
  rejection('runtime return rejects ' + name, mintA, t => { t.meta.logMessages[21] = line; }, /canonical return base64|unsupported\/malformed runtime log/);
}
for (const payload of ['', 'AA==', 'AAA=', 'AAAA', '+/8=']) {
  test('runtime return accepts canonical base64 ' + JSON.stringify(payload), () => {
    const got = decode(changed(mintA, (t, e) => { t.meta.logMessages[21] = 'Program return: ' + e.poolProgram + ' ' + payload; }));
    const baseline = decode(original(mintA));
    assert.equal(got.capturedConsistency, 'known');
    assert.deepEqual(got.effects, baseline.effects);
    assert.deepEqual(got.events, baseline.events);
    assert.deepEqual(got.balanceDeltas, baseline.balanceDeltas);
  });
}
rejection('runtime return rejects canonical payload from inactive owner', mintA,
  t => { t.meta.logMessages[21] = 'Program return: ' + SYSTEM_PROGRAM + ' AA=='; }, /runtime log owner/);

// Regression: bigint amounts above 2^53 keep the final base unit throughout
// Router/report, pool, SPL, event and token balance matching. The wire replacement
// and expectation are independently literal; no implementation encoder is used.
function replaceAmount(b, width) {
  const before = Buffer.from('00ca9a3b' + '00'.repeat(width - 4), 'hex');
  const after = Buffer.from('0100000000002000' + '00'.repeat(width - 8), 'hex');
  const at = b.indexOf(before); assert.notEqual(at, -1); assert.equal(b.indexOf(before, at + 1), -1);
  after.copy(b, at); return b;
}
for (const v of [mintA, reverse]) {
  test('amount 9007199254740993 survives every selected binding: ' + v.label, () => {
    const input = changed(v, (t, e) => {
      e.amount = '9007199254740993';
      ixMutation(top(t)[1], b => replaceAmount(b, e.direction === 'mint' ? 32 : 8));
      ixMutation(inner(t)[e.direction === 'mint' ? 1 : 6], b => replaceAmount(b, e.direction === 'mint' ? 32 : 8));
      for (const i of e.direction === 'mint' ? [3] : [5, 8]) { ixMutation(inner(t)[i], b => replaceAmount(b, 8)); }
      if (e.direction === 'burn') {
        ixMutation(top(t)[0], b => replaceAmount(b, 8));
        const event = Buffer.from(t.meta.logMessages[38].slice(14), 'base64');
        replaceAmount(event, 32); t.meta.logMessages[38] = 'Program data: ' + event.toString('base64');
      }
      const index = e.direction === 'mint' ? 2 : 1;
      t.meta.preTokenBalances.find(b => b.accountIndex === index).uiTokenAmount.amount = e.direction === 'mint' ? '17' : '9007199254741010';
      t.meta.postTokenBalances.find(b => b.accountIndex === index).uiTokenAmount.amount = e.direction === 'mint' ? '9007199254741010' : '17';
    });
    const got = decode(input);
    assert.ok(got.effects.every(e => e.amount === '9007199254740993'));
    assert.equal(got.balanceDeltas[0].delta, v === reverse ? '-9007199254740993' : '9007199254740993');
    assert.equal(got.capturedConsistency, 'known');
  });
}

// Regression: direct PDA authority is distinct from a transaction signer or
// arbitrary/multisig authority, and spender and recipient roles are exact.
rejection('wrong Pool Signer PDA in selected context', mintA, (_t, e) => { e.poolSigner = e.recipient; }, /binding/);
rejection('wrong SPL mint authority raw meta', mintA, t => { inner(t)[3].accounts[2] = 9; inner(t)[3].accounts[3] = 9; }, /repeated SPL|binding/);
rejection('different extra SPL authority is not direct PDA evidence', mintA, t => { inner(t)[3].accounts[3] = 9; }, /authority metas/);
rejection('wrong transfer spender inside Router', reverse, t => { inner(t)[5].accounts[3] = 0; }, /binding/);
rejection('wrong burn authority inside pool', reverse, t => { inner(t)[8].accounts[2] = 29; }, /binding/);
rejection('wrong mint ATA raw meta', mintA, t => { inner(t)[3].accounts[1] = 10; }, /binding/);
rejection('wrong reverse source ATA', reverse, (_t, e) => { e.sourceATA = '2HGSh7v8thLVyxVSizQtvicsfKFrbYeL2sTSGjWzbCDE'; }, /binding/);
rejection('wrong mint raw meta', mintA, t => { inner(t)[3].accounts[0] = 9; }, /binding/);
rejection('wrong selected official pool owner/program', mintA, (_t, e) => { e.poolProgram = e.router; }, /official BurnMint/);
rejection('wrong captured classic token program owner', mintA, t => { t.meta.postTokenBalances[0].programId = SYSTEM_PROGRAM; }, /balance.*program/);
rejection('wrong captured recipient owner', mintA, t => { t.meta.postTokenBalances[0].owner = mintB.expectedContext.recipient; }, /balance.*owner/);

// Regression: checked and unchecked effects have different wire lengths and
// checked forms bind decimals. Unknown opcodes never fall back to amount matching.
for (const [v, index, opcode] of [[mintA, 3, 14], [reverse, 8, 15]]) {
  test('checked SPL form accepted with exact decimals9: ' + opcode, () => {
    const got = decode(changed(v, t => ixMutation(inner(t)[index], b => Buffer.concat([Buffer.from([opcode]), b.subarray(1), Buffer.from([9])]))));
    assert.equal(got.effects.at(-1).opcode, opcode); assert.equal(got.effects.at(-1).decimals, 9);
  });
  rejection('checked SPL rejects decimals8: ' + opcode, v, t => ixMutation(inner(t)[index], b => Buffer.concat([Buffer.from([opcode]), b.subarray(1), Buffer.from([8])])), /checked decimals/);
}
rejection('transferChecked rejects wrong decimals', reverse, t => ixMutation(inner(t)[5], b => { b[9] = 8; }), /checked decimals/);
rejection('unchecked MintTo rejects trailing bytes', mintA, t => ixMutation(inner(t)[3], b => Buffer.concat([b, Buffer.from([9])])), /effect length/);
rejection('unknown selected SPL opcode fails closed', mintA, t => ixMutation(inner(t)[3], b => { b[0] = 255; }), /unsupported selected SPL/);

// Regression: trace remains internally consistent after moving an effect; the
// rejection must come from causality, not merely an invalid log/stack mutation.
rejection('same mint amount under OffRamp but outside selected pool is rejected', mintA, t => {
  inner(t)[3].stackHeight = 2;
  const block = t.meta.logMessages.splice(16, 3); block[0] = block[0].replace('[3]', '[2]');
  t.meta.logMessages.splice(20, 0, ...block);
}, /mint owning invocation/);
rejection('same burn amount moved to a different top-level invocation is rejected', reverse, t => {
  const burn = inner(t).splice(8, 1)[0]; burn.stackHeight = 1; top(t).push(burn);
  const block = t.meta.logMessages.splice(31, 3); block[0] = block[0].replace('[3]', '[1]'); t.meta.logMessages.push(...block);
}, /reverse owning invocation/);
rejection('burn before transfer within same Router is rejected', reverse, t => {
  const transfer = inner(t).splice(5, 1)[0]; inner(t).splice(8, 0, transfer);
  const block = t.meta.logMessages.splice(21, 3); t.meta.logMessages.splice(35, 0, ...block);
}, /transferChecked before/);
rejection('duplicate physical mint in same pool is rejected', mintA, t => {
  inner(t).push(structuredClone(inner(t)[3])); t.meta.logMessages.splice(19, 0, ...t.meta.logMessages.slice(16, 19));
}, /unique selected mint/);
rejection('two selected OffRamp invocations are ambiguous', mintA, t => {
  const ix = structuredClone(top(t)[1]); top(t).push(ix);
  t.meta.innerInstructions.push({ index: 2, instructions: structuredClone(inner(t)) }); t.meta.logMessages.push(...t.meta.logMessages.slice(2));
}, /ambiguous selected/);

// Regression: independently meaningful used-state balances are deltas; legacy
// exact-to-zero and pool-zero assumptions must not constrain captured replay.
test('arbitrary recipient pre balance supports exact mint delta', () => {
  const got = decode(changed(mintB, t => { t.meta.preTokenBalances[0].uiTokenAmount.amount = '777'; t.meta.postTokenBalances[0].uiTokenAmount.amount = '1000000777'; }));
  assert.deepEqual(got.balanceDeltas[0], { address: mintB.expectedContext.recipientATA, status: 'known', pre: '777', post: '1000000777', delta: '1000000000', preEvidence: 'captured' });
});
test('reverse permits source greater than amount and nonzero pool before/after', () => {
  const got = decode(changed(reverse, t => {
    t.meta.preTokenBalances[0].uiTokenAmount.amount = '9000000000'; t.meta.postTokenBalances[0].uiTokenAmount.amount = '8000000000';
    t.meta.preTokenBalances[2].uiTokenAmount.amount = '444'; t.meta.postTokenBalances[2].uiTokenAmount.amount = '444';
  }));
  assert.deepEqual(got.balanceDeltas.map(b => [b.pre, b.post, b.delta]), [['9000000000', '8000000000', '-1000000000'], ['444', '444', '0']]);
});
rejection('wrong reverse source delta is rejected', reverse, t => { t.meta.postTokenBalances[0].uiTokenAmount.amount = '1'; }, /exact token balance delta/);
rejection('wrong pool delta is rejected', reverse, t => { t.meta.postTokenBalances[2].uiTokenAmount.amount = '1'; }, /exact token balance delta/);
rejection('impossible intermediate pool u64 overflow is rejected', reverse, t => { for (const side of ['preTokenBalances', 'postTokenBalances']) { t.meta[side][2].uiTokenAmount.amount = '18446744073709551615'; } }, /pool balance u64 overflow/);
rejection('wrong balance mint/decimals cannot support delta', mintA, t => { t.meta.postTokenBalances[0].uiTokenAmount.decimals = 8; }, /balance.*decimals/);

// Regression: a missing observation is not fabricated from a success/finality
// flag, zero post balance, a parsed name, or a later current-state assertion.
for (const [name, mutation] of [
  ['missing pre for pre-existing ATA', t => { t.meta.preTokenBalances.shift(); }],
  ['missing post', t => { t.meta.postTokenBalances = []; }],
  ['missing balance arrays', t => { delete t.meta.preTokenBalances; delete t.meta.postTokenBalances; }],
  ['missing classic owner evidence', t => { delete t.meta.postTokenBalances[0].programId; }],
  ['missing wallet owner evidence', t => { delete t.meta.postTokenBalances[0].owner; }],
  ['null owner evidence', t => { t.meta.postTokenBalances[0].owner = null; }],
]) {
  test(name + ' stays unknown', () => {
    const got = decode(changed(mintA, (t, e) => { mutation(t); t.finalized = true; t.decodedSuccess = true; e.finalized = true; }));
    assert.equal(got.capturedConsistency, 'unknown'); assert.equal(got.balanceDeltas[0].status, 'unknown');
    assert.equal(got.capabilities.freshFinality, 'unknown'); assert.equal(got.capabilities.mintAuthorityAndDelegateState, 'unknown');
  });
}

// Regression: absence of a pre balance is zero ONLY with same-capture ATA
// allocation+initialization, ordered before mint, zero prior lamports and exact
// classic owner/mint/recipient bindings. These changed captures are fixture cases.
function createdCapture(t, e) {
  const associated = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  t.meta.loadedAddresses.readonly.push(associated);
  t.meta.preBalances.push(0); t.meta.postBalances.push(0);
  t.transaction.message.addressTableLookups[0].readonlyIndexes.push(250);
  const programIdIndex = keys(t).length - 1;
  top(t).unshift({ programIdIndex, accounts: [0, 2, 0, 11, 15, 21], data: '', stackHeight: 1 });
  t.meta.innerInstructions[0].index++;
  const create = Buffer.alloc(52); create.writeBigUInt64LE(1488440n, 4); create.writeBigUInt64LE(165n, 12); solanaPublicKeyBytes(SPL_TOKEN_PROGRAM).copy(create, 20);
  const initialize = Buffer.concat([Buffer.from([18]), solanaPublicKeyBytes(e.recipient)]);
  t.meta.innerInstructions.unshift({ index: 0, instructions: [
    { programIdIndex: 15, accounts: [0, 2], data: to58(create), stackHeight: 2 },
    { programIdIndex: 21, accounts: [2, 11], data: to58(initialize), stackHeight: 2 },
  ] });
  t.meta.logMessages.unshift('Program ' + associated + ' invoke [1]', 'Program ' + SYSTEM_PROGRAM + ' invoke [2]',
    'Program ' + SYSTEM_PROGRAM + ' success', 'Program ' + SPL_TOKEN_PROGRAM + ' invoke [2]',
    'Program ' + SPL_TOKEN_PROGRAM + ' success', 'Program ' + associated + ' success');
  t.meta.preTokenBalances.shift(); t.meta.preBalances[2] = 0; t.meta.postBalances[2] = 1488440;
}
test('missing pre balance is zero for truly created classic ATA in same capture', () => {
  const got = decode(changed(mintA, createdCapture));
  assert.equal(got.capturedConsistency, 'known'); assert.equal(got.balanceDeltas[0].preEvidence, 'created-ATA-zero');
  assert.equal(got.balanceDeltas[0].pre, '0'); assert.equal(got.balanceDeltas[0].post, '1000000000');
});
test('idempotent ATA instruction with prior account lamports cannot prove creation', () => {
  const got = decode(changed(mintA, (t, e) => { createdCapture(t, e); top(t)[0].data = to58(Buffer.from([1])); t.meta.preBalances[2] = 1; }));
  assert.equal(got.capturedConsistency, 'unknown'); assert.equal(got.balanceDeltas[0].status, 'unknown');
});
test('ATA initialization without allocation cannot fabricate missing pre zero', () => {
  const got = decode(changed(mintA, (t, e) => { createdCapture(t, e); inner(t).shift(); t.meta.logMessages.splice(1, 2); }));
  assert.equal(got.balanceDeltas[0].status, 'unknown');
});
rejection('wrong ATA initialized owner fails closed', mintA, (t, e) => {
  createdCapture(t, e); ixMutation(inner(t)[1], b => { solanaPublicKeyBytes(mintB.expectedContext.recipient).copy(b, 1); });
}, /ATA initialized owner/);
rejection('unknown classic ATA initialization layout fails closed', mintA, (t, e) => {
  createdCapture(t, e); ixMutation(inner(t)[1], b => Buffer.concat([b, Buffer.from([0])]));
}, /ATA initialization layout/);
rejection('known wrong delta still rejects when owner evidence is missing', mintA, t => {
  delete t.meta.postTokenBalances[0].owner; t.meta.postTokenBalances[0].uiTokenAmount.amount = '1000000001';
}, /exact token balance delta/);

// Regression: exact runtime account/log membership must agree with ordered raw
// groups and heights. Rejection assertions distinguish each structural defect.
for (const [name, mutation, reason] of [
  ['duplicate groups', t => t.meta.innerInstructions.push(structuredClone(t.meta.innerInstructions[0])), /group index\/duplicate/],
  ['group beyond top count', t => { t.meta.innerInstructions[0].index = 99; }, /group index/],
  ['out of range account', t => { inner(t)[3].accounts[0] = 256; }, /account index/],
  ['out of range program', t => { inner(t)[3].programIdIndex = 256; }, /program index/],
  ['duplicate loaded identity', t => { t.meta.loadedAddresses.readonly[0] = t.transaction.message.accountKeys[0]; }, /repeated global/],
  ['lookup loaded counts disagree', t => { t.transaction.message.addressTableLookups[0].readonlyIndexes.pop(); }, /lookup\/loaded/],
  ['invalid header signer role', t => { t.transaction.message.header.numRequiredSignatures = 99; }, /header role/],
  ['height jumps across missing parent', t => { inner(t)[0].stackHeight = 3; }, /contradictory inner stack/],
  ['missing inner height', t => { delete inner(t)[3].stackHeight; }, /contradictory inner stack/],
  ['raw height disagrees with invoke log', t => { inner(t)[3].stackHeight = 2; }, /invoke log\/stack/],
  ['child borrows account outside parent', t => { inner(t)[3].accounts[2] = 0; }, /CPI account membership/],
  ['missing logs', t => { t.meta.logMessages = null; }, /complete logs/],
  ['truncated logs', t => { t.meta.logMessages.pop(); }, /incomplete.*log coverage/],
  ['truncation marker', t => { t.meta.logMessages[25] = 'Log truncated'; }, /truncated log/],
  ['wrong success owner', t => { t.meta.logMessages[18] = 'Program ' + SYSTEM_PROGRAM + ' success'; }, /success log membership/],
  ['wrong consumed owner', t => { t.meta.logMessages[17] = 'Program ' + SYSTEM_PROGRAM + ' consumed 131 of 154131 compute units'; }, /runtime log owner/],
  ['failed transaction', t => { t.meta.err = { InstructionError: [1, 'InvalidArgument'] }; }, /failed transaction/],
  ['failed invocation', t => { t.meta.logMessages[18] = 'Program ' + SPL_TOKEN_PROGRAM + ' failed: invalid argument'; }, /failed invocation/],
  ['parsed instruction payload', t => { inner(t)[3].parsed = { type: 'mintTo' }; }, /raw compiled/],
]) { rejection(name, mintA, mutation, reason); }

// Regression: valid program names or events do not authorize unknown instructions,
// malformed variable lengths, altered payload identities or event-owner spoofing.
rejection('OffRamp unknown discriminator despite unchanged Execute log name', mintA, t => ixMutation(top(t)[1], b => { b[0] ^= 1; }), /OffRamp discriminator/);
rejection('Router unknown discriminator despite unchanged CcipSend log name', reverse, t => ixMutation(top(t)[1], b => { b[7] ^= 1; }), /Router discriminator/);
rejection('raw Router receiver padding mismatch', reverse, t => ixMutation(top(t)[1], b => { b[20] = 1; }), /receiver ABI32/);
rejection('raw report variable vector cannot claim 4GiB', mintA, t => ixMutation(top(t)[1], b => { b.writeUInt32LE(0xffffffff, 8); }), /truncated instruction layout/);
rejection('raw Router trailing body fails closed', reverse, t => ixMutation(top(t)[1], b => Buffer.concat([b, Buffer.from([0])])), /trailing instruction layout/);
rejection('raw pool body trailing bytes fails closed', mintA, t => ixMutation(inner(t)[1], b => Buffer.concat([b, Buffer.from([0])])), /trailing instruction layout/);
rejection('pool body amount must agree with selected report/effect', mintA, t => ixMutation(inner(t)[1], b => { const at = b.indexOf(Buffer.from('00ca9a3b' + '00'.repeat(28), 'hex')); assert.ok(at >= 0); b[at] ^= 1; }), /pool.*amount/);
rejection('selected execution event message differs from raw report', mintA, t => { const b = Buffer.from(t.meta.logMessages[23].slice(14), 'base64'); b[24] ^= 1; t.meta.logMessages[23] = 'Program data: ' + b.toString('base64'); }, /event identity/);
rejection('selected request event amount differs from raw send/effects', reverse, t => { const b = Buffer.from(t.meta.logMessages[38].slice(14), 'base64'); b[325] ^= 1; t.meta.logMessages[38] = 'Program data: ' + b.toString('base64'); }, /event selected identity/);
rejection('BurnMint program ID cannot substitute event source pool STATE address', reverse, (t, e) => {
  const b = Buffer.from(t.meta.logMessages[38].slice(14), 'base64'); solanaPublicKeyBytes(e.poolProgram).copy(b, 221); t.meta.logMessages[38] = 'Program data: ' + b.toString('base64');
}, /event selected identity/);
rejection('JS number selector is rejected by the context port', mintA, (_t, e) => { e.sourceChainSelector = Number(e.sourceChainSelector); }, /decimal string/);
rejection('decoded-success flag cannot override raw execution Failure state', mintA, t => {
  const b = Buffer.from(t.meta.logMessages[23].slice(14), 'base64'); b[88] = 3;
  t.meta.logMessages[23] = 'Program data: ' + b.toString('base64'); t.decodedSuccess = true; t.finalized = true;
}, /execution event identity\/state/);
rejection('execution event moved under pool owner is rejected', mintA, t => { const event = t.meta.logMessages.splice(23, 1)[0]; t.meta.logMessages.splice(20, 0, event); }, /CCIP event wrong owning/);
rejection('execution success-only event cannot replace ordered raw state1 and state2', mintA, t => { t.meta.logMessages.splice(8, 1); }, /execution events missing/);

test('changed raw digest is rejected before decoding', () => {
  const v = original(mintA); v.raw = Buffer.concat([v.raw, Buffer.from('\n')]);
  assert.throws(() => decode(v), /raw digest mismatch/);
});
test('duplicate JSON identity key cannot be hidden by JSON.parse last-wins', () => {
  const v = original(mintA); v.raw = Buffer.from(v.raw.toString().replace('"slot":494905812', '"slot":1,"slot":494905812'));
  assert.notEqual(sha(v.raw), v.e.sourceSha256); v.e.sourceSha256 = sha(v.raw);
  assert.throws(() => decode(v), /duplicate JSON key/);
});

// Regression: reject all explicit DEV capacity excesses before decoding or
// iterating attacker-declared collections; exactly 256KiB of JSON is admitted.
test('transaction capacity is inclusive at 256KiB', () => {
  const v = original(mintA); v.raw = Buffer.concat([v.raw, Buffer.alloc(262144 - v.raw.length, 32)]); v.e.sourceSha256 = sha(v.raw);
  assert.equal(decode(v).capturedConsistency, 'known');
  v.raw = Buffer.concat([v.raw, Buffer.from(' ')]); assert.throws(() => decode(v), /transaction capacity/);
});
for (const [name, mutation, reason] of [
  ['accounts257', t => { t.transaction.message.accountKeys = Array(257).fill(t.transaction.message.accountKeys[0]); }, /accounts capacity/],
  ['combined accounts257', t => { t.meta.loadedAddresses.readonly = Array(245).fill(t.meta.loadedAddresses.readonly[0]); }, /combined accounts capacity/],
  ['instructions1025', t => { t.transaction.message.instructions = Array(1025).fill(top(t)[0]); t.meta.innerInstructions = []; }, /top instructions capacity/],
  ['combined instructions1025', t => { t.meta.innerInstructions[0].instructions = Array(1023).fill(inner(t)[0]); }, /combined instructions capacity/],
  ['logs2049', t => { t.meta.logMessages = Array(2049).fill('Program log: x'); }, /complete logs capacity/],
  ['encoded instruction1233', t => { inner(t)[3].data = '1'.repeat(1233); }, /encoded instruction capacity/],
  ['native account balances257', t => { t.meta.preBalances = Array(257).fill(0); }, /preBalances capacity/],
]) { rejection('DEV bound ' + name, mintA, mutation, reason); }

// Regression: output aliases, Buffer mutation or ambient state cannot change
// retained facts; every public nested object/array is frozen and replay is stable.
test('returns deterministic deeply immutable public DTOs without touching input', () => {
  const v = original(mintA), before = Buffer.from(v.raw), context = structuredClone(v.e);
  const a = decode(v), b = decode(v); assert.deepEqual(a, b); assert.deepEqual(v.raw, before); assert.deepEqual(v.e, context);
  inspect(a); assert.throws(() => { a.effects[0].amount = '0'; }, TypeError);
  v.raw.fill(0); v.e.amount = '1'; assert.equal(a.effects[0].amount, '1000000000');
});
