// @ts-check
import { createHash } from "node:crypto";
import { validateReplacementFixture } from "../domain/replacement-fixture.ts";
import { openTestSdk } from "./test-sdk-admission.ts";
import { selectTestSdk } from "./test-sdk-policy.ts";
import { createSetupSigning } from "./solana-setup-operator.ts";
import { loadSolanaProvider, createSolanaTransactionSdk } from "./solana-transaction-sdk.mjs";
import { verifySolanaPoolInitIntent, BURNMINT_PROGRAM, BURNMINT_PROGRAM_DATA, POOL_GLOBAL } from "../domain/solana-pool-init.ts";
/** @typedef {{build(e: import('../domain/solana-pool-init.ts').SolanaPoolInitExpectation, latest: import('./solana-transaction-sdk.mjs').BlockValidity): import('./solana-setup-operator.ts').PreparedSetup<import('../domain/solana-pool-init.ts').SolanaPoolInitEnvelope>, inspectSigned(bytes: string, e: import('../domain/solana-pool-init.ts').SolanaPoolInitExpectation): import('./solana-setup-operator.ts').InspectedSetup<import('../domain/solana-pool-init.ts').SolanaPoolInitEnvelope>, destroy(): Promise<void>, verifyState(bytes: string, e: import('../domain/solana-pool-init.ts').SolanaPoolInitExpectation): import('../application/solana-pool-init-journal.ts').PoolStateEvidence, verifyGlobal(bytes: string): void}} UnsignedPoolInitSdk */
/** @overload @param {string} providerDirectory @param {import('./test-sdk-policy.ts').ExplicitTestSdkSelection} selection @returns {Promise<UnsignedPoolInitSdk>} */
/** @overload @param {string} providerDirectory @param {import('./test-sdk-policy.ts').TestSdkSelection} [selection] @returns {Promise<UnsignedPoolInitSdk | ReturnType<typeof createPoolInitSdk>>} */
/** @param {string} providerDirectory @param {import('./test-sdk-policy.ts').TestSdkSelection} [selection] */
export async function createSolanaPoolInitSdk(providerDirectory, selection = {}) {
  const selected = selectTestSdk(selection, providerDirectory, selection.fixture === undefined ? undefined : validateReplacementFixture(selection.fixture));
  if (selected) {
    return (await materializePoolInit(providerDirectory, selected)).sdk;
  }
  const provider = await loadSolanaProvider(providerDirectory);
  return createPoolInitSdk(provider);
}
/** @param {string} directory @param {import('./test-sdk-policy.ts').SelectedTestSdk} selected */
async function materializePoolInit(directory, selected) {
  const session = await openTestSdk({ root: directory, archives: selected.archives });
  try {
    const sdk = createPoolInitSdk(session.native);
    const owner = createSetupSigning(sdk, session.assertHealthy, session.close);
    /** @type {UnsignedPoolInitSdk} */
    const sdkView = Object.freeze({
        build: owner.build,
        inspectSigned: /** @param {Parameters<typeof sdk.inspectSigned>} args */ (...args) => { owner.assertOpen(); const value = sdk.inspectSigned(...args); owner.assertOpen(); return value; },
        verifyState: /** @param {Parameters<typeof sdk.verifyState>} args */ (...args) => { owner.assertOpen(); const value = sdk.verifyState(...args); owner.assertOpen(); return value; },
        verifyGlobal: /** @param {Parameters<typeof sdk.verifyGlobal>} args */ (...args) => { owner.assertOpen(); sdk.verifyGlobal(...args); owner.assertOpen(); },
        destroy: owner.destroy,
      });
    return Object.freeze({ sdk: sdkView, acquireSigner: owner.acquireSigner });
  } catch { session.close(); throw new Error("TEST PoolInit construction failed"); }
}
/** @param {string} directory @param {import('./test-sdk-policy.ts').ExplicitTestSdkSelection} selection */
export async function createSolanaPoolInitOperatorAttempt(directory, selection) {
  const selected = selectTestSdk(selection, directory, validateReplacementFixture(selection.fixture));
  if (!selected) { throw new Error("Explicit TEST operator selection required"); }
  return materializePoolInit(directory, selected);
}
/** @param {import('./solana-transaction-sdk.mjs').NativeProvider} provider */
export function createPoolInitSdk(provider) {
  const { PublicKey, SystemProgram, TransactionInstruction } = provider.web3;
  const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = provider.spl;
  const program = new PublicKey(BURNMINT_PROGRAM);
  /** @param {import('../domain/solana-pool-init.ts').SolanaPoolInitExpectation} expected */
  function addresses(expected) {
    const mint = new PublicKey(expected.mint);
    const pool = PublicKey.findProgramAddressSync([Buffer.from("ccip_tokenpool_config"), mint.toBuffer()], program)[0];
    if (pool.toBase58() !== expected.pool) { throw new Error("Wrong pool PDA"); }
    const signer = PublicKey.findProgramAddressSync([Buffer.from("ccip_tokenpool_signer"), mint.toBuffer()], program)[0];
    return { mint, pool, signer, ata: getAssociatedTokenAddressSync(mint, signer, true) };
  }
  const { build, sign, inspectSigned, inspectPrepared } = createSolanaTransactionSdk(provider,
    (intent, /** @type {import('../domain/solana-pool-init.ts').SolanaPoolInitExpectation} */expected) => { addresses(expected); return verifySolanaPoolInitIntent(intent, expected); },
    expected => {
      addresses(expected);
      const keys = [expected.pool, expected.mint, expected.payer, SystemProgram.programId.toBase58(), BURNMINT_PROGRAM, BURNMINT_PROGRAM_DATA, POOL_GLOBAL];
      return new TransactionInstruction({ programId: program, data: Buffer.from("afaf6d1f0d989bed", "hex"),
        keys: keys.map((address, i) => ({ pubkey: new PublicKey(address), isSigner: i === 2, isWritable: i === 0 || i === 2 })) });
    });
  /** @param {string} bytesBase64 @param {import('../domain/solana-pool-init.ts').SolanaPoolInitExpectation} expected */
  function verifyState(bytesBase64, expected) {
    const a = addresses(expected), data = Buffer.from(bytesBase64, "base64");
    const discriminator = createHash("sha256").update("account:State").digest().subarray(0, 8);
    const key = (/** @type {number} */offset) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    // Pinned official State: version followed by BaseConfig. Never accept a mint-only success.
    if (data.toString("base64") !== bytesBase64 || data.length !== 368 || !data.subarray(0, 8).equals(discriminator) || data[8] !== 1 ||
      key(9) !== TOKEN_PROGRAM_ID.toBase58() || key(41) !== expected.mint || data[73] !== 9 ||
      key(74) !== a.signer.toBase58() || key(106) !== a.ata.toBase58() || key(138) !== expected.payer ||
      key(170) !== SystemProgram.programId.toBase58() || key(202) !== expected.payer ||
      key(266) !== "Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C" ||
      key(234) !== PublicKey.findProgramAddressSync([Buffer.from("external_token_pools_signer"), program.toBuffer()], new PublicKey(key(266)))[0].toBase58() ||
      key(298) !== SystemProgram.programId.toBase58() || data[330] !== 0 || data[331] !== 0 || data.readUInt32LE(332) !== 0 ||
      key(336) !== "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7") { throw new Error("Wrong initialized pool state"); }
    return { address: expected.pool, mint: expected.mint, owner: expected.payer, verified: /** @type {const} */ (true) };
  }
  /** @param {string} bytesBase64 */
  function verifyGlobal(bytesBase64) {
    const data = Buffer.from(bytesBase64, "base64");
    if (data.toString("base64") !== bytesBase64 || data.length !== 74 ||
      !data.subarray(0, 8).equals(createHash("sha256").update("account:PoolConfig").digest().subarray(0, 8)) ||
      data[8] !== 1 || data[9] !== 1 ||
      new PublicKey(data.subarray(10, 42)).toBase58() !== "Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C" ||
      new PublicKey(data.subarray(42, 74)).toBase58() !== "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7") {
      throw new Error("Wrong pool global configuration");
    }
  }
  return { build, sign, inspectSigned, inspectPrepared, verifyState, verifyGlobal };
}
