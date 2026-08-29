import type { AccountState, FixtureObservations, TokenAccountState, TransactionFact } from "../domain/model.ts";

export interface ToolPaths {
  readonly solana: string;
  readonly keygen: string;
  readonly validator: string;
  readonly splToken: string;
}

export interface CommandResult { readonly stdout: string; readonly stderr: string; readonly exitCode: number; }
export interface CommandPort {
  run(executable: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly stdin?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<CommandResult>;
}

export interface ValidatorHandle { readonly pid: number; stop(): Promise<void>; }
export interface ValidatorPort {
  start(executable: string, ledger: string, rpcPort: number, faucetPort: number, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<ValidatorHandle>;
}

export interface RpcPort {
  waitReady(rpcUrl: string, timeoutMs: number, signal: AbortSignal): Promise<{ readonly version: string; readonly genesisHash: string }>;
  genesisHash(rpcUrl: string): Promise<string>;
  mintAccount(rpcUrl: string, address: string): Promise<AccountState>;
  tokenAccount(rpcUrl: string, address: string): Promise<TokenAccountState>;
  finalizedTransaction(rpcUrl: string, kind: TransactionFact["kind"], signature: string, genesisHash: string): Promise<TransactionFact>;
  sendSignedTransaction(rpcUrl: string, bytes: Uint8Array): Promise<string>;
  latestBlockhash(rpcUrl: string): Promise<string>;
}

export interface RunPaths {
  readonly directory: string;
  readonly ledger: string;
  readonly config: string;
  readonly payerKey: string;
  readonly mintKey: string;
  readonly ownerKey: string;
  readonly freezeKey: string;
}

export interface RunStorePort {
  create(): Promise<RunPaths>;
  cleanup(paths: RunPaths): Promise<void>;
  reclaimStale(): Promise<number>;
  publish(report: FixtureObservations, verified: unknown): Promise<{ readonly jsonPath: string; readonly markdownPath: string }>;
}

export interface CliPort {
  createKeys(paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ payer: string; mint: string; owner: string; freeze: string }>;
  fund(rpcUrl: string, payer: string, paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string>;
  createMint(rpcUrl: string, publicKeys: { payer: string; mint: string; freeze: string }, paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string>;
  revokeFreeze(rpcUrl: string, mint: string, paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string>;
  createTokenAccount(rpcUrl: string, mint: string, owner: string, paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ address: string; signature: string }>;
  mint(rpcUrl: string, mint: string, account: string, paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string>;
  burn(rpcUrl: string, account: string, paths: RunPaths, tools: ToolPaths, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string>;
}

export interface ToolResolverPort { resolve(): Promise<ToolPaths>; }
export interface PortAllocator { allocate(): Promise<{ readonly rpcPort: number; readonly faucetPort: number }>; }
export interface AuthorityTransactionPort {
  restoreFreeze(rpc: RpcPort, rpcUrl: string, payerPath: string, authorityPath: string, mint: string, newAuthority: string): Promise<Uint8Array>;
  freezeAccount(rpc: RpcPort, rpcUrl: string, payerPath: string, authorityPath: string, account: string, mint: string, authority: string): Promise<Uint8Array>;
}
