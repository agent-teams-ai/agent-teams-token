import { ASSOCIATED_TOKEN_PROGRAM, CLASSIC_TOKEN_PROGRAM, FIXTURE_AMOUNT_BASE_UNITS, LocalSolanaError, type FailurePhase, type FixtureObservations, type TransactionFact } from "../domain/model.ts";
import { verifyObservations } from "./verifier.ts";
import type { AuthorityTransactionPort, CliPort, CommandPort, PortAllocator, PortLease, RpcPort, RunStorePort, ToolResolverPort, ValidatorHandle, ValidatorPort } from "./ports.ts";

export interface FixtureDependencies {
  readonly tools: ToolResolverPort;
  readonly command: CommandPort;
  readonly validator: ValidatorPort;
  readonly rpc: RpcPort;
  readonly cli: CliPort;
  readonly store: RunStorePort;
  readonly ports: PortAllocator;
  readonly authorityTransactions: AuthorityTransactionPort;
  readonly environment: NodeJS.ProcessEnv;
}

export interface FixtureResult { readonly jsonPath: string; readonly markdownPath: string; }

const CLEANUP_ATTEMPTS = 2;
const RPC_READINESS_TIMEOUT_MS = 30_000;
const RPC_LISTENER_RETRY_MS = 50;

export interface ReadinessTiming {
  readonly now: () => number;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const systemReadinessTiming: ReadinessTiming = {
  now: () => performance.now(),
  wait: async (milliseconds, signal) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, milliseconds);
      const abort = (): void => finish();
      function finish(): void { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); }
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { finish(); }
    });
  },
};

interface CleanupResources {
  validator: Awaited<ReturnType<ValidatorPort["start"]>> | undefined;
  portLease: PortLease | undefined;
}

interface CleanupTruth {
  readonly validatorStopped: boolean;
  readonly portLeaseReleased: boolean;
  readonly privateDirectoryRemoved: boolean;
}

