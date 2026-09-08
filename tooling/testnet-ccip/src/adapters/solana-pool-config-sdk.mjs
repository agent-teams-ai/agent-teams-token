import { loadSolanaProvider, createSolanaTransactionSdk } from "./solana-transaction-sdk.mjs";
import { createSolanaPoolInitSdk } from "./solana-pool-init-sdk.mjs";
import { createSolanaRegistrationSdk } from "./solana-registration-sdk.mjs";
import { createPoolConfigStateVerifier } from "./solana-pool-config-state.mjs";
import { BURNMINT_PROGRAM, POOL_GLOBAL } from "../domain/solana-pool-init.ts";
import { ROUTER_PROGRAM } from "../domain/solana-registration.ts";
import { SEPOLIA_SELECTOR, FEE_QUOTER_PROGRAM, ALT_PROGRAM, poolConfigInstructions, verifySolanaPoolConfigIntent, u64 } from "../domain/solana-pool-config.ts";
  function snapshotAddresses(e) { return [e.mint, e.pool, e.ata, e.registry, POOL_GLOBAL, e.routerConfig, e.chain, ...(e.alt ? [e.alt] : [])]; }
export async function createSolanaPoolConfigSdk(providerDirectory) {
  const provider = await loadSolanaProvider(providerDirectory);
  const registrationSdk = await createSolanaRegistrationSdk(providerDirectory);
  const poolSdk = await createSolanaPoolInitSdk(providerDirectory);
  const { PublicKey, TransactionInstruction, Transaction } = provider.web3;
  function derive(input) {
    const registration = registrationSdk.derive({ ...input, operation: "transfer-mint-authority" });
    const mint = new PublicKey(input.mint), program = new PublicKey(BURNMINT_PROGRAM);
    const pda = (seeds, owner) => PublicKey.findProgramAddressSync(seeds, new PublicKey(owner));
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
    return { ...registration, operation: input.operation, chain,
      feeTokenConfig: pda([Buffer.from("fee_billing_token_config"), mint.toBuffer()], FEE_QUOTER_PROGRAM)[0].toBase58(),
      routerPoolSigner: pda([Buffer.from("external_token_pools_signer"), program.toBuffer()], ROUTER_PROGRAM)[0].toBase58(),
      recentSlot, alt, altBump, ...(input.repairRateLimitsBase64 !== undefined ? { repairRateLimitsBase64: input.repairRateLimitsBase64 } : {}) };
  }
  function validate(intent, expected) {
    const canonical = derive(expected);
    for (const field of Object.keys(canonical)) {
      if (canonical[field] !== expected[field]) { throw new Error("Wrong derived pool config identity"); }
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
  function verifySnapshot(values, expected, phase, slot, transactionSlot = 0) {
    validate({ feePayer: expected.payer, instructions: poolConfigInstructions(expected) }, expected);
    return verify(values, expected, phase, slot, transactionSlot);
  }

  return { ...transaction, derive, snapshotAddresses, verifySnapshot };
}
