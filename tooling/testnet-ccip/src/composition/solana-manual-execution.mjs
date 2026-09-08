import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSolanaManualExecutionSdk } from '../adapters/solana-manual-execution-sdk.mjs';
import { createSolanaTransactionRpc } from '../adapters/solana-transaction-rpc.ts';
import { createJournalFile } from '../adapters/evm-journal-file.ts';
import { runSolanaTransactionJournal } from '../application/solana-transaction-journal.ts';
import { manualExpected, validateManualExpected, manualContract } from '../domain/solana-manual-execution.mjs';
const defaults={sdk:createSolanaManualExecutionSdk,store:createJournalFile,rpc:createSolanaTransactionRpc};
/** Recover only the original message; the shared durable journal never re-signs uncertain/expired bytes. */
export async function executeSolanaManualRecovery(settings,ports=defaults) {
  if(settings.testOnly!==true||!settings.journalFile||!/^[1-9][0-9]*$/.test(settings.maxNativeBalanceLamports)||
    BigInt(settings.maxNativeBalanceLamports)>1000000000n){throw new Error('Explicit test-only manual recovery with at most 1 SOL required');}
  const sdk=await ports.sdk(settings),store=ports.store(resolve(settings.journalFile));
  let signature;
  const fromStored=intent=>manualExpected(intent.lookupTables);
  const rpc=ports.rpc((bytes,intent)=>sdk.inspectSigned(bytes,fromStored(intent)).messageBase64,
    async(readRpc,intent,slot)=>sdk.state.after(readRpc,fromStored(intent),signature,slot));
  try {return await store.exclusive(async()=>{
    const prior=await store.read();let expected,prepared;
    if(prior){expected=fromStored(prior.intent);validateManualExpected(expected);signature=prior.signed.signature;}
    else {
      await rpc.chain();
      const candidate=await sdk.candidate();
      expected=manualExpected(candidate.lookupTables.map(t=>({key:t.key.toBase58(),addresses:t.state.addresses.map(a=>a.toBase58())})));
      await sdk.state.before(rpc.readRpc,expected,settings.maxNativeBalanceLamports);
      const latest=await rpc.readRpc('getLatestBlockhash',[{commitment:'finalized'}]);
      if(!Number.isSafeInteger(latest?.value?.lastValidBlockHeight)||latest.value.lastValidBlockHeight<1){throw new Error('Invalid manual block validity');}
      prepared=sdk.build(candidate,expected,{blockhash:latest.value.blockhash,lastValidBlockHeight:String(latest.value.lastValidBlockHeight)});
      const sim=await rpc.readRpc('simulateTransaction',[prepared.bytesBase64,{encoding:'base64',commitment:'finalized',sigVerify:false,replaceRecentBlockhash:false}]);
      if(!sim?.value||sim.value.err!==null){throw new Error('Unsigned manual execution simulation failed');}
    }
    const beforeEffect=async()=>{await rpc.chain();await sdk.state.before(rpc.readRpc,expected,settings.maxNativeBalanceLamports);};
    const result=await runSolanaTransactionJournal(expected,{...store,...rpc,exclusive:work=>work(),
      inspectSigned:async bytes=>sdk.inspectSigned(bytes,expected),
      async sign(){if(prior||!prepared){throw new Error('Existing manual recovery cannot be replaced');}await beforeEffect();
        const signed=await sdk.sign(prepared,expected,{testOnly:true,payerFile:settings.payerFile});signature=signed.signature;return signed;},
      async broadcast(bytes){await beforeEffect();return rpc.broadcast(bytes);},
    },manualContract());
    return {status:result.status,phase:result.record.phase,reason:result.reason,signature:result.record.signed.signature,messageId:expected.messageId};
  });}finally {await sdk.state.destroy?.();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {if(process.argv.length!==3){throw new Error('Usage: solana-manual-execution.mjs <private-test-settings.json>');}
    console.log(JSON.stringify(await executeSolanaManualRecovery(JSON.parse(await readFile(resolve(process.argv[2]),'utf8')))));
  }catch(error){console.error(error instanceof Error?error.message:'Manual recovery failed');process.exitCode=1;}
}
