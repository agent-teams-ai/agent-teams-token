// @ts-check
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROUTER_PROGRAM } from '../domain/solana-registration.ts';
import { BURNMINT_PROGRAM } from '../domain/solana-pool-init.ts';
import { createSepoliaRpc } from './evm-rpc.ts';
import { readTestRpcJson } from './test-rpc.ts';
import { forwardRoute, forwardRecipient, FORWARD_RECIPIENT_B } from '../domain/evm-forward.mjs';
import { reverseRoute } from '../domain/solana-reverse.mjs';
/** @typedef {import('../domain/replacement-fixture.ts').ReplacementFixture} ReplacementFixture */
/** @typedef {import('../domain/transfer-status.mjs').StatusNativeProof} StatusNativeProof */
/** @typedef {import('../domain/transfer-status.mjs').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../domain/transfer-status.mjs').StatusNativePort} StatusNativePort */
/** @typedef {Parameters<StatusNativePort['ethereum']>[1]} EffectKind */
/** @typedef {{ fixture?: ReplacementFixture, recipientAtas?: Readonly<Record<string, string>>, solanaPoolAta?: string,
 * solanaSigner?: string, solanaSpender?: string, solanaPool?: string,
 * allowedOffRamp?: (selector: bigint, offRamp: string) => string,
 * isOffRampData?: (selector: bigint, offRamp: string) => string,
 * solanaLog?: (hash: string, kind: EffectKind, slot: number) => Promise<InvocationLog> }} NativeStatusLane */
/** Official SDK decoded event metadata, retaining its raw log position and depth.
 * @typedef {import('../domain/transfer-status.mjs').StatusLog & { level: number }} InvocationLog */
