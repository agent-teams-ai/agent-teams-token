// @ts-check
import { validateReplacementFixture } from "../domain/replacement-fixture.ts";
import { openTestSdk } from "./test-sdk-admission.ts";
import { selectTestSdk } from "./test-sdk-policy.ts";
import { loadSolanaProvider, createSolanaTransactionSdk } from "./solana-transaction-sdk.mjs";
import { createSolanaPoolInitSdk, createPoolInitSdk } from "./solana-pool-init-sdk.mjs";
import { createSolanaRegistrationSdk, createRegistrationSdk } from "./solana-registration-sdk.mjs";
import { createPoolConfigStateVerifier } from "./solana-pool-config-state.mjs";
import { BURNMINT_PROGRAM, POOL_GLOBAL } from "../domain/solana-pool-init.ts";
import { ROUTER_PROGRAM } from "../domain/solana-registration.ts";
import { SEPOLIA_SELECTOR, FEE_QUOTER_PROGRAM, ALT_PROGRAM, poolConfigInstructions, verifySolanaPoolConfigIntent, u64 } from "../domain/solana-pool-config.ts";
/** @typedef {import('../domain/solana-pool-config.ts').SolanaPoolConfigExpectation} Expectation */
/** @typedef {import('../domain/solana-pool-init.ts').SolanaPoolInitExpectation & {operation: Expectation['operation'], recentSlot?: string | null, repairRateLimitsBase64?: string}} ConfigInput */
  /** @param {Expectation} e */
  function snapshotAddresses(e) { return [e.mint, e.pool, e.ata, e.registry, POOL_GLOBAL, e.routerConfig, e.chain, ...(e.alt ? [e.alt] : [])]; }
