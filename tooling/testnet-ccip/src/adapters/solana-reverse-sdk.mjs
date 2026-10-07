// @ts-check
import { bindFixture } from './fixture-binding.ts';
import { createReverseSigning } from './solana-reverse-operator.ts';
import { openTestSdk } from './test-sdk-admission.ts';
import { selectTestSdk } from './test-sdk-policy.ts';
import { validateReplacementFixture } from '../domain/replacement-fixture.ts';
import { createSdkTestFetch, selectSolanaRpc, TEST_RPC_RESPONSE_LIMIT, UndrainedTestRpcBody } from './test-rpc.ts';
import { unsignedSvmPrimitives } from './dev-provider-primitives.mjs';
import { verifySvmWirePacket } from './dev-svm-call-plan.mjs';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSolanaProvider } from './solana-transaction-sdk.mjs';
import { createSolanaPoolConfigSdk, createPoolConfigSdk } from './solana-pool-config-sdk.mjs';
import { createSolanaPoolInitSdk, createPoolInitSdk } from './solana-pool-init-sdk.mjs';
import { createRegistrationSdk } from './solana-registration-sdk.mjs';
import { createReverseState } from './solana-reverse-state.mjs';
import { reverseRoute, deriveReverseAccounts, reverseInstructions, verifyReverseIntent } from '../domain/solana-reverse.mjs';
import { ROUTER_PROGRAM } from '../domain/solana-registration.ts';
import { altAddresses, SEPOLIA_SELECTOR } from '../domain/solana-pool-config.ts';
import { SOLANA_REMOTE } from '../domain/evm-remote-config.ts';
/** @typedef {import('./solana-transaction-sdk.mjs').NativeProvider} NativeProvider */
/** @typedef {import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js').UnsignedSolanaTx} Candidate */
/** @typedef {import('../../../../.local/INPUT/provider/node_modules/@solana/web3.js/lib/index.js').AddressLookupTableAccount} LookupTable */
/** @typedef {import('../domain/solana-pool-config.ts').SolanaPoolConfigExpectation & {linkMint: string, sourceAta: string, spender: string, destChain: string, nonce: string, feeReceiver: string, feeConfig: string, feeDest: string, nativeFeeConfig: string, linkFeeConfig: string, perTokenConfig: string, curses: string, rmnConfig: string, approval: boolean, quotedFee: string, sourceLamports: string}} ReverseExpectation */
/** Independently selected state.before evidence; candidate metadata is never its authority.
 * @typedef {{lookupTable: LookupTable, slot: string}} FinalizedLookup
 */
