import { createCastSigner } from "../adapters/evm-cast.ts";
import type { CastSignerConfig } from "../adapters/evm-cast.ts";
import { createJournalFile } from "../adapters/evm-journal-file.ts";
import { createSepoliaRpc } from "../adapters/evm-rpc.ts";
import { runEvmJournal } from "../application/evm-journal.ts";
import type { SepoliaIntentInput } from "../domain/evm-intent.ts";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export async function executeSepoliaIntent(intent: SepoliaIntentInput, settings: {
  readonly signer: CastSignerConfig; readonly journalFile: string;
}): Promise<{ status: string; reason: string; transactionHash: string }> {
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
        BigInt(envelope.value) + BigInt(settings.signer.gasLimit) * BigInt(settings.signer.maxFeePerGas)) {
        throw new Error("Test address needs faucet ETH before token deployment");
      }
      return signer.sign(envelope);
    },
  });
  return { status: result.status, reason: result.reason, transactionHash: result.record.signed.hash };
}
