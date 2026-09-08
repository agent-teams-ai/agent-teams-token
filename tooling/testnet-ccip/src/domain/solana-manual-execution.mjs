import { createHash } from 'node:crypto';
import { solanaPublicKeyBytes } from './solana-mint.ts';
import { u64 } from './solana-pool-config.ts';
// Single recovery identity from the original finalized Sepolia send, not a general execution API.
export const MANUAL = Object.freeze({ sourceTransaction:'0x9d2e2a7503c12a08c5e57317470fdc7ed8f1f82575c9c695de58c6cc36ea50fa',
  messageId:'0x9aa9c02072640c7926c740f15282c004f8748789c94462d2cc84338458a60dd4',
  payer:'8T13W72sSEKmBpEv1FpUM7nJRatnChEfPSjkbSpdUn9t', mint:'13Q74er9thh3my9oACjChDhtn4znJibWBp1u8q1rAYau',
  offRamp:'offqSMQWgQud6WJz694LRzkeN5kMYpCHTpXQr3Rkcjm',
  merkleRoot:'0x4a5c6abf7f0c6aafef36bf93dfeb158d5741559a7c52190af404906fd525db4e', computeUnits:300000 });
const fixedInput = {
  "offRamp": "offqSMQWgQud6WJz694LRzkeN5kMYpCHTpXQr3Rkcjm",
  "sourceChainSelector": "16015286601757825753",
  "destChainSelector": "16423721717087811551",
  "onRamp": "0x23a5084Fa78104F3DF11C63Ae59fcac4f6AD9DeE",
  "version": "1.6.0",
  "message": {
    "data": "",
    "sender": "0x275eE728C49100b56D4AA37C00E2Dc8FfC5E5dF6",
    "accounts": [],
    "feeToken": "0x097D90c9d3E0B50Ca60e1ae45F6A81010f9FB534",
    "receiver": "11111111111111111111111111111111",
    "extraArgs": "0x1f3b3aba00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000016eaaf552a9efeb6a6c55e36685f0089ed638a940f7e5b2b7709e434614a1c66f00000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000",
    "computeUnits": "0",
    "tokenAmounts": [
      {
        "amount": "1000000000",
        "extraData": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAk=",
        "destExecData": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACSfA=",
        "destTokenAddress": "13Q74er9thh3my9oACjChDhtn4znJibWBp1u8q1rAYau",
        "sourcePoolAddress": "0x24508e2EB3BeDC086318abc054153Fd83823A4e2",
        "sourceTokenAddress": "0xBEe91Ba3CA94Dd7c639Ee6C1B1C2fc1a1996CDc9",
        "destGasAmount": "150000"
      }
    ],
    "feeValueJuels": "46917346636602680",
    "tokenReceiver": "8T13W72sSEKmBpEv1FpUM7nJRatnChEfPSjkbSpdUn9t",
    "feeTokenAmount": "240030429000119",
    "accountIsWritableBitmap": "0",
    "allowOutOfOrderExecution": true,
    "nonce": "0",
    "messageId": "0x9aa9c02072640c7926c740f15282c004f8748789c94462d2cc84338458a60dd4",
    "sequenceNumber": "11207",
    "destChainSelector": "16423721717087811551",
    "sourceChainSelector": "16015286601757825753"
  },
  "offchainTokenData": [
    null
  ],
  "proofs": [],
  "proofFlagBits": "0",
  "merkleRoot": "0x4a5c6abf7f0c6aafef36bf93dfeb158d5741559a7c52190af404906fd525db4e"
};
const fixedAccounts = [
  {
    "address": "G88p8xbxwG6D5ZRbx7S31sdPPYR2UnRs1PhhE5iAL1ny",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "A4qQENKi1unhuDYL5ANPQKnGoNjFhNcvWaMoCH6iMd51",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "GSuurZ1QaGP2FhKacDHM8yJmSEZYFEs18ViprxvvQQG7",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "8dzm6AmzoSNYdM2MkgMRFDdhZuv82c6izM9JcGij12QJ",
    "isWritable": true,
    "isSigner": false
  },
  {
    "address": "offqSMQWgQud6WJz694LRzkeN5kMYpCHTpXQr3Rkcjm",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "3esbiuy48XCGL2L2q5UzKfAhHe7DqEFHXv6GzzPwWfW4",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "8T13W72sSEKmBpEv1FpUM7nJRatnChEfPSjkbSpdUn9t",
    "isWritable": true,
    "isSigner": true
  },
  {
    "address": "11111111111111111111111111111111",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "Sysvar1nstructions1111111111111111111111111",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "CpbeEvmTR4UE8CgDDL5b1nqjSz7JCD4wNJhxPLZRkSL1",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "GbQFCDTPbhwPjeUvhu7hXEM3Wm2S6t3FCxoCmQtKxetw",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "8qxTjifGv98vHhaUDdunUEquZHekHdQ2N8KwfzhxMR96",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "BDW4fQh6QGDnTbZATEjTCcu1PQaKvKSE5GzmQTGe9Kvh",
    "isWritable": true,
    "isSigner": false
  },
  {
    "address": "fgnvi2sNm7guSH8W6ov445nRit7AgYXdZCaV8RFZENF",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "5GoY6aNRFwQonLxjScU9jJC3BbzGFiQup2CSGiJkBJsQ",
    "isWritable": true,
    "isSigner": false
  },
  {
    "address": "595XKFP6v7zGTtSuA9h19BdA4q7hmcGTFiHSLRsmV6ru",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "8JqpXNmgmRGMm93Kh6sRETcMxbABM8y2oD8YAX26t7Gb",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "DQ2LpgGVwXc62NNkqrwmhLMkUWuxVzMJhyt4p2Yw5aiJ",
    "isWritable": true,
    "isSigner": false
  },
  {
    "address": "ETmid1DpsTNnZGueaiK68hWqfcs6rJii1YFgjKxrcVzF",
    "isWritable": true,
    "isSigner": false
  },
  {
    "address": "8NGr2WFh3JrC1UzmB3iifESF7W5wf3CBPWguJayuXmkX",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "13Q74er9thh3my9oACjChDhtn4znJibWBp1u8q1rAYau",
    "isWritable": true,
    "isSigner": false
  },
  {
    "address": "EkFFAtA4DRfmDGnxGxMcqZfSupUkxvUWEd3VFURYYT1j",
    "isWritable": false,
    "isSigner": false
  },
  {
    "address": "H6ZviaabTYZqUPgiSoMDbeVthcNW9ULcAuUu3zRLFqDR",
    "isWritable": false,
    "isSigner": false
  }
];
export const MANUAL_ALTS = Object.freeze([
  {key:'9VCkpsA1Hoaf7DC63ts3yTr6nAjvUxuZ4Vf4U5GR9Dy7',count:137,hash:'797c8c87222d4b60671e49e9e85278eec89ebf2e8be058b840821b89371c36e7'},
  {key:'595XKFP6v7zGTtSuA9h19BdA4q7hmcGTFiHSLRsmV6ru',count:10,hash:'9f17ecd0a43938be323481a5659836f5956688d1f8317223d835be3c675b94c5'}]);
