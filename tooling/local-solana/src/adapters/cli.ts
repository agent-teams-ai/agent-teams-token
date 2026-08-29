import { chmod } from "node:fs/promises";
import { CLASSIC_TOKEN_PROGRAM, FIXTURE_DECIMALS, LocalSolanaError, object, string } from "../domain/model.ts";
import type { CliPort, CommandPort, RunPaths, ToolPaths } from "../application/ports.ts";

export class SolanaCliAdapter implements CliPort {
  private readonly commands: CommandPort;
  public constructor(commands: CommandPort) { this.commands = commands; }

  public async createKeys(paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal) {
    for (const path of [paths.payerKey, paths.mintKey, paths.ownerKey, paths.freezeKey]) {
      await this.checked(tools.keygen, ["new", "--no-bip39-passphrase", "--silent", "--force", "--outfile", path], env, signal);
      await chmod(path, 0o600);
    }
    return {
      payer: await this.pubkey(tools, paths.payerKey, env, signal), mint: await this.pubkey(tools, paths.mintKey, env, signal),
      owner: await this.pubkey(tools, paths.ownerKey, env, signal), freeze: await this.pubkey(tools, paths.freezeKey, env, signal),
    };
  }
  public async fund(rpcUrl: string, payer: string, paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
    const result = await this.checked(tools.solana, ["airdrop", "10", payer, "--url", rpcUrl, "--keypair", paths.payerKey, "--commitment", "finalized", "--output", "json"], env, signal);
    return extractSignature(result.stdout, "airdrop");
  }
  public async createMint(rpcUrl: string, publicKeys: { payer: string; mint: string; freeze: string }, paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
    const result = await this.spl(tools, rpcUrl, paths.payerKey, ["create-token", "--decimals", String(FIXTURE_DECIMALS), "--mint-authority", publicKeys.mint, "--freeze-authority", publicKeys.freeze, paths.mintKey], env, signal);
    return extractSignature(result.stdout, "create token");
  }
  public async revokeFreeze(rpcUrl: string, mint: string, paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
    const result = await this.spl(tools, rpcUrl, paths.payerKey, ["authorize", mint, "freeze", "--disable", "--authority", paths.freezeKey], env, signal);
    return extractSignature(result.stdout, "revoke freeze");
  }
  public async createTokenAccount(rpcUrl: string, mint: string, owner: string, paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ address: string; signature: string }> {
    const result = await this.spl(tools, rpcUrl, paths.payerKey, ["create-account", mint, "--owner", owner], env, signal);
    return { address: extractAddress(result.stdout), signature: extractSignature(result.stdout, "create token account") };
  }
  public async mint(rpcUrl: string, mint: string, account: string, paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
    const result = await this.spl(tools, rpcUrl, paths.payerKey, ["mint", mint, "1000", account, "--mint-authority", paths.mintKey], env, signal);
    return extractSignature(result.stdout, "mint");
  }
  public async burn(rpcUrl: string, account: string, paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
    const result = await this.spl(tools, rpcUrl, paths.payerKey, ["burn", account, "1000", "--owner", paths.ownerKey], env, signal);
    return extractSignature(result.stdout, "burn");
  }
  private async pubkey(tools: ToolPaths, path: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
    const result = await this.checked(tools.keygen, ["pubkey", path], env, signal);
    const value = result.stdout.trim(); assertPubkey(value, "keypair public key"); return value;
  }
  private async spl(tools: ToolPaths, rpcUrl: string, payer: string, args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal) {
    return await this.checked(tools.splToken, ["--program-id", CLASSIC_TOKEN_PROGRAM, "--url", rpcUrl, "--fee-payer", payer, "--commitment", "finalized", "--output", "json", ...args], env, signal);
  }
  private async checked(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal) {
    const result = await this.commands.run(executable, args, { env, signal, timeoutMs: 60_000 });
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
function parseJson(stdout: string, label: string): unknown { try { return JSON.parse(stdout); } catch { throw new LocalSolanaError("SOLANA_CLI_JSON", `${label} did not return strict JSON`); } }
function recursivelyFind(value: unknown, keys: ReadonlySet<string>): unknown {
  const root = object(value, "CLI JSON");
  for (const key of keys) { if (root[key] !== undefined) { return root[key]; } }
  for (const child of Object.values(root)) { if (typeof child === "object" && child !== null && !Array.isArray(child)) { try { return recursivelyFind(child, keys); } catch (cause) { if (!(cause instanceof LocalSolanaError) || cause.code !== "SOLANA_CLI_FIELD") { throw cause; } } } }
  throw new LocalSolanaError("SOLANA_CLI_FIELD", `CLI JSON is missing ${[...keys].join("/")}`);
}
function assertPubkey(value: string, label: string): void { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(value)) { throw new LocalSolanaError("SOLANA_CLI_PUBKEY", `${label} is not base58`); } }
function assertSignature(value: string, label: string): void { if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/u.test(value)) { throw new LocalSolanaError("SOLANA_CLI_SIGNATURE", `${label} signature is not base58`); } }
