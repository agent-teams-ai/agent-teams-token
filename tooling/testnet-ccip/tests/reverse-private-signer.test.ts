import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as turn} from 'node:timers/promises';
import {createReverseSigning,checkReverseSigned} from '../src/adapters/solana-reverse-operator.ts';
import type {NativeSolanaProvider} from '../src/adapters/test-sdk-admission.ts';
import type {createReverseTransactionSdk,ReverseExpectation,FinalizedLookup} from '../src/adapters/solana-reverse-sdk.mjs';

const prepared={bytesBase64:'AQ==',messageBase64:'Ag==',blockhash:'hash',lastValidBlockHeight:'100'};
const signed={bytesBase64:'Aw==',signature:'sig',blockhash:'hash',lastValidBlockHeight:'100'};
const inspected={intent:{feePayer:'test-payer',instructions:[]},messageBase64:'Ag==',signature:'sig',blockhash:'hash'};
class Key {
  private value:string;
  constructor(value:string){this.value=value;}
  toBase58(){return this.value;}
}
class Lookup {
  readonly key:Key; readonly state:{deactivationSlot:bigint;lastExtendedSlot:number;lastExtendedSlotStartIndex:number;addresses:Key[];authority?:Key};
  constructor(value:{key:Key;state:Lookup['state']}){this.key=value.key;this.state=value.state;}
}
function fixture(sign:()=>Promise<typeof signed>=async()=>signed){
  const calls:{key?:string;lookup?:string|undefined;sign:number}={sign:0};
  const snapshot={slot:'3',lookupTable:new Lookup({key:new Key('alt'),state:{deactivationSlot:1n,lastExtendedSlot:1,
    lastExtendedSlotStartIndex:0,addresses:[new Key('original')]}})};
  const expected={quotedFee:'5'} as ReverseExpectation;
  const core={build:()=>({...prepared}),inspectPrepared(){},
    sign:async(_p:unknown,_e:unknown,keys:{payerFile:string},captured:typeof snapshot)=>{
      calls.sign++;calls.key=keys.payerFile;calls.lookup=captured.lookupTable.state.addresses[0]?.toBase58();return sign();
    },
    inspectSigned:()=>inspected};
  // This fake compiler isolates operator custody/lifecycle contracts, not native byte authentication.
  const owner=createReverseSigning({web3:{PublicKey:Key,AddressLookupTableAccount:Lookup}} as unknown as NativeSolanaProvider,
    core as unknown as ReturnType<typeof createReverseTransactionSdk>,()=>{});
  const build=()=>owner.build({} as Parameters<ReturnType<typeof createReverseTransactionSdk>['build']>[0],
    expected,{blockhash:'hash',lastValidBlockHeight:'100'},snapshot as unknown as FinalizedLookup);
  return {owner,calls,snapshot,expected,build};
}
test('private reverse signer rejects acquisition before preparation and mismatched packets before signing',async()=>{
  const f=fixture();
  assert.throws(()=>f.owner.acquireSigner({testOnly:true,payerFile:'/test-key'}),/acquisition/);
  f.build();
  const sign=f.owner.acquireSigner({testOnly:true,payerFile:'/test-key'});
  assert.throws(()=>sign({...prepared,messageBase64:'BA=='},f.expected),/identity/);
  assert.throws(()=>sign(prepared,{...f.expected,quotedFee:'6'}),/identity/);
  assert.equal(f.calls.sign,0);
  assert.deepEqual(await sign(prepared,f.expected),signed);
  assert.equal(f.calls.sign,1);
  assert.throws(()=>sign(prepared,f.expected),/identity/);
  await f.owner.drain();
});
test('private reverse signer preserves copied key reference and finalized lookup despite caller mutation',async()=>{
  const f=fixture();f.build();
  const keys={testOnly:true as const,payerFile:'/original-test-key'};
  const sign=f.owner.acquireSigner(keys);
  keys.payerFile='/replacement-test-key';
  f.snapshot.lookupTable.state.addresses[0]=new Key('replacement');
  await sign(prepared,f.expected);
  assert.equal(f.calls.key,'/original-test-key');assert.equal(f.calls.lookup,'original');
  assert.throws(()=>f.build(),/already prepared/);
  await f.owner.drain();
});
test('reverse signing drain retains outstanding work and refuses late signature acceptance',async()=>{
  let release!:()=>void;
  const pending=new Promise<typeof signed>(resolve=>{release=()=>resolve(signed);});
  const f=fixture(()=>pending);f.build();
  const sign=f.owner.acquireSigner({testOnly:true,payerFile:'/test-key'});
  const work=sign(prepared,f.expected);
  const rejected=assert.rejects(work,/signing failed/);
  let drained=false;const drain=f.owner.drain().then(()=>{drained=true;return null;});
  await turn();assert.equal(drained,false);assert.equal(f.calls.sign,1);
  release();await rejected;await drain;assert.equal(drained,true);
  assert.throws(()=>f.owner.acquireSigner({testOnly:true,payerFile:'/test-key'}),/closing/);
});
test('reverse signed packet comparison rejects callback metadata inconsistent with raw inspection',()=>{
  assert.deepEqual(checkReverseSigned(prepared,signed,inspected),signed);
  for(const changed of [{...signed,signature:'other'},{...signed,blockhash:'other'},{...signed,lastValidBlockHeight:'101'}]){
    assert.throws(()=>checkReverseSigned(prepared,changed,inspected),/does not match/);
  }
  assert.throws(()=>checkReverseSigned(prepared,signed,{...inspected,messageBase64:'BA=='}),/does not match/);
});