/** @typedef {(delay: number, signal?: AbortSignal) => Promise<void>} StatusWait */
/** @typedef {{ programId: string, stackHeight?: number, parsed?: { type: string, info: Record<string, unknown> } }} ParsedInstruction */
/** @typedef {{ ix: ParsedInstruction, index: number, topIndex: number, innerIndex: number | null }} InstructionPosition */
/** @typedef {{ position: InstructionPosition, start: number, end: number, parent?: InvocationFrame }} InvocationFrame */
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Native JSON is untrusted even on an admitted SDK's endpoint. @param {unknown} value */
function object(value) { if (!isObject(value)) { throw new Error('Invalid native object'); } return value; }
/** @param {unknown} value @returns {readonly unknown[]} */
function array(value) { if (!Array.isArray(value)) { throw new Error('Invalid native array'); } return value; }
/** @param {unknown} value */
function text(value) { if (typeof value !== 'string') { throw new Error('Invalid native text'); } return value; }
/** @param {unknown} value */
function integer(value) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { throw new Error('Invalid native slot/index'); } return value; }
/** @param {unknown} value */
function amount(value) { const s = text(value); if (!/^(?:0|[1-9][0-9]*)$/.test(s) || s.length > 78) { throw new Error('Invalid native amount'); } return BigInt(s); }
/** @param {unknown} value */
function hexQuantity(value) { const s = text(value); if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(s) || s.length > 66) { throw new Error('Invalid native quantity'); } return BigInt(s); }
/** Padded ABI words are uint values, not JSON-RPC quantity encodings. @param {unknown} value */
function hexUint(value) { const s = text(value); if (!/^0x[0-9a-f]{1,64}$/i.test(s)) { throw new Error('Invalid native uint'); } return BigInt(s); }
/** @param {unknown} value */
function hexHash(value) { const s = text(value); if (!/^0x[0-9a-f]{64}$/i.test(s)) { throw new Error('Invalid native block hash'); } return s.toLowerCase(); }
/** @param {string} address */
const topic = address => '0x' + address.slice(2).padStart(64, '0');
const STATUS_READ_METHODS = new Set([
  'eth_call', 'eth_chainId', 'eth_getTransactionReceipt', 'eth_getBlockByNumber',
  'getAccountInfo', 'getGenesisHash', 'getTransaction', 'getSignatureStatuses',
  'getBlock', 'getSlot', 'getTokenSupply', 'getBlockTime',
]);
/** @param {Response} response @param {unknown} body @param {number} requestId */
function rpcRateLimited(response, body, requestId) {
  return response.status === 429 || (response.ok && isObject(body) && body.id === requestId && body.jsonrpc === '2.0' &&
    !('result' in body) && isObject(body.error) && body.error.code === 429 && typeof body.error.message === 'string');
}
/** @param {Response} response */
function retryDelay(response) {
  const header = response.headers.get('retry-after');
  if (header === null) { return 1000; }
  if (!/^\d+(?:\.\d+)?$/.test(header)) { return null; }
  const seconds = Number(header);
  return seconds <= 10 ? seconds * 1000 : null;
}
/** @param {Response} response */
async function rpcBody(response) {
  try { return await readTestRpcJson(response); }
  catch (error) { if (response.status !== 429 || !(error instanceof SyntaxError)) { throw error; } return null; }
}
/** @param {Response} response @param {unknown} body @param {number} requestId */
function rpcResult(response, body, requestId) {
  if (!response.ok || response.redirected || !isObject(body) || body.id !== requestId || body.jsonrpc !== '2.0' || 'error' in body || !('result' in body)) { throw new Error('Invalid native RPC response'); }
  return body.result;
}
/** @type {StatusWait} */
const defaultWait = async (delay, signal) => { await sleep(delay, undefined, signal ? { signal } : {}); };
/** @param {string} endpoint @param {typeof fetch} [fetcher] @param {StatusWait} [wait] @param {AbortSignal} [signal] */
export function jsonRpc(endpoint, fetcher = fetch, wait = defaultWait, signal) {
  let id = 0;
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) { throw new Error('Invalid RPC URL'); }
  /** @param {string} method @param {readonly unknown[]} params */
  return async (method, params) => {
    const requestId = ++id;
    const requestBody = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params });
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(20_000);
      const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: requestBody, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      const body = await rpcBody(response);
      const delay = attempt === 0 && STATUS_READ_METHODS.has(method) && rpcRateLimited(response, body, requestId) ? retryDelay(response) : null;
      if (delay === null) { return rpcResult(response, body, requestId); }
      await wait(delay, signal);
    }
  };
}
/** @param {unknown} receipt @param {EffectKind} kind @param {ReplacementFixture} [fixture] */
export function evmEffect(receipt, kind, fixture) {
  if (kind !== 'lock' && kind !== 'release') { throw new Error('Invalid EVM effect kind'); }
  const route = forwardRoute(fixture);
  const from = kind === 'lock' ? route.administrator : route.pool, to = kind === 'lock' ? route.pool : route.administrator;
  const logs = array(object(receipt).logs).map(object).filter(log => {
    const topics = array(log.topics);
    return text(log.address).toLowerCase() === route.token && topics.length === 3 && text(topics[0]).toLowerCase() === TRANSFER &&
      text(topics[1]).toLowerCase() === topic(from) && text(topics[2]).toLowerCase() === topic(to);
  });
  const log = logs[0];
  if (logs.length !== 1 || !log || hexUint(log.data) !== route.amount || log.removed === true) { throw new Error('Exact unique ERC20 effect missing'); }
  return integer(Number(hexQuantity(log.logIndex)));
}
/** @param {unknown} value @returns {ParsedInstruction} */
function instruction(value) {
  const ix = object(value), parsed = ix.parsed;
  return { programId: text(ix.programId), ...(ix.stackHeight === null || ix.stackHeight === undefined ? {} : { stackHeight: integer(ix.stackHeight) }),
    ...(isObject(parsed) ? { parsed: { type: text(parsed.type), info: object(parsed.info) } } : {}) };
}
/** Canonical top-level instruction, then its ordered CPI instructions. @param {unknown} tx @param {boolean} [strict] */
function orderedSolanaInstructions(tx, strict = true) {
  const top = array(object(object(object(tx).transaction).message).instructions).map(instruction);
  const groups = array(object(object(tx).meta).innerInstructions ?? []).map(object);
  /** @type {Map<number, readonly ParsedInstruction[]>} */
  const byIndex = new Map();
  let previous = -1;
  for (const group of groups) {
    // Retain legacy fixture decoding; replacement requires real execution positions.
    if (!strict && group.index === undefined) { continue; }
    const index = integer(group.index);
    if (index >= top.length || index <= previous || byIndex.has(index)) { throw new Error('Invalid SPL execution order'); }
    previous = index; byIndex.set(index, array(group.instructions).map(instruction));
  }
  if (!strict && groups.some(group => group.index === undefined)) {
    return [...top, ...groups.flatMap(group => array(group.instructions).map(instruction))].map((ix, index) => ({ ix, index, topIndex: index, innerIndex: null }));
  }
  let index = 0;
  return top.flatMap((ix, topIndex) => [{ ix, index: index++, topIndex, innerIndex: null },
    ...(byIndex.get(topIndex) ?? []).map((inner, innerIndex) => ({ ix: inner, index: index++, topIndex, innerIndex }))]);
}
/** Align native instruction coordinates with the runtime invocation trace. Event bytes
 * are decoded by the official SDK; this only binds that event to its physical CPI owner.
 * Missing heights, truncated traces and unsupported synthetic events fail closed.
 * @param {unknown} tx @param {readonly InstructionPosition[]} positions @param {InvocationLog | undefined} event */
