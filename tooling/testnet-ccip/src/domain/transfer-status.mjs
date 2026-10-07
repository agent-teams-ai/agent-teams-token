// @ts-check
import { projectMessage } from '../../../../packages/domain/src/features/ccip-status/message.ts';
import { reconcileSupply } from '../../../../packages/domain/src/supply.ts';
import { forwardRoute, forwardRecipient, FORWARD_RECIPIENT_B } from './evm-forward.mjs';
import { reverseRoute } from './solana-reverse.mjs';
import { validateReplacementFixture } from './replacement-fixture.ts';
import { ROUTER_PROGRAM } from './solana-registration.ts';
/** @typedef {import('./replacement-fixture.ts').ReplacementFixture} ReplacementFixture */
/** @typedef {import('../../../../packages/domain/src/features/ccip-status/message.ts').Direction} Direction */
/** @typedef {import('../../../../packages/domain/src/features/ccip-status/message.ts').TransferIdentity} TransferIdentity */
/** @typedef {import('../../../../packages/domain/src/features/ccip-status/message.ts').TransferEvent} TransferEvent */
/** @typedef {import('../../../../packages/domain/src/features/ccip-status/message.ts').MessageState & {
 * sourceHash?: string, fixtureIdentity?: string, selectedRecipient?: string,
 * route?: StatusRouteAssociation, events: readonly TransferEvent[], discoveryOrigin?: string,
 * discoveryStatus?: string, discoveryError?: string | undefined, destinationError?: string | undefined
 * }} StatusTransferReport */
/** Actual decoded source route, separate from the logical A/B slot.
 * @typedef {{ sourceSelector: bigint, destinationSelector: bigint, sourcePool: string,
 * sender: string, receiver: string, tokenReceiver?: string }} StatusRouteAssociation */
/** @typedef {{ timestamp: number | null, maxAgeSeconds: number, fresh: boolean, slot?: number }} StatusFreshness */
/** Snapshot values are independently observed; the selected fixture supplies expectations only.
 * Optional association/decimals fields are mandatory for replacement exact acceptance.
 * @typedef {{ fixedSupply: bigint, lockedOnEthereum: bigint, supplyOnSolana: bigint,
 * coherent: boolean, ethereumHeight: bigint, solanaSlot: number, ethereumBlock?: string,
 * fixtureIdentity?: string, decimals?: number, observedAt?: string, freshnessCheckedAt?: string,
 * pendingEthereumToSolana?: bigint | null, pendingSolanaToEthereum?: bigint | null,
 * freshness?: { ethereum: StatusFreshness, solana: StatusFreshness, solanaRepeated: StatusFreshness }
 * }} StatusSnapshot */
/** Consuming ports describe facts provided by existing decoders and authenticated native observers.
 * They do not grant signing, transport or native qualification.
 * @typedef {{ transactionHash: string, index: number, address: string, data: string, topics: readonly string[], type?: string }} StatusLog */
/** @typedef {{ amount: bigint, destTokenAddress: string, sourcePoolAddress: string }} StatusTokenAmount */
/** @typedef {{ data: string, messageId: string, sourceChainSelector: bigint, destChainSelector: bigint,
 * sender: string, receiver: string, tokenReceiver?: string, sequenceNumber: bigint,
 * tokenAmounts: readonly StatusTokenAmount[] }} StatusMessage */
/** @typedef {{ tx: { hash: string, from?: string }, log: StatusLog,
 * lane: { sourceChainSelector: bigint, destChainSelector: bigint, onRamp: string }, message: StatusMessage }} StatusRequest */
/** @typedef {{ transactionHash: string, offRamp: string }} StatusReceiptHint */
/** @typedef {{ logs?: readonly { logIndex: string, address: string, data: string, topics: readonly string[] }[],
 * programLogs?: readonly string[], eventIndex: number, blockHash: string, blockHeight: bigint,
 * transaction: { to?: string, from?: string, message?: {
 * accountKeys: readonly { pubkey: string, signer?: boolean }[], instructions: readonly { programId: string }[] } }
 * }} StatusNativeProof */
