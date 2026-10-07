// @ts-check
import { bindFixture } from '../adapters/fixture-binding.ts';
import { selectedFixture } from '../domain/replacement-fixture.ts';
import { selectTestSdk, TEST_SDK_PROFILE } from '../adapters/test-sdk-policy.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEvmForwardSdk } from '../adapters/evm-forward-sdk.mjs';
import { createJournalFile } from '../adapters/evm-journal-file.ts';
import { assertForwardJournalRecord, createForwardJournalFile, forwardJournalBinding } from '../adapters/evm-forward-journal.ts';
import { createCastSigner } from '../adapters/evm-cast.ts';
import { readRemoteConfigSnapshot } from '../adapters/evm-remote-config-rpc.ts';
import { nextRemoteConfigStep } from '../domain/evm-remote-config.ts';
import { canonicalIntentJson, validateSepoliaIntent } from '../domain/evm-intent.ts';
import { forwardRoute, boundedAllowance, forwardIntent, forwardTarget, forwardRecipient } from '../domain/evm-forward.mjs';
import { executeSepoliaIntent } from './execute-sepolia.ts';
import { selectSepoliaRpc } from '../adapters/test-rpc.ts';
/** @typedef {import('../adapters/evm-forward-journal.ts').ForwardStep} ForwardStep
 * @typedef {import('../application/evm-journal.ts').EvmJournalRecord} EvmJournalRecord
 * @typedef {import('../domain/evm-intent.ts').SepoliaIntentInput} SepoliaIntentInput
 * @typedef {import('../adapters/test-sdk-forward.ts').ForwardTransaction} ForwardTransaction
 * @typedef {import('../adapters/test-sdk-policy.ts').TestSdkSelection & import('../adapters/fixture-binding.ts').FixtureSettings &
 *   import('../adapters/test-rpc.ts').TestRpcSettings & {providerDirectory: string, signer: import('../adapters/evm-cast.ts').CastSignerConfig,
 *   approvalJournal: string, sendJournal: string, approvalNonce: string, sendNonce: string}} ForwardSettings
 * @typedef {{allowance: () => Promise<bigint>, verify: (tx: ForwardTransaction, step: ForwardStep, fee: bigint) => unknown,
 *   prepare: () => Promise<{fee: bigint, send: unknown, approval: unknown}>, destroy: () => Promise<void>}} ForwardSdk
 * @typedef {{sdk: (directory: string, recipient: string, fixture: import('../domain/replacement-fixture.ts').ReplacementFixture|undefined,
 *   endpoint: string, selection?: import('../adapters/test-sdk-policy.ts').TestSdkSelection) => Promise<ForwardSdk>,
 *   snapshot: typeof readRemoteConfigSnapshot, execute: typeof executeSepoliaIntent,
 *   read: (file: string) => Promise<EvmJournalRecord|null>, exclusive: <T>(file: string, work: () => Promise<T>) => Promise<T>,
 *   io?: Pick<import('./execute-sepolia.ts').SepoliaExecutionIo, 'signer'|'journal'>}} ForwardPorts
 */
/** @type {ForwardPorts} */
const defaults = {
  sdk: createEvmForwardSdk, snapshot: readRemoteConfigSnapshot, execute: executeSepoliaIntent,
  read: async file => { const store = createJournalFile(file); return store.exclusive(() => store.read()); },
  exclusive: (file, work) => createJournalFile(file + '.forward-operation').exclusive(work),
};
/** Validate the provider projection without recreating its calldata.
 * @param {unknown} candidate @returns {ForwardTransaction} */
function transaction(candidate) {
  if (!candidate || typeof candidate !== 'object' || !('from' in candidate) || typeof candidate.from !== 'string' ||
    !('to' in candidate) || typeof candidate.to !== 'string' || !('data' in candidate) || typeof candidate.data !== 'string' ||
    ('value' in candidate && candidate.value !== undefined && typeof candidate.value !== 'bigint')) { throw new Error('Invalid forward transaction projection'); }
  const value = 'value' in candidate && typeof candidate.value === 'bigint' ? candidate.value : 0n;
  return { from: candidate.from, to: candidate.to, data: candidate.data, value };
}
/** Check the complete pair before granting either execution call.
 * @param {readonly {record: EvmJournalRecord|null, step: ForwardStep, nonce: string}[]} records
 * @param {import('../adapters/evm-forward-journal.ts').ForwardJournalBinding|undefined} binding
 * @param {(record: EvmJournalRecord, step: ForwardStep, nonce: string) => SepoliaIntentInput} verifyIntent
 * @param {ForwardSdk} sdk
 * @param {() => Pick<import('../application/evm-journal.ts').EvmJournalPorts, 'inspectSigned'>} inspectorFactory
 */
