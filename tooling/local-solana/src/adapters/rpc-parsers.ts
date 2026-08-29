import { ASSOCIATED_TOKEN_PROGRAM, CLASSIC_TOKEN_PROGRAM, LIFECYCLE, LocalSolanaError, type AccountState, type InstructionFact, type LifecycleKind, type TokenAccountState, type TransactionErrorFact, type TransactionFact } from "../domain/model.ts";

export function parseAccountState(value: unknown, address: string): AccountState {
  const root = object(value, "mint account");
  const owner = string(root.owner, "mint account owner");
  if (owner !== CLASSIC_TOKEN_PROGRAM) { throw new LocalSolanaError("SOLANA_MINT_PROGRAM", "mint is not owned by classic Token Program"); }
  const parsed = object(object(root.data, "mint account data").parsed, "mint parsed data");
  if (parsed.type !== "mint") { throw new LocalSolanaError("SOLANA_MINT_TYPE", "account is not a parsed mint"); }
  const info = object(parsed.info, "mint info");
  return { address, programOwner: owner, decimals: integer(info.decimals, "mint decimals"), supply: canonicalInteger(info.supply, "mint supply"), mintAuthority: nullableString(info.mintAuthority, "mint authority"), freezeAuthority: nullableString(info.freezeAuthority, "freeze authority") };
}

export function parseTokenAccountState(value: unknown, address: string): TokenAccountState {
  const root = object(value, "token account");
  if (root.owner !== CLASSIC_TOKEN_PROGRAM) { throw new LocalSolanaError("SOLANA_TOKEN_ACCOUNT_PROGRAM", "token account is not owned by classic Token Program"); }
  const parsed = object(object(root.data, "token account data").parsed, "token account parsed data");
  if (parsed.type !== "account") { throw new LocalSolanaError("SOLANA_TOKEN_ACCOUNT_TYPE", "account is not parsed token state"); }
  const info = object(parsed.info, "token account info");
  return { address, mint: string(info.mint, "token mint"), owner: string(info.owner, "token owner"), amount: canonicalInteger(object(info.tokenAmount, "token amount").amount, "token amount") };
}

export function parseFinalizedTransaction(raw: unknown, signature: string, genesisHash: string): TransactionFact {
  if (raw === null) { throw new LocalSolanaError("SOLANA_TRANSACTION_MISSING", "finalized transaction is missing"); }
  const tx = object(raw, "transaction");
  const meta = object(tx.meta, "transaction meta");
  const message = object(object(tx.transaction, "transaction envelope").message, "transaction message");
  const accountKeys = array(message.accountKeys, "transaction account keys");
  const signers = accountKeys.filter((entry) => object(entry, "account key").signer === true).map((entry) => string(object(entry, "account key").pubkey, "signer pubkey"));
  const outer = array(message.instructions, "transaction instructions").map((entry, index) => decodeInstruction(entry, index, null));
  const inner = meta.innerInstructions === null ? [] : array(meta.innerInstructions, "inner instruction groups").flatMap((group) => {
    const parsed = object(group, "inner instruction group"); const outerIndex = integer(parsed.index, "inner outer index");
    return array(parsed.instructions, "inner instructions").map((entry, innerIndex) => decodeInstruction(entry, outerIndex, innerIndex));
  });
  const instructions = [...outer, ...inner];
  const error = parseTransactionError(meta.err);
  const operation = deriveOperation(instructions, error);
  return { operation, signature, slot: String(integer(tx.slot, "transaction slot")), confirmationStatus: "finalized", error, signers: unique(signers), instructions, genesisHash };
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
export function array(value: unknown, label: string): readonly unknown[] { if (!Array.isArray(value)) { throw new LocalSolanaError("SOLANA_JSON_ARRAY", `${label} must be an array`); } return value; }
export function string(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0) { throw new LocalSolanaError("SOLANA_JSON_STRING", `${label} must be a non-empty string`); } return value; }
export function integer(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) { throw new LocalSolanaError("SOLANA_JSON_INTEGER", `${label} must be a safe integer`); } return value; }

