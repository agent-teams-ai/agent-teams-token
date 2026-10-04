import { decodeEvmCapture, parseEvmCapture, DEV_EVM_INPUT_BOUNDS } from './dev-evm-event-codec.mjs';
import { decodeDevSvmCpiCapture, DEV_SVM_CAPTURE_BOUNDS } from './dev-svm-cpi-capture.mjs';
import { checkCaptureJson, readReference } from './dev-roundtrip-report-input.mjs';
import { solanaPublicKeyBytes } from '../domain/solana-mint.ts';
import { ROLES } from '../domain/dev-roundtrip-report.mjs';

// Expected context comes from selected PR1 route and explicit header bindings,
// never from the event/receipt being verified. These are unverified expectations,
// not event-time authorization, deployed binary or finality authorities.
const raw32 = address => '0x' + solanaPublicKeyBytes(address).toString('hex');
export function captureContexts(route, expected, m) {
  const forward = m.identity.direction === 'ethereum-to-solana', e = route.pair.evm, s = route.pair.svm;
  const receiver = expected.receivers.find(r => r.recipient === m.identity.recipient);
  const selectors = { sourceChainSelector: forward ? route.lane.ethereumSelector : route.lane.solanaSelector,
    destChainSelector: forward ? route.lane.solanaSelector : route.lane.ethereumSelector };
  const common = { ...selectors, messageId: m.identity.messageId, sequenceNumber: m.sequenceNumber, amount: route.amount };
  return {
    evm: { ...common, kind: forward ? 'lock' : 'release', chainId: route.lane.chainId, transactionHash: m.evm?.transactionId,
      token: e.token, pool: e.pool, router: route.lane.router, onRamp: expected.onRamp, offRamp: expected.offRamp,
      sourceSender: forward ? e.sender : raw32(s.sender), receiver: forward ? '0x' + '00'.repeat(32) : e.recipient,
      ...(forward ? { nativeFeeToken: expected.nativeFeeToken, remoteToken: raw32(s.mint), tokenReceiver: raw32(m.identity.recipient) } : { remotePool: raw32(s.pool) }) },
    svm: { ...common, testOnly: true, decimals: 9, direction: forward ? 'mint' : 'burn', nonce: m.nonce,
      router: route.lane.routerProgram, offRamp: expected.svmOffRamp, poolProgram: route.lane.poolProgram,
      mint: s.mint, poolSigner: s.signer, poolATA: s.poolAta, poolState: s.pool, poolChainConfig: expected.poolChainConfig,
      evmToken: e.token, evmPool: e.pool, evmSender: e.sender, evmRecipient: e.recipient,
      sourcePath: m.svm?.capture.path, sourceSha256: m.svm?.capture.sha256, transactionId: m.svm?.transactionId, slot: m.svm?.slot,
      ...(forward ? { recipient: m.identity.recipient, recipientATA: receiver?.ata, messageHash: m.messageHash,
        allowedOffRamp: expected.allowedOffRamp, offRampPoolAuthority: expected.offRampPoolAuthority } : {
        sourceOwner: s.sender, sourceATA: s.sourceAta, spender: s.spender, routerPoolAuthority: expected.routerPoolAuthority, msgTotalNonce: m.msgTotalNonce }) },
  };
}
const allowed = (value, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.split(' ').includes(k))) { throw new Error('DEV report capture: unsafe shape/unknown fields'); }
};
function evmShape(value, receipt) {
  if (receipt) {
    allowed(value, 'type status cumulativeGasUsed logs logsBloom transactionHash transactionIndex blockHash blockNumber gasUsed effectiveGasPrice from to contractAddress root blobGasUsed blobGasPrice');
    for (const log of value.logs ?? []) { allowed(log, 'address topics data blockHash blockNumber blockTimestamp transactionHash transactionIndex logIndex removed'); }
  } else {
    allowed(value, 'type chainId nonce gas maxFeePerGas maxPriorityFeePerGas to value accessList input r s yParity v hash blockHash blockNumber transactionIndex from gasPrice blockTimestamp maxFeePerBlobGas blobVersionedHashes authorizationList');
    for (const entry of value.accessList ?? []) { allowed(entry, 'address storageKeys'); }
  }
}
function svmShape(t) {
  allowed(t, 'blockTime meta slot transaction transactionIndex version');
  allowed(t.transaction, 'message signatures'); allowed(t.transaction.message, 'accountKeys addressTableLookups header instructions recentBlockhash');
  const m = t.transaction.message, meta = t.meta;
  allowed(m.header, 'numRequiredSignatures numReadonlySignedAccounts numReadonlyUnsignedAccounts');
  allowed(meta, 'computeUnitsConsumed costUnits err fee innerInstructions loadedAddresses logMessages postBalances postTokenBalances preBalances preTokenBalances returnData rewards status');
  allowed(meta.loadedAddresses, 'writable readonly');
  for (const lookup of m.addressTableLookups ?? []) { allowed(lookup, 'accountKey readonlyIndexes writableIndexes'); }
  for (const group of meta.innerInstructions ?? []) { allowed(group, 'index instructions'); }
  for (const instruction of [...m.instructions, ...(meta.innerInstructions ?? []).flatMap(g => g.instructions)]) { allowed(instruction, 'accounts data programIdIndex stackHeight'); }
  for (const balance of [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]) {
    allowed(balance, 'accountIndex mint owner programId uiTokenAmount'); allowed(balance.uiTokenAmount, 'amount decimals uiAmount uiAmountString');
  }
  if (meta.returnData) { allowed(meta.returnData, 'programId data'); }
  if (meta.status) { allowed(meta.status, 'Ok Err'); }
}
function observation(m, chain, effect) {
  const { kind, tx, index, scheme, hash, height, paths = {} } = effect;
  if (!Number.isSafeInteger(index) || index < 0) { throw new Error('Physical index exceeds legacy safe index contract'); }
  return { identity: m.identity, routeHash: m.routeHash, chain, kind, transactionId: tx, eventIndex: index, indexScheme: scheme,
    instructionPath: paths.instructionPath ?? null, owningInstructionPath: paths.owningInstructionPath ?? null,
    blockHash: hash, blockHeight: height, finality: 'unfinalized' };
}
/** Finite captured observations only. Missing files do not acquire replacements. */
export async function readMessageCaptures(route, expected, m, primitives = null) {
  const contexts = captureContexts(route, expected, m), events = [], diagnostics = [], captures = [], native = {};
  if (m.evm) { captures.push({ chain: 'ethereum', receipt: m.evm.receipt, transaction: m.evm.transaction, integrity: 'unknown', authenticity: 'unknown' }); }
  if (m.svm) { captures.push({ chain: 'solana', source: m.svm.capture, integrity: 'unknown', authenticity: 'unknown' }); }
  const decode = async (chain, supplied, read) => {
    if (!supplied) { native[chain] = { availability: 'missing', capturedConsistency: 'unknown', prerequisite: 'Explicit full raw capture not supplied' }; return; }
    try { native[chain] = await read(); }
    catch (error) {
      const missing = ['ENOENT', 'DEV_CAPTURE_MISSING'].includes(error.code);
      diagnostics.push({ status: missing ? 'unknown' : 'inconsistent', reason: missing ? 'explicit-capture-read-missing' : error.message, chain });
      native[chain] = { availability: missing ? 'missing' : 'invalid', capturedConsistency: 'unknown' };
    }
  };
  await decode('ethereum', m.evm, async () => {
    const receiptRaw = await readReference(m.evm.receipt, DEV_EVM_INPUT_BOUNDS.captureBytes), transactionRaw = await readReference(m.evm.transaction, DEV_EVM_INPUT_BOUNDS.captureBytes);
    captures.find(c => c.chain === 'ethereum').integrity = 'selected-digest-match';
    const receipt = checkCaptureJson(receiptRaw).result, transaction = checkCaptureJson(transactionRaw).result;
    evmShape(receipt, true); evmShape(transaction, false);
    if (!primitives) { return { availability: 'prerequisite', capturedConsistency: 'unknown', prerequisite: 'Explicit admitted public provider and archive paths required for actual ethers decode' }; }
    const decoded = decodeEvmCapture({ receipt: parseEvmCapture(receiptRaw), transaction: parseEvmCapture(transactionRaw), selection: contexts.evm }, primitives);
    const effect = decoded.effect;
    events.push(observation(m, 'ethereum', { kind: effect.kind, tx: effect.transactionHash, index: Number(BigInt(effect.logIndex)), scheme: 'evm-log-index-v1', hash: effect.blockHash, height: effect.blockNumber }));
    return { availability: 'decoded', capturedConsistency: 'known', decoded, capabilities: {
      captureAuthenticity: 'unknown', eventTimeRouteAuthorization: 'unknown', programProvenance: 'unknown', chainFinality: 'unknown', currentSettlement: 'unknown' } };
  });
  await decode('solana', m.svm, async () => {
    const raw = await readReference(m.svm.capture, DEV_SVM_CAPTURE_BOUNDS.transactionBytes);
    captures.find(c => c.chain === 'solana').integrity = 'selected-digest-match';
    svmShape(checkCaptureJson(raw).result);
    const decoded = decodeDevSvmCpiCapture(raw, contexts.svm);
    for (const effect of decoded.effects) {
      events.push(observation(m, 'solana', { kind: effect.kind === 'transferChecked' ? 'internal-transfer' : effect.kind, tx: decoded.transactionId,
        index: effect.ordinal, scheme: decoded.indexScheme, hash: m.svm.blockHash, height: decoded.slot, paths: effect }));
    }
    return { availability: 'decoded', capturedConsistency: decoded.capturedConsistency, decoded, capabilities: decoded.capabilities };
  });
  // Neither decoder can authenticate chain finality or event-time authorization.
  return { ...m, events, diagnostics, native, captures, qualification: 'captured-consistency-only', roles: ROLES[m.identity.direction] };
}