/** @typedef {{ receipt: { messageId: string, sequenceNumber: bigint, sourceChainSelector?: bigint, state: number }, log: StatusLog }} StatusExecution */
/** @typedef {{ getMessagesInTx(hash: string): Promise<readonly StatusRequest[]>,
 * getExecutionReceiptInTx(hash: string, filters: { offRamp: string, messageId: string, sourceChainSelector: bigint }): Promise<StatusExecution>
 * }} StatusChainPort */
/** @typedef {{ lane?: { fixture?: ReplacementFixture, solanaPool?: string },
 * ethereum(hash: string, kind: TransferEvent['kind'], recipient?: string): Promise<StatusNativeProof>,
 * solana(hash: string, kind: TransferEvent['kind'], recipient?: string): Promise<StatusNativeProof>,
 * authorizeOffRamp(chain: TransferEvent['chain'], offRamp: string, selector: bigint): Promise<void> }} StatusNativePort */
/** @typedef {{ status?: string, readyForManualExecution?: boolean, receiptTransactionHash?: string, offRamp?: string }} StatusMetadata */
/** @typedef {{ metadata?: StatusMetadata | undefined, discoveryError?: string | undefined,
 * destinationError?: string | undefined, receipt?: StatusReceiptHint | undefined, discoveryOrigin?: string | undefined }} StatusDiscovery */
