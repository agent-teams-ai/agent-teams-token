import { MANUAL, manualInput, manualInstructions, validateManualAlts, validateManualExpected, validateManualDerivedAccounts } from '../domain/solana-manual-execution.mjs';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSolanaProvider } from './solana-transaction-sdk.mjs';
const normalized = ix => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map(k => ({ address:k.pubkey.toBase58(),isWritable:k.isWritable,isSigner:k.isSigner })), dataBase64:Buffer.from(ix.data).toString('base64') });
export function createManualTransactionSdk(provider) {
  validateManualDerivedAccounts(provider);
  const validateExpected = validateManualExpected;
  const { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount, Keypair } = provider.web3;

  const native = ix => new TransactionInstruction({programId:new PublicKey(ix.programId),data:Buffer.from(ix.dataBase64,'base64'),
    keys:ix.accounts.map(a=>({pubkey:new PublicKey(a.address),isWritable:a.isWritable,isSigner:a.isSigner}))});
  function tables(e) {
    return e.lookupTables.map(t=>new AddressLookupTableAccount({key:new PublicKey(t.key),state:{deactivationSlot:(1n<<64n)-1n,
      lastExtendedSlot:0,lastExtendedSlotStartIndex:0,addresses:t.addresses.map(a=>new PublicKey(a))}}));
  }
  function message(e,blockhash) {
    validateExpected(e);
    return new TransactionMessage({payerKey:new PublicKey(e.payer),recentBlockhash:blockhash,
      instructions:manualInstructions().map(native)}).compileToV0Message(tables(e));
  }
  function decode(tx,e) {
    if (tx.version !== 0 || tx.signatures.length !== 1 || tx.message.header.numRequiredSignatures !== 1 ||
      tx.message.staticAccountKeys[0].toBase58() !== e.payer ||
      !Buffer.from(tx.message.serialize()).equals(Buffer.from(message(e,tx.message.recentBlockhash).serialize()))) {
      throw new Error('Unexpected v0 signer, instructions, ALT lookup indexes or global privileges');
    }
    // Exact recompiled bytes prove both ordered instruction data and global privilege union.
    const intent = {feePayer:e.payer,instructions:manualInstructions()};
    return {intent,messageBase64:Buffer.from(tx.message.serialize()).toString('base64'),blockhash:tx.message.recentBlockhash};
  }
  function build(candidate,e,latest) {
    validateExpected(e);
    if (candidate.family !== 'SVM' || candidate.mainIndex !== 0 || candidate.instructions.length !== 1) {
      throw new Error('Only one SDK manuallyExecute instruction allowed');
    }
    const alts=candidate.lookupTables.map(t=>({key:t.key.toBase58(),addresses:t.state.addresses.map(a=>a.toBase58())}));
    validateManualAlts(alts);
    if(JSON.stringify(alts)!==JSON.stringify(e.lookupTables)||JSON.stringify(normalized(candidate.instructions[0]))!==JSON.stringify(manualInstructions()[1])) {
      throw new Error('Manual candidate instruction/report/account/privilege changed');
    }
    if (!/^[1-9][0-9]*$/.test(latest.lastValidBlockHeight) || new PublicKey(latest.blockhash).toBase58() !== latest.blockhash) { throw new Error('Invalid block validity'); }
    const tx = new VersionedTransaction(message(e,latest.blockhash));
    const bytes = Buffer.from(tx.serialize());
    if (bytes.length > 1232) { throw new Error('Manual v0 transaction exceeds packet limit'); }
    return {...latest,bytesBase64:bytes.toString('base64'),...decode(tx,e)};
  }
  function inspectSigned(bytesBase64,e) {
    const bytes=Buffer.from(bytesBase64,'base64');
    if (bytes.length>1232 || bytes.toString('base64')!==bytesBase64) {throw new Error('Invalid manual recovery signed encoding');}
    const tx=VersionedTransaction.deserialize(bytes), inspected=decode(tx,e);
    if (!Buffer.from(tx.serialize()).equals(bytes)) {throw new Error('Noncanonical signed transaction');}
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(e.payer).toBuffer()]),format:'der',type:'spki'});
    if (!verifySignature(null,tx.message.serialize(),key,tx.signatures[0])) {throw new Error('Invalid native Ed25519 signature');}
    return {...inspected,signature:provider.bs58.encode(tx.signatures[0])};
  }
  async function sign(prepared,e,keys) {
    if(keys.testOnly!==true) {throw new Error('Test-only manual recovery signer required');}
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
    } catch {throw new Error('Test-only manual recovery signing failed');}
    finally {secret?.fill(0);payer?.secretKey.fill(0);}
  }
  return {build,inspectSigned,sign};
}
export async function createSolanaManualExecutionSdk(settings) {
  const provider=await loadSolanaProvider(settings.providerDirectory);
  const root=resolve(settings.ccipProviderDirectory);
  for(const [file,hash] of Object.entries({'package.json':'8cf7da517123c8be46f0a5fa14ef67904bf45bf4cfb972fc2c54be4b91cb56fb',
    'package-lock.json':'1477c1d04940f9556ff87eaf82de6f0f2eaa6f3585deea0f09bfdab8fba7f50f'})) {
    if(createHash('sha256').update(await readFile(resolve(root,file))).digest('hex')!==hash){throw new Error('Wrong CCIP provider pin');}
  }
  const require=createRequire(resolve(root,'package.json')),sdk=await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk')).href);
  const {createManualExecutionState}=await import('./solana-manual-execution-state.mjs');
  const state=await createManualExecutionState({...settings,sdkDirectory:root},provider);
  return {...createManualTransactionSdk(provider),state,
    async candidate() {
      const chain=await sdk.SolanaChain.fromUrl('https://api.devnet.solana.com');
      try {return await chain.generateUnsignedExecute({offRamp:MANUAL.offRamp,input:manualInput(),payer:MANUAL.payer});}
      finally {await chain.destroy();}
    }};
}