function invocationOwnership(tx, positions, event) {
  const logs = array(object(object(tx).meta).logMessages).map(text);
  if (!event || event.type !== 'data' || logs[event.index] !== 'Program data: ' + event.data) { throw new Error('Missing authenticated Solana invocation event'); }
  /** @type {InvocationFrame[]} */
  const stack = [], frames = [];
  let cursor = 0;
  /** @type {InvocationFrame | undefined} */
  let owner;
  for (const [index, line] of logs.entries()) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line), finish = /^Program (\S+) (success|failed:.*)$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth !== stack.length + 1) { throw new Error('Invalid Solana invocation depth'); }
      if (depth === 1) {
        // Some builtins omit trace lines. Only ungrouped top-level instructions
        // can be skipped; no token CPI or its parent can disappear this way.
        cursor = skipUntracedBuiltins(positions, cursor, invoke[1]);
      }
      const position = positions[cursor++], parent = stack.at(-1);
      if (!validInvocationPosition(position, invoke[1], depth, parent)) { throw new Error('Solana instruction/invocation coordinates disagree'); }
      const frame = { position, start: index, end: -1, ...(parent ? { parent } : {}) };
      frames.push(frame); stack.push(frame);
    } else if (finish) {
      finishInvocation(stack, positions[cursor], finish, index);
    }
    if (index === event.index) { owner = stack.at(-1); }
  }
  let level = 0;
  for (let frame = owner; frame; frame = frame.parent) { level++; }
  if (stack.length || !owner || owner.position.ix.programId !== event.address || event.level !== level ||
    positions.slice(cursor).some(position => position.innerIndex !== null)) { throw new Error('Unproven Solana invocation ancestry'); }
  return { frames, owner, eventIndex: event.index };
}
/** @param {readonly InstructionPosition[]} positions @param {number} cursor @param {string | undefined} program */
function skipUntracedBuiltins(positions, cursor, program) {
  while (positions[cursor]?.innerIndex === null && positions[cursor]?.ix.programId !== program &&
    positions[cursor + 1]?.topIndex !== positions[cursor]?.topIndex) { cursor++; }
  return cursor;
}
/** @param {InstructionPosition | undefined} position @param {string | undefined} program @param {number} depth @param {InvocationFrame | undefined} parent
 * @returns {position is InstructionPosition} */
function validInvocationPosition(position, program, depth, parent) {
  return !!position && position.ix.programId === program && (depth === 1 ? position.innerIndex === null &&
    (position.ix.stackHeight === undefined || position.ix.stackHeight === 1) :
    position.innerIndex !== null && position.ix.stackHeight === depth && position.topIndex === parent?.position.topIndex);
}
/** @param {InvocationFrame[]} stack @param {InstructionPosition | undefined} next @param {RegExpExecArray} finish @param {number} index */
function finishInvocation(stack, next, finish, index) {
  const frame = stack.pop();
  if (!frame || frame.position.ix.programId !== finish[1] || finish[2] !== 'success' ||
    !stack.length && next?.innerIndex !== null && next?.topIndex === frame.position.topIndex) { throw new Error('Invalid/incomplete Solana invocation return'); }
  frame.end = index;
}
/** @param {InvocationFrame | undefined} frame @param {InvocationFrame} ancestor */
function descendsFrom(frame, ancestor) { for (; frame; frame = frame.parent) { if (frame === ancestor) { return true; } } return false; }
/** @param {ReturnType<typeof invocationOwnership>} trace @param {number} index */
function poolInvocation(trace, index) {
  const frame = trace.frames.find(value => value.position.index === index), pool = frame?.parent;
  if (!frame || frame.position.ix.programId !== TOKEN || !pool || pool.position.ix.programId !== BURNMINT_PROGRAM ||
    !descendsFrom(pool, trace.owner)) { throw new Error('SPL effect outside authenticated pool execution'); }
  if (pool.end >= trace.eventIndex) { throw new Error('Solana pool effect/event order unproven'); }
  return pool;
}
/** @param {unknown} tx */
function accountKeys(tx) { return array(object(object(object(tx).transaction).message).accountKeys).map(key => typeof key === 'string' ? key : text(object(key).pubkey)); }
/** @param {unknown} values @param {number} index @param {string} mint @param {string} owner @param {boolean} strict */
function balanceAt(values, index, mint, owner, strict) {
  const matches = array(values ?? []).map(object).filter(value => value.accountIndex === index);
  if (matches.length > 1) { throw new Error('Duplicate SPL token balance'); }
  return matches.map(value => {
    const ui = object(value.uiTokenAmount);
    if (value.mint !== mint || value.owner !== owner || value.programId !== TOKEN || strict && ui.decimals !== 9) { throw new Error('Missing exact SPL account ownership/decimals'); }
    return amount(ui.amount);
  });
}
/** @param {unknown} tx @param {string} owner @param {string} expectedAta @param {NativeStatusLane} lane @param {ReplacementFixture} [fixture] */
function verifyPoolBurnBalances(tx, owner, expectedAta, lane, fixture) {
  const reverse = reverseRoute(fixture), keys = accountKeys(tx), meta = object(object(tx).meta);
  for (const [account, authority, pre, post] of [[expectedAta, owner, reverse.amount, 0n], [lane.solanaPoolAta, lane.solanaSigner, 0n, 0n]]) {
    const index = keys.indexOf(text(account));
    if (index < 0 || keys.lastIndexOf(text(account)) !== index) { throw new Error('Missing exact SPL account ownership'); }
    const before = balanceAt(meta.preTokenBalances, index, reverse.mint, text(authority), true);
    const after = balanceAt(meta.postTokenBalances, index, reverse.mint, text(authority), true);
    if (before.length !== 1 || after.length !== 1 || before[0] !== pre || after[0] !== post) { throw new Error('SPL pool burn balances do not reconcile'); }
  }
}
/** @param {readonly InstructionPosition[]} instructions @param {string} mint */
function poolBurnPair(instructions, mint) {
  /** @param {readonly string[]} types */
  const candidates = types => instructions.filter(({ ix }) =>
    ix.programId === TOKEN && ix.parsed && types.includes(ix.parsed.type) && ix.parsed.info.mint === mint);
  const transfers = candidates(['transferChecked']), burns = candidates(['burn', 'burnChecked']);
  const first = transfers[0], last = burns[0], transfer = first?.ix.parsed?.info, burn = last?.ix.parsed?.info;
  if (transfers.length !== 1 || burns.length !== 1 || !first || !last || !transfer || !burn) { throw new Error('Exact unique SPL pool transfer/burn missing'); }
  return { first, last, transfer, burn };
}
/** @param {ReturnType<typeof poolBurnPair>} pair @param {string} expectedAta @param {NativeStatusLane} lane @param {bigint} expectedAmount */
function verifyPoolBurnPair({ first, last, transfer, burn }, expectedAta, lane, expectedAmount) {
  const tokenAmount = object(transfer.tokenAmount);
  if (first.index >= last.index || transfer.source !== expectedAta || transfer.destination !== lane.solanaPoolAta ||
      transfer.authority !== lane.solanaSpender || tokenAmount.amount !== expectedAmount.toString() || tokenAmount.decimals !== 9 ||
      last.ix.parsed?.type !== 'burn' || burn.account !== lane.solanaPoolAta || burn.authority !== lane.solanaSigner || burn.amount !== expectedAmount.toString()) { throw new Error('Wrong canonical SPL pool transfer/burn'); }
}
/** The official reverse CPI transfers A's tokens to the pool before burning.
 * @param {unknown} tx @param {string} owner @param {string | undefined} expectedAta @param {{ lane: NativeStatusLane, event?: InvocationLog | undefined }} context */
