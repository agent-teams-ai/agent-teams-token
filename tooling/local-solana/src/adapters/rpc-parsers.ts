import { ASSOCIATED_TOKEN_PROGRAM, CLASSIC_TOKEN_PROGRAM, LIFECYCLE, LocalSolanaError, isValidLoopbackPort, type AccountState, type InstructionFact, type LifecycleKind, type TokenAccountState, type TransactionErrorFact, type TransactionFact } from "../domain/model.ts";

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

export function parseFinalizedTransaction(parsedRaw: unknown, compiledRaw: unknown, signature: string, genesisHash: string): TransactionFact {
  if (parsedRaw === null || compiledRaw === null) { throw new LocalSolanaError("SOLANA_TRANSACTION_MISSING", "finalized transaction is missing"); }
  const parsedTx = object(parsedRaw, "parsed transaction");
  const compiledTx = object(compiledRaw, "compiled transaction");
  const parsedMeta = object(parsedTx.meta, "parsed transaction meta");
  const compiledMeta = object(compiledTx.meta, "compiled transaction meta");
  const parsedMessage = object(object(parsedTx.transaction, "parsed transaction envelope").message, "parsed transaction message");
  const compiledMessage = object(object(compiledTx.transaction, "compiled transaction envelope").message, "compiled transaction message");
  const parsedKeys = array(parsedMessage.accountKeys, "parsed transaction account keys");
  const accountKeys = array(compiledMessage.accountKeys, "compiled transaction account keys").map((entry) => string(entry, "compiled account key"));
  const parsedAddresses = parsedKeys.map((entry) => string(object(entry, "parsed account key").pubkey, "parsed account pubkey"));
  if (!sameStrings(parsedAddresses, accountKeys)) { throw new LocalSolanaError("SOLANA_TRANSACTION_RAW_BINDING", "parsed and compiled account keys differ"); }
  const signers = parsedKeys.filter((entry) => object(entry, "account key").signer === true).map((entry) => string(object(entry, "account key").pubkey, "signer pubkey"));
  const parsedOuter = array(parsedMessage.instructions, "parsed transaction instructions");
  const compiledOuter = array(compiledMessage.instructions, "compiled transaction instructions");
  if (parsedOuter.length !== compiledOuter.length) { throw new LocalSolanaError("SOLANA_TRANSACTION_RAW_BINDING", "parsed and compiled outer instruction counts differ"); }
  const outer = parsedOuter.map((entry, index) => decodeInstruction(entry, compiledOuter[index], accountKeys, index, null, null));
  const parsedGroups = parsedMeta.innerInstructions === null ? [] : array(parsedMeta.innerInstructions, "parsed inner instruction groups");
  const compiledGroups = compiledMeta.innerInstructions === null ? [] : array(compiledMeta.innerInstructions, "compiled inner instruction groups");
  if (parsedGroups.length !== compiledGroups.length) { throw new LocalSolanaError("SOLANA_TRANSACTION_RAW_BINDING", "parsed and compiled CPI group counts differ"); }
  const innerInstructionGroups = parsedGroups.map((entry, groupIndex) => {
    const parsedGroup = object(entry, "parsed inner instruction group");
    const compiledGroup = object(compiledGroups[groupIndex], "compiled inner instruction group");
    const outerInstructionIndex = integer(parsedGroup.index, "inner outer index");
    if (integer(compiledGroup.index, "compiled inner outer index") !== outerInstructionIndex) { throw new LocalSolanaError("SOLANA_TRANSACTION_RAW_BINDING", "parsed and compiled CPI groups differ"); }
    return { groupIndex, outerInstructionIndex };
  });
  const inner = parsedGroups.flatMap((entry, groupIndex) => {
    const parsedGroup = object(entry, "parsed inner instruction group");
    const compiledGroup = object(compiledGroups[groupIndex], "compiled inner instruction group");
    const outerIndex = integer(parsedGroup.index, "inner outer index");
    const parsedInstructions = array(parsedGroup.instructions, "parsed inner instructions");
    const compiledInstructions = array(compiledGroup.instructions, "compiled inner instructions");
    if (parsedInstructions.length !== compiledInstructions.length) { throw new LocalSolanaError("SOLANA_TRANSACTION_RAW_BINDING", "parsed and compiled CPI instruction counts differ"); }
    return parsedInstructions.map((item, innerIndex) => decodeInstruction(item, compiledInstructions[innerIndex], accountKeys, outerIndex, innerIndex, groupIndex));
  });
  const instructions = [...outer, ...inner];
  const error = parseTransactionError(parsedMeta.err);
  if (stableJson(parsedMeta.err) !== stableJson(compiledMeta.err) || parsedTx.slot !== compiledTx.slot) { throw new LocalSolanaError("SOLANA_TRANSACTION_RAW_BINDING", "parsed and compiled transaction results differ"); }
  const operation = deriveOperation(instructions, error);
  return { operation, signature, slot: String(integer(parsedTx.slot, "transaction slot")), confirmationStatus: "finalized", error, signers: unique(signers), accountKeys, instructions, innerInstructionGroups, genesisHash };
}