/** @param {Candidate['instructions'][number]} ix */
const normalized = ix => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map(k => ({ address:k.pubkey.toBase58(),isWritable:k.isWritable,isSigner:k.isSigner })), dataBase64:Buffer.from(ix.data).toString('base64') });
/** @param {ReverseExpectation} e @param {FinalizedLookup | undefined} snapshot */
function finalized(e, snapshot) {
    if (!snapshot || !/^[1-9][0-9]*$/.test(snapshot.slot) || BigInt(snapshot.slot) > BigInt(Number.MAX_SAFE_INTEGER) || !e.recentSlot) {
      throw new Error('Independent finalized ALT snapshot required');
    }
    const selected = snapshot.lookupTable, s = selected.state, addresses = altAddresses(e);
    if (selected.key.toBase58() !== e.alt || s.authority?.toBase58() !== e.payer || s.deactivationSlot !== (1n << 64n) - 1n ||
      !Number.isSafeInteger(s.lastExtendedSlot) || BigInt(s.lastExtendedSlot) < BigInt(e.recentSlot) || BigInt(s.lastExtendedSlot) >= BigInt(snapshot.slot) ||
      s.lastExtendedSlotStartIndex !== 0 || s.addresses.length !== addresses.length || s.addresses.some((a, i) => a.toBase58() !== addresses[i])) {
      throw new Error('Wrong independent finalized ALT metadata/addresses');
    }
    // Encode the observed finalized metadata for the independent wire decoder.
    const data = Buffer.alloc(56 + addresses.length * 32); data.writeUInt32LE(1, 0);
    data.writeBigUInt64LE(s.deactivationSlot, 4); data.writeBigUInt64LE(BigInt(s.lastExtendedSlot), 12);
    data[20] = s.lastExtendedSlotStartIndex; data[21] = 1; s.authority.toBuffer().copy(data, 22);
    s.addresses.forEach((a, i) => a.toBuffer().copy(data, 56 + i * 32));
    return { selected, wire: { key: selected.key.toBase58(), dataBase64: data.toString('base64') } };
}
/** @param {LookupTable} observed @param {LookupTable} selected */
function sameTable(observed, selected) {
    const a = observed.state, b = selected.state;
    if (observed.key.toBase58() !== selected.key.toBase58() || a.authority?.toBase58() !== b.authority?.toBase58() ||
      a.deactivationSlot !== b.deactivationSlot || a.lastExtendedSlot !== b.lastExtendedSlot || a.lastExtendedSlotStartIndex !== b.lastExtendedSlotStartIndex ||
      a.addresses.length !== b.addresses.length || a.addresses.some((key, i) => key.toBase58() !== b.addresses[i]?.toBase58())) {
      throw new Error('SDK candidate ALT differs from independent finalized snapshot');
    }
}
/** @param {NativeProvider} provider @param {(expected: ReverseExpectation) => void} validateExpected */
export function createReverseTransactionSdk(provider, validateExpected) {
  const { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount, Keypair } = provider.web3;

  const native = (/** @type {import('../domain/solana-mint.ts').MintInstruction} */ix) => new TransactionInstruction({programId:new PublicKey(ix.programId),data:Buffer.from(ix.dataBase64,'base64'),
    keys:ix.accounts.map(a=>({pubkey:new PublicKey(a.address),isWritable:a.isWritable,isSigner:a.isSigner}))});
  /** Independent compiler oracle only: ALT metadata never participates in compiled messages.
   * @param {ReverseExpectation} e
   */
  function table(e) {
    if (!e.alt) { throw new Error('Missing selected ALT'); }
    return new AddressLookupTableAccount({key:new PublicKey(e.alt),state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:0,
      lastExtendedSlotStartIndex:0,authority:new PublicKey(e.payer),addresses:altAddresses(e).map(a=>new PublicKey(a))}});
  }
  /** @param {ReverseExpectation} e @param {string} blockhash */
  function message(e,blockhash) {
    validateExpected(e);
    return new TransactionMessage({payerKey:new PublicKey(e.payer),recentBlockhash:blockhash,
      instructions:reverseInstructions(e).map(native)}).compileToV0Message([table(e)]);
  }
  /** @param {InstanceType<NativeProvider['web3']['VersionedTransaction']>} tx @param {ReverseExpectation} e @param {FinalizedLookup | undefined} snapshot @param {readonly import('../domain/solana-mint.ts').MintInstruction[]} [instructions] */
  function decode(tx,e,snapshot,instructions = reverseInstructions(e)) {
    if (!snapshot || !(snapshot.lookupTable instanceof AddressLookupTableAccount)) { throw new Error('Native finalized reverse ALT required'); }
    const lookup = finalized(e, snapshot);
    if (tx.version !== 0 || tx.signatures.length !== 1 || tx.message.header.numRequiredSignatures !== 1 ||
      tx.message.staticAccountKeys[0]?.toBase58() !== e.payer ||
      !Buffer.from(tx.message.serialize()).equals(Buffer.from(message(e,tx.message.recentBlockhash).serialize()))) {
      throw new Error('Unexpected v0 signer, instructions, ALT lookup indexes or global privileges');
    }
    // The shared raw verifier checks Borsh payload and compiled global privileges/ALT.
    // Remove signatures only in this read-only verification copy; signed identity is
    // authenticated separately below by native Ed25519 verification.
    const unsigned = new VersionedTransaction(tx.message);
    verifySvmWirePacket(unsignedSvmPrimitives(provider.web3), { ...reverseRoute(e.fixture), selector: SEPOLIA_SELECTOR }, e,
      { bytesBase64: Buffer.from(unsigned.serialize()).toString('base64'), messageBase64: Buffer.from(tx.message.serialize()).toString('base64'),
        blockhash: tx.message.recentBlockhash, instructions }, lookup.wire);
    // Exact recompiled bytes prove both ordered instruction data and global privilege union.
    const intent = {feePayer:e.payer,instructions};
    return {intent,messageBase64:Buffer.from(tx.message.serialize()).toString('base64'),blockhash:tx.message.recentBlockhash};
  }
  /** @param {Candidate} candidate @param {ReverseExpectation} e @param {import('./solana-transaction-sdk.mjs').BlockValidity} latest @param {FinalizedLookup} snapshot */
  function build(candidate,e,latest,snapshot) {
    validateExpected(e);
    if (!candidate || candidate.family !== 'SVM' || candidate.mainIndex !== Number(e.approval) || !Array.isArray(candidate.instructions) || candidate.instructions.length !== 1+Number(e.approval) ||
      !Array.isArray(candidate.lookupTables) || candidate.lookupTables.length !== 1 || !candidate.lookupTables[0]) {
      throw new Error('Wrong SDK instruction list or ALT');
    }
    const lookup = finalized(e, snapshot); sameTable(candidate.lookupTables[0], lookup.selected);
    const instructions = candidate.instructions.map(normalized);
    verifyReverseIntent({feePayer:e.payer,instructions},e);
    if (!/^[1-9][0-9]*$/.test(latest.lastValidBlockHeight) || new PublicKey(latest.blockhash).toBase58() !== latest.blockhash) { throw new Error('Invalid block validity'); }
    const actual = new TransactionMessage({payerKey:new PublicKey(e.payer),recentBlockhash:latest.blockhash,
      instructions:candidate.instructions}).compileToV0Message(candidate.lookupTables);
    const tx = new VersionedTransaction(actual);
    const bytes = Buffer.from(tx.serialize());
    if (bytes.length > 1232) { throw new Error('Reverse v0 transaction exceeds packet limit'); }
    if (!Buffer.from(VersionedTransaction.deserialize(bytes).serialize()).equals(bytes)) { throw new Error('Noncanonical unsigned transaction'); }
    return {...latest,bytesBase64:bytes.toString('base64'),...decode(tx,e,snapshot,instructions)};
  }
  /** @param {string} bytesBase64 @param {ReverseExpectation} e @param {FinalizedLookup} snapshot */
  function inspectSigned(bytesBase64,e,snapshot) {
    const bytes=Buffer.from(bytesBase64,'base64');
    if (bytes.length>1232 || bytes.toString('base64')!==bytesBase64) {throw new Error('Invalid reverse signed encoding');}
    const tx=VersionedTransaction.deserialize(bytes), inspected=decode(tx,e,snapshot);
    if (!Buffer.from(tx.serialize()).equals(bytes)) {throw new Error('Noncanonical signed transaction');}
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(e.payer).toBuffer()]),format:'der',type:'spki'});
    const signature = tx.signatures[0];
    if (!signature || !verifySignature(null,tx.message.serialize(),key,signature)) {throw new Error('Invalid native Ed25519 signature');}
    return {...inspected,signature:provider.bs58.encode(signature)};
  }
  /** Native unsigned packet check; the height remains captured validity metadata.
   * @param {import('./solana-transaction-sdk.mjs').PreparedTransaction} prepared
   * @param {ReverseExpectation} e @param {FinalizedLookup} snapshot
   */
  function inspectPrepared(prepared, e, snapshot) {
    const bytes = Buffer.from(prepared.bytesBase64, 'base64');
    if (!bytes.length || bytes.length > 1232 || bytes.toString('base64') !== prepared.bytesBase64 ||
      !/^[1-9][0-9]*$/.test(prepared.lastValidBlockHeight) || BigInt(prepared.lastValidBlockHeight) >= 1n << 64n) {
      throw new Error('Invalid reverse prepared encoding/validity');
    }
    const tx = VersionedTransaction.deserialize(bytes), inspected = decode(tx, e, snapshot);
    if (!Buffer.from(tx.serialize()).equals(bytes) || tx.signatures.some(s => s.some(b => b !== 0)) ||
      inspected.messageBase64 !== prepared.messageBase64 || inspected.blockhash !== prepared.blockhash) {
      throw new Error('Invalid unsigned reverse prepared identity');
    }
    return tx;
  }
  /** @param {import('./solana-transaction-sdk.mjs').PreparedTransaction} prepared @param {ReverseExpectation} e @param {import('./solana-transaction-sdk.mjs').TestKeys} keys @param {FinalizedLookup} snapshot */
  async function sign(prepared,e,keys,snapshot) {
    if(keys.testOnly!==true) {throw new Error('Test-only reverse signer required');}
    let secret,payer,signingSecret;
    /** @type {unknown[] | undefined} */ let raw;
    try {
      const tx=inspectPrepared(prepared,e,snapshot);
      const parsed=/** @type {unknown} */(JSON.parse(await readFile(keys.payerFile,'utf8')));
      if(Array.isArray(parsed)){raw=parsed;}
      if(!Array.isArray(parsed)||parsed.length!==64||parsed.some(n=>typeof n!=='number'||!Number.isInteger(n)||n<0||n>255)){throw new Error('Invalid key');}
      secret=Uint8Array.from(parsed);raw?.fill(0);payer=Keypair.fromSecretKey(secret);
      if(payer.publicKey.toBase58()!==e.payer){throw new Error('Wrong test payer');}
      signingSecret=payer.secretKey;
      tx.sign([{publicKey:payer.publicKey,secretKey:signingSecret}]);
      const bytesBase64=Buffer.from(tx.serialize()).toString('base64'),inspected=inspectSigned(bytesBase64,e,snapshot);
      return {bytesBase64,signature:inspected.signature,blockhash:inspected.blockhash,lastValidBlockHeight:prepared.lastValidBlockHeight};
    } catch {throw new Error('Test-only reverse signing failed');}
    finally {raw?.fill(0);secret?.fill(0);signingSecret?.fill(0);}
  }
  return {build,inspectSigned,inspectPrepared,sign};
}
/** @typedef {import('./test-sdk-policy.ts').TestSdkSelection & {providerDirectory: string, ccipProviderDirectory: string, recentSlot: string, journalFile?: string, solanaRpc?: string, replayFetch?: typeof fetch}} ReverseSettings */
/** @param {unknown} params @param {NativeProvider} provider */
function verifyUnsignedSimulation(params, provider) {
  if (!Array.isArray(params) || typeof params[0] !== 'string') { throw new Error('Unsigned SDK simulation required'); }
  /** @type {unknown} */
  const options = params[1];
  if (!options || typeof options !== 'object' || !('sigVerify' in options) || options.sigVerify !== false ||
    !('encoding' in options) || options.encoding !== 'base64') { throw new Error('Unsigned SDK simulation required'); }
  const raw = Buffer.from(params[0], 'base64'), tx = new provider.web3.VersionedTransaction(provider.web3.VersionedTransaction.deserialize(raw).message);
  if (raw.length > 1232 || raw.toString('base64') !== params[0] || !Buffer.from(tx.serialize()).equals(raw)) {
    throw new Error('Signed/noncanonical SDK simulation forbidden');
  }
}
/** @param {string} endpoint @param {typeof fetch | undefined} replayFetch @param {NativeProvider} provider */
function unsignedReverseFetch(endpoint, replayFetch, provider) {
  const checked = createSdkTestFetch(endpoint, replayFetch);
  /** @type {typeof fetch} */
  const fetchUnsigned = (input, init) => {
    if (typeof init?.body !== 'string' || Buffer.byteLength(init.body) > TEST_RPC_RESPONSE_LIMIT) { throw new Error('Invalid TEST reverse transport'); }
    /** @type {unknown} */
    const body = JSON.parse(init.body);
    /** @type {readonly unknown[]} */
    const rows = Array.isArray(body) ? body : [body];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !('method' in row) || typeof row.method !== 'string' ||
        !['getGenesisHash', 'getAccountInfo', 'getMultipleAccounts', 'getLatestBlockhash', 'simulateTransaction'].includes(row.method)) {
        throw new Error('Non-read TEST reverse RPC forbidden');
      }
      if (row.method === 'simulateTransaction') { verifyUnsignedSimulation('params' in row ? row.params : undefined, provider); }
    }
    return checked(input, init);
  };
  return fetchUnsigned;
}
/** @param {ReverseSettings} settings @param {typeof fetch | undefined} replayFetch */
function reverseSelection(settings, replayFetch) {
  const selected = selectTestSdk(settings, settings.providerDirectory,
    settings.fixture === undefined ? undefined : validateReplacementFixture(settings.fixture));
  if (selected && typeof replayFetch !== 'function') { throw new Error('TEST reverse requires injected unsigned transport'); }
  return selected;
}
/** Public TEST view stays unsigned; legacy callers retain their existing signer. @param {ReverseSettings} settings */
export async function createSolanaReverseSdk(settings) {
  return (await materializeReverse(settings, false)).sdk;
}
/** One private operator attempt using the same admission and native compiler as its unsigned view.
 * @param {ReverseSettings} settings
 */
