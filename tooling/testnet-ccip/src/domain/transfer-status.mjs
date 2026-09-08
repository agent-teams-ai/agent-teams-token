import { projectMessage } from '../../../../packages/domain/src/features/ccip-status/message.ts';
import { reconcileSupply } from '../../../../packages/domain/src/supply.ts';
import { FORWARD, forwardRecipient } from './evm-forward.mjs';
import { REVERSE } from './solana-reverse.mjs';
import { ROUTER_PROGRAM } from './solana-registration.ts';
const equal = (a, b) => typeof a === 'string' && (b.startsWith('0x') ? a.toLowerCase() === b : a === b);
export function statusRecipient(direction, recipient) {
  const selected = forwardRecipient(recipient);
  if (direction === 'solana-to-ethereum' && selected !== FORWARD.recipient) { throw new Error('Reverse fixture supports only recipient A'); }
  if (!['ethereum-to-solana', 'solana-to-ethereum'].includes(direction)) { throw new Error('Invalid transfer direction'); }
  return selected;
}
export function validateStatusTransfers(transfers) {
  if (!Array.isArray(transfers) || transfers.length > 3) { throw new Error('At most three fixed fixture transfers required'); }
  const slots = transfers.map(transfer => `${transfer.direction}:${statusRecipient(transfer.direction, transfer.recipient)}`);
  if (new Set(slots).size !== slots.length || new Set(transfers.map(transfer => transfer.sourceHash)).size !== transfers.length) { throw new Error('Duplicate fixture transfer'); }
}
function validForwardReceiver(forward, message, recipient) { return message.data === '0x' && (!forward || (message.tokenReceiver === recipient && equal(message.tokenAmounts?.[0]?.sourcePoolAddress, FORWARD.pool))); }
export function matchRequest(request, direction, hash, recipient = FORWARD.recipient) {
  const forward = direction === 'ethereum-to-solana', message = request.message;
  const source = forward ? 16015286601757825753n : FORWARD.selector;
  const destination = forward ? FORWARD.selector : 16015286601757825753n;
  return [request.tx.hash, request.log.transactionHash].every(value => value === hash) && request.lane.sourceChainSelector === source &&
    request.lane.destChainSelector === destination && message.sourceChainSelector === source && message.destChainSelector === destination &&
    equal(message.sender, forward ? FORWARD.administrator : REVERSE.payer) &&
    equal(message.receiver, forward ? '11111111111111111111111111111111' : REVERSE.recipient) &&
    validForwardReceiver(forward, message, recipient) && message.tokenAmounts?.length === 1 &&
    message.tokenAmounts[0].amount === FORWARD.amount && equal(message.tokenAmounts[0].destTokenAddress, forward ? REVERSE.mint : FORWARD.token) &&
    /^0x[0-9a-fA-F]{64}$/.test(message.messageId);
}
function bindProgramLog(proof, log, program) {
  const stack = [], matches = [];
  for (const [index, line] of (proof.programLogs ?? []).entries()) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    const finish = /^Program (\S+) (?:success|failed:.*)$/.exec(line);
    if (invoke) { stack.push(invoke[1]); }
    else if (finish) { if (stack.pop() !== finish[1]) { throw new Error('Invalid invocation stack'); } }
    else if (line.startsWith('Program data: ') && stack.at(-1) === program) {
      const data = line.slice(14), topic = '0x' + Buffer.from(data, 'base64').subarray(0, 8).toString('hex');
      if (log.data === data && log.index === index && log.type !== 'cpi' && log.topics?.[0] === topic) { matches.push(line); }
    }
  }
  if (stack.length !== 0 || matches.length !== 1 || log.address !== program) { throw new Error('SDK log absent from native authenticated program'); }
}
function bindExecution(proof, log, chain, offRamp) {
  if (chain === 'solana') { bindProgramLog(proof, log, offRamp); return; }
  const matches = proof.logs.filter(item => Number(BigInt(item.logIndex)) === log.index && item.address.toLowerCase() === offRamp.toLowerCase() &&
    item.data === log.data && JSON.stringify(item.topics) === JSON.stringify(log.topics));
  if (matches.length !== 1 || log.address.toLowerCase() !== offRamp.toLowerCase()) { throw new Error('SDK execution log absent from native receipt'); }
}
function verifyNativeSource(forward, proof, request, lane) {
  if (forward) {
    const nativeLog = proof.logs.filter(log => Number(BigInt(log.logIndex)) === request.log.index &&
      log.address.toLowerCase() === request.log.address.toLowerCase() && log.data === request.log.data &&
      JSON.stringify(log.topics) === JSON.stringify(request.log.topics));
    if (nativeLog.length !== 1 || request.log.address.toLowerCase() !== request.lane.onRamp.toLowerCase()) {throw new Error('SDK source log not present in native receipt');}
  } else {
    if (request.message.tokenAmounts[0].sourcePoolAddress !== lane?.solanaPool) { throw new Error('Wrong Solana source pool'); }
    bindProgramLog(proof, request.log, ROUTER_PROGRAM);
    const message = proof.transaction.message;
    if (!message.accountKeys.some(key => key.pubkey === REVERSE.payer && key.signer === true) ||
      !message.instructions.some(ix => ix.programId === ROUTER_PROGRAM) || request.tx.from !== REVERSE.payer) {throw new Error('Wrong native Solana sender/router');}
  }
}
function verifyExecution(execution, identity, request, hash, successState) {
      if (execution.receipt.messageId !== identity.messageId || execution.receipt.state !== successState ||
          execution.receipt.sequenceNumber !== request.message.sequenceNumber || execution.log.transactionHash !== hash ||
          (execution.receipt.sourceChainSelector !== undefined && execution.receipt.sourceChainSelector !== request.lane.sourceChainSelector)) {throw new Error('Execution identity/state mismatch');}
}
function roles(forward) {
  const sourceName = forward ? 'ethereum' : 'solana', destinationName = forward ? 'solana' : 'ethereum';
  const sourceKind = forward ? 'lock' : 'burn', destinationKind = forward ? 'mint' : 'release';
  return { sourceName, destinationName, sourceKind, destinationKind };
}
export async function inspectTransfer({ sourceHash, direction, recipient }, chains, native, api, successState) {
  const selectedRecipient = statusRecipient(direction, recipient);
  const forward = direction === 'ethereum-to-solana';
  const { sourceName, destinationName, sourceKind, destinationKind } = roles(forward);
  const proof = await native[sourceName](sourceHash, sourceKind);
  if (forward && (proof.transaction.to !== FORWARD.router || proof.transaction.from !== FORWARD.administrator)) {throw new Error('Wrong native source sender/router');}
  const requests = await chains[sourceName].getMessagesInTx(sourceHash);
  const matching = requests.filter(request => matchRequest(request, direction, sourceHash, selectedRecipient));
  if (matching.length !== 1 || requests.length !== 1) {throw new Error('Source message identity is not unique/exact');}
  const request = matching[0];
  verifyNativeSource(forward, proof, request, native.lane);
  const identity = { messageId: request.message.messageId, direction, amount: FORWARD.amount,
    sourceToken: forward ? FORWARD.token : REVERSE.mint, destinationToken: forward ? REVERSE.mint : FORWARD.token,
    recipient: forward ? selectedRecipient : REVERSE.recipient };
  const event = (chain, kind, hash, evidence) => ({ ...identity, chain, kind, transactionId: hash,
    eventIndex: evidence.eventIndex, blockHash: evidence.blockHash, blockHeight: evidence.blockHeight, finality: 'finalized' });
  const events = [event(sourceName, sourceKind, sourceHash, proof)];
  let metadata, discoveryError, destinationError;
  try { metadata = (await api.getMessageById(identity.messageId, { signal: AbortSignal.timeout(20_000) })).metadata; }
  catch { discoveryError = 'CCIP discovery unavailable; no retry authorized'; }
  if (metadata?.receiptTransactionHash && metadata.offRamp) {
    try {
      const hash = metadata.receiptTransactionHash;
      await native.authorizeOffRamp(destinationName, metadata.offRamp, request.lane.sourceChainSelector);
      const execution = await chains[destinationName].getExecutionReceiptInTx(hash, { offRamp: metadata.offRamp,
        messageId: identity.messageId, sourceChainSelector: request.lane.sourceChainSelector });
      verifyExecution(execution, identity, request, hash, successState);
      const destination = await native[destinationName](hash, destinationKind, selectedRecipient);
      bindExecution(destination, execution.log, destinationName, metadata.offRamp);
      events.push(event(destinationName, destinationKind, hash, destination));
    } catch { destinationError = 'Destination finality, execution identity or token effect unproven'; }
  }
  return { sourceHash, ...projectMessage(identity, events, metadata?.readyForManualExecution === true || metadata?.status === 'FAILED'),
    events, discoveryStatus: metadata?.status ?? 'UNKNOWN', discoveryError, destinationError };
}
export function accountTransfers(transfers, snapshot, completeInventory = false) {
  if (!completeInventory || !snapshot.coherent || transfers.some(t => t.pendingAmount === null) ||
      new Set(transfers.map(t => t.identity.messageId)).size !== transfers.length ||
      transfers.some(t => t.events.some(e => (e.chain === 'solana' && e.blockHeight > BigInt(snapshot.solanaSlot)) || (e.chain === 'ethereum' && e.blockHeight > snapshot.ethereumHeight)))) {
    return { status: 'unknown', reason: 'Incomplete inventory, duplicate, unproven transfer or incoherent/stale snapshot' };
  }
  const pending = direction => transfers.filter(t => t.identity.direction === direction).reduce((sum, t) => sum + t.pendingAmount, 0n);
  return { ...reconcileSupply({ ...snapshot, pendingEthereumToSolana: pending('ethereum-to-solana'), pendingSolanaToEthereum: pending('solana-to-ethereum') }),
    scope: 'operator-declared-complete-fixed-test-fixture', snapshot };
}
