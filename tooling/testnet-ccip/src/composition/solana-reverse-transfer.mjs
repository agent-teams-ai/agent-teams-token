import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSolanaReverseSdk } from '../adapters/solana-reverse-sdk.mjs';
import { createSolanaTransactionRpc } from '../adapters/solana-transaction-rpc.ts';
import { createJournalFile } from '../adapters/evm-journal-file.ts';
import { runSolanaTransactionJournal } from '../application/solana-transaction-journal.ts';
import { reverseContract } from '../domain/solana-reverse.mjs';
const defaults={sdk:createSolanaReverseSdk,store:createJournalFile,rpc:createSolanaTransactionRpc};
/** Existing journal core owns write-before-broadcast and never replaces expired/uncertain sends. */
export async function transferSolanaReverse(settings,ports=defaults) {
  if(settings.testOnly!==true || !settings.journalFile || !/^[1-9][0-9]*$/.test(settings.maxNativeBalanceLamports) ||
    BigInt(settings.maxNativeBalanceLamports)>10000000000n) {throw new Error('Explicit test-only reverse settings and native exposure required');}
  const sdk=await ports.sdk(settings),store=ports.store(resolve(settings.journalFile));
  const expectedFrom=stored=>sdk.derive(stored.linkMint,{approval:stored.approval,quotedFee:stored.quotedFee,sourceLamports:stored.sourceLamports});
  const rpc=ports.rpc((bytes,intent)=>sdk.inspectSigned(bytes,expectedFrom(intent)).messageBase64,
    async()=>({sourceReceiptVerified:true}));
  return store.exclusive(async()=>{
    const prior=await store.read();
    let expected,prepared;
    if(prior){expected=expectedFrom(prior.intent);sdk.validateExpected(expected);}
    else {
      await rpc.chain();
      const link=await sdk.state.config(rpc.readRpc,sdk.pool.routerConfig);
      const base=sdk.derive(link,{});
      const snapshot=await sdk.state.before(rpc.readRpc,base,settings.maxNativeBalanceLamports);
      const generated=await sdk.candidate();
      expected=sdk.derive(link,{approval:snapshot.approval,quotedFee:generated.fee,sourceLamports:snapshot.sourceLamports});
      const again=await sdk.state.before(rpc.readRpc,expected,settings.maxNativeBalanceLamports);
      if(again.approval!==snapshot.approval || again.sourceLamports!==snapshot.sourceLamports){throw new Error('Source changed during reverse preparation');}
      const latest=await rpc.readRpc('getLatestBlockhash',[{commitment:'finalized'}]);
      if(!Number.isSafeInteger(latest?.value?.lastValidBlockHeight)||latest.value.lastValidBlockHeight<1){throw new Error('Invalid reverse block validity');}
      prepared=sdk.build(generated.candidate,expected,{blockhash:latest.value.blockhash,lastValidBlockHeight:String(latest.value.lastValidBlockHeight)});
      const simulation=await rpc.readRpc('simulateTransaction',[prepared.bytesBase64,{encoding:'base64',commitment:'finalized',sigVerify:false,replaceRecentBlockhash:false}]);
      if(!simulation?.value || simulation.value.err!==null){throw new Error('Unsigned reverse preflight simulation failed');}
      await rpc.chain();
    }
    const beforeEffect=async()=>{
      await rpc.chain();
      if(await sdk.state.config(rpc.readRpc,sdk.pool.routerConfig)!==expected.linkMint){throw new Error('Router config changed');}
      const snapshot=await sdk.state.before(rpc.readRpc,expected,settings.maxNativeBalanceLamports);
      if(BigInt(snapshot.sourceLamports)>BigInt(expected.sourceLamports)){throw new Error('Native exposure increased since intent');}
      if(snapshot.approval!==expected.approval){throw new Error('Delegation changed since signed intent');}
    };
    const result=await runSolanaTransactionJournal(expected,{...store,...rpc,exclusive:work=>work(),
      inspectSigned:async bytes=>sdk.inspectSigned(bytes,expected),
      async sign(){
        if(prior||!prepared){throw new Error('Existing reverse journal cannot be replaced');}
        await beforeEffect();
        return sdk.sign(prepared,expected,{testOnly:true,payerFile:settings.payerFile});
      },
      async broadcast(bytes){await beforeEffect();return rpc.broadcast(bytes);},
    },reverseContract(expected));
    return {status:result.status,phase:result.record.phase,reason:result.reason,signature:result.record.signed.signature,
      quotedFee:expected.quotedFee,sourceLamportsAtPreparation:expected.sourceLamports};
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {
    if(process.argv.length!==3){throw new Error('Usage: solana-reverse-transfer.mjs <private-test-settings.json>');}
    console.log(JSON.stringify(await transferSolanaReverse(JSON.parse(await readFile(resolve(process.argv[2]),'utf8')))));
  } catch(error){console.error(error instanceof Error?error.message:'Solana reverse failed');process.exitCode=1;}
}
