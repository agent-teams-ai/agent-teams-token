import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCastSigner } from "../adapters/evm-cast.ts";
import type { CastSignerConfig } from "../adapters/evm-cast.ts";
import { createJournalFile } from "../adapters/evm-journal-file.ts";
import { createSepoliaRpc } from "../adapters/evm-rpc.ts";
import { runEvmJournal } from "../application/evm-journal.ts";
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
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
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
  const signer = createCastSigner(settings.signer);
  const rpc = createSepoliaRpc(RPC);
  const store = createJournalFile(settings.journalFile);
  const result = await runEvmJournal(intent, intent, {
    ...store, ...rpc, ...signer,
    async sign(envelope) {
      // Only a new journal needs nonce/funding preflight; restart observes its saved signature.
      async function quantity(method: string, params: string[]): Promise<bigint> {
        const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          redirect: "error", signal: AbortSignal.timeout(20_000) });
        const body = await response.json() as { jsonrpc: string; id: number; error?: unknown; result?: string };
        if (!response.ok || body.jsonrpc !== "2.0" || body.id !== 1 || "error" in body ||
          !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(body.result ?? "")) {
          throw new Error("Sepolia funding/nonce preflight unavailable");
        }
        return BigInt(body.result!);
      }
      if (await quantity("eth_chainId", []) !== 11155111n) { throw new Error("Wrong deployment chain"); }
      if (await quantity("eth_getTransactionCount", [envelope.from, "pending"]) !== BigInt(envelope.nonce)) {
        throw new Error("Deployment nonce changed; reconcile before preparing another operation");
      }
      if (await quantity("eth_getBalance", [envelope.from, "latest"]) <
        BigInt(settings.signer.gasLimit) * BigInt(settings.signer.maxFeePerGas)) {
        throw new Error("Test address needs faucet ETH before token deployment");
      }
      return signer.sign(envelope);
    },
  });
  return { status: result.status, reason: result.reason, transactionHash: result.record.signed.hash };
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
