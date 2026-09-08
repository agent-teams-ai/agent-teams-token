import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJournalFile } from "../adapters/evm-journal-file.ts";
import { createSolanaPoolConfigSdk } from "../adapters/solana-pool-config-sdk.mjs";
import { createSolanaPoolConfigRpc, readPoolConfigSnapshot } from "../adapters/solana-pool-config-rpc.ts";
import { createSolanaRegistrationSdk } from "../adapters/solana-registration-sdk.mjs";
import { createSolanaRegistrationRpc } from "../adapters/solana-registration-rpc.ts";
import { runSolanaPoolConfigJournal } from "../application/solana-pool-config-journal.ts";
import { runSolanaRegistrationJournal } from "../application/solana-registration-journal.ts";
import { createSolanaTransactionRpc } from "../adapters/solana-transaction-rpc.ts";
import { POOL_CONFIG_OPERATIONS } from "../domain/solana-pool-config.ts";
export async function verifyPoolConfigPredecessor(settings, expected, { sdk, rpc, registrationSdk, registrationRpc }) {
  const index = POOL_CONFIG_OPERATIONS.indexOf(expected.operation);
  const registration = index === 0;
  const operation = registration ? "transfer-mint-authority" : POOL_CONFIG_OPERATIONS[index - 1];
  const path = registration ? settings.registrationJournalFile : resolve(settings.journalDirectory, operation + ".json");
  const file = createJournalFile(path), record = await file.exclusive(() => file.read());
  if (record?.phase !== "succeeded" || record.intent?.operation !== operation) { throw new Error("Previous pool configuration checkpoint is not finalized"); }
  for (const field of ["payer", "mint", "pool", "cluster", "testOnly"]) {
    if (record.intent[field] !== expected[field]) { throw new Error("Wrong predecessor identity"); }
  }
  const provider = registration ? registrationSdk : sdk;
  const observer = registration ? registrationRpc : expected.operation === "repair-remote-pool-encoding" ? { ...rpc, observe: rpc.observeRepairPredecessor } : rpc;
  const previous = provider.derive(record.intent);
  if (["set-pool", "repair-remote-pool-encoding"].includes(expected.operation) && (previous.alt !== expected.alt || previous.recentSlot !== expected.recentSlot)) { throw new Error("Set pool must use the finalized predecessor ALT"); }
  const run = registration ? runSolanaRegistrationJournal : runSolanaPoolConfigJournal;
  const result = await run(previous, { ...file, ...observer,
    inspectSigned: async bytes => provider.inspectSigned(bytes, previous),
    sign: async () => { throw new Error("Predecessor cannot be replaced"); },
    broadcast: async () => { throw new Error("Predecessor cannot be resent"); },
  });
  if (result.status !== "succeeded") { throw new Error("Previous checkpoint is unreadable or unresolved"); }
}
export async function broadcastPoolConfig(bytes, expected, rpc, sdk) {
  if (expected.operation === "repair-remote-pool-encoding") {
    // This guard also runs when a persisted signed journal resumes after a crash.
    await rpc.chain();
    await readPoolConfigSnapshot(rpc.readRpc, sdk, expected, "before");
  }
  return rpc.broadcast(bytes);
}
export async function configureTestSolanaPool(settings) {
  if (settings.testOnly !== true || settings.expected?.testOnly !== true || settings.expected.cluster !== "solana-devnet" ||
    !POOL_CONFIG_OPERATIONS.includes(settings.expected.operation)) { throw new Error("Explicit test-only pool configuration required"); }
  const sdk = await createSolanaPoolConfigSdk(settings.providerDirectory), expected = sdk.derive(settings.expected);
  const rpc = createSolanaPoolConfigRpc((bytes, intent) => sdk.inspectSigned(bytes, intent).messageBase64, sdk);
  // Reconcile the historical set-pool transaction against the explicitly guarded
  // legacy repair prerequisite, not a replay of the old append32 journal.
  rpc.observeRepairPredecessor = createSolanaTransactionRpc(
    (bytes, intent) => sdk.inspectSigned(bytes, intent).messageBase64,
    async (read, intent, slot) => {
      await readPoolConfigSnapshot(read, sdk, expected, "before", slot);
      return { operation: intent.operation, mint: expected.mint, verified: true };
    }).observe;
  const registrationSdk = await createSolanaRegistrationSdk(settings.providerDirectory);
  const registrationRpc = createSolanaRegistrationRpc((bytes, intent) => registrationSdk.inspectSigned(bytes, intent).messageBase64, registrationSdk);
  const result = await runSolanaPoolConfigJournal(expected, {
    ...createJournalFile(resolve(settings.journalDirectory, expected.operation + ".json")), ...rpc,
    inspectSigned: async bytes => sdk.inspectSigned(bytes, expected),
    broadcast: bytes => broadcastPoolConfig(bytes, expected, rpc, sdk),
    async sign() {
      await verifyPoolConfigPredecessor(settings, expected, { sdk, rpc, registrationSdk, registrationRpc });
      await rpc.chain();
      await readPoolConfigSnapshot(rpc.readRpc, sdk, expected, "before");
      const latest = await rpc.readRpc("getLatestBlockhash", [{ commitment: "finalized" }]);
      if (!Number.isSafeInteger(latest?.value?.lastValidBlockHeight) || latest.value.lastValidBlockHeight <= 0) { throw new Error("Invalid block validity"); }
      await rpc.chain();
      return sdk.sign(sdk.build(expected, { blockhash: latest.value.blockhash, lastValidBlockHeight: String(latest.value.lastValidBlockHeight) }), expected,
        { testOnly: true, payerFile: settings.payerFile });
    },
  });
  return { operation: expected.operation, status: result.status, phase: result.record.phase, reason: result.reason,
    signature: result.record.signed.signature, alt: expected.alt };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) { throw new Error("Usage: configure-solana-pool.mjs <private-test-settings.json>"); }
    console.log(JSON.stringify(await configureTestSolanaPool(JSON.parse(await readFile(resolve(process.argv[2]), "utf8")))));
  } catch (error) { console.error(error instanceof Error ? error.message : "Solana pool configuration failed"); process.exitCode = 1; }
}
