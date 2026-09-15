import { canonicalCustodyIntent, type CustodyIntent } from "../domain/custody-intent.ts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import type { SepoliaIntentEnvelope } from "../domain/evm-intent.ts";
import { canonicalIntentJson } from "../domain/evm-intent.ts";
import type { ObservedTransaction, SignedTransaction } from "../application/evm-journal.ts";

export interface CastSignerConfig {
  readonly executable: string;
  readonly executableSha256: string;
  readonly testOnly: true;
  readonly keystore: string;
  readonly passwordFile: string;
  readonly gasLimit: string;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
}
export type CastRunner = (executable: string, args: readonly string[], options: {
  readonly env: Readonly<Record<string, string>>; readonly timeout: number; readonly maxBuffer: number;
}) => Promise<string>;
const nativeRunner: CastRunner = (executable, args, options) => new Promise((resolve, reject) => {
  execFile(executable, [...args], options, (error, stdout) => {
    if (error) { reject(new Error("Cast subprocess failed")); }
    else { resolve(stdout); }
  });
});
const reject = (): never => { throw new Error("Invalid test-only cast signer data"); };
function bounded(value: string, maximum: bigint, zero = false): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) { return reject(); }
  const parsed = BigInt(value);
  if (parsed > maximum || parsed < (zero ? 0n : 1n)) { return reject(); }
  return value;
}
function hex(value: unknown, size?: number): string {
  if (typeof value !== "string" || !/^0x(?:[a-fA-F0-9]{2})*$/.test(value) ||
    (size !== undefined && value.length !== size * 2 + 2)) { return reject(); }
  return value.toLowerCase();
}
function quantity(value: unknown): string {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][a-fA-F0-9]*)$/.test(value)) { return reject(); }
  const result = BigInt(value);
  if (result >= 1n << 256n) { return reject(); }
  return result.toString();
}
function envelope(output: string): string {
  const value = JSON.parse(output) as Record<string, unknown>;
  if (!value || value.schema_version !== 1 || value.success !== true || typeof value.data !== "string" ||
    !Array.isArray(value.errors) || value.errors.length !== 0 || !Array.isArray(value.warnings)) { return reject(); }
  return value.data;
}

/** Local signing only. Caller provisions this fresh test-only encrypted keystore; no key creation/import here. */
export function createCastSigner(config: CastSignerConfig, runner: CastRunner = nativeRunner): {
  sign(intent: SepoliaIntentEnvelope): Promise<SignedTransaction>;
  inspectSigned(bytes: string): Promise<ObservedTransaction>;
} {
  return createSigner(config, "11155111", canonicalIntentJson, runner, true);
}

/** Explicit V2 profile; no mainnet signing profile exists. Local callers select an isolated Anvil adapter separately. */
export function createCustodyCastSigner(config: CastSignerConfig, environment: "local-test" | "owned-testnet", runner: CastRunner = nativeRunner): {
  sign(intent: CustodyIntent): Promise<SignedTransaction>;
  inspectSigned(bytes: string): Promise<ObservedTransaction>;
} {
  if (!["local-test", "owned-testnet"].includes(environment)) { return reject(); }
  return createSigner(config, environment === "local-test" ? "31337" : "11155111", intent => {
    if (intent.environment !== environment || intent.gasLimit !== config.gasLimit || intent.maxFeePerGasWei !== config.maxFeePerGas || intent.maxPriorityFeePerGasWei !== config.maxPriorityFeePerGas) { return reject(); }
    return canonicalCustodyIntent(intent);
  }, runner, false);
}