async function verifyStoredPair(records, binding, verifyIntent, sdk, inspectorFactory) {
  for (const { record, step } of records) {
    if (binding && record) { assertForwardJournalRecord(record, binding, step); }
  }
  for (const { record, step, nonce } of records) {
    if (record) { verifyIntent(record, step, nonce); }
  }
  if (!binding || !records.some(({ record }) => record !== null)) { return; }
  // The existing inspector also checks EIP-1559 gas and fee settings.
  const inspector = inspectorFactory();
  for (const { record, step } of records) {
    if (!record) { continue; }
    const actual = await inspector.inspectSigned(record.signed.bytes), intent = record.intent;
    if (actual.hash.toLowerCase() !== record.signed.hash.toLowerCase() || actual.chainId !== intent.chainId ||
      actual.from.toLowerCase() !== intent.from.toLowerCase() || actual.to?.toLowerCase() !== intent.to?.toLowerCase() ||
      actual.data.toLowerCase() !== intent.data.toLowerCase() || actual.value !== intent.value || actual.nonce !== intent.nonce) {
      throw new Error('Stored signed forward transaction conflict');
    }
    sdk.verify(transaction({ from: actual.from, to: actual.to, data: actual.data, value: BigInt(actual.value) }), step, BigInt(actual.value));
  }
}
/** A finalized source receipt means source success only, never destination delivery.
 * @param {ForwardSettings} settings @param {ForwardPorts} ports */