/** @typedef {{ getMessageById(messageId: string, options: { signal: AbortSignal }): Promise<{ metadata?: StatusMetadata }> }} StatusApiPort */
/** @typedef {{ sourceHash: string, direction: Direction, recipient?: unknown, destinationReceipt?: unknown }} StatusTransferInput */
/** @param {unknown} a @param {string} b */
const equal = (a, b) => typeof a === 'string' && (b.startsWith('0x') ? a.toLowerCase() === b : a === b);
/** @param {unknown} direction @param {unknown=} recipient @param {ReplacementFixture=} fixture */
export function statusRecipient(direction, recipient, fixture) {
  if (!['ethereum-to-solana', 'solana-to-ethereum'].some(value => value === direction)) { throw new Error('Invalid transfer direction'); }
  const selected = forwardRecipient(recipient, fixture);
  if (direction === 'solana-to-ethereum' && selected !== forwardRoute(fixture).recipient) { throw new Error('Reverse fixture supports only recipient A'); }
  return selected;
}
/** @param {unknown} transfers @param {ReplacementFixture=} fixture */
export function validateStatusTransfers(transfers, fixture) {
  if (!Array.isArray(transfers) || transfers.length > 3) { throw new Error('At most three fixed fixture transfers required'); }
  /** @type {Set<string>} */
  const slots = new Set();
  /** @type {Set<string>} */
  const sources = new Set();
  /** @type {readonly unknown[]} */
  const entries = transfers;
  for (const transfer of entries) {
    if (!transfer || typeof transfer !== 'object' || !('direction' in transfer) || !('sourceHash' in transfer)) { throw new Error('Malformed fixture transfer'); }
    const recipient = statusRecipient(transfer.direction, 'recipient' in transfer ? transfer.recipient : undefined, fixture);
    const chain = transfer.direction === 'ethereum-to-solana' ? 'ethereum' : 'solana';
    const hash = transfer.sourceHash;
    if (typeof hash !== 'string' || !hash || fixture !== undefined && !canonicalTransaction(chain, hash)) { throw new Error('Invalid fixture source hash'); }
    const source = chain === 'ethereum' ? canonicalEvmHash(hash) ?? hash : hash;
    const slot = `${transfer.direction}:${recipient}`;
    if (slots.has(slot) || sources.has(source)) { throw new Error('Duplicate fixture transfer'); }
    slots.add(slot); sources.add(source);
  }
}
/** @param {boolean} forward @param {StatusMessage} message @param {string} recipient @param {import('./replacement-fixture.ts').ForwardRoute} route */
function validForwardReceiver(forward, message, recipient, route) { return message.data === '0x' && (!forward || (message.tokenReceiver === recipient && equal(message.tokenAmounts?.[0]?.sourcePoolAddress, route.pool))); }
/** @param {boolean} forward @param {StatusMessage} message @param {ReplacementFixture=} fixture */
function validSourcePool(forward, message, fixture) {
  return fixture === undefined || forward || equal(message.tokenAmounts?.[0]?.sourcePoolAddress, fixture.solanaPool);
}
/** @param {StatusRequest} request @param {bigint} source @param {bigint} destination */
function matchingSelectors(request, source, destination) {
  return request.lane.sourceChainSelector === source && request.lane.destChainSelector === destination &&
    request.message.sourceChainSelector === source && request.message.destChainSelector === destination;
}
/** @param {StatusRequest} request @param {Direction} direction @param {string} hash @param {unknown=} recipient @param {ReplacementFixture=} fixture */
export function matchRequest(request, direction, hash, recipient, fixture) {
  const route = forwardRoute(fixture), reverse = reverseRoute(fixture);
  const selectedRecipient = statusRecipient(direction, recipient, fixture);
  const forward = direction === 'ethereum-to-solana', message = request.message;
  const source = forward ? 16015286601757825753n : route.selector;
  const destination = forward ? route.selector : 16015286601757825753n;
  const token = message.tokenAmounts?.[0];
  return [request.tx.hash, request.log.transactionHash].every(value => fixture && forward ? equal(value, hash.toLowerCase()) : value === hash) && matchingSelectors(request, source, destination) &&
    equal(message.sender, forward ? route.administrator : reverse.payer) &&
    equal(message.receiver, forward ? '11111111111111111111111111111111' : reverse.recipient) &&
    validForwardReceiver(forward, message, selectedRecipient, route) && message.tokenAmounts?.length === 1 &&
    validSourcePool(forward, message, fixture) &&
    token?.amount === route.amount && equal(token.destTokenAddress, forward ? reverse.mint : route.token) &&
    /^0x[0-9a-fA-F]{64}$/.test(message.messageId);
}
/** @param {StatusNativeProof} proof @param {StatusLog} log @param {string} program */
function bindProgramLog(proof, log, program) {
  /** @type {string[]} */
  const stack = [];
  /** @type {string[]} */
  const matches = [];
  for (const [index, line] of (proof.programLogs ?? []).entries()) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    const finish = /^Program (\S+) (?:success|failed:.*)$/.exec(line);
    if (invoke?.[1]) { stack.push(invoke[1]); }
    else if (finish) { if (stack.pop() !== finish[1]) { throw new Error('Invalid invocation stack'); } }
    else if (line.startsWith('Program data: ') && stack.at(-1) === program) {
      const data = line.slice(14), topic = '0x' + Buffer.from(data, 'base64').subarray(0, 8).toString('hex');
      if (log.data === data && log.index === index && log.type !== 'cpi' && log.topics?.[0] === topic) { matches.push(line); }
    }
  }
  if (stack.length !== 0 || matches.length !== 1 || log.address !== program) { throw new Error('SDK log absent from native authenticated program'); }
}
/** @param {StatusNativeProof} proof @param {StatusLog} log @param {TransferEvent['chain']} chain @param {string} offRamp */
function bindExecution(proof, log, chain, offRamp) {
  if (chain === 'solana') { bindProgramLog(proof, log, offRamp); return; }
  const matches = (proof.logs ?? []).filter(item => Number(BigInt(item.logIndex)) === log.index && item.address.toLowerCase() === offRamp.toLowerCase() &&
    item.data === log.data && JSON.stringify(item.topics) === JSON.stringify(log.topics));
  if (matches.length !== 1 || log.address.toLowerCase() !== offRamp.toLowerCase()) { throw new Error('SDK execution log absent from native receipt'); }
}
/** @param {boolean} forward @param {StatusNativeProof} proof @param {StatusRequest} request @param {StatusNativePort['lane']} lane @param {ReplacementFixture=} fixture */
function verifyNativeSource(forward, proof, request, lane, fixture) {
  if (forward) {
    const nativeLog = (proof.logs ?? []).filter(log => Number(BigInt(log.logIndex)) === request.log.index &&
      log.address.toLowerCase() === request.log.address.toLowerCase() && log.data === request.log.data &&
      JSON.stringify(log.topics) === JSON.stringify(request.log.topics));
    if (nativeLog.length !== 1 || request.log.address.toLowerCase() !== request.lane.onRamp.toLowerCase()) {throw new Error('SDK source log not present in native receipt');}
  } else {
    const reverse = reverseRoute(fixture);
    if (request.message.tokenAmounts[0]?.sourcePoolAddress !== lane?.solanaPool) { throw new Error('Wrong Solana source pool'); }
    bindProgramLog(proof, request.log, ROUTER_PROGRAM);
    const message = proof.transaction.message;
    if (!message || !message.accountKeys.some(key => key.pubkey === reverse.payer && key.signer === true) ||
      !message.instructions.some(ix => ix.programId === ROUTER_PROGRAM) || request.tx.from !== reverse.payer) {throw new Error('Wrong native Solana sender/router');}
  }
}
/** @param {StatusExecution} execution @param {TransferIdentity} identity @param {StatusRequest} request @param {string} hash @param {number} successState */
function verifyExecution(execution, identity, request, hash, successState) {
      if (execution.receipt.messageId !== identity.messageId || execution.receipt.state !== successState ||
          execution.receipt.sequenceNumber !== request.message.sequenceNumber || execution.log.transactionHash !== hash ||
          (execution.receipt.sourceChainSelector !== undefined && execution.receipt.sourceChainSelector !== request.lane.sourceChainSelector)) {throw new Error('Execution identity/state mismatch');}
}
/** @param {boolean} forward @returns {{ sourceName: TransferEvent['chain'], destinationName: TransferEvent['chain'], sourceKind: TransferEvent['kind'], destinationKind: TransferEvent['kind'] }} */
function roles(forward) {
  const sourceName = forward ? 'ethereum' : 'solana', destinationName = forward ? 'solana' : 'ethereum';
  const sourceKind = forward ? 'lock' : 'burn', destinationKind = forward ? 'mint' : 'release';
  return { sourceName, destinationName, sourceKind, destinationKind };
}
// Base58 has a unique representation when leading zero bytes are counted.
/** @param {unknown} value @param {number} bytes */
function base58Bytes(value, bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (typeof value !== 'string' || value.length < bytes || value.length > Math.ceil(bytes * 8 / Math.log2(58))) { return false; }
  let number = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) { return false; }
    number = number * 58n + BigInt(digit);
  }
  let length = 0;
  for (; length < value.length && value[length] === '1'; length++) {}
  while (number > 0n) { length++; number >>= 8n; }
  return length === bytes;
}
/** @param {unknown} hint @param {boolean} forward @returns {hint is StatusReceiptHint} */
function validReceiptHint(hint, forward) {
  return hint !== null && typeof hint === 'object' && !Array.isArray(hint) &&
    Object.keys(hint).length === 2 && 'transactionHash' in hint && 'offRamp' in hint && Object.hasOwn(hint, 'transactionHash') && Object.hasOwn(hint, 'offRamp') &&
    (forward ? base58Bytes(hint.transactionHash, 64) && base58Bytes(hint.offRamp, 32) :
      typeof hint.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hint.transactionHash) &&
      typeof hint.offRamp === 'string' && /^0x[0-9a-fA-F]{40}$/.test(hint.offRamp));
}
/** @param {StatusMetadata | undefined} metadata @param {StatusReceiptHint | undefined} destinationReceipt @param {boolean} forward */
function selectReceipt(metadata, destinationReceipt, forward) {
  const apiReceipt = metadata?.receiptTransactionHash && metadata.offRamp ?
    { transactionHash: metadata.receiptTransactionHash, offRamp: metadata.offRamp } : undefined;
  /** @param {string} a @param {string} b */
  const same = (a, b) => forward ? a === b : typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (apiReceipt && destinationReceipt && (!same(apiReceipt.transactionHash, destinationReceipt.transactionHash) ||
      !same(apiReceipt.offRamp, destinationReceipt.offRamp))) {
    return { destinationError: 'Destination receipt discovery conflict; destination unproven' };
  }
  const receipt = apiReceipt ?? destinationReceipt;
  return { receipt, discoveryOrigin: receipt ? (apiReceipt ? 'ccip-api' : 'operator-receipt-hint') : undefined };
}
/** @param {StatusApiPort} api @param {string} messageId @param {unknown} destinationReceipt @param {boolean} forward @returns {Promise<StatusDiscovery>} */
async function discoverReceipt(api, messageId, destinationReceipt, forward) {
  if (destinationReceipt !== undefined && !validReceiptHint(destinationReceipt, forward)) {
    return { destinationError: 'Destination receipt hint malformed; destination unproven' };
  }
  /** @type {StatusMetadata | undefined} */
  let metadata;
  let discoveryError;
  try { metadata = (await api.getMessageById(messageId, { signal: AbortSignal.timeout(20_000) })).metadata; }
  catch { discoveryError = 'CCIP discovery unavailable; no retry authorized'; }
  return { metadata, discoveryError, ...selectReceipt(metadata, destinationReceipt, forward) };
}
/** @param {ReplacementFixture | undefined} fixture @param {StatusRequest} request @param {string} selectedRecipient */
function transferAssociation(fixture, request, selectedRecipient) {
  const sourcePool = request.message.tokenAmounts[0]?.sourcePoolAddress;
  if (fixture && !sourcePool) { throw new Error('Replacement source pool observation missing'); }
  return fixture && sourcePool ? { fixtureIdentity: fixture.identity, selectedRecipient,
    route: { sourceSelector: request.lane.sourceChainSelector, destinationSelector: request.lane.destChainSelector,
      sourcePool, sender: request.message.sender, receiver: request.message.receiver,
      ...(request.message.tokenReceiver === undefined ? {} : { tokenReceiver: request.message.tokenReceiver }) } } : {};
}
/** @param {StatusTransferInput} transfer @param {{ ethereum: StatusChainPort, solana: StatusChainPort }} chains
 * @param {StatusNativePort} native @param {StatusApiPort} api @param {number} successState @returns {Promise<StatusTransferReport>} */