export async function createSolanaReverseOperatorAttempt(settings) {
  const attempt = await materializeReverse(settings, true);
  if (!('acquireSigner' in attempt) || typeof attempt.acquireSigner !== 'function' || !('destroy' in attempt.sdk)) {
    if ('destroy' in attempt.sdk) { await attempt.sdk.destroy(); }
    throw new Error('Explicit TEST reverse operator attempt required');
  }
  return Object.freeze({ sdk: attempt.sdk, acquireSigner: attempt.acquireSigner });
}
/** Load only the already admitted provider or the existing pinned legacy dependencies.
 * @param {ReverseSettings} settings
 * @param {Awaited<ReturnType<typeof openTestSdk>> | undefined} session
 */
async function reverseDependencies(settings,session) {
  const provider = session?.native ?? await loadSolanaProvider(settings.providerDirectory);
  const poolSdk = session ? createPoolInitSdk(provider) : await createSolanaPoolInitSdk(settings.providerDirectory);
  const poolConfig = session ? createPoolConfigSdk(provider, createRegistrationSdk(provider, poolSdk), poolSdk) : await createSolanaPoolConfigSdk(settings.providerDirectory);
  /** @type {typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js')} */
  let sdk;
  if (session) { sdk = session.solana; }
  else {
  const root=resolve(settings.ccipProviderDirectory);
  for(const [file,hash] of Object.entries({'package.json':'8cf7da517123c8be46f0a5fa14ef67904bf45bf4cfb972fc2c54be4b91cb56fb',
    'package-lock.json':'1477c1d04940f9556ff87eaf82de6f0f2eaa6f3585deea0f09bfdab8fba7f50f'})) {
    if(createHash('sha256').update(await readFile(resolve(root,file))).digest('hex')!==hash){throw new Error('Wrong CCIP provider pin');}
  }
  const require=createRequire(resolve(root,'package.json')); sdk=await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk')).href);
  }
  return {provider,poolSdk,poolConfig,sdk};
}
/** @param {ReverseSettings} settings @param {boolean} operator */
async function materializeReverse(settings, operator) {
  const replayFetch = settings.replayFetch, selected = reverseSelection(settings, replayFetch);
  if (operator && !selected) { throw new Error('Explicit TEST reverse operator selection required'); }
  const fixture = selected?.fixture ?? bindFixture({ ...settings, testOnly: settings.testOnly === true }, settings.journalFile ? [settings.journalFile] : []), route = reverseRoute(fixture);
  const endpoint = selectSolanaRpc(settings);
  const session = selected ? await openTestSdk({ root: settings.providerDirectory, archives: selected.archives }) : undefined;
  const abort = new AbortController();
  /** @type {Set<Promise<Response>>} */
  const transports = new Set();
  /** The quote belongs to the actual candidate produced by this admitted client.
   * @type {WeakMap<Candidate, string>}
   */
  const quotes = new WeakMap();
  /** @type {import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js').SolanaChain | undefined} */
  let chain;
  /** @type {Promise<unknown> | undefined} */
  let busy;
  /** @type {Promise<void> | undefined} */
  let destroyPromise;
  /** @type {(() => Promise<void>) | undefined} */ let drainSigning;
  let closing = false, physicalDebt = false;
  const destroy = () => {
    if (destroyPromise) { return destroyPromise; }
    closing = true; abort.abort(); const active = busy;
    destroyPromise = (async () => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let deadline;
      try {
        await Promise.race([(async () => {
          if (active) { await active.catch(() => {}); }
          await drainSigning?.();
          await Promise.allSettled(transports);
          if (physicalDebt) { throw new Error('Unresolved TEST SDK reverse body drain'); }
          chain?.destroy(); session?.close();
        })(), new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Unresolved TEST SDK reverse drain')), 20_000); })]);
      } finally { clearTimeout(deadline); }
    })();
    return destroyPromise;
  };
  try {
  const {provider,poolSdk,poolConfig,sdk}=await reverseDependencies(settings,session);
  if (session) {
    const checked = unsignedReverseFetch(endpoint, replayFetch, provider);
    /** @type {typeof fetch} */
    const ownedFetch = (input, init) => {
      if (closing) { throw new Error('Closed TEST reverse transport'); }
      const result = checked(input, { ...init, signal: init?.signal ? AbortSignal.any([abort.signal, init.signal]) : abort.signal });
      transports.add(result); void result.then(() => transports.delete(result), error => {
        if (error instanceof UndrainedTestRpcBody) { physicalDebt = true; }
        transports.delete(result);
      }); return result;
    };
    chain = await sdk.SolanaChain.fromUrl(endpoint, { fetch: ownedFetch, abort: abort.signal, apiClient: null,
      logger: { debug() {}, info() {}, warn() {}, error() {} } });
    session.assertHealthy();
    if (!fixture || chain.network.chainSelector !== BigInt(fixture.forwardSelector)) { throw new Error('Wrong TEST SDK SVM source chain'); }
  }
  const pool=poolConfig.derive({testOnly:true,cluster:'solana-devnet',payer:route.payer,mint:route.mint,
    pool:fixture?.solanaPool ?? new provider.web3.PublicKey(Buffer.from(SOLANA_REMOTE.pool.slice(2),'hex')).toBase58(),operation:'set-pool',recentSlot:settings.recentSlot});
  if (session) { Object.freeze(pool); }
  const rawState=createReverseState(provider,poolSdk,fixture);
  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  async function readState(work) {
    if (!session) { return work(); }
    session.assertHealthy();
    if (closing || busy) { throw new Error('Reverse client busy/destroyed'); }
    const operation = Promise.resolve().then(work); busy = operation;
    try {
      const value = await operation; session.assertHealthy();
      if (closing) { throw new Error('Reverse client busy/destroyed'); }
      return value;
    } catch (error) { if (error instanceof UndrainedTestRpcBody) { physicalDebt = true; } await destroy(); throw error; }
    finally { busy = undefined; }
  }
  /** @typedef {(method: string, params: readonly unknown[]) => Promise<unknown>} Rpc */
  const state = Object.freeze({
    /** @param {Rpc} rpc @param {string} routerConfig */
    config(rpc, routerConfig) { return readState(async () => {
      session?.assertHealthy();
      /** @type {unknown} */
      const value = await rawState.config(rpc, routerConfig); session?.assertHealthy();
      if (typeof value !== 'string' || new provider.web3.PublicKey(value).toBase58() !== value) { throw new Error('Invalid finalized link mint'); }
      return value;
    }); },
    /** @param {Rpc} rpc @param {ReverseExpectation} e @param {string} maximumLamports */
    before(rpc, e, maximumLamports) { return readState(async () => {
      session?.assertHealthy();
      /** @type {unknown} */
      const value = await rawState.before(rpc, e, maximumLamports); session?.assertHealthy();
      if (!value || typeof value !== 'object' || !('approval' in value) || typeof value.approval !== 'boolean' ||
        !('sourceLamports' in value) || typeof value.sourceLamports !== 'string' || !('lookupTable' in value) ||
        !(value.lookupTable instanceof provider.web3.AddressLookupTableAccount) || !('slot' in value) || typeof value.slot !== 'string') { throw new Error('Invalid finalized reverse state'); }
      const snapshot = { lookupTable: value.lookupTable, slot: value.slot }; finalized(e, snapshot);
      return { approval: value.approval, sourceLamports: value.sourceLamports, ...snapshot };
    }); },
    /** @param {Rpc} rpc @param {ReverseExpectation} e */
    lookup(rpc, e) { return readState(async () => {
      /** @type {unknown} */
      const value = await rawState.lookup(rpc, e);
      if (!value || typeof value !== 'object' || !('lookupTable' in value) ||
        !(value.lookupTable instanceof provider.web3.AddressLookupTableAccount) || !('slot' in value) || typeof value.slot !== 'string') {
        throw new Error('Invalid finalized reverse lookup');
      }
      const snapshot = { lookupTable: value.lookupTable, slot: value.slot }; finalized(e, snapshot); return snapshot;
    }); },
  });
  /** @param {string} linkMint @param {Pick<ReverseExpectation, 'approval' | 'quotedFee' | 'sourceLamports'>} dynamic @returns {ReverseExpectation} */
  function derive(linkMint,dynamic) {return {...deriveReverseAccounts(provider,pool,linkMint,route),...dynamic,...(fixture ? { fixture } : {})};}
  /** @param {ReverseExpectation} e */
  function validateExpected(e) {
    const canonical=derive(e.linkMint,{approval:e.approval,quotedFee:e.quotedFee,sourceLamports:e.sourceLamports});
    if(JSON.stringify(e)!==JSON.stringify(canonical)){throw new Error('Wrong reverse derived identity');}
    reverseInstructions(e);
  }
  const transaction=createReverseTransactionSdk(provider,validateExpected);
  const signing = operator ? createReverseSigning(provider, transaction, () => {
    session?.assertHealthy();
    if (closing || busy) { throw new Error('Reverse client busy/destroyed'); }
  }) : undefined;
  drainSigning = signing?.drain;
  /** @returns {Promise<Readonly<{fee: string, candidate: Candidate}>>} */
  async function candidate() {
      session?.assertHealthy(); if (closing || busy) { throw new Error('Reverse client busy/destroyed'); }
      const client = chain ?? await sdk.SolanaChain.fromUrl(endpoint);
      const operation = Promise.resolve().then(async () => {
      try {
        /** @type {Parameters<typeof client.generateUnsignedSendMessage>[0]} */
        const opts={sender:route.payer,router:ROUTER_PROGRAM,destChainSelector:BigInt(SEPOLIA_SELECTOR),approveMax:false,
          message:{receiver:route.recipient,data:'0x',tokenAmounts:[{token:route.mint,amount:route.amount}],
            feeToken:'11111111111111111111111111111111',extraArgs:{gasLimit:0n,allowOutOfOrderExecution:true}}};
        const fee=await client.getFee(opts);
        if(typeof fee!=='bigint'||fee<=0n||fee>100000000n){throw new Error('Native quote outside test range');}
        const actual = await client.generateUnsignedSendMessage({...opts,message:{...opts.message,fee}});
        quotes.set(actual, fee.toString());
        return Object.freeze({fee:fee.toString(),candidate:actual});
      } finally { if (!session) { client.destroy(); } }
      });
      busy = operation;
      try { const value = await operation; session?.assertHealthy(); if (closing) { throw new Error('Reverse client busy/destroyed'); } return value; }
      catch (error) { if (error instanceof UndrainedTestRpcBody) { physicalDebt = true; } await destroy(); throw error; } finally { busy = undefined; }
  }
  if (!session) { return { sdk: { ...transaction, state, pool, derive, validateExpected, candidate } }; }
  const sdkView = Object.freeze({ state, pool,
    derive: /** @param {Parameters<typeof derive>} args */(...args) => { session.assertHealthy(); return derive(...args); },
    validateExpected: /** @param {ReverseExpectation} e */e => { session.assertHealthy(); validateExpected(e); },
    build: /** @param {Parameters<typeof transaction.build>} args */(...args) => {
      session.assertHealthy();
      if (quotes.get(args[0]) !== args[1].quotedFee) { throw new Error('Missing or mismatched native SDK candidate quote'); }
      const value = (signing?.build ?? transaction.build)(...args); session.assertHealthy(); return value;
    },
    inspectSigned: /** @param {Parameters<typeof transaction.inspectSigned>} args */(...args) => { session.assertHealthy(); const value = transaction.inspectSigned(...args); session.assertHealthy(); return value; },
    candidate, destroy,
  });
  return signing ? { sdk: sdkView, acquireSigner: signing.acquireSigner } : { sdk: sdkView };
  } catch (error) { if (error instanceof UndrainedTestRpcBody) { physicalDebt = true; } await destroy(); throw error; }
}