function solanaPoolBurn(tx, owner, expectedAta, { lane, event }) {
  const fixture = lane.fixture, reverse = reverseRoute(fixture);
  if (owner !== forwardRoute(fixture).recipient) { throw new Error('B reverse is not supported'); }
  if (!expectedAta || !lane.solanaPoolAta || !lane.solanaSigner || !lane.solanaSpender || expectedAta === lane.solanaPoolAta) { throw new Error('Missing canonical burn lane'); }
  const instructions = orderedSolanaInstructions(tx), pair = poolBurnPair(instructions, reverse.mint);
  verifyPoolBurnPair(pair, expectedAta, lane, reverse.amount);
  if (fixture) {
    const trace = invocationOwnership(tx, instructions, event);
    const transferFrame = trace.frames.find(frame => frame.position.index === pair.first.index), pool = poolInvocation(trace, pair.last.index);
    // Router transfers to the pool, then invokes that pool to burn. Both belong
    // to the exact router frame emitting this decoded send, not another call to it.
    if (trace.owner.position.ix.programId !== ROUTER_PROGRAM || !transferFrame || transferFrame.parent !== trace.owner || pool.parent !== trace.owner) { throw new Error('Split Solana router transfer/burn execution'); }
  }
  verifyPoolBurnBalances(tx, owner, expectedAta, lane, fixture);
  return pair.last.index;
}
/** Parsed instructions are native RPC decoding of actual transaction bytes, not CCIP metadata.
 * @param {unknown} tx @param {EffectKind} kind @param {unknown} [recipient] @param {string} [expectedAta] @param {NativeStatusLane} [lane] */
export function solanaEffect(tx, kind, recipient, expectedAta, lane = {}) {
  return authenticatedSolanaEffect(tx, kind, recipient, expectedAta, { lane });
}
/** @param {unknown} tx @param {EffectKind} kind @param {unknown} recipient @param {string | undefined} expectedAta
 * @param {{ lane: NativeStatusLane, event?: InvocationLog | undefined }} context */
