import { FIXTURE_AMOUNT_BASE_UNITS, LocalSolanaError, type FixtureObservations, type TransactionFact } from "../domain/model.ts";
import { verifyObservations } from "./verifier.ts";
import type { AuthorityTransactionPort, CliPort, CommandPort, PortAllocator, RpcPort, RunStorePort, ToolResolverPort, ValidatorPort } from "./ports.ts";

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
  try {
    const tools = await deps.tools.resolve();
    const env = allowlistedEnvironment(deps.environment ?? process.env, paths.directory);
    const keys = await deps.cli.createKeys(paths, tools, env, signal);
    const allocated = await deps.ports.allocate();
    const rpcUrl = `http://127.0.0.1:${allocated.rpcPort}/`;
    validator = await deps.validator.start(tools.validator, paths.ledger, allocated.rpcPort, allocated.faucetPort, env, signal);
    const ready = await deps.rpc.waitReady(rpcUrl, 30_000, signal);
    await deps.cli.fund(rpcUrl, keys.payer, paths, tools, env, signal);
    const createSignature = await deps.cli.createMint(rpcUrl, keys, paths, tools, env, signal);
    const initialMint = await deps.rpc.mintAccount(rpcUrl, keys.mint);
    const revokeSignature = await deps.cli.revokeFreeze(rpcUrl, keys.mint, paths, tools, env, signal);
    const afterRevokeMint = await deps.rpc.mintAccount(rpcUrl, keys.mint);
    const tokenAccount = await deps.cli.createTokenAccount(rpcUrl, keys.mint, keys.owner, paths, tools, env, signal);
    const mintSignature = await deps.cli.mint(rpcUrl, keys.mint, tokenAccount.address, paths, tools, env, signal);
    const afterMint = await deps.rpc.mintAccount(rpcUrl, keys.mint);
    const afterMintTokenAccount = await deps.rpc.tokenAccount(rpcUrl, tokenAccount.address);
    const burnSignature = await deps.cli.burn(rpcUrl, tokenAccount.address, paths, tools, env, signal);
    const finalMint = await deps.rpc.mintAccount(rpcUrl, keys.mint);
    const finalTokenAccount = await deps.rpc.tokenAccount(rpcUrl, tokenAccount.address);

    const restoreBytes = await deps.authorityTransactions.restoreFreeze(deps.rpc, rpcUrl, paths.payerKey, paths.freezeKey, keys.mint, keys.freeze);
    const restoreSignature = await deps.rpc.sendSignedTransaction(rpcUrl, restoreBytes);
    const freezeBytes = await deps.authorityTransactions.freezeAccount(deps.rpc, rpcUrl, paths.payerKey, paths.freezeKey, tokenAccount.address, keys.mint, keys.freeze);
    const freezeSignature = await deps.rpc.sendSignedTransaction(rpcUrl, freezeBytes);
    const genesisAfter = await deps.rpc.genesisHash(rpcUrl);
    const transactionInputs: readonly [TransactionFact["kind"], string][] = [
      ["create", createSignature], ["revokeFreeze", revokeSignature], ["mint", mintSignature], ["burn", burnSignature],
      ["restoreFreezeAttempt", restoreSignature], ["freezeAttempt", freezeSignature],
    ];
    const transactions = await Promise.all(transactionInputs.map(async ([kind, signature]) => await deps.rpc.finalizedTransaction(rpcUrl, kind, signature, ready.genesisHash)));
    const observations: FixtureObservations = {
      schemaVersion: 1, rpcUrl, genesisHashBefore: ready.genesisHash, genesisHashAfter: genesisAfter,
      validatorVersion: ready.version, mintAddress: keys.mint, mintAuthority: keys.mint,
      ownerAddress: keys.owner, tokenAccountAddress: tokenAccount.address, initialMint, afterRevokeMint,
      afterMint, afterMintTokenAccount, finalMint, finalTokenAccount, transactions,
    };
    const report = verifyObservations(observations);
    await validator.stop();
    validator = undefined;
    await deps.store.cleanup(paths);
    return await deps.store.publish(observations, report);
  } finally {
    controller.abort();
    await validator?.stop().catch(() => {});
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