export async function inspectTransfer({ sourceHash, direction, recipient, destinationReceipt }, chains, native, api, successState) {
  const fixture = native.lane?.fixture, route = forwardRoute(fixture), reverse = reverseRoute(fixture);
  const selectedRecipient = statusRecipient(direction, recipient, fixture);
  const forward = direction === 'ethereum-to-solana';
  const { sourceName, destinationName, sourceKind, destinationKind } = roles(forward);
  const proof = await native[sourceName](sourceHash, sourceKind);
  if (forward && (proof.transaction.to !== route.router || proof.transaction.from !== route.administrator)) {throw new Error('Wrong native source sender/router');}
  const requests = await chains[sourceName].getMessagesInTx(sourceHash);
  const matching = requests.filter(request => matchRequest(request, direction, sourceHash, selectedRecipient, fixture));
  if (matching.length !== 1 || requests.length !== 1) {throw new Error('Source message identity is not unique/exact');}
  const request = matching[0];
  if (!request) { throw new Error('Source message identity missing'); }
  verifyNativeSource(forward, proof, request, native.lane, fixture);
  const identity = { messageId: request.message.messageId, direction, amount: route.amount,
    sourceToken: forward ? route.token : reverse.mint, destinationToken: forward ? reverse.mint : route.token,
    recipient: forward ? selectedRecipient : reverse.recipient };
  /** @param {TransferEvent['chain']} chain @param {TransferEvent['kind']} kind @param {string} hash @param {StatusNativeProof} evidence @returns {TransferEvent} */
  const event = (chain, kind, hash, evidence) => ({ ...identity, chain, kind, transactionId: hash,
    eventIndex: evidence.eventIndex, blockHash: evidence.blockHash, blockHeight: evidence.blockHeight, finality: 'finalized' });
  const events = [event(sourceName, sourceKind, sourceHash, proof)];
  const discovery = await discoverReceipt(api, identity.messageId, destinationReceipt, forward);
  const { metadata, discoveryError, receipt, discoveryOrigin } = discovery;
  let { destinationError } = discovery;
  if (receipt) {
    try {
      const hash = receipt.transactionHash;
      await native.authorizeOffRamp(destinationName, receipt.offRamp, request.lane.sourceChainSelector);
      const execution = await chains[destinationName].getExecutionReceiptInTx(hash, { offRamp: receipt.offRamp,
        messageId: identity.messageId, sourceChainSelector: request.lane.sourceChainSelector });
      verifyExecution(execution, identity, request, hash, successState);
      const destination = await native[destinationName](hash, destinationKind, selectedRecipient);
      bindExecution(destination, execution.log, destinationName, receipt.offRamp);
      events.push(event(destinationName, destinationKind, hash, destination));
    } catch { destinationError = 'Destination finality, execution identity or token effect unproven'; }
  }
  const progress = projectMessage(identity, events, metadata?.readyForManualExecution === true || metadata?.status === 'FAILED');
  // A finalized source proves progress, but absent destination evidence cannot prove nonsettlement.
  // Keep the delivery status while excluding this amount from proven pending accounting.
  const accounting = progress.pendingAmount === 0n ? progress : {
    ...progress, pendingAmount: null, reasons: [...progress.reasons, 'destination-settlement-unresolved'],
  };
  return { sourceHash, ...accounting, ...transferAssociation(fixture, request, selectedRecipient),
    events, ...(discoveryOrigin ? { discoveryOrigin } : {}), discoveryStatus: metadata?.status ?? 'UNKNOWN', discoveryError, destinationError };
}
// A finalized source does not prove that its destination is still unsettled.
// Only an observed settlement can contribute a known zero pending amount.
/** @param {StatusTransferReport} t */
const settled = t => {
  if (t?.pendingAmount !== 0n || t.status !== 'settled' || !Array.isArray(t.events) || !t.identity) { return false; }
  try { return projectMessage(t.identity, t.events).status === 'settled'; }
  catch { return false; }
};
/** @param {unknown} value */
function canonicalEvmHash(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : undefined;
}
/** @param {TransferEvent['chain']} chain @param {unknown} value */
function canonicalTransaction(chain, value) {
  return chain === 'ethereum' ? canonicalEvmHash(value) : typeof value === 'string' && base58Bytes(value, 64) ? value : undefined;
}
/** @param {TransferEvent['chain']} chain @param {unknown} value */
function canonicalBlock(chain, value) {
  return chain === 'ethereum' ? canonicalEvmHash(value) : typeof value === 'string' && base58Bytes(value, 32) ? value : undefined;
}
/** @param {unknown} value */
function observationTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) { return; }
  const timestamp = Date.parse(value);
  if (Number.isSafeInteger(timestamp) && timestamp >= 0 && new Date(timestamp).toISOString() === value) { return timestamp / 1000; }
}
/** @param {StatusSnapshot} snapshot @param {ReplacementFixture} fixture */
function replacementSnapshotValues(snapshot, fixture) {
  if (snapshot.fixtureIdentity !== fixture.identity || snapshot.decimals !== fixture.decimals ||
      snapshot.fixedSupply !== BigInt(fixture.supply) || snapshot.lockedOnEthereum !== BigInt(fixture.amount) ||
      snapshot.supplyOnSolana !== BigInt(fixture.amount) || !canonicalEvmHash(snapshot.ethereumBlock) ||
      typeof snapshot.ethereumHeight !== 'bigint' || snapshot.ethereumHeight < 0n ||
      !Number.isSafeInteger(snapshot.solanaSlot) || snapshot.solanaSlot < 0) { return false; }
  return true;
}
/** @param {StatusFreshness | undefined} observation @param {number} limit @param {number} observedAt @param {number} checkedAt */
function validFreshnessObservation(observation, limit, observedAt, checkedAt) {
  const timestamp = observation?.timestamp;
  return !!observation && observation.fresh === true && observation.maxAgeSeconds === limit &&
    typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp >= 0 &&
    timestamp <= observedAt && checkedAt - timestamp <= limit;
}
/** @param {StatusSnapshot} snapshot @param {number} observedAt @param {number} checkedAt */
function replacementFreshness(snapshot, observedAt, checkedAt) {
  for (const chain of ['ethereum', 'solana', 'solanaRepeated']) {
    const limit = chain === 'ethereum' ? 1800 : 300;
    const observation = chain === 'ethereum' ? snapshot.freshness?.ethereum : chain === 'solana' ? snapshot.freshness?.solana : snapshot.freshness?.solanaRepeated;
    if (!validFreshnessObservation(observation, limit, observedAt, checkedAt)) { return false; }
  }
  const first = snapshot.freshness?.solana.slot, repeated = snapshot.freshness?.solanaRepeated.slot;
  return first === snapshot.solanaSlot && typeof repeated === 'number' && Number.isSafeInteger(repeated) && repeated >= first;
}
/** No clock is read here. Collection/finalization supply the observed times.
 * @param {StatusSnapshot} snapshot @param {ReplacementFixture} fixture */
