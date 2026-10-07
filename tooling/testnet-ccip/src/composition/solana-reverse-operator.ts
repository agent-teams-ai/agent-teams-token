import { createSolanaReverseSdk, createSolanaReverseOperatorAttempt } from "../adapters/solana-reverse-sdk.mjs";
import type { ReverseSettings, ReverseExpectation } from "../adapters/solana-reverse-sdk.mjs";
import type { FixtureSettings } from "../adapters/fixture-binding.ts";
import type { TestKeys, PreparedTransaction } from "../adapters/solana-transaction-sdk.mjs";
import type { OperatorSignPrepared } from "../adapters/solana-setup-operator.ts";
import type { SolanaTransactionRecord } from "../application/solana-transaction-journal.ts";
import type { MintInstruction } from "../domain/solana-mint.ts";
import type { createJournalFile } from "../adapters/evm-journal-file.ts";
import type { createSolanaTransactionRpc } from "../adapters/solana-transaction-rpc.ts";
import { testKeys } from "./solana-setup-operator.ts";

export type ReverseTransferSettings = Partial<ReverseSettings> & FixtureSettings & {
  readonly journalFile: string; readonly maxNativeBalanceLamports: string; readonly payerFile?: string;
};
export interface ReverseEnvelope extends ReverseExpectation {
  readonly schema: "agtmai-solana-reverse-v1"; readonly instructions: readonly MintInstruction[];
}
export type ReverseRecord = SolanaTransactionRecord<ReverseEnvelope>;
export interface ReverseSourceState { readonly sourceReceiptVerified: true }
/** Finite composition port. Signing is an outer operator capability, never an SDK member. */
export interface ReversePorts {
  sdk(settings: ReverseTransferSettings): Promise<Awaited<ReturnType<typeof createSolanaReverseSdk>>>;
  // Existing JSON store is generic; specialize only this Solana caller. Shared EVM behavior is unchanged.
  store: typeof createJournalFile<ReverseRecord>;
  rpc: typeof createSolanaTransactionRpc<ReverseEnvelope, ReverseSourceState>;
  readonly signPrepared?: OperatorSignPrepared<ReverseExpectation>;
}

/** Injected legacy test ports may omit provider references; default SDK acquisition requires them. */
export function reverseSdkSettings(settings: ReverseTransferSettings): ReverseSettings {
  const { providerDirectory, ccipProviderDirectory, recentSlot } = settings;
  if (typeof providerDirectory !== "string" || !providerDirectory || typeof ccipProviderDirectory !== "string" ||
    !ccipProviderDirectory || typeof recentSlot !== "string" || !recentSlot) { throw new Error("Reverse SDK references required"); }
  return { ...settings, providerDirectory, ccipProviderDirectory, recentSlot };
}
export const openReverseSdk = (settings: ReverseTransferSettings) => createSolanaReverseSdk(reverseSdkSettings(settings));

/** Inert initializer. Capture TEST references only; one SDK acquisition owns the entire attempt. */
export function createReverseOperatorPorts(keys: TestKeys): Pick<ReversePorts, "sdk" | "signPrepared"> {
  const savedKeys = testKeys(keys);
  let attempt: Awaited<ReturnType<typeof createSolanaReverseOperatorAttempt>> | undefined, opened = false;
  return Object.freeze({
    async sdk(settings: ReverseTransferSettings) {
      if (opened) { throw new Error("Reverse operator ports already used"); }
      opened = true; attempt = await createSolanaReverseOperatorAttempt(reverseSdkSettings(settings)); return attempt.sdk;
    },
    signPrepared: (prepared: Readonly<PreparedTransaction>, expected: Readonly<ReverseExpectation>) => {
      if (!attempt) { throw new Error("Reverse operator attempt missing"); }
      return attempt.acquireSigner(savedKeys)(prepared, expected);
    },
  });
}

/** Await cleanup without discarding either an operation failure or a cleanup failure. */
export async function finishReverseSdk(sdk: Awaited<ReturnType<typeof createSolanaReverseSdk>>,
  operationFailed: boolean, operationError: unknown): Promise<void> {
  if (!('destroy' in sdk)) { return; }
  try { await sdk.destroy(); }
  catch (cleanupError) {
    if (operationFailed) {
      throw new AggregateError([operationError, cleanupError], 'Reverse operation and cleanup failed', {cause: cleanupError});
    }
    throw cleanupError;
  }
}
