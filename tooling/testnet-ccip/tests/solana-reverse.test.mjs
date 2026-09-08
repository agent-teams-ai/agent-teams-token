import assert from 'node:assert/strict';
import test from 'node:test';
import { REVERSE, reverseInstructions, verifyReverseIntent } from '../src/domain/solana-reverse.mjs';
import { transferSolanaReverse } from '../src/composition/solana-reverse-transfer.mjs';
const address=REVERSE.payer;
const expected={testOnly:true,cluster:'solana-devnet',payer:REVERSE.payer,mint:REVERSE.mint,
  ...Object.fromEntries(['pool','chain','signer','ata','registry','routerConfig','feeTokenConfig','routerPoolSigner','alt','sourceAta',
    'destChain','nonce','feeReceiver','spender','feeConfig','feeDest','nativeFeeConfig','linkFeeConfig','curses','rmnConfig','perTokenConfig','linkMint'].map(k=>[k,address])),
  approval:true,quotedFee:'5',sourceLamports:'1000000'};
test('fixed reverse payload includes bounded approve + 31 accounts; rejects instruction/privilege mutations',()=>{
  const instructions=reverseInstructions(expected);
  assert.equal(instructions.length,2);assert.equal(instructions[1].accounts.length,31);
  assert.equal(Buffer.from(instructions[0].dataBase64,'base64').readBigUInt64LE(1),1000000000n);
  verifyReverseIntent({feePayer:REVERSE.payer,instructions},expected);
  for(const mutate of [ix=>ix.push(ix[0]),ix=>ix[0].accounts[1].address=REVERSE.mint,
    ix=>ix[1].accounts[30].isWritable=true,ix=>ix[1].accounts[17].isSigner=true,
    ix=>ix[1].dataBase64=Buffer.from('hidden transfer').toString('base64')]){
    const changed=structuredClone(instructions);mutate(changed);
    assert.throws(()=>verifyReverseIntent({feePayer:REVERSE.payer,instructions:changed},expected));
  }
  assert.throws(()=>reverseInstructions({...expected,quotedFee:'100000001'}));
});
const settings={testOnly:true,journalFile:'/tmp/test-only-reverse/journal.json',maxNativeBalanceLamports:'1000000'};
function fixture(){
  let record=null,broadcasts=0,candidates=0,checks=0;
  const signed={bytesBase64:'AQID',signature:'1'.repeat(88),blockhash:'1'.repeat(32),lastValidBlockHeight:'100'};
  const sdk={pool:{routerConfig:address},derive:(_link,dynamic)=>({...expected,...dynamic}),validateExpected:()=>{},
    state:{config:async()=>address,before:async()=>{checks++;return {approval:true,sourceLamports:'1000000'};}},
    candidate:async()=>{candidates++;return {fee:'5',candidate:{}};},build:()=>({bytesBase64:'AQID'}),sign:async()=>signed,
    inspectSigned:()=>({signature:signed.signature,blockhash:signed.blockhash,messageBase64:'BAUG',intent:{feePayer:REVERSE.payer,instructions:reverseInstructions(expected)}})};
  const rpc={chain:async()=>{},readRpc:async method=>method==='getLatestBlockhash'?{value:{blockhash:signed.blockhash,lastValidBlockHeight:100}}:{value:{err:null}},
    observe:async()=>({kind:'not-found'}),broadcast:async()=>{broadcasts++;throw new Error('uncertain');}};
  const store={exclusive:work=>work(),read:async()=>record,write:async r=>{record=r;}};
  return {sdk,rpc,ports:{sdk:async()=>sdk,store:()=>store,rpc:()=>rpc},counts:()=>({broadcasts,candidates,checks}),record:()=>record};
}
test('uncertain native send resumes signed identity without preparing, checking progressed balances or resending',async()=>{
  const f=fixture();
  const first=await transferSolanaReverse(settings,f.ports);
  assert.equal(first.reason,'broadcast-outcome-unknown');assert.equal(f.record().phase,'submitting');
  const before=f.counts();
  f.sdk.state.before=f.sdk.candidate=async()=>{throw new Error('must not regenerate');};
  const next=await transferSolanaReverse(settings,f.ports);
  assert.equal(next.signature,first.signature);assert.equal(next.reason,'submission-unresolved-or-expired');
  assert.deepEqual(f.counts(),before);
});
test('finalized source receipt is source-only success; no destination claim',async()=>{
  const f=fixture();await transferSolanaReverse(settings,f.ports);
  f.rpc.observe=async()=>({kind:'finalized',signature:f.record().signed.signature,messageBase64:'BAUG',slot:'99',err:null,state:{sourceReceiptVerified:true}});
  const result=await transferSolanaReverse(settings,f.ports);
  assert.equal(result.status,'succeeded');assert.equal(result.reason,'finalized-source-receipt-only');
});
