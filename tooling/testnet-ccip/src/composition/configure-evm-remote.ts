import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJournalFile } from "../adapters/evm-journal-file.ts";
import { readRemoteConfigSnapshot } from "../adapters/evm-remote-config-rpc.ts";
import type { CastSignerConfig } from "../adapters/evm-cast.ts";
import type { RegistrationTarget } from "../domain/evm-registration.ts";
import { nextRemoteConfigStep, remoteConfigCalldata } from "../domain/evm-remote-config.ts";
import { validateSepoliaIntent } from "../domain/evm-intent.ts";
import { executeSepoliaIntent } from "./execute-sepolia.ts";
export interface RemoteConfigSettings extends RegistrationTarget {
  readonly signer: CastSignerConfig; readonly journalFile: string; readonly nonce: string;
}
const defaults = {
  snapshot: readRemoteConfigSnapshot,
  read: async (file: string) => { const store = createJournalFile(file); return store.exclusive(() => store.read()); },
  execute: executeSepoliaIntent,
};
/** One fixed journal/nonce. Reconcile it even when finalized remote state already matches. */
export async function configureEvmRemote(settings: RemoteConfigSettings, ports = defaults): Promise<{
  status: string; reason: string; transactionHash?: string;
}> {
  if (settings.testOnly !== true || settings.signer.testOnly !== true) { throw new Error("Test-only remote config required"); }
  const intent = { chainId: "11155111", kind: "call" as const, from: settings.administrator,
    to: settings.pool, value: "0", nonce: settings.nonce, data: remoteConfigCalldata() };
  validateSepoliaIntent(intent, intent);
  const initial = nextRemoteConfigStep(await ports.snapshot(settings), settings);
  const prior = await ports.read(settings.journalFile);
  if (prior) {
    if (prior.phase === "signed" && initial === "complete") { throw new Error("Signed configuration prerequisites changed"); }
    const reconciled = await ports.execute(intent, settings);
    if (reconciled.status !== "succeeded") { return reconciled; }
    if (nextRemoteConfigStep(await ports.snapshot(settings), settings) !== "complete") {
      throw new Error("Finalized remote config transaction/state mismatch");
    }
    return { ...reconciled, reason: "finalized-remote-config-match" };
  }
  if (initial === "complete") { return { status: "succeeded", reason: "finalized-remote-config-match" }; }
  const result = await ports.execute(intent, settings);
  if (result.status === "succeeded" && nextRemoteConfigStep(await ports.snapshot(settings), settings) !== "complete") {
    throw new Error("Finalized remote config transaction/state mismatch");
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) { throw new Error("Usage: configure-evm-remote.ts <private-test-settings.json>"); }
    console.log(JSON.stringify(await configureEvmRemote(JSON.parse(await readFile(resolve(process.argv[2]!), "utf8")))));
  } catch (error) { console.error(error instanceof Error ? error.message : "Remote configuration failed"); process.exitCode = 1; }
}
