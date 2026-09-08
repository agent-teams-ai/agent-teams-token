import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSolanaProvider } from '../src/adapters/solana-transaction-sdk.mjs';
import { createManualTransactionSdk } from '../src/adapters/solana-manual-execution-sdk.mjs';
import { manualExpected, manualInstructions, validateManualDerivedAccounts } from '../src/domain/solana-manual-execution.mjs';
import { unsignedFixture } from './solana-manual-execution-fixture.mjs';
const providerPath=process.env.AGTMAI_TEST_SOLANA_PROVIDER,ccipPath=process.env.AGTMAI_TEST_CCIP_PROVIDER;
test('native v0 fixed manual execution independently derives PDAs and rejects byte/ALT/global privilege/signature changes',
  {skip:!providerPath||!ccipPath},async()=>{
  const provider=await loadSolanaProvider(providerPath),sdk=createManualTransactionSdk(provider);
  assert.equal(validateManualDerivedAccounts(provider).length,26);
  const {PublicKey,TransactionInstruction,AddressLookupTableAccount,VersionedTransaction}=provider.web3;
  const e=manualExpected(unsignedFixture.lookupTables);
  const ix=manualInstructions()[1];
  const candidate={family:'SVM',mainIndex:0,instructions:[new TransactionInstruction({programId:new PublicKey(ix.programId),
    data:Buffer.from(ix.dataBase64,'base64'),keys:ix.accounts.map(a=>({pubkey:new PublicKey(a.address),isWritable:a.isWritable,isSigner:a.isSigner}))})],
    lookupTables:e.lookupTables.map(t=>new AddressLookupTableAccount({key:new PublicKey(t.key),state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,addresses:t.addresses.map(a=>new PublicKey(a))}}))};
  const require=createRequire(resolve(ccipPath,'package.json'));
  const {BorshInstructionCoder,BorshCoder}=require('@coral-xyz/anchor');
  const {IDL}=await import(pathToFileURL(resolve(ccipPath,'node_modules/@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_OFFRAMP.js')).href);
  const decoded=new BorshInstructionCoder(IDL).decode(candidate.instructions[0].data);
  assert.equal(decoded.name,'manuallyExecute');
  const report=new BorshCoder(IDL).types.decode('ExecutionReportSingleChain',decoded.data.rawExecutionReport);
  assert.equal(report.message.header.sequenceNumber.toString(),'11207');assert.equal(report.message.tokenReceiver.toBase58(),e.payer);
  assert.equal(report.message.tokenAmounts.length,1);assert.equal(report.proofs.length,0);assert.equal(report.offchainTokenData.length,1);
  assert.deepEqual(candidate.instructions[0].keys.slice(0,12).map(k=>[k.isWritable,k.isSigner]),IDL.instructions.find(i=>i.name==='manuallyExecute').accounts.map(a=>[a.isMut,a.isSigner]));
  const latest={blockhash:'11111111111111111111111111111111',lastValidBlockHeight:'100'};
  const built=sdk.build(candidate,e,latest),bytes=Buffer.from(built.bytesBase64,'base64');
  assert.equal(bytes.length,821);assert.throws(()=>sdk.inspectSigned(built.bytesBase64,e),/signature/);
  for(const mutate of [t=>t.message.compiledInstructions[1].data[12]^=1,t=>t.message.addressTableLookups[0].writableIndexes[0]^=1,
    t=>t.message.header.numReadonlyUnsignedAccounts^=1,t=>t.message.staticAccountKeys[0]=new PublicKey(e.mint),t=>t.signatures[0][0]=1]){
    const tx=VersionedTransaction.deserialize(bytes);mutate(tx);assert.throws(()=>sdk.inspectSigned(Buffer.from(tx.serialize()).toString('base64'),e));
  }
  assert.throws(()=>sdk.build({...candidate,instructions:[...candidate.instructions,...candidate.instructions]},e,latest));
  candidate.instructions[0].keys[12].isWritable=true;assert.throws(()=>sdk.build(candidate,e,latest),/privilege/);
});