export async function transferEvmForward(settings, ports = defaults) {
  const fixture = selectedFixture(settings);
  const selected = selectTestSdk(settings, settings.providerDirectory, fixture);
  const fetcher = selected ? settings.replayFetch : undefined;
  if (selected && typeof fetcher !== 'function') { throw new Error('Explicit TEST replay transport function required'); }
  const recipient = forwardRecipient(settings.recipient, fixture);
  const route = forwardRoute(fixture);
  /** @type {import('../domain/evm-registration.ts').RegistrationTarget} */
  const target = { ...forwardTarget(settings), testOnly: true };
  const sepoliaRpc = selectSepoliaRpc(settings);
  if (resolve(settings.approvalJournal) === resolve(settings.sendJournal)) { throw new Error('Journal paths alias'); }
  const binding = fixture ? forwardJournalBinding(fixture, forwardRecipient(settings.recipient, fixture), settings) : undefined;
  bindFixture(settings, [settings.approvalJournal, settings.sendJournal], 'forward');
  // Check own presence on the original input before taking an asynchronous-attempt copy.
  settings = { ...settings, testOnly: settings.testOnly, signer: settings.signer, recipient,
    providerDirectory: settings.providerDirectory, approvalJournal: settings.approvalJournal, sendJournal: settings.sendJournal,
    approvalNonce: settings.approvalNonce, sendNonce: settings.sendNonce,
    ...(fixture ? { fixture, fixtureIdentity: fixture.identity } : {}),
    ...(selected && fetcher ? { providerProfile: TEST_SDK_PROFILE, replayFetch: fetcher, providerArchives: selected.archives } : {}) };
  const baseIo = ports.io ?? { signer: createCastSigner, journal: createJournalFile };
  /** @type {import('./execute-sepolia.ts').SepoliaExecutionIo|undefined} */
  const io = binding || selected ? { ...baseIo, fetcher: fetcher ?? globalThis.fetch,
    journal: binding ? file => createForwardJournalFile(file, binding, baseIo.journal) : baseIo.journal } : undefined;
  return ports.exclusive(settings.sendJournal, async () => {
    const sdk = await ports.sdk(settings.providerDirectory, recipient, fixture, sepoliaRpc, settings);
    try {
      const ready = async () => {
        if (nextRemoteConfigStep(await ports.snapshot({ ...target, sepoliaRpc }, fetcher), target) !== 'complete') {
          throw new Error('Finalized remote registration/configuration required');
        }
      };
      /** @param {EvmJournalRecord} record @param {ForwardStep} step @param {string} nonce */
      const storedIntent = (record, step, nonce) => {
        const fee = BigInt(record.intent.value);
        if (step === 'send' && (fee <= 0n || fee > 10000000000000000n)) { throw new Error('Stored native fee outside bound'); }
        const tx = transaction({ from: record.intent.from, to: record.intent.to, data: record.intent.data, value: fee });
        sdk.verify(tx, step, fee);
        const intent = forwardIntent(tx, nonce, route);
        if (canonicalIntentJson(validateSepoliaIntent(intent, intent)) !== canonicalIntentJson(record.intent)) {
          throw new Error('Stored forward intent conflict');
        }
        return intent;
      };
      /** @param {EvmJournalRecord} record @param {ForwardStep} step @param {string} file @param {string} nonce */
      const resume = async (record, step, file, nonce) => {
        const intent = storedIntent(record, step, nonce);
        // Only phase signed can have its first broadcast. All later phases reconcile despite progressed state.
        if (record.phase === 'signed') {
          await ready();
          const allowance = boundedAllowance(await sdk.allowance(), route);
          if (step === 'send' && allowance !== route.amount) { throw new Error('Exact bounded allowance required'); }
        }
        return ports.execute(intent, { sepoliaRpc, signer: settings.signer, journalFile: file, ...(fixture ? { fixture, fixtureIdentity: fixture.identity } : {}) }, io);
      };
      const sendRecord = await ports.read(settings.sendJournal);
      const approvalRecord = await ports.read(settings.approvalJournal);
      await verifyStoredPair([{ record: sendRecord, step: 'send', nonce: settings.sendNonce },
        { record: approvalRecord, step: 'approval', nonce: settings.approvalNonce }], binding, storedIntent, sdk, () => baseIo.signer(settings.signer));
      // An attempted send reconciles only itself, even if its approval record still says signed.
      if (binding && sendRecord && sendRecord.phase !== 'signed') {
        return { ...await resume(sendRecord, 'send', settings.sendJournal, settings.sendNonce), step: 'send' };
      }
      if (approvalRecord) {
        const result = await resume(approvalRecord, 'approval', settings.approvalJournal, settings.approvalNonce);
        if (result.status !== 'succeeded') { return { ...result, step: 'approval' }; }
      }
      if (sendRecord) { return { ...await resume(sendRecord, 'send', settings.sendJournal, settings.sendNonce), step: 'send' }; }
      await ready();
      const allowance = boundedAllowance(await sdk.allowance(), route);
      const candidate = await sdk.prepare();
      // Read again after the SDK's own allowance lookup, never infer a bound from approveMax=false.
      if (boundedAllowance(await sdk.allowance(), route) !== allowance) { throw new Error('Allowance changed during preparation'); }
      if (allowance < route.amount) {
        if (approvalRecord || !candidate.approval) { throw new Error('Approval state conflicts with journal/provider'); }
        const intent = forwardIntent(transaction(candidate.approval), settings.approvalNonce, route);
        sdk.verify(transaction(candidate.approval), 'approval', 0n);
        await ready();
        return { ...await ports.execute(intent, { sepoliaRpc, ...(fixture ? { fixture, fixtureIdentity: fixture.identity } : {}), signer: settings.signer, journalFile: settings.approvalJournal }, io), step: 'approval' };
      }
      if (candidate.approval) { throw new Error('Unexpected redundant approval'); }
      sdk.verify(transaction(candidate.send), 'send', candidate.fee);
      await ready();
      if (boundedAllowance(await sdk.allowance(), route) !== route.amount) { throw new Error('Allowance changed before signing'); }
      return { ...await ports.execute(forwardIntent(transaction(candidate.send), settings.sendNonce, route),
        { sepoliaRpc, ...(fixture ? { fixture, fixtureIdentity: fixture.identity } : {}), signer: settings.signer, journalFile: settings.sendJournal }, io), step: 'send' };
    } finally { await sdk.destroy(); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const settingsFile = process.argv[2];
    if (process.argv.length !== 3 || settingsFile === undefined) { throw new Error('Usage: transfer-evm-forward.mjs <private-test-settings.json>'); }
    console.log(JSON.stringify(await transferEvmForward(JSON.parse(await readFile(resolve(settingsFile), 'utf8')))));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Forward transfer failed'); process.exitCode = 1; }
}
