import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSolanaProvider } from './solana-transaction-sdk.mjs';
import { createSolanaPoolConfigSdk } from './solana-pool-config-sdk.mjs';
import { createSolanaPoolInitSdk } from './solana-pool-init-sdk.mjs';
import { createReverseState } from './solana-reverse-state.mjs';
import { REVERSE, deriveReverseAccounts, reverseInstructions, verifyReverseIntent } from '../domain/solana-reverse.mjs';
import { ROUTER_PROGRAM } from '../domain/solana-registration.ts';
import { altAddresses, SEPOLIA_SELECTOR } from '../domain/solana-pool-config.ts';
import { SOLANA_REMOTE } from '../domain/evm-remote-config.ts';
const normalized = ix => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map(k => ({ address:k.pubkey.toBase58(),isWritable:k.isWritable,isSigner:k.isSigner })), dataBase64:Buffer.from(ix.data).toString('base64') });
export function createReverseTransactionSdk(provider, validateExpected) {
  const { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount, Keypair } = provider.web3;

  const native = ix => new TransactionInstruction({programId:new PublicKey(ix.programId),data:Buffer.from(ix.dataBase64,'base64'),
    keys:ix.accounts.map(a=>({pubkey:new PublicKey(a.address),isWritable:a.isWritable,isSigner:a.isSigner}))});
  function table(e) {
    return new AddressLookupTableAccount({key:new PublicKey(e.alt),state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:0,
      lastExtendedSlotStartIndex:0,authority:new PublicKey(e.payer),addresses:altAddresses(e).map(a=>new PublicKey(a))}});
  }
  function message(e,blockhash) {
    validateExpected(e);
    return new TransactionMessage({payerKey:new PublicKey(e.payer),recentBlockhash:blockhash,
      instructions:reverseInstructions(e).map(native)}).compileToV0Message([table(e)]);
  }
  function decode(tx,e) {
    if (tx.version !== 0 || tx.signatures.length !== 1 || tx.message.header.numRequiredSignatures !== 1 ||
      tx.message.staticAccountKeys[0].toBase58() !== e.payer ||
      !Buffer.from(tx.message.serialize()).equals(Buffer.from(message(e,tx.message.recentBlockhash).serialize()))) {
      throw new Error('Unexpected v0 signer, instructions, ALT lookup indexes or global privileges');
    }
    // Exact recompiled bytes prove both ordered instruction data and global privilege union.
    const intent = {feePayer:e.payer,instructions:reverseInstructions(e)};
    return {intent,messageBase64:Buffer.from(tx.message.serialize()).toString('base64'),blockhash:tx.message.recentBlockhash};
  }
  function build(candidate,e,latest) {
    validateExpected(e);
    if (candidate.family !== 'SVM' || candidate.mainIndex !== Number(e.approval) || candidate.instructions.length !== 1+Number(e.approval) ||
      candidate.lookupTables.length !== 1 || candidate.lookupTables[0].key.toBase58() !== e.alt ||
      JSON.stringify(candidate.lookupTables[0].state.addresses.map(a=>a.toBase58())) !== JSON.stringify(altAddresses(e))) {
      throw new Error('Wrong SDK instruction list or ALT');
    }
    verifyReverseIntent({feePayer:e.payer,instructions:candidate.instructions.map(normalized)},e);
    if (!/^[1-9][0-9]*$/.test(latest.lastValidBlockHeight) || new PublicKey(latest.blockhash).toBase58() !== latest.blockhash) { throw new Error('Invalid block validity'); }
    const tx = new VersionedTransaction(message(e,latest.blockhash));
    const bytes = Buffer.from(tx.serialize());
    if (bytes.length > 1232) { throw new Error('Reverse v0 transaction exceeds packet limit'); }
    return {...latest,bytesBase64:bytes.toString('base64'),...decode(tx,e)};
  }
  function inspectSigned(bytesBase64,e) {
    const bytes=Buffer.from(bytesBase64,'base64');
    if (bytes.length>1232 || bytes.toString('base64')!==bytesBase64) {throw new Error('Invalid reverse signed encoding');}
    const tx=VersionedTransaction.deserialize(bytes), inspected=decode(tx,e);
    if (!Buffer.from(tx.serialize()).equals(bytes)) {throw new Error('Noncanonical signed transaction');}
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(e.payer).toBuffer()]),format:'der',type:'spki'});
    if (!verifySignature(null,tx.message.serialize(),key,tx.signatures[0])) {throw new Error('Invalid native Ed25519 signature');}
    return {...inspected,signature:provider.bs58.encode(tx.signatures[0])};
  }
  async function sign(prepared,e,keys) {
    if(keys.testOnly!==true) {throw new Error('Test-only reverse signer required');}
    let secret,payer;
    try {
      const raw=JSON.parse(await readFile(keys.payerFile,'utf8'));
      if(!Array.isArray(raw)||raw.length!==64||raw.some(n=>!Number.isInteger(n)||n<0||n>255)){throw new Error('Invalid key');}
      secret=Uint8Array.from(raw);raw.fill(0);payer=Keypair.fromSecretKey(secret);
      if(payer.publicKey.toBase58()!==e.payer){throw new Error('Wrong test payer');}
      const tx=VersionedTransaction.deserialize(Buffer.from(prepared.bytesBase64,'base64'));
      const decoded=decode(tx,e);
      if(decoded.blockhash!==prepared.blockhash || decoded.messageBase64!==prepared.messageBase64){throw new Error('Prepared message mismatch');}
      tx.sign([payer]);
      const bytesBase64=Buffer.from(tx.serialize()).toString('base64'),inspected=inspectSigned(bytesBase64,e);
      return {bytesBase64,signature:inspected.signature,blockhash:inspected.blockhash,lastValidBlockHeight:prepared.lastValidBlockHeight};
    } catch {throw new Error('Test-only reverse signing failed');}
    finally {secret?.fill(0);payer?.secretKey.fill(0);}
  }
  return {build,inspectSigned,sign};
}
export async function createSolanaReverseSdk(settings) {
  const provider=await loadSolanaProvider(settings.providerDirectory);
  const poolConfig=await createSolanaPoolConfigSdk(settings.providerDirectory),poolSdk=await createSolanaPoolInitSdk(settings.providerDirectory);
  const root=resolve(settings.ccipProviderDirectory);
  for(const [file,hash] of Object.entries({'package.json':'8cf7da517123c8be46f0a5fa14ef67904bf45bf4cfb972fc2c54be4b91cb56fb',
    'package-lock.json':'1477c1d04940f9556ff87eaf82de6f0f2eaa6f3585deea0f09bfdab8fba7f50f'})) {
    if(createHash('sha256').update(await readFile(resolve(root,file))).digest('hex')!==hash){throw new Error('Wrong CCIP provider pin');}
  }
  const require=createRequire(resolve(root,'package.json')),sdk=await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk')).href);
  const pool=poolConfig.derive({testOnly:true,cluster:'solana-devnet',payer:REVERSE.payer,mint:REVERSE.mint,
    pool:new provider.web3.PublicKey(Buffer.from(SOLANA_REMOTE.pool.slice(2),'hex')).toBase58(),operation:'set-pool',recentSlot:settings.recentSlot});
  const state=createReverseState(provider,poolSdk);
  function derive(linkMint,dynamic) {return {...deriveReverseAccounts(provider,pool,linkMint),...dynamic};}
  function validateExpected(e) {
    const canonical=derive(e.linkMint,{approval:e.approval,quotedFee:e.quotedFee,sourceLamports:e.sourceLamports});
    if(JSON.stringify(e)!==JSON.stringify(canonical)){throw new Error('Wrong reverse derived identity');}
    reverseInstructions(e);
  }
  const transaction=createReverseTransactionSdk(provider,validateExpected);
  return {...transaction,state,pool,derive,validateExpected,
    async candidate(e) {
      const chain=await sdk.SolanaChain.fromUrl('https://api.devnet.solana.com');
      try {
        const opts={sender:REVERSE.payer,router:ROUTER_PROGRAM,destChainSelector:BigInt(SEPOLIA_SELECTOR),approveMax:false,
          message:{receiver:REVERSE.recipient,data:'0x',tokenAmounts:[{token:REVERSE.mint,amount:REVERSE.amount}],
            feeToken:'11111111111111111111111111111111',extraArgs:{gasLimit:0n,allowOutOfOrderExecution:true}}};
        const fee=await chain.getFee(opts);
        if(typeof fee!=='bigint'||fee<=0n||fee>100000000n){throw new Error('Native quote outside test range');}
        return {fee:fee.toString(),candidate:await chain.generateUnsignedSendMessage({...opts,message:{...opts.message,fee}}),...e};
      } finally {await chain.destroy();}
    },
  };
}
