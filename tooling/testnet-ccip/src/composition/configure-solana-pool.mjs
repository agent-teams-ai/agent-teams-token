// @ts-check
import { setupIngress, selectSetup, freezeSetupExpected, latestSetupBlock, signSetup, setupLifetime, parseSetupCli, operatorTestFetch, testKeys, createPoolConfigOperatorIO } from "./solana-setup-operator.ts";
import { bindFixture } from "../adapters/fixture-binding.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJournalFile } from "../adapters/evm-journal-file.ts";
/** @type {typeof createJournalFile<import('../application/solana-pool-config-journal.ts').SolanaPoolConfigRecord>} */
const setupJournalFile = createJournalFile;
import { createSolanaPoolConfigSdk } from "../adapters/solana-pool-config-sdk.mjs";
import { createSolanaPoolConfigRpc, readPoolConfigSnapshot } from "../adapters/solana-pool-config-rpc.ts";
import { createSolanaRegistrationSdk } from "../adapters/solana-registration-sdk.mjs";
import { createSolanaRegistrationRpc } from "../adapters/solana-registration-rpc.ts";
import { runSolanaPoolConfigJournal } from "../application/solana-pool-config-journal.ts";
import { runSolanaRegistrationJournal } from "../application/solana-registration-journal.ts";
import { createSolanaTransactionRpc } from "../adapters/solana-transaction-rpc.ts";
import { POOL_CONFIG_OPERATIONS } from "../domain/solana-pool-config.ts";
/** @typedef {ReturnType<typeof createSolanaPoolConfigRpc> & {observeRepairPredecessor: ReturnType<typeof createSolanaPoolConfigRpc>['observe']}} ConfigRpc */
/** @type {typeof createJournalFile<import('../application/solana-registration-journal.ts').SolanaRegistrationRecord>} */
const registrationJournalFile = createJournalFile;
/** @param {import('../domain/solana-pool-init.ts').SolanaPoolInitExpectation} previous @param {import('../domain/solana-pool-config.ts').SolanaPoolConfigExpectation} expected */
function predecessorIdentity(previous, expected) {
  for (const field of /** @type {const} */ (["payer", "mint", "pool", "cluster", "testOnly"])) {
    if (previous[field] !== expected[field]) { throw new Error("Wrong predecessor identity"); }
  }
  if (expected.fixture !== undefined && previous.fixture?.identity !== expected.fixture.identity) { throw new Error("Wrong predecessor fixture identity"); }
}
/** @param {Pick<import('./solana-setup-operator.ts').ConfigSettings, 'journalDirectory' | 'registrationJournalFile'>} settings
 * @param {import('../domain/solana-pool-config.ts').SolanaPoolConfigExpectation} expected
 * @param {{sdk: Pick<import('../adapters/solana-pool-config-sdk.mjs').UnsignedPoolConfigSdk, 'derive' | 'inspectSigned'>, rpc: ConfigRpc,
 * registrationSdk: import('../adapters/solana-registration-sdk.mjs').RegistrationPredecessorVerifier, registrationRpc: ReturnType<typeof createSolanaRegistrationRpc>}} ports */
