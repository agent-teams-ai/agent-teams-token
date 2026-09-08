import assert from 'node:assert/strict';
import test from 'node:test';
import { MANUAL, manualInput, validateManualInput, manualInstructions, manualExpected, verifyManualIntent } from '../src/domain/solana-manual-execution.mjs';
import { executeSolanaManualRecovery } from '../src/composition/solana-manual-execution.mjs';
import { unsignedFixture } from './solana-manual-execution-fixture.mjs';
const expected=manualExpected(unsignedFixture.lookupTables);
test('independent Borsh original report matches public native SDK fixture; strict report/account/proof scope',()=>{
  const ix=manualInstructions();assert.equal(ix[1].dataBase64,unsignedFixture.instructions[0].dataBase64);
  assert.equal(ix[1].accounts.length,26);assert.equal(Buffer.from(ix[1].dataBase64,'base64').length,305);
  validateManualInput(manualInput());
  for(const mutate of [i=>i.message.messageId='0x'+'01'.repeat(32),i=>i.message.tokenReceiver=MANUAL.mint,
    i=>i.proofs.push('0x'+'00'.repeat(32)),i=>i.message.tokenAmounts[0].amount='2',i=>i.merkleRoot='0x'+'01'.repeat(32)]){
    const input=manualInput();mutate(input);assert.throws(()=>validateManualInput(input));
  }
  for(const mutate of [a=>a.push(a[0]),a=>a[1].accounts[13].address=MANUAL.mint,a=>a[1].accounts[12].isWritable=true,
    a=>a[1].accounts[15].isSigner=true,a=>a[1].dataBase64='AQID']){
    const changed=structuredClone(ix);mutate(changed);assert.throws(()=>verifyManualIntent({feePayer:MANUAL.payer,instructions:changed},expected));
  }
  const tables=structuredClone(unsignedFixture.lookupTables);tables[0].addresses[0]=MANUAL.mint;
  assert.throws(()=>manualExpected(tables),/ALT/);
});
const settings={testOnly:true,journalFile:'/tmp/manual-recovery-test/journal.json',maxNativeBalanceLamports:'1000000000'};
function fixture(){
  let record=null,broadcasts=0,candidates=0,signs=0;
  const signed={bytesBase64:'AQID',signature:'1'.repeat(88),blockhash:'1'.repeat(32),lastValidBlockHeight:'100'};
  const sdk={state:{before:async()=>{},destroy:async()=>{}},
    candidate:async()=>{candidates++;return {lookupTables:unsignedFixture.lookupTables.map(t=>({key:{toBase58:()=>t.key},state:{addresses:t.addresses.map(a=>({toBase58:()=>a}))}}))};},
    build:()=>({bytesBase64:'AQID'}),sign:async()=>{signs++;return signed;},
    inspectSigned:()=>({...signed,messageBase64:'BAUG',intent:{feePayer:MANUAL.payer,instructions:manualInstructions()}})};
  const rpc={chain:async()=>{},readRpc:async m=>m==='getLatestBlockhash'?{value:{blockhash:signed.blockhash,lastValidBlockHeight:100}}:{value:{err:null}},
    observe:async()=>({kind:'not-found'}),broadcast:async()=>{broadcasts++;throw new Error('uncertain');}};
  const store={exclusive:w=>w(),read:async()=>record,write:async r=>{record=r;}};
  return {sdk,rpc,ports:{sdk:async()=>sdk,store:()=>store,rpc:()=>rpc},counts:()=>({broadcasts,candidates,signs}),record:()=>record};
}
test('unknown/expired resume retains durable exact signed identity and never regenerates',async()=>{
  const f=fixture();await executeSolanaManualRecovery(settings,f.ports);assert.equal(f.record().phase,'submitting');
  const before=f.counts();f.rpc.observe=async()=>({kind:'expired'});
  f.sdk.candidate=f.sdk.state.before=async()=>{throw new Error('fresh call forbidden');};
  const result=await executeSolanaManualRecovery(settings,f.ports);
  assert.equal(result.reason,'submission-unresolved-or-expired');assert.deepEqual(f.counts(),before);
  f.record().intent.messageId='0x'+'01'.repeat(32);
  await assert.rejects(executeSolanaManualRecovery(settings,f.ports),/identity/);
});
test('manual native delay/simulation errors stop before signing or writing journal',async()=>{
  const f=fixture();f.rpc.readRpc=async m=>m==='getLatestBlockhash'?{value:{blockhash:'1'.repeat(32),lastValidBlockHeight:100}}:{value:{err:{InstructionError:[1,{Custom:9020}]}}};
  await assert.rejects(executeSolanaManualRecovery(settings,f.ports),/simulation/);
  assert.equal(f.counts().signs,0);assert.equal(f.record(),null);
  await assert.rejects(executeSolanaManualRecovery({...settings,maxNativeBalanceLamports:'1000000001'},f.ports),/1 SOL/);
});

