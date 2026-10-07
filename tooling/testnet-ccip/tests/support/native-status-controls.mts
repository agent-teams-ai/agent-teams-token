import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateReplacementFixture } from '../../src/domain/replacement-fixture.ts';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { NativeStatusLane } from '../../src/adapters/transfer-status-native.mjs';
import { BURNMINT_PROGRAM } from '../../src/domain/solana-pool-init.ts';
import { ROUTER_PROGRAM } from '../../src/domain/solana-registration.ts';
import { FORWARD_RECIPIENT_B } from '../../src/domain/evm-forward.mjs';
import type { EVMChain } from '../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/index.js';
import type { SolanaChain } from '../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js';
import type * as Web3 from '../../../../.local/INPUT/provider/node_modules/@solana/web3.js/lib/index.js';
import type * as Spl from '../../../../.local/INPUT/provider/node_modules/@solana/spl-token/lib/types/index.js';
import { DEFAULT_SEPOLIA_RPC, DEFAULT_SOLANA_RPC, TEST_RPC_RESPONSE_LIMIT } from '../../src/adapters/test-rpc.ts';

// These responses are controlled native units over real admitted SDK bytes. They
// are deliberately not genuine RPC captures and do not qualify public delivery.
export const root = resolve('.local/INPUT/native-private-provider'), archives = resolve('.local/INPUT/archives');
export const fixture = validateReplacementFixture(JSON.parse(readFileSync('.local/INPUT/EXACT-FIXTURE.json', 'utf8')));
export interface MintInstruction { programId: string; stackHeight: number; parsed?: { type: string; info: { mint: string; account: string; amount: string; mintAuthority: string } } }
export interface MintTransaction {
  transaction: { message: { accountKeys: string[]; instructions: { programId: string }[] } };
  meta: { logMessages: string[]; innerInstructions: { index: number; instructions: MintInstruction[] }[];
    preTokenBalances: TokenBalance[]; postTokenBalances: TokenBalance[] };
}
export interface TokenBalance { accountIndex: number; mint: string; owner: string; programId: string; uiTokenAmount: { amount: string; decimals: number } }
export function present<T>(value: T | undefined): T { assert.notEqual(value, undefined); if (value === undefined) { throw new Error('Missing controlled unit field'); } return value; }
export const time = 1_791_288_000_000, hash = '0x' + 'ab'.repeat(32);
export const logger = { debug() {}, info() {}, warn() {}, error() {} };
export const svmOffRamp = 'offqSMQWgQud6WJz694LRzkeN5kMYpCHTpXQr3Rkcjm';
export const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function object(value: unknown): Record<string, unknown> { assert.ok(record(value)); return value; }
export function deferred<T>() { return Promise.withResolvers<T>(); }
export async function ticks(): Promise<void> { for (let i = 0; i < 30; i++) { await Promise.resolve(); } }
export const  json = (value: unknown): string => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
export function  u64(value: bigint): Buffer { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; }
export function  discriminator(event: string): Buffer { return createHash('sha256').update('event:' + event).digest().subarray(0, 8); }