export async function verifyPoolConfigPredecessor(settings, expected, { sdk, rpc, registrationSdk, registrationRpc }) {
  const index = POOL_CONFIG_OPERATIONS.indexOf(expected.operation);
  if (index === 0) {
    const file = registrationJournalFile(settings.registrationJournalFile), record = await file.exclusive(() => file.read());
    if (record?.phase !== "succeeded" || record.intent.operation !== "transfer-mint-authority") { throw new Error("Previous pool configuration checkpoint is not finalized"); }
    predecessorIdentity(record.intent, expected);
    const previous = registrationSdk.derive(record.intent);
    const result = await runSolanaRegistrationJournal(previous, { ...file, ...registrationRpc,
      inspectSigned: async bytes => registrationSdk.inspectSigned(bytes, previous),
      sign: async () => { throw new Error("Predecessor cannot be replaced"); },
      broadcast: async () => { throw new Error("Predecessor cannot be resent"); },
    });
    if (result.status !== "succeeded") { throw new Error("Previous checkpoint is unreadable or unresolved"); }
    return;
  }
  const operation = POOL_CONFIG_OPERATIONS[index - 1];
  if (!operation) { throw new Error("Unknown pool configuration predecessor"); }
  const file = setupJournalFile(resolve(settings.journalDirectory, operation + ".json")), record = await file.exclusive(() => file.read());
  if (record?.phase !== "succeeded" || record.intent.operation !== operation) { throw new Error("Previous pool configuration checkpoint is not finalized"); }
  predecessorIdentity(record.intent, expected);
  const previous = sdk.derive(record.intent);
  if (["set-pool", "repair-remote-pool-encoding"].includes(expected.operation) && (previous.alt !== expected.alt || previous.recentSlot !== expected.recentSlot)) { throw new Error("Set pool must use the finalized predecessor ALT"); }
  const observer = expected.operation === "repair-remote-pool-encoding" ? { ...rpc, observe: rpc.observeRepairPredecessor } : rpc;
  const result = await runSolanaPoolConfigJournal(previous, { ...file, ...observer,
    inspectSigned: async bytes => sdk.inspectSigned(bytes, previous),
    sign: async () => { throw new Error("Predecessor cannot be replaced"); },
    broadcast: async () => { throw new Error("Predecessor cannot be resent"); },
  });
  if (result.status !== "succeeded") { throw new Error("Previous checkpoint is unreadable or unresolved"); }
}
/** @param {string} bytes @param {import('../domain/solana-pool-config.ts').SolanaPoolConfigExpectation} expected @param {ReturnType<typeof createSolanaPoolConfigRpc>} rpc @param {import('../adapters/solana-pool-config-rpc.ts').PoolConfigVerifier} sdk */
export async function broadcastPoolConfig(bytes, expected, rpc, sdk) {
  if (expected.operation === "repair-remote-pool-encoding") {
    // This guard also runs when a persisted signed journal resumes after a crash.
    await rpc.chain();
    await readPoolConfigSnapshot(rpc.readRpc, sdk, expected, "before");
  }
  return rpc.broadcast(bytes);
}
/** @param {import('./solana-setup-operator.ts').ConfigSettings} settings @param {import('./solana-setup-operator.ts').SetupIO<import('../domain/solana-pool-config.ts').SolanaPoolConfigExpectation, import('../adapters/solana-pool-config-sdk.mjs').UnsignedPoolConfigSdk>} [io] @returns {Promise<import('./solana-setup-operator.ts').ConfigResult>} */
export async function configureTestSolanaPool(settings, io) {
  const { selection, providerDirectory, journalDirectory, registrationJournalFilePath, input, lifetime } = setupIngress(() => {
    if (settings.testOnly !== true || settings.expected?.testOnly !== true || settings.expected.cluster !== "solana-devnet" ||
      !POOL_CONFIG_OPERATIONS.includes(settings.expected.operation)) { throw new Error("Explicit test-only pool configuration required"); }
    const selected = selectSetup(settings, io);
    const directory = settings.providerDirectory;
    const journal = settings.journalDirectory;
    const predecessorFile = settings.registrationJournalFile;
    const fixture = bindFixture(settings, [journal, predecessorFile]);
    const captured = freezeSetupExpected({ ...settings.expected, ...(fixture ? { fixture } : {}) });
    const owner = setupLifetime(io?.fetcher ?? globalThis.fetch);
    return { selection: selected, providerDirectory: directory, journalDirectory: journal, registrationJournalFilePath: predecessorFile, input: captured, lifetime: owner };
  });
  /** @type {Awaited<ReturnType<typeof createSolanaPoolConfigSdk>> | undefined} */ let acquiredSdk;
  let sdk;
  try { sdk = await lifetime.track(async () => {
    const value = await (selection ? (io?.openSdk ?? createSolanaPoolConfigSdk)(providerDirectory, selection) : createSolanaPoolConfigSdk(providerDirectory));
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
  const observer = createSolanaPoolConfigRpc((bytes, intent) => sdk.inspectSigned(bytes, intent).messageBase64, sdk, lifetime.fetcher);
  // Reconcile the historical set-pool transaction against the explicitly guarded
  // legacy repair prerequisite, not a replay of the old append32 journal.
  /** @type {ConfigRpc['observe']} */
  const observeRepairPredecessor = createSolanaTransactionRpc(
    (bytes, intent) => sdk.inspectSigned(bytes, intent).messageBase64,
    async (read, intent, slot) => {
      await readPoolConfigSnapshot(read, sdk, expected, "before", slot);
      return { operation: intent.operation, mint: expected.mint, verified: /** @type {const} */ (true) };
    }, lifetime.fetcher).observe;
  const rpc = { ...observer, observeRepairPredecessor };
  if (selection && !("registrationVerifier" in sdk)) { throw new Error("Borrowed TEST registration verifier required"); }
  const registrationSdk = "registrationVerifier" in sdk ? sdk.registrationVerifier : await createSolanaRegistrationSdk(providerDirectory);
  const registrationRpc = createSolanaRegistrationRpc((bytes, intent) => registrationSdk.inspectSigned(bytes, intent).messageBase64, registrationSdk, lifetime.fetcher);
  const result = await runSolanaPoolConfigJournal(expected, {
    ...setupJournalFile(resolve(journalDirectory, expected.operation + ".json")), ...rpc,
    inspectSigned: async bytes => sdk.inspectSigned(bytes, expected),
    broadcast: bytes => broadcastPoolConfig(bytes, expected, rpc, sdk),
    async sign() {
      await verifyPoolConfigPredecessor({ journalDirectory, registrationJournalFile: registrationJournalFilePath }, expected, { sdk, rpc, registrationSdk, registrationRpc });
      await rpc.chain();
      await readPoolConfigSnapshot(rpc.readRpc, sdk, expected, "before");
      const latest = latestSetupBlock(await rpc.readRpc("getLatestBlockhash", [{ commitment: "finalized" }]));
      await rpc.chain();
      lifetime.assertOpen();
      const prepared = sdk.build(expected, latest);
      if (selection) { return lifetime.track(() => signSetup(prepared, expected, latest, sdk.inspectSigned, io?.signPrepared)); }
      if (!("sign" in sdk)) { throw new Error("Legacy setup signer unavailable"); }
      return lifetime.track(() => sdk.sign(prepared, expected, testKeys(settings)));

    },
  });
  return { operation: expected.operation, status: result.status, phase: result.record.phase, reason: result.reason,
    signature: result.record.signed.signature, alt: expected.alt };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 && process.argv.length !== 4 || !process.argv[2] || process.argv.length === 4 && process.argv[3] !== "--operator-test") { throw new Error("Invalid setup CLI invocation"); }
    const raw = /** @type {unknown} */ (JSON.parse(await readFile(resolve(process.argv[2]), "utf8")));
    const settings = parseSetupCli(raw, "config");
    const operator = process.argv[3] === "--operator-test";
    if (operator && !Object.hasOwn(settings, "providerProfile")) { throw new Error("Explicit TEST operator profile required"); }
    const io = operator ? createPoolConfigOperatorIO(testKeys(raw), operatorTestFetch(raw)) : undefined;
    const publicSettings = operator ? settings : { ...settings, ...testKeys(raw) };
    console.log(JSON.stringify(await configureTestSolanaPool(publicSettings, io)));
  } catch { console.error("Solana pool configuration failed"); process.exitCode = 1; }
}