export async function runFixture(deps: FixtureDependencies, externalSignal?: AbortSignal): Promise<FixtureResult> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abort, { once: true });
  if (externalSignal?.aborted) { controller.abort(externalSignal.reason); }
  const signal = controller.signal;
  ensureNotAborted(signal);
  await deps.store.reclaimStale();
  ensureNotAborted(signal);
  const paths = await deps.store.create();
  const resources: CleanupResources = { validator: undefined, portLease: undefined };
  let mutationPhase: FailurePhase | undefined;
  let observations: FixtureObservations | undefined;
  let report: ReturnType<typeof verifyObservations> | undefined;
  let failure: unknown;
  let failed = false;
  try {
    ensureNotAborted(signal);
    const tools = await deps.tools.resolve();
    const env = allowlistedEnvironment(deps.environment, paths.directory);
    const cliContext = { paths, tools, env, signal };
    const keys = await deps.cli.createKeys(cliContext);
    ({ validator: resources.validator, portLease: resources.portLease } = await startValidatorWithPortRetry({ deps, paths, tools, env, signal, genesisMint: keys.payer, resources }));
    const rpcUrl = `http://127.0.0.1:${resources.portLease.rpcPort}/`;
    const ready = await waitForOwnedRpcReady(resources.validator, resources.portLease.rpcPort, signal, async (remainingMs) => await deps.rpc.waitReady(rpcUrl, remainingMs, signal));
    await validatorRpc(resources.validator, resources.portLease.rpcPort, signal, async () => await deps.rpc.waitProgramsReady(rpcUrl, [CLASSIC_TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM], 30_000, signal));
    await deps.cli.verifyFunded(cliContext, { rpcUrl, payer: keys.payer }); ensureNotAborted(signal);
    await assertValidatorHealthy(resources.validator);
    mutationPhase = "createMint";
    const createSignature = await deps.cli.createMint(cliContext, { rpcUrl, publicKeys: keys }); ensureNotAborted(signal);
    const initialMint = await validatorRpc(resources.validator, resources.portLease.rpcPort, signal, async () => await deps.rpc.mintAccount(rpcUrl, keys.mint, signal));
    await assertValidatorHealthy(resources.validator);
    mutationPhase = "revokeFreeze";
    const revokeSignature = await deps.cli.revokeFreeze(cliContext, { rpcUrl, mint: keys.mint }); ensureNotAborted(signal);
    const afterRevokeMint = await validatorRpc(resources.validator, resources.portLease.rpcPort, signal, async () => await deps.rpc.mintAccount(rpcUrl, keys.mint, signal));
    await assertValidatorHealthy(resources.validator);
    mutationPhase = "createAta";
    const ataSignature = await deps.cli.createTokenAccount(cliContext, { rpcUrl, mint: keys.mint, owner: keys.owner }); ensureNotAborted(signal);
    const tokenAccountAddress = await validatorRpc(resources.validator, resources.portLease.rpcPort, signal, async () => await deps.rpc.tokenAccountAddress(rpcUrl, keys.owner, keys.mint, signal));
    const expectedTokenAccountAddress = await deps.cli.associatedAddress(cliContext, { rpcUrl, mint: keys.mint, owner: keys.owner }); ensureNotAborted(signal);
    if (tokenAccountAddress !== expectedTokenAccountAddress) { throw new LocalSolanaError("SOLANA_ASSOCIATED_ADDRESS", "created token account is not the derived associated address"); }
    await assertValidatorHealthy(resources.validator);
    mutationPhase = "mint";
    const mintSignature = await deps.cli.mint(cliContext, { rpcUrl, mint: keys.mint, account: tokenAccountAddress }); ensureNotAborted(signal);
    const afterMint = await validatorRpc(resources.validator, resources.portLease.rpcPort, signal, async () => await deps.rpc.mintAccount(rpcUrl, keys.mint, signal));
    const afterMintTokenAccount = await validatorRpc(resources.validator, resources.portLease.rpcPort, signal, async () => await deps.rpc.tokenAccount(rpcUrl, tokenAccountAddress, signal));
    await assertValidatorHealthy(resources.validator);
    mutationPhase = "burn";
    const burnSignature = await deps.cli.burn(cliContext, { rpcUrl, account: tokenAccountAddress }); ensureNotAborted(signal);
    const finalMint = await validatorRpc(resources.validator, resources.portLease.rpcPort, signal, async () => await deps.rpc.mintAccount(rpcUrl, keys.mint, signal));
    const finalTokenAccount = await validatorRpc(resources.validator, resources.portLease.rpcPort, signal, async () => await deps.rpc.tokenAccount(rpcUrl, tokenAccountAddress, signal));

    const authorityContext = { rpc: deps.rpc, rpcUrl, payerPath: paths.payerKey, authorityPath: paths.mintKey, signal };
    await assertValidatorHealthy(resources.validator);
    mutationPhase = "restoreFreezeAttempt";
    ensureNotAborted(signal);
    const restoreBytes = await deps.authorityTransactions.restoreFreeze({ ...authorityContext, mint: keys.mint, newAuthority: keys.mint }); ensureNotAborted(signal);
    const restoreSignature = await validatorRpc(resources.validator, resources.portLease.rpcPort, signal, async () => { ensureNotAborted(signal); return await deps.rpc.sendSignedTransaction(rpcUrl, restoreBytes, signal); });
    await assertValidatorHealthy(resources.validator);
    mutationPhase = "freezeAttempt";
    ensureNotAborted(signal);
    const freezeBytes = await deps.authorityTransactions.freezeAccount({ ...authorityContext, account: tokenAccountAddress, mint: keys.mint }); ensureNotAborted(signal);
    const freezeSignature = await validatorRpc(resources.validator, resources.portLease.rpcPort, signal, async () => { ensureNotAborted(signal); return await deps.rpc.sendSignedTransaction(rpcUrl, freezeBytes, signal); });
    const genesisAfter = await validatorRpc(resources.validator, resources.portLease.rpcPort, signal, async () => await deps.rpc.genesisHash(rpcUrl, signal));
    const transactionSignatures = [createSignature, revokeSignature, ataSignature, mintSignature, burnSignature, restoreSignature, freezeSignature] as const;
    const transactions: TransactionFact[] = [];
    for (const signature of transactionSignatures) { transactions.push(await validatorRpc(resources.validator, resources.portLease.rpcPort, signal, async () => await deps.rpc.finalizedTransaction(rpcUrl, signature, signal))); }
    const observationDraft = {
      schemaVersion: 1, rpcUrl, genesisHashBefore: ready.genesisHash, genesisHashAfter: genesisAfter,
      validatorVersion: ready.version, payerAddress: keys.payer, mintAddress: keys.mint, mintAuthority: keys.mint, freezeAuthority: keys.mint,
      ownerAddress: keys.owner, tokenAccountAddress, initialMint, afterRevokeMint,
      afterMint, afterMintTokenAccount, finalMint, finalTokenAccount, transactions,
    } satisfies Omit<FixtureObservations, "rpcListener">;
    mutationPhase = "verification";
    const rpcListener = await assertValidatorRpc(resources.validator, resources.portLease.rpcPort); ensureNotAborted(signal);
    observations = { ...observationDraft, rpcListener };
    report = verifyObservations(observations);
    const confirmedRpcListener = await assertValidatorRpc(resources.validator, resources.portLease.rpcPort); ensureNotAborted(signal);
    if (confirmedRpcListener.scope !== rpcListener.scope) { throw new LocalSolanaError("SOLANA_RPC_LISTENER_IDENTITY", "RPC listener scope changed during final evidence verification"); }
  } catch (cause) {
    failed = true;
    failure = cause;
  }

  try {
    const cleanup = await finalizeCleanup(resources, deps.store, paths);
    if (failed || !cleanupComplete(cleanup)) {
      const cause = failed ? failure : new LocalSolanaError("SOLANA_CLEANUP_INCOMPLETE", "bounded cleanup attempts were exhausted");
      if (mutationPhase !== undefined) {
        await deps.store.publishFailure(failureEvidence(mutationPhase, cause, cleanup));
      }
      throw cause;
    }
    try {
      if (observations === undefined || report === undefined) { throw new LocalSolanaError("SOLANA_EVIDENCE_INCOMPLETE", "verified observations are absent after successful cleanup"); }
      return await deps.store.publish(observations, report);
    } catch (cause) {
      if (mutationPhase !== undefined) {
        await deps.store.publishFailure({
          schemaVersion: 1,
          status: "FAILED",
          failedPhase: mutationPhase,
          diagnosticCode: cause instanceof LocalSolanaError ? cause.code : "SOLANA_UNEXPECTED_FAILURE",
          mutationsMayHaveOccurred: true,
          cleanupCompleted: true,
          validatorStopped: true,
          portLeaseReleased: true,
          privateDirectoryRemoved: true,
          publicNetwork: false,
          realAssetCostUsd: 0,
          secretsRetained: false,
          productionApproved: false,
        });
      }
      throw cause;
    }
  } finally {
    controller.abort();
    externalSignal?.removeEventListener("abort", abort);
  }
}