interface ScenarioDecoders {
  native?: { web3: typeof Web3; spl: typeof Spl };
  lane?: NativeStatusLane;
  sourceLog?: { data: string; topics: string[] };
  executionLog?: { data: string; topics: string[] };
  typeAndVersion?: string;
  parseLogs?: typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/utils.js').parseSolanaLogs;
  svmSourceData?: string;
  svmExecutionData?: string;
}
export function createScenarioState(name: string) {
  const reverseCausal = name === 'causal-reverse', causal = name.startsWith('causal-') && !reverseCausal, evmDecoders = name === 'decoders' || causal || reverseCausal;
  const decoders: ScenarioDecoders = {};
  const cpiMutant = '', failedCancellation = false, physicalReleased = true;
  const evms: EVMChain[] = [], svms: SolanaChain[] = [];
  const evmDestroyed = 0, svmDestroyed = 0, calls = 0, installed = false;
  const header = deferred<Response>(), entered = deferred<void>(), body = deferred<void>();
  const held = false, apiCalls = 0, globalFetchAttempts = 0, mutateReply = false, bodyCancelled = 0;
  const messageId = '0x' + '11'.repeat(32), sourceHash = '0x' + '22'.repeat(32), executionHash = '0x' + '33'.repeat(32);
  const onRamp = '0x' + '44'.repeat(20), offRamp = '0x0820f975ce90ee5c508657f0c58b71d1fcc85ce0';
  const apiResponse: import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/api/types.js').RawMessageResponse = {
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
  const mutations: { timestamp: number | null | undefined; endTimestamp?: number; endSupply?: string; mintDecimals: number; supplyDecimals: number; mintAuthority: string; freezeAuthority: string | null | undefined; supply: string; mintContext: number; blockHash: string; endHash: string } = { timestamp: time / 1000, mintDecimals: 9, supplyDecimals: 9,
    mintAuthority: '', freezeAuthority: undefined, supply: '1000000000', mintContext: 20, blockHash: hash, endHash: hash };
  mutations.freezeAuthority = null;
  const accountMetadata: { program: string; mint: string; owner?: string; state: string; decimals: number; slot: number; amountA?: string } = {
    program: token, mint: fixture.mint, state: 'initialized', decimals: 9, slot: 20,
  };
  const requests: { url: string; request: Record<string, unknown>; signal: AbortSignal }[] = [], signals: AbortSignal[] = [];
  const blockReads = 0, supplyReads = 0, rateLimited = false;
  return { name, reverseCausal, causal, evmDecoders, cpiMutant, failedCancellation, physicalReleased, evms, svms, evmDestroyed, svmDestroyed, calls, installed, header, entered, body, held, apiCalls, globalFetchAttempts, mutateReply, bodyCancelled, messageId, sourceHash, executionHash, onRamp, offRamp, apiResponse, ...decoders, mutations, accountMetadata, requests, signals, blockReads, supplyReads, rateLimited };
}
export type ScenarioState = ReturnType<typeof createScenarioState>;
export async function installProbes(s: ScenarioState): Promise<void> {
    if (s.installed) { return; } s.installed = true;
    // Observe real construction through its public method binding. The returned
    // chains remain real SDK instances; only destroy failure is a controlled mutant.
    const evmModule: typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/index.js') = await import(pathToFileURL(root + '/node_modules/@chainlink/ccip-sdk/dist/evm/index.js').href);
    const svmModule: typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js') = await import(pathToFileURL(root + '/node_modules/@chainlink/ccip-sdk/dist/solana/index.js').href);
    const evmOriginal = evmModule.EVMChain.prototype.getTransaction;
    Object.defineProperty(evmModule.EVMChain.prototype, 'getTransaction', { configurable: true,
      get(this: EVMChain) { s.evms.push(this); if (s.name === 'composition') { const original = this.destroy; this.destroy = () => { s.evmDestroyed++; original(); }; } return evmOriginal; },
      set(this: EVMChain, value: EVMChain['getTransaction']) { Object.defineProperty(this, 'getTransaction', { configurable: true, writable: true, value }); } });
    const svmOriginal = svmModule.SolanaChain.prototype.getTransaction;
    Object.defineProperty(svmModule.SolanaChain.prototype, 'getTransaction', { configurable: true,
      get(this: SolanaChain) { s.svms.push(this); if (s.name === 'composition') { const original = this.destroy; this.destroy = () => { s.svmDestroyed++; original(); }; } return svmOriginal; },
      set(this: SolanaChain, value: SolanaChain['getTransaction']) { Object.defineProperty(this, 'getTransaction', { configurable: true, writable: true, value }); } });
    const require = createRequire(root + '/package.json');
    const web3: typeof Web3 = require('@solana/web3.js');
    const spl: typeof Spl = require('@solana/spl-token'); s.native = { web3, spl };
    const { PublicKey } = web3, mint = new PublicKey(fixture.mint);
    const signer = PublicKey.findProgramAddressSync([Buffer.from('ccip_tokenpool_signer'), mint.toBuffer()], new PublicKey(BURNMINT_PROGRAM))[0].toBase58();
    const atas = Object.fromEntries([fixture.recipient, FORWARD_RECIPIENT_B].map(recipient => [recipient,
      spl.getAssociatedTokenAddressSync(mint, new PublicKey(recipient), false, spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()]));
    s.lane = { fixture, recipientAtas: atas, solanaSigner: signer,
      solanaPoolAta: spl.getAssociatedTokenAddressSync(mint, new PublicKey(signer), true, spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID).toBase58() };
    s.mutations.mintAuthority = signer;
    s.parseLogs = (await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/solana/utils.js')).href)).parseSolanaLogs;
    s.lane.solanaSpender = PublicKey.findProgramAddressSync([Buffer.from('fee_billing_signer')], new PublicKey(ROUTER_PROGRAM))[0].toBase58();
    if (s.evmDecoders) {
      const abi: typeof import('../../../../.local/INPUT/provider/node_modules/ethers/lib.esm/abi/index.js') = await import(pathToFileURL(require.resolve('ethers/abi')).href);
      const sourceAbi: typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/abi/OnRamp_1_6.js') = await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/evm/abi/OnRamp_1_6.js')).href);
      const executionAbi: typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/abi/OffRamp_1_6.js') = await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/evm/abi/OffRamp_1_6.js')).href);
      s.sourceLog = new abi.Interface(sourceAbi.default).encodeEventLog('CCIPMessageSent', [BigInt(fixture.forwardSelector), 7n, {
        header: { messageId: s.messageId, sourceChainSelector: BigInt(fixture.reverseSelector), destChainSelector: BigInt(fixture.forwardSelector), sequenceNumber: 7n, nonce: 0n },
        sender: fixture.administrator, data: '0x', receiver: '0x' + '00'.repeat(32), feeToken: '0x' + '00'.repeat(20), feeTokenAmount: 1n, feeValueJuels: 1n,
        extraArgs: evmModule.EVMChain.encodeExtraArgs({ computeUnits: 0n, accountIsWritableBitmap: 0n, allowOutOfOrderExecution: true, tokenReceiver: FORWARD_RECIPIENT_B, accounts: [] }),
        tokenAmounts: [{ sourcePoolAddress: fixture.pool, destTokenAddress: '0x' + mint.toBuffer().toString('hex'), extraData: '0x', amount: 1000000000n, destExecData: '0x00000000' }],
      }]);
      s.executionLog = new abi.Interface(executionAbi.default).encodeEventLog('ExecutionStateChanged', [BigInt(fixture.forwardSelector), 7n, s.messageId, hash, 2, '0x', 100n]);
      s.typeAndVersion = new abi.Interface(['function typeAndVersion() view returns(string)']).encodeFunctionResult('typeAndVersion', ['OnRamp 1.6.0']);
      s.svmExecutionData = Buffer.concat([createHash('sha256').update('event:ExecutionStateChanged').digest().subarray(0, 8),
        u64(BigInt(fixture.reverseSelector)), u64(7n), Buffer.from(s.messageId.slice(2), 'hex'), Buffer.from(hash.slice(2), 'hex'), Buffer.from([2])]).toString('base64');
    }
    if (s.name === 'svm-decoders' || s.reverseCausal) {
      const anchor: typeof import('../../../../.local/INPUT/provider/node_modules/@coral-xyz/anchor/dist/cjs/index.js') = require('@coral-xyz/anchor');
      const router: typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js') = await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js')).href);
      type Ramp = import('../../../../.local/INPUT/provider/node_modules/@coral-xyz/anchor/dist/cjs/index.js').IdlTypes<typeof router.IDL>['SVM2AnyRampMessage'];
      const amount = Buffer.alloc(32); amount.writeBigUInt64LE(1000000000n);
      const message: Ramp = { header: { messageId: [...Buffer.from(s.messageId.slice(2), 'hex')], sourceChainSelector: new anchor.BN(fixture.forwardSelector),
        destChainSelector: new anchor.BN(fixture.reverseSelector), sequenceNumber: new anchor.BN(7), nonce: new anchor.BN(0) }, sender: new PublicKey(fixture.payer),
        data: Buffer.alloc(0), receiver: Buffer.from(fixture.administrator.slice(2), 'hex'),
        extraArgs: Buffer.from(svmModule.SolanaChain.encodeExtraArgs({ gasLimit: 100000n, allowOutOfOrderExecution: true }).slice(2), 'hex'),
        feeToken: new PublicKey(fixture.mint), feeTokenAmount: { leBytes: [...Buffer.alloc(32)] }, feeValueJuels: { leBytes: [...Buffer.alloc(32)] },
        tokenAmounts: [{ sourcePoolAddress: new PublicKey(fixture.solanaPool), destTokenAddress: Buffer.from(fixture.token.slice(2), 'hex'),
          extraData: Buffer.alloc(0), amount: { leBytes: [...amount] }, destExecData: Buffer.from('00000000', 'hex') }] };
      // Controlled bytes encoded with the admitted public IDL/types coder. They
      // prove the real decoder mapping only, never native delivery qualification.
      const encoded = new anchor.BorshCoder(router.IDL).types.encode<Ramp>('SVM2AnyRampMessage', message);
      s.svmSourceData = Buffer.concat([discriminator('CCIPMessageSent'), u64(BigInt(fixture.reverseSelector)), u64(7n), encoded]).toString('base64');
      s.svmExecutionData = Buffer.concat([discriminator('ExecutionStateChanged'), u64(BigInt(fixture.reverseSelector)), u64(7n), Buffer.from(s.messageId.slice(2), 'hex'), Buffer.from(hash.slice(2), 'hex'), Buffer.from([2])]).toString('base64');
    }
}

