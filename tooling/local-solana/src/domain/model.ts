export const CLASSIC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
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

export type LifecycleKind = "create" | "revokeFreeze" | "mint" | "burn" | "restoreFreezeAttempt" | "freezeAttempt";

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

export interface TransactionFact {
  readonly kind: LifecycleKind;
  readonly signature: string;
  readonly slot: string;
  readonly confirmationStatus: "finalized";
  readonly err: unknown;
  readonly programIds: readonly string[];
  readonly instructionKinds: readonly string[];
  readonly amountBaseUnits: string | null;
  readonly genesisHash: string;
}

export interface FixtureObservations {
  readonly schemaVersion: 1;
  readonly rpcUrl: string;
  readonly genesisHashBefore: string;
  readonly genesisHashAfter: string;
  readonly validatorVersion: string;
  readonly mintAddress: string;
  readonly mintAuthority: string;
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
  readonly mintAuthority: string;
  readonly genesisHash: string;
  readonly validatorVersion: string;
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

export function parseUnsignedInteger(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new LocalSolanaError("SOLANA_INTEGER_INVALID", `${label} must be a canonical decimal string`);
  }
  return BigInt(value);
}

export function parseAccountState(value: unknown, address: string): AccountState {
  const root = object(value, "mint account");
  const owner = string(root.owner, "mint account owner");
  if (owner !== CLASSIC_TOKEN_PROGRAM) { throw new LocalSolanaError("SOLANA_MINT_PROGRAM", "mint is not owned by classic Token Program"); }
  const data = object(root.data, "mint account data");
  const parsed = object(data.parsed, "mint parsed data");
  if (parsed.type !== "mint") { throw new LocalSolanaError("SOLANA_MINT_TYPE", "account is not a parsed mint"); }
  const info = object(parsed.info, "mint info");
  const decimals = integer(info.decimals, "mint decimals");
  const supply = canonicalInteger(info.supply, "mint supply");
  return {
    address,
    programOwner: owner,
    decimals,
    supply,
    mintAuthority: nullableString(info.mintAuthority, "mint authority"),
    freezeAuthority: nullableString(info.freezeAuthority, "freeze authority"),
  };
}

export function parseTokenAccountState(value: unknown, address: string): TokenAccountState {
  const root = object(value, "token account");
  if (root.owner !== CLASSIC_TOKEN_PROGRAM) { throw new LocalSolanaError("SOLANA_TOKEN_ACCOUNT_PROGRAM", "token account is not owned by classic Token Program"); }
  const parsed = object(object(root.data, "token account data").parsed, "token account parsed data");
  if (parsed.type !== "account") { throw new LocalSolanaError("SOLANA_TOKEN_ACCOUNT_TYPE", "account is not parsed token state"); }
  const info = object(parsed.info, "token account info");
  const tokenAmount = object(info.tokenAmount, "token amount");
  return {
    address,
    mint: string(info.mint, "token mint"),
    owner: string(info.owner, "token owner"),
    amount: canonicalInteger(tokenAmount.amount, "token amount"),
  };
}

export function assertLoopbackRpcUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new LocalSolanaError("SOLANA_RPC_URL", "RPC URL is invalid"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new LocalSolanaError("SOLANA_RPC_NON_LOOPBACK", "RPC must be exact http://127.0.0.1:<port>/ with no credentials or redirect surface");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { throw new LocalSolanaError("SOLANA_RPC_PORT", "RPC port is outside the private fixture range"); }
  return url;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { throw new LocalSolanaError("SOLANA_JSON_SHAPE", `${label} must be an object`); }
  return value as Record<string, unknown>;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) { throw new LocalSolanaError("SOLANA_JSON_STRING", `${label} must be a non-empty string`); }
  return value;
}

export function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) { throw new LocalSolanaError("SOLANA_JSON_INTEGER", `${label} must be a safe integer`); }
  return value;
}

function canonicalInteger(value: unknown, label: string): string { parseUnsignedInteger(value, label); return value as string; }
function nullableString(value: unknown, label: string): string | null { return value === null ? null : string(value, label); }
