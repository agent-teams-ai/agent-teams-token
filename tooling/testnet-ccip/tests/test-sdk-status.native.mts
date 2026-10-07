import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { Hash, type BinaryToTextEncoding } from 'node:crypto';
import { runStatus } from '../src/composition/transfer-status.mjs';
import { inspectTransfer, matchRequest } from '../src/domain/transfer-status.mjs';
import { createTestSdkStatus } from '../src/adapters/test-sdk-status.ts';
import { testSdkCounters } from '../src/adapters/test-sdk-admission.ts';
import { validateReplacementFixture } from '../src/domain/replacement-fixture.ts';
import { solanaEffect, type NativeStatusLane, type InvocationLog } from '../src/adapters/transfer-status-native.mjs';
import { DEFAULT_SEPOLIA_RPC, DEFAULT_SOLANA_RPC, TEST_RPC_RESPONSE_LIMIT } from '../src/adapters/test-rpc.ts';
import { BURNMINT_PROGRAM } from '../src/domain/solana-pool-init.ts';
import { ROUTER_PROGRAM } from '../src/domain/solana-registration.ts';
import { FORWARD_RECIPIENT_B, FORWARD_RECIPIENT_B_ATA } from '../src/domain/evm-forward.mjs';
import { TEST_SDK_PROFILE, type ExplicitTestSdkSelection } from '../src/adapters/test-sdk-policy.ts';
import type { EVMChain } from '../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/index.js';
import type { SolanaChain } from '../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js';
import type * as Web3 from '../../../.local/INPUT/provider/node_modules/@solana/web3.js/lib/index.js';
import type * as Spl from '../../../.local/INPUT/provider/node_modules/@solana/spl-token/lib/types/index.js';
import type { StatusSettings } from '../src/composition/transfer-status.mjs';
import type { StatusTransferInput } from '../src/domain/transfer-status.mjs';

