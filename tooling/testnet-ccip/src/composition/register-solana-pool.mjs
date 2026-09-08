import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSolanaRegistrationSdk } from "../adapters/solana-registration-sdk.mjs";
import { createSolanaRegistrationRpc, readRegistrationSnapshot } from "../adapters/solana-registration-rpc.ts";
import { createJournalFile } from "../adapters/evm-journal-file.ts";
import { runSolanaRegistrationJournal } from "../application/solana-registration-journal.ts";
import { REGISTRATION_OPERATIONS } from "../domain/solana-registration.ts";
export async function verifyPreviousRegistrationCheckpoint(journalDirectory, expected, sdk, rpc) {
      const previousOperation = REGISTRATION_OPERATIONS[REGISTRATION_OPERATIONS.indexOf(expected.operation) - 1];
      if (previousOperation) {
        const previous = { ...expected, operation: previousOperation };
        const file = createJournalFile(resolve(journalDirectory, previousOperation + ".json"));
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
/** One explicit prerequisite-gated operation, with its own non-replaceable durable journal. */
export async function registerTestSolanaPool(settings) {
  if (settings.testOnly !== true || settings.expected?.testOnly !== true || settings.expected.cluster !== "solana-devnet" ||
    !REGISTRATION_OPERATIONS.includes(settings.expected.operation)) { throw new Error("Test-only registration settings required"); }
  const sdk = await createSolanaRegistrationSdk(settings.providerDirectory), expected = sdk.derive(settings.expected);
  const rpc = createSolanaRegistrationRpc((bytes, intent) => sdk.inspectSigned(bytes, intent).messageBase64, sdk);
  const journalFile = resolve(settings.journalDirectory, expected.operation + ".json");
  const result = await runSolanaRegistrationJournal(expected, {
    ...createJournalFile(journalFile), ...rpc,
    inspectSigned: async bytes => sdk.inspectSigned(bytes, expected),
    async sign() {
      await verifyPreviousRegistrationCheckpoint(settings.journalDirectory, expected, sdk, rpc);
      await rpc.chain();
      await readRegistrationSnapshot(rpc.readRpc, sdk, expected, "before");
      const latest = await rpc.readRpc("getLatestBlockhash", [{ commitment: "finalized" }]);
      if (!Number.isSafeInteger(latest?.value?.lastValidBlockHeight) || latest.value.lastValidBlockHeight < 0) { throw new Error("Invalid block validity"); }
      await rpc.chain();
      const prepared = sdk.build(expected, { blockhash: latest.value.blockhash, lastValidBlockHeight: String(latest.value.lastValidBlockHeight) });
      return sdk.sign(prepared, expected, { testOnly: true, payerFile: settings.payerFile });
    },
  });
  return { operation: expected.operation, status: result.status, phase: result.record.phase,
    reason: result.reason, signature: result.record.signed.signature };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) { throw new Error("Usage: register-solana-pool.mjs <private-test-settings.json>"); }
    console.log(JSON.stringify(await registerTestSolanaPool(JSON.parse(await readFile(resolve(process.argv[2]), "utf8")))));
  } catch (error) { console.error(error instanceof Error ? error.message : "Solana registration failed"); process.exitCode = 1; }
}
