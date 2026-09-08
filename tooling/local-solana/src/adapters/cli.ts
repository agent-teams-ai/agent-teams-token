import { chmod } from "node:fs/promises";
import { CLASSIC_TOKEN_PROGRAM, FIXTURE_DECIMALS, LocalSolanaError, parseUnsignedInteger } from "../domain/model.ts";
import type { CliExecutionContext, CliPort, CommandPort, ToolPaths } from "../application/ports.ts";
import { object, string } from "./rpc-parsers.ts";

export class SolanaCliAdapter implements CliPort {
  private readonly commands: CommandPort;
  public constructor(commands: CommandPort) { this.commands = commands; }

  public async createKeys(context: CliExecutionContext) {
    const { paths, tools, env, signal } = context;
    for (const path of [paths.payerKey, paths.mintKey, paths.ownerKey]) {
      if (signal.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "command interrupted"); }
      await this.checked(tools.keygen, ["new", "--no-bip39-passphrase", "--silent", "--force", "--outfile", path], env, signal);
      if (signal.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "command interrupted"); }
      await chmod(path, 0o600);
      if (signal.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "command interrupted"); }
    }
    return {
      payer: await this.pubkey(tools, paths.payerKey, env, signal), mint: await this.pubkey(tools, paths.mintKey, env, signal),
      owner: await this.pubkey(tools, paths.ownerKey, env, signal),
    };
  }
  public async verifyFunded(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly payer: string }): Promise<void> {
    const result = await this.checked(context.tools.solana, [
      "balance", request.payer, "--url", request.rpcUrl, "--lamports", "--output", "json", "--config", context.paths.config,
    ], context.env, context.signal);
    const lamports = extractLamports(result.stdout);
    if (lamports < 1_000_000_000n) { throw new LocalSolanaError("SOLANA_PAYER_BALANCE", "local genesis payer has insufficient test funds"); }
  }
  public async createMint(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly publicKeys: { readonly payer: string; readonly mint: string; readonly owner: string } }): Promise<string> {
    const created = await this.spl(context, request.rpcUrl, ["create-token", "--decimals", String(FIXTURE_DECIMALS), "--mint-authority", request.publicKeys.mint, "--enable-freeze", context.paths.mintKey]);
    return extractSignature(created.stdout, "create token");
  }
  public async revokeFreeze(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly mint: string }): Promise<string> {
    const result = await this.spl(context, request.rpcUrl, ["authorize", request.mint, "freeze", "--disable", "--authority", context.paths.mintKey]);
    return extractSignature(result.stdout, "revoke freeze");
  }
  public async createTokenAccount(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly mint: string; readonly owner: string }): Promise<string> {
    const result = await this.spl(context, request.rpcUrl, ["create-account", request.mint, "--owner", request.owner]);
    return extractSignature(result.stdout, "create token account");
  }
  public async associatedAddress(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly mint: string; readonly owner: string }): Promise<string> {
    const result = await this.spl(context, request.rpcUrl, ["address", "--verbose", "--owner", request.owner, "--token", request.mint]);
    return extractAssociatedAddress(result.stdout);
  }
  public async mint(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly mint: string; readonly account: string }): Promise<string> {
    const result = await this.spl(context, request.rpcUrl, ["mint", request.mint, "1000", request.account, "--mint-authority", context.paths.mintKey]);
    return extractSignature(result.stdout, "mint");
  }
  public async burn(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly account: string }): Promise<string> {
    const result = await this.spl(context, request.rpcUrl, ["burn", request.account, "1000", "--owner", context.paths.ownerKey]);
    return extractSignature(result.stdout, "burn");
  }
  private async pubkey(tools: ToolPaths, path: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
    const result = await this.checked(tools.keygen, ["pubkey", path], env, signal);
    const value = result.stdout.trim(); assertPubkey(value, "keypair public key"); return value;
  }
  private async spl(context: CliExecutionContext, rpcUrl: string, args: readonly string[]) {
    return await this.checked(context.tools.splToken, ["--config", context.paths.config, "--program-id", CLASSIC_TOKEN_PROGRAM, "--url", rpcUrl, "--fee-payer", context.paths.payerKey, "--output", "json", ...args], context.env, context.signal);
  }
  private async checked(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal) {
    const result = await this.commands.run(executable, args, { env, signal, timeoutMs: 60_000 });
    if (signal.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "command interrupted"); }
    if (result.exitCode !== 0) { throw new LocalSolanaError("SOLANA_CLI_FAILED", `${executable.split("/").at(-1) ?? "CLI"} exited ${result.exitCode}: ${result.stderr}`); }
    return result;
  }
}

export function extractSignature(stdout: string, label: string): string {
  const value = parseJson(stdout, label);
  const found = recursivelyFind(value, new Set(["signature"]));
  const signature = string(found, `${label} signature`); assertSignature(signature, label); return signature;
}
export function extractAddress(stdout: string): string {
  const value = parseJson(stdout, "create account");
  const found = recursivelyFind(value, new Set(["address", "account"]));
  const address = string(found, "created token account address"); assertPubkey(address, "token account"); return address;
}
export function extractAssociatedAddress(stdout: string): string {
  const value = parseJson(stdout, "associated address");
  const found = recursivelyFind(value, new Set(["associatedTokenAddress"]));
  const address = string(found, "associated token account address"); assertPubkey(address, "associated token account"); return address;
}
export function extractLamports(stdout: string): bigint {
  const value = object(parseJson(stdout, "payer balance"), "payer balance");
  if (Object.keys(value).length !== 1 || typeof value.lamports !== "number" || !Number.isFinite(value.lamports) || value.lamports < 0) {
    throw new LocalSolanaError("SOLANA_PAYER_BALANCE_JSON", "payer balance JSON has an unexpected shape");
  }
  const match = /^\s*\{\s*"lamports"\s*:\s*(0|[1-9][0-9]*)\s*\}\s*$/u.exec(stdout);
  if (!match) { throw new LocalSolanaError("SOLANA_PAYER_BALANCE_INTEGER", "payer balance is not an exact canonical integer"); }
  return parseUnsignedInteger(match[1], "payer lamports");
}
function parseJson(stdout: string, label: string): unknown { try { return JSON.parse(stdout); } catch { throw new LocalSolanaError("SOLANA_CLI_JSON", `${label} did not return strict JSON`); } }
function recursivelyFind(value: unknown, keys: ReadonlySet<string>): unknown {
  const root = object(value, "CLI JSON");
  for (const key of keys) { if (root[key] !== undefined) { return root[key]; } }
  for (const child of Object.values(root)) { if (typeof child === "object" && child !== null && !Array.isArray(child)) { try { return recursivelyFind(child, keys); } catch (cause) { if (!(cause instanceof LocalSolanaError) || cause.code !== "SOLANA_CLI_FIELD") { throw cause; } } } }
  throw new LocalSolanaError("SOLANA_CLI_FIELD", `CLI JSON is missing ${[...keys].join("/")}`);
}
function assertPubkey(value: string, label: string): void { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(value)) { throw new LocalSolanaError("SOLANA_CLI_PUBKEY", `${label} is not base58`); } }
function assertSignature(value: string, label: string): void { if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/u.test(value)) { throw new LocalSolanaError("SOLANA_CLI_SIGNATURE", `${label} signature is not base58`); } }
