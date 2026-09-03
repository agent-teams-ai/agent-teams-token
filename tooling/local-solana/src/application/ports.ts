import type { AccountState, FailureEvidenceReport, FixtureObservations, TokenAccountState, TransactionFact } from "../domain/model.ts";

export interface ToolPaths {
  readonly solana: string;
  readonly keygen: string;
  readonly validator: string;
  readonly splToken: string;
  readonly tokenProgram: string;
  readonly associatedTokenProgram: string;
}

export interface CommandResult { readonly stdout: string; readonly stderr: string; readonly exitCode: number; }
export interface CommandPort {
  run(executable: string, args: readonly string[], options?: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly stdin?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<CommandResult>;
}

export interface ValidatorHandle { readonly pid: number; stop(): Promise<void>; assertHealthy?: () => Promise<void>; }
export interface ValidatorStartRequest {
  readonly executable: string;
  readonly ledger: string;
  readonly config: string;
  readonly genesisMint: string;
  readonly tokenProgram: string;
  readonly associatedTokenProgram: string;
  readonly rpcPort: number;
  readonly faucetPort: number;
  readonly gossipPort: number;
  readonly dynamicPortRange: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly leaseToken: string;
  readonly registerIdentity: (identity: ValidatorIdentity) => Promise<void>;
}
export interface ValidatorIdentity {
  readonly pid: number;
  readonly platform: "linux" | "darwin";
  readonly startTime: string;
  readonly executable: string;
  readonly ledger: string;
  readonly commandHash: string;
}
export interface ValidatorPort {
  start(request: ValidatorStartRequest): Promise<ValidatorHandle>;
}

export interface RpcPort {
  waitReady(rpcUrl: string, timeoutMs: number, signal: AbortSignal): Promise<{ readonly version: string; readonly genesisHash: string }>;
  waitProgramsReady(rpcUrl: string, programIds: readonly string[], timeoutMs: number, signal: AbortSignal): Promise<void>;
  genesisHash(rpcUrl: string): Promise<string>;
  mintAccount(rpcUrl: string, address: string): Promise<AccountState>;
  tokenAccount(rpcUrl: string, address: string): Promise<TokenAccountState>;
  tokenAccountAddress(rpcUrl: string, owner: string, mint: string): Promise<string>;
  finalizedTransaction(rpcUrl: string, signature: string): Promise<TransactionFact>;
  sendSignedTransaction(rpcUrl: string, bytes: Uint8Array): Promise<string>;
  latestBlockhash(rpcUrl: string, signal?: AbortSignal): Promise<string>;
}

export interface RunPaths {
  readonly directory: string;
  readonly ledger: string;
  readonly config: string;
  readonly payerKey: string;
  readonly mintKey: string;
  readonly ownerKey: string;
  readonly leaseToken: string;
}

export interface RunStorePort {
  create(): Promise<RunPaths>;
  cleanup(paths: RunPaths): Promise<void>;
  registerValidator(paths: RunPaths, identity: ValidatorIdentity): Promise<void>;
  reclaimStale(): Promise<number>;
  publish(report: FixtureObservations, verified: unknown): Promise<{ readonly jsonPath: string; readonly markdownPath: string }>;
  publishFailure(report: FailureEvidenceReport): Promise<{ readonly jsonPath: string; readonly markdownPath: string }>;
}

export interface CliExecutionContext {
  readonly paths: RunPaths;
  readonly tools: ToolPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}

export interface CliPort {
  createKeys(context: CliExecutionContext): Promise<{ payer: string; mint: string; owner: string }>;
  verifyFunded(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly payer: string }): Promise<void>;
  createMint(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly publicKeys: { readonly payer: string; readonly mint: string; readonly owner: string } }): Promise<string>;
  revokeFreeze(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly mint: string }): Promise<string>;
  createTokenAccount(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly mint: string; readonly owner: string }): Promise<string>;
  associatedAddress(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly mint: string; readonly owner: string }): Promise<string>;
  mint(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly mint: string; readonly account: string }): Promise<string>;
  burn(context: CliExecutionContext, request: { readonly rpcUrl: string; readonly account: string }): Promise<string>;
}

export interface ToolResolverPort { resolve(): Promise<ToolPaths>; }
export interface PortLease {
  readonly rpcPort: number;
  readonly faucetPort: number;
  readonly gossipPort: number;
  readonly dynamicPortRange: string;
  release(): Promise<void>;
}
export interface PortAllocator { allocate(): Promise<PortLease>; }
export interface AuthorityTransactionPort {
  restoreFreeze(request: AuthorityTransactionContext & { readonly mint: string; readonly newAuthority: string }): Promise<Uint8Array>;
  freezeAccount(request: AuthorityTransactionContext & { readonly account: string; readonly mint: string }): Promise<Uint8Array>;
}

export interface AuthorityTransactionContext {
  readonly rpc: RpcPort;
  readonly rpcUrl: string;
  readonly payerPath: string;
  readonly authorityPath: string;
  readonly signal?: AbortSignal;
}
