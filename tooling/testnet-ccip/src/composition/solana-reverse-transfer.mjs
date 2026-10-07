// @ts-check
import { openReverseSdk, finishReverseSdk } from './solana-reverse-operator.ts';
import { capturePrepared, captureSigned } from '../adapters/solana-setup-operator.ts';
import { checkReverseSigned } from '../adapters/solana-reverse-operator.ts';
import { freezeSetupExpected, latestSetupBlock, setupObject } from './solana-setup-operator.ts';
import { selectTestSdk } from '../adapters/test-sdk-policy.ts';
import { selectedFixture } from '../domain/replacement-fixture.ts';
import { bindFixture } from '../adapters/fixture-binding.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSolanaTransactionRpc } from '../adapters/solana-transaction-rpc.ts';
import { createJournalFile } from '../adapters/evm-journal-file.ts';
import { runSolanaTransactionJournal } from '../application/solana-transaction-journal.ts';
import { reverseContract } from '../domain/solana-reverse.mjs';
/** @type {typeof createJournalFile<import('./solana-reverse-operator.ts').ReverseRecord>} */
const reverseJournalFile=createJournalFile;
/** @type {import('./solana-reverse-operator.ts').ReversePorts} */
const defaults={sdk:openReverseSdk,store:reverseJournalFile,rpc:createSolanaTransactionRpc};
/** Existing journal core owns write-before-broadcast and never replaces expired/uncertain sends.
 * @param {import('./solana-reverse-operator.ts').ReverseTransferSettings} settings
 * @param {import('./solana-reverse-operator.ts').ReversePorts} [ports]
 */
