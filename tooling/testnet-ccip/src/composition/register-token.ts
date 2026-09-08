import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSepoliaRpc } from "../adapters/evm-rpc.ts";
import { readRegistrationSnapshot } from "../adapters/evm-registration-rpc.ts";
import type { CastSignerConfig } from "../adapters/evm-cast.ts";
import type { EvmJournalRecord } from "../application/evm-journal.ts";
import { runEvmJournal } from "../application/evm-journal.ts";
import { nextRegistrationStep } from "../domain/evm-registration.ts";
import type { RegistrationTarget } from "../domain/evm-registration.ts";
import type { SepoliaIntentInput } from "../domain/evm-intent.ts";
import { lockReleaseConstructor } from "../domain/evm-pool.ts";
import { testTokenConstructor } from "./deploy-token.ts";
import { executeSepoliaIntent } from "./execute-sepolia.ts";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const kinds = ["register-admin", "accept-admin", "set-pool"] as const;
type Kind = typeof kinds[number];
export interface RegistrationSettings extends RegistrationTarget {
  readonly signer: CastSignerConfig;
  readonly tokenDeployment: { readonly journalFile: string; readonly intent: SepoliaIntentInput };
  readonly poolDeployment: { readonly journalFile: string; readonly intent: SepoliaIntentInput };
  readonly steps: Readonly<Record<Kind, { readonly journalFile: string; readonly nonce: string }>>;
}
const defaults = {
  read: async (file: string): Promise<EvmJournalRecord> => JSON.parse(await readFile(file, "utf8")) as EvmJournalRecord,
  observe: createSepoliaRpc(RPC).observe,
  snapshot: readRegistrationSnapshot,
  execute: executeSepoliaIntent,
  async address(record: EvmJournalRecord): Promise<string> {
    const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [record.signed.hash] }),
      redirect: "error", signal: AbortSignal.timeout(20_000) });
    const body = await response.json() as { id: number; jsonrpc: string; error?: unknown; result?: {
      transactionHash: string; blockHash: string; status: string; contractAddress: string;
    } };
    const receipt = body.result;
    if (!response.ok || body.id !== 1 || body.jsonrpc !== "2.0" || "error" in body || !receipt ||
      receipt.transactionHash.toLowerCase() !== record.signed.hash.toLowerCase() || receipt.status !== "0x1" ||
      receipt.blockHash.toLowerCase() !== record.receipt?.blockHash.toLowerCase() ||
      !/^0x[0-9a-fA-F]{40}$/.test(receipt.contractAddress)) { throw new Error("Deployment address evidence unavailable"); }
    return receipt.contractAddress.toLowerCase();
  },
};
async function verifyDeployments(settings: RegistrationSettings, ports: typeof defaults): Promise<void> {
  for (const [deployment, expectedAddress, artifactId, constructorBytes] of [
    [settings.tokenDeployment, settings.token, "AGTMAICCIPToken", testTokenConstructor(settings.administrator)],
    [settings.poolDeployment, settings.pool, "@chainlink/contracts-ccip@1.6.1/LockReleaseTokenPool", lockReleaseConstructor(settings.token)],
  ] as const) {
    const binding = deployment.intent.deployment;
    if (deployment.intent.kind !== "deploy" || deployment.intent.value !== "0" ||
      deployment.intent.from.toLowerCase() !== settings.administrator.toLowerCase() ||
      binding?.artifactId !== artifactId || binding.constructorBytes.toLowerCase() !== constructorBytes.toLowerCase() ||
      binding.administrator.toLowerCase() !== settings.administrator.toLowerCase() ||
      (artifactId.includes("LockRelease") && binding.artifactSha256 !== "82dac8896b84a7abe909e076a4de830258e19f5aae50f48ce17cfe8305f74114")) {
      throw new Error("Unexpected test deployment intent");
    }
    const record = await ports.read(deployment.journalFile);
    if (record.phase !== "succeeded") { throw new Error("Finalized deployment journal required"); }
    const observed = await ports.observe(record.signed.hash);
    const result = await runEvmJournal(deployment.intent, deployment.intent, {
      exclusive: work => work(), read: async () => record, observe: async () => observed,
      // No signing, mutation or broadcast is permitted during prerequisite reconciliation.
      sign: async () => { throw new Error("Deployment signing forbidden"); },
      write: async () => { throw new Error("Deployment mutation forbidden"); },
      broadcast: async () => { throw new Error("Deployment broadcast forbidden"); },
      inspectSigned: async () => { if (observed.kind !== "observed") { throw new Error("Deployment unavailable"); }
        return observed.transaction; },
    });
    if (result.status !== "succeeded" || await ports.address(record) !== expectedAddress.toLowerCase()) {
      throw new Error("Finalized deployment/address mismatch");
    }
  }
}
/** One bounded step per invocation. Existing journals reconcile before any later step can start. */
export async function registerTestToken(settings: RegistrationSettings, ports = defaults): Promise<{
  status: string; reason: string; transactionHash?: string; step?: Kind;
}> {
  if (settings.testOnly !== true || settings.signer.testOnly !== true) { throw new Error("Test-only registration required"); }
  const files = [settings.tokenDeployment.journalFile, settings.poolDeployment.journalFile,
    ...kinds.map(kind => settings.steps[kind].journalFile)];
  // Normalize existing symlinks as well as lexical aliases before checking separation.
  const paths = await Promise.all(files.map(async file => {
    try { return await realpath(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
      const absolute = resolve(file); const parent = resolve(absolute, "..");
      return resolve(await realpath(parent), absolute.slice(parent.length + 1)); }
  }));
  if (new Set(paths).size !== paths.length || new Set(kinds.map(kind => settings.steps[kind].nonce)).size !== 3 ||
    kinds.some(kind => !/^(0|[1-9][0-9]*)$/.test(settings.steps[kind].nonce))) {
    throw new Error("Distinct registration journals and nonces required");
  }
  await verifyDeployments(settings, ports);
  // Reconcile ALL prior step journals, including steps already reflected by finalized registry state.
  // Never advance past an unknown/reverted transaction merely because contract state changed externally.
  const initial = nextRegistrationStep(await ports.snapshot(settings), settings);
  for (const kind of kinds) {
    let record: EvmJournalRecord;
    try { record = await ports.read(settings.steps[kind].journalFile); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { continue; } throw error; }
    if (record.phase === "signed" && initial.kind !== kind) { throw new Error("Signed step prerequisites changed"); }
    const to = kind === "register-admin" ? "0xa3c796d480638d7476792230da1e2ada86e031b0" : "0x95f29fee11c5c55d26cccf1db6772de953b37b82";
    const data = ({ "register-admin": "0xff12c354", "accept-admin": "0x156194da", "set-pool": "0x4e847fc7" })[kind] +
      settings.token.slice(2).toLowerCase().padStart(64, "0") + (kind === "set-pool" ? settings.pool.slice(2).toLowerCase().padStart(64, "0") : "");
    const intent = { chainId: "11155111", kind: "call" as const, from: settings.administrator,
      to, data, value: "0", nonce: settings.steps[kind].nonce };
    // execute validates the complete stored intent/signature and never retries an uncertain submission.
    if (!record.signed?.hash) { throw new Error("Invalid registration journal"); }
    const result = await ports.execute(intent, { signer: settings.signer, journalFile: settings.steps[kind].journalFile });
    if (result.status !== "succeeded") { return { ...result, step: kind }; }
  }
  const next = nextRegistrationStep(await ports.snapshot(settings), settings);
  if (next.kind === "complete") { return { status: "succeeded", reason: "finalized-registry-pool-match" }; }
  const result = await ports.execute({ chainId: next.chainId, kind: "call", from: next.from, to: next.to,
    value: next.value, data: next.data, nonce: settings.steps[next.kind].nonce },
  { signer: settings.signer, journalFile: settings.steps[next.kind].journalFile });
  return { ...result, step: next.kind };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) { throw new Error("Usage: register-token.ts <private-test-settings.json>"); }
    console.log(JSON.stringify(await registerTestToken(JSON.parse(await readFile(resolve(process.argv[2]!), "utf8")))));
  } catch (error) { console.error(error instanceof Error ? error.message : "Registration failed"); process.exitCode = 1; }
}
