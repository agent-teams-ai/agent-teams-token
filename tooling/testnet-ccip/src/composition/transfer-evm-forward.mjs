import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEvmForwardSdk } from '../adapters/evm-forward-sdk.mjs';
import { createJournalFile } from '../adapters/evm-journal-file.ts';
import { readRemoteConfigSnapshot } from '../adapters/evm-remote-config-rpc.ts';
import { nextRemoteConfigStep } from '../domain/evm-remote-config.ts';
import { canonicalIntentJson, validateSepoliaIntent } from '../domain/evm-intent.ts';
import { FORWARD, boundedAllowance, forwardIntent, forwardTarget } from '../domain/evm-forward.mjs';
import { executeSepoliaIntent } from './execute-sepolia.ts';
const defaults = {
  sdk: createEvmForwardSdk, snapshot: readRemoteConfigSnapshot, execute: executeSepoliaIntent,
  read: async file => { const store = createJournalFile(file); return store.exclusive(() => store.read()); },
  exclusive: (file, work) => createJournalFile(file + '.forward-operation').exclusive(work),
};
/** A finalized source receipt means source success only, never destination delivery. */
export async function transferEvmForward(settings, ports = defaults) {
  const target = forwardTarget(settings);
  if (resolve(settings.approvalJournal) === resolve(settings.sendJournal)) { throw new Error('Journal paths alias'); }
  return ports.exclusive(settings.sendJournal, async () => {
    const sdk = await ports.sdk(settings.providerDirectory);
    const ready = async () => {
      if (nextRemoteConfigStep(await ports.snapshot(target), target) !== 'complete') {
        throw new Error('Finalized remote registration/configuration required');
      }
    };
    const resume = async (record, step, file, nonce) => {
      const fee = BigInt(record.intent.value);
      if (step === 'send' && (fee <= 0n || fee > 10000000000000000n)) { throw new Error('Stored native fee outside bound'); }
      const tx = { from: record.intent.from, to: record.intent.to, data: record.intent.data, value: fee };
      sdk.verify(tx, step, fee);
      const intent = forwardIntent(tx, nonce);
      if (canonicalIntentJson(validateSepoliaIntent(intent, intent)) !== canonicalIntentJson(record.intent)) {
        throw new Error('Stored forward intent conflict');
      }
      // Only phase signed can have its first broadcast. All later phases reconcile despite progressed state.
      if (record.phase === 'signed') {
        await ready();
        const allowance = boundedAllowance(await sdk.allowance());
        if (step === 'send' && allowance !== FORWARD.amount) { throw new Error('Exact bounded allowance required'); }
      }
      return ports.execute(intent, { signer: settings.signer, journalFile: file });
    };
    try {
      const sendRecord = await ports.read(settings.sendJournal);
      const approvalRecord = await ports.read(settings.approvalJournal);
      if (approvalRecord) {
        const result = await resume(approvalRecord, 'approval', settings.approvalJournal, settings.approvalNonce);
        if (result.status !== 'succeeded') { return { ...result, step: 'approval' }; }
      }
      if (sendRecord) { return { ...await resume(sendRecord, 'send', settings.sendJournal, settings.sendNonce), step: 'send' }; }
      await ready();
      const allowance = boundedAllowance(await sdk.allowance());
      const candidate = await sdk.prepare();
      // Read again after the SDK's own allowance lookup, never infer a bound from approveMax=false.
      if (boundedAllowance(await sdk.allowance()) !== allowance) { throw new Error('Allowance changed during preparation'); }
      if (allowance < FORWARD.amount) {
        if (approvalRecord || !candidate.approval) { throw new Error('Approval state conflicts with journal/provider'); }
        const intent = forwardIntent(candidate.approval, settings.approvalNonce);
        sdk.verify(candidate.approval, 'approval', 0n);
        await ready();
        return { ...await ports.execute(intent, { signer: settings.signer, journalFile: settings.approvalJournal }), step: 'approval' };
      }
      if (candidate.approval) { throw new Error('Unexpected redundant approval'); }
      sdk.verify(candidate.send, 'send', candidate.fee);
      await ready();
      if (boundedAllowance(await sdk.allowance()) !== FORWARD.amount) { throw new Error('Allowance changed before signing'); }
      return { ...await ports.execute(forwardIntent(candidate.send, settings.sendNonce),
        { signer: settings.signer, journalFile: settings.sendJournal }), step: 'send' };
    } finally { await sdk.destroy(); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) { throw new Error('Usage: transfer-evm-forward.mjs <private-test-settings.json>'); }
    console.log(JSON.stringify(await transferEvmForward(JSON.parse(await readFile(resolve(process.argv[2]), 'utf8')))));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Forward transfer failed'); process.exitCode = 1; }
}