function mintAccount(s: ScenarioState, slot: number) {
  return ({ context: { slot }, value: { owner: token, executable: false, data: { parsed: { type: 'mint',
    info: { decimals: s.mutations.mintDecimals, isInitialized: true, freezeAuthority: s.mutations.freezeAuthority,
      mintAuthority: s.mutations.mintAuthority, supply: s.mutations.supply } } } } });
}
function account(s: ScenarioState, recipient: string, value: string) {
  return ({ context: { slot: s.accountMetadata.slot }, value: { owner: s.accountMetadata.program, executable: false, data: { parsed: { type: 'account',
    info: { mint: s.accountMetadata.mint, owner: s.accountMetadata.owner ?? recipient, state: s.accountMetadata.state,
      tokenAmount: { amount: recipient === fixture.recipient ? s.accountMetadata.amountA ?? value : value, decimals: s.accountMetadata.decimals } } } } } });
}
function balance(accountIndex: number, owner: string, amount: string) { return { accountIndex, mint: fixture.mint, owner, programId: token, uiTokenAmount: { amount, decimals: 9 } }; }
function transaction(s: ScenarioState, params: readonly unknown[]): unknown {
  let result: unknown;
  if (s.causal || s.reverseCausal) {
    assert.ok(s.lane?.recipientAtas);
    const ata = present(s.lane.recipientAtas[s.reverseCausal ? fixture.recipient : FORWARD_RECIPIENT_B]), data = present(s.reverseCausal ? s.svmSourceData : s.svmExecutionData);
    if (s.reverseCausal) {
      const transfer = { programId: token, stackHeight: 2, parsed: { type: 'transferChecked', info: { mint: fixture.mint, source: ata,
        destination: s.lane.solanaPoolAta, authority: s.lane.solanaSpender, tokenAmount: { amount: fixture.amount, decimals: 9 } } } };
      const pool = { programId: BURNMINT_PROGRAM, stackHeight: 2 };
      const burn = { programId: token, stackHeight: 3, parsed: { type: 'burn', info: { mint: fixture.mint, account: s.lane.solanaPoolAta, authority: s.lane.solanaSigner, amount: fixture.amount } } };
      const logs = s.cpiMutant === 'split' ? ['Program ' + ROUTER_PROGRAM + ' invoke [1]', 'Program ' + token + ' invoke [2]', 'Program ' + token + ' success',
        ...Array<string>(4).fill('Program log: execution'), 'Program data: ' + data, 'Program ' + ROUTER_PROGRAM + ' success',
        'Program ' + ROUTER_PROGRAM + ' invoke [1]', 'Program ' + BURNMINT_PROGRAM + ' invoke [2]', 'Program ' + token + ' invoke [3]',
        'Program ' + token + ' success', 'Program ' + BURNMINT_PROGRAM + ' success', 'Program ' + ROUTER_PROGRAM + ' success'] :
        ['Program ' + ROUTER_PROGRAM + ' invoke [1]', 'Program ' + token + ' invoke [2]', 'Program ' + token + ' success',
        'Program ' + BURNMINT_PROGRAM + ' invoke [2]', 'Program ' + token + ' invoke [3]', 'Program ' + token + ' success',
        'Program ' + BURNMINT_PROGRAM + ' success', 'Program data: ' + data, 'Program ' + ROUTER_PROGRAM + ' success', 'Program ' + fixture.payer + ' invoke [1]', 'Program ' + fixture.payer + ' success'];
      result = object(params[1]).encoding === 'jsonParsed' ? {
        slot: 20, transaction: { signatures: [params[0]], message: { accountKeys: [ata, s.lane.solanaPoolAta, { pubkey: fixture.payer, signer: true }],
          instructions: [{ programId: ROUTER_PROGRAM }, { programId: s.cpiMutant === 'split' ? ROUTER_PROGRAM : fixture.payer }] } },
        meta: { err: null, logMessages: logs, innerInstructions: s.cpiMutant ? [{ index: 0, instructions: [transfer] }, { index: 1, instructions: [pool, burn] }] :
          [{ index: 0, instructions: [transfer, pool, burn] }], preTokenBalances: [balance(0, fixture.recipient, fixture.amount), balance(1, present(s.lane.solanaSigner), '0')],
          postTokenBalances: [balance(0, fixture.recipient, '0'), balance(1, present(s.lane.solanaSigner), '0')] },
      } : {
        slot: 20, blockTime: time / 1000, version: 0,
        transaction: { signatures: [params[0]], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
          accountKeys: [fixture.payer, ROUTER_PROGRAM], recentBlockhash: fixture.mint, instructions: [], addressTableLookups: [] } },
        meta: { err: null, fee: 1, preBalances: [1,1], postBalances: [1,1], innerInstructions: [], preTokenBalances: [], postTokenBalances: [],
          loadedAddresses: { writable: [], readonly: [] }, logMessages: logs },
      }; return result;
    }
    const progressBytes = Buffer.from(data, 'base64'); progressBytes[progressBytes.length - 1] = 1;
    let eventLogs = ['Program ' + svmOffRamp + ' invoke [1]', 'Program data: ' + progressBytes.toString('base64'), 'Program ' + BURNMINT_PROGRAM + ' invoke [2]',
      'Program ' + token + ' invoke [3]', 'Program ' + token + ' success', 'Program ' + BURNMINT_PROGRAM + ' success',
      'Program data: ' + data, 'Program ' + svmOffRamp + ' success', 'Program ' + fixture.payer + ' invoke [1]', 'Program ' + fixture.payer + ' success'];
    const inner: MintInstruction[] = [{ programId: BURNMINT_PROGRAM, stackHeight: 2 }, { programId: token, stackHeight: 3,
      parsed: { type: 'mintTo', info: { mint: fixture.mint, account: ata, amount: fixture.amount, mintAuthority: present(s.lane.solanaSigner) } } }];
    if (s.cpiMutant === 'depth') { present(inner[1]).stackHeight = 2; }
    if (s.cpiMutant === 'missing-height') { Reflect.deleteProperty(present(inner[1]), 'stackHeight'); }
    if (s.cpiMutant === 'trace-truncated') { eventLogs.pop(); }
    if (s.cpiMutant === 'split') {
      eventLogs = ['Program ' + svmOffRamp + ' invoke [1]', ...Array<string>(5).fill('Program log: execution'), 'Program data: ' + data,
        'Program ' + svmOffRamp + ' success', 'Program ' + svmOffRamp + ' invoke [1]', 'Program ' + BURNMINT_PROGRAM + ' invoke [2]',
        'Program ' + token + ' invoke [3]', 'Program ' + token + ' success', 'Program ' + BURNMINT_PROGRAM + ' success', 'Program ' + svmOffRamp + ' success'];
    }
    const config = object(params[1]);
    result = config.encoding === 'jsonParsed' ? {
      slot: 20, transaction: { signatures: [params[0]], message: { accountKeys: [ata], instructions: [{ programId: svmOffRamp }, { programId: s.cpiMutant === 'split' ? svmOffRamp : fixture.payer }] } },
      meta: { err: null, logMessages: eventLogs, innerInstructions: [{ index: ['parent', 'split'].includes(s.cpiMutant) ? 1 : 0, instructions: inner }],
        preTokenBalances: [balance(0, FORWARD_RECIPIENT_B, '0')], postTokenBalances: [balance(0, FORWARD_RECIPIENT_B, fixture.amount)] },
    } : {
      slot: 20, blockTime: time / 1000, version: 0,
      transaction: { signatures: [params[0]], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        accountKeys: [fixture.payer, svmOffRamp], recentBlockhash: fixture.mint, instructions: [], addressTableLookups: [] } },
      meta: { err: null, fee: 1, preBalances: [1,1], postBalances: [1,1], innerInstructions: [], preTokenBalances: [], postTokenBalances: [],
        loadedAddresses: { writable: [], readonly: [] }, logMessages: eventLogs },
    }; return result;
  }
  assert.equal(s.name, 'svm-decoders');
  const execution = params[0] === '2'.repeat(87), program = execution ? BURNMINT_PROGRAM : ROUTER_PROGRAM;
  result = { slot: 20, blockTime: time / 1000, version: 0,
    transaction: { signatures: [params[0]], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      accountKeys: [fixture.payer, program], recentBlockhash: fixture.mint, instructions: [], addressTableLookups: [] } },
    meta: { err: null, fee: 1, preBalances: [1, 1], postBalances: [1, 1], innerInstructions: [], preTokenBalances: [], postTokenBalances: [],
      loadedAddresses: { writable: [], readonly: [] }, logMessages: ['Program ' + program + ' invoke [1]', 'Program data: ' + present(execution ? s.svmExecutionData : s.svmSourceData), 'Program ' + program + ' success'] } };
  return result;

}
function evmReply(s: ScenarioState, r: Record<string, unknown>, params: readonly unknown[]): unknown {
  let result: unknown;
  switch (r.method) {
        case 'eth_chainId': result = '0xaa36a7'; break;
        case 'eth_getTransactionReceipt': {
          if (!s.evmDecoders) { result = null; break; }
          const txHash = String(params[0]);
          const rawLog = (address: string, event: { data: string; topics: string[] }, index: number) => ({ address, ...event,
            logIndex: '0x' + index.toString(16), transactionHash: txHash, blockHash: hash, blockNumber: '0xa', transactionIndex: '0x0', removed: false });
          result = { transactionHash: txHash, blockHash: hash, blockNumber: '0xa', transactionIndex: '0x0', from: fixture.administrator,
            to: '0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59', status: '0x1', type: '0x0', cumulativeGasUsed: '0x10000', gasUsed: '0x10000', effectiveGasPrice: '0x1', logsBloom: '0x' + '00'.repeat(256),
            logs: txHash === s.executionHash ? [rawLog(s.offRamp, present(s.executionLog), 0), ...(s.reverseCausal ? [rawLog(fixture.token, {
              topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + fixture.pool.slice(2).padStart(64, '0'),
                '0x' + fixture.administrator.slice(2).padStart(64, '0')], data: '0x' + (1000000000n).toString(16).padStart(64, '0') }, 1)] : [])] : [
              rawLog(fixture.token, { topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                '0x' + fixture.administrator.slice(2).padStart(64, '0'), '0x' + fixture.pool.slice(2).padStart(64, '0')], data: '0x' + (1000000000n).toString(16).padStart(64, '0') }, 0), rawLog(s.onRamp, present(s.sourceLog), 1)] };
          break;
        }
        case 'eth_getTransactionByHash': result = { hash: params[0], chainId: '0xaa36a7', from: fixture.administrator,
          to: '0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59', input: '0x1234', value: '0x0', nonce: '0x5', blockHash: hash, blockNumber: '0xa' }; break;
        case 'eth_getCode': result = '0x1234'; break;
        case 'eth_getBlockByNumber': return evmBlock(s);
        case 'eth_call': {
          const call = object(params[0]); if (s.evmDecoders && call.to === s.onRamp) { result = s.typeAndVersion; break; } if (s.reverseCausal && params[1] === 'finalized') { result = '0x1'; break; } assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true });
          result = '0x' + (call.data === '0x18160ddd' ? 100000000000n : call.data === '0x313ce567' ? 9n : 1000000000n).toString(16).padStart(64, '0'); break;
        }

    default: throw new Error('Unexpected controlled unit RPC: ' + String(r.method));
  }
  return result;
}
function solanaReply(s: ScenarioState, r: Record<string, unknown>, params: readonly unknown[]): unknown {
  let result: unknown;
  switch (r.method) {
    case 'getSlot': return 20;
    case 'getGenesisHash': return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    case 'getTransaction': return transaction(s, params);
        case 'simulateTransaction': {
          assert.ok(s.name === 'svm-decoders' || s.reverseCausal);
          const config = object(params[1]); assert.equal(config.sigVerify, false); assert.equal(config.replaceRecentBlockhash, true);
          assert.equal(config.commitment, 'confirmed'); assert.equal(config.encoding, 'base64');
          const label = Buffer.from('CCIP Router 1.6.0'), length = Buffer.alloc(4); length.writeUInt32LE(label.length);
          const encoded = Buffer.concat([length, label]).toString('base64');
          result = { context: { slot: 20 }, value: { err: null, logs: ['Program return: ' + ROUTER_PROGRAM + ' ' + encoded], unitsConsumed: 1,
            returnData: { programId: ROUTER_PROGRAM, data: [encoded, 'base64'] } } }; break;
        }
        case 'getAccountInfo': return solanaAccount(s, params);
        case 'getSignatureStatuses': result = { context: { slot: 20 }, value: [{ slot: 20, err: null, confirmationStatus: 'finalized' }] }; break;
        case 'getBlock': result = { blockhash: fixture.mint, signatures: ['1'.repeat(64)] }; break;
        case 'getTokenSupply': result = { context: { slot: 20 }, value: { amount: s.supplyReads++ % 2 === 1 ? s.mutations.endSupply ?? s.mutations.supply : s.mutations.supply, decimals: s.mutations.supplyDecimals } }; break;
        case 'getBlockTime': result = s.mutations.timestamp ?? null; break;
        default: throw new Error('Unexpected controlled unit RPC: ' + String(r.method));

  }
  return result;
}
async function apiReply(s: ScenarioState, url: string, init: RequestInit): Promise<Response> {
      s.apiCalls++; assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
      assert.match(url, /^https:\/\/api\.ccip\.chain\.link\/v2\/messages\/0x[0-9a-f]{64}$/);
      if (s.failedCancellation) {
        s.physicalReleased = false;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { if (s.name !== 'causal-cancel-header') { controller.enqueue(new Uint8Array(TEST_RPC_RESPONSE_LIMIT + 1)); } },
          async cancel() { s.bodyCancelled++; s.entered.resolve(); if (s.name === 'causal-cancel-pending') { await s.body.promise; } throw new Error('Controlled retained physical resource'); },
        }), { status: 404, ...(s.name === 'causal-cancel-header' ? { headers: { 'content-length': String(TEST_RPC_RESPONSE_LIMIT + 1) } } : {}) });
      }
      if (s.held) {
        if (s.name === 'api-error-body') {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array(TEST_RPC_RESPONSE_LIMIT + 1)); },
            async cancel() { s.bodyCancelled++; s.entered.resolve(); await s.body.promise; },
          }), { status: 404 });
        }
        s.entered.resolve();
        if (s.name === 'api-headers' || s.name === 'deadline') { return s.header.promise; }
        return new Response(new ReadableStream<Uint8Array>({ async start(controller) { await s.body.promise; controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } }), { status: 404 });
      }
      return s.evmDecoders ? new Response(json(s.reverseCausal ? { ...s.apiResponse, offramp: s.offRamp, receiptTransactionHash: s.executionHash } : s.apiResponse)) : new Response('{}', { status: 404 });

}
async function interruptedReply(s: ScenarioState, r: Record<string, unknown>): Promise<Response | undefined> {
      if (r.method === 'eth_chainId') { await installProbes(s); }
      if (s.name === 'partial' && r.method === 'getGenesisHash') {
        const chain = s.evms[0]; assert.ok(chain); const original = chain.destroy; chain.destroy = () => { s.evmDestroyed++; original(); };
        throw new Error('Controlled second-constructor failure');
      }
      if (s.name === 'retry' && r.method === 'getSlot' && !s.rateLimited) { s.rateLimited = true; return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: 429, message: 'Controlled read rate limit' } }), { status: 429, headers: { 'retry-after': '10' } }); }
      if (s.mutateReply && r.method === 'getSlot') {
        const reply = { jsonrpc: '2.0', id: s.name === 'rpc-reply-id' ? 'unrequested' : r.id, result: 20 };
        return new Response(JSON.stringify(s.name === 'rpc-reply-batch' ? [reply] : reply), { status: s.name === 'rpc-redirect' ? 302 : 200 });
      }
      if (s.held && (r.method === 'getSlot' || r.method === 'eth_getTransactionReceipt')) {
        s.entered.resolve();
        if (s.name === 'native-body' || s.name === 'sdk-body') {
          return new Response(new ReadableStream<Uint8Array>({ async start(controller) { await s.body.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: r.method === 'getSlot' ? 20 : null }))); controller.close(); } }));
        }
      }

}
export function createFetcher(s: ScenarioState): typeof fetch {
  return async (input, init) => {
    s.calls++;
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal);
    s.signals.push(init.signal);
    const url = String(input);
    if (url.startsWith('https://api.ccip.chain.link')) { return apiReply(s, url, init); }
    assert.ok(url === DEFAULT_SEPOLIA_RPC + '/' || url === DEFAULT_SOLANA_RPC + '/');
    assert.equal(init.method, 'POST'); assert.equal(typeof init.body, 'string');
    const payload: unknown = JSON.parse(String(init.body));
    const rows: unknown[] = Array.isArray(payload) ? payload : [payload];
    const replies: Record<string, unknown>[] = [];
    for (const raw of rows) {
      const r = object(raw); s.requests.push({ url, request: r, signal: init.signal });
      assert.ok(Array.isArray(r.params)); const params: readonly unknown[] = r.params;
      const interrupted = await interruptedReply(s, r); if (interrupted) { return interrupted; }
      const result = String(r.method).startsWith('eth_') ? evmReply(s, r, params) : solanaReply(s, r, params);
      replies.push({ jsonrpc: '2.0', id: r.id, result });
    }
    return new Response(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
  };

}

