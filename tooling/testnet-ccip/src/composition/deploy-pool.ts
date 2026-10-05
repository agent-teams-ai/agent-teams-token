import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deployTestToken } from "./deploy-token.ts";
import type { TokenDeploymentSettings } from "./deploy-token.ts";
import type { EvmJournalRecord } from "../application/evm-journal.ts";
import { executeSepoliaIntent } from "./execute-sepolia.ts";
import { lockReleaseConstructor } from "../domain/evm-pool.ts";
import type { CastSignerConfig } from "../adapters/evm-cast.ts";
import { createTestRpcRequest, selectSepoliaRpc } from "../adapters/test-rpc.ts";
import type { TestRpcSettings } from "../adapters/test-rpc.ts";
export interface PoolDeploymentSettings extends TestRpcSettings {
  readonly testOnly: true; readonly tokenSettingsFile: string;
  readonly artifactFile: string; readonly journalFile: string; readonly nonce: string;
  readonly signer: CastSignerConfig;
}
const ARTIFACT_HASH = "82dac8896b84a7abe909e076a4de830258e19f5aae50f48ce17cfe8305f74114";
/** The accepted testnet pool artifact, authenticated before its bytecode is used. */
export async function loadOfficialPoolArtifact(artifactFile: string): Promise<{
  artifactSha256: string; creationBytecode: string;
}> {
  const artifactBytes = await readFile(artifactFile);
  if (createHash("sha256").update(artifactBytes).digest("hex") !== ARTIFACT_HASH) { throw new Error("Official pool artifact mismatch"); }
  const artifact = JSON.parse(artifactBytes.toString("utf8")) as { bytecode: { object: string } };
  const creationBytecode = artifact.bytecode.object;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(creationBytecode)) { throw new Error("Invalid official pool bytecode"); }
  return { artifactSha256: ARTIFACT_HASH, creationBytecode };
}
export async function deployTestPool(settings: PoolDeploymentSettings): Promise<{
  status: string; reason: string; transactionHash: string;
}> {
  const endpoint = selectSepoliaRpc(settings);
  if (settings.testOnly !== true || settings.signer.testOnly !== true) { throw new Error("Test-only pool required"); }
  const storedSettings = JSON.parse(await readFile(settings.tokenSettingsFile, "utf8")) as TokenDeploymentSettings;
  if (storedSettings.sepoliaRpc !== undefined && selectSepoliaRpc(storedSettings) !== endpoint) {
    throw new Error("Conflicting token/pool TEST RPC selection");
  }
  const tokenSettings = { ...storedSettings, sepoliaRpc: endpoint };
  // Never start pool deployment while token deployment is unresolved, reverted, or absent.
  // deployTestToken reconciles its existing journal; an absent journal must not be started here.
  const tokenRecord = JSON.parse(await readFile(tokenSettings.journalFile, "utf8")) as EvmJournalRecord;
  if (!tokenRecord || !tokenRecord.signed?.hash) { throw new Error("Token transaction journal required"); }
  const result = await deployTestToken(tokenSettings);
  if (result.status !== "succeeded") { throw new Error("Token deployment is not finalized successfully"); }
  const confirmed = JSON.parse(await readFile(tokenSettings.journalFile, "utf8")) as EvmJournalRecord;
  const receipt = await createTestRpcRequest(endpoint)("eth_getTransactionReceipt", [result.transactionHash]) as {
    transactionHash: string; blockHash: string; status: string; contractAddress: string;
  } | null;
  if (!receipt ||
    receipt.status !== "0x1" || receipt.transactionHash !== result.transactionHash ||
    receipt.blockHash !== confirmed.receipt?.blockHash || !/^0x[0-9a-fA-F]{40}$/.test(receipt.contractAddress)) {
    throw new Error("Confirmed token address unavailable");
  }
  const { creationBytecode } = await loadOfficialPoolArtifact(settings.artifactFile);
  const constructorBytes = lockReleaseConstructor(receipt.contractAddress);
  return executeSepoliaIntent({ chainId: "11155111", kind: "deploy", from: tokenSettings.administrator,
    nonce: settings.nonce, value: "0", data: creationBytecode + constructorBytes.slice(2), deployment: {
      artifactId: "@chainlink/contracts-ccip@1.6.1/LockReleaseTokenPool", artifactSha256: ARTIFACT_HASH,
      creationBytecode, constructorBytes, administrator: tokenSettings.administrator, administratorBinding: "sender",
    } }, settings);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) { throw new Error("Usage: deploy-pool.ts <private-test-settings.json>"); }
    console.log(JSON.stringify(await deployTestPool(JSON.parse(await readFile(resolve(process.argv[2]!), "utf8")))));
  } catch (error) { console.error(error instanceof Error ? error.message : "Pool deployment failed"); process.exitCode = 1; }
}