export function manualInput() {return structuredClone(fixedInput);}
const stable = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
export function validateManualInput(input) {
  const selected=Object.fromEntries(Object.keys(fixedInput).map(k=>[k,input?.[k]]));
  if(stable(selected)!==stable(fixedInput)){throw new Error('Original manual report identity/proof changed');}
  return manualInput();
}
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const vec=b=>Buffer.concat([u32(b.length),b]);
const hex=s=>Buffer.from(s.slice(2),'hex');
/** Independent Borsh encoding from the pinned official 1.6 ExecutionReportSingleChain IDL. */
export function manualInstructions() {
  const m=fixedInput.message,t=m.tokenAmounts[0];
  const amount=Buffer.alloc(32);amount.writeBigUInt64LE(BigInt(t.amount));
  const report=Buffer.concat([u64(m.sourceChainSelector),hex(m.messageId),u64(m.sourceChainSelector),u64(m.destChainSelector),
    u64(m.sequenceNumber),u64(m.nonce),vec(hex(m.sender)),vec(Buffer.alloc(0)),solanaPublicKeyBytes(m.tokenReceiver),u32(1),
    vec(hex(t.sourcePoolAddress)),solanaPublicKeyBytes(t.destTokenAddress),u32(Number(t.destGasAmount)),vec(Buffer.from(t.extraData,'base64')),amount,
    u32(0),u64(0),u32(1),vec(Buffer.alloc(0)),u32(0)]);
  const data=Buffer.concat([createHash('sha256').update('global:manually_execute').digest().subarray(0,8),vec(report),vec(Buffer.from([0]))]);
  return [{programId:'ComputeBudget111111111111111111111111111111',accounts:[],dataBase64:Buffer.concat([Buffer.from([2]),u32(MANUAL.computeUnits)]).toString('base64')},
    {programId:MANUAL.offRamp,accounts:structuredClone(fixedAccounts),dataBase64:data.toString('base64')}];
}
export function validateManualAlts(tables) {
  if(!Array.isArray(tables)||tables.length!==2){throw new Error('Only existing manual ALTs allowed');}
  tables.forEach((t,i)=>{const pin=MANUAL_ALTS[i];if(t.key!==pin.key||t.addresses?.length!==pin.count||
    createHash('sha256').update(JSON.stringify(t.addresses)).digest('hex')!==pin.hash){throw new Error('Manual ALT membership changed');}});
}
export function manualExpected(tables) {validateManualAlts(tables);return {testOnly:true,cluster:'solana-devnet',payer:MANUAL.payer,
  sourceTransaction:MANUAL.sourceTransaction,messageId:MANUAL.messageId,mint:MANUAL.mint,offRamp:MANUAL.offRamp,merkleRoot:MANUAL.merkleRoot,sequenceNumber:'11207',sourceChainSelector:'16015286601757825753',
  feeTokenConfig:fixedAccounts[24].address,routerPoolSigner:fixedAccounts[25].address,offRampConfig:fixedAccounts[0].address,pool:fixedAccounts[19].address,signer:fixedAccounts[21].address,ata:fixedAccounts[20].address,registry:fixedAccounts[17].address,
  chain:fixedAccounts[15].address,alt:fixedAccounts[16].address,routerConfig:'3Yrg9E4ySAeRezgQY99NNarAmFLtixapga9MZb6y2dt3',recipientAta:fixedAccounts[13].address,commitReport:fixedAccounts[3].address,lookupTables:structuredClone(tables)};}