function createSigner<I extends SepoliaIntentEnvelope | CustodyIntent>(
  config: CastSignerConfig, chainId: "31337" | "11155111", canonical: (intent: I) => string, runner: CastRunner, legacy: boolean,
): { sign(intent: I): Promise<SignedTransaction>; inspectSigned(bytes: string): Promise<ObservedTransaction> } {
  const settings = { ...config };
  if (settings.testOnly !== true || ![settings.executable, settings.keystore, settings.passwordFile].every(isAbsolute) ||
    !/^[a-f0-9]{64}$/.test(settings.executableSha256)) { return reject(); }
  bounded(settings.gasLimit, legacy ? 30_000_000n : (1n << 64n) - 1n);
  bounded(settings.maxFeePerGas, legacy ? 100_000_000_000n : (1n << 256n) - 1n);
  bounded(settings.maxPriorityFeePerGas, BigInt(settings.maxFeePerGas), true);
  const run = pinnedCastRunner(settings.executable, settings.executableSha256, runner);
  async function inspectSigned(bytes: string): Promise<ObservedTransaction> {
    try {
      const raw = hex(bytes);
      if (raw === "0x") { return reject(); }
      const output = await run(["decode-transaction", raw, "--json"]);
      const decoded = JSON.parse(envelope(output)) as Record<string, unknown>;
      if (decoded.type !== "0x2" || quantity(decoded.chainId) !== chainId ||
        quantity(decoded.gas) !== settings.gasLimit || quantity(decoded.maxFeePerGas) !== settings.maxFeePerGas ||
        quantity(decoded.maxPriorityFeePerGas) !== settings.maxPriorityFeePerGas ||
        !Array.isArray(decoded.accessList) || decoded.accessList.length !== 0) { return reject(); }
      return {
        hash: hex(decoded.hash, 32), chainId, from: hex(decoded.signer, 20),
        to: decoded.to === null ? null : hex(decoded.to, 20), data: hex(decoded.input),
        value: quantity(decoded.value), nonce: quantity(decoded.nonce),
      };
    } catch { throw new Error("Signed transaction inspection failed"); }
  }
  async function sign(intent: I): Promise<SignedTransaction> {
    try {
      // Validate before invoking a subprocess; use a detached canonical copy below.
      const checked = JSON.parse(canonical(intent)) as I;
      const args = ["mktx", "--chain", chainId, "--nonce", checked.nonce, "--value", checked.value,
        "--gas-limit", settings.gasLimit, "--gas-price", settings.maxFeePerGas,
        "--priority-gas-price", settings.maxPriorityFeePerGas,
        "--keystore", settings.keystore, "--password-file", settings.passwordFile];
      if (checked.kind === "deploy") { args.push("--create", checked.data); }
      else { args.push(checked.to!, checked.data); }
      const output = (await run(args)).trim();
      const bytes = hex(output.startsWith("0x") ? output : envelope(output));
      const tx = await inspectSigned(bytes);
      if (tx.from !== checked.from || tx.to !== checked.to || tx.data !== checked.data ||
        tx.nonce !== checked.nonce || tx.value !== checked.value) { return reject(); }
      return { bytes, hash: tx.hash };
    } catch { throw new Error("Test-only transaction signing failed"); }
  }
  return { sign, inspectSigned };
}

function pinnedCastRunner(executable: string, executableSha256: string, runner: CastRunner): (args: readonly string[]) => Promise<string> {
  if (!isAbsolute(executable) || !/^[a-f0-9]{64}$/.test(executableSha256)) { return reject(); }
  return async function run(args: readonly string[]): Promise<string> {
    try {
      const digest = createHash("sha256").update(await readFile(executable)).digest("hex");
      if (digest !== executableSha256) { return reject(); }
      return await runner(executable, args, {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...(process.env.HOME && isAbsolute(process.env.HOME) ? { HOME: process.env.HOME } : {}) }, timeout: 30_000, maxBuffer: 256 * 1024,
      });
    } catch { throw new Error("Pinned cast operation failed"); }
  }
}

/** Verify EIP-712 digest signatures locally with pinned cast; no keystore or network capability. */
export function createCastSignatureVerifier(binary: { readonly executable: string; readonly executableSha256: string }, runner: CastRunner = nativeRunner):
  (owner: `0x${string}`, digest: `0x${string}`, signature: `0x${string}`) => Promise<boolean> {
  const run = pinnedCastRunner(binary.executable, binary.executableSha256, runner);
  return async (owner, digest, signature) => {
    try {
      hex(owner, 20); hex(digest, 32); hex(signature, 65);
      const result = JSON.parse(await run(["wallet", "verify", "--address", owner, "--no-hash", digest, signature, "--json"])) as Record<string, unknown>;
      const data = result.data as Record<string, unknown> | null;
      return result.schema_version === 1 && result.success === true && Array.isArray(result.errors) && result.errors.length === 0
        && data?.result === true && typeof data.address === "string" && data.address.toLowerCase() === owner.toLowerCase();
    } catch { return false; }
  };
}
