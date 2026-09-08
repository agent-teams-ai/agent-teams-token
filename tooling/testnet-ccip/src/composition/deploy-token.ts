import { executeSepoliaIntent } from "./execute-sepolia.ts";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CastSignerConfig } from "../adapters/evm-cast.ts";
import type { SepoliaIntentInput } from "../domain/evm-intent.ts";

export interface TokenDeploymentSettings {
  readonly testOnly: true;
  readonly administrator: string;
  readonly nonce: string;
  readonly artifactFile: string;
  readonly artifactSha256: string;
  readonly journalFile: string;
  readonly signer: CastSignerConfig;
}
const TEST_SUPPLY = 100_000_000_000n;
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
/** Explicit test fixture: 100 AGTMAI to the isolated test administrator, not production allocations. */
export function testTokenConstructor(administrator: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(administrator) || /^0x0+$/.test(administrator)) {
    throw new Error("Invalid test administrator");
  }
  const addressWord = administrator.slice(2).toLowerCase().padStart(64, "0");
  return "0x" + [word(TEST_SUPPLY), word(96n), addressWord, word(1n), word(1n), addressWord, word(TEST_SUPPLY)].join("");
}

export async function deployTestToken(settings: TokenDeploymentSettings): Promise<{
  status: string; reason: string; transactionHash: string;
}> {
  if (settings.testOnly !== true || settings.signer.testOnly !== true ||
    !/^[0-9a-f]{64}$/.test(settings.artifactSha256)) { throw new Error("Test-only settings required"); }
  const artifactBytes = await readFile(settings.artifactFile);
  if (createHash("sha256").update(artifactBytes).digest("hex") !== settings.artifactSha256) {
    throw new Error("Token artifact hash mismatch");
  }
  const artifact = JSON.parse(artifactBytes.toString("utf8")) as { bytecode: { object: string } };
  const bytecode = artifact.bytecode.object;
  if (!/^0x(?:[a-fA-F0-9]{2})+$/.test(bytecode)) { throw new Error("Invalid token creation bytecode"); }
  const constructorBytes = testTokenConstructor(settings.administrator);
  const intent: SepoliaIntentInput = {
    chainId: "11155111", kind: "deploy", from: settings.administrator, nonce: settings.nonce,
    value: "0", data: bytecode + constructorBytes.slice(2), deployment: {
      artifactId: "AGTMAICCIPToken", artifactSha256: settings.artifactSha256,
      creationBytecode: bytecode, constructorBytes, administrator: settings.administrator,
      administratorBinding: "constructor-word-2",
    },
  };
  return executeSepoliaIntent(intent, settings);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) { throw new Error("Usage: deploy-token.ts <private-test-settings.json>"); }
    const settings = JSON.parse(await readFile(resolve(process.argv[2]!), "utf8")) as TokenDeploymentSettings;
    console.log(JSON.stringify(await deployTestToken(settings)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Token deployment failed");
    process.exitCode = 1;
  }
}