export function validateManualExpected(e) {if(JSON.stringify(e)!==JSON.stringify(manualExpected(e.lookupTables))){throw new Error('Manual recovery identity changed');}}
export function verifyManualIntent(intent,e) {
  validateManualExpected(e);const instructions=manualInstructions();
  if(intent.feePayer!==MANUAL.payer||JSON.stringify(intent.instructions)!==JSON.stringify(instructions)){throw new Error('Manual instruction/account/privilege changed');}
  return {...e,instructions};
}
export function manualContract() {return {schema:'agtmai-solana-manual-execution-journal-v1',label:'Original CCIP manual recovery',successReason:'finalized-manual-execution',
  verify:verifyManualIntent,canonical:(intent,e)=>{const canonical=verifyManualIntent({feePayer:intent.payer,instructions:intent.instructions},e);
    if(JSON.stringify(intent)!==JSON.stringify(canonical)){throw new Error('Stored manual identity mismatch');}return JSON.stringify(canonical);},
  stateMatches:s=>s?.manualExecutionVerified===true};}
/** PDA seeds checked against official ccip-offramp derive.rs; independent of SDK candidate. */
export function validateManualDerivedAccounts(provider) {
  const {PublicKey}=provider.web3,key=a=>new PublicKey(a),bytes=a=>key(a).toBuffer();
  const pda=(owner,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>typeof s==='string'?Buffer.from(s):s),key(owner))[0].toBase58();
  const router='Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C',poolProgram=fixedAccounts[18].address;
  const fee='FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi',rmn=fixedAccounts[9].address;
  const selector=u64(fixedInput.sourceChainSelector),mint=bytes(MANUAL.mint),off=MANUAL.offRamp;
  const ata=owner=>provider.spl.getAssociatedTokenAddressSync(key(MANUAL.mint),key(owner),true).toBase58();
  const poolSigner=pda(poolProgram,'ccip_tokenpool_signer',mint);
  const addresses=[pda(off,'config'),pda(off,'reference_addresses'),pda(off,'source_chain_state',selector),
    pda(off,'commit_report',selector,hex(MANUAL.merkleRoot)),off,pda(router,'allowed_offramp',selector,bytes(off)),MANUAL.payer,
    '11111111111111111111111111111111','Sysvar1nstructions1111111111111111111111111',rmn,pda(rmn,'curses'),pda(rmn,'config'),
    pda(off,'external_token_pools_signer',bytes(poolProgram)),ata(MANUAL.payer),pda(fee,'per_chain_per_token_config',selector,mint),
    pda(poolProgram,'ccip_tokenpool_chainconfig',selector,mint),MANUAL_ALTS[1].key,pda(router,'token_admin_registry',mint),poolProgram,
    pda(poolProgram,'ccip_tokenpool_config',mint),ata(poolSigner),poolSigner,'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',MANUAL.mint,
    pda(fee,'fee_billing_token_config',mint),pda(router,'external_token_pools_signer',bytes(poolProgram))];
  if(JSON.stringify(addresses)!==JSON.stringify(fixedAccounts.map(a=>a.address))){throw new Error('Independent manual PDA derivation mismatch');}
  return addresses;
}
