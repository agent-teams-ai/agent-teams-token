// @ts-check
import { validateReplacementFixture } from "../domain/replacement-fixture.ts";
import { openTestSdk } from "./test-sdk-admission.ts";
import { selectTestSdk } from "./test-sdk-policy.ts";
import { createSetupSigning } from "./solana-setup-operator.ts";
import { createHash } from "node:crypto";
import { loadSolanaProvider, createSolanaTransactionSdk } from "./solana-transaction-sdk.mjs";
import { createSolanaPoolInitSdk, createPoolInitSdk } from "./solana-pool-init-sdk.mjs";
import { BURNMINT_PROGRAM, POOL_GLOBAL } from "../domain/solana-pool-init.ts";
import { ROUTER_PROGRAM, registrationInstruction, verifySolanaRegistrationIntent } from "../domain/solana-registration.ts";
/** @typedef {import('../domain/solana-registration.ts').SolanaRegistrationExpectation} Expectation */
/** @typedef {import('./solana-transaction-sdk.mjs').RpcAccount | null | undefined} Account */
  /** @param {Buffer} data @param {string} name @param {number} size @param {number} [version] */
  function anchor(data, name, size, version = 1) {
    if (data.length !== size || !data.subarray(0, 8).equals(createHash("sha256").update("account:" + name).digest().subarray(0, 8)) || data[8] !== version) {
      throw new Error("Wrong " + name + " layout");
    }
  }
  /** @param {Expectation} expected */
  function snapshotAddresses(expected) { return [expected.mint, expected.pool, expected.ata, expected.registry, POOL_GLOBAL, expected.routerConfig]; }
