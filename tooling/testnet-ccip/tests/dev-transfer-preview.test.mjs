import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { readPreviewInput, normalizePreviewEvm } from '../src/adapters/dev-transfer-preview-input.mjs';
import { admitDevTransfer } from '../src/domain/dev-transfer-preview.mjs';
import { prepareDevTransferPreview } from '../src/application/dev-transfer-preview.mjs';
import { previewPorts } from '../src/adapters/dev-transfer-preview-store.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/dev-transfer-preview.json', import.meta.url)));
const input = () => structuredClone(fixture);
const read = value => readPreviewInput(JSON.stringify(value));
const preview = value => prepareDevTransferPreview(read(value), previewPorts);
const set = (v, path, value) => { const keys = path.split('.'); const last = keys.pop(); for (const k of keys) {v = v[k];} v[last] = value; };

// Failure caught: JSON normalization could erase a misspelled checksum or duplicate executable field.
test('strict explicit route rejects unsafe input before any provider is evaluated', () => {
  for (const [path, value] of [
    ['lane.chainId', '1'], ['lane.genesisHash', '11111111111111111111111111111111'], ['lane.solanaSelector', '124615329519749607'],
    ['lane.poolProgram', fixture.pair.svm.mint], ['testOnly', false], ['broadcastAllowed', true], ['sourceRevision', '0'.repeat(40)],
    ['schemaVersion', 2], ['profile', 'qualified'], ['fixedSupplyBaseUnits', '100000000000'], ['amount', '0'], ['amount', '01'],
    ['amount', '1e9'], ['amount', '-1'], ['amount', '1.0'], ['amount', 1000000000], ['amount', '18446744073709551616'],
    ['pair.evm.token', '0x' + '0'.repeat(40)], ['pair.evm.pool', '0x' + '0'.repeat(40)], ['pair.evm.sender', '0x' + '0'.repeat(40)],
    ['pair.evm.registryAdmin', '0x' + '0'.repeat(40)], ['pair.evm.recipient', '0x' + '0'.repeat(40)],
    ['pair.svm.sender', fixture.pair.svm.poolOwner], ['pair.svm.payer', fixture.pair.svm.poolOwner],
    ['pair.svm.poolAta', fixture.pair.svm.sourceAta], ['pair.svm.mint', '0OIl'], ['pair.svm.alt.writableIndexes', [3]],
    ['limiters.evmOutbound.enabled', false], ['limiters.evmOutbound.capacity', '18446744073709551616'],
  ]) { const v = input(); set(v, path, value); assert.throws(() => read(v), undefined, path); }
  for (const field of ['privateKey', 'seed', 'sign', 'broadcast', 'rpcUrl', 'provider', 'approval']) {
    const v = input(); v[field] = 'forbidden'; assert.throws(() => read(v));
  }
  const raw = JSON.stringify(fixture);
  assert.throws(() => readPreviewInput(raw.replace('"testOnly":true', '"testOnly":false,"testOnly":true')), /Duplicate/);
  assert.throws(() => readPreviewInput(raw.replace('"testOnly":true', '"testOnly":false,"test\\u004fnly":true')), /Duplicate/);
  assert.throws(() => readPreviewInput(raw + 'x'), /Trailing/);
  // Failure caught: JavaScript whitespace rules could accept bytes forbidden by the JSON wire grammar.
  assert.throws(() => readPreviewInput('\u00a0' + raw));
  assert.throws(() => readPreviewInput(raw + '\ufeff'), /Trailing/);
  assert.throws(() => readPreviewInput(' '.repeat(65537)), /byte bound/);
  assert.equal(normalizePreviewEvm('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
  assert.throws(() => normalizePreviewEvm('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAee'), /checksum/);
});

// Failure caught: setup-only supply==amount/pool==0 or admin==payer assumptions would reject a used lane.
test('used-state admission keeps user, initial/current administrator and ALT authority separate', () => {
  const v = read(input());
  assert.notEqual(v.pair.evm.sender, v.pair.evm.poolOwner);
  assert.notEqual(v.pair.evm.initialAdmin, v.pair.evm.registryAdmin);
  assert.notEqual(v.pair.svm.payer, v.pair.svm.registryAdmin);
  assert.notEqual(v.pair.svm.payer, v.pair.svm.alt.authority);
  for (const direction of ['forward', 'reverse']) {
    assert.equal(admitDevTransfer(v, direction).status, 'admitted-in-model');
    assert.equal(admitDevTransfer(v, direction).approval.required, true);
  }
  const output = preview(input());
  assert.equal(output.plan.legs.reverse.conditional, true);
  assert.match(output.plan.legs.reverse.condition, /Finalized receive/);
  assert.deepEqual(output.plan.legs.reverse.hypotheticalAfter, { sourceBalance: '2000000000', poolBalance: '7', supply: '9000000000',
    delegate: null, delegatedAmount: '0', provenance: 'hypothetical; exhausted classic SPL delegation resets None' });
  assert.equal(output.facts.currentReadiness, null);
  assert.equal(output.plan.legs.forward.unsignedAvailable, false);
  assert.equal(output.plan.evidenceClass, 'fixture-only');
});

// Failure caught: silently overwriting a positive allowance/delegate could grant extra spending authority.
test('zero/exact approvals are bounded; partial, excess, foreign and unknown require reconciliation', () => {
  for (const amount of ['0', '999999999', '1000000000', '1000000001', null]) {
    const v = read(input()); v.states.forward.allowance = amount;
    const result = admitDevTransfer(v, 'forward');
    assert.equal(result.status, amount === '0' || amount === '1000000000' ? 'admitted-in-model' : 'prerequisite');
    assert.equal(result.approval.required, amount === '0' ? true : amount === '1000000000' ? false : null);
  }
  for (const [delegate, amount, expected] of [[null, '0', 'admitted-in-model'], [fixture.pair.svm.spender, '0', 'admitted-in-model'],
    [fixture.pair.svm.spender, '1000000000', 'admitted-in-model'], [fixture.pair.svm.spender, '999999999', 'prerequisite'],
    [fixture.pair.svm.spender, '1000000001', 'prerequisite'], [fixture.pair.svm.poolOwner, '0', 'prerequisite'], [null, '1', 'inconsistent']]) {
    const v = read(input()); v.states.reverse.source.delegate = delegate; v.states.reverse.source.delegatedAmount = amount;
    assert.equal(admitDevTransfer(v, 'reverse').status, expected);
  }
  const v = input(); v.states.reverse.source.delegate = v.pair.svm.spender; v.states.reverse.source.delegatedAmount = v.amount;
  assert.equal(preview(v).plan.legs.reverse.operations.length, 1);
  assert.equal(preview(v).plan.legs.reverse.hypotheticalAfter.delegate, null);
});

// Failure caught: mint freeze None cannot establish the token account's state or delegated spender.
test('classic SPL layout, direct authority, role bindings, peers and ALT substitutions refuse a leg', () => {
  for (const [path, value] of [
    ['mint.program', fixture.lane.poolProgram], ['mint.length', 83], ['mint.initialized', false], ['mint.decimals', 8],
    ['mint.authority', fixture.pair.svm.registryAdmin], ['mint.freezeAuthority', fixture.pair.svm.registryAdmin],
    ['source.program', fixture.lane.poolProgram], ['source.length', 166], ['source.owner', fixture.pair.svm.poolOwner],
    ['source.mint', fixture.pair.svm.pool], ['source.state', 'frozen'], ['source.state', 'uninitialized'], ['source.native', true],
    ['source.closeAuthority', fixture.pair.svm.poolOwner], ['poolAccount.state', 'frozen'], ['poolAccount.native', true],
    ['poolAccount.closeAuthority', fixture.pair.svm.poolOwner], ['poolAccount.delegate', fixture.pair.svm.spender], ['poolAccount.delegatedAmount', '1'],
    ['poolOwner', fixture.pair.svm.payer], ['registryAdmin', fixture.pair.svm.payer], ['pendingOwner', fixture.pair.svm.payer],
    ['rateAdmin', fixture.pair.svm.payer], ['registryVersion', 1], ['registryLength', 169], ['supportsAutoDerivation', true],
    ['registryAlt', fixture.pair.svm.pool], ['registryProgram', fixture.lane.poolProgram], ['poolProgram', fixture.lane.routerProgram],
    ['writableIndexes', []], ['alt.authority', fixture.pair.svm.payer], ['alt.program', fixture.lane.poolProgram],
    ['alt.deactivationSlot', '200'], ['alt.lastExtendedSlot', '200'], ['alt.addresses', fixture.pair.svm.alt.addresses.toReversed()],
    ['remoteTokenHex', 'f'.repeat(64)], ['remotePoolHex', 'f'.repeat(40)], ['remoteSelector', '5009297550715157269'],
    ['router', fixture.pair.svm.pool], ['rmn', fixture.pair.svm.pool],
  ]) { const v = input(); set(v.states.reverse, path, value); assert.equal(admitDevTransfer(read(v), 'reverse').status, 'inconsistent', path); }
  const v = input(); v.pair.svm.alt.authority = null; v.states.reverse.alt.authority = null;
  assert.equal(admitDevTransfer(read(v), 'reverse').status, 'admitted-in-model');
});

// Failure caught: small or missing balances, incoherent snapshots, and wraparound could authorize impossible spending.
test('balance bounds and observation knownness fail without inventing zero', () => {
  for (const balance of ['1000000000', '2000000000', '999999999', null]) {
    const v = input(); v.states.forward.balance = balance;
    assert.equal(admitDevTransfer(read(v), 'forward').status, balance === null || balance === '999999999' ? 'prerequisite' : 'admitted-in-model');
  }
  for (const [path, value, status] of [['source.balance', '999999999', 'prerequisite'], ['mint.supply', '3000000006', 'inconsistent'],
    ['poolAccount.balance', '18446744073709551615', 'inconsistent'], ['commonBeforeState', false, 'prerequisite'], ['alt', null, 'prerequisite'],
    ['mint.supply', '100000000000000001', 'inconsistent']]) {
    const v = input(); set(v.states.reverse, path, value); assert.equal(admitDevTransfer(read(v), 'reverse').status, status, path);
  }
  const v = input(); v.states.forward = null; v.states.reverse = null;
  const output = preview(v); assert.equal(output.facts.knownness.forwardState, null); assert.equal(output.plan.legs.reverse.hypotheticalAfter, null);
  assert.equal(output.plan.legs.forward.admission.status, 'prerequisite');
});

// Failure caught: treating a disabled limiter as paused, borrowing observed policy, or predicting refill gives false availability.
test('paired capacities/rates and point-bound available buckets are mandatory', () => {
  for (const name of ['evmOutbound', 'evmInbound', 'svmOutbound', 'svmInbound']) {
    for (const [field, value, status] of [['tokens', '999999999', 'prerequisite'], ['tokens', '10000000001', 'inconsistent'],
      ['rate', '999999999', 'inconsistent'], ['owner', name.startsWith('evm') ? fixture.pair.evm.sender : fixture.pair.svm.payer, 'inconsistent']]) {
      const v = input(); v.buckets[name][field] = value;
      assert.equal(admitDevTransfer(read(v), name === 'evmOutbound' || name === 'svmInbound' ? 'forward' : 'reverse').status, status);
    }
    const v = input(); v.buckets[name].context.point = '201';
    assert.equal(admitDevTransfer(read(v), name === 'evmOutbound' || name === 'svmInbound' ? 'forward' : 'reverse').status, 'inconsistent');
  }
  const v = input(); for (const name of Object.keys(v.limiters)) { v.limiters[name].capacity = '0'; v.limiters[name].rate = '0'; v.buckets[name].capacity = '0'; v.buckets[name].rate = '0'; v.buckets[name].tokens = '0'; }
  assert.equal(admitDevTransfer(read(v), 'forward').status, 'prerequisite');
});

// Failure caught: a stale fixture quote or unknown native component could become a current fee ceiling or a zero-cost send.
test('quote bindings, fee caps and native uncertainty remain explicit', () => {
  for (const [path, value] of [['amount', '999999999'], ['selector', '5009297550715157269'], ['recipient', fixture.pair.evm.sender],
    ['feeToken', 'other'], ['ccipFee', '0'], ['ccipFee', '100000001']]) {
    const v = input(); v.quotes.reverse[path] = value; assert.equal(preview(v).plan.status, 'inconsistent', path);
  }
  const v = input(); v.quotes.forward = null; v.quotes.reverse.networkFee = null; v.quotes.reverse.expiresAt = '2026-09-08T00:00:01Z';
  const result = preview(v); assert.equal(result.plan.legs.forward.quote.value, null); assert.equal(result.plan.legs.reverse.quote.totalExposure, null);
  assert.equal(result.plan.legs.reverse.quote.current, false); assert.equal(result.plan.legs.reverse.quote.executionTimeCeilingProven, false);
  assert.match(result.plan.legs.reverse.quote.reasons.join(' '), /expired.*networkFee/);
});

// Failure caught: correct token balances could mask substituted registration, administrator, router or remote pool facts.
test('EVM transfer observations bind each authority and directional peer independently', () => {
  for (const [path, value] of [['token', fixture.pair.evm.pool], ['pool', fixture.pair.evm.token], ['poolOwner', fixture.pair.evm.sender],
    ['initialAdmin', fixture.pair.evm.registryAdmin], ['registryAdmin', fixture.pair.evm.initialAdmin], ['pendingAdmin', fixture.pair.evm.sender],
    ['router', fixture.pair.evm.pool], ['rmn', fixture.pair.evm.pool], ['registry', fixture.pair.evm.pool], ['backingHolder', fixture.pair.evm.sender],
    ['registeredPool', fixture.pair.evm.token], ['artifactSha256', '0'.repeat(64)], ['decimals', 8], ['totalSupply', '100000000000'],
    ['allowanceOwner', fixture.pair.evm.recipient], ['allowanceSpender', fixture.pair.evm.sender],
    ['remoteTokenHex', '0'.repeat(64)], ['remotePoolHex', '0'.repeat(64)], ['remoteSelector', '5009297550715157269']]) {
    const v = input(); set(v.states.forward, path, value); assert.equal(admitDevTransfer(read(v), 'forward').status, 'inconsistent', path);
  }
});

// Failure caught: a direct application caller could bypass the CLI and launder effectful mode or zero recipients into a TEST plan.
test('application route admission rejects invalid mode and actors before calling output ports', () => {
  for (const [path, value] of [['testOnly', false], ['broadcastAllowed', true], ['profile', 'accepted'], ['decimals', 18], ['pair.evm.recipient', '0x' + '0'.repeat(40)]]) {
    const v = input(); set(v, path, value); let calls = 0;
    assert.throws(() => prepareDevTransferPreview(v, { digest: () => { calls++; return 'bad'; }, render: () => { calls++; return 'bad'; } }));
    assert.equal(calls, 0);
  }
});