export function authenticatedSolanaEffect(tx, kind, recipient, expectedAta, { lane, event }) {
  if (kind !== 'mint' && kind !== 'burn') { throw new Error('Invalid SPL effect kind'); }
  const fixture = lane.fixture, reverse = reverseRoute(fixture), owner = forwardRecipient(recipient, fixture);
  if (fixture && (!expectedAta || lane.recipientAtas?.[owner] !== expectedAta || !lane.solanaSigner || expectedAta === lane.solanaPoolAta)) { throw new Error('Missing canonical recipient ATA/authority'); }
  if (kind === 'burn') { return solanaPoolBurn(tx, owner, expectedAta, { lane, event }); }
  const instructions = orderedSolanaInstructions(tx, fixture !== undefined);
  const matches = instructions.filter(({ ix }) => ix.programId === TOKEN &&
    ix.parsed && ['mintTo', 'mintToChecked'].includes(ix.parsed.type) && ix.parsed.info.mint === reverse.mint);
  const match = matches[0], info = match?.ix.parsed?.info;
  if (matches.length !== 1 || !match || !info) { throw new Error('Exact unique SPL mint instruction missing'); }
  verifyMintInstruction(match, info, lane, reverse.amount);
  const account = text(info.account);
  if (expectedAta !== undefined && account !== expectedAta) { throw new Error('Wrong canonical recipient ATA'); }
  verifyMintBalances(tx, account, owner, lane);
  if (fixture) {
    const trace = invocationOwnership(tx, instructions, event);
    if (poolInvocation(trace, match.index).parent !== trace.owner) { throw new Error('Split Solana offRamp/pool execution'); }
  }
  return match.index;
}
/** @param {Record<string, unknown>} info @param {string | undefined} signer */
function exactPoolMintAuthority(info, signer) {
  // Solana's parser labels an extra, repeated authority meta as multisig.
  // Accept only the exact pool PDA repeated once, never arbitrary multisig keys.
  if (!signer) { return false; }
  if (Object.hasOwn(info, 'multisigMintAuthority')) {
    return info.multisigMintAuthority === signer && info.mintAuthority === undefined && info.authority === undefined &&
      Array.isArray(info.signers) && info.signers.length === 1 && info.signers[0] === signer;
  }
  return info.mintAuthority === signer && info.signers === undefined &&
    (info.authority === undefined || info.authority === info.mintAuthority);
}
/** @param {InstructionPosition} match @param {Record<string, unknown>} info @param {NativeStatusLane} lane @param {bigint} expectedAmount */
function verifyMintInstruction(match, info, lane, expectedAmount) {
  const fixture = lane.fixture;
  const tokenAmount = isObject(info.tokenAmount) ? info.tokenAmount : undefined;
  if (amount(info.amount ?? tokenAmount?.amount) !== expectedAmount || fixture && !exactPoolMintAuthority(info, lane.solanaSigner) ||
      fixture && match.ix.parsed?.type === 'mintToChecked' && tokenAmount?.decimals !== 9) { throw new Error('Wrong SPL mint amount/authority/decimals'); }
}
/** @param {unknown} tx @param {string} account @param {string} owner @param {NativeStatusLane} lane */
function verifyMintBalances(tx, account, owner, lane) {
  const fixture = lane.fixture, reverse = reverseRoute(fixture);
  const keys = accountKeys(tx), index = keys.indexOf(account), meta = object(object(tx).meta);
  if (index < 0 || keys.lastIndexOf(account) !== index) { throw new Error('Missing exact SPL account ownership'); }
  const before = balanceAt(meta.preTokenBalances, index, reverse.mint, owner, fixture !== undefined);
  const after = balanceAt(meta.postTokenBalances, index, reverse.mint, owner, fixture !== undefined);
  if (after.length !== 1 || after[0] === undefined || after[0] - (before[0] ?? 0n) !== reverse.amount) { throw new Error('SPL token effect does not reconcile'); }
}
/** @param {unknown} account @param {NativeStatusLane} lane */
function verifyMint(account, lane) {
  const value = object(object(account).value), parsed = object(object(value.data).parsed), info = object(parsed.info);
  if (value.owner !== TOKEN || parsed.type !== 'mint' || info.decimals !== 9 || info.isInitialized !== true || info.freezeAuthority !== null ||
      !lane.solanaSigner || info.mintAuthority !== lane.solanaSigner || lane.fixture && value.executable !== false) { throw new Error('Unexpected mint identity/state'); }
  return info;
}
/** @param {unknown} timestamp @param {number} now @param {number} maxAgeSeconds */
function blockFreshness(timestamp, now, maxAgeSeconds) {
  const valid = typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp >= 0;
  const ageSeconds = valid ? now / 1000 - timestamp : null;
  return { timestamp: valid ? timestamp : null, ageSeconds, maxAgeSeconds, fresh: ageSeconds !== null && ageSeconds >= 0 && ageSeconds <= maxAgeSeconds };
}
/** Recheck original observations without restoring trust lost during collection.
 * @param {StatusSnapshot} snapshot @param {number} now */
