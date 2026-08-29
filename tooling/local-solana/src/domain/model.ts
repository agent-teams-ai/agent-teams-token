export const CLASSIC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const FIXTURE_DECIMALS = 9;
export const FIXTURE_AMOUNT_BASE_UNITS = 1_000_000_000_000n;

export class LocalSolanaError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "LocalSolanaError";
  }
}

/** The exact, ordered transaction lifecycle published as v1 evidence. */
export const LIFECYCLE = ["createMint", "revokeFreeze", "createAta", "mint", "burn", "restoreFreezeAttempt", "freezeAttempt"] as const;
export type LifecycleKind = typeof LIFECYCLE[number];

export interface AccountState {
  readonly address: string;
  readonly programOwner: string;
  readonly decimals: number;
  readonly supply: string;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
}

export interface TokenAccountState {
  readonly address: string;
  readonly mint: string;
  readonly owner: string;
  readonly amount: string;
}

export interface TransactionErrorFact {
  readonly instructionIndex: number;
  readonly code: string;
}

/** Semantic instruction facts decoded by the RPC adapter, never supplied by the runner. */
export interface InstructionFact {
  readonly programId: string;
  readonly instructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly kind: string;
  readonly accounts: readonly string[];
  readonly mint: string | null;
  readonly tokenAccount: string | null;
  readonly owner: string | null;
  readonly authority: string | null;
  readonly newAuthority: string | null;
  readonly authorityType: string | null;
  readonly amountBaseUnits: string | null;
  readonly decimals: number | null;
}

export interface TransactionFact {
  readonly operation: LifecycleKind;
  readonly signature: string;
  readonly slot: string;
  readonly confirmationStatus: "finalized";
  readonly error: TransactionErrorFact | null;
  readonly signers: readonly string[];
  readonly instructions: readonly InstructionFact[];
  readonly genesisHash: string;
}

export interface FixtureObservations {
  readonly schemaVersion: 1;
  readonly rpcUrl: string;
  readonly genesisHashBefore: string;
  readonly genesisHashAfter: string;
  readonly validatorVersion: string;
  readonly payerAddress: string;
  readonly mintAddress: string;
  readonly mintAuthority: string;
  readonly freezeAuthority: string;
  readonly ownerAddress: string;
  readonly tokenAccountAddress: string;
  readonly initialMint: AccountState;
  readonly afterRevokeMint: AccountState;
  readonly afterMint: AccountState;
  readonly afterMintTokenAccount: TokenAccountState;
  readonly finalMint: AccountState;
  readonly finalTokenAccount: TokenAccountState;
  readonly transactions: readonly TransactionFact[];
}

export interface EvidenceReport {
  readonly schemaVersion: 1;
  readonly status: "READY";
  readonly identity: { readonly name: "Agent Teams AI"; readonly symbol: "AGTMAI" };
  readonly programId: typeof CLASSIC_TOKEN_PROGRAM;
  readonly decimals: 9;
  readonly testAmountBaseUnits: string;
  readonly initialSupply: "0";
  readonly intermediateSupply: string;
  readonly finalSupply: "0";
  readonly freezeAuthority: null;
  readonly payerAddress: string;
  readonly mintAddress: string;
  readonly tokenAccountAddress: string;
  readonly ownerAddress: string;
  readonly mintAuthority: string;
  readonly formerFreezeAuthority: string;
  readonly genesisHash: string;
  readonly validatorVersion: string;
  readonly snapshots: {
    readonly initialMint: AccountState;
    readonly afterRevokeMint: AccountState;
    readonly afterMint: AccountState;
    readonly afterMintTokenAccount: TokenAccountState;
    readonly finalMint: AccountState;
    readonly finalTokenAccount: TokenAccountState;
  };
  readonly transactions: readonly TransactionFact[];
  readonly assertions: {
    readonly productionAuthorityProven: false;
    readonly ccip: false;
    readonly publicNetwork: false;
    readonly realAssetCostUsd: 0;
    readonly mintAuthorityRevoked: false;
    readonly authorityKeyRetained: false;
    readonly remintPossibleUntilTeardown: true;
    readonly productionHardCapProven: false;
    readonly signedRestoreReachedTokenProgramAndFailed: true;
    readonly signedFreezeReachedTokenProgramAndFailed: true;
  };
}

export const FAILURE_PHASES = [
  "createMint", "revokeFreeze", "createAta", "mint", "burn",
  "restoreFreezeAttempt", "freezeAttempt", "verification",
] as const;
export type FailurePhase = typeof FAILURE_PHASES[number];

/** Sanitized terminal evidence emitted only after a mutation may have started. */
export interface FailureEvidenceReport {
  readonly schemaVersion: 1;
  readonly status: "FAILED";
  readonly failedPhase: FailurePhase;
  readonly diagnosticCode: string;
  readonly mutationsMayHaveOccurred: true;
  readonly cleanupCompleted: boolean;
  readonly publicNetwork: false;
  readonly realAssetCostUsd: 0;
  readonly secretsRetained: boolean;
  readonly productionApproved: false;
}

export function parseUnsignedInteger(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new LocalSolanaError("SOLANA_INTEGER_INVALID", `${label} must be a canonical decimal string`);
  }
  return BigInt(value);
}
