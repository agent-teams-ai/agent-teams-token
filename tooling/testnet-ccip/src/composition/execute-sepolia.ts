import { bindFixture } from "../adapters/fixture-binding.ts";
import type { FixtureSelection } from "../domain/replacement-fixture.ts";
import { createCastSigner } from "../adapters/evm-cast.ts";
import type { CastSignerConfig } from "../adapters/evm-cast.ts";
import { createJournalFile } from "../adapters/evm-journal-file.ts";
import { createSepoliaRpc } from "../adapters/evm-rpc.ts";
import { createTestRpcRequest, selectSepoliaRpc } from "../adapters/test-rpc.ts";
import type { TestRpcSettings } from "../adapters/test-rpc.ts";
import { runEvmJournal } from "../application/evm-journal.ts";
import type { EvmJournalPorts } from "../application/evm-journal.ts";
import type { SepoliaIntentInput } from "../domain/evm-intent.ts";
import type { EvmRpcDiagnostic } from "../application/evm-rpc-diagnostic.ts";
export interface SepoliaExecutionResult {
  readonly status: string; readonly reason: string; readonly transactionHash: string;
  readonly diagnostic?: EvmRpcDiagnostic;
}
export interface SepoliaExecutionIo {
  signer(config: CastSignerConfig): Pick<EvmJournalPorts, "sign" | "inspectSigned">;
  journal(path: string): Pick<EvmJournalPorts, "read" | "write" | "exclusive">;
  fetcher: typeof fetch;
}
export async function executeSepoliaIntent(intent: SepoliaIntentInput, settings: FixtureSelection & TestRpcSettings & {
  readonly signer: CastSignerConfig; readonly journalFile: string;
}, io: SepoliaExecutionIo = { signer: createCastSigner, journal: createJournalFile, fetcher: globalThis.fetch }): Promise<SepoliaExecutionResult> {
  const endpoint = selectSepoliaRpc(settings), readRpc = createTestRpcRequest(endpoint, io.fetcher);
  const fixture = bindFixture({ ...settings, testOnly: settings.signer.testOnly }, [settings.journalFile]);
  if (fixture && (intent.chainId !== fixture.chainId || intent.from.toLowerCase() !== fixture.administrator)) {
    throw new Error("Wrong replacement execution chain/authority");
  }
  const signer = io.signer(settings.signer);
  const rpc = createSepoliaRpc(endpoint, io.fetcher);
  const store = io.journal(settings.journalFile);
  const result = await runEvmJournal(intent, intent, {
    ...store, ...rpc, ...signer,
    async sign(envelope) {
      // Only a new journal needs nonce/funding preflight; restart observes its saved signature.
      async function quantity(method: string, params: string[]): Promise<bigint> {
        const value = await readRpc(method, params);
        if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) || BigInt(value) >= 1n << 256n) {
          throw new Error("Sepolia funding/nonce preflight unavailable");
        }
        return BigInt(value);
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
  const diagnostic = rpc.diagnostic();
  return { status: result.status, reason: result.reason, transactionHash: result.record.signed.hash,
    ...(diagnostic === undefined ? {} : { diagnostic }) };
}
