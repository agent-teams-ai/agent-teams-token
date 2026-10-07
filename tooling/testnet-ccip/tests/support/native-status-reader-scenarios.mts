import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createTestSdkStatus } from '../../src/adapters/test-sdk-status.ts';
import { testSdkCounters } from '../../src/adapters/test-sdk-admission.ts';
import { TEST_SDK_PROFILE, type ExplicitTestSdkSelection } from '../../src/adapters/test-sdk-policy.ts';
import { DEFAULT_SEPOLIA_RPC, DEFAULT_SOLANA_RPC, TEST_RPC_RESPONSE_LIMIT } from '../../src/adapters/test-rpc.ts';
import { finalizeStatusReport } from '../../src/composition/transfer-status.mjs';
import { createFetcher, createScenarioState, fixture, root, archives, logger, time, ticks } from './native-status-controls.mts';

/** Actual admitted SDK callers, controlled public responses; no delivery qualification. */
export async function readerScenario(name: string): Promise<void> {
  assert.ok(['reader-acquisition-failure', 'reader-read-failure', 'reader-cancel-success'].includes(name));
  const s = createScenarioState('decoders'), replay = createFetcher(s);
  const producer = Promise.withResolvers<void>(), cancelEntered = Promise.withResolvers<void>();
  const secretMarker = 'synthetic-only-read-secret';
  let faulty = false, producerReleased = true, cancelCalls = 0, abortObserved = false, calls = 0;
  let heldReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const diagnostics: unknown[] = [];
  const capture = (...args: unknown[]): void => { diagnostics.push(args); };
  const safeLogger = { ...logger, debug: capture, info: capture, warn: capture, error: capture };
  globalThis.fetch = () => { s.globalFetchAttempts++; throw new Error('Uninjected global fetch forbidden'); };
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    if (!faulty || !String(input).startsWith('https://api.ccip.chain.link/')) { return replay(input, init); }
    assert.equal(init?.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    producerReleased = false;
    init.signal.addEventListener('abort', () => { abortObserved = true; }, { once: true });
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        if (name === 'reader-read-failure') { value.error(new Error('password=' + secretMarker)); }
        if (name === 'reader-cancel-success') { value.enqueue(new Uint8Array(TEST_RPC_RESPONSE_LIMIT + 1)); }
      },
      async cancel() {
        cancelCalls++; cancelEntered.resolve();
        await producer.promise; producerReleased = true;
      },
    });
    const response = new Response(body);
    if (name === 'reader-acquisition-failure') { heldReader = body.getReader(); }
    return response;
  };
  const selection: ExplicitTestSdkSelection = { providerProfile: TEST_SDK_PROFILE, testOnly: true, fixture,
    fixtureIdentity: fixture.identity, providerArchives: archives };
  const exitListeners = process.listenerCount('exit');
  const ports = await createTestSdkStatus({ directory: root, selection, fetcher, logger: safeLogger,
    now: () => time, sepolia: DEFAULT_SEPOLIA_RPC, solana: DEFAULT_SOLANA_RPC });
  const evm = s.evms[0], svm = s.svms[0]; assert.ok(evm && svm);
  const evmDestroy = evm.destroy, svmDestroy = svm.destroy;
  evm.destroy = () => { s.evmDestroyed++; evmDestroy(); };
  svm.destroy = () => { s.svmDestroyed++; svmDestroy(); };
  const apiCall = () => ports.api.getMessageById(s.messageId, { signal: new AbortController().signal });
  // EOF must release each body without poisoning this same actual SDK owner.
  assert.equal((await apiCall()).metadata?.status, 'SUCCESS');
  assert.equal((await apiCall()).metadata?.status, 'SUCCESS');
  const snapshot = await ports.native.snapshot(); assert.equal(snapshot.coherent, true);
  assert.equal(testSdkCounters()?.closed, false);
  faulty = true;
  const outcome = apiCall().then((): unknown => null, (error: unknown) => error);
  if (name === 'reader-cancel-success') {
    await cancelEntered.promise;
    const previous = calls;
    assert.throws(() => ports.native.snapshot(), /byte bound/); assert.equal(calls, previous);
    const close = ports.destroy(); assert.equal(close, ports.destroy());
    let settled = false; void close.then(() => settled = true, () => settled = true);
    await ticks(); assert.equal(settled, false); assert.equal(producerReleased, false);
    assert.equal(testSdkCounters()?.closed, false);
    producer.resolve();
    const error = await outcome; assert.ok(error instanceof Error);
    assert.equal(error.message.includes('byte bound'), true);
    await close;
    assert.equal(producerReleased, true); assert.equal(cancelCalls, 1);
    assert.equal(testSdkCounters()?.closed, true);
    assert.equal(process.listenerCount('exit'), exitListeners);
  } else {
    const error = await outcome;
    faulty = false;
    const previous = calls;
    let subsequentSnapshotAllowed = false, snapshotError: unknown;
    try { subsequentSnapshotAllowed = (await ports.native.snapshot()).coherent; } catch (cause) { snapshotError = cause; }
    const callsAfterFailure = calls - previous;
    const close = ports.destroy(); assert.equal(close, ports.destroy());
    const cleanupError: unknown = await close.then(() => null, (cause: unknown) => cause);
    let publicationClockReads = 0;
    // Even previously collected coherent data must not be published with unknown cleanup debt.
    const publicationError: unknown = await finalizeStatusReport(async () => ({ transfers: [], snapshot }), ports.destroy, true,
      () => { publicationClockReads++; return time; }, fixture).then(() => null, (cause: unknown) => cause);
    const safeOperation = error instanceof Error && error.message === (name === 'reader-read-failure' ?
      'TEST status response read failed' : 'TEST status response reader acquisition failed');
    const secretExposed = inspect([error, snapshotError, cleanupError, publicationError, diagnostics], { depth: null }).includes(secretMarker);
    process.stdout.write(JSON.stringify({ probe: 'STATUS-PHYSICAL-READ-DEBT', scenario: name, qualification: 'UNQUALIFIED',
      operationRejected: error instanceof Error, safeOperation, subsequentSnapshotAllowed, callsAfterFailure,
      cleanupRejected: cleanupError instanceof Error, publicationRejected: publicationError instanceof Error,
      hooksClosed: testSdkCounters()?.closed, producerReleased, cancelCalls, abortObserved, secretExposed }) + '\n');
    assert.equal(producerReleased, false);
    assert.equal(subsequentSnapshotAllowed, false, 'Failed reader must latch refusal before another actual native snapshot');
    assert.equal(callsAfterFailure, 0);
    assert.ok(cleanupError instanceof AggregateError, 'Unknown physical debt must reject cleanup');
    assert.equal(cleanupError.message.includes('physical cancellation'), true);
    assert.equal(publicationError, cleanupError); assert.equal(publicationClockReads, 0);
    assert.equal(testSdkCounters()?.closed, false); assert.equal(process.listenerCount('exit'), exitListeners + 1);
    assert.equal(cancelCalls, 0, 'An errored/locked stream does not acknowledge lower producer cancellation');
    assert.equal(safeOperation, true); assert.equal(snapshotError, error); assert.equal(secretExposed, false);
    // Only the external fixture tears down its held producer. This cannot fabricate an owner witness.
    if (name === 'reader-acquisition-failure') { assert.ok(controller && heldReader); controller.close(); heldReader.releaseLock(); }
    producer.resolve(); await producer.promise; producerReleased = true;
    await ticks(); assert.equal(testSdkCounters()?.closed, false);
    await assert.rejects(ports.destroy(), cause => cause === cleanupError);
  }
  assert.equal(s.evmDestroyed, 1); assert.equal(s.svmDestroyed, 1);
  assert.equal(abortObserved, true); assert.equal(s.globalFetchAttempts, 0);
  process.stdout.write(JSON.stringify({ scenario: name, qualification: 'UNQUALIFIED', evidence: 'controlled-actual-SDK-unit',
    networkEffects: 0, signingEffects: 0, successfulEofCalls: 2, acknowledgedCancellation: name === 'reader-cancel-success' }) + '\n');
}
