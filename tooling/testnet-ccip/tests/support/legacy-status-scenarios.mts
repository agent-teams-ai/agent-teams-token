import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, Hash, type BinaryToTextEncoding } from 'node:crypto';
import { runStatus, type StatusSettings } from '../../src/composition/transfer-status.mjs';
import type { StatusTransferInput } from '../../src/domain/transfer-status.mjs';
import { DEFAULT_SEPOLIA_RPC, DEFAULT_SOLANA_RPC } from '../../src/adapters/test-rpc.ts';
import { BURNMINT_PROGRAM } from '../../src/domain/solana-pool-init.ts';
import { ROUTER_PROGRAM } from '../../src/domain/solana-registration.ts';
import { FORWARD_RECIPIENT_B } from '../../src/domain/evm-forward.mjs';
import type { SolanaChain } from '../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js';
import type * as Web3 from '../../../../.local/INPUT/provider/node_modules/@solana/web3.js/lib/index.js';
import type * as Spl from '../../../../.local/INPUT/provider/node_modules/@solana/spl-token/lib/types/index.js';
import { fixture, time, hash, svmOffRamp, token, present, object, u64, discriminator } from './native-status-controls.mts';
// Exercise runStatus's actual absent-profile assembly, not just a lane supplied
// directly to createNativeStatus. The retained installation has TEST root/lock
// bytes, so the unmodified legacy pin refuses it. Only that installation check
// and EVM's older string-body transport boundary are controlled below. Real
// public SDK constructors, transactions, official decoders, native ancestry,
// collection, cleanup and finalization still execute. This is not qualification
// of the unavailable pinned legacy installation or of public CCIP delivery.
async function legacyState() {
  const directory = resolve('.local/INPUT/provider');
  const sdk: typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/index.js') = await import(pathToFileURL(directory + '/node_modules/@chainlink/ccip-sdk/dist/index.js').href);
  const require = createRequire(directory + '/package.json');
  const web3: typeof Web3 = require('@solana/web3.js'), spl: typeof Spl = require('@solana/spl-token');
  const anchor: typeof import('../../../../.local/INPUT/provider/node_modules/@coral-xyz/anchor/dist/cjs/index.js') = require('@coral-xyz/anchor');
  const router: typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js') = await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js')).href);
  const abi: typeof import('../../../../.local/INPUT/provider/node_modules/ethers/lib.esm/abi/index.js') = await import(pathToFileURL(directory + '/node_modules/ethers/lib.esm/abi/index.js').href);
  const sourceAbi: typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/abi/OnRamp_1_6.js') = await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/evm/abi/OnRamp_1_6.js')).href);
  const executionAbi: typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/abi/OffRamp_1_6.js') = await import(pathToFileURL(require.resolve('@chainlink/ccip-sdk/dist/evm/abi/OffRamp_1_6.js')).href);
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
  const executionData = ids.slice(0, 2).map(id => Buffer.concat([discriminator('ExecutionStateChanged'), u64(BigInt(fixture.reverseSelector)),
    u64(7n), Buffer.from(id.slice(2), 'hex'), Buffer.from(hash.slice(2), 'hex'), Buffer.from([sdk.ExecutionState.Success])]).toString('base64'));
  type Ramp = import('../../../../.local/INPUT/provider/node_modules/@coral-xyz/anchor/dist/cjs/index.js').IdlTypes<typeof router.IDL>['SVM2AnyRampMessage'];
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
  let mutant = '', target = 0, controlledFetches = 0, decodedReads = 0, pinChecks = 0, constructed = 0, destroyed = 0;
  return { directory, sdk, signer, recipientAtas, poolAta, spender, ids, sources, destinations, onRamp, evmOffRamp, executionData, sendData, sourceEvents, releaseEvent, typeAndVersion, mutant, target, controlledFetches, decodedReads, pinChecks, constructed, destroyed };
}
type LegacyState = Awaited<ReturnType<typeof legacyState>>;
function transactions(s: LegacyState, index: number, parsed: boolean) {
    const reverse = index === 2, owner = index === 1 ? FORWARD_RECIPIENT_B : fixture.recipient;
    const ata = present(s.recipientAtas[owner]), signature = present(reverse ? s.sources[index] : s.destinations[index]);
    const program = reverse ? ROUTER_PROGRAM : svmOffRamp, data = present(reverse ? s.sendData : s.executionData[index]);
    const change = index === s.target ? s.mutant : '';
    const pool = { programId: BURNMINT_PROGRAM, stackHeight: 2 };
    const effect = reverse ? { programId: token, stackHeight: 3, parsed: { type: 'burn', info: { mint: fixture.mint, account: s.poolAta, authority: s.signer, amount: fixture.amount } } } :
      { programId: token, stackHeight: 3, parsed: { type: 'mintTo', info: { mint: fixture.mint, account: ata, mintAuthority: s.signer, amount: fixture.amount } } };
    const transfer = { programId: token, stackHeight: 2, parsed: { type: 'transferChecked', info: { mint: fixture.mint, source: ata, destination: s.poolAta, authority: s.spender, tokenAmount: { amount: fixture.amount, decimals: 9 } } } };
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
    ({ logs, instructions } = mutateEvent({ logs, instructions }, change, data, reverse));
    if (parsed) {
      return { slot: 20, transaction: { signatures: [signature], message: { accountKeys: reverse ? [ata, s.poolAta, { pubkey: fixture.payer, signer: true }] : [ata], instructions } },
        meta: { err: null, logMessages: logs, innerInstructions,
          preTokenBalances: reverse ? [balance(0, owner, fixture.amount), balance(1, s.signer, '0')] : [balance(0, owner, '0')],
          postTokenBalances: reverse ? [balance(0, owner, '0'), balance(1, s.signer, '0')] : [balance(0, owner, fixture.amount)] } };
    }
    return { slot: change === 'sdk-slot' ? 21 : 20, blockTime: time / 1000, version: 0,
      transaction: { signatures: [signature], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        accountKeys: [fixture.payer, program], recentBlockhash: fixture.mint, instructions: [], addressTableLookups: [] } },
      meta: { err: change === 'sdk-failure' ? { InstructionError: [0, 'InvalidArgument'] } : null, fee: 1, preBalances: [1, 1], postBalances: [1, 1],
        innerInstructions: [], preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: [], readonly: [] }, logMessages: logs } };
}
function mutateEvent(event: { logs: string[]; instructions: { programId: string }[] }, change: string, data: string, reverse: boolean) {
  let { logs, instructions } = event;
    if (change === 'duplicate-event') {
      // decodeReceipt intentionally hides earlier states for the same message.
      // A second distinct official Success must still make ownership ambiguous.
      const duplicate = Buffer.from(data, 'base64'); if (!reverse) { duplicate.fill(0xee, 24, 56); }
      logs.splice(logs.length - 1, 0, `Program data: ${duplicate.toString('base64')}`);
    }
    if (change === 'missing-event') { logs = logs.filter(line => !line.startsWith('Program data:')); }
    if (change === 'failed-receipt' && !reverse) { logs = logs.map(line => line === `Program data: ${data}` ? `Program data: ${Buffer.concat([Buffer.from(data, 'base64').subarray(0, -1), Buffer.from([3])]).toString('base64')}` : line); }
    if (change === 'non-router-send' && reverse) { logs = logs.map(line => line.replaceAll(ROUTER_PROGRAM, fixture.payer)); instructions[0] = { programId: fixture.payer }; }
  return { logs, instructions };
}
function balance(accountIndex: number, owner: string, quantity: string) { return { accountIndex, mint: fixture.mint, owner, programId: token, uiTokenAmount: { amount: quantity, decimals: 9 } }; }
function legacySolanaReply(s: LegacyState, request: Record<string, unknown>, params: readonly unknown[]): unknown {
  let result: unknown;
  switch (request.method) {
        case 'getGenesisHash': result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'; break;
        case 'getTransaction': {
          const index = params[0] === s.sources[2] ? 2 : s.destinations.indexOf(String(params[0])); assert.ok(index >= 0 && index <= 2);
          result = transactions(s, index, object(params[1]).encoding === 'jsonParsed'); break;
        }
        case 'getSignatureStatuses': result = { context: { slot: 20 }, value: [{ slot: 20, err: null, confirmationStatus: 'finalized' }] }; break;
        case 'getBlock': result = { blockhash: fixture.mint, signatures: [...s.destinations.slice(0, 2), present(s.sources[2])] }; break;
        case 'getSlot': result = 20; break;
        case 'getTokenSupply': result = { context: { slot: 20 }, value: { amount: fixture.amount, decimals: 9, uiAmount: 1, uiAmountString: '1' } }; break;
        case 'getBlockTime': result = time / 1000; break;
        case 'getAccountInfo': {
          if (params[0] === fixture.mint) { result = { context: { slot: 20 }, value: { owner: token, executable: false, data: { parsed: { type: 'mint', info: {
            decimals: 9, isInitialized: true, freezeAuthority: null, mintAuthority: s.signer, supply: fixture.amount } } } } }; }
          else if (Object.values(s.recipientAtas).includes(String(params[0]))) {
            const owner = params[0] === s.recipientAtas[fixture.recipient] ? fixture.recipient : FORWARD_RECIPIENT_B;
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
    default: throw new Error('Unexpected controlled legacy method ' + String(request.method));
  }
  return result;
}
function legacyEvmReply(s: LegacyState, request: Record<string, unknown>, params: readonly unknown[]): unknown {
  let result: unknown;
  switch (request.method) {
        case 'eth_chainId': result = '0xaa36a7'; break;
        case 'eth_getTransactionReceipt': {
          const txHash = String(params[0]), reverse = txHash === s.destinations[2], index = s.sources.indexOf(txHash);
          assert.ok(reverse || index === 0 || index === 1);
          const log = (address: string, event: { data: string; topics: readonly string[] }, logIndex: number) => ({ address, ...event, logIndex: '0x' + logIndex.toString(16),
            transactionHash: txHash, blockHash: hash, blockNumber: '0xa', transactionIndex: '0x0', removed: false });
          const transfer = { topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            '0x' + (reverse ? fixture.pool : fixture.administrator).slice(2).padStart(64, '0'), '0x' + (reverse ? fixture.administrator : fixture.pool).slice(2).padStart(64, '0')],
            data: '0x' + BigInt(fixture.amount).toString(16).padStart(64, '0') };
          result = { transactionHash: txHash, blockHash: hash, blockNumber: '0xa', transactionIndex: '0x0', from: fixture.administrator,
            to: '0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59', status: '0x1', type: '0x0', cumulativeGasUsed: '0x10000', gasUsed: '0x10000', effectiveGasPrice: '0x1', logsBloom: '0x' + '00'.repeat(256),
            logs: reverse ? [log(s.evmOffRamp, s.releaseEvent, 0), log(fixture.token, transfer, 1)] : [log(fixture.token, transfer, 0), log(s.onRamp, present(s.sourceEvents[index]), 1)] }; break;
        }
        case 'eth_getTransactionByHash': result = { hash: params[0], chainId: '0xaa36a7', from: fixture.administrator,
          to: '0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59', input: '0x1234', value: '0x0', nonce: '0x5', blockHash: hash, blockNumber: '0xa' }; break;
        case 'eth_getBlockByNumber': result = { hash, number: '0xa', timestamp: '0x' + (time / 1000).toString(16), parentHash: hash, nonce: '0x0000000000000000',
          difficulty: '0x0', gasLimit: '0x1000000', gasUsed: '0x10000', miner: fixture.administrator, extraData: '0x', transactions: [] }; break;
        case 'eth_call': {
          const call = object(params[0]); result = call.to === s.onRamp ? s.typeAndVersion : params[1] === 'finalized' ? '0x1' :
            '0x' + (call.data === '0x18160ddd' ? 100000000000n : call.data === '0x313ce567' ? 9n : 1000000000n).toString(16).padStart(64, '0'); break;
        }
    default: throw new Error('Unexpected controlled legacy method ' + String(request.method));
  }
  return result;
}
function rpcReply(s: LegacyState, request: Record<string, unknown>) {
  assert.ok(Array.isArray(request.params)); const params: readonly unknown[] = request.params;
  const result = String(request.method).startsWith('eth_') ? legacyEvmReply(s, request, params) : legacySolanaReply(s, request, params);
  return { jsonrpc: '2.0', id: request.id, result };
}
function createLegacyFetcher(s: LegacyState): typeof fetch {
  return async (input, init) => {
    s.controlledFetches++;
    const url = String(input);
    if (url.startsWith('https://api.ccip.chain.link/v2/messages/')) { assert.equal(init?.method, 'GET'); return new Response('{}', { status: 404 }); }
    assert.ok([DEFAULT_SEPOLIA_RPC, DEFAULT_SEPOLIA_RPC + '/', DEFAULT_SOLANA_RPC, DEFAULT_SOLANA_RPC + '/'].includes(url), url);
    assert.equal(init?.method, 'POST');
    const body = init?.body; assert.ok(typeof body === 'string' || body instanceof Uint8Array);
    const payload: unknown = JSON.parse(typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body));
    const replies = (Array.isArray(payload) ? payload : [payload]).map(value => {
      return rpcReply(s, object(value));
    });
    return new Response(JSON.stringify(Array.isArray(payload) ? replies : present(replies[0])));
  };

}
function installLegacyControls(s: LegacyState, fetcher: typeof fetch): void {
  const realDigest = Hash.prototype.digest;
  function installationDigest(this: Hash): Buffer;
  function installationDigest(this: Hash, encoding: BinaryToTextEncoding): string;
  function installationDigest(this: Hash, encoding?: BinaryToTextEncoding): Buffer | string {
    const actual = realDigest.call(this, 'hex');
    const expected = actual === '9bc50499bd486b1457bb2efb85951ed8b90d15faf13b39d36d3bb97a2338ccc4' ? '8cf7da517123c8be46f0a5fa14ef67904bf45bf4cfb972fc2c54be4b91cb56fb' :
      actual === 'f65db5bc0003f0cfe4545ab853a991cea43ec7b172ad52e5002e7f25dd7ce8c1' ? '1477c1d04940f9556ff87eaf82de6f0f2eaa6f3585deea0f09bfdab8fba7f50f' : actual;
    if (expected !== actual) { s.pinChecks++; }
    const bytes = Buffer.from(expected, 'hex'); return encoding === undefined ? bytes : bytes.toString(encoding);
  }
  const originalFromUrl = s.sdk.EVMChain.fromUrl;
  mock.method(Hash.prototype, 'digest', installationDigest);
  // The actual installed EVM constructor produces Uint8Array bodies. The legacy
  // transport accepts strings. Reuse the real constructor with the controlled
  // transport; do not change production RPC policy to solve this separate limit.
  mock.method(s.sdk.EVMChain, 'fromUrl', async (url: string, context?: Parameters<typeof s.sdk.EVMChain.fromUrl>[1]) => {
    assert.equal(url, DEFAULT_SEPOLIA_RPC); assert.equal(typeof context?.fetch, 'function');
    const chain = await originalFromUrl.call(s.sdk.EVMChain, url, { ...context, fetch: fetcher });
    s.constructed++; const destroy = chain.destroy; chain.destroy = () => { s.destroyed++; destroy(); }; return chain;
  });
  const originalSolanaFromUrl = s.sdk.SolanaChain.fromUrl;
  mock.method(s.sdk.SolanaChain, 'fromUrl', async (url: string, context?: Parameters<typeof s.sdk.SolanaChain.fromUrl>[1]) => {
    const chain = await originalSolanaFromUrl.call(s.sdk.SolanaChain, url, context);
    s.constructed++; const destroy = chain.destroy; chain.destroy = () => { s.destroyed++; destroy(); }; return chain;
  });
  const originalGetTransaction = s.sdk.SolanaChain.prototype.getTransaction;
  mock.method(s.sdk.SolanaChain.prototype, 'getTransaction', async function(this: SolanaChain, requested: string) {
    s.decodedReads++; const transaction = await originalGetTransaction.call(this, requested);
    if (requested === (s.target === 2 ? s.sources[2] : s.destinations[s.target])) {
      if (s.mutant === 'sdk-hash') { transaction.hash = '4'.repeat(64); }
      if (s.mutant.startsWith('sdk-log-')) {
        const log = present(transaction.logs.find(value => value.type === 'data'));
        if (s.mutant === 'sdk-log-index') { log.index = 0; }
        if (s.mutant === 'sdk-log-address') { log.address = fixture.payer; }
        if (s.mutant === 'sdk-log-data') { log.data = Buffer.alloc(16).toString('base64'); }
        if (s.mutant === 'sdk-log-type') { log.type = 'log'; }
        if (s.mutant === 'sdk-log-depth') { log.level = 2; }
      }
    }
    return transaction;
  });
}
async function positive(s: LegacyState, settings: StatusSettings, name: string, inputs: readonly StatusTransferInput[]) {
      let report: Awaited<ReturnType<typeof runStatus>> | undefined;
      await assert.doesNotReject(async () => { report = await runStatus({ ...settings, transfers: inputs }, () => time); }, name + ': valid official invocation must collect');
      assert.ok(report);
      assert.equal(report.readOnly, true); assert.equal(report.transfers.length, inputs.length);
      for (const [index, transfer] of report.transfers.entries()) {
        const input = present(inputs[index]), route = s.sources.indexOf(input.sourceHash); assert.ok(route >= 0);
        assert.equal(transfer.status, 'settled', name + ': ' + JSON.stringify(transfer, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
        assert.equal(transfer.pendingAmount, 0n); assert.equal(transfer.destinationError, undefined); assert.equal(transfer.identity.messageId, s.ids[route]);
        assert.equal(transfer.selectedRecipient, route === 1 ? FORWARD_RECIPIENT_B : fixture.recipient);
        const effect = present(transfer.events.find(event => event.chain === 'solana'));
        assert.equal(effect.kind, route === 2 ? 'burn' : 'mint'); assert.equal(effect.eventIndex, route === 2 ? 3 : 2);
        assert.equal(effect.transactionId, route === 2 ? s.sources[2] : s.destinations[route]);
      }
      return report;
}
export async function legacyComposition(name: string): Promise<void> {
  const s = await legacyState(), fetcher = createLegacyFetcher(s);
  const transfers: StatusTransferInput[] = [fixture.recipient, FORWARD_RECIPIENT_B].map((recipient, index) => ({ direction: 'ethereum-to-solana', recipient,
    sourceHash: present(s.sources[index]), destinationReceipt: { transactionHash: present(s.destinations[index]), offRamp: svmOffRamp } }));
  transfers.push({ direction: 'solana-to-ethereum', sourceHash: present(s.sources[2]), destinationReceipt: { transactionHash: present(s.destinations[2]), offRamp: s.evmOffRamp } });
  const settings: StatusSettings = { testOnly: true, fixture, fixtureIdentity: fixture.identity, sdkDirectory: s.directory, transfers, completeFixtureInventory: true };
  assert.equal(Object.hasOwn(settings, 'providerProfile'), false);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('External fetch forbidden'); };
  await assert.rejects(runStatus(settings, () => time), /Unreviewed SDK installation/);
  assert.equal(s.controlledFetches, 0);
  installLegacyControls(s, fetcher);
  globalThis.fetch = fetcher;
  try {
    if (name === 'legacy-inventory') {
      const report = await positive(s, settings, name, transfers); assert.equal(report.accounting.status, 'exact');
      assert.equal(new Set(report.transfers.flatMap(transfer => transfer.events.map(event => `${event.chain}:${event.transactionId}:${event.eventIndex}`))).size, 6);
    } else {
      s.target = name === 'legacy-a' ? 0 : name === 'legacy-b' ? 1 : 2;
      const input = present(transfers[s.target]); await positive(s, settings, name, [input]);
      for (const change of ['unrelated-parent', 'same-program-split', 'sdk-slot', 'sdk-hash', 'sdk-failure', 'duplicate-event', 'missing-event',
        'sdk-log-index', 'sdk-log-address', 'sdk-log-data', 'sdk-log-type', 'sdk-log-depth', s.target === 2 ? 'non-router-send' : 'failed-receipt']) {
        s.mutant = change;
        if (s.target === 2) { await assert.rejects(runStatus({ ...settings, transfers: [input] }, () => time), /execution|invocation|order/i, change); }
        else {
          const report = await runStatus({ ...settings, transfers: [input] }, () => time);
          const transfer = present(report.transfers[0]); assert.equal(transfer.status, 'pending', change); assert.equal(transfer.pendingAmount, null, change);
          assert.equal(transfer.events.length, 1, change); assert.match(present(transfer.destinationError), /unproven/); assert.equal(report.accounting.status, 'unknown');
        }
        s.mutant = ''; await positive(s, settings, name, [input]);
      }
    }
    assert.equal(s.constructed, s.destroyed); assert.ok(s.constructed > 0 && s.decodedReads > 0); assert.equal(s.pinChecks, s.constructed);
    process.stdout.write(JSON.stringify({ scenario: name, qualification: 'UNQUALIFIED', evidence: 'actual-legacy-composition-controlled-public-SDK-ports',
      installation: 'retained TEST bytes; legacy pin check explicitly stubbed', sdkVersion: s.sdk.SDK_VERSION, controlledFetches: s.controlledFetches, decodedReads: s.decodedReads, constructed: s.constructed, destroyed: s.destroyed, networkEffects: 0, signingEffects: 0 }) + '\n');
  } finally { mock.restoreAll(); globalThis.fetch = realFetch; }
}