function replacementSnapshot(snapshot, fixture) {
  if (!replacementSnapshotValues(snapshot, fixture)) { return false; }
  if (Object.hasOwn(snapshot, 'pendingEthereumToSolana') && snapshot.pendingEthereumToSolana !== 0n ||
      Object.hasOwn(snapshot, 'pendingSolanaToEthereum') && snapshot.pendingSolanaToEthereum !== 0n) { return false; }
  const observedAt = observationTime(snapshot.observedAt);
  const checkedAt = snapshot.freshnessCheckedAt === undefined ? observedAt : observationTime(snapshot.freshnessCheckedAt);
  if (observedAt === undefined || checkedAt === undefined || checkedAt < observedAt) { return false; }
  return replacementFreshness(snapshot, observedAt, checkedAt);
}
/** @param {StatusRouteAssociation | undefined} route @param {boolean} forward @param {string} recipient @param {ReplacementFixture} fixture */
function replacementRoute(route, forward, recipient, fixture) {
  return !!route && route.sourceSelector === BigInt(forward ? fixture.reverseSelector : fixture.forwardSelector) &&
    route.destinationSelector === BigInt(forward ? fixture.forwardSelector : fixture.reverseSelector) &&
    equal(route.sourcePool, forward ? fixture.pool : fixture.solanaPool) &&
    equal(route.sender, forward ? fixture.administrator : fixture.payer) &&
    equal(route.receiver, forward ? '11111111111111111111111111111111' : fixture.administrator) &&
    (!forward || route.tokenReceiver === recipient);
}
/** @param {StatusTransferReport} transfer @param {ReplacementFixture} fixture */
function replacementAssociation(transfer, fixture) {
  const identity = transfer.identity, forward = identity.direction === 'ethereum-to-solana';
  const recipient = transfer.selectedRecipient, route = transfer.route;
  return transfer.fixtureIdentity === fixture.identity && typeof recipient === 'string' &&
    statusRecipient(identity.direction, recipient, fixture) === recipient &&
    identity.amount === BigInt(fixture.amount) && equal(identity.sourceToken, forward ? fixture.token : fixture.mint) &&
    equal(identity.destinationToken, forward ? fixture.mint : fixture.token) &&
    equal(identity.recipient, forward ? recipient : fixture.administrator) && replacementRoute(route, forward, recipient, fixture);
}
/** @param {TransferEvent} event @param {StatusSnapshot} snapshot */
function physicalEventLocation(event, snapshot) {
  const transaction = canonicalTransaction(event.chain, event.transactionId), block = canonicalBlock(event.chain, event.blockHash);
  const height = event.blockHeight;
  if (!transaction || !block || typeof height !== 'bigint' || height < 0n ||
      !Number.isSafeInteger(event.eventIndex) || event.eventIndex < 0 || event.finality !== 'finalized' ||
      height > (event.chain === 'ethereum' ? snapshot.ethereumHeight : BigInt(snapshot.solanaSlot))) { return; }
  return { transaction, block, height };
}
/** @param {TransferEvent} event @param {NonNullable<ReturnType<typeof physicalEventLocation>>} observation @param {StatusSnapshot} snapshot
 * @param {{ transactions: Map<string, string>, blocks: Map<string, string>, heights: Map<string, bigint> }} locations */
