import { ASSOCIATED_TOKEN_PROGRAM, CLASSIC_TOKEN_PROGRAM, FIXTURE_AMOUNT_BASE_UNITS, LocalSolanaError, type FailurePhase, type FixtureObservations } from "../domain/model.ts";
import { verifyObservations } from "./verifier.ts";
import type { AuthorityTransactionPort, CliPort, CommandPort, PortAllocator, PortLease, RpcPort, RunStorePort, ToolResolverPort, ValidatorPort } from "./ports.ts";

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

export async function runFixture(deps: FixtureDependencies, externalSignal?: AbortSignal): Promise<FixtureResult> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abort, { once: true });
  const signal = controller.signal;
  await deps.store.reclaimStale();
  const paths = await deps.store.create();
  let validator: Awaited<ReturnType<ValidatorPort["start"]>> | undefined;
  let portLease: PortLease | undefined;
  let mutationPhase: FailurePhase | undefined;
  try {
    const tools = await deps.tools.resolve();
    const env = allowlistedEnvironment(deps.environment, paths.directory);
    const cliContext = { paths, tools, env, signal };
    const keys = await deps.cli.createKeys(cliContext);
    ({ validator, portLease } = await startValidatorWithPortRetry({ deps, paths, tools, env, signal, genesisMint: keys.payer }));
    const rpcUrl = `http://127.0.0.1:${portLease.rpcPort}/`;
    const ready = await deps.rpc.waitReady(rpcUrl, 30_000, signal);
    await deps.rpc.waitProgramsReady(rpcUrl, [CLASSIC_TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM], 30_000, signal);
    await deps.cli.verifyFunded(cliContext, { rpcUrl, payer: keys.payer });
    mutationPhase = "createMint";
    const createSignature = await deps.cli.createMint(cliContext, { rpcUrl, publicKeys: keys });
    const initialMint = await deps.rpc.mintAccount(rpcUrl, keys.mint);
    mutationPhase = "revokeFreeze";
    const revokeSignature = await deps.cli.revokeFreeze(cliContext, { rpcUrl, mint: keys.mint });
    const afterRevokeMint = await deps.rpc.mintAccount(rpcUrl, keys.mint);
    mutationPhase = "createAta";
    const ataSignature = await deps.cli.createTokenAccount(cliContext, { rpcUrl, mint: keys.mint, owner: keys.owner });
    const tokenAccountAddress = await deps.rpc.tokenAccountAddress(rpcUrl, keys.owner, keys.mint);
    const expectedTokenAccountAddress = await deps.cli.associatedAddress(cliContext, { rpcUrl, mint: keys.mint, owner: keys.owner });
    if (tokenAccountAddress !== expectedTokenAccountAddress) { throw new LocalSolanaError("SOLANA_ASSOCIATED_ADDRESS", "created token account is not the derived associated address"); }
    mutationPhase = "mint";
    const mintSignature = await deps.cli.mint(cliContext, { rpcUrl, mint: keys.mint, account: tokenAccountAddress });
    const afterMint = await deps.rpc.mintAccount(rpcUrl, keys.mint);
    const afterMintTokenAccount = await deps.rpc.tokenAccount(rpcUrl, tokenAccountAddress);
    mutationPhase = "burn";
    const burnSignature = await deps.cli.burn(cliContext, { rpcUrl, account: tokenAccountAddress });
    const finalMint = await deps.rpc.mintAccount(rpcUrl, keys.mint);
    const finalTokenAccount = await deps.rpc.tokenAccount(rpcUrl, tokenAccountAddress);

    const authorityContext = { rpc: deps.rpc, rpcUrl, payerPath: paths.payerKey, authorityPath: paths.mintKey };
    mutationPhase = "restoreFreezeAttempt";
    const restoreBytes = await deps.authorityTransactions.restoreFreeze({ ...authorityContext, mint: keys.mint, newAuthority: keys.mint });
    const restoreSignature = await deps.rpc.sendSignedTransaction(rpcUrl, restoreBytes);
    mutationPhase = "freezeAttempt";
    const freezeBytes = await deps.authorityTransactions.freezeAccount({ ...authorityContext, account: tokenAccountAddress, mint: keys.mint });
    const freezeSignature = await deps.rpc.sendSignedTransaction(rpcUrl, freezeBytes);
    const genesisAfter = await deps.rpc.genesisHash(rpcUrl);
    const transactionSignatures = [createSignature, revokeSignature, ataSignature, mintSignature, burnSignature, restoreSignature, freezeSignature] as const;
    const transactions = await Promise.all(transactionSignatures.map(async (signature) => await deps.rpc.finalizedTransaction(rpcUrl, signature)));
    const observations: FixtureObservations = {
      schemaVersion: 1, rpcUrl, genesisHashBefore: ready.genesisHash, genesisHashAfter: genesisAfter,
      validatorVersion: ready.version, payerAddress: keys.payer, mintAddress: keys.mint, mintAuthority: keys.mint, freezeAuthority: keys.mint,
      ownerAddress: keys.owner, tokenAccountAddress, initialMint, afterRevokeMint,
      afterMint, afterMintTokenAccount, finalMint, finalTokenAccount, transactions,
    };
    mutationPhase = "verification";
    const report = verifyObservations(observations);
    await validator.stop();
    validator = undefined;
    await portLease.release();
    portLease = undefined;
    await deps.store.cleanup(paths);
    return await deps.store.publish(observations, report);
  } catch (cause) {
    if (mutationPhase !== undefined) {
      let cleanupCompleted = true;
      await validator?.stop().catch(() => { cleanupCompleted = false; });
      validator = undefined;
      await portLease?.release().catch(() => { cleanupCompleted = false; });
      portLease = undefined;
      await deps.store.cleanup(paths).catch(() => { cleanupCompleted = false; });
      await deps.store.publishFailure({
        schemaVersion: 1,
        status: "FAILED",
        failedPhase: mutationPhase,
        diagnosticCode: cause instanceof LocalSolanaError ? cause.code : "SOLANA_UNEXPECTED_FAILURE",
        mutationsMayHaveOccurred: true,
        cleanupCompleted,
        publicNetwork: false,
        realAssetCostUsd: 0,
        secretsRetained: !cleanupCompleted,
        productionApproved: false,
      });
    }
    throw cause;
  } finally {
    controller.abort();
    await validator?.stop().catch(() => {});
    await portLease?.release().catch(() => {});
    await deps.store.cleanup(paths).catch(() => {});
    externalSignal?.removeEventListener("abort", abort);
  }
}

