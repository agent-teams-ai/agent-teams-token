// @ts-check
import { selectSetup, freezeSetupExpected, latestSetupBlock, signSetup, setupLifetime, parseSetupCli, operatorTestFetch, testKeys, createRegistrationOperatorIO } from "./solana-setup-operator.ts";
import { bindFixture } from "../adapters/fixture-binding.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSolanaRegistrationSdk } from "../adapters/solana-registration-sdk.mjs";
import { createSolanaRegistrationRpc, readRegistrationSnapshot } from "../adapters/solana-registration-rpc.ts";
import { createJournalFile } from "../adapters/evm-journal-file.ts";
/** @type {typeof createJournalFile<import('../application/solana-registration-journal.ts').SolanaRegistrationRecord>} */
const setupJournalFile = createJournalFile;
import { runSolanaRegistrationJournal } from "../application/solana-registration-journal.ts";
import { REGISTRATION_OPERATIONS } from "../domain/solana-registration.ts";
/** @param {string} journalDirectory @param {import('../domain/solana-registration.ts').SolanaRegistrationExpectation} expected @param {Pick<import('../adapters/solana-registration-sdk.mjs').RegistrationPredecessorVerifier, 'inspectSigned'>} sdk @param {ReturnType<typeof createSolanaRegistrationRpc>} rpc */
export async function verifyPreviousRegistrationCheckpoint(journalDirectory, expected, sdk, rpc) {
      const previousOperation = REGISTRATION_OPERATIONS[REGISTRATION_OPERATIONS.indexOf(expected.operation) - 1];
      if (previousOperation) {
        const previous = { ...expected, operation: previousOperation };
        const file = setupJournalFile(resolve(journalDirectory, previousOperation + ".json"));
        const prior = await file.exclusive(() => file.read());
        if (prior?.phase !== "succeeded") { throw new Error("Previous registration checkpoint is not finalized; reconcile it first"); }
        const reconciled = await runSolanaRegistrationJournal(previous, { ...file, ...rpc,
          sign: async () => { throw new Error("Previous checkpoint cannot be replaced"); },
          broadcast: async () => { throw new Error("Previous checkpoint cannot be resent"); },
          inspectSigned: async bytes => sdk.inspectSigned(bytes, previous),
        });
        if (reconciled.status !== "succeeded") { throw new Error("Previous registration checkpoint is unreadable or unresolved"); }
      }
}
/** @param {import('../domain/solana-registration.ts').SolanaRegistrationExpectation} expected @param {ReturnType<typeof createSolanaRegistrationRpc>} rpc @param {import('../adapters/solana-registration-rpc.ts').RegistrationVerifier} sdk */
export async function beforeBroadcastRegistration(expected, rpc, sdk) {
  // A durable signed restart skips sign(); recheck before marking submission uncertain.
  await rpc.chain();
  await readRegistrationSnapshot(rpc.readRpc, sdk, expected, "before");
}
/** One explicit prerequisite-gated operation, with its own non-replaceable durable journal. */
/** @param {import('./solana-setup-operator.ts').RegistrationSettings} settings @param {import('./solana-setup-operator.ts').SetupIO<import('../domain/solana-registration.ts').SolanaRegistrationExpectation, import('../adapters/solana-registration-sdk.mjs').UnsignedRegistrationSdk>} [io] @returns {Promise<import('./solana-setup-operator.ts').RegistrationResult>} */
export async function registerTestSolanaPool(settings, io) {
  if (settings.testOnly !== true || settings.expected?.testOnly !== true || settings.expected.cluster !== "solana-devnet" ||
    !REGISTRATION_OPERATIONS.includes(settings.expected.operation)) { throw new Error("Test-only registration settings required"); }
  const selection = selectSetup(settings, io);
  const providerDirectory = settings.providerDirectory;
  const journalDirectory = settings.journalDirectory;
  const fixture = bindFixture(settings, [journalDirectory]);
  const input = freezeSetupExpected({ ...settings.expected, ...(fixture ? { fixture } : {}) });
  const lifetime = setupLifetime(io?.fetcher ?? globalThis.fetch);
  /** @type {Awaited<ReturnType<typeof createSolanaRegistrationSdk>> | undefined} */ let acquiredSdk;
  let sdk;
  try { sdk = await lifetime.track(async () => {
    const value = await (selection ? (io?.openSdk ?? createSolanaRegistrationSdk)(providerDirectory, selection) : createSolanaRegistrationSdk(providerDirectory));
    acquiredSdk = value; return value;
  }); }
  catch {
    try { await lifetime.close(async () => { if (acquiredSdk && "destroy" in acquiredSdk) { await acquiredSdk.destroy(); } }); }
    catch { throw new Error("TEST setup provider unavailable; unresolved cleanup debt"); }
    throw new Error("TEST setup provider unavailable");
  }
  return lifetime.run(async () => { if ("destroy" in sdk) { await sdk.destroy(); } }, async () => {
  if (selection && "sign" in sdk) { throw new Error("Unsigned TEST setup view required"); }
  const expected = freezeSetupExpected(sdk.derive(input));
  const rpc = createSolanaRegistrationRpc((bytes, intent) => sdk.inspectSigned(bytes, intent).messageBase64, sdk, lifetime.fetcher);
  const journalFile = resolve(journalDirectory, expected.operation + ".json");
  const result = await runSolanaRegistrationJournal(expected, {
    ...setupJournalFile(journalFile), ...rpc,
    inspectSigned: async bytes => sdk.inspectSigned(bytes, expected),
    beforeBroadcast: () => beforeBroadcastRegistration(expected, rpc, sdk),
    async sign() {
      await verifyPreviousRegistrationCheckpoint(journalDirectory, expected, sdk, rpc);
      await rpc.chain();
      await readRegistrationSnapshot(rpc.readRpc, sdk, expected, "before");
      const latest = latestSetupBlock(await rpc.readRpc("getLatestBlockhash", [{ commitment: "finalized" }]));
      await rpc.chain();
      lifetime.assertOpen();
      const prepared = sdk.build(expected, latest);
      if (selection) { return lifetime.track(() => signSetup(prepared, expected, latest, sdk.inspectSigned, io?.signPrepared)); }
      if (!("sign" in sdk)) { throw new Error("Legacy setup signer unavailable"); }
      return lifetime.track(() => sdk.sign(prepared, expected, testKeys(settings)));

    },
  });
  return { operation: expected.operation, status: result.status, phase: result.record.phase,
    reason: result.reason, signature: result.record.signed.signature };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 && process.argv.length !== 4 || !process.argv[2] || process.argv.length === 4 && process.argv[3] !== "--operator-test") { throw new Error("Invalid setup CLI invocation"); }
    const raw = /** @type {unknown} */ (JSON.parse(await readFile(resolve(process.argv[2]), "utf8")));
    const settings = parseSetupCli(raw, "registration");
    const operator = process.argv[3] === "--operator-test";
    if (operator && !Object.hasOwn(settings, "providerProfile")) { throw new Error("Explicit TEST operator profile required"); }
    const io = operator ? createRegistrationOperatorIO(testKeys(raw), operatorTestFetch(raw)) : undefined;
    const publicSettings = operator ? settings : { ...settings, ...testKeys(raw) };
    console.log(JSON.stringify(await registerTestSolanaPool(publicSettings, io)));
  } catch { console.error("Solana registration failed"); process.exitCode = 1; }
}