function decodeInstruction(value: unknown, instructionIndex: number, innerInstructionIndex: number | null): InstructionFact {
  const instruction = object(value, "instruction");
  const programId = string(instruction.programId, "instruction program ID");
  const rawAccounts = instruction.accounts === undefined ? [] : array(instruction.accounts, "instruction accounts").map((item) => string(item, "instruction account"));
  if (instruction.parsed === undefined) {
    return semantic(programId, instructionIndex, innerInstructionIndex, "raw", rawAccounts, {});
  }
  const parsed = object(instruction.parsed, "parsed instruction");
  const kind = string(parsed.type, "instruction type");
  const info = object(parsed.info, "instruction info");
  const tokenAmount = typeof info.tokenAmount === "object" && info.tokenAmount !== null ? object(info.tokenAmount, "instruction token amount").amount : undefined;
  const amount = info.amount ?? tokenAmount;
  const accounts = rawAccounts.length > 0 ? rawAccounts : semanticAccounts(info);
  const account = kind === "setAuthority" ? info.account ?? info.mint : info.account;
  const authority = info.authority ?? info.mintAuthority
    ?? (kind === "freezeAccount" ? info.freezeAuthority : undefined)
    ?? (programId === ASSOCIATED_TOKEN_PROGRAM ? info.source : undefined);
  const newAuthority = kind === "freezeAccount" ? undefined : info.newAuthority ?? info.freezeAuthority;
  return semantic(programId, instructionIndex, innerInstructionIndex, kind, accounts, {
    mint: optionalString(info.mint), tokenAccount: optionalString(account), owner: optionalString(info.owner ?? info.wallet),
    authority: optionalString(authority),
    newAuthority: info.newAuthority === null ? null : optionalString(newAuthority), authorityType: optionalString(info.authorityType),
    amountBaseUnits: amount === undefined ? null : canonicalInteger(amount, "instruction amount"), decimals: info.decimals === undefined ? null : integer(info.decimals, "instruction decimals"),
  });
}

function semantic(programId: string, instructionIndex: number, innerInstructionIndex: number | null, kind: string, accounts: readonly string[], partial: Partial<InstructionFact>): InstructionFact {
  return { programId, instructionIndex, innerInstructionIndex, kind, accounts, mint: null, tokenAccount: null, owner: null, authority: null, newAuthority: null, authorityType: null, amountBaseUnits: null, decimals: null, ...partial };
}

function semanticAccounts(info: Record<string, unknown>): readonly string[] {
  const result: string[] = [];
  for (const key of ["source", "account", "wallet", "mint", "owner", "authority", "mintAuthority", "freezeAuthority", "newAuthority", "systemProgram", "tokenProgram"]) {
    const value = info[key]; if (typeof value === "string" && !result.includes(value)) { result.push(value); }
  }
  return result;
}

function deriveOperation(instructions: readonly InstructionFact[], error: TransactionErrorFact | null): LifecycleKind {
  const token = instructions.filter((item) => item.programId === CLASSIC_TOKEN_PROGRAM);
  const ata = instructions.filter((item) => item.programId === ASSOCIATED_TOKEN_PROGRAM);
  let result: LifecycleKind | undefined;
  if (token.some((item) => item.kind === "initializeMint" || item.kind === "initializeMint2")) { result = "createMint"; }
  else if (ata.length === 1 && error === null) { result = "createAta"; }
  else if (token.length === 1) {
    const item = token[0] as InstructionFact;
    if (item.kind === "setAuthority" && item.authorityType === "freezeAccount") { result = item.newAuthority === null ? "revokeFreeze" : "restoreFreezeAttempt"; }
    else if (item.kind === "mintTo" || item.kind === "mintToChecked") { result = "mint"; }
    else if (item.kind === "burn" || item.kind === "burnChecked") { result = "burn"; }
    else if (item.kind === "freezeAccount") { result = "freezeAttempt"; }
  }
  if (result === undefined || !LIFECYCLE.includes(result)) { throw new LocalSolanaError("SOLANA_TRANSACTION_SEMANTICS", "transaction does not contain exactly one recognized lifecycle operation"); }
  return result;
}

function parseTransactionError(value: unknown): TransactionErrorFact | null {
  if (value === null) { return null; }
  const root = object(value, "transaction error");
  const instructionError = array(root.InstructionError, "instruction error");
  if (instructionError.length !== 2) { throw new LocalSolanaError("SOLANA_TRANSACTION_ERROR", "transaction error must identify one instruction"); }
  const instructionIndex = integer(instructionError[0], "failed instruction index");
  const rawCode = instructionError[1];
  const code = typeof rawCode === "string" ? rawCode : (() => { const custom = object(rawCode, "custom instruction error").Custom; return `Custom(${integer(custom, "custom instruction error code")})`; })();
  return { instructionIndex, code };
}

function optionalString(value: unknown): string | null { return value === undefined || value === null ? null : string(value, "instruction semantic address"); }
function nullableString(value: unknown, label: string): string | null { return value === null ? null : string(value, label); }
function canonicalInteger(value: unknown, label: string): string { if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) { throw new LocalSolanaError("SOLANA_INTEGER_INVALID", `${label} must be a canonical decimal string`); } return value; }
function unique(values: readonly string[]): readonly string[] { return [...new Set(values)]; }
