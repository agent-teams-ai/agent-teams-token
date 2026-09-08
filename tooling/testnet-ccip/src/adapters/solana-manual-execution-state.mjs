import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MANUAL, manualInput, validateManualExpected } from '../domain/solana-manual-execution.mjs';
import { FORWARD } from '../domain/evm-forward.mjs';
import { ROUTER_PROGRAM } from '../domain/solana-registration.ts';
import { POOL_GLOBAL, BURNMINT_PROGRAM } from '../domain/solana-pool-init.ts';
import { ALT_PROGRAM } from '../domain/solana-pool-config.ts';
import { inspectTransfer } from '../domain/transfer-status.mjs';
import { createNativeStatus } from './transfer-status-native.mjs';
import { createSolanaPoolInitSdk } from './solana-pool-init-sdk.mjs';
import { createSolanaRegistrationSdk } from './solana-registration-sdk.mjs';
import { createPoolConfigStateVerifier } from './solana-pool-config-state.mjs';
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR = 'Sysvar1111111111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const disc = name => createHash('sha256').update('account:' + name).digest().subarray(0,8);
function bytes(raw, owner) {
  if (!raw || raw.owner !== owner || raw.executable !== false || raw.data?.length !== 2 || raw.data[1] !== 'base64') { throw new Error('Wrong manual prerequisite owner/encoding'); }
  const b = Buffer.from(raw.data[0], 'base64');
  if (b.toString('base64') !== raw.data[0]) { throw new Error('Noncanonical manual prerequisite bytes'); }
  return b;
}
/** Native CommitReport 1.6.0: 2-bit state, source selector and root bound to the fixed original report. */
export function manualCommitState(raw, expected, phase) {
  const b = bytes(raw, MANUAL.offRamp), input = manualInput(), sequence = BigInt(input.message.sequenceNumber);
  if (b.length !== 89 || !b.subarray(0,8).equals(disc('CommitReport')) || b[8] !== 1 ||
      b.readBigUInt64LE(9) !== BigInt(input.sourceChainSelector) || '0x' + b.subarray(17,49).toString('hex') !== MANUAL.merkleRoot ||
      expected.merkleRoot !== MANUAL.merkleRoot || BigInt(expected.sequenceNumber) !== sequence) { throw new Error('Wrong native original commit report'); }
  const min = b.readBigUInt64LE(57), max = b.readBigUInt64LE(65), timestamp = b.readBigInt64LE(49);
  if (min > sequence || max < sequence || max - min >= 64n || timestamp <= 0n) { throw new Error('Wrong native commit sequence interval'); }
  const states = b.readBigUInt64LE(73) | b.readBigUInt64LE(81) << 64n;
  const state = Number(states >> ((sequence-min)*2n) & 3n);
  if (phase === 'before' ? state !== 0 : phase !== 'after' || state !== 2) { throw new Error('Original message execution state forbids this phase'); }
  return { timestamp, state };
}
export function manualEligibility(configRaw, clockRaw, timestamp) {
  const c = bytes(configRaw, MANUAL.offRamp), clock = bytes(clockRaw, SYSVAR);
  if (c.length !== 1848 || !c.subarray(0,8).equals(disc('Config')) || c[8] !== 1 || c[9] !== 1 ||
      c.readBigUInt64LE(16) !== FORWARD.selector || clock.length !== 40) { throw new Error('Wrong manual offRamp config/Clock'); }
  const delay = c.readBigInt64LE(24), now = clock.readBigInt64LE(32);
  if (delay < 0n || now <= 0n || timestamp <= 0n) { throw new Error('Invalid native manual execution time'); }
  const eligibleAt = timestamp + delay + 1n;
  if (now < eligibleAt) { throw new Error('Manual execution not yet allowed; eligible at ' + new Date(Number(eligibleAt)*1000).toISOString()); }
  return { eligibleAt: eligibleAt.toString(), clockTimestamp: now.toString() };
}
async function sdkModule(directory) {
  for (const [file, hash] of Object.entries({ 'package.json':'8cf7da517123c8be46f0a5fa14ef67904bf45bf4cfb972fc2c54be4b91cb56fb',
    'package-lock.json':'1477c1d04940f9556ff87eaf82de6f0f2eaa6f3585deea0f09bfdab8fba7f50f' })) {
    if (createHash('sha256').update(await readFile(resolve(directory,file))).digest('hex') !== hash) { throw new Error('Unreviewed CCIP SDK installation'); }
  }
  const require = createRequire(resolve(directory,'package.json'));
  return import(pathToFileURL(require.resolve('@chainlink/ccip-sdk')).href);
}
const le = v => { const b=Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
async function read(rpc,addresses) {
  const result=await rpc('getMultipleAccounts',[addresses,{encoding:'base64',commitment:'finalized'}]);
  if (!Number.isSafeInteger(result?.context?.slot) || result.context.slot < 1 || result.value?.length !== addresses.length) { throw new Error('Incomplete finalized manual snapshot'); }
  return result;
}
export async function createManualExecutionState(settings, provider) {
  const { PublicKey, AddressLookupTableAccount } = provider.web3;
  const { TOKEN_PROGRAM_ID, unpackAccount, getAssociatedTokenAddressSync } = provider.spl;
  const sdk = await sdkModule(settings.sdkDirectory);
  const pool = await createSolanaPoolInitSdk(settings.providerDirectory);
  const registration = await createSolanaRegistrationSdk(settings.providerDirectory);
  const verifyPool = createPoolConfigStateVerifier(provider,pool,registration);
  const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds,new PublicKey(program))[0].toBase58();
  const mint = new PublicKey(MANUAL.mint), payer = new PublicKey(MANUAL.payer);
  const recipientAta = getAssociatedTokenAddressSync(mint,payer).toBase58();
  const lane = { recipientAtas: {[MANUAL.payer]:recipientAta},
    solanaSigner:pda([Buffer.from('ccip_tokenpool_signer'),mint.toBuffer()], BURNMINT_PROGRAM),
    allowedOffRamp:(selector, offRamp) => pda([Buffer.from('allowed_offramp'),le(selector),new PublicKey(offRamp).toBuffer()],ROUTER_PROGRAM) };
  const native = createNativeStatus(settings.sepoliaRpc,settings.solanaRpc,lane);
  const logger = {debug(){},info(){},warn(){},error(){}};
  const chains = {};
  try {
    chains.ethereum = await sdk.EVMChain.fromUrl(settings.sepoliaRpc,{logger});
    chains.solana = await sdk.SolanaChain.fromUrl(settings.solanaRpc,{logger});
  } catch(error) { await Promise.all(Object.values(chains).map(c=>c.destroy())); throw error; }
  async function identity(rpc,e) {
    validateManualExpected(e);
    if (await rpc('getGenesisHash',[]) !== GENESIS || e.recipientAta !== recipientAta ||
        e.commitReport !== pda([Buffer.from('commit_report'),le(manualInput().sourceChainSelector),Buffer.from(MANUAL.merkleRoot.slice(2),'hex')],MANUAL.offRamp)) { throw new Error('Wrong original manual recovery chain/PDA'); }
    if(e.signer!==lane.solanaSigner) {throw new Error('Wrong independently derived pool signer');}
    await native.authorizeOffRamp('solana',MANUAL.offRamp,BigInt(manualInput().sourceChainSelector));
  }
  async function transfer(signature) {
    // This local metadata binds only a persisted signature. No API discovery or regenerated report.
    const api={getMessageById:async()=>({metadata:signature ? {receiptTransactionHash:signature,offRamp:MANUAL.offRamp} : {}})};
    const result=await inspectTransfer({sourceHash:MANUAL.sourceTransaction,direction:'ethereum-to-solana'},chains,native,api,sdk.ExecutionState.Success);
    if(result.identity.messageId!==MANUAL.messageId || result.events.length!==(signature?2:1) || result.destinationError) { throw new Error('Original native source/execution identity unproven'); }
    return result;
  }
  function recipient(raw,e,amount) {
    if(raw===null && amount===0n) {return;}
    const b=bytes(raw,TOKEN_PROGRAM_ID.toBase58());
    if(b.length!==165) {throw new Error('Wrong recipient SPL layout');}
    const a=unpackAccount(new PublicKey(e.recipientAta),{...raw,owner:TOKEN_PROGRAM_ID,data:b});
    if(a.owner.toBase58()!==MANUAL.payer || a.mint.toBase58()!==MANUAL.mint || !a.isInitialized || a.isFrozen || a.isNative || a.amount!==amount ||
      a.delegate!==null || a.delegatedAmount!==0n || a.closeAuthority!==null) {throw new Error('Wrong canonical recipient token state');}
  }
  async function accounting(amount) {
    const s=await native.snapshot();
    if(!s.coherent || s.fixedSupply!==100000000000n || s.lockedOnEthereum!==FORWARD.amount || s.supplyOnSolana!==amount) {throw new Error('Manual recovery accounting is not exact');}
    return s;
  }
  async function before(rpc,e,maxLamports) {
    if(!/^[1-9][0-9]*$/.test(maxLamports) || BigInt(maxLamports)>1000000000n) {throw new Error('Explicit at most 1 SOL exposure required');}
    await identity(rpc,e); await transfer();
    const addresses=[e.mint,e.pool,e.ata,e.registry,POOL_GLOBAL,e.routerConfig,e.chain,e.alt,e.recipientAta,e.payer,e.commitReport,e.offRampConfig,CLOCK];
    const s=await read(rpc,addresses), [,,,,,,,,recipientRaw,payerRaw,commitRaw,configRaw,clockRaw]=s.value;
    const commit=manualCommitState(commitRaw,e,'before');
    const eligibility=manualEligibility(configRaw,clockRaw,commit.timestamp);
    const chain=Buffer.from(s.value[6]?.data?.[0]??'','base64');
    verifyPool(s.value.slice(0,8),{...e,operation:'repair-remote-pool-encoding',recentSlot:'0',repairRateLimitsBase64:chain.subarray(73,139).toString('base64')},'after',s.context.slot,s.context.slot);
    recipient(recipientRaw,e,0n);
    if(payerRaw?.owner!==SYSTEM || payerRaw.executable!==false || !Number.isSafeInteger(payerRaw.lamports) || payerRaw.lamports<=0 || BigInt(payerRaw.lamports)>BigInt(maxLamports)) {throw new Error('Native balance exceeds authorized test exposure');}
    const tables=await read(rpc,e.lookupTables.map(t=>t.key));
    const lookupTables=tables.value.map((raw,i)=>{
      const b=bytes(raw,ALT_PROGRAM), state=AddressLookupTableAccount.deserialize(b), expected=e.lookupTables[i];
      if(state.deactivationSlot!==(1n<<64n)-1n || state.lastExtendedSlot>=tables.context.slot ||
        JSON.stringify(state.addresses.map(k=>k.toBase58()))!==JSON.stringify(expected.addresses) ||
        expected.key===e.alt && state.authority?.toBase58()!==e.payer) {throw new Error('Wrong finalized manual ALT identity/permissions');}
      return new AddressLookupTableAccount({key:new PublicKey(expected.key),state});
    });
    await accounting(0n);
    return {sourceLamports:String(payerRaw.lamports),lookupTables,...eligibility,manualExecutionVerified:false};
  }
  async function after(rpc,e,signature) {
    if(typeof signature!=='string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {throw new Error('Persisted signed manual transaction required');}
    await identity(rpc,e);
    const result=await transfer(signature);
    const s=await read(rpc,[e.commitReport,e.recipientAta]);
    manualCommitState(s.value[0],e,'after'); recipient(s.value[1],e,FORWARD.amount);
    const snapshot=await accounting(FORWARD.amount);
    if(BigInt(snapshot.solanaSlot)<result.events[1].blockHeight) {throw new Error('Manual accounting predates finalized execution');}
    return {manualExecutionVerified:true,signature,messageId:MANUAL.messageId,amount:FORWARD.amount.toString(),blockHash:result.events[1].blockHash};
  }
  return {before,after,destroy:()=>Promise.all(Object.values(chains).map(c=>c.destroy()))};
}