export function assertLoopbackRpcUrl(value: string): URL {
  // Validate serialized form first: WHATWG URL erases explicit default :80,
  // while this fixture boundary requires an explicit port and accepts :80.
  const serialized = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/$/u.exec(value);
  if (serialized === null) { throw new LocalSolanaError("SOLANA_RPC_NON_LOOPBACK", "RPC must be exact http://127.0.0.1:<port>/ with no credentials or redirect surface"); }
  let url: URL;
  try { url = new URL(value); } catch { throw new LocalSolanaError("SOLANA_RPC_URL", "RPC URL is invalid"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new LocalSolanaError("SOLANA_RPC_NON_LOOPBACK", "RPC must be exact http://127.0.0.1:<port>/ with no credentials or redirect surface");
  }
  const port = Number(serialized[1]);
  if (!isValidLoopbackPort(port)) { throw new LocalSolanaError("SOLANA_RPC_PORT", "RPC port is outside the private fixture range"); }
  return url;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { throw new LocalSolanaError("SOLANA_JSON_SHAPE", `${label} must be an object`); }
  return value as Record<string, unknown>;
}
export function array(value: unknown, label: string): readonly unknown[] { if (!Array.isArray(value)) { throw new LocalSolanaError("SOLANA_JSON_ARRAY", `${label} must be an array`); } return value; }
export function string(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0) { throw new LocalSolanaError("SOLANA_JSON_STRING", `${label} must be a non-empty string`); } return value; }
export function integer(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) { throw new LocalSolanaError("SOLANA_JSON_INTEGER", `${label} must be a safe integer`); } return value; }

function decodeInstruction(value: unknown, compiledValue: unknown, accountKeys: readonly string[], instructionIndex: number, innerInstructionIndex: number | null, innerGroupIndex: number | null): InstructionFact {
  const instruction = object(value, "parsed instruction");
  const compiled = object(compiledValue, "compiled instruction");
  const programIdIndex = integer(compiled.programIdIndex, "instruction program index");
  const programId = string(instruction.programId, "instruction program ID");
  if (accountKeys[programIdIndex] !== programId) { throw new LocalSolanaError("SOLANA_TRANSACTION_RAW_BINDING", "instruction program index does not resolve to parsed program"); }
  const accountIndices = array(compiled.accounts, "compiled instruction accounts").map((item) => integer(item, "compiled account index"));
  const compiledAccounts = accountIndices.map((index) => accountKeys[index] ?? (() => { throw new LocalSolanaError("SOLANA_TRANSACTION_RAW_BINDING", "compiled account index is out of range"); })());
  const parsedAccounts = instruction.accounts === undefined ? [] : array(instruction.accounts, "instruction accounts").map((item) => string(item, "instruction account"));
  const dataHex = Buffer.from(base58Bytes(string(compiled.data, "compiled instruction data"))).toString("hex");
  if (parsedAccounts.length > 0 && !sameStrings(parsedAccounts, compiledAccounts)) { throw new LocalSolanaError("SOLANA_TRANSACTION_RAW_BINDING", "instruction account indices do not resolve to parsed accounts"); }
  const location = { programId, programIdIndex, instructionIndex, innerInstructionIndex, innerGroupIndex, accounts: compiledAccounts, accountIndices, dataHex };
  if (instruction.parsed === undefined) { return semantic({ ...location, kind: "raw" }, {}); }
  const parsed = object(instruction.parsed, "parsed instruction");
  const kind = string(parsed.type, "instruction type");
  const info = object(parsed.info, "instruction info");
  const tokenAmount = typeof info.tokenAmount === "object" && info.tokenAmount !== null ? object(info.tokenAmount, "instruction token amount").amount : undefined;
  const amount = info.amount ?? tokenAmount;
  const account = kind === "setAuthority" ? info.account ?? info.mint : info.account;
  const authority = info.authority ?? info.mintAuthority
    ?? (kind === "freezeAccount" ? info.freezeAuthority : undefined)
    ?? (programId === ASSOCIATED_TOKEN_PROGRAM ? info.source : undefined);
  const newAuthority = kind === "freezeAccount" ? undefined : info.newAuthority ?? info.freezeAuthority;
  return semantic({ ...location, kind }, {
    mint: optionalString(info.mint), tokenAccount: optionalString(account), owner: optionalString(info.owner ?? info.wallet), newAccount: optionalString(info.newAccount),
    authority: optionalString(authority),
    newAuthority: info.newAuthority === null ? null : optionalString(newAuthority), authorityType: optionalString(info.authorityType),
    amountBaseUnits: amount === undefined ? null : canonicalInteger(amount, "instruction amount"), decimals: info.decimals === undefined ? null : integer(info.decimals, "instruction decimals"),
  });
}

type InstructionLocation = Pick<InstructionFact, "programId" | "programIdIndex" | "instructionIndex" | "innerInstructionIndex" | "innerGroupIndex" | "kind" | "accounts" | "accountIndices" | "dataHex">;

function semantic(location: InstructionLocation, partial: Partial<InstructionFact>): InstructionFact {
  return { ...location, mint: null, tokenAccount: null, owner: null, newAccount: null, authority: null, newAuthority: null, authorityType: null, amountBaseUnits: null, decimals: null, ...partial };
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function stableJson(value: unknown): string { return JSON.stringify(value); }
function base58Bytes(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if ([...value].some((character) => !alphabet.includes(character))) { throw new LocalSolanaError("SOLANA_TRANSACTION_RAW_DATA", "instruction data is not base58"); }
  let number = 0n; for (const character of value) { number = number * 58n + BigInt(alphabet.indexOf(character)); }
  const bytes: number[] = []; while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  for (const character of value) { if (character === "1") { bytes.unshift(0); } else { break; } }
  return Uint8Array.from(bytes);
}