function evmBlock(s: ScenarioState): unknown {
  let result: unknown;
          const repeated = s.blockReads++ % 2 === 1, timestamp = repeated && s.mutations.endTimestamp !== undefined ? s.mutations.endTimestamp : s.mutations.timestamp;
          result = { ...(s.evmDecoders ? { parentHash: hash, nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1000000', gasUsed: '0x10000', miner: fixture.administrator, extraData: '0x', transactions: [] } : {}),
            hash: repeated ? s.mutations.endHash : s.mutations.blockHash, number: '0xa', ...(timestamp === undefined ? {} : { timestamp: timestamp === null ? null : '0x' + timestamp.toString(16) }) }; return result;
}

function solanaAccount(s: ScenarioState, params: readonly unknown[]): unknown {
  let result: unknown;
          assert.ok(s.lane?.recipientAtas);
          if (s.causal && params[0] !== fixture.mint && !Object.values(s.lane.recipientAtas).includes(String(params[0]))) {
            result = { context: { slot: 20 }, value: params[0] === svmOffRamp ? { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, data: ['', 'base64'] } :
              { owner: ROUTER_PROGRAM, executable: false, data: [createHash('sha256').update('account:AllowedOfframp').digest().subarray(0, 8).toString('base64'), 'base64'] } }; return result;
          }
          if (params[0] === fixture.mint) { result = mintAccount(s, s.mutations.mintContext); }
          else {
            const recipient = [fixture.recipient, FORWARD_RECIPIENT_B].find(owner => s.lane?.recipientAtas?.[owner] === params[0]);
            assert.ok(recipient); result = account(s, recipient, recipient === FORWARD_RECIPIENT_B ? '1000000000' : '0');
          } return result;
}
