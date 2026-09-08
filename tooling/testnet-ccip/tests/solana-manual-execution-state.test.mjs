import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { MANUAL, manualInput } from '../src/domain/solana-manual-execution.mjs';
import { manualCommitState, manualEligibility } from '../src/adapters/solana-manual-execution-state.mjs';
const disc = name => createHash('sha256').update('account:' + name).digest().subarray(0,8);
const raw = (b,owner=MANUAL.offRamp) => ({owner,executable:false,data:[b.toString('base64'),'base64']});
const expected={merkleRoot:MANUAL.merkleRoot,sequenceNumber:'11207'};
function report() {
  const b=Buffer.alloc(89);disc('CommitReport').copy(b);b[8]=1;
  b.writeBigUInt64LE(BigInt(manualInput().sourceChainSelector),9);Buffer.from(MANUAL.merkleRoot.slice(2),'hex').copy(b,17);
  b.writeBigInt64LE(1788833789n,49);b.writeBigUInt64LE(11207n,57);b.writeBigUInt64LE(11207n,65);return b;
}
function timing(now) {
  const config=Buffer.alloc(1848);disc('Config').copy(config);config[8]=1;config[9]=1;
  config.writeBigUInt64LE(16423721717087811551n,16);config.writeBigInt64LE(1200n,24);
  const clock=Buffer.alloc(40);clock.writeBigInt64LE(now,32);
  return [raw(config),raw(clock,'Sysvar1111111111111111111111111111111111111')];
}
test('original committed source/root and untouched bit are mandatory before execution',()=>{
  assert.deepEqual(manualCommitState(raw(report()),expected,'before'),{timestamp:1788833789n,state:0});
  for(const offset of [0,8,9,17]) {
    const b=report();b[offset]^=1;
    assert.throws(()=>manualCommitState(raw(b),expected,'before'));
  }
  for(const [offset,value] of [[57,11208n],[65,11206n]]) {
    const b=report();b.writeBigUInt64LE(value,offset);assert.throws(()=>manualCommitState(raw(b),expected,'before'),/interval/);
  }
  for(const state of [1n,2n,3n]) {
    const b=report();b.writeBigUInt64LE(state,73);assert.throws(()=>manualCommitState(raw(b),expected,'before'),/forbids/);
  }
  assert.throws(()=>manualCommitState(raw(report(),'11111111111111111111111111111111'),expected,'before'),/owner/);
  assert.throws(()=>manualCommitState(raw(report()),{...expected,merkleRoot:'0x'+'00'.repeat(32)},'before'),/original/);
  assert.throws(()=>manualCommitState(raw(report()),{...expected,sequenceNumber:'11208'},'before'),/original/);
});
test('commit execution bitmap reads exact sequence position, including upper u64',()=>{
  const b=report();b.writeBigUInt64LE(11144n,57);b.writeBigUInt64LE(11207n,65);b.writeBigUInt64LE(2n<<62n,81);
  assert.equal(manualCommitState(raw(b),expected,'after').state,2);
  b.writeBigUInt64LE(2n,81);assert.throws(()=>manualCommitState(raw(b),expected,'after'),/forbids/);
  b.writeBigUInt64LE(11143n,57);assert.throws(()=>manualCommitState(raw(b),expected,'after'),/interval/);
});
test('native successful state is mandatory after, never untouched or in-progress',()=>{
  assert.throws(()=>manualCommitState(raw(report()),expected,'after'),/forbids/);
  const b=report();b.writeBigUInt64LE(2n,73);
  assert.equal(manualCommitState(raw(b),expected,'after').state,2);
  assert.throws(()=>manualCommitState(raw(b),expected,'unknown'),/forbids/);
  assert.throws(()=>manualCommitState(raw(Buffer.concat([b,Buffer.alloc(1)])),expected,'after'),/original/);
});
test('manual protocol delay uses finalized Clock and strict greater-than boundary',()=>{
  const stamp=1788833789n;
  for(const now of [stamp,stamp+1199n,stamp+1200n]) {
    assert.throws(()=>manualEligibility(...timing(now),stamp),/2026-09-08T02:36:30.000Z/);
  }
  assert.deepEqual(manualEligibility(...timing(stamp+1201n),stamp),{eligibleAt:'1788834990',clockTimestamp:'1788834990'});
  const [config,clock]=timing(stamp+1201n);
  assert.throws(()=>manualEligibility({...clock,owner:MANUAL.offRamp},clock,stamp),/config/);
  assert.throws(()=>manualEligibility(config,{...clock,owner:MANUAL.offRamp},stamp),/owner/);
  const bad=Buffer.from(config.data[0],'base64');bad.writeBigInt64LE(-1n,24);
  assert.throws(()=>manualEligibility(raw(bad),clock,stamp),/Invalid/);
});
