import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CLASSIC_TOKEN_PROGRAM, LocalSolanaError } from "../domain/model.ts";
import type { AuthorityTransactionContext, AuthorityTransactionPort } from "../application/ports.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export class Ed25519AuthorityTransactionAdapter implements AuthorityTransactionPort {
  public async restoreFreeze(request: AuthorityTransactionContext & { readonly mint: string; readonly newAuthority: string }): Promise<Uint8Array> {
    return await signedRestoreFreezeTransaction(request);
  }
  public async freezeAccount(request: AuthorityTransactionContext & { readonly account: string; readonly mint: string }): Promise<Uint8Array> {
    return await signedFreezeAccountTransaction(request);
  }
}

export async function signedRestoreFreezeTransaction(request: AuthorityTransactionContext & { readonly mint: string; readonly newAuthority: string }): Promise<Uint8Array> {
  const data = Uint8Array.from([6, 1, 1, ...base58Decode(request.newAuthority)]); // SetAuthority, FreezeAccount, Some(pubkey)
  return await signedTokenTransaction(request, { writableAccounts: [request.mint], readonlyFlags: [false], data });
}

export async function signedFreezeAccountTransaction(request: AuthorityTransactionContext & { readonly account: string; readonly mint: string }): Promise<Uint8Array> {
  return await signedTokenTransaction(request, { writableAccounts: [request.account, request.mint], readonlyFlags: [false, true], data: Uint8Array.from([10]) });
}

async function signedTokenTransaction(context: AuthorityTransactionContext, instructionRequest: { readonly writableAccounts: readonly string[]; readonly readonlyFlags: readonly boolean[]; readonly data: Uint8Array }): Promise<Uint8Array> {
  if (context.signal?.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "fixture interrupted"); }
  const payer = await keypair(context.payerPath); ensureActive(context.signal);
  const authority = await keypair(context.authorityPath); ensureActive(context.signal);
  if (instructionRequest.writableAccounts.length !== instructionRequest.readonlyFlags.length) {
    throw new LocalSolanaError("SOLANA_TRANSACTION_ACCOUNTS", "instruction account flags are inconsistent");
  }
  const instructionKeys = instructionRequest.writableAccounts.map(base58Decode);
  const programKey = base58Decode(CLASSIC_TOKEN_PROGRAM);
  const compiled = compileAccountKeys([
    { key: payer.publicKey, signer: true, writable: true, payer: true },
    { key: authority.publicKey, signer: true, writable: false },
    ...instructionKeys.map((key, index) => ({ key, signer: false, writable: !instructionRequest.readonlyFlags[index] })),
    { key: programKey, signer: false, writable: false },
  ]);
  const instructionAccounts = instructionKeys.map((key) => compiled.indexOf(key)).concat(compiled.indexOf(authority.publicKey));
  const instruction = concat([
    Uint8Array.from([compiled.indexOf(programKey)]), shortVec(instructionAccounts.length),
    Uint8Array.from(instructionAccounts), shortVec(instructionRequest.data.length), instructionRequest.data,
  ]);
  const message = concat([
    Uint8Array.from([compiled.requiredSignatures, compiled.readonlySigned, compiled.readonlyUnsigned]),
    shortVec(compiled.keys.length), ...compiled.keys,
    base58Decode(await context.rpc.latestBlockhash(context.rpcUrl, context.signal)), shortVec(1), instruction,
  ]);
  ensureActive(context.signal);
  const signatures = [ed25519Sign(message, payer.seed), ed25519Sign(message, authority.seed)];
  return concat([shortVec(signatures.length), ...signatures, message]);
}

interface RequestedAccount {
  readonly key: Uint8Array;
  readonly signer: boolean;
  readonly writable: boolean;
  readonly payer?: boolean;
}

interface CompiledAccountKeys {
  readonly keys: readonly Uint8Array[];
  readonly requiredSignatures: number;
  readonly readonlySigned: number;
  readonly readonlyUnsigned: number;
  indexOf(key: Uint8Array): number;
}

