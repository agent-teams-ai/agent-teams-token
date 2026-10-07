import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as turn} from 'node:timers/promises';
import {transferSolanaReverse} from '../src/composition/solana-reverse-transfer.mjs';
import {replacementFixture} from '../src/domain/replacement-fixture.ts';
import {TEST_SDK_PROFILE} from '../src/adapters/test-sdk-policy.ts';

// Synthetic public fixture for zero-network lifecycle probes only.
const fixture=replacementFixture('0x'+'1'.repeat(40),'0x'+'2'.repeat(40));
const settings={testOnly:true,replayFetch:async()=>{throw new Error('Unexpected TEST transport');},providerProfile:TEST_SDK_PROFILE,fixture,fixtureIdentity:fixture.identity,
  providerDirectory:'/unused-provider',providerArchives:'/unused-archives',ccipProviderDirectory:'/unused-provider',
  payerFile:'/unused-test-key',recentSlot:'1',maxNativeBalanceLamports:'10000000000',
  journalFile:'/tmp/agtmai-replacement-'+fixture.identity+'/reverse-A/send.json'};

function harness(read:()=>Promise<null>,destroy:()=>Promise<void>){
  const calls={candidate:0,writes:0,broadcast:0};
  const sdk={pool:{routerConfig:'route'},destroy,
    derive:()=>({testOnly:true,cluster:'solana-devnet',approval:false,sourceLamports:'100'}),
    validateExpected(){},
    state:{config:async()=>'link',before:async()=>({approval:false,sourceLamports:'100'})},
    candidate:async()=>{calls.candidate++;throw new Error('Candidate must not be reached without a trusted signer');}};
  const ports={sdk:async()=>sdk,store:()=>({read,write:async()=>{calls.writes++;},exclusive:async<T>(work:()=>Promise<T>)=>work()}),
    rpc:()=>({chain:async()=>{},readRpc:async()=>{throw new Error('Unexpected RPC');},
      broadcast:async()=>{calls.broadcast++;throw new Error('Unexpected broadcast');}})};
  // These lifecycle doubles deliberately omit unused native compiler methods.
  // No mock assertion is used as native signature or on-chain evidence.
  const run=()=>transferSolanaReverse(settings,ports as unknown as NonNullable<Parameters<typeof transferSolanaReverse>[1]>);
  return {run,calls};
}

test('fresh admitted reverse requires a trusted signer before candidate or effects and destroys SDK',async()=>{
  let destroyed=false;
  const h=harness(async()=>null,async()=>{destroyed=true;});
  await assert.rejects(h.run(),/trusted.*signer/i);
  assert.deepEqual(h.calls,{candidate:0,writes:0,broadcast:0});
  assert.equal(destroyed,true);
});

test('reverse read failure waits for acquired SDK destruction before rejecting',async()=>{
  const failure=new Error('journal read failed');
  let entered!:()=>void,release!:()=>void,settled=false;
  const destructionEntered=new Promise<void>(resolve=>{entered=resolve;});
  const destructionReleased=new Promise<void>(resolve=>{release=resolve;});
  const h=harness(async()=>{throw failure;},async()=>{entered();await destructionReleased;});
  const work=h.run();
  const result=work.then(()=>{settled=true;return null;},error=>{settled=true;return error as unknown;});
  const didEnter=await Promise.race([destructionEntered.then(()=>true),result.then(()=>false)]);
  try{
    assert.equal(didEnter,true);
    await turn();
    assert.equal(settled,false);
  }finally{release();}
  assert.equal(await result,failure);
  assert.deepEqual(h.calls,{candidate:0,writes:0,broadcast:0});
});

test('reverse preserves both operation and cleanup failures',async()=>{
  const operation=new Error('journal read failed'),cleanup=new Error('SDK cleanup failed');
  const h=harness(async()=>{throw operation;},async()=>{throw cleanup;});
  await assert.rejects(h.run(),error=>{
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.includes(operation));
    assert.ok(error.errors.includes(cleanup));
    return true;
  });
  assert.deepEqual(h.calls,{candidate:0,writes:0,broadcast:0});
});