export function refreshSnapshotFreshness(snapshot, now) {
  if (!Number.isSafeInteger(now) || now < 0) { throw new Error('Invalid snapshot clock'); }
  /** @param {'ethereum'|'solana'|'solanaRepeated'} chain @param {number} limit */
  const refresh = (chain, limit) => {
    const observation = snapshot.freshness?.[chain], current = blockFreshness(observation?.timestamp, now, limit);
    return { ...observation, ...current, fresh: observation?.fresh === true && current.fresh };
  };
  const freshness = { ethereum: refresh('ethereum', 1800), solana: refresh('solana', 300), solanaRepeated: refresh('solanaRepeated', 300) };
  return { ...snapshot, freshness, freshnessCheckedAt: new Date(now).toISOString(), coherent: snapshot.coherent === true && Object.values(freshness).every(value => value.fresh) };
}
/** @param {unknown} value */
function contextSlot(value) { return integer(object(object(value).context).slot); }
/** @param {unknown} raw @returns {NonNullable<StatusNativeProof['logs']>} */
function receiptLogs(raw) { return array(raw).map(value => { const log = object(value); return { logIndex: text(log.logIndex), address: text(log.address), data: text(log.data), topics: array(log.topics).map(text) }; }); }
/** @param {unknown} tx @returns {StatusNativeProof['transaction']} */
function solanaTransaction(tx) {
  const message = object(object(object(tx).transaction).message);
  return { message: { accountKeys: array(message.accountKeys).map(value => {
    if (typeof value === 'string') { return { pubkey: value }; }
    const key = object(value); return { pubkey: text(key.pubkey), ...(typeof key.signer === 'boolean' ? { signer: key.signer } : {}) };
  }), instructions: array(message.instructions).map(value => ({ programId: text(object(value).programId) })) } };
}
/** @param {Record<string, unknown>} meta @param {Record<string, unknown>} status @param {Record<string, unknown>} transaction @param {number} slot @param {string} hash */
function verifySuccessfulSolana(meta, status, transaction, slot, hash) {
  if (meta.err !== null || status.err !== null || status.confirmationStatus !== 'finalized' || status.slot !== slot || array(transaction.signatures)[0] !== hash) { throw new Error('Solana transaction not successful finalized'); }
}
/** @param {unknown} observed @param {{ ata: string, recipient: string, mint: string, minimum: number }} expected */
function recipientAccount(observed, { ata, recipient, mint, minimum }) {
  const accountSlot = contextSlot(observed), value = object(object(observed).value), parsed = object(object(value.data).parsed), info = object(parsed.info), ui = object(info.tokenAmount);
  if (value.owner !== TOKEN || value.executable !== false || parsed.type !== 'account' || info.state !== 'initialized' || info.mint !== mint || info.owner !== recipient || ui.decimals !== 9 || accountSlot < minimum) { throw new Error('Wrong observed recipient account metadata'); }
  return { ata, owner: text(info.owner), mint: text(info.mint), amount: amount(ui.amount), decimals: integer(ui.decimals), slot: accountSlot };
}
/** @param {ReturnType<typeof jsonRpc>} svm @param {NativeStatusLane} lane
 * @param {{ fixture: ReplacementFixture, mintAccount: unknown, mint: Record<string, unknown>, first: Record<string, unknown>, slot: number, firstSlot: number }} initial */
async function replacementAccounts(svm, lane, { fixture, mintAccount, mint, first, slot, firstSlot }) {
  const route = forwardRoute(fixture), reverse = reverseRoute(fixture);
  let minimum = firstSlot;
  let metadataCoherent = contextSlot(mintAccount) >= slot && contextSlot(mintAccount) <= firstSlot && amount(mint.supply) === amount(first.amount);
  /** @type {Record<string, ReturnType<typeof recipientAccount>>} */
  const recipientAccounts = {};
  for (const recipient of [route.recipient, FORWARD_RECIPIENT_B]) {
    const ata = lane.recipientAtas?.[recipient];
    if (!ata || ata === lane.solanaPoolAta || lane.recipientAtas?.[route.recipient] === lane.recipientAtas?.[FORWARD_RECIPIENT_B]) { throw new Error('Missing canonical selected ATA map'); }
    const observed = await svm('getAccountInfo', [ata, { commitment: 'finalized', encoding: 'jsonParsed', minContextSlot: minimum }]);
    const account = recipientAccount(observed, { ata, recipient, mint: reverse.mint, minimum });
    minimum = account.slot;
    recipientAccounts[recipient] = account;
  }
  // These independently read accounts are only a subset of the mint's
  // holdings. A sum above its observed supply is a conflicting snapshot,
  // even when each account's owner/program/decimals is individually valid.
  metadataCoherent &&= Object.values(recipientAccounts).reduce((sum, account) => sum + account.amount, 0n) <= amount(first.amount);
  const endMintAccount = await svm('getAccountInfo', [reverse.mint, { commitment: 'finalized', encoding: 'jsonParsed', minContextSlot: minimum }]);
  const endMint = verifyMint(endMintAccount, lane), endMintSlot = contextSlot(endMintAccount);
  metadataCoherent &&= endMintSlot >= minimum && amount(endMint.supply) === amount(mint.supply);
  return { minimum: endMintSlot, metadataCoherent, recipientAccounts };
}
/** @param {Record<string, unknown>} block @param {Record<string, unknown>} end */
function sameCanonicalBlock(block, end) { return end.hash === block.hash && end.number === block.number && end.timestamp === block.timestamp; }
/** @param {unknown} timestamp */
function ethereumTimestamp(timestamp) { return typeof timestamp === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(timestamp) ? Number(timestamp) : null; }
/** @param {string} sepolia @param {string} solana @param {NativeStatusLane} [lane] @param {typeof fetch} [fetcher] @param {() => number} [now] */
export function createNativeStatus(sepolia, solana, lane = {}, fetcher = fetch, now = Date.now) {
  return createOwnedNativeStatus({ sepolia, solana, lane, fetcher, now });
}
/** @param {{ sepolia: string, solana: string, lane?: NativeStatusLane, fetcher?: typeof fetch, now?: () => number,
 * wait?: StatusWait | undefined, signal?: AbortSignal }} options */