function compileAccountKeys(requested: readonly RequestedAccount[]): CompiledAccountKeys {
  const merged = new Map<string, { key: Uint8Array; signer: boolean; writable: boolean; payer: boolean; order: number }>();
  requested.forEach((account, order) => {
    const identity = Buffer.from(account.key).toString("hex");
    const current = merged.get(identity);
    if (current === undefined) {
      merged.set(identity, { ...account, payer: account.payer === true, order });
    } else {
      current.signer ||= account.signer;
      current.writable ||= account.writable;
      current.payer ||= account.payer === true;
    }
  });
  const payer = [...merged.values()].filter(({ payer: value }) => value);
  if (payer.length !== 1 || !payer[0]!.signer || !payer[0]!.writable) {
    throw new LocalSolanaError("SOLANA_TRANSACTION_PAYER", "transaction requires one writable signer payer");
  }
  const ordered = [
    payer[0]!,
    ...[...merged.values()].filter(({ payer: value }) => !value).toSorted((left, right) =>
      accountCategory(left) - accountCategory(right) || left.order - right.order),
  ];
  const indexes = new Map(ordered.map((account, index) => [Buffer.from(account.key).toString("hex"), index]));
  return {
    keys: ordered.map(({ key }) => key),
    requiredSignatures: ordered.filter(({ signer }) => signer).length,
    readonlySigned: ordered.filter(({ signer, writable }) => signer && !writable).length,
    readonlyUnsigned: ordered.filter(({ signer, writable }) => !signer && !writable).length,
    indexOf: (key) => {
      const index = indexes.get(Buffer.from(key).toString("hex"));
      if (index === undefined) { throw new LocalSolanaError("SOLANA_TRANSACTION_ACCOUNT_INDEX", "instruction account is missing from the compiled message"); }
      return index;
    },
  };
}

function accountCategory(account: { readonly signer: boolean; readonly writable: boolean }): number {
  return account.signer ? (account.writable ? 0 : 1) : (account.writable ? 2 : 3);
}

async function keypair(path: string): Promise<{ readonly seed: Uint8Array; readonly publicKey: Uint8Array }> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { throw new LocalSolanaError("SOLANA_KEYPAIR_READ", "ephemeral keypair cannot be read"); }
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
    throw new LocalSolanaError("SOLANA_KEYPAIR_SHAPE", "ephemeral keypair shape is invalid");
  }
  const bytes = Uint8Array.from(parsed as number[]);
  return { seed: bytes.slice(0, 32), publicKey: bytes.slice(32) };
}

function ed25519Sign(message: Uint8Array, seed: Uint8Array): Uint8Array {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  return sign(null, message, key);
}

export function base58Decode(value: string): Uint8Array {
  if (!value || [...value].some((character) => !ALPHABET.includes(character))) { throw new LocalSolanaError("SOLANA_BASE58", "invalid base58 value"); }
  let number = 0n;
  for (const character of value) { number = number * 58n + BigInt(ALPHABET.indexOf(character)); }
  const bytes: number[] = [];
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  for (const character of value) { if (character === "1") { bytes.unshift(0); } else { break; } }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let number = 0n;
  for (const byte of bytes) { number = (number << 8n) + BigInt(byte); }
  let result = "";
  while (number > 0n) { result = ALPHABET[Number(number % 58n)] + result; number /= 58n; }
  for (const byte of bytes) { if (byte === 0) { result = `1${result}`; } else { break; } }
  return result || "1";
}

function shortVec(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do { let byte = remaining & 0x7f; remaining >>>= 7; if (remaining > 0) { byte |= 0x80; } bytes.push(byte); } while (remaining > 0);
  return Uint8Array.from(bytes);
}
function concat(parts: readonly Uint8Array[]): Uint8Array { const size = parts.reduce((sum, part) => sum + part.length, 0); const result = new Uint8Array(size); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }

function ensureActive(signal: AbortSignal): void { if (signal?.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "fixture interrupted"); } }