// These responses are controlled native units over real admitted SDK bytes. They
// are deliberately not genuine RPC captures and do not qualify public delivery.
const root = resolve('.local/INPUT/native-private-provider'), archives = resolve('.local/INPUT/archives');
const fixture = validateReplacementFixture(JSON.parse(readFileSync('.local/INPUT/EXACT-FIXTURE.json', 'utf8')));
interface MintInstruction { programId: string; stackHeight: number; parsed?: { type: string; info: { mint: string; account: string; amount: string; mintAuthority: string } } }
interface MintTransaction {
  transaction: { message: { accountKeys: string[]; instructions: { programId: string }[] } };
  meta: { logMessages: string[]; innerInstructions: { index: number; instructions: MintInstruction[] }[];
    preTokenBalances: TokenBalance[]; postTokenBalances: TokenBalance[] };
}
interface TokenBalance { accountIndex: number; mint: string; owner: string; programId: string; uiTokenAmount: { amount: string; decimals: number } }
function present<T>(value: T | undefined): T { assert.notEqual(value, undefined); if (value === undefined) { throw new Error('Missing controlled unit field'); } return value; }
const time = 1_791_288_000_000, hash = '0x' + 'ab'.repeat(32);
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const svmOffRamp = 'offqSMQWgQud6WJz694LRzkeN5kMYpCHTpXQr3Rkcjm';
const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function object(value: unknown): Record<string, unknown> { assert.ok(record(value)); return value; }
function deferred<T>() { return Promise.withResolvers<T>(); }
async function ticks(): Promise<void> { for (let i = 0; i < 30; i++) { await Promise.resolve(); } }
async function scenario(name: string): Promise<void> {
  const reverseCausal = name === 'causal-reverse', causal = name.startsWith('causal-') && !reverseCausal, evmDecoders = name === 'decoders' || causal || reverseCausal;
  let cpiMutant = '', failedCancellation = false, physicalReleased = true;
  const evms: EVMChain[] = [], svms: SolanaChain[] = [];
  let evmDestroyed = 0, svmDestroyed = 0, calls = 0, installed = false;
  let native: { web3: typeof Web3; spl: typeof Spl } | undefined, lane: NativeStatusLane | undefined;
  const header = deferred<Response>(), entered = deferred<void>(), body = deferred<void>();
  let held = false, apiCalls = 0, globalFetchAttempts = 0, mutateReply = false, bodyCancelled = 0;
  const messageId = '0x' + '11'.repeat(32), sourceHash = '0x' + '22'.repeat(32), executionHash = '0x' + '33'.repeat(32);
  const onRamp = '0x' + '44'.repeat(20), offRamp = '0x0820f975ce90ee5c508657f0c58b71d1fcc85ce0';
  let sourceLog: { data: string; topics: string[] } | undefined, executionLog: { data: string; topics: string[] } | undefined;
  let typeAndVersion: string | undefined;
  let parseLogs: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/utils.js').parseSolanaLogs | undefined;
  let svmSourceData: string | undefined, svmExecutionData: string | undefined;
  const apiResponse: import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/api/types.js').RawMessageResponse = {
    messageId, sender: fixture.administrator, receiver: '11111111111111111111111111111111', status: 'SUCCESS',
    sourceNetworkInfo: { name: 'ethereum-testnet-sepolia', chainSelector: fixture.reverseSelector, chainId: fixture.chainId, chainFamily: 'EVM', displayName: null },
    destNetworkInfo: { name: 'solana-testnet-devnet', chainSelector: fixture.forwardSelector, chainId: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', chainFamily: 'SVM', displayName: null },
    sendTransactionHash: sourceHash, sendTimestamp: new Date(time).toISOString(),
    tokenAmounts: [{ sourceTokenAddress: fixture.token, destTokenAddress: fixture.mint, sourcePoolAddress: fixture.pool, amount: fixture.amount }],
    extraArgs: { computeUnits: 0n, accountIsWritableBitmap: '0', allowOutOfOrderExecution: true, tokenReceiver: FORWARD_RECIPIENT_B, accounts: [] },
    readyForManualExecution: false, finality: 0n, fees: { fixedFeesDetails: { tokenAddress: '0x' + '00'.repeat(20), totalAmount: '1' } },
    origin: fixture.administrator, sequenceNumber: '7', onramp: onRamp, offramp: svmOffRamp,
    sendBlockNumber: 10n, sendLogIndex: 1n, version: '1.6.0', receiptTransactionHash: '1'.repeat(64), data: '0x',
  };
  const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
  const mutations: { timestamp: number | null | undefined; endTimestamp?: number; endSupply?: string; mintDecimals: number; supplyDecimals: number; mintAuthority: string; freezeAuthority: string | null | undefined; supply: string; mintContext: number; blockHash: string; endHash: string } = { timestamp: time / 1000, mintDecimals: 9, supplyDecimals: 9,
    mintAuthority: '', freezeAuthority: undefined, supply: '1000000000', mintContext: 20, blockHash: hash, endHash: hash };
  mutations.freezeAuthority = null;
  const mintAccount = (slot: number) => ({ context: { slot }, value: { owner: token, executable: false, data: { parsed: { type: 'mint',
    info: { decimals: mutations.mintDecimals, isInitialized: true, freezeAuthority: mutations.freezeAuthority,
      mintAuthority: mutations.mintAuthority, supply: mutations.supply } } } } });
  const accountMetadata: { program: string; mint: string; owner?: string; state: string; decimals: number; slot: number; amountA?: string } = {
    program: token, mint: fixture.mint, state: 'initialized', decimals: 9, slot: 20,
  };
  const account = (recipient: string, value: string) => ({ context: { slot: accountMetadata.slot }, value: { owner: accountMetadata.program, executable: false, data: { parsed: { type: 'account',
    info: { mint: accountMetadata.mint, owner: accountMetadata.owner ?? recipient, state: accountMetadata.state,
      tokenAmount: { amount: recipient === fixture.recipient ? accountMetadata.amountA ?? value : value, decimals: accountMetadata.decimals } } } } } });
  async function probes(): Promise<void> {
    if (installed) { return; } installed = true;
    // Observe real construction through its public method binding. The returned
    // chains remain real SDK instances; only destroy failure is a controlled mutant.
    const evmModule: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/index.js') = await import(pathToFileURL(root + '/node_modules/@chainlink/ccip-sdk/dist/evm/index.js').href);
    const svmModule: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js') = await import(pathToFileURL(root + '/node_modules/@chainlink/ccip-sdk/dist/solana/index.js').href);
    const evmOriginal = evmModule.EVMChain.prototype.getTransaction;
    Object.defineProperty(evmModule.EVMChain.prototype, 'getTransaction', { configurable: true,
      get(this: EVMChain) { evms.push(this); if (name === 'composition') { const original = this.destroy; this.destroy = () => { evmDestroyed++; original(); }; } return evmOriginal; },
      set(this: EVMChain, value: EVMChain['getTransaction']) { Object.defineProperty(this, 'getTransaction', { configurable: true, writable: true, value }); } });
    const svmOriginal = svmModule.SolanaChain.prototype.getTransaction;
    Object.defineProperty(svmModule.SolanaChain.prototype, 'getTransaction', { configurable: true,
      get(this: SolanaChain) { svms.push(this); if (name === 'composition') { const original = this.destroy; this.destroy = () => { svmDestroyed++; original(); }; } return svmOriginal; },
      set(this: SolanaChain, value: SolanaChain['getTransaction']) { Object.defineProperty(this, 'getTransaction', { configurable: true, writable: true, value }); } });
    const require = createRequire(root + '/package.json');
    const web3: typeof Web3 = require('@solana/web3.js');
    const spl: typeof Spl = require('@solana/spl-token'); native = { web3, spl };
    const { PublicKey } = web3, mint = new PublicKey(fixture.mint);
    const signer = PublicKey.findProgramAddressSync([Buffer.from('ccip_tokenpool_signer'), mint.toBuffer()], new PublicKey(BURNMINT_PROGRAM))[0].toBase58();
    const atas = Object.fromEntries([fixture.recipient, FORWARD_RECIPIENT_B].map(recipient => [recipient,
      spl.getAssociatedTokenAddressSync(mint, new PublicKey(recipient), false, spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()]));
    lane = { fixture, recipientAtas: atas, solanaSigner: signer,
      solanaPoolAta: spl.getAssociatedTokenAddressSync(mint, new PublicKey(signer), true, spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID).toBase58() };
    mutations.mintAuthority = signer;
    parseLogs = (await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/solana/utils.js')).href)).parseSolanaLogs;
    lane.solanaSpender = PublicKey.findProgramAddressSync([Buffer.from('fee_billing_signer')], new PublicKey(ROUTER_PROGRAM))[0].toBase58();
    if (evmDecoders) {
      const abi: typeof import('../../../.local/INPUT/provider/node_modules/ethers/lib.esm/abi/index.js') = await import(pathToFileURL(require.resolve('ethers/abi')).href);
      const sourceAbi: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/abi/OnRamp_1_6.js') = await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/evm/abi/OnRamp_1_6.js')).href);
      const executionAbi: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/abi/OffRamp_1_6.js') = await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/evm/abi/OffRamp_1_6.js')).href);
      sourceLog = new abi.Interface(sourceAbi.default).encodeEventLog('CCIPMessageSent', [BigInt(fixture.forwardSelector), 7n, {
        header: { messageId, sourceChainSelector: BigInt(fixture.reverseSelector), destChainSelector: BigInt(fixture.forwardSelector), sequenceNumber: 7n, nonce: 0n },
        sender: fixture.administrator, data: '0x', receiver: '0x' + '00'.repeat(32), feeToken: '0x' + '00'.repeat(20), feeTokenAmount: 1n, feeValueJuels: 1n,
        extraArgs: evmModule.EVMChain.encodeExtraArgs({ computeUnits: 0n, accountIsWritableBitmap: 0n, allowOutOfOrderExecution: true, tokenReceiver: FORWARD_RECIPIENT_B, accounts: [] }),
        tokenAmounts: [{ sourcePoolAddress: fixture.pool, destTokenAddress: '0x' + mint.toBuffer().toString('hex'), extraData: '0x', amount: 1000000000n, destExecData: '0x00000000' }],
      }]);
      executionLog = new abi.Interface(executionAbi.default).encodeEventLog('ExecutionStateChanged', [BigInt(fixture.forwardSelector), 7n, messageId, hash, 2, '0x', 100n]);
      typeAndVersion = new abi.Interface(['function typeAndVersion() view returns(string)']).encodeFunctionResult('typeAndVersion', ['OnRamp 1.6.0']);
      const u64 = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
      svmExecutionData = Buffer.concat([createHash('sha256').update('event:ExecutionStateChanged').digest().subarray(0, 8),
        u64(BigInt(fixture.reverseSelector)), u64(7n), Buffer.from(messageId.slice(2), 'hex'), Buffer.from(hash.slice(2), 'hex'), Buffer.from([2])]).toString('base64');
    }
    if (name === 'svm-decoders' || reverseCausal) {
      const anchor: typeof import('../../../.local/INPUT/provider/node_modules/@coral-xyz/anchor/dist/cjs/index.js') = require('@coral-xyz/anchor');
      const router: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js') = await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js')).href);
      type Ramp = import('../../../.local/INPUT/provider/node_modules/@coral-xyz/anchor/dist/cjs/index.js').IdlTypes<typeof router.IDL>['SVM2AnyRampMessage'];
      const u64 = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
      const amount = Buffer.alloc(32); amount.writeBigUInt64LE(1000000000n);
      const message: Ramp = { header: { messageId: [...Buffer.from(messageId.slice(2), 'hex')], sourceChainSelector: new anchor.BN(fixture.forwardSelector),
        destChainSelector: new anchor.BN(fixture.reverseSelector), sequenceNumber: new anchor.BN(7), nonce: new anchor.BN(0) }, sender: new PublicKey(fixture.payer),
        data: Buffer.alloc(0), receiver: Buffer.from(fixture.administrator.slice(2), 'hex'),
        extraArgs: Buffer.from(svmModule.SolanaChain.encodeExtraArgs({ gasLimit: 100000n, allowOutOfOrderExecution: true }).slice(2), 'hex'),
        feeToken: new PublicKey(fixture.mint), feeTokenAmount: { leBytes: [...Buffer.alloc(32)] }, feeValueJuels: { leBytes: [...Buffer.alloc(32)] },
        tokenAmounts: [{ sourcePoolAddress: new PublicKey(fixture.solanaPool), destTokenAddress: Buffer.from(fixture.token.slice(2), 'hex'),
          extraData: Buffer.alloc(0), amount: { leBytes: [...amount] }, destExecData: Buffer.from('00000000', 'hex') }] };
      // Controlled bytes encoded with the admitted public IDL/types coder. They
      // prove the real decoder mapping only, never native delivery qualification.
      const encoded = new anchor.BorshCoder(router.IDL).types.encode<Ramp>('SVM2AnyRampMessage', message);
      const discriminator = (name: string) => createHash('sha256').update('event:' + name).digest().subarray(0, 8);
      svmSourceData = Buffer.concat([discriminator('CCIPMessageSent'), u64(BigInt(fixture.reverseSelector)), u64(7n), encoded]).toString('base64');
      svmExecutionData = Buffer.concat([discriminator('ExecutionStateChanged'), u64(BigInt(fixture.reverseSelector)), u64(7n), Buffer.from(messageId.slice(2), 'hex'), Buffer.from(hash.slice(2), 'hex'), Buffer.from([2])]).toString('base64');
    }
  }
  const requests: { url: string; request: Record<string, unknown>; signal: AbortSignal }[] = [], signals: AbortSignal[] = [];
  let blockReads = 0, supplyReads = 0, rateLimited = false;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal);
    signals.push(init.signal);
    const url = String(input);
    if (url.startsWith('https://api.ccip.chain.link')) {
      apiCalls++; assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
      assert.match(url, /^https:\/\/api\.ccip\.chain\.link\/v2\/messages\/0x[0-9a-f]{64}$/);
      if (failedCancellation) {
        physicalReleased = false;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { if (name !== 'causal-cancel-header') { controller.enqueue(new Uint8Array(TEST_RPC_RESPONSE_LIMIT + 1)); } },
          async cancel() { bodyCancelled++; entered.resolve(); if (name === 'causal-cancel-pending') { await body.promise; } throw new Error('Controlled retained physical resource'); },
        }), { status: 404, ...(name === 'causal-cancel-header' ? { headers: { 'content-length': String(TEST_RPC_RESPONSE_LIMIT + 1) } } : {}) });
      }
      if (held) {
        if (name === 'api-error-body') {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array(TEST_RPC_RESPONSE_LIMIT + 1)); },
            async cancel() { bodyCancelled++; entered.resolve(); await body.promise; },
          }), { status: 404 });
        }
        entered.resolve();
        if (name === 'api-headers' || name === 'deadline') { return header.promise; }
        return new Response(new ReadableStream<Uint8Array>({ async start(controller) { await body.promise; controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } }), { status: 404 });
      }
      return evmDecoders ? new Response(json(reverseCausal ? { ...apiResponse, offramp: offRamp, receiptTransactionHash: executionHash } : apiResponse)) : new Response('{}', { status: 404 });
    }
    assert.ok(url === DEFAULT_SEPOLIA_RPC + '/' || url === DEFAULT_SOLANA_RPC + '/');
    assert.equal(init.method, 'POST'); assert.equal(typeof init.body, 'string');
    const payload: unknown = JSON.parse(String(init.body));
    const rows: unknown[] = Array.isArray(payload) ? payload : [payload];
    const replies: Record<string, unknown>[] = [];
    for (const raw of rows) {
      const r = object(raw); requests.push({ url, request: r, signal: init.signal });
      assert.ok(Array.isArray(r.params)); const params: readonly unknown[] = r.params;
      if (r.method === 'eth_chainId') { await probes(); }
      if (name === 'partial' && r.method === 'getGenesisHash') {
        const chain = evms[0]; assert.ok(chain); const original = chain.destroy; chain.destroy = () => { evmDestroyed++; original(); };
        throw new Error('Controlled second-constructor failure');
      }
      if (name === 'retry' && r.method === 'getSlot' && !rateLimited) { rateLimited = true; return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: 429, message: 'Controlled read rate limit' } }), { status: 429, headers: { 'retry-after': '10' } }); }
      if (mutateReply && r.method === 'getSlot') {
        const reply = { jsonrpc: '2.0', id: name === 'rpc-reply-id' ? 'unrequested' : r.id, result: 20 };
        return new Response(JSON.stringify(name === 'rpc-reply-batch' ? [reply] : reply), { status: name === 'rpc-redirect' ? 302 : 200 });
      }
      if (held && (r.method === 'getSlot' || r.method === 'eth_getTransactionReceipt')) {
        entered.resolve();
        if (name === 'native-body' || name === 'sdk-body') {
          return new Response(new ReadableStream<Uint8Array>({ async start(controller) { await body.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: r.method === 'getSlot' ? 20 : null }))); controller.close(); } }));
        }
      }
      let result: unknown;
      switch (r.method) {
        case 'eth_chainId': result = '0xaa36a7'; break;
        case 'getGenesisHash': result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'; break;
        case 'getSlot': result = 20; break;
        case 'getTransaction': {
          if (causal || reverseCausal) {
            assert.ok(lane?.recipientAtas);
            const ata = present(lane.recipientAtas[reverseCausal ? fixture.recipient : FORWARD_RECIPIENT_B]), data = present(reverseCausal ? svmSourceData : svmExecutionData);
            if (reverseCausal) {
              const transfer = { programId: token, stackHeight: 2, parsed: { type: 'transferChecked', info: { mint: fixture.mint, source: ata,
                destination: lane.solanaPoolAta, authority: lane.solanaSpender, tokenAmount: { amount: fixture.amount, decimals: 9 } } } };
              const pool = { programId: BURNMINT_PROGRAM, stackHeight: 2 };
              const burn = { programId: token, stackHeight: 3, parsed: { type: 'burn', info: { mint: fixture.mint, account: lane.solanaPoolAta, authority: lane.solanaSigner, amount: fixture.amount } } };
              const logs = cpiMutant === 'split' ? ['Program ' + ROUTER_PROGRAM + ' invoke [1]', 'Program ' + token + ' invoke [2]', 'Program ' + token + ' success',
                ...Array<string>(4).fill('Program log: execution'), 'Program data: ' + data, 'Program ' + ROUTER_PROGRAM + ' success',
                'Program ' + ROUTER_PROGRAM + ' invoke [1]', 'Program ' + BURNMINT_PROGRAM + ' invoke [2]', 'Program ' + token + ' invoke [3]',
                'Program ' + token + ' success', 'Program ' + BURNMINT_PROGRAM + ' success', 'Program ' + ROUTER_PROGRAM + ' success'] :
                ['Program ' + ROUTER_PROGRAM + ' invoke [1]', 'Program ' + token + ' invoke [2]', 'Program ' + token + ' success',
                'Program ' + BURNMINT_PROGRAM + ' invoke [2]', 'Program ' + token + ' invoke [3]', 'Program ' + token + ' success',
                'Program ' + BURNMINT_PROGRAM + ' success', 'Program data: ' + data, 'Program ' + ROUTER_PROGRAM + ' success', 'Program ' + fixture.payer + ' invoke [1]', 'Program ' + fixture.payer + ' success'];
              const balance = (accountIndex: number, owner: string, amount: string) => ({ accountIndex, mint: fixture.mint, owner, programId: token, uiTokenAmount: { amount, decimals: 9 } });
              result = object(params[1]).encoding === 'jsonParsed' ? {
                slot: 20, transaction: { signatures: [params[0]], message: { accountKeys: [ata, lane.solanaPoolAta, { pubkey: fixture.payer, signer: true }],
                  instructions: [{ programId: ROUTER_PROGRAM }, { programId: cpiMutant === 'split' ? ROUTER_PROGRAM : fixture.payer }] } },
                meta: { err: null, logMessages: logs, innerInstructions: cpiMutant ? [{ index: 0, instructions: [transfer] }, { index: 1, instructions: [pool, burn] }] :
                  [{ index: 0, instructions: [transfer, pool, burn] }], preTokenBalances: [balance(0, fixture.recipient, fixture.amount), balance(1, present(lane.solanaSigner), '0')],
                  postTokenBalances: [balance(0, fixture.recipient, '0'), balance(1, present(lane.solanaSigner), '0')] },
              } : {
                slot: 20, blockTime: time / 1000, version: 0,
                transaction: { signatures: [params[0]], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
                  accountKeys: [fixture.payer, ROUTER_PROGRAM], recentBlockhash: fixture.mint, instructions: [], addressTableLookups: [] } },
                meta: { err: null, fee: 1, preBalances: [1,1], postBalances: [1,1], innerInstructions: [], preTokenBalances: [], postTokenBalances: [],
                  loadedAddresses: { writable: [], readonly: [] }, logMessages: logs },
              }; break;
            }
            const progressBytes = Buffer.from(data, 'base64'); progressBytes[progressBytes.length - 1] = 1;
            let eventLogs = ['Program ' + svmOffRamp + ' invoke [1]', 'Program data: ' + progressBytes.toString('base64'), 'Program ' + BURNMINT_PROGRAM + ' invoke [2]',
              'Program ' + token + ' invoke [3]', 'Program ' + token + ' success', 'Program ' + BURNMINT_PROGRAM + ' success',
              'Program data: ' + data, 'Program ' + svmOffRamp + ' success', 'Program ' + fixture.payer + ' invoke [1]', 'Program ' + fixture.payer + ' success'];
            const inner: MintInstruction[] = [{ programId: BURNMINT_PROGRAM, stackHeight: 2 }, { programId: token, stackHeight: 3,
              parsed: { type: 'mintTo', info: { mint: fixture.mint, account: ata, amount: fixture.amount, mintAuthority: present(lane.solanaSigner) } } }];
            if (cpiMutant === 'depth') { present(inner[1]).stackHeight = 2; }
            if (cpiMutant === 'missing-height') { Reflect.deleteProperty(present(inner[1]), 'stackHeight'); }
            if (cpiMutant === 'trace-truncated') { eventLogs.pop(); }
            if (cpiMutant === 'split') {
              eventLogs = ['Program ' + svmOffRamp + ' invoke [1]', ...Array<string>(5).fill('Program log: execution'), 'Program data: ' + data,
                'Program ' + svmOffRamp + ' success', 'Program ' + svmOffRamp + ' invoke [1]', 'Program ' + BURNMINT_PROGRAM + ' invoke [2]',
                'Program ' + token + ' invoke [3]', 'Program ' + token + ' success', 'Program ' + BURNMINT_PROGRAM + ' success', 'Program ' + svmOffRamp + ' success'];
            }
            const balance = (amount: string) => ({ accountIndex: 0, mint: fixture.mint, owner: FORWARD_RECIPIENT_B, programId: token, uiTokenAmount: { amount, decimals: 9 } });
            const config = object(params[1]);
            result = config.encoding === 'jsonParsed' ? {
              slot: 20, transaction: { signatures: [params[0]], message: { accountKeys: [ata], instructions: [{ programId: svmOffRamp }, { programId: cpiMutant === 'split' ? svmOffRamp : fixture.payer }] } },
              meta: { err: null, logMessages: eventLogs, innerInstructions: [{ index: ['parent', 'split'].includes(cpiMutant) ? 1 : 0, instructions: inner }],
                preTokenBalances: [balance('0')], postTokenBalances: [balance(fixture.amount)] },
            } : {
              slot: 20, blockTime: time / 1000, version: 0,
              transaction: { signatures: [params[0]], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
                accountKeys: [fixture.payer, svmOffRamp], recentBlockhash: fixture.mint, instructions: [], addressTableLookups: [] } },
              meta: { err: null, fee: 1, preBalances: [1,1], postBalances: [1,1], innerInstructions: [], preTokenBalances: [], postTokenBalances: [],
                loadedAddresses: { writable: [], readonly: [] }, logMessages: eventLogs },
            }; break;
          }
          assert.equal(name, 'svm-decoders');
          const execution = params[0] === '2'.repeat(87), program = execution ? BURNMINT_PROGRAM : ROUTER_PROGRAM;
          result = { slot: 20, blockTime: time / 1000, version: 0,
            transaction: { signatures: [params[0]], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
              accountKeys: [fixture.payer, program], recentBlockhash: fixture.mint, instructions: [], addressTableLookups: [] } },
            meta: { err: null, fee: 1, preBalances: [1, 1], postBalances: [1, 1], innerInstructions: [], preTokenBalances: [], postTokenBalances: [],
              loadedAddresses: { writable: [], readonly: [] }, logMessages: ['Program ' + program + ' invoke [1]', 'Program data: ' + present(execution ? svmExecutionData : svmSourceData), 'Program ' + program + ' success'] } };
          break;
        }
        case 'simulateTransaction': {
          assert.ok(name === 'svm-decoders' || reverseCausal);
          const config = object(params[1]); assert.equal(config.sigVerify, false); assert.equal(config.replaceRecentBlockhash, true);
          assert.equal(config.commitment, 'confirmed'); assert.equal(config.encoding, 'base64');
          const label = Buffer.from('CCIP Router 1.6.0'), length = Buffer.alloc(4); length.writeUInt32LE(label.length);
          const encoded = Buffer.concat([length, label]).toString('base64');
          result = { context: { slot: 20 }, value: { err: null, logs: ['Program return: ' + ROUTER_PROGRAM + ' ' + encoded], unitsConsumed: 1,
            returnData: { programId: ROUTER_PROGRAM, data: [encoded, 'base64'] } } }; break;
        }
        case 'eth_getTransactionReceipt': {
          if (!evmDecoders) { result = null; break; }
          const txHash = String(params[0]);
          const rawLog = (address: string, event: { data: string; topics: string[] }, index: number) => ({ address, ...event,
            logIndex: '0x' + index.toString(16), transactionHash: txHash, blockHash: hash, blockNumber: '0xa', transactionIndex: '0x0', removed: false });
          result = { transactionHash: txHash, blockHash: hash, blockNumber: '0xa', transactionIndex: '0x0', from: fixture.administrator,
            to: '0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59', status: '0x1', type: '0x0', cumulativeGasUsed: '0x10000', gasUsed: '0x10000', effectiveGasPrice: '0x1', logsBloom: '0x' + '00'.repeat(256),
            logs: txHash === executionHash ? [rawLog(offRamp, present(executionLog), 0), ...(reverseCausal ? [rawLog(fixture.token, {
              topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + fixture.pool.slice(2).padStart(64, '0'),
                '0x' + fixture.administrator.slice(2).padStart(64, '0')], data: '0x' + (1000000000n).toString(16).padStart(64, '0') }, 1)] : [])] : [
              rawLog(fixture.token, { topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                '0x' + fixture.administrator.slice(2).padStart(64, '0'), '0x' + fixture.pool.slice(2).padStart(64, '0')], data: '0x' + (1000000000n).toString(16).padStart(64, '0') }, 0), rawLog(onRamp, present(sourceLog), 1)] };
          break;
        }
        case 'eth_getTransactionByHash': result = { hash: params[0], chainId: '0xaa36a7', from: fixture.administrator,
          to: '0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59', input: '0x1234', value: '0x0', nonce: '0x5', blockHash: hash, blockNumber: '0xa' }; break;
        case 'eth_getCode': result = '0x1234'; break;
        case 'eth_getBlockByNumber': {
          const repeated = blockReads++ % 2 === 1, timestamp = repeated && mutations.endTimestamp !== undefined ? mutations.endTimestamp : mutations.timestamp;
          result = { ...(evmDecoders ? { parentHash: hash, nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1000000', gasUsed: '0x10000', miner: fixture.administrator, extraData: '0x', transactions: [] } : {}),
            hash: repeated ? mutations.endHash : mutations.blockHash, number: '0xa', ...(timestamp === undefined ? {} : { timestamp: timestamp === null ? null : '0x' + timestamp.toString(16) }) }; break;
        }
        case 'eth_call': {
          const call = object(params[0]); if (evmDecoders && call.to === onRamp) { result = typeAndVersion; break; } if (reverseCausal && params[1] === 'finalized') { result = '0x1'; break; } assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true });
          result = '0x' + (call.data === '0x18160ddd' ? 100000000000n : call.data === '0x313ce567' ? 9n : 1000000000n).toString(16).padStart(64, '0'); break;
        }
        case 'getAccountInfo': {
          assert.ok(lane?.recipientAtas);
          if (causal && params[0] !== fixture.mint && !Object.values(lane.recipientAtas).includes(String(params[0]))) {
            result = { context: { slot: 20 }, value: params[0] === svmOffRamp ? { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, data: ['', 'base64'] } :
              { owner: ROUTER_PROGRAM, executable: false, data: [createHash('sha256').update('account:AllowedOfframp').digest().subarray(0, 8).toString('base64'), 'base64'] } }; break;
          }
          if (params[0] === fixture.mint) { result = mintAccount(mutations.mintContext); }
          else {
            const recipient = [fixture.recipient, FORWARD_RECIPIENT_B].find(owner => lane?.recipientAtas?.[owner] === params[0]);
            assert.ok(recipient); result = account(recipient, recipient === FORWARD_RECIPIENT_B ? '1000000000' : '0');
          } break;
        }
        case 'getSignatureStatuses': result = { context: { slot: 20 }, value: [{ slot: 20, err: null, confirmationStatus: 'finalized' }] }; break;
        case 'getBlock': result = { blockhash: fixture.mint, signatures: ['1'.repeat(64)] }; break;
        case 'getTokenSupply': result = { context: { slot: 20 }, value: { amount: supplyReads++ % 2 === 1 ? mutations.endSupply ?? mutations.supply : mutations.supply, decimals: mutations.supplyDecimals } }; break;
        case 'getBlockTime': result = mutations.timestamp ?? null; break;
        default: throw new Error('Unexpected controlled unit RPC: ' + String(r.method));
      }
      replies.push({ jsonrpc: '2.0', id: r.id, result });
    }
    return new Response(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
  };
  globalThis.fetch = () => { globalFetchAttempts++; throw new Error('Uninjected global fetch forbidden'); };
  const selection: ExplicitTestSdkSelection = { providerProfile: TEST_SDK_PROFILE, testOnly: true, fixture, fixtureIdentity: fixture.identity, providerArchives: archives };
  const delays: number[] = [];
  const wait = async (delay: number, signal?: AbortSignal) => { assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false); delays.push(delay); };
  const options = { wait, directory: root, selection,
    sepolia: DEFAULT_SEPOLIA_RPC, solana: DEFAULT_SOLANA_RPC, fetcher, now: () => time, logger };
  if (name === 'partial') {
    await assert.rejects(createTestSdkStatus(options), /second-constructor/);
    assert.equal(evmDestroyed, 1); assert.equal(evms[0]?.abort.aborted, true); assert.equal(testSdkCounters()?.closed, true); process.stdout.write(JSON.stringify({ scenario: name, qualification: 'UNQUALIFIED', evidence: 'controlled-native-unit' }) + '\n'); return;
  }
  if (name === 'composition') {
    const phases: (boolean | undefined)[] = [];
    const result = await runStatus({ ...selection, sdkDirectory: root, replayFetch: fetcher, transfers: [], completeFixtureInventory: true }, () => { phases.push(testSdkCounters()?.closed); return time; });
    assert.deepEqual(phases, [false, true]); assert.equal(result.readOnly, true); assert.equal(result.accounting.status, 'unknown');
    assert.equal(evmDestroyed, 1); assert.equal(svmDestroyed, 1); assert.equal(globalFetchAttempts, 0);
    process.stdout.write(JSON.stringify({ scenario: name, qualification: 'UNQUALIFIED', evidence: 'controlled-native-unit' }) + '\n'); return;
  }
  const ports = await createTestSdkStatus(options);
  assert.ok(native && lane?.recipientAtas); assert.equal(evms.length, 1); assert.equal(svms.length, 1);
  const evm = evms[0], svm = svms[0]; assert.ok(evm && svm);
  assert.equal(evm.apiClient, svm.apiClient); assert.equal(evm.apiClient?.timeoutMs, 20000);
  const evmDestroy = evm.destroy, svmDestroy = svm.destroy;
  evm.destroy = () => { evmDestroyed++; evmDestroy(); if (name === 'cleanup-failure') { throw new Error('Controlled acquired chain cleanup failure'); } };
  svm.destroy = () => { svmDestroyed++; svmDestroy(); };
  assert.equal('destroy' in ports.chains.ethereum, false); assert.equal('provider' in ports.chains.ethereum, false);
  assert.equal('sign' in ports.native, false); assert.equal('web3' in ports.native, false); assert.equal('Keypair' in ports, false);
  if (name === 'byte-utf8' || name === 'byte-limit') {
    // The ESM SDK imports ethers' ESM public entry, so mutate that actual class
    // rather than the separate CommonJS class selected by require.resolve.
    const utils: typeof import('../../../.local/INPUT/provider/node_modules/ethers/lib.esm/utils/index.js') = await import(pathToFileURL(root + '/node_modules/ethers/lib.esm/utils/index.js').href);
    const original = Object.getOwnPropertyDescriptor(utils.FetchRequest.prototype, 'body'); assert.ok(original);
    Object.defineProperty(utils.FetchRequest.prototype, 'body', { ...original, get() { return name === 'byte-utf8' ? new Uint8Array([0xc3, 0x28]) : new Uint8Array(TEST_RPC_RESPONSE_LIMIT + 1); } });
    const previous = calls;
    try { await assert.rejects(ports.chains.ethereum.getMessagesInTx(sourceHash), name === 'byte-utf8' ? /UTF-8/ : /bytes exceed bound/); assert.equal(calls, previous); }
    finally { Object.defineProperty(utils.FetchRequest.prototype, 'body', original); }
  } else if (name === 'retry') {
    assert.equal((await ports.native.snapshot()).coherent, true); assert.deepEqual(delays, [10000]);
    const retried = requests.filter(row => row.request.method === 'getSlot'); assert.equal(retried.length, 2);
    assert.deepEqual(retried[0]?.request, retried[1]?.request);
  } else if (['rpc-reply-id', 'rpc-reply-batch', 'rpc-redirect'].includes(name)) {
    assert.equal((await ports.native.snapshot()).coherent, true);
    mutateReply = true;
    await assert.rejects(ports.native.snapshot(), name === 'rpc-reply-id' ? /response envelope/ : name === 'rpc-reply-batch' ? /response batch/ : /redirected/);
  } else if (name === 'api-error-body') {
    await assert.rejects(ports.api.getMessageById(messageId, { signal: new AbortController().signal }), error => error instanceof Error && 'code' in error && error.code === 'MESSAGE_ID_NOT_FOUND');
    held = true;
    const operation = ports.api.getMessageById(messageId, { signal: new AbortController().signal });
    const outcome = operation.then(() => { throw new Error('Over-bound API error body accepted'); }, error => error);
    await entered.promise; assert.equal(bodyCancelled, 1);
    const close = ports.destroy(); let settled = false; void close.then(() => { settled = true; });
    await ticks(); assert.equal(settled, false); assert.equal(testSdkCounters()?.closed, false);
    body.resolve(); const error: unknown = await outcome; assert.ok(error instanceof Error); assert.match(error.message, /response exceeds byte bound/);
    await close;
  } else if (reverseCausal) {
    const transfer = { direction: 'solana-to-ethereum' as const, sourceHash: '1'.repeat(64), recipient: fixture.recipient,
      destinationReceipt: { transactionHash: executionHash, offRamp } };
    await ports.native.authorizeOffRamp('ethereum', offRamp, BigInt(fixture.forwardSelector));
    assert.equal((await ports.chains.ethereum.getExecutionReceiptInTx(executionHash, { offRamp, messageId, sourceChainSelector: BigInt(fixture.forwardSelector) })).receipt.state, ports.successState);
    assert.equal((await ports.native.ethereum(executionHash, 'release')).eventIndex, 1);
    const positive = await inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState);
    assert.equal(positive.status, 'settled'); assert.equal(positive.pendingAmount, 0n); assert.equal(positive.events[0]?.eventIndex, 3);
    for (const mutant of ['parent', 'split']) {
      cpiMutant = mutant;
      await assert.rejects(ports.native.solana(transfer.sourceHash, 'burn', fixture.recipient), /invocation|coordinates|execution/);
      await assert.rejects(inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState), /invocation|coordinates|execution/);
      process.stdout.write(JSON.stringify({ probe: 'U2-reverse', mutant, positive: positive.status, rejected: true }) + '\n');
    }
    cpiMutant = '';
    await assert.rejects(ports.native.solana(transfer.sourceHash, 'burn', FORWARD_RECIPIENT_B), /B reverse/);
    assert.equal((await inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState)).status, 'settled');
  } else if (causal) {
    const transfer = { direction: 'ethereum-to-solana' as const, sourceHash, recipient: FORWARD_RECIPIENT_B,
      destinationReceipt: { transactionHash: '1'.repeat(64), offRamp: svmOffRamp } };
    const positive = await inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState);
    assert.equal(positive.status, 'settled'); assert.equal(positive.pendingAmount, 0n); assert.equal(positive.events[1]?.eventIndex, 2);
    assert.equal((await ports.native.solana('1'.repeat(64), 'mint', FORWARD_RECIPIENT_B)).eventIndex, 2);
    if (name === 'causal-cpi') {
      for (const mutant of ['parent', 'split', 'depth', 'missing-height', 'trace-truncated']) {
        cpiMutant = mutant;
        await assert.rejects(ports.native.solana('1'.repeat(64), 'mint', FORWARD_RECIPIENT_B), /invocation|coordinates|ancestry|execution/);
        const rejected = await inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState);
        assert.equal(rejected.status, 'pending'); assert.equal(rejected.pendingAmount, null); assert.equal(rejected.events.length, 1);
        process.stdout.write(JSON.stringify({ probe: 'U2', mutant, positive: positive.status, rejected: rejected.status, pendingUnknown: rejected.pendingAmount === null }) + '\n');
      }
      cpiMutant = '';
      assert.equal((await inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState)).status, 'settled');
    } else {
      failedCancellation = true;
      const inspection = inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState);
      await entered.promise;
      // Refusal must already be latched while the physical cancel is still pending.
      const before = calls;
      assert.throws(() => ports.native.snapshot(), /byte bound|over-bound/); assert.equal(calls, before);
      body.resolve();
      const rejected = await inspection;
      assert.equal(rejected.status, 'pending'); assert.equal(rejected.pendingAmount, null); assert.equal(physicalReleased, false);
      const close = ports.destroy(); assert.equal(close, ports.destroy());
      await assert.rejects(close, /physical cancellation/);
      assert.equal(testSdkCounters()?.closed, false); assert.equal(evmDestroyed, 1); assert.equal(svmDestroyed, 1); assert.equal(globalFetchAttempts, 0);
      process.stdout.write(JSON.stringify({ probe: 'U1', scenario: name, qualification: 'UNQUALIFIED', positive: positive.status, rejected: rejected.status,
        physicalReleased, cleanupRejected: true, hooksClosed: testSdkCounters()?.closed, bodyCancelled }) + '\n'); return;
    }
  } else if (name === 'decoders') {
    const requests = await ports.chains.ethereum.getMessagesInTx(sourceHash);
    assert.equal(requests.length, 1); const request = present(requests[0]);
    assert.equal(request.message.tokenReceiver, FORWARD_RECIPIENT_B); assert.equal(request.message.sequenceNumber, 7n);
    assert.equal(request.message.tokenAmounts[0]?.amount, 1000000000n);
    assert.equal(matchRequest(request, 'ethereum-to-solana', sourceHash, FORWARD_RECIPIENT_B, fixture), true);
    assert.equal(matchRequest({ ...request, message: { ...request.message, tokenReceiver: fixture.recipient } }, 'ethereum-to-solana', sourceHash, FORWARD_RECIPIENT_B, fixture), false);
    const receipt = await ports.chains.ethereum.getExecutionReceiptInTx(executionHash, { offRamp, messageId, sourceChainSelector: BigInt(fixture.forwardSelector) });
    assert.equal(receipt.receipt.sequenceNumber, 7n); assert.equal(receipt.receipt.state, ports.successState);
    assert.equal(receipt.log.transactionHash, executionHash);
    await assert.rejects(ports.chains.ethereum.getExecutionReceiptInTx(executionHash, { offRamp, messageId: '0x' + 'ff'.repeat(32), sourceChainSelector: BigInt(fixture.forwardSelector) }));
    const found = await ports.api.getMessageById(messageId, { signal: new AbortController().signal }); assert.equal(found.metadata?.status, 'SUCCESS');
    const result = await inspectTransfer({ direction: 'ethereum-to-solana', sourceHash, recipient: FORWARD_RECIPIENT_B }, ports.chains, ports.native, ports.api, ports.successState);
    assert.equal(result.status, 'pending'); assert.equal(result.pendingAmount, null); assert.equal(result.events.length, 1); assert.match(result.destinationError ?? '', /unproven/);
  } else if (name === 'svm-decoders' || reverseCausal) {
    const messages = await ports.chains.solana.getMessagesInTx('1'.repeat(64));
    assert.equal(messages.length, 1); const message = present(messages[0]);
    assert.equal(message.message.sourceChainSelector, BigInt(fixture.forwardSelector)); assert.equal(message.message.sequenceNumber, 7n);
    assert.equal(message.message.tokenAmounts[0]?.sourcePoolAddress, fixture.solanaPool);
    assert.equal(matchRequest(message, 'solana-to-ethereum', '1'.repeat(64), fixture.recipient, fixture), true);
    const filters = { offRamp: BURNMINT_PROGRAM, messageId, sourceChainSelector: BigInt(fixture.reverseSelector) };
    const receipt = await ports.chains.solana.getExecutionReceiptInTx('2'.repeat(87), filters);
    assert.equal(receipt.receipt.state, ports.successState); assert.equal(receipt.receipt.sequenceNumber, 7n); assert.equal(receipt.log.address, BURNMINT_PROGRAM);
    await assert.rejects(ports.chains.solana.getExecutionReceiptInTx('2'.repeat(87), { ...filters, messageId: '0x' + 'ff'.repeat(32) }));
    assert.equal(requests.filter(row => row.request.method === 'simulateTransaction').length, 1);
  } else if (name === 'observer') {
    const result = await ports.native.snapshot();
    assert.equal(result.coherent, true); assert.equal(result.fixtureIdentity, fixture.identity); assert.equal(result.decimals, 9);
    assert.equal(result.ethereumBlock, hash); assert.equal(result.observedAt, new Date(time).toISOString());
    assert.equal(result.fixedSupply, 100000000000n); assert.equal(result.lockedOnEthereum, 1000000000n); assert.equal(result.supplyOnSolana, 1000000000n);
    assert.notEqual(lane.recipientAtas[fixture.recipient], lane.recipientAtas[FORWARD_RECIPIENT_B]);
    assert.notEqual(lane.recipientAtas[FORWARD_RECIPIENT_B], FORWARD_RECIPIENT_B_ATA);
    const accountRequests = requests.filter(row => row.request.method === 'getAccountInfo').map(row => row.request.params);
    assert.ok(accountRequests.some(params => Array.isArray(params) && params[0] === lane?.recipientAtas?.[FORWARD_RECIPIENT_B]));
    for (const recipient of [fixture.recipient, FORWARD_RECIPIENT_B]) {
      const ata: string | undefined = lane.recipientAtas[recipient]; assert.ok(ata);
      const data = Buffer.alloc(16).toString('base64');
      const tx: MintTransaction = { transaction: { message: { accountKeys: [ata], instructions: [{ programId: svmOffRamp }, { programId: fixture.payer }] } }, meta: {
        logMessages: ['Program ' + svmOffRamp + ' invoke [1]', 'Program ' + BURNMINT_PROGRAM + ' invoke [2]', 'Program ' + token + ' invoke [3]', 'Program ' + token + ' success', 'Program ' + BURNMINT_PROGRAM + ' success', 'Program data: ' + data, 'Program ' + svmOffRamp + ' success'],
        innerInstructions: [{ index: 0, instructions: [{ programId: BURNMINT_PROGRAM, stackHeight: 2 }, { programId: token, stackHeight: 3, parsed: { type: 'mintTo', info: { mint: fixture.mint, account: ata, amount: '1000000000', mintAuthority: present(lane.solanaSigner) } } }] }],
        preTokenBalances: [{ accountIndex: 0, mint: fixture.mint, owner: recipient, programId: token, uiTokenAmount: { amount: '0', decimals: 9 } }],
        postTokenBalances: [{ accountIndex: 0, mint: fixture.mint, owner: recipient, programId: token, uiTokenAmount: { amount: '1000000000', decimals: 9 } }] } };
      const event = present(present(parseLogs)(tx.meta.logMessages).find(log => log.type === 'data'));
      const invocation: InvocationLog = { ...event, transactionHash: '1'.repeat(64) };
      assert.equal(solanaEffect(tx, 'mint', recipient, ata, lane, invocation), 2);
      const early = structuredClone(tx); early.meta.logMessages.splice(5, 1); early.meta.logMessages.splice(1, 0, 'Program data: ' + data);
      const earlyEvent = present(present(parseLogs)(early.meta.logMessages).find(log => log.type === 'data'));
      assert.throws(() => solanaEffect(early, 'mint', recipient, ata, lane, { ...earlyEvent, transactionHash: '1'.repeat(64) }), /effect\/event order/);
      for (const mutate of [
        (t: typeof tx) => { present(t.meta.postTokenBalances[0]).owner = 'wrong'; },
        (t: typeof tx) => { present(present(t.meta.innerInstructions[0]).instructions[0]).programId = 'wrong'; },
        (t: typeof tx) => { present(present(present(t.meta.innerInstructions[0]).instructions[1]).parsed).info.mint = '13Q74er9thh3my9oACjChDhtn4znJibWBp1u8q1rAYau'; },
        (t: typeof tx) => { present(t.meta.preTokenBalances[0]).uiTokenAmount.decimals = 8; },
        (t: typeof tx) => { present(t.meta.postTokenBalances[0]).programId = 'wrong'; },
        (t: typeof tx) => { present(t.meta.postTokenBalances[0]).uiTokenAmount.decimals = 8; },
        (t: typeof tx) => { present(present(present(t.meta.innerInstructions[0]).instructions[1]).parsed).info.mintAuthority = 'wrong'; },
        (t: typeof tx) => { present(present(present(t.meta.innerInstructions[0]).instructions[1]).parsed).info.account = FORWARD_RECIPIENT_B_ATA; },
        (t: typeof tx) => { present(t.meta.innerInstructions[0]).instructions.push(present(present(t.meta.innerInstructions[0]).instructions[1])); },
        (t: typeof tx) => { present(t.meta.innerInstructions[0]).index = 9; },
        (t: typeof tx) => { present(t.meta.postTokenBalances[0]).uiTokenAmount.amount = '2000000000'; },
        (t: typeof tx) => { t.meta.postTokenBalances.push(present(t.meta.postTokenBalances[0])); },
      ]) { const changed = structuredClone(tx); mutate(changed); assert.throws(() => solanaEffect(changed, 'mint', recipient, ata, lane, invocation)); }
    }
    mutations.endHash = '0x' + 'cd'.repeat(32); assert.equal((await ports.native.snapshot()).coherent, false); mutations.endHash = hash;
    mutations.endTimestamp = time / 1000 - 1; assert.equal((await ports.native.snapshot()).coherent, false); delete mutations.endTimestamp;
    mutations.endSupply = '2000000000'; assert.equal((await ports.native.snapshot()).coherent, false); delete mutations.endSupply;
    accountMetadata.amountA = '1000000000'; assert.equal((await ports.native.snapshot()).coherent, false);
    delete accountMetadata.amountA; assert.equal((await ports.native.snapshot()).coherent, true);
    mutations.mintContext = 19; assert.equal((await ports.native.snapshot()).coherent, false); mutations.mintContext = 20;
    mutations.timestamp = undefined; assert.equal((await ports.native.snapshot()).coherent, false);
    mutations.timestamp = null; assert.equal((await ports.native.snapshot()).coherent, false);
    mutations.timestamp = time / 1000 + 1; assert.equal((await ports.native.snapshot()).coherent, false);
    mutations.timestamp = time / 1000 - 301; assert.equal((await ports.native.snapshot()).coherent, false); mutations.timestamp = time / 1000;
    mutations.mintDecimals = 8; await assert.rejects(ports.native.snapshot(), /mint identity/); mutations.mintDecimals = 9;
    mutations.freezeAuthority = fixture.payer; await assert.rejects(ports.native.snapshot(), /mint identity/); mutations.freezeAuthority = null;
    mutations.mintAuthority = fixture.payer; await assert.rejects(ports.native.snapshot(), /mint identity/); mutations.mintAuthority = lane.solanaSigner ?? '';
    for (const changed of [
      { program: BURNMINT_PROGRAM }, { mint: fixture.payer }, { owner: FORWARD_RECIPIENT_B },
      { state: 'frozen' }, { decimals: 8 }, { slot: 19 },
    ]) {
      const original = { ...accountMetadata };
      Object.assign(accountMetadata, changed);
      await assert.rejects(ports.native.snapshot(), /recipient account metadata/);
      Object.assign(accountMetadata, original); delete accountMetadata.owner;
    }
    assert.equal((await ports.native.snapshot()).coherent, true, 'Metadata controls recover after each independent mutation');
    await assert.rejects(ports.api.getMessageById('0x' + '11'.repeat(32), { signal: new AbortController().signal }), error => error instanceof Error && 'code' in error && error.code === 'MESSAGE_ID_NOT_FOUND');
    await assert.rejects(ports.api.getMessageById('0x' + '11'.repeat(32), { signal: new AbortController().signal }), error => error instanceof Error && 'code' in error && error.code === 'MESSAGE_ID_NOT_FOUND');
    assert.equal(apiCalls, 2, 'Fresh API discovery must not hit SDK memoization');
    assert.ok(supplyReads >= 2);
  } else if (['api-headers', 'api-body', 'native-body', 'sdk-body', 'deadline'].includes(name)) {
    held = true;
    const operation = name === 'native-body' ? ports.native.snapshot() : name === 'sdk-body' ? ports.chains.ethereum.getMessagesInTx('0x' + '11'.repeat(32)) :
      ports.api.getMessageById('0x' + '11'.repeat(32), { signal: new AbortController().signal });
    const operationOutcome = operation.then(() => 'resolved', () => 'rejected');
    await entered.promise;
    if (name === 'deadline') { mock.timers.enable({ apis: ['setTimeout'] }); }
    const close = ports.destroy(); assert.equal(ports.destroy(), close);
    const closedCalls = calls;
    assert.throws(() => ports.native.snapshot(), /lifetime closed/); assert.equal(calls, closedCalls);
    let settled = false; void close.then(() => { settled = true; }, () => { settled = true; });
    await ticks(); assert.equal(settled, false); assert.equal(testSdkCounters()?.closed, false);
    assert.equal(evmDestroyed, 1); assert.equal(svmDestroyed, 1); assert.ok(signals.every(signal => signal.aborted));
    if (name === 'deadline') { mock.timers.tick(20_000); await assert.rejects(close, /Unresolved TEST status drain/); assert.equal(testSdkCounters()?.closed, false); mock.timers.reset(); }
    held = false; header.resolve(new Response('{}', { status: 404 })); body.resolve();
    await operationOutcome;
    if (name !== 'deadline') { await close; } else { await ticks(); assert.equal(testSdkCounters()?.closed, true); }
  } else if (name === 'cleanup-failure') {
    await assert.rejects(ports.destroy(), /chain cleanup failed/); assert.equal(evmDestroyed, 1); assert.equal(svmDestroyed, 1);
  } else if (name === 'unexpected') {
    const previous = calls;
    await assert.rejects(ports.api.getMessageById('../execution-inputs', { signal: new AbortController().signal }), /Unexpected TEST status API/);
    assert.equal(calls, previous);
  } else { throw new Error('Unknown native unit scenario'); }
  if (name !== 'deadline' && name !== 'cleanup-failure') { const close = ports.destroy(); assert.equal(ports.destroy(), close); await close; }
  assert.equal(testSdkCounters()?.closed, true); assert.equal(evmDestroyed, 1); assert.equal(svmDestroyed, 1);
  assert.equal(globalFetchAttempts, 0);
  process.stdout.write(JSON.stringify({ scenario: name, qualification: 'UNQUALIFIED', evidence: 'controlled-native-unit', networkEffects: 0, signingEffects: 0, calls }) + '\n');
}
// Exercise runStatus's actual absent-profile assembly, not just a lane supplied
// directly to createNativeStatus. The retained installation has TEST root/lock
// bytes, so the unmodified legacy pin refuses it. Only that installation check
// and EVM's older string-body transport boundary are controlled below. Real
// public SDK constructors, transactions, official decoders, native ancestry,
// collection, cleanup and finalization still execute. This is not qualification
// of the unavailable pinned legacy installation or of public CCIP delivery.
async function legacyComposition(name: string): Promise<void> {
  const directory = resolve('.local/INPUT/provider');
  const sdk: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/index.js') = await import(pathToFileURL(directory + '/node_modules/@chainlink/ccip-sdk/dist/index.js').href);
  const require = createRequire(directory + '/package.json');
  const web3: typeof Web3 = require('@solana/web3.js'), spl: typeof Spl = require('@solana/spl-token');
  const anchor: typeof import('../../../.local/INPUT/provider/node_modules/@coral-xyz/anchor/dist/cjs/index.js') = require('@coral-xyz/anchor');
  const router: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js') = await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js')).href);
  const abi: typeof import('../../../.local/INPUT/provider/node_modules/ethers/lib.esm/abi/index.js') = await import(pathToFileURL(directory + '/node_modules/ethers/lib.esm/abi/index.js').href);
  const sourceAbi: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/abi/OnRamp_1_6.js') = await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/evm/abi/OnRamp_1_6.js')).href);
  const executionAbi: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/abi/OffRamp_1_6.js') = await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/evm/abi/OffRamp_1_6.js')).href);
  const { PublicKey } = web3, mint = new PublicKey(fixture.mint);
  const signer = PublicKey.findProgramAddressSync([Buffer.from('ccip_tokenpool_signer'), mint.toBuffer()], new PublicKey(BURNMINT_PROGRAM))[0].toBase58();
  const recipientAtas = Object.fromEntries([fixture.recipient, FORWARD_RECIPIENT_B].map(owner => [owner,
    spl.getAssociatedTokenAddressSync(mint, new PublicKey(owner), false, spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()]));
  const poolAta = spl.getAssociatedTokenAddressSync(mint, new PublicKey(signer), true, spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();
  const spender = PublicKey.findProgramAddressSync([Buffer.from('fee_billing_signer')], new PublicKey(ROUTER_PROGRAM))[0].toBase58();
  const ids = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32)];
  const sources = ['0x' + '44'.repeat(32), '0x' + '55'.repeat(32), '1'.repeat(64)];
  const destinations = ['1'.repeat(63) + '2', '1'.repeat(63) + '3', '0x' + '66'.repeat(32)];
  const onRamp = '0x' + '77'.repeat(20), evmOffRamp = '0x0820f975ce90ee5c508657f0c58b71d1fcc85ce0';
  const u64 = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
  const discriminator = (event: string) => createHash('sha256').update('event:' + event).digest().subarray(0, 8);
  const executionData = ids.slice(0, 2).map(id => Buffer.concat([discriminator('ExecutionStateChanged'), u64(BigInt(fixture.reverseSelector)),
    u64(7n), Buffer.from(id.slice(2), 'hex'), Buffer.from(hash.slice(2), 'hex'), Buffer.from([sdk.ExecutionState.Success])]).toString('base64'));
  type Ramp = import('../../../.local/INPUT/provider/node_modules/@coral-xyz/anchor/dist/cjs/index.js').IdlTypes<typeof router.IDL>['SVM2AnyRampMessage'];
  const amount = Buffer.alloc(32); amount.writeBigUInt64LE(BigInt(fixture.amount));
  const message: Ramp = { header: { messageId: [...Buffer.from(present(ids[2]).slice(2), 'hex')], sourceChainSelector: new anchor.BN(fixture.forwardSelector),
    destChainSelector: new anchor.BN(fixture.reverseSelector), sequenceNumber: new anchor.BN(7), nonce: new anchor.BN(0) }, sender: new PublicKey(fixture.payer),
    data: Buffer.alloc(0), receiver: Buffer.from(fixture.administrator.slice(2), 'hex'),
    extraArgs: Buffer.from(sdk.SolanaChain.encodeExtraArgs({ gasLimit: 100000n, allowOutOfOrderExecution: true }).slice(2), 'hex'),
    feeToken: mint, feeTokenAmount: { leBytes: [...Buffer.alloc(32)] }, feeValueJuels: { leBytes: [...Buffer.alloc(32)] },
    tokenAmounts: [{ sourcePoolAddress: new PublicKey(fixture.solanaPool), destTokenAddress: Buffer.from(fixture.token.slice(2), 'hex'),
      extraData: Buffer.alloc(0), amount: { leBytes: [...amount] }, destExecData: Buffer.alloc(4) }] };
  const sendData = Buffer.concat([discriminator('CCIPMessageSent'), u64(BigInt(fixture.reverseSelector)), u64(7n),
    new anchor.BorshCoder(router.IDL).types.encode<Ramp>('SVM2AnyRampMessage', message)]).toString('base64');
  const sourceEvents = [fixture.recipient, FORWARD_RECIPIENT_B].map((recipient, index) => new abi.Interface(sourceAbi.default).encodeEventLog('CCIPMessageSent', [BigInt(fixture.forwardSelector), 7n, {
    header: { messageId: present(ids[index]), sourceChainSelector: BigInt(fixture.reverseSelector), destChainSelector: BigInt(fixture.forwardSelector), sequenceNumber: 7n, nonce: 0n },
    sender: fixture.administrator, data: '0x', receiver: '0x' + '00'.repeat(32), feeToken: '0x' + '00'.repeat(20), feeTokenAmount: 1n, feeValueJuels: 1n,
    extraArgs: sdk.EVMChain.encodeExtraArgs({ computeUnits: 0n, accountIsWritableBitmap: 0n, allowOutOfOrderExecution: true, tokenReceiver: recipient, accounts: [] }),
    tokenAmounts: [{ sourcePoolAddress: fixture.pool, destTokenAddress: '0x' + mint.toBuffer().toString('hex'), extraData: '0x', amount: BigInt(fixture.amount), destExecData: '0x00000000' }],
  }]));
  const releaseEvent = new abi.Interface(executionAbi.default).encodeEventLog('ExecutionStateChanged', [BigInt(fixture.forwardSelector), 7n, present(ids[2]), hash, sdk.ExecutionState.Success, '0x', 100n]);
  const typeAndVersion = new abi.Interface(['function typeAndVersion() view returns(string)']).encodeFunctionResult('typeAndVersion', ['OnRamp 1.6.0']);
  const balance = (accountIndex: number, owner: string, quantity: string) => ({ accountIndex, mint: fixture.mint, owner, programId: token, uiTokenAmount: { amount: quantity, decimals: 9 } });
  let mutant = '', target = 0, controlledFetches = 0, decodedReads = 0, pinChecks = 0, constructed = 0, destroyed = 0;
  const transactions = (index: number, parsed: boolean) => {
    const reverse = index === 2, owner = index === 1 ? FORWARD_RECIPIENT_B : fixture.recipient;
    const ata = present(recipientAtas[owner]), signature = present(reverse ? sources[index] : destinations[index]);
    const program = reverse ? ROUTER_PROGRAM : svmOffRamp, data = present(reverse ? sendData : executionData[index]);
    const change = index === target ? mutant : '';
    const pool = { programId: BURNMINT_PROGRAM, stackHeight: 2 };
    const effect = reverse ? { programId: token, stackHeight: 3, parsed: { type: 'burn', info: { mint: fixture.mint, account: poolAta, authority: signer, amount: fixture.amount } } } :
      { programId: token, stackHeight: 3, parsed: { type: 'mintTo', info: { mint: fixture.mint, account: ata, mintAuthority: signer, amount: fixture.amount } } };
    const transfer = { programId: token, stackHeight: 2, parsed: { type: 'transferChecked', info: { mint: fixture.mint, source: ata, destination: poolAta, authority: spender, tokenAmount: { amount: fixture.amount, decimals: 9 } } } };
    const child = change === 'unrelated-parent' ? fixture.payer : program;
    let logs = reverse ? [`Program ${program} invoke [1]`, `Program ${token} invoke [2]`, `Program ${token} success`, `Program ${BURNMINT_PROGRAM} invoke [2]`,
      `Program ${token} invoke [3]`, `Program ${token} success`, `Program ${BURNMINT_PROGRAM} success`, `Program data: ${data}`, `Program ${program} success`] :
      [`Program ${program} invoke [1]`, `Program ${BURNMINT_PROGRAM} invoke [2]`, `Program ${token} invoke [3]`, `Program ${token} success`, `Program ${BURNMINT_PROGRAM} success`, `Program data: ${data}`, `Program ${program} success`];
    let instructions = [{ programId: program }];
    let innerInstructions = [{ index: 0, instructions: reverse ? [transfer, pool, effect] : [pool, effect] }];
    if (change === 'same-program-split' || change === 'unrelated-parent') {
      logs = reverse ? [`Program ${program} invoke [1]`, `Program ${token} invoke [2]`, `Program ${token} success`, `Program data: ${data}`, `Program ${program} success`,
        `Program ${child} invoke [1]`, `Program ${BURNMINT_PROGRAM} invoke [2]`, `Program ${token} invoke [3]`, `Program ${token} success`, `Program ${BURNMINT_PROGRAM} success`, `Program ${child} success`] :
        [`Program ${program} invoke [1]`, `Program data: ${data}`, `Program ${program} success`, `Program ${child} invoke [1]`, `Program ${BURNMINT_PROGRAM} invoke [2]`,
          `Program ${token} invoke [3]`, `Program ${token} success`, `Program ${BURNMINT_PROGRAM} success`, `Program ${child} success`];
      instructions = [{ programId: program }, { programId: child }];
      innerInstructions = reverse ? [{ index: 0, instructions: [transfer] }, { index: 1, instructions: [pool, effect] }] : [{ index: 1, instructions: [pool, effect] }];
    }
    if (change === 'duplicate-event') {
      // decodeReceipt intentionally hides earlier states for the same message.
      // A second distinct official Success must still make ownership ambiguous.
      const duplicate = Buffer.from(data, 'base64'); if (!reverse) { duplicate.fill(0xee, 24, 56); }
      logs.splice(logs.length - 1, 0, `Program data: ${duplicate.toString('base64')}`);
    }
    if (change === 'missing-event') { logs = logs.filter(line => !line.startsWith('Program data:')); }
    if (change === 'failed-receipt' && !reverse) { logs = logs.map(line => line === `Program data: ${data}` ? `Program data: ${Buffer.concat([Buffer.from(data, 'base64').subarray(0, -1), Buffer.from([3])]).toString('base64')}` : line); }
    if (change === 'non-router-send' && reverse) { logs = logs.map(line => line.replaceAll(ROUTER_PROGRAM, fixture.payer)); instructions[0] = { programId: fixture.payer }; }
    if (parsed) {
      return { slot: 20, transaction: { signatures: [signature], message: { accountKeys: reverse ? [ata, poolAta, { pubkey: fixture.payer, signer: true }] : [ata], instructions } },
        meta: { err: null, logMessages: logs, innerInstructions,
          preTokenBalances: reverse ? [balance(0, owner, fixture.amount), balance(1, signer, '0')] : [balance(0, owner, '0')],
          postTokenBalances: reverse ? [balance(0, owner, '0'), balance(1, signer, '0')] : [balance(0, owner, fixture.amount)] } };
    }
    return { slot: change === 'sdk-slot' ? 21 : 20, blockTime: time / 1000, version: 0,
      transaction: { signatures: [signature], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        accountKeys: [fixture.payer, program], recentBlockhash: fixture.mint, instructions: [], addressTableLookups: [] } },
      meta: { err: change === 'sdk-failure' ? { InstructionError: [0, 'InvalidArgument'] } : null, fee: 1, preBalances: [1, 1], postBalances: [1, 1],
        innerInstructions: [], preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: [], readonly: [] }, logMessages: logs } };
  };
  const fetcher: typeof fetch = async (input, init) => {
    controlledFetches++;
    const url = String(input);
    if (url.startsWith('https://api.ccip.chain.link/v2/messages/')) { assert.equal(init?.method, 'GET'); return new Response('{}', { status: 404 }); }
    assert.ok([DEFAULT_SEPOLIA_RPC, DEFAULT_SEPOLIA_RPC + '/', DEFAULT_SOLANA_RPC, DEFAULT_SOLANA_RPC + '/'].includes(url), url);
    assert.equal(init?.method, 'POST');
    const body = init?.body; assert.ok(typeof body === 'string' || body instanceof Uint8Array);
    const payload: unknown = JSON.parse(typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body));
    const replies = (Array.isArray(payload) ? payload : [payload]).map(value => {
      const request = object(value); assert.ok(Array.isArray(request.params)); const params: readonly unknown[] = request.params;
      let result: unknown;
      switch (request.method) {
        case 'eth_chainId': result = '0xaa36a7'; break;
        case 'getGenesisHash': result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'; break;
        case 'getTransaction': {
          const index = params[0] === sources[2] ? 2 : destinations.indexOf(String(params[0])); assert.ok(index >= 0 && index <= 2);
          result = transactions(index, object(params[1]).encoding === 'jsonParsed'); break;
        }
        case 'getSignatureStatuses': result = { context: { slot: 20 }, value: [{ slot: 20, err: null, confirmationStatus: 'finalized' }] }; break;
        case 'getBlock': result = { blockhash: fixture.mint, signatures: [...destinations.slice(0, 2), present(sources[2])] }; break;
        case 'getSlot': result = 20; break;
        case 'getTokenSupply': result = { context: { slot: 20 }, value: { amount: fixture.amount, decimals: 9, uiAmount: 1, uiAmountString: '1' } }; break;
        case 'getBlockTime': result = time / 1000; break;
        case 'getAccountInfo': {
          if (params[0] === fixture.mint) { result = { context: { slot: 20 }, value: { owner: token, executable: false, data: { parsed: { type: 'mint', info: {
            decimals: 9, isInitialized: true, freezeAuthority: null, mintAuthority: signer, supply: fixture.amount } } } } }; }
          else if (Object.values(recipientAtas).includes(String(params[0]))) {
            const owner = params[0] === recipientAtas[fixture.recipient] ? fixture.recipient : FORWARD_RECIPIENT_B;
            result = { context: { slot: 20 }, value: { owner: token, executable: false, data: { parsed: { type: 'account', info: {
              mint: fixture.mint, owner, state: 'initialized', tokenAmount: { amount: owner === fixture.recipient ? '0' : fixture.amount, decimals: 9 } } } } } };
          } else { result = { context: { slot: 20 }, value: params[0] === svmOffRamp ? { executable: true } : { owner: ROUTER_PROGRAM, executable: false,
            data: [createHash('sha256').update('account:AllowedOfframp').digest().subarray(0, 8).toString('base64'), 'base64'] } }; } break;
        }
        case 'simulateTransaction': {
          const label = Buffer.from('CCIP Router 1.6.0'), length = Buffer.alloc(4); length.writeUInt32LE(label.length);
          const data = Buffer.concat([length, label]).toString('base64'); result = { context: { slot: 20 }, value: { err: null, unitsConsumed: 1,
            logs: [`Program return: ${ROUTER_PROGRAM} ${data}`], returnData: { programId: ROUTER_PROGRAM, data: [data, 'base64'] } } }; break;
        }
        case 'eth_getTransactionReceipt': {
          const txHash = String(params[0]), reverse = txHash === destinations[2], index = sources.indexOf(txHash);
          assert.ok(reverse || index === 0 || index === 1);
          const log = (address: string, event: { data: string; topics: readonly string[] }, logIndex: number) => ({ address, ...event, logIndex: '0x' + logIndex.toString(16),
            transactionHash: txHash, blockHash: hash, blockNumber: '0xa', transactionIndex: '0x0', removed: false });
          const transfer = { topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            '0x' + (reverse ? fixture.pool : fixture.administrator).slice(2).padStart(64, '0'), '0x' + (reverse ? fixture.administrator : fixture.pool).slice(2).padStart(64, '0')],
            data: '0x' + BigInt(fixture.amount).toString(16).padStart(64, '0') };
          result = { transactionHash: txHash, blockHash: hash, blockNumber: '0xa', transactionIndex: '0x0', from: fixture.administrator,
            to: '0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59', status: '0x1', type: '0x0', cumulativeGasUsed: '0x10000', gasUsed: '0x10000', effectiveGasPrice: '0x1', logsBloom: '0x' + '00'.repeat(256),
            logs: reverse ? [log(evmOffRamp, releaseEvent, 0), log(fixture.token, transfer, 1)] : [log(fixture.token, transfer, 0), log(onRamp, present(sourceEvents[index]), 1)] }; break;
        }
        case 'eth_getTransactionByHash': result = { hash: params[0], chainId: '0xaa36a7', from: fixture.administrator,
          to: '0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59', input: '0x1234', value: '0x0', nonce: '0x5', blockHash: hash, blockNumber: '0xa' }; break;
        case 'eth_getBlockByNumber': result = { hash, number: '0xa', timestamp: '0x' + (time / 1000).toString(16), parentHash: hash, nonce: '0x0000000000000000',
          difficulty: '0x0', gasLimit: '0x1000000', gasUsed: '0x10000', miner: fixture.administrator, extraData: '0x', transactions: [] }; break;
        case 'eth_call': {
          const call = object(params[0]); result = call.to === onRamp ? typeAndVersion : params[1] === 'finalized' ? '0x1' :
            '0x' + (call.data === '0x18160ddd' ? 100000000000n : call.data === '0x313ce567' ? 9n : 1000000000n).toString(16).padStart(64, '0'); break;
        }
        default: throw new Error('Unexpected controlled legacy method ' + String(request.method));
      }
      return { jsonrpc: '2.0', id: request.id, result };
    });
    return new Response(JSON.stringify(Array.isArray(payload) ? replies : present(replies[0])));
  };
  const transfers: StatusTransferInput[] = [fixture.recipient, FORWARD_RECIPIENT_B].map((recipient, index) => ({ direction: 'ethereum-to-solana', recipient,
    sourceHash: present(sources[index]), destinationReceipt: { transactionHash: present(destinations[index]), offRamp: svmOffRamp } }));
  transfers.push({ direction: 'solana-to-ethereum', sourceHash: present(sources[2]), destinationReceipt: { transactionHash: present(destinations[2]), offRamp: evmOffRamp } });
  const settings: StatusSettings = { testOnly: true, fixture, fixtureIdentity: fixture.identity, sdkDirectory: directory, transfers, completeFixtureInventory: true };
  assert.equal(Object.hasOwn(settings, 'providerProfile'), false);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('External fetch forbidden'); };
  await assert.rejects(runStatus(settings, () => time), /Unreviewed SDK installation/);
  assert.equal(controlledFetches, 0);
  const realDigest = Hash.prototype.digest;
  function installationDigest(this: Hash): Buffer;
  function installationDigest(this: Hash, encoding: BinaryToTextEncoding): string;
  function installationDigest(this: Hash, encoding?: BinaryToTextEncoding): Buffer | string {
    const actual = realDigest.call(this, 'hex');
    const expected = actual === '9bc50499bd486b1457bb2efb85951ed8b90d15faf13b39d36d3bb97a2338ccc4' ? '8cf7da517123c8be46f0a5fa14ef67904bf45bf4cfb972fc2c54be4b91cb56fb' :
      actual === 'f65db5bc0003f0cfe4545ab853a991cea43ec7b172ad52e5002e7f25dd7ce8c1' ? '1477c1d04940f9556ff87eaf82de6f0f2eaa6f3585deea0f09bfdab8fba7f50f' : actual;
    if (expected !== actual) { pinChecks++; }
    const bytes = Buffer.from(expected, 'hex'); return encoding === undefined ? bytes : bytes.toString(encoding);
  }
  const originalFromUrl = sdk.EVMChain.fromUrl;
  mock.method(Hash.prototype, 'digest', installationDigest);
  // The actual installed EVM constructor produces Uint8Array bodies. The legacy
  // transport accepts strings. Reuse the real constructor with the controlled
  // transport; do not change production RPC policy to solve this separate limit.
  mock.method(sdk.EVMChain, 'fromUrl', async (url: string, context?: Parameters<typeof sdk.EVMChain.fromUrl>[1]) => {
    assert.equal(url, DEFAULT_SEPOLIA_RPC); assert.equal(typeof context?.fetch, 'function');
    const chain = await originalFromUrl.call(sdk.EVMChain, url, { ...context, fetch: fetcher });
    constructed++; const destroy = chain.destroy; chain.destroy = () => { destroyed++; destroy(); }; return chain;
  });
  const originalSolanaFromUrl = sdk.SolanaChain.fromUrl;
  mock.method(sdk.SolanaChain, 'fromUrl', async (url: string, context?: Parameters<typeof sdk.SolanaChain.fromUrl>[1]) => {
    const chain = await originalSolanaFromUrl.call(sdk.SolanaChain, url, context);
    constructed++; const destroy = chain.destroy; chain.destroy = () => { destroyed++; destroy(); }; return chain;
  });
  const originalGetTransaction = sdk.SolanaChain.prototype.getTransaction;
  mock.method(sdk.SolanaChain.prototype, 'getTransaction', async function(this: SolanaChain, requested: string) {
    decodedReads++; const transaction = await originalGetTransaction.call(this, requested);
    if (requested === (target === 2 ? sources[2] : destinations[target])) {
      if (mutant === 'sdk-hash') { transaction.hash = '4'.repeat(64); }
      if (mutant.startsWith('sdk-log-')) {
        const log = present(transaction.logs.find(value => value.type === 'data'));
        if (mutant === 'sdk-log-index') { log.index = 0; }
        if (mutant === 'sdk-log-address') { log.address = fixture.payer; }
        if (mutant === 'sdk-log-data') { log.data = Buffer.alloc(16).toString('base64'); }
        if (mutant === 'sdk-log-type') { log.type = 'log'; }
        if (mutant === 'sdk-log-depth') { log.level = 2; }
      }
    }
    return transaction;
  });
  globalThis.fetch = fetcher;
  try {
    const positive = async (inputs: readonly StatusTransferInput[]) => {
      let report: Awaited<ReturnType<typeof runStatus>> | undefined;
      await assert.doesNotReject(async () => { report = await runStatus({ ...settings, transfers: inputs }, () => time); }, name + ': valid official invocation must collect');
      assert.ok(report);
      assert.equal(report.readOnly, true); assert.equal(report.transfers.length, inputs.length);
      for (const [index, transfer] of report.transfers.entries()) {
        const input = present(inputs[index]), route = sources.indexOf(input.sourceHash); assert.ok(route >= 0);
        assert.equal(transfer.status, 'settled', name + ': ' + JSON.stringify(transfer, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
        assert.equal(transfer.pendingAmount, 0n); assert.equal(transfer.destinationError, undefined); assert.equal(transfer.identity.messageId, ids[route]);
        assert.equal(transfer.selectedRecipient, route === 1 ? FORWARD_RECIPIENT_B : fixture.recipient);
        const effect = present(transfer.events.find(event => event.chain === 'solana'));
        assert.equal(effect.kind, route === 2 ? 'burn' : 'mint'); assert.equal(effect.eventIndex, route === 2 ? 3 : 2);
        assert.equal(effect.transactionId, route === 2 ? sources[2] : destinations[route]);
      }
      return report;
    };
    if (name === 'legacy-inventory') {
      const report = await positive(transfers); assert.equal(report.accounting.status, 'exact');
      assert.equal(new Set(report.transfers.flatMap(transfer => transfer.events.map(event => `${event.chain}:${event.transactionId}:${event.eventIndex}`))).size, 6);
    } else {
      target = name === 'legacy-a' ? 0 : name === 'legacy-b' ? 1 : 2;
      const input = present(transfers[target]); await positive([input]);
      for (const change of ['unrelated-parent', 'same-program-split', 'sdk-slot', 'sdk-hash', 'sdk-failure', 'duplicate-event', 'missing-event',
        'sdk-log-index', 'sdk-log-address', 'sdk-log-data', 'sdk-log-type', 'sdk-log-depth', target === 2 ? 'non-router-send' : 'failed-receipt']) {
        mutant = change;
        if (target === 2) { await assert.rejects(runStatus({ ...settings, transfers: [input] }, () => time), /execution|invocation|order/i, change); }
        else {
          const report = await runStatus({ ...settings, transfers: [input] }, () => time);
          const transfer = present(report.transfers[0]); assert.equal(transfer.status, 'pending', change); assert.equal(transfer.pendingAmount, null, change);
          assert.equal(transfer.events.length, 1, change); assert.match(present(transfer.destinationError), /unproven/); assert.equal(report.accounting.status, 'unknown');
        }
        mutant = ''; await positive([input]);
      }
    }
    assert.equal(constructed, destroyed); assert.ok(constructed > 0 && decodedReads > 0); assert.equal(pinChecks, constructed);
    process.stdout.write(JSON.stringify({ scenario: name, qualification: 'UNQUALIFIED', evidence: 'actual-legacy-composition-controlled-public-SDK-ports',
      installation: 'retained TEST bytes; legacy pin check explicitly stubbed', sdkVersion: sdk.SDK_VERSION, controlledFetches, decodedReads, constructed, destroyed, networkEffects: 0, signingEffects: 0 }) + '\n');
  } finally { mock.restoreAll(); globalThis.fetch = realFetch; }
}
const selected = process.argv[2];
if (selected) { if (selected.startsWith('legacy-')) { await legacyComposition(selected); } else { await scenario(selected); } }
else {
  for (const name of ['observer', 'decoders', 'svm-decoders', 'composition', 'retry', 'byte-utf8', 'byte-limit', 'rpc-reply-id', 'rpc-reply-batch', 'rpc-redirect', 'api-error-body', 'partial', 'api-headers', 'api-body', 'native-body', 'sdk-body', 'deadline', 'cleanup-failure', 'unexpected', 'causal-cpi', 'causal-cancel', 'causal-cancel-header', 'causal-cancel-pending', 'causal-reverse', 'legacy-a', 'legacy-b', 'legacy-reverse', 'legacy-inventory']) {
    test((name.startsWith('legacy-') ? 'controlled actual legacy composition status unit: ' : 'controlled actual admitted SDK status unit: ') + name, () => {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * TEST_RPC_RESPONSE_LIMIT });
      assert.equal(child.status, 0, child.error?.message ?? child.stdout + child.stderr);
      const evidence: unknown = JSON.parse(present(child.stdout.trim().split('\n').at(-1)));
      assert.equal(object(evidence).qualification, 'UNQUALIFIED'); assert.equal(object(evidence).scenario, name);
    });
  }
}
