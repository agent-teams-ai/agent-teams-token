import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createSolanaReverseSdk } from '../src/adapters/solana-reverse-sdk.mjs';
import { reverseInstructions } from '../src/domain/solana-reverse.mjs';
import { altAddresses } from '../src/domain/solana-pool-config.ts';
const provider=process.env.AGTMAI_TEST_SOLANA_PROVIDER,ccip=process.env.AGTMAI_TEST_CCIP_PROVIDER;
test('pinned native provider v0 rejects hidden instructions, lookup substitution, signer changes and invalid signatures',{skip:!provider||!ccip},async()=>{
  const sdk=await createSolanaReverseSdk({providerDirectory:provider,ccipProviderDirectory:ccip,recentSlot:'1'});
  const require=createRequire(resolve(provider,'package.json'));
  const {PublicKey,TransactionInstruction,VersionedTransaction,AddressLookupTableAccount}=require('@solana/web3.js');
  const expected=sdk.derive('So11111111111111111111111111111111111111112',{approval:true,quotedFee:'5',sourceLamports:'1000000'});
  const native=ix=>new TransactionInstruction({programId:new PublicKey(ix.programId),data:Buffer.from(ix.dataBase64,'base64'),
    keys:ix.accounts.map(a=>({pubkey:new PublicKey(a.address),isSigner:a.isSigner,isWritable:a.isWritable}))});
  const candidate={family:'SVM',mainIndex:1,instructions:reverseInstructions(expected).map(native),
    lookupTables:[new AddressLookupTableAccount({key:new PublicKey(expected.alt),state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:0,
      lastExtendedSlotStartIndex:0,authority:new PublicKey(expected.payer),addresses:altAddresses(expected).map(a=>new PublicKey(a))}})]};
  const ccipRequire=createRequire(resolve(ccip,'package.json'));
  const {BorshInstructionCoder}=ccipRequire('@coral-xyz/anchor'), BN=ccipRequire('bn.js');
  const official=await import(pathToFileURL(ccipRequire.resolve('@chainlink/ccip-sdk')).href);
  const {IDL}=await import(pathToFileURL(resolve(ccip,'node_modules/@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js')).href);
  const officialData=new BorshInstructionCoder(IDL).encode('ccipSend',{destChainSelector:new BN('16015286601757825753'),
    message:{receiver:Buffer.from('275ee728c49100b56d4aa37c00e2dc8ffc5e5df6','hex'),data:Buffer.alloc(0),
      tokenAmounts:[{token:new PublicKey(expected.mint),amount:new BN('1000000000')}],feeToken:new PublicKey('11111111111111111111111111111111'),
      extraArgs:Buffer.from(official.SolanaChain.encodeExtraArgs({gasLimit:0n,allowOutOfOrderExecution:true}).slice(2),'hex')},tokenIndexes:Buffer.from([0])});
  assert.deepEqual(candidate.instructions[1].data,officialData,'Independent Borsh bytes must match pinned official SDK/IDL');
  assert.deepEqual(candidate.instructions[1].keys.slice(0,18).map(k=>[k.isWritable,k.isSigner]),
    IDL.instructions.find(ix=>ix.name==='ccipSend').accounts.map(a=>[a.isMut,a.isSigner]));
  const latest={blockhash:'11111111111111111111111111111111',lastValidBlockHeight:'100'};
  const built=sdk.build(candidate,expected,latest),bytes=Buffer.from(built.bytesBase64,'base64');
  assert.ok(bytes.length<=1232);assert.throws(()=>sdk.inspectSigned(built.bytesBase64,expected),/signature/);
  // Opt-in root-owned TEST identity only. Fixed expired validity, no RPC or broadcast in this test.
  if(process.env.AGTMAI_TEST_SOLANA_PAYER_FILE){
    const signed=await sdk.sign(built,expected,{testOnly:true,payerFile:process.env.AGTMAI_TEST_SOLANA_PAYER_FILE});
    const inspected=sdk.inspectSigned(signed.bytesBase64,expected);
    assert.equal(inspected.signature,signed.signature);assert.equal(inspected.messageBase64,built.messageBase64);
    const corrupted=Buffer.from(signed.bytesBase64,'base64');corrupted[1]^=1;
    assert.throws(()=>sdk.inspectSigned(corrupted.toString('base64'),expected),/signature/);
  }

  for(const mutate of [tx=>tx.message.compiledInstructions[1].data[0]^=1,
    tx=>tx.message.addressTableLookups[0].writableIndexes[0]^=1,
    tx=>tx.message.header.numRequiredSignatures=2,
    tx=>tx.message.staticAccountKeys[0]=new PublicKey(expected.mint)]){
    const tx=VersionedTransaction.deserialize(bytes);mutate(tx);
    assert.throws(()=>sdk.inspectSigned(Buffer.from(tx.serialize()).toString('base64'),expected));
  }
  const changed=[...candidate.instructions,candidate.instructions[0]];
  assert.throws(()=>sdk.build({...candidate,instructions:changed},expected,latest),/instruction list/);
  candidate.lookupTables[0].state.addresses[2]=new PublicKey(expected.payer);
  assert.throws(()=>sdk.build(candidate,expected,latest),/ALT/);
  assert.throws(()=>sdk.validateExpected({...expected,spender:expected.payer}),/derived identity/);
});