test('manual opts into forwarding 3; fresh signed unknown then absent observes same identity twice',async()=>{
  const f=fixture();let observations=0,checks=0;
  f.ports.rpc=(inspect,after,fetcher,maxRetries)=>{
    assert.equal(typeof inspect,'function');assert.equal(typeof after,'function');
    assert.equal(fetcher,undefined);assert.equal(maxRetries,3);return f.rpc;
  };
  f.sdk.state.before=async()=>{checks++;};
  let firstSigned,firstIntent;
  f.rpc.observe=async(signed,intent)=>{
    assert.equal(f.record().phase,'signed');assert.deepEqual(signed,f.record().signed);
    if(++observations===1){firstSigned=signed;firstIntent=intent;return {kind:'unknown'};}
    assert.strictEqual(signed,firstSigned);assert.strictEqual(intent,firstIntent);return {kind:'not-found'};
  };
  const broadcast=f.rpc.broadcast;
  f.rpc.broadcast=async bytes=>{assert.equal(bytes,firstSigned.bytesBase64);return broadcast(bytes);};
  await executeSolanaManualRecovery(settings,f.ports);
  assert.equal(observations,2);assert.equal(checks,3);
  assert.deepEqual(f.counts(),{broadcasts:1,candidates:1,signs:1});
});
test('persistent unknown stops after two reads; stored signed resumes without regeneration',async()=>{
  const f=fixture();let observations=0;
  f.rpc.observe=async()=>{observations++;return {kind:'unknown'};};
  await executeSolanaManualRecovery(settings,f.ports);
  assert.equal(observations,2);assert.equal(f.record().phase,'signed');
  const original=structuredClone(f.record());
  assert.deepEqual(f.counts(),{broadcasts:0,candidates:1,signs:1});
  observations=0;
  f.rpc.observe=async(signed,intent)=>{
    assert.deepEqual(signed,original.signed);assert.deepEqual(intent,original.intent);
    return {kind:++observations===1?'unknown':'not-found'};
  };
  await executeSolanaManualRecovery(settings,f.ports);
  assert.equal(observations,2);assert.deepEqual(f.counts(),{broadcasts:1,candidates:1,signs:1});
});
for(const phase of ['signed','submitting','submitted','succeeded','failed']){
  for(const kind of ['unknown','expired','not-found']){
    if(phase==='signed'&&kind!=='expired'){continue;}
    test(`${phase}/${kind} does not regenerate or resend`,async()=>{
      const f=fixture();f.rpc.observe=async()=>({kind:'unknown'});
      await executeSolanaManualRecovery(settings,f.ports);
      f.record().phase=phase;
      const original=structuredClone(f.record()),before=f.counts();let observations=0;
      f.rpc.observe=async()=>{observations++;return {kind};};
      f.sdk.candidate=f.sdk.sign=f.sdk.state.before=async()=>{throw new Error('fresh effect forbidden');};
      await executeSolanaManualRecovery(settings,f.ports);
      assert.equal(observations,1);assert.deepEqual(f.counts(),before);assert.deepEqual(f.record(),original);
    });
  }
}
test('second observation never bypasses pre-broadcast state checks',async()=>{
  const f=fixture();let observations=0,checks=0;
  f.rpc.observe=async()=>({kind:++observations===1?'unknown':'not-found'});
  f.sdk.state.before=async()=>{if(++checks===3){throw new Error('state changed');}};
  const result=await executeSolanaManualRecovery(settings,f.ports);
  assert.equal(result.phase,'submitting');assert.equal(observations,2);
  assert.deepEqual(f.counts(),{broadcasts:0,candidates:1,signs:1});
});