export function createOwnedNativeStatus({ sepolia, solana, lane = {}, fetcher = fetch, now = Date.now, wait = defaultWait, signal }) {
  const fixture = lane.fixture, route = forwardRoute(fixture), reverse = reverseRoute(fixture);
  const evm = jsonRpc(sepolia, fetcher, wait, signal), svm = jsonRpc(solana, fetcher, wait, signal), observer = createSepoliaRpc(sepolia, fetcher);
  return {
    lane,
    /** @param {'ethereum'|'solana'} chain @param {string} offRamp @param {bigint} selector */
    async authorizeOffRamp(chain, offRamp, selector) {
      if (chain === 'ethereum') {
        if (!lane.isOffRampData) { throw new Error('Missing offRamp decoder'); }
        if (hexUint(await evm('eth_call', [{ to: route.router, data: lane.isOffRampData(selector, offRamp) }, 'finalized'])) !== 1n) { throw new Error('Unauthorized EVM offRamp'); }
      } else {
        if (!lane.allowedOffRamp) { throw new Error('Missing offRamp derivation'); }
        const marker = object(await svm('getAccountInfo', [lane.allowedOffRamp(selector, offRamp), { commitment: 'finalized', encoding: 'base64' }]));
        const program = object(await svm('getAccountInfo', [offRamp, { commitment: 'finalized', encoding: 'base64' }]));
        const value = object(marker.value), data = array(value.data), bytes = Buffer.from(text(data[0]), 'base64');
        if (value.owner !== ROUTER_PROGRAM || value.executable !== false || !bytes.equals(createHash('sha256').update('account:AllowedOfframp').digest().subarray(0, 8)) || object(program.value).executable !== true) { throw new Error('Unauthorized Solana offRamp'); }
      }
    },
    /** @param {string} hash @param {EffectKind} kind @returns {Promise<StatusNativeProof>} */
    async ethereum(hash, kind) {
      const canonical = hash.toLowerCase(), observation = await observer.observe(canonical);
      if (observation.kind !== 'observed' || !observation.finalizedBlock || observation.receipt?.status !== 1 || !observation.transaction.to) { throw new Error('Ethereum transaction not successful finalized'); }
      const receipt = object(await evm('eth_getTransactionReceipt', [canonical]));
      if (receipt.blockHash !== observation.receipt.blockHash || receipt.transactionHash !== canonical || hexQuantity(receipt.blockNumber).toString() !== observation.receipt.blockNumber || hexQuantity(receipt.status) !== 1n) { throw new Error('Receipt changed'); }
      return { transaction: { from: observation.transaction.from, to: observation.transaction.to }, logs: receiptLogs(receipt.logs), eventIndex: evmEffect(receipt, kind, fixture), blockHash: hexHash(receipt.blockHash), blockHeight: hexQuantity(receipt.blockNumber) };
    },
    /** @param {string} hash @param {EffectKind} kind @param {string} [recipient] @returns {Promise<StatusNativeProof>} */
    async solana(hash, kind, recipient = route.recipient) {
      if (await svm('getGenesisHash', []) !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') { throw new Error('Wrong Solana cluster'); }
      const tx = object(await svm('getTransaction', [hash, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]));
      const statuses = object(await svm('getSignatureStatuses', [[hash], { searchTransactionHistory: true }])), status = object(array(statuses.value)[0]);
      const meta = object(tx.meta), transaction = object(tx.transaction), slot = integer(tx.slot);
      verifySuccessfulSolana(meta, status, transaction, slot, hash);
      const params = [slot, { commitment: 'finalized', transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0 }];
      const block = object(await svm('getBlock', params));
      if (!array(block.signatures).includes(hash)) { throw new Error('Solana canonical block does not contain transaction'); }
      if (fixture) {
        if (contextSlot(statuses) < slot) { throw new Error('Invalid finalized signature context'); }
        const again = object(await svm('getBlock', params));
        if (again.blockhash !== block.blockhash || !array(again.signatures).includes(hash)) { throw new Error('Solana canonical block changed'); }
        const mint = await svm('getAccountInfo', [reverse.mint, { commitment: 'finalized', encoding: 'jsonParsed', minContextSlot: slot }]);
        verifyMint(mint, lane);
        if (contextSlot(mint) < slot) { throw new Error('Invalid finalized mint context'); }
      }
      const event = fixture ? await lane.solanaLog?.(hash, kind, slot) : undefined;
      if (fixture && kind === 'mint') {
        if (!event || event.address === BURNMINT_PROGRAM || event.address === ROUTER_PROGRAM) { throw new Error('Missing official offRamp execution owner'); }
        await this.authorizeOffRamp('solana', event.address, BigInt(fixture.reverseSelector));
      }
      return { transaction: solanaTransaction(tx), ...(meta.logMessages === undefined ? {} : { programLogs: array(meta.logMessages).map(text) }), eventIndex: authenticatedSolanaEffect(tx, kind, recipient, lane.recipientAtas?.[recipient], { lane, event }), blockHash: text(block.blockhash), blockHeight: BigInt(slot) };
    },
    /** @returns {Promise<StatusSnapshot & { recipientAccounts?: Readonly<Record<string, { ata: string, owner: string, mint: string, amount: bigint, decimals: number, slot: number }>> }>} */
    async snapshot() {
      if (hexQuantity(await evm('eth_chainId', [])) !== 11155111n || await svm('getGenesisHash', []) !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') { throw new Error('Wrong accounting chains'); }
      const block = object(await evm('eth_getBlockByNumber', ['finalized', false]));
      const slot = integer(await svm('getSlot', [{ commitment: 'finalized' }]));
      /** @param {string} data */
      const call = data => evm('eth_call', [{ to: route.token, data }, { blockHash: block.hash, requireCanonical: true }]);
      const total = hexUint(await call('0x18160ddd')), locked = hexUint(await call('0x70a08231' + route.pool.slice(2).padStart(64, '0')));
      const mintAccount = await svm('getAccountInfo', [reverse.mint, { commitment: 'finalized', encoding: 'jsonParsed', minContextSlot: slot }]);
      const mint = verifyMint(mintAccount, lane);
      const supply = object(await svm('getTokenSupply', [reverse.mint, { commitment: 'finalized', minContextSlot: slot }]));
      const firstSlot = contextSlot(supply), first = object(supply.value);
      let minimum = firstSlot, metadataCoherent = true;
      /** @type {Record<string, { ata: string, owner: string, mint: string, amount: bigint, decimals: number, slot: number }>} */
      let recipientAccounts = {};
      if (fixture) {
        if (hexUint(await call('0x313ce567')) !== 9n) { throw new Error('Wrong independently observed EVM decimals'); }
        ({ minimum, metadataCoherent, recipientAccounts } = await replacementAccounts(svm, lane, { fixture, mintAccount, mint, first, slot, firstSlot }));
      }
      const end = object(await evm('eth_getBlockByNumber', [block.number, false]));
      const endSupply = object(await svm('getTokenSupply', [reverse.mint, { commitment: 'finalized', minContextSlot: minimum }]));
      const repeatedSlot = contextSlot(endSupply), repeated = object(endSupply.value);
      const supplyTime = await svm('getBlockTime', [firstSlot]);
      const endSupplyTime = repeatedSlot === firstSlot ? supplyTime : await svm('getBlockTime', [repeatedSlot]);
      const observedAt = now();
      if (!Number.isSafeInteger(observedAt) || observedAt < 0) { throw new Error('Invalid snapshot clock'); }
      const ethereumTime = ethereumTimestamp(block.timestamp);
      const freshness = { ethereum: blockFreshness(ethereumTime, observedAt, 1800), solana: { slot: firstSlot, ...blockFreshness(supplyTime, observedAt, 300) }, solanaRepeated: { slot: repeatedSlot, ...blockFreshness(endSupplyTime, observedAt, 300) } };
      if (total !== 100_000_000_000n || first.decimals !== 9 || fixture && repeated.decimals !== 9) { throw new Error('Immutable supply/decimals mismatch'); }
      if (fixture) { hexHash(block.hash); hexQuantity(block.number); }
      return { fixedSupply: total, lockedOnEthereum: locked, supplyOnSolana: amount(first.amount), decimals: integer(first.decimals),
        ...(fixture ? { fixtureIdentity: fixture.identity, recipientAccounts } : {}), ethereumBlock: text(block.hash), ethereumHeight: hexQuantity(block.number), solanaSlot: firstSlot, freshness,
        coherent: metadataCoherent && Object.values(freshness).every(value => value.fresh) && sameCanonicalBlock(block, end) && firstSlot >= slot && repeatedSlot >= minimum && repeated.amount === first.amount,
        observedAt: new Date(observedAt).toISOString() };
    },
  };
}