async function finalizeCleanup(resources: CleanupResources, store: RunStorePort, paths: Awaited<ReturnType<RunStorePort["create"]>>): Promise<CleanupTruth> {
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS && resources.validator !== undefined; attempt += 1) {
    try { await resources.validator.stop(); resources.validator = undefined; } catch {}
  }
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS && resources.portLease !== undefined; attempt += 1) {
    try { await resources.portLease.release(); resources.portLease = undefined; } catch {}
  }
  let privateDirectoryRemoved = false;
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS && !privateDirectoryRemoved; attempt += 1) {
    try { await store.cleanup(paths); privateDirectoryRemoved = true; } catch {}
  }
  return {
    validatorStopped: resources.validator === undefined,
    portLeaseReleased: resources.portLease === undefined,
    privateDirectoryRemoved,
  };
}

function cleanupComplete(value: CleanupTruth): boolean {
  return value.validatorStopped && value.portLeaseReleased && value.privateDirectoryRemoved;
}

function failureEvidence(phase: FailurePhase, cause: unknown, cleanup: CleanupTruth) {
  return {
    schemaVersion: 1 as const,
    status: "FAILED" as const,
    failedPhase: phase,
    diagnosticCode: cause instanceof LocalSolanaError ? cause.code : "SOLANA_UNEXPECTED_FAILURE",
    mutationsMayHaveOccurred: true as const,
    cleanupCompleted: cleanupComplete(cleanup),
    validatorStopped: cleanup.validatorStopped,
    portLeaseReleased: cleanup.portLeaseReleased,
    privateDirectoryRemoved: cleanup.privateDirectoryRemoved,
    publicNetwork: false as const,
    realAssetCostUsd: 0 as const,
    secretsRetained: !cleanup.privateDirectoryRemoved,
    productionApproved: false as const,
  };
}

