import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CLASSIC_TOKEN_PROGRAM, LocalSolanaError } from "../domain/model.ts";
import type { AuthorityTransactionPort, RpcPort } from "../application/ports.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export class Ed25519AuthorityTransactionAdapter implements AuthorityTransactionPort {
  public async restoreFreeze(rpc: RpcPort, rpcUrl: string, payerPath: string, authorityPath: string, mint: string, newAuthority: string): Promise<Uint8Array> {
    return await signedRestoreFreezeTransaction(rpc, rpcUrl, payerPath, authorityPath, mint, newAuthority);
  }
  public async freezeAccount(rpc: RpcPort, rpcUrl: string, payerPath: string, authorityPath: string, account: string, mint: string, authority: string): Promise<Uint8Array> {
    return await signedFreezeAccountTransaction(rpc, rpcUrl, payerPath, authorityPath, account, mint, authority);
  }
}

export async function signedRestoreFreezeTransaction(rpc: RpcPort, rpcUrl: string, payerPath: string, authorityPath: string, mint: string, newAuthority: string): Promise<Uint8Array> {
  const data = Uint8Array.from([6, 1, 1, ...base58Decode(newAuthority)]); // SetAuthority, FreezeAccount, Some(pubkey)
  return await signedTokenTransaction(rpc, rpcUrl, payerPath, authorityPath, [mint], [false], data);
}

export async function signedFreezeAccountTransaction(rpc: RpcPort, rpcUrl: string, payerPath: string, authorityPath: string, account: string, mint: string, authority: string): Promise<Uint8Array> {
  void authority;
  return await signedTokenTransaction(rpc, rpcUrl, payerPath, authorityPath, [account, mint], [false, true], Uint8Array.from([10]));
}

async function signedTokenTransaction(rpc: RpcPort, rpcUrl: string, payerPath: string, authorityPath: string, writableAccounts: readonly string[], readonlyFlags: readonly boolean[], data: Uint8Array): Promise<Uint8Array> {
  const payer = await keypair(payerPath);
  const authority = await keypair(authorityPath);
  const accounts = [payer.publicKey, authority.publicKey, ...writableAccounts.map(base58Decode), base58Decode(CLASSIC_TOKEN_PROGRAM)];
  const readonlyUnsigned = 1 + readonlyFlags.filter(Boolean).length;
  const instructionAccounts = writableAccounts.map((_unused, index) => index + 2).concat(1);
  const instruction = concat([Uint8Array.from([accounts.length - 1]), shortVec(instructionAccounts.length), Uint8Array.from(instructionAccounts), shortVec(data.length), data]);
  const message = concat([
    Uint8Array.from([2, 1, readonlyUnsigned]), shortVec(accounts.length), ...accounts,
    base58Decode(await rpc.latestBlockhash(rpcUrl)), shortVec(1), instruction,
  ]);
  const signatures = [ed25519Sign(message, payer.seed), ed25519Sign(message, authority.seed)];
  return concat([shortVec(signatures.length), ...signatures, message]);
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
