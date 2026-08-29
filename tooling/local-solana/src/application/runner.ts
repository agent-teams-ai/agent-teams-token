import { ASSOCIATED_TOKEN_PROGRAM, CLASSIC_TOKEN_PROGRAM, FIXTURE_AMOUNT_BASE_UNITS, LocalSolanaError, type FixtureObservations, type TransactionFact } from "../domain/model.ts";
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
  readonly environment?: NodeJS.ProcessEnv;
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
  try {
    const tools = await deps.tools.resolve();
    const env = allowlistedEnvironment(deps.environment ?? process.env, paths.directory);
    const cliContext = { paths, tools, env, signal };
    const keys = await deps.cli.createKeys(cliContext);
    portLease = await deps.ports.allocate();
    const rpcUrl = `http://127.0.0.1:${portLease.rpcPort}/`;
    validator = await deps.validator.start({
      executable: tools.validator, ledger: paths.ledger, config: paths.config, genesisMint: keys.payer,
      tokenProgram: tools.tokenProgram, associatedTokenProgram: tools.associatedTokenProgram,
      rpcPort: portLease.rpcPort, faucetPort: portLease.faucetPort, gossipPort: portLease.gossipPort,
      dynamicPortRange: portLease.dynamicPortRange, env, signal,
    });
    const ready = await deps.rpc.waitReady(rpcUrl, 30_000, signal);
    await deps.rpc.waitProgramsReady(rpcUrl, [CLASSIC_TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM], 30_000, signal);
    await deps.cli.verifyFunded(cliContext, { rpcUrl, payer: keys.payer });
    const createMint = await deps.cli.createMint(cliContext, { rpcUrl, publicKeys: keys });
    const initialMint = await deps.rpc.mintAccount(rpcUrl, keys.mint);
    const revokeSignature = await deps.cli.revokeFreeze(cliContext, { rpcUrl, mint: keys.mint });
    const afterRevokeMint = await deps.rpc.mintAccount(rpcUrl, keys.mint);
    await deps.cli.createTokenAccount(cliContext, { rpcUrl, mint: keys.mint, owner: keys.owner });
    const tokenAccountAddress = await deps.rpc.tokenAccountAddress(rpcUrl, keys.owner, keys.mint);
    const expectedTokenAccountAddress = await deps.cli.associatedAddress(cliContext, { rpcUrl, mint: keys.mint, owner: keys.owner });
    if (tokenAccountAddress !== expectedTokenAccountAddress) { throw new LocalSolanaError("SOLANA_ASSOCIATED_ADDRESS", "created token account is not the derived associated address"); }
    const mintSignature = await deps.cli.mint(cliContext, { rpcUrl, mint: keys.mint, account: tokenAccountAddress });
    const afterMint = await deps.rpc.mintAccount(rpcUrl, keys.mint);
    const afterMintTokenAccount = await deps.rpc.tokenAccount(rpcUrl, tokenAccountAddress);
    const burnSignature = await deps.cli.burn(cliContext, { rpcUrl, account: tokenAccountAddress });
    const finalMint = await deps.rpc.mintAccount(rpcUrl, keys.mint);
    const finalTokenAccount = await deps.rpc.tokenAccount(rpcUrl, tokenAccountAddress);

    const authorityContext = { rpc: deps.rpc, rpcUrl, payerPath: paths.payerKey, authorityPath: paths.freezeKey };
    const restoreBytes = await deps.authorityTransactions.restoreFreeze({ ...authorityContext, mint: keys.mint, newAuthority: keys.freeze });
    const restoreSignature = await deps.rpc.sendSignedTransaction(rpcUrl, restoreBytes);
    const freezeBytes = await deps.authorityTransactions.freezeAccount({ ...authorityContext, account: tokenAccountAddress, mint: keys.mint });
    const freezeSignature = await deps.rpc.sendSignedTransaction(rpcUrl, freezeBytes);
    const genesisAfter = await deps.rpc.genesisHash(rpcUrl);
    const transactionInputs: readonly [TransactionFact["kind"], string][] = [
      ["create", createMint.createSignature], ["assignFreeze", createMint.assignFreezeSignature],
      ["revokeFreeze", revokeSignature], ["mint", mintSignature], ["burn", burnSignature],
      ["restoreFreezeAttempt", restoreSignature], ["freezeAttempt", freezeSignature],
    ];
    const transactions = await Promise.all(transactionInputs.map(async ([kind, signature]) => await deps.rpc.finalizedTransaction(rpcUrl, kind, signature, ready.genesisHash)));
    const observations: FixtureObservations = {
      schemaVersion: 1, rpcUrl, genesisHashBefore: ready.genesisHash, genesisHashAfter: genesisAfter,
      validatorVersion: ready.version, mintAddress: keys.mint, mintAuthority: keys.mint, freezeAuthority: keys.freeze,
      ownerAddress: keys.owner, tokenAccountAddress, initialMint, afterRevokeMint,
      afterMint, afterMintTokenAccount, finalMint, finalTokenAccount, transactions,
    };
    const report = verifyObservations(observations);
    await validator.stop();
    validator = undefined;
    portLease.release();
    portLease = undefined;
    await deps.store.cleanup(paths);
    return await deps.store.publish(observations, report);
  } finally {
    controller.abort();
    await validator?.stop().catch(() => {});
    portLease?.release();
    await deps.store.cleanup(paths).catch(() => {});
    externalSignal?.removeEventListener("abort", abort);
  }
}

export function allowlistedEnvironment(source: NodeJS.ProcessEnv, runDirectory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: runDirectory, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", TMPDIR: runDirectory };
  for (const key of ["SYSTEMROOT", "WINDIR"]) { if (source[key]) { env[key] = source[key]; } }
  return env;
}

export function assertFixtureAmount(value: bigint): void {
  if (value !== FIXTURE_AMOUNT_BASE_UNITS) { throw new LocalSolanaError("SOLANA_AMOUNT", "fixture amount is immutable"); }
}