interface ValidatorStartContext {
  readonly deps: FixtureDependencies;
  readonly paths: Awaited<ReturnType<RunStorePort["create"]>>;
  readonly tools: Awaited<ReturnType<ToolResolverPort["resolve"]>>;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly genesisMint: string;
  readonly resources: CleanupResources;
}

async function startValidatorWithPortRetry(context: ValidatorStartContext): Promise<{ readonly validator: Awaited<ReturnType<ValidatorPort["start"]>>; readonly portLease: PortLease }> {
  const { deps, paths, tools, env, signal, genesisMint, resources } = context;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const portLease = await deps.ports.allocate();
    resources.portLease = portLease;
    try {
      const validator = await deps.validator.start({
        executable: tools.validator, ledger: paths.ledger, config: paths.config, genesisMint,
        tokenProgram: tools.tokenProgram, associatedTokenProgram: tools.associatedTokenProgram,
        rpcPort: portLease.rpcPort, faucetPort: portLease.faucetPort, gossipPort: portLease.gossipPort,
        dynamicPortRange: portLease.dynamicPortRange, env, signal, leaseToken: paths.leaseToken,
        registerIdentity: async (identity) => await deps.store.registerValidator(paths, identity),
      });
      resources.validator = validator;
      return { validator, portLease };
    } catch (cause) {
      await portLease.release();
      resources.portLease = undefined;
      if (!(cause instanceof LocalSolanaError) || cause.code !== "SOLANA_VALIDATOR_PORT_COLLISION" || attempt === 2) { throw cause; }
    }
  }
  throw new LocalSolanaError("SOLANA_VALIDATOR_PORT_RETRY", "validator port retry exhausted before mutation");
}

export function allowlistedEnvironment(source: NodeJS.ProcessEnv, runDirectory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: runDirectory, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", TMPDIR: runDirectory };
  for (const key of ["SYSTEMROOT", "WINDIR"]) { if (source[key]) { env[key] = source[key]; } }
  return env;
}

export function ensureNotAborted(signal: AbortSignal): void { if (signal.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "fixture interrupted"); } }

export function assertFixtureAmount(value: bigint): void {
  if (value !== FIXTURE_AMOUNT_BASE_UNITS) { throw new LocalSolanaError("SOLANA_AMOUNT", "fixture amount is immutable"); }
}

async function assertValidatorHealthy(value: CleanupResources["validator"]): Promise<void> { if (value === undefined) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "validator identity is absent"); } await value.assertHealthy(); }
async function assertValidatorRpc(value: CleanupResources["validator"], port: number) { if (value === undefined) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "validator identity is absent"); } await assertValidatorHealthy(value); const fact = await value.assertRpcListener(port); await assertValidatorHealthy(value); return fact; }
async function validatorRpc<T>(value: CleanupResources["validator"], port: number, signal: AbortSignal, action: () => Promise<T>): Promise<T> { ensureNotAborted(signal); await assertValidatorRpc(value, port); ensureNotAborted(signal); const result = await action(); ensureNotAborted(signal); await assertValidatorRpc(value, port); ensureNotAborted(signal); return result; }

export async function waitForOwnedRpcReady<T>(
  validator: ValidatorHandle,
  port: number,
  signal: AbortSignal,
  action: (remainingMs: number) => Promise<T>,
  timing: ReadinessTiming = systemReadinessTiming,
): Promise<T> {
  const deadline = timing.now() + RPC_READINESS_TIMEOUT_MS;
  while (true) {
    ensureNotAborted(signal);
    try {
      await assertValidatorRpc(validator, port);
      break;
    } catch (cause) {
      ensureNotAborted(signal);
      if (!(cause instanceof LocalSolanaError) || cause.code !== "SOLANA_RPC_LISTENER_IDENTITY") { throw cause; }
      const remainingMs = deadline - timing.now();
      if (remainingMs <= 0) { throw cause; }
      await timing.wait(Math.min(RPC_LISTENER_RETRY_MS, remainingMs), signal);
    }
  }
  ensureNotAborted(signal);
  const remainingMs = Math.floor(deadline - timing.now());
  if (remainingMs <= 0) { throw new LocalSolanaError("SOLANA_RPC_READY_TIMEOUT", "RPC readiness deadline was exhausted after listener ownership was proven"); }
  const result = await action(remainingMs);
  ensureNotAborted(signal);
  await assertValidatorRpc(validator, port);
  ensureNotAborted(signal);
  return result;
}
