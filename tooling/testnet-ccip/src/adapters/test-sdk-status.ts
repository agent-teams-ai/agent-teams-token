import { openTestSdk } from './test-sdk-admission.ts';
import { selectTestSdk, type ExplicitTestSdkSelection } from './test-sdk-policy.ts';
import { selectSepoliaRpc, selectSolanaRpc, TEST_RPC_RESPONSE_LIMIT } from './test-rpc.ts';
import { createOwnedNativeStatus, type NativeStatusLane, type StatusWait } from './transfer-status-native.mjs';
import { FORWARD_RECIPIENT_B } from '../domain/evm-forward.mjs';
import { selectedFixture } from '../domain/replacement-fixture.ts';
import { BURNMINT_PROGRAM } from '../domain/solana-pool-init.ts';
import { ROUTER_PROGRAM } from '../domain/solana-registration.ts';
import type { StatusChainPort, StatusApiPort, StatusNativePort, StatusSnapshot, StatusRequest, StatusLog, StatusExecution } from '../domain/transfer-status.mjs';
import type { CCIPRequest, ChainLog, Logger } from '../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/types.js';
import type { EVMChain } from '../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/index.js';
import type { SolanaChain } from '../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js';

export interface TestStatusOptions {
  readonly directory: string;
  readonly selection: ExplicitTestSdkSelection;
  readonly sepolia: string;
  readonly solana: string;
  readonly fetcher: typeof fetch;
  readonly now: () => number;
  readonly logger: Logger;
  readonly wait?: StatusWait;
}
export interface StatusPorts {
  readonly chains: Readonly<{ ethereum: StatusChainPort; solana: StatusChainPort }>;
  readonly api: StatusApiPort;
  readonly native: StatusNativePort & { snapshot(): Promise<StatusSnapshot> };
  readonly successState: number;
}
const API_ORIGIN = 'https://api.ccip.chain.link';
const EVM_READS = new Set(['eth_chainId', 'eth_call', 'eth_getBlockByNumber',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash']);
const SOLANA_READS = new Set(['getGenesisHash', 'getTransaction', 'getAccountInfo',
  'getSignatureStatuses', 'getBlock', 'getSlot', 'getTokenSupply', 'getBlockTime', 'simulateTransaction']);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function track<T>(set: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
  set.add(promise); void promise.then(() => set.delete(promise), () => set.delete(promise)); return promise;
}
type Refuse = (message: string) => never;
function validateViewSimulation(params: unknown[], refuse: Refuse): void {
  if (params.length !== 2 || typeof params[0] !== 'string' || !record(params[1]) ||
      params[1].sigVerify !== false || params[1].replaceRecentBlockhash !== true || params[1].encoding !== 'base64' || params[1].commitment !== 'confirmed') {
    refuse('Unexpected TEST status view simulation');
  }
}
function rpcRequestId(row: unknown, methods: ReadonlySet<string>, refuse: Refuse): string | number {
  if (!record(row) || row.jsonrpc !== '2.0' || typeof row.method !== 'string' || !methods.has(row.method) || !Array.isArray(row.params) ||
      Object.keys(row).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key)) ||
      !(typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id >= 0 || typeof row.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(row.id))) {
    return refuse('Non-read or malformed TEST status RPC request');
  }
  // The actual Solana source decoder reads typeVersion via an unsigned
  // view simulation. It neither signs nor submits a transaction.
  if (row.method === 'simulateTransaction') { validateViewSimulation(row.params, refuse); }
  return row.id;
}
function rpcRequestBody(body: RequestInit['body'], headers: Headers, methods: ReadonlySet<string>, refuse: Refuse) {
  if (body instanceof Uint8Array) {
    if (body.byteLength > TEST_RPC_RESPONSE_LIMIT) { return refuse('TEST status SDK request bytes exceed bound'); }
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return refuse('Invalid UTF-8 TEST status SDK request'); }
  }
  if (typeof body !== 'string' || Buffer.byteLength(body) > TEST_RPC_RESPONSE_LIMIT) { return refuse('Unexpected TEST status RPC body'); }
  if (headers.has('content-length') && headers.get('content-length') !== String(Buffer.byteLength(body))) { return refuse('Mismatched TEST status request length'); }
  headers.delete('content-length');
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return refuse('Invalid TEST status RPC JSON'); }
  const batch = Array.isArray(payload), rows: readonly unknown[] = Array.isArray(payload) ? payload : [payload];
  if (!rows.length || rows.length > 20) { return refuse('Invalid TEST status RPC batch'); }
  const ids = rows.map(row => rpcRequestId(row, methods, refuse));
  if (new Set(ids).size !== ids.length) { return refuse('Duplicate TEST status RPC request ID'); }
  return { body, ids, batch };
}
function validateApiRequest(url: URL, init: RequestInit | undefined, body: RequestInit['body'], refuse: Refuse, input: string | URL): void {
  if (url.origin !== API_ORIGIN || String(input) !== url.href || !/^\/v2\/messages\/0x[0-9a-fA-F]{64}$/.test(url.pathname) || url.search ||
      (init?.method ?? 'GET').toUpperCase() !== 'GET' || body !== undefined && body !== null) { refuse('Unexpected TEST status API discovery request'); }
}
function requestHeaders(init: RequestInit | undefined, methods: ReadonlySet<string> | undefined, refuse: Refuse): Headers {
  const headers = new Headers(init?.headers);
  for (const key of headers.keys()) {
    const allowed = methods ? ['content-type', 'accept-encoding', 'content-length', 'solana-client'] : ['content-type', 'x-sdk-version'];
    if (!allowed.includes(key)) { return refuse('Unexpected TEST status request header: ' + key); }
  }
  return headers;
}
function transportRequest(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, endpoint: string, methods: ReadonlySet<string> | undefined, refuse: Refuse) {
  if (typeof input !== 'string' && !(input instanceof URL)) { return refuse('Unexpected TEST status request input'); }
  const url = new URL(String(input));
  if (url.username || url.password || url.hash || init?.credentials && init.credentials !== 'omit') { return refuse('Credentialled/noncanonical TEST status request'); }
  const headers = requestHeaders(init, methods, refuse);
  const body = init?.body;
  if (methods) {
    if (String(input) !== endpoint && String(input) !== new URL(endpoint).href || init?.method?.toUpperCase() !== 'POST') { return refuse('Unexpected TEST status RPC endpoint/method'); }
    return { url, headers, ...rpcRequestBody(body, headers, methods, refuse) };
  }
  validateApiRequest(url, init, body, refuse, input);
  return { url, headers, body, ids: [] as readonly (string | number)[], batch: false };
}
function validRpcReply(row: unknown, ids: readonly (string | number)[], replyIds: ReadonlySet<string | number>): row is Record<string, unknown> & { id: string | number } {
  return record(row) && row.jsonrpc === '2.0' && (typeof row.id === 'number' || typeof row.id === 'string') && ids.includes(row.id) && !replyIds.has(row.id) &&
    ('result' in row) !== ('error' in row) && (!('error' in row) || record(row.error) && Number.isSafeInteger(row.error.code) && typeof row.error.message === 'string');
}
function validateRpcResponse(bytes: Uint8Array, batch: boolean, ids: readonly (string | number)[], refuse: Refuse): void {
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return refuse('Invalid TEST status RPC response JSON'); }
  const rows: readonly unknown[] = Array.isArray(decoded) ? decoded : [decoded];
  const replyIds = new Set<string | number>();
  if (Array.isArray(decoded) !== batch || rows.length !== ids.length) { return refuse('Mismatched TEST status RPC response batch'); }
  for (const row of rows) {
    if (!validRpcReply(row, ids, replyIds)) { return refuse('Invalid TEST status RPC response envelope'); }
    replyIds.add(row.id);
  }
}
function log(value: ChainLog): StatusLog {
  if (typeof value.data !== 'string') { throw new Error('Unsupported status SDK log data'); }
  return { transactionHash: value.transactionHash, index: value.index, address: value.address, data: value.data, topics: [...value.topics],
    ...('type' in value && typeof value.type === 'string' ? { type: value.type } : {}) };
}
/** Anti-corruption mapping checked against the actual SDK union, never an ambient DTO. */
function request(value: CCIPRequest): StatusRequest {
  const m = value.message;
  if (!('sourceChainSelector' in m) || !('destChainSelector' in m) || typeof m.sourceChainSelector !== 'bigint' || typeof m.destChainSelector !== 'bigint' || typeof m.data !== 'string') {
    throw new Error('Status requires SDK message selectors and bytes');
  }
  return { tx: { hash: value.tx.hash, from: value.tx.from }, log: log(value.log),
    lane: { sourceChainSelector: value.lane.sourceChainSelector, destChainSelector: value.lane.destChainSelector, onRamp: value.lane.onRamp },
    message: { data: m.data, messageId: m.messageId, sourceChainSelector: m.sourceChainSelector, destChainSelector: m.destChainSelector,
      sender: m.sender, receiver: m.receiver, sequenceNumber: m.sequenceNumber,
      ...('tokenReceiver' in m && typeof m.tokenReceiver === 'string' ? { tokenReceiver: m.tokenReceiver } : {}),
      tokenAmounts: m.tokenAmounts.map((token: unknown) => {
        if (!record(token) || typeof token.amount !== 'bigint' || typeof token.destTokenAddress !== 'string' || typeof token.sourcePoolAddress !== 'string') {
          throw new Error('Status requires decoded SDK token route');
        }
        return { amount: token.amount, destTokenAddress: token.destTokenAddress, sourcePoolAddress: token.sourcePoolAddress };
      }) } };
}
/** The same finite decoder mapping is used by the retained legacy composition. */
export function statusChainView(chain: Pick<EVMChain, 'getMessagesInTx' | 'getExecutionReceiptInTx'>,
  normalize: (address: string) => string): StatusChainPort {
  return {
    getMessagesInTx: async hash => (await chain.getMessagesInTx(hash)).map(request),
    getExecutionReceiptInTx: async (hash, filters): Promise<StatusExecution> => {
      const value = await chain.getExecutionReceiptInTx(hash, { ...filters, offRamp: normalize(filters.offRamp) });
      return { receipt: { messageId: value.receipt.messageId, sequenceNumber: value.receipt.sequenceNumber, state: value.receipt.state,
        ...(value.receipt.sourceChainSelector === undefined ? {} : { sourceChainSelector: value.receipt.sourceChainSelector }) }, log: log(value.log) };
    },
  };
}
/** One fixed status attempt. All capabilities are borrowed; only destroy owns release. */
export async function createTestSdkStatus(options: TestStatusOptions): Promise<Readonly<StatusPorts & { destroy(): Promise<void> }>> {
  const { directory, selection, fetcher, now, logger } = options;
  const selected = selectTestSdk(selection, directory, selectedFixture(selection));
  if (!selected || typeof fetcher !== 'function') { throw new Error('Explicit TEST status selection and replay fetch required'); }
  const sepolia = selectSepoliaRpc({ sepoliaRpc: options.sepolia }), solana = selectSolanaRpc({ solanaRpc: options.solana });
  const abort = new AbortController(), operations = new Set<Promise<unknown>>(), transports = new Set<Promise<unknown>>();
  const cancellationDebt: unknown[] = [];
  let closing = false, violation: Error | undefined, destruction: Promise<void> | undefined;
  // The owner and its work sets exist before admission or the first constructor.
  const session = await openTestSdk({ root: directory, archives: selected.archives });
  const acquired: (EVMChain | SolanaChain)[] = [];
  const latch = (message: string): Error => { const error = new Error(message); violation ??= error; logger.error(message); return violation; };
  const refuse = (message: string): never => { throw latch(message); };
  function healthy(): void { session.assertHealthy(); if (violation) { throw violation; } if (closing) { throw new Error('TEST status lifetime closed'); } abort.signal.throwIfAborted(); }
  function run<T>(operation: () => Promise<T>): Promise<T> {
    healthy();
    return track(operations, (async () => {
      try { const value = await operation(); healthy(); return value; }
      catch (error) { if (violation) { throw violation; } throw error; }
    })());
  }
  /** Fully consume physical bytes, including errors, before handing an inert response to SDK/native decoding. */
  async function consume(response: Response): Promise<Uint8Array> {
    if (!response.body) {
      if (response.redirected || response.status >= 300 && response.status < 400) { return refuse('Invalid/redirected TEST status response'); }
      return new Uint8Array();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    async function cancelRefused(message: string): Promise<never> {
      const error = latch(message);
      try { await reader.cancel(); }
      catch (cause) { cancellationDebt.push(cause); }
      // A rejected cancellation ends the JS promise, not the physical resource.
      // This Response has no independent release witness; its owner survives to process exit.
      throw error;
    }
    try {
      const length = response.headers.get('content-length');
      if (response.redirected || response.status >= 300 && response.status < 400 || length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(TEST_RPC_RESPONSE_LIMIT))) {
        return await cancelRefused('Invalid/redirected/over-bound TEST status response');
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        size += value.byteLength;
        if (size > TEST_RPC_RESPONSE_LIMIT) { return await cancelRefused('TEST status response exceeds byte bound'); }
        chunks.push(value);
      }
      return Buffer.concat(chunks, size);
    } finally { reader.releaseLock(); }
  }
  const transport = (endpoint: string, methods?: ReadonlySet<string>): typeof fetch => (input, init) => track(transports, (async () => {
    healthy();
    const { url, headers, body, ids, batch } = transportRequest(input, init, endpoint, methods, refuse);
    const signal = init?.signal ? AbortSignal.any([abort.signal, init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]);
    const response = await fetcher(url.href, { method: methods ? 'POST' : 'GET', headers, ...(typeof body === 'string' ? { body } : {}),
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal });
    const bytes = await consume(response);
    if (response.url && response.url !== url.href) { return refuse('TEST status response endpoint changed'); }
    if (methods && response.ok) { validateRpcResponse(bytes, batch, ids, refuse); }
    // Native jsonRpc owns its one bounded 429 retry. SDK/API receive the original HTTP error.
    return new Response(new Uint8Array(bytes), { status: response.status, statusText: response.statusText, headers: response.headers });
  })());
  function destroy(): Promise<void> {
    if (destruction) { return destruction; }
    closing = true; abort.abort();
    const physical = (async () => {
      const released = await Promise.allSettled(acquired.map(chain => Promise.resolve().then(() => chain.destroy())));
      // An SDK timeout or abort can settle an operation while its fetch/body is still held.
      while (operations.size || transports.size) { await Promise.allSettled([...operations, ...transports]); }
      if (cancellationDebt.length) { throw new AggregateError(cancellationDebt, 'Unresolved TEST status physical cancellation; admission guard retained until process exit'); }
      session.close();
      const errors = released.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) { throw new AggregateError(errors, 'TEST status chain cleanup failed'); }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    destruction = Promise.race([physical, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Unresolved TEST status drain; admission guard retained until physical settlement')), 20_000);
    })]).finally(() => clearTimeout(timer));
    // Physical work continues after the observation deadline. Only it (or process exit) closes the hooks.
    return destruction;
  }
  try {
    const rpcEvm = transport(sepolia, EVM_READS), rpcSolana = transport(solana, SOLANA_READS);
    const api = new session.api.CCIPAPIClient(API_ORIGIN, { fetch: transport(API_ORIGIN), logger, timeoutMs: 20_000 });
    // The pinned constructor memoizes getMessageById for four seconds. Status requires a fresh
    // discovery in each inspection; call the actual public method on this same explicit instance.
    api.getMessageById = (id, opts) => session.api.CCIPAPIClient.prototype.getMessageById.call(api, id, opts);
    const context = { apiClient: api, logger, abort: abort.signal, apiRetryConfig: { maxRetries: 0 } };
    const evm = await run(async () => { const value = await session.evm.EVMChain.fromUrl(sepolia, { ...context, fetch: rpcEvm }); acquired.push(value); return value; });
    const svm = await run(async () => { const value = await session.solana.SolanaChain.fromUrl(solana, { ...context, fetch: rpcSolana }); acquired.push(value); return value; });
    if (evm.network.family !== 'EVM' || evm.network.networkType !== 'TESTNET' || evm.network.chainSelector !== BigInt(selected.fixture.reverseSelector) ||
        svm.network.family !== 'SVM' || svm.network.networkType !== 'TESTNET' || svm.network.chainSelector !== BigInt(selected.fixture.forwardSelector)) { throw new Error('Wrong admitted TEST status networks'); }
    const { PublicKey } = session.native.web3, { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = session.native.spl;
    const mint = new PublicKey(selected.fixture.mint);
    const derive = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed), mint.toBuffer()], new PublicKey(BURNMINT_PROGRAM))[0].toBase58();
    const solanaSigner = derive('ccip_tokenpool_signer');
    const solanaPoolAta = getAssociatedTokenAddressSync(mint, new PublicKey(solanaSigner), true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();
    const recipients = [selected.fixture.recipient, FORWARD_RECIPIENT_B];
    const recipientAtas = Object.freeze(Object.fromEntries(recipients.map(recipient => [recipient,
      getAssociatedTokenAddressSync(mint, new PublicKey(recipient), false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()])));
    if (new Set(Object.values(recipientAtas)).size !== 2 || recipients.some(recipient => !recipientAtas[recipient] || recipientAtas[recipient] === solanaPoolAta) || derive('ccip_tokenpool_config') !== selected.fixture.solanaPool) { throw new Error('Invalid independently derived status lane'); }
    const routerAbi = new session.abi.Interface(['function isOffRamp(uint64,address) view returns(bool)']);
    const lane: NativeStatusLane = Object.freeze({ fixture: selected.fixture, recipientAtas, solanaPoolAta, solanaSigner, solanaPool: selected.fixture.solanaPool,
      solanaSpender: PublicKey.findProgramAddressSync([Buffer.from('fee_billing_signer')], new PublicKey(ROUTER_PROGRAM))[0].toBase58(),
      isOffRampData: (selector, offRamp) => routerAbi.encodeFunctionData('isOffRamp', [selector, offRamp]),
      allowedOffRamp: (selector, offRamp) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(selector); return PublicKey.findProgramAddressSync([Buffer.from('allowed_offramp'), bytes, new PublicKey(offRamp).toBuffer()], new PublicKey(ROUTER_PROGRAM))[0].toBase58(); },
      solanaLog: async (hash, kind, slot) => {
        const transaction = await svm.getTransaction(hash);
        if (transaction.hash !== hash || transaction.tx.slot !== slot || transaction.error !== null) { throw new Error('SDK/native Solana execution location disagrees'); }
        const matches = transaction.logs.filter(value => value.type === 'data' && (kind === 'mint' ? session.solana.SolanaChain.decodeReceipt(value)?.state === session.types.ExecutionState.Success :
          value.address === ROUTER_PROGRAM && session.solana.SolanaChain.decodeMessage(value) !== undefined));
        const value = matches[0];
        if (matches.length !== 1 || !value) { throw new Error('Unique official Solana execution log missing'); }
        return { ...log(value), level: value.level };
      } });
    const nativeFetch: typeof fetch = (input, init) => String(input) === sepolia || String(input) === new URL(sepolia).href ? rpcEvm(input, init) : rpcSolana(input, init);
    const native = createOwnedNativeStatus({ sepolia, solana, lane, fetcher: nativeFetch, now, wait: options.wait, signal: abort.signal });
    function chainPort(chain: EVMChain | SolanaChain, normalize: (address: string) => string): StatusChainPort {
      const view = statusChainView(chain, normalize);
      return Object.freeze({ getMessagesInTx: hash => run(() => view.getMessagesInTx(hash)),
        getExecutionReceiptInTx: (hash, filters) => run(() => view.getExecutionReceiptInTx(hash, filters)) });
    }
    const apiView: StatusApiPort = { getMessageById: (id, opts) => run(async () => {
        const value = await api.getMessageById(id, { signal: AbortSignal.any([abort.signal, opts.signal]) });
        const m = value.metadata;
        return { metadata: { status: m.status, readyForManualExecution: m.readyForManualExecution,
          ...(m.receiptTransactionHash === undefined ? {} : { receiptTransactionHash: m.receiptTransactionHash }), ...(m.offRamp === undefined ? {} : { offRamp: m.offRamp }) } };
      }) };
    const nativeView: StatusPorts['native'] = { lane: Object.freeze({ fixture: selected.fixture, solanaPool: selected.fixture.solanaPool }),
        ethereum: (hash, kind) => run(() => native.ethereum(hash, kind)), solana: (hash, kind, recipient) => run(() => native.solana(hash, kind, recipient)),
        authorizeOffRamp: (chain, offRamp, selector) => run(() => native.authorizeOffRamp(chain, offRamp, selector)), snapshot: () => run(() => native.snapshot()) };
    return Object.freeze({ chains: Object.freeze({ ethereum: chainPort(evm, session.address.getAddress), solana: chainPort(svm, address => address) }),
      api: Object.freeze(apiView), native: Object.freeze(nativeView),
      successState: session.types.ExecutionState.Success, destroy });
  } catch (error) { await destroy(); throw error; }
}