function recordEventLocation(event, { transaction, block, height }, snapshot, { transactions, blocks, heights }) {
  // A transaction cannot move blocks, and one height cannot name conflicting canonical blocks.
  const transactionKey = `${event.chain}:${transaction}`, blockKey = `${event.chain}:${height}`, location = `${height}:${block}`;
  const hashKey = `${event.chain}:${block}`;
  if (transactions.has(transactionKey) && transactions.get(transactionKey) !== location ||
      blocks.has(blockKey) && blocks.get(blockKey) !== block || heights.has(hashKey) && heights.get(hashKey) !== height || event.chain === 'ethereum' &&
      height === snapshot.ethereumHeight && block !== canonicalEvmHash(snapshot.ethereumBlock)) { return false; }
  transactions.set(transactionKey, location); blocks.set(blockKey, block); heights.set(hashKey, height);
  return true;
}
/** A finite inventory seal over supplied native facts; this function cannot authenticate an observer.
 * In particular it never fills absent physical metadata from fixture values or message labels.
 * @param {readonly StatusTransferReport[]} transfers @param {StatusSnapshot} snapshot @param {ReplacementFixture} fixture */
function replacementInventory(transfers, snapshot, fixture) {
  if (transfers.length !== 3 || !replacementSnapshot(snapshot, fixture)) { return false; }
  const expected = new Set([`ethereum-to-solana:${fixture.recipient}`, `solana-to-ethereum:${fixture.recipient}`, `ethereum-to-solana:${FORWARD_RECIPIENT_B}`]);
  /** @type {Set<string>} */
  const sources = new Set();
  /** @type {Set<string>} */
  const messages = new Set();
  /** @type {Set<string>} */
  const physical = new Set();
  /** @type {Map<string, string>} */
  const blocks = new Map();
  /** @type {Map<string, string>} */
  const transactions = new Map();
  /** @type {Map<string, bigint>} */
  const heights = new Map();
  for (const transfer of transfers) {
    if (transfer.destinationError !== undefined || !replacementAssociation(transfer, fixture) || transfer.events.length !== 2) { return false; }
    const { sourceName, sourceKind } = roles(transfer.identity.direction === 'ethereum-to-solana');
    const source = canonicalTransaction(sourceName, transfer.sourceHash), message = canonicalEvmHash(transfer.identity.messageId);
    const slot = `${transfer.identity.direction}:${transfer.selectedRecipient}`;
    if (!source || !message || sources.has(source) || messages.has(message) || !expected.delete(slot)) { return false; }
    sources.add(source); messages.add(message);
    const sourceEffect = transfer.events.find(event => event.chain === sourceName && event.kind === sourceKind);
    if (!sourceEffect || canonicalTransaction(sourceName, sourceEffect.transactionId) !== source) { return false; }
    for (const event of transfer.events) {
      const location = physicalEventLocation(event, snapshot);
      if (!location) { return false; }
      const key = `${event.chain}:${location.transaction}:${event.eventIndex}`;
      if (physical.has(key)) { return false; }
      physical.add(key);
      if (!recordEventLocation(event, location, snapshot, { transactions, blocks, heights })) { return false; }
    }
  }
  return expected.size === 0 && physical.size === 6;
}
/** @param {readonly StatusTransferReport[]} transfers @param {StatusSnapshot} snapshot @param {boolean} [completeInventory=false] @param {ReplacementFixture=} fixture */
export function accountTransfers(transfers, snapshot, completeInventory = false, fixture) {
  if (fixture !== undefined) {
    try {
      if (completeInventory !== true || snapshot.coherent !== true || transfers.some(t => !settled(t)) ||
          !replacementInventory(transfers, snapshot, validateReplacementFixture(fixture))) {
        return { status: 'unknown', reason: 'Replacement inventory, physical effects, route or observed F100/L1/S1 snapshot unproven' };
      }
    } catch { return { status: 'unknown', reason: 'Malformed replacement observations; exact acceptance unproven' }; }
  }
  if (!completeInventory || !snapshot.coherent || transfers.some(t => !settled(t)) ||
      new Set(transfers.map(t => t.identity.messageId)).size !== transfers.length ||
      transfers.some(t => t.events.some(e => (e.chain === 'solana' && e.blockHeight > BigInt(snapshot.solanaSlot)) || (e.chain === 'ethereum' && e.blockHeight > snapshot.ethereumHeight)))) {
    return { status: 'unknown', reason: 'Incomplete inventory, duplicate, unproven transfer or incoherent/stale snapshot' };
  }
  /** @param {Direction} direction @returns {bigint | null} */
  const pending = direction => {
    let sum = 0n;
    for (const transfer of transfers) {
      if (transfer.identity.direction !== direction) { continue; }
      if (transfer.pendingAmount === null) { return null; }
      sum += transfer.pendingAmount;
    }
    return sum;
  };
  const pendingEthereumToSolana = pending('ethereum-to-solana'), pendingSolanaToEthereum = pending('solana-to-ethereum');
  if (pendingEthereumToSolana === null || pendingSolanaToEthereum === null) { return { status: 'unknown', reason: 'Pending settlement unresolved' }; }
  return { ...reconcileSupply({ ...snapshot, pendingEthereumToSolana, pendingSolanaToEthereum }),
    scope: 'operator-declared-complete-fixed-test-fixture', snapshot };
}
