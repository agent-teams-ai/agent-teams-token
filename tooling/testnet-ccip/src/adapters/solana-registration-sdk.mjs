import { createHash } from "node:crypto";
import { loadSolanaProvider, createSolanaTransactionSdk } from "./solana-transaction-sdk.mjs";
import { createSolanaPoolInitSdk } from "./solana-pool-init-sdk.mjs";
import { BURNMINT_PROGRAM, POOL_GLOBAL } from "../domain/solana-pool-init.ts";
import { ROUTER_PROGRAM, registrationInstruction, verifySolanaRegistrationIntent } from "../domain/solana-registration.ts";
  function anchor(data, name, size) {
    if (data.length !== size || !data.subarray(0, 8).equals(createHash("sha256").update("account:" + name).digest().subarray(0, 8)) || data[8] !== 1) {
      throw new Error("Wrong " + name + " layout");
    }
  }
  function snapshotAddresses(expected) { return [expected.mint, expected.pool, expected.ata, expected.registry, POOL_GLOBAL, expected.routerConfig]; }
export async function createSolanaRegistrationSdk(providerDirectory) {
  const provider = await loadSolanaProvider(providerDirectory);
  const poolSdk = await createSolanaPoolInitSdk(providerDirectory);
  const { PublicKey, SystemProgram, TransactionInstruction } = provider.web3;
  const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackMint, unpackAccount } = provider.spl;
  const zero = SystemProgram.programId.toBase58();
  function derive(expected) {
    const mint = new PublicKey(expected.mint), program = new PublicKey(BURNMINT_PROGRAM), router = new PublicKey(ROUTER_PROGRAM);
    const pda = (seed, owner) => PublicKey.findProgramAddressSync([Buffer.from(seed), mint.toBuffer()], owner)[0];
    const pool = pda("ccip_tokenpool_config", program).toBase58();
    if (expected.pool !== pool) { throw new Error("Wrong registration pool PDA"); }
    const signer = pda("ccip_tokenpool_signer", program);
    return { testOnly: expected.testOnly, cluster: expected.cluster, payer: expected.payer, mint: expected.mint,
      pool, operation: expected.operation, signer: signer.toBase58(), ata: getAssociatedTokenAddressSync(mint, signer, true).toBase58(),
      registry: pda("token_admin_registry", router).toBase58(),
      routerConfig: PublicKey.findProgramAddressSync([Buffer.from("config")], router)[0].toBase58() };
  }
  function validate(intent, expected) {
    const derived = derive(expected);
    for (const key of ["signer", "ata", "registry", "routerConfig"]) {
      if (expected[key] !== derived[key]) { throw new Error("Wrong derived registration address"); }
    }
    return verifySolanaRegistrationIntent(intent, expected);
  }
  const transaction = createSolanaTransactionSdk(provider, validate, expected => {
    const ix = registrationInstruction(expected);
    validate({ feePayer: expected.payer, instructions: [ix] }, expected);
    return new TransactionInstruction({ programId: new PublicKey(ix.programId), data: Buffer.from(ix.dataBase64, "base64"),
      keys: ix.accounts.map(a => ({ pubkey: new PublicKey(a.address), isSigner: a.isSigner, isWritable: a.isWritable })) });
  });
  function account(raw, owner) {
    if (!raw || raw.owner !== owner || raw.executable !== false || !Array.isArray(raw.data) || raw.data.length !== 2 ||
      raw.data[1] !== "base64" || typeof raw.data[0] !== "string") { throw new Error("Wrong registration account owner or encoding"); }
    const data = Buffer.from(raw.data[0], "base64");
    if (data.toString("base64") !== raw.data[0]) { throw new Error("Noncanonical account data"); }
    return { ...raw, data, owner: new PublicKey(owner) };
  }
  const key = (data, offset) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  function verifyMint(mintRaw, expected, before) {
    const tokenProgram = TOKEN_PROGRAM_ID.toBase58();
    const mintAccount = account(mintRaw, tokenProgram);
    if (mintAccount.data.length !== 82 || mintAccount.data.readUInt32LE(0) !== 1 || mintAccount.data.readUInt32LE(46) !== 0 || mintAccount.data[45] !== 1) { throw new Error("Wrong mint layout"); }
    const mint = unpackMint(new PublicKey(expected.mint), mintAccount, TOKEN_PROGRAM_ID);
    const authority = mint.mintAuthority?.toBase58();
    const validAuthority = before ? authority === expected.payer : expected.operation === "transfer-mint-authority" ? authority === expected.signer : [expected.payer, expected.signer].includes(authority);
    if (!mint.isInitialized || mint.decimals !== 9 || mint.supply !== 0n || mint.freezeAuthority !== null ||
      !validAuthority) { throw new Error("Wrong finalized mint prerequisite or outcome"); }
  }
  function verifyAta(ataRaw, expected, before) {
    const tokenProgram = TOKEN_PROGRAM_ID.toBase58(), op = expected.operation;
    if (before && op === "create-token-account") {
      if (ataRaw !== null) { throw new Error("ATA already exists; reconcile its original journal"); }
    } else {
      const ataAccount = account(ataRaw, tokenProgram);
      if (ataAccount.data.length !== 165 || ataAccount.data[108] !== 1) { throw new Error("Wrong ATA layout"); }
      const ata = unpackAccount(new PublicKey(expected.ata), ataAccount, TOKEN_PROGRAM_ID);
      if (ata.mint.toBase58() !== expected.mint || ata.owner.toBase58() !== expected.signer || !ata.isInitialized || ata.isFrozen ||
        ata.amount !== 0n || ata.delegate !== null || ata.delegatedAmount !== 0n || ata.closeAuthority !== null || ata.isNative) { throw new Error("Wrong pool ATA"); }
    }
  }
  function verifyRegistry(registryRaw, expected, before) {
    const op = expected.operation;
    if (before && (op === "create-token-account" || op === "owner-propose-administrator")) {
      if (registryRaw !== null) { throw new Error("Registry already exists; reconcile registration journal"); }
    } else if (registryRaw === null && !before && op === "create-token-account") {
      // This first checkpoint precedes the registry operation.
    } else {
      const registry = account(registryRaw, ROUTER_PROGRAM).data;
      anchor(registry, "TokenAdminRegistry", 169);
      const administrator = key(registry, 9), pending = key(registry, 41);
      const proposed = administrator === zero && pending === expected.payer;
      const accepted = administrator === expected.payer && pending === zero;
      if (key(registry, 137) !== expected.mint || key(registry, 73) !== zero || !registry.subarray(105, 137).equals(Buffer.alloc(32)) ||
        (before && op === "accept-admin-role" ? !proposed : op === "transfer-mint-authority" || op === "accept-admin-role" ? !accepted : !proposed && !accepted)) {
        throw new Error("Wrong registry administrator or configuration");
      }
    }
  }
  function verifySnapshot(values, expected, phase) {
    validate({ feePayer: expected.payer, instructions: [registrationInstruction(expected)] }, expected);
    if (!["before", "after"].includes(phase) || !Array.isArray(values) || values.length !== 6) { throw new Error("Incomplete registration snapshot"); }
    const [mintRaw, poolRaw, ataRaw, registryRaw, globalRaw, configRaw] = values;
    const before = phase === "before", op = expected.operation;
    verifyMint(mintRaw, expected, before);
    poolSdk.verifyState(account(poolRaw, BURNMINT_PROGRAM).data.toString("base64"), expected);
    poolSdk.verifyGlobal(account(globalRaw, BURNMINT_PROGRAM).data.toString("base64"));
    const config = account(configRaw, ROUTER_PROGRAM).data;
    anchor(config, "Config", 210);
    if (config[9] !== 1 || config.readBigUInt64LE(10) !== 16423721717087811551n ||
      key(config, 82) !== "FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi" ||
      key(config, 114) !== "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7") { throw new Error("Wrong router config"); }
    verifyAta(ataRaw, expected, before);
    verifyRegistry(registryRaw, expected, before);
    return { operation: op, mint: expected.mint, verified: true };
  }

  return { ...transaction, derive, snapshotAddresses, verifySnapshot };
}