/** @typedef {import('../domain/solana-pool-init.ts').SolanaPoolInitExpectation & {readonly operation: import('../domain/solana-registration.ts').RegistrationOperation}} RegistrationInput */
/** @typedef {{readonly administrator: string, readonly pendingAdministrator: string, readonly lookupTable: string, readonly writableIndexes: string, readonly mint: string, readonly supportsAutoDerivation: boolean}} RegistryState */
/** @typedef {{derive(e: RegistrationInput): Expectation, inspectSigned(bytes: string, e: Expectation): import('./solana-setup-operator.ts').InspectedSetup<import('../domain/solana-registration.ts').SolanaRegistrationEnvelope>, snapshotAddresses(e: Expectation): string[], decodeRegistry(raw: Account): RegistryState, verifySnapshot(values: readonly Account[], e: Expectation, phase: 'before' | 'after'): import('../application/solana-registration-journal.ts').RegistrationStateEvidence}} RegistrationPredecessorVerifier */
/** @typedef {{build(e: import('../domain/solana-registration.ts').SolanaRegistrationExpectation, latest: import('./solana-transaction-sdk.mjs').BlockValidity): import('./solana-setup-operator.ts').PreparedSetup<import('../domain/solana-registration.ts').SolanaRegistrationEnvelope>, inspectSigned(bytes: string, e: import('../domain/solana-registration.ts').SolanaRegistrationExpectation): import('./solana-setup-operator.ts').InspectedSetup<import('../domain/solana-registration.ts').SolanaRegistrationEnvelope>, destroy(): Promise<void>, derive(e: RegistrationInput): Expectation, snapshotAddresses(e: Expectation): string[], decodeRegistry(raw: Account): RegistryState, verifySnapshot(values: readonly Account[], e: Expectation, phase: 'before' | 'after'): import('../application/solana-registration-journal.ts').RegistrationStateEvidence}} UnsignedRegistrationSdk */
/** @overload @param {string} providerDirectory @param {import('./test-sdk-policy.ts').ExplicitTestSdkSelection} selection @returns {Promise<UnsignedRegistrationSdk>} */
/** @overload @param {string} providerDirectory @param {import('./test-sdk-policy.ts').TestSdkSelection} [selection] @returns {Promise<UnsignedRegistrationSdk | ReturnType<typeof createRegistrationSdk>>} */
/** @param {string} providerDirectory @param {import('./test-sdk-policy.ts').TestSdkSelection} [selection] */
export async function createSolanaRegistrationSdk(providerDirectory, selection = {}) {
  const selected = selectTestSdk(selection, providerDirectory, selection.fixture === undefined ? undefined : validateReplacementFixture(selection.fixture));
  if (selected) {
    return (await materializeRegistration(providerDirectory, selected)).sdk;
  }
  const provider = await loadSolanaProvider(providerDirectory);
  const poolSdk = await createSolanaPoolInitSdk(providerDirectory);
  return createRegistrationSdk(provider, poolSdk);
}
/** @param {string} directory @param {import('./test-sdk-policy.ts').SelectedTestSdk} selected */
async function materializeRegistration(directory, selected) {
  const session = await openTestSdk({ root: directory, archives: selected.archives });
  try {
    const pool = createPoolInitSdk(session.native), sdk = createRegistrationSdk(session.native, pool);
    const owner = createSetupSigning(sdk, session.assertHealthy, session.close);
    /** @type {UnsignedRegistrationSdk} */
    const sdkView = Object.freeze({
        build: owner.build,
        inspectSigned: /** @param {Parameters<typeof sdk.inspectSigned>} args */ (...args) => { owner.assertOpen(); const value = sdk.inspectSigned(...args); owner.assertOpen(); return value; },
        derive: /** @param {Parameters<typeof sdk.derive>} args */ (...args) => { owner.assertOpen(); const value = sdk.derive(...args); owner.assertOpen(); return value; },
        snapshotAddresses: /** @param {Parameters<typeof snapshotAddresses>} args */ (...args) => { owner.assertOpen(); const value = snapshotAddresses(...args); owner.assertOpen(); return value; },
        decodeRegistry: /** @param {Parameters<typeof sdk.decodeRegistry>} args */ (...args) => { owner.assertOpen(); const value = sdk.decodeRegistry(...args); owner.assertOpen(); return value; },
        verifySnapshot: /** @param {Parameters<typeof sdk.verifySnapshot>} args */ (...args) => { owner.assertOpen(); const value = sdk.verifySnapshot(...args); owner.assertOpen(); return value; },
        destroy: owner.destroy,
      });
    return Object.freeze({ sdk: sdkView, acquireSigner: owner.acquireSigner });
  } catch { session.close(); throw new Error("TEST Registration construction failed"); }
}
/** @param {string} directory @param {import('./test-sdk-policy.ts').ExplicitTestSdkSelection} selection */
export async function createSolanaRegistrationOperatorAttempt(directory, selection) {
  const selected = selectTestSdk(selection, directory, validateReplacementFixture(selection.fixture));
  if (!selected) { throw new Error("Explicit TEST operator selection required"); }
  return materializeRegistration(directory, selected);
}
/** @param {import('./solana-transaction-sdk.mjs').NativeProvider} provider @param {Pick<ReturnType<typeof createPoolInitSdk>, 'verifyState' | 'verifyGlobal'>} poolSdk */
export function createRegistrationSdk(provider, poolSdk) {
  const { PublicKey, SystemProgram, TransactionInstruction } = provider.web3;
  const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackMint, unpackAccount } = provider.spl;
  const zero = SystemProgram.programId.toBase58();
  /** @param {import('../domain/solana-pool-init.ts').SolanaPoolInitExpectation & {operation: Expectation['operation']}} expected */
  function derive(expected) {
    const fixture = expected.fixture === undefined ? undefined : validateReplacementFixture(expected.fixture);
    if (fixture && (expected.payer !== fixture.payer || expected.mint !== fixture.mint || expected.pool !== fixture.solanaPool)) { throw new Error("Wrong registration fixture"); }
    const mint = new PublicKey(expected.mint), program = new PublicKey(BURNMINT_PROGRAM), router = new PublicKey(ROUTER_PROGRAM);
    const pda = (/** @type {string} */seed, /** @type {InstanceType<typeof PublicKey>} */owner) => PublicKey.findProgramAddressSync([Buffer.from(seed), mint.toBuffer()], owner)[0];
    const pool = pda("ccip_tokenpool_config", program).toBase58();
    if (expected.pool !== pool) { throw new Error("Wrong registration pool PDA"); }
    const signer = pda("ccip_tokenpool_signer", program);
    return { ...(fixture ? { fixture } : {}), testOnly: expected.testOnly, cluster: expected.cluster, payer: expected.payer, mint: expected.mint,
      pool, operation: expected.operation, signer: signer.toBase58(), ata: getAssociatedTokenAddressSync(mint, signer, true).toBase58(),
      registry: pda("token_admin_registry", router).toBase58(),
      routerConfig: PublicKey.findProgramAddressSync([Buffer.from("config")], router)[0].toBase58() };
  }
  /** @param {import('../domain/solana-mint.ts').SolanaMintIntent} intent @param {Expectation} expected */
  function validate(intent, expected) {
    const derived = derive(expected);
    for (const key of /** @type {const} */(["signer", "ata", "registry", "routerConfig"])) {
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
  /** @param {Account} raw @param {string} owner */
  function account(raw, owner) {
    if (!raw || raw.owner !== owner || raw.executable !== false || !Array.isArray(raw.data) || raw.data.length !== 2 ||
      raw.data[1] !== "base64" || typeof raw.data[0] !== "string") { throw new Error("Wrong registration account owner or encoding"); }
    const data = Buffer.from(raw.data[0], "base64");
    if (data.toString("base64") !== raw.data[0]) { throw new Error("Noncanonical account data"); }
    return { ...raw, data, owner: new PublicKey(owner) };
  }
  const key = (/** @type {Buffer} */data, /** @type {number} */offset) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  /** @param {Account} rawRpcAccount */
  function decodeRegistry(rawRpcAccount) {
    const data = account(rawRpcAccount, ROUTER_PROGRAM).data;
    anchor(data, "TokenAdminRegistry", 170, 2);
    if (data[169] !== 0 && data[169] !== 1) { throw new Error("Wrong TokenAdminRegistry boolean"); }
    return { administrator: key(data, 9), pendingAdministrator: key(data, 41), lookupTable: key(data, 73),
      writableIndexes: "0x" + data.subarray(105, 137).toString("hex"), mint: key(data, 137), supportsAutoDerivation: data[169] === 1 };
  }
  /** @param {Account} mintRaw @param {Expectation} expected @param {boolean} before */
  function verifyMint(mintRaw, expected, before) {
    const tokenProgram = TOKEN_PROGRAM_ID.toBase58();
    const mintAccount = account(mintRaw, tokenProgram);
    if (mintAccount.data.length !== 82 || mintAccount.data.readUInt32LE(0) !== 1 || mintAccount.data.readUInt32LE(46) !== 0 || mintAccount.data[45] !== 1) { throw new Error("Wrong mint layout"); }
    const mint = unpackMint(new PublicKey(expected.mint), mintAccount, TOKEN_PROGRAM_ID);
    const authority = mint.mintAuthority?.toBase58();
    const validAuthority = before ? authority === expected.payer : expected.operation === "transfer-mint-authority" ? authority === expected.signer : authority !== undefined && [expected.payer, expected.signer].includes(authority);
    if (!mint.isInitialized || mint.decimals !== 9 || mint.supply !== 0n || mint.freezeAuthority !== null ||
      !validAuthority) { throw new Error("Wrong finalized mint prerequisite or outcome"); }
  }
  /** @param {Account} ataRaw @param {Expectation} expected @param {boolean} before */
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
  /** @param {Account} registryRaw @param {Expectation} expected @param {boolean} before */
  function verifyRegistry(registryRaw, expected, before) {
    const op = expected.operation;
    if (before && (op === "create-token-account" || op === "owner-propose-administrator")) {
      if (registryRaw !== null) { throw new Error("Registry already exists; reconcile registration journal"); }
    } else if (registryRaw === null && !before && op === "create-token-account") {
      // This first checkpoint precedes the registry operation.
    } else {
      const registry = decodeRegistry(registryRaw);
      const { administrator, pendingAdministrator: pending } = registry;
      const proposed = administrator === zero && pending === expected.payer;
      const accepted = administrator === expected.payer && pending === zero;
      if (registry.mint !== expected.mint || registry.lookupTable !== zero || registry.writableIndexes !== "0x" + "00".repeat(32) || registry.supportsAutoDerivation ||
        (before && op === "accept-admin-role" ? !proposed : op === "transfer-mint-authority" || op === "accept-admin-role" ? !accepted : !proposed && !accepted)) {
        throw new Error("Wrong registry administrator or configuration");
      }
    }
  }
  /** @param {readonly Account[]} values @param {Expectation} expected @param {'before' | 'after'} phase */
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
    return { operation: op, mint: expected.mint, verified: /** @type {const} */ (true) };
  }

  return { ...transaction, derive, snapshotAddresses, decodeRegistry, verifySnapshot };
}