/** @param {string} providerDirectory @param {import('./test-sdk-policy.ts').TestSdkSelection} [selection] */
export async function createSolanaPoolConfigSdk(providerDirectory, selection = {}) {
  const selected = selectTestSdk(selection, providerDirectory, selection.fixture === undefined ? undefined : validateReplacementFixture(selection.fixture));
  if (selected) {
    const session = await openTestSdk({ root: providerDirectory, archives: selected.archives });
    try {
      const pool = createPoolInitSdk(session.native), registration = createRegistrationSdk(session.native, pool);
      const sdk = createPoolConfigSdk(session.native, registration, pool);
      const registrationVerifier = Object.freeze({
        derive: /** @param {Parameters<typeof registration.derive>} args */ (...args) => { session.assertHealthy(); const value = registration.derive(...args); session.assertHealthy(); return value; },
        snapshotAddresses: /** @param {Parameters<typeof registration.snapshotAddresses>} args */ (...args) => { session.assertHealthy(); return registration.snapshotAddresses(...args); },
        decodeRegistry: /** @param {Parameters<typeof registration.decodeRegistry>} args */ (...args) => { session.assertHealthy(); const value = registration.decodeRegistry(...args); session.assertHealthy(); return value; },
        verifySnapshot: /** @param {Parameters<typeof registration.verifySnapshot>} args */ (...args) => { session.assertHealthy(); const value = registration.verifySnapshot(...args); session.assertHealthy(); return value; },
      });
      return Object.freeze({
        build: /** @param {Parameters<typeof sdk.build>} args */ (...args) => { session.assertHealthy(); const value = sdk.build(...args); session.assertHealthy(); return value; },
        inspectSigned: /** @param {Parameters<typeof sdk.inspectSigned>} args */ (...args) => { session.assertHealthy(); const value = sdk.inspectSigned(...args); session.assertHealthy(); return value; },
        derive: /** @param {Parameters<typeof sdk.derive>} args */ (...args) => { session.assertHealthy(); const value = sdk.derive(...args); session.assertHealthy(); return value; },
        snapshotAddresses: /** @param {Parameters<typeof snapshotAddresses>} args */ (...args) => { session.assertHealthy(); return snapshotAddresses(...args); },
        verifySnapshot: /** @param {Parameters<typeof sdk.verifySnapshot>} args */ (...args) => { session.assertHealthy(); const value = sdk.verifySnapshot(...args); session.assertHealthy(); return value; },
        registrationVerifier, destroy: async () => session.close(),
      });
    } catch (error) { session.close(); throw error; }
  }
  const provider = await loadSolanaProvider(providerDirectory);
  const registrationSdk = await createSolanaRegistrationSdk(providerDirectory);
  const poolSdk = await createSolanaPoolInitSdk(providerDirectory);
  return createPoolConfigSdk(provider, registrationSdk, poolSdk);
}
/** @param {import('./solana-transaction-sdk.mjs').NativeProvider} provider @param {Pick<ReturnType<typeof createRegistrationSdk>, 'derive' | 'decodeRegistry'>} registrationSdk @param {Pick<ReturnType<typeof createPoolInitSdk>, 'verifyState' | 'verifyGlobal'>} poolSdk */
export function createPoolConfigSdk(provider, registrationSdk, poolSdk) {
  const { PublicKey, TransactionInstruction, Transaction } = provider.web3;
  /** @param {ConfigInput} input @returns {Expectation} */
  function derive(input) {
    const fixture = input.fixture === undefined ? undefined : validateReplacementFixture(input.fixture);
    if (fixture && (input.payer !== fixture.payer || input.mint !== fixture.mint || input.pool !== fixture.solanaPool)) { throw new Error("Wrong selected pool config identity"); }
    const registration = registrationSdk.derive({ ...input, operation: "transfer-mint-authority" });
    const mint = new PublicKey(input.mint), program = new PublicKey(BURNMINT_PROGRAM);
    const pda = (/** @type {Buffer[]} */seeds, /** @type {ConstructorParameters<typeof PublicKey>[0]} */owner) => PublicKey.findProgramAddressSync(seeds, new PublicKey(owner));
    const chain = pda([Buffer.from("ccip_tokenpool_chainconfig"), u64(SEPOLIA_SELECTOR), mint.toBuffer()], program)[0].toBase58();
    let recentSlot = null, alt = null, altBump = null;
    if (["create-lookup-table", "set-pool", "repair-remote-pool-encoding"].includes(input.operation)) {
      if (typeof input.recentSlot !== "string" || !/^[1-9][0-9]*$/.test(input.recentSlot) || BigInt(input.recentSlot) > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Persisted finalized ALT recentSlot required");
      }
      recentSlot = input.recentSlot;
      const derived = pda([new PublicKey(input.payer).toBuffer(), u64(recentSlot)], ALT_PROGRAM);
      alt = derived[0].toBase58(); altBump = derived[1];
    } else if (input.recentSlot !== undefined && input.recentSlot !== null) { throw new Error("Remote config operation does not take ALT recentSlot"); }
    return { ...registration, ...(fixture ? { fixture } : {}), operation: input.operation, chain,
      feeTokenConfig: pda([Buffer.from("fee_billing_token_config"), mint.toBuffer()], FEE_QUOTER_PROGRAM)[0].toBase58(),
      routerPoolSigner: pda([Buffer.from("external_token_pools_signer"), program.toBuffer()], ROUTER_PROGRAM)[0].toBase58(),
      recentSlot, alt, altBump, ...(input.repairRateLimitsBase64 !== undefined ? { repairRateLimitsBase64: input.repairRateLimitsBase64 } : {}) };
  }
  /** @param {import('../domain/solana-mint.ts').SolanaMintIntent} intent @param {Expectation} expected */
  function validate(intent, expected) {
    const canonical = derive(expected);
    for (const [field, value] of Object.entries(canonical)) {
      if (JSON.stringify(value) !== JSON.stringify(Reflect.get(expected, field))) { throw new Error("Wrong derived pool config identity"); }
    }
    return verifySolanaPoolConfigIntent(intent, expected);
  }
  const transaction = createSolanaTransactionSdk(provider, validate, expected => {
    const instructions = poolConfigInstructions(expected);
    validate({ feePayer: expected.payer, instructions }, expected);
    // web3 Transaction.add accepts a Transaction and appends its instructions atomically.
    return new Transaction().add(...instructions.map(ix => new TransactionInstruction({ programId: new PublicKey(ix.programId),
      data: Buffer.from(ix.dataBase64, "base64"), keys: ix.accounts.map(a => ({ pubkey: new PublicKey(a.address), isSigner: a.isSigner, isWritable: a.isWritable })) })));
  });
  const verify = createPoolConfigStateVerifier(provider, poolSdk, registrationSdk);
  /** @param {readonly (import('./solana-transaction-sdk.mjs').RpcAccount | null)[]} values @param {Expectation} expected @param {'before' | 'after'} phase @param {number} slot @param {number} [transactionSlot] */
  function verifySnapshot(values, expected, phase, slot, transactionSlot = 0) {
    validate({ feePayer: expected.payer, instructions: poolConfigInstructions(expected) }, expected);
    verify(values, expected, phase, slot, transactionSlot);
    return { operation: expected.operation, mint: expected.mint, verified: true };
  }

  return { ...transaction, derive, snapshotAddresses, verifySnapshot };
}