interface ValidatorStartContext {
  readonly deps: FixtureDependencies;
  readonly paths: Awaited<ReturnType<RunStorePort["create"]>>;
  readonly tools: Awaited<ReturnType<ToolResolverPort["resolve"]>>;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly genesisMint: string;
}

async function startValidatorWithPortRetry(context: ValidatorStartContext): Promise<{ readonly validator: Awaited<ReturnType<ValidatorPort["start"]>>; readonly portLease: PortLease }> {
  const { deps, paths, tools, env, signal, genesisMint } = context;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const portLease = await deps.ports.allocate();
    try {
      const validator = await deps.validator.start({
        executable: tools.validator, ledger: paths.ledger, config: paths.config, genesisMint,
        tokenProgram: tools.tokenProgram, associatedTokenProgram: tools.associatedTokenProgram,
        rpcPort: portLease.rpcPort, faucetPort: portLease.faucetPort, gossipPort: portLease.gossipPort,
        dynamicPortRange: portLease.dynamicPortRange, env, signal, leaseToken: paths.leaseToken,
        registerIdentity: async (identity) => await deps.store.registerValidator(paths, identity),
      });
      return { validator, portLease };
    } catch (cause) {
      await portLease.release();
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

export function assertFixtureAmount(value: bigint): void {
  if (value !== FIXTURE_AMOUNT_BASE_UNITS) { throw new LocalSolanaError("SOLANA_AMOUNT", "fixture amount is immutable"); }
}