export async function transferSolanaReverse(settings,ports=defaults) {
  if(settings.testOnly!==true || !settings.journalFile || !/^[1-9][0-9]*$/.test(settings.maxNativeBalanceLamports) ||
    BigInt(settings.maxNativeBalanceLamports)>10000000000n) {throw new Error('Explicit test-only reverse settings and native exposure required');}
  const selected=selectTestSdk(settings,settings.providerDirectory ?? '',selectedFixture(settings));
  if(selected && typeof settings.replayFetch!=='function'){throw new Error('TEST reverse requires injected unsigned transport');}
  bindFixture(settings, [settings.journalFile]);
  const sdk=await ports.sdk(settings);
  let operationFailed=false;
  /** @type {unknown} */ let operationError;
  try {
  if(selected && ('sign' in sdk || !('destroy' in sdk))){throw new Error('Unsigned TEST reverse view required');}
  const store=ports.store(resolve(settings.journalFile));
  /** @type {import('../adapters/solana-reverse-sdk.mjs').FinalizedLookup | undefined} */
  let finalizedLookup;
  /** @param {import('./solana-reverse-operator.ts').ReverseEnvelope} stored */
  const expectedFrom=stored=>freezeSetupExpected(sdk.derive(stored.linkMint,{approval:stored.approval,quotedFee:stored.quotedFee,sourceLamports:stored.sourceLamports}));
  const rpc=ports.rpc((bytes,intent)=>{
    if(!finalizedLookup){throw new Error('Finalized reverse lookup required');}
    return sdk.inspectSigned(bytes,expectedFrom(intent),finalizedLookup).messageBase64;
  },
    async()=>({sourceReceiptVerified:true}));
  /** @param {string} method @param {readonly unknown[]} params */
  const readRpc=(method,params)=>rpc.readRpc(method,[...params]);
  return await store.exclusive(async()=>{
    const prior=await store.read();
    const signPrepared=selected && !prior ? ports.signPrepared : undefined;
    /** @type {import('../adapters/solana-reverse-sdk.mjs').ReverseExpectation} */ let expected;
    /** @type {import('../adapters/solana-transaction-sdk.mjs').PreparedTransaction | undefined} */ let prepared;
    if(prior){expected=expectedFrom(prior.intent);sdk.validateExpected(expected);}
    else {
      if(selected && typeof signPrepared!=='function'){throw new Error('Trusted TEST reverse signer required for new operation');}
      await rpc.chain();
      const link=await sdk.state.config(readRpc,sdk.pool.routerConfig);
      // Initial account derivation only; finalized state and the actual candidate supply signing facts.
      const base=sdk.derive(link,{approval:false,quotedFee:'1',sourceLamports:settings.maxNativeBalanceLamports});
      const snapshot=await sdk.state.before(readRpc,base,settings.maxNativeBalanceLamports);
      const generated=await sdk.candidate();
      expected=freezeSetupExpected(sdk.derive(link,{approval:snapshot.approval,quotedFee:generated.fee,sourceLamports:snapshot.sourceLamports}));
      const again=await sdk.state.before(readRpc,expected,settings.maxNativeBalanceLamports);
      if(again.approval!==snapshot.approval || again.sourceLamports!==snapshot.sourceLamports){throw new Error('Source changed during reverse preparation');}
      const latest=latestSetupBlock(await rpc.readRpc('getLatestBlockhash',[{commitment:'finalized'}]));
      finalizedLookup=again;
      const built=sdk.build(generated.candidate,expected,latest,again);
      prepared=selected ? capturePrepared(built) : built;
      const simulation=setupObject(setupObject(await rpc.readRpc('simulateTransaction',[prepared.bytesBase64,{encoding:'base64',commitment:'finalized',sigVerify:false,replaceRecentBlockhash:false}])).value);
      if(simulation.err!==null){throw new Error('Unsigned reverse preflight simulation failed');}
      await rpc.chain();
    }
    const beforeEffect=async()=>{
      await rpc.chain();
      if(await sdk.state.config(readRpc,sdk.pool.routerConfig)!==expected.linkMint){throw new Error('Router config changed');}
      const snapshot=await sdk.state.before(readRpc,expected,settings.maxNativeBalanceLamports);
      if(BigInt(snapshot.sourceLamports)>BigInt(expected.sourceLamports)){throw new Error('Native exposure increased since intent');}
      if(snapshot.approval!==expected.approval){throw new Error('Delegation changed since signed intent');}
      finalizedLookup=snapshot;
      return snapshot;
    };
    const result=await runSolanaTransactionJournal(expected,{...store,...rpc,exclusive:work=>work(),
      inspectSigned:async bytes=>{
        finalizedLookup=await sdk.state.lookup(readRpc,expected);
        return sdk.inspectSigned(bytes,expected,finalizedLookup);
      },
      async sign(){
        if(prior||!prepared){throw new Error('Existing reverse journal cannot be replaced');}
        const original=selected ? capturePrepared(prepared) : prepared;
        const snapshot=await beforeEffect();
        if(selected){
          if(!signPrepared){throw new Error('Trusted TEST reverse signer required for new operation');}
          let signed;
          try { signed=captureSigned(await signPrepared(original,expected)); }
          catch { throw new Error('TEST reverse signing failed'); }
          return checkReverseSigned(original,signed,sdk.inspectSigned(signed.bytesBase64,expected,snapshot));
        }
        if(!('sign' in sdk)){throw new Error('Legacy reverse signer unavailable');}
        return sdk.sign(original,expected,{testOnly:true,payerFile:settings.payerFile ?? ''},snapshot);
      },
      async broadcast(bytes){await beforeEffect();return rpc.broadcast(bytes);},
    },reverseContract(expected));
    return {status:result.status,phase:result.record.phase,reason:result.reason,signature:result.record.signed.signature,
      quotedFee:expected.quotedFee,sourceLamportsAtPreparation:expected.sourceLamports};
  });
  } catch(error){operationFailed=true;operationError=error;throw error;}
  finally {await finishReverseSdk(sdk,operationFailed,operationError);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {
    const settingsFile=process.argv[2];
    if(process.argv.length!==3||!settingsFile){throw new Error('Usage: solana-reverse-transfer.mjs <private-test-settings.json>');}
    console.log(JSON.stringify(await transferSolanaReverse(JSON.parse(await readFile(resolve(settingsFile),'utf8')))));
  } catch(error){console.error(error instanceof Error?error.message:'Solana reverse failed');process.exitCode=1;}
}
