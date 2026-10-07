// @ts-check
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { verifySolanaMintIntent } from "../domain/solana-mint.ts";
import { validateReplacementFixture } from "../domain/replacement-fixture.ts";
import { openTestSdk } from "./test-sdk-admission.ts";
import { selectTestSdk } from "./test-sdk-policy.ts";
import { checkSetupPrepared, createSetupSigning } from "./solana-setup-operator.ts";
/** @typedef {import('./solana-transaction-sdk.mjs').NativeProvider} NativeProvider */
/** @typedef {import('../domain/solana-mint.ts').SolanaMintExpectation} Expectation */

/** @param {InstanceType<NativeProvider['web3']['Transaction']>} transaction @param {Expectation} expected */
function decode(transaction, expected) {
  const message = transaction.compileMessage();
  if (message.header.numRequiredSignatures !== 2 || message.accountKeys.length !== 4 ||
    message.accountKeys[0]?.toBase58() !== expected.payer || message.accountKeys[1]?.toBase58() !== expected.mint || !transaction.feePayer) {
    throw new Error("Unexpected mint transaction signers/accounts");
  }
  const intent = {
    feePayer: transaction.feePayer.toBase58(),
    instructions: transaction.instructions.map(ix => ({ programId: ix.programId.toBase58(),
      accounts: ix.keys.map(key => ({ address: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })),
      dataBase64: ix.data.toString("base64") })),
  };
  for (const address of intent.instructions.map(ix => ix.programId)) {
    const index = message.accountKeys.findIndex(key => key.toBase58() === address);
    if (index < 0 || message.isAccountWritable(index) || message.isAccountSigner(index)) { throw new Error("Unexpected mint program privilege"); }
  }
  return { intent, envelope: verifySolanaMintIntent(intent, expected),
    messageBase64: transaction.serializeMessage().toString("base64") };
}

/** @typedef {{build(e: Expectation, latest: import('./solana-transaction-sdk.mjs').BlockValidity): import('./solana-setup-operator.ts').PreparedSetup<import('../domain/solana-mint.ts').SolanaMintEnvelope>, inspectSigned(bytes: string, e: Expectation): import('./solana-setup-operator.ts').InspectedSetup<import('../domain/solana-mint.ts').SolanaMintEnvelope>, destroy(): Promise<void>}} UnsignedMintSdk */
/** @overload @param {string} providerDirectory @param {import('./test-sdk-policy.ts').ExplicitTestSdkSelection} selection @returns {Promise<UnsignedMintSdk>} */
/** @overload @param {string} providerDirectory @param {import('./test-sdk-policy.ts').TestSdkSelection} [selection] @returns {Promise<UnsignedMintSdk | ReturnType<typeof createMintSdk>>} */
/** @param {string} providerDirectory @param {import('./test-sdk-policy.ts').TestSdkSelection} [selection] */
export async function createSolanaMintSdk(providerDirectory, selection = {}) {
  const selected = selectTestSdk(selection, providerDirectory, selection.fixture === undefined ? undefined : validateReplacementFixture(selection.fixture));
  if (selected) {
    return (await materializeMint(providerDirectory, selected)).sdk;
  }
  const root = resolve(providerDirectory);
  const pins = {
    "package.json": "e19ff221b6ea124a2a05c9eefaf41a2d2b077d00689386dff56f482c393dde4d",
    "pnpm-lock.yaml": "5a79e221885ce31a8ae511d009cd60b657b5113f3456557e28f2b923e4ff7a01",
  };
  for (const [file, digest] of Object.entries(pins)) {
    if (createHash("sha256").update(await readFile(resolve(root, file))).digest("hex") !== digest) {
      throw new Error("Official Solana provider pin mismatch");
    }
  }
  const require = createRequire(resolve(root, "package.json"));
  return createMintSdk({ web3: require("@solana/web3.js"), spl: require("@solana/spl-token"), bs58: require("bs58").default });
}
/** @param {string} directory @param {import('./test-sdk-policy.ts').SelectedTestSdk} selected */
async function materializeMint(directory, selected) {
  const session = await openTestSdk({ root: directory, archives: selected.archives });
  try {
    const core = createMintSdk(session.native), owner = createSetupSigning(core, session.assertHealthy, session.close);
    /** @type {UnsignedMintSdk} */
    const sdk = Object.freeze({ build: owner.build,
      inspectSigned: (bytes, e) => { owner.assertOpen(); const value = core.inspectSigned(bytes, e); owner.assertOpen(); return value; },
      destroy: owner.destroy });
    return Object.freeze({ sdk, acquireSigner: owner.acquireSigner });
  } catch { session.close(); throw new Error("TEST mint construction failed"); }
}
/** @param {string} directory @param {import('./test-sdk-policy.ts').ExplicitTestSdkSelection} selection */
export async function createSolanaMintOperatorAttempt(directory, selection) {
  const selected = selectTestSdk(selection, directory, validateReplacementFixture(selection.fixture));
  if (!selected) { throw new Error("Explicit TEST operator selection required"); }
  return materializeMint(directory, selected);
}
/** @param {unknown} raw @returns {number[]} */
function keyBytes(raw) {
        if (!Array.isArray(raw) || raw.length !== 64 || raw.some(v => typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255)) { throw new Error("Invalid test key"); }
        return raw;
}
/** @param {NativeProvider} provider */
export function createMintSdk(provider) {
  const { PublicKey, SystemProgram, Transaction, Keypair } = provider.web3;
  const { createInitializeMint2Instruction, TOKEN_PROGRAM_ID } = provider.spl;
  const { bs58 } = provider;
  /** @param {Expectation} expected @param {import('./solana-transaction-sdk.mjs').BlockValidity} latestBlockhash */
  function build(expected, latestBlockhash) {
    if (!/^[1-9][0-9]*$/.test(latestBlockhash.lastValidBlockHeight)) { throw new Error("Invalid block validity height"); }
    if (new PublicKey(latestBlockhash.blockhash).toBase58() !== latestBlockhash.blockhash) { throw new Error("Invalid blockhash"); }
    const payer = new PublicKey(expected.payer), mint = new PublicKey(expected.mint);
    const rent = BigInt(expected.rentLamports);
    if (rent <= 0n || rent > 10_000_000n) { throw new Error("Invalid mint rent"); }
    const tx = new Transaction({ feePayer: payer, recentBlockhash: latestBlockhash.blockhash });
    tx.add(SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint,
      lamports: Number(rent), space: 82, programId: TOKEN_PROGRAM_ID }));
    tx.add(createInitializeMint2Instruction(mint, 9, payer, null, TOKEN_PROGRAM_ID));
    // Round-trip through compiled bytes so shared signer privileges are inspected correctly.
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const decoded = Transaction.from(bytes);
    return { bytesBase64: bytes.toString("base64"), blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight, ...decode(decoded, expected) };
  }
  /** @param {string} bytesBase64 @param {Expectation} expected */
  function inspectSigned(bytesBase64, expected) {
    const bytes = Buffer.from(bytesBase64, "base64");
    if (!bytes.length || bytes.length > 1232 || bytes.toString("base64") !== bytesBase64) { throw new Error("Invalid mint transaction bytes"); }
    const tx = Transaction.from(bytes);
    if (!tx.verifySignatures(true) || tx.signatures.length !== 2 || !tx.signature || !tx.recentBlockhash || !tx.serialize().equals(bytes)) {
      throw new Error("Invalid mint transaction signatures");
    }
    return { signature: bs58.encode(tx.signature), blockhash: tx.recentBlockhash, ...decode(tx, expected) };
  }
  /** @param {import('./solana-transaction-sdk.mjs').PreparedTransaction} prepared @param {Expectation} expected @param {import('./solana-transaction-sdk.mjs').BlockValidity} latest */
  function inspectPrepared(prepared, expected, latest) { decode(checkSetupPrepared(provider, prepared, latest, [expected.payer, expected.mint]), expected); }
  /** @param {import('./solana-transaction-sdk.mjs').PreparedTransaction} prepared @param {Expectation} expected @param {import('./solana-transaction-sdk.mjs').TestKeys & {mintFile: string}} testKeys */
  async function sign(prepared, expected, testKeys) {
    if (testKeys.testOnly !== true) { throw new Error("Test-only mint keys required"); }
    let payerBytes, mintBytes, payer, mint, payerSigningSecret, mintSigningSecret;
    /** @type {unknown[] | undefined} */ let payerRaw, mintRaw;
    try {
      inspectPrepared(prepared, expected, prepared);
      const parsedPayer = /** @type {unknown} */ (JSON.parse(await readFile(testKeys.payerFile, "utf8")));
      if (Array.isArray(parsedPayer)) { payerRaw = parsedPayer; }
      payerBytes = Uint8Array.from(keyBytes(parsedPayer));
      const parsedMint = /** @type {unknown} */ (JSON.parse(await readFile(testKeys.mintFile, "utf8")));
      if (Array.isArray(parsedMint)) { mintRaw = parsedMint; }
      mintBytes = Uint8Array.from(keyBytes(parsedMint));
      payer = Keypair.fromSecretKey(payerBytes); mint = Keypair.fromSecretKey(mintBytes);
      if (payer.publicKey.toBase58() !== expected.payer || mint.publicKey.toBase58() !== expected.mint) {
        throw new Error("Wrong test keys");
      }
      const tx = Transaction.from(Buffer.from(prepared.bytesBase64, "base64"));
      decode(tx, expected);
      if (tx.recentBlockhash !== prepared.blockhash) { throw new Error("Wrong prepared blockhash"); }
      payerSigningSecret = payer.secretKey; mintSigningSecret = mint.secretKey;
      tx.sign({ publicKey: payer.publicKey, secretKey: payerSigningSecret }, { publicKey: mint.publicKey, secretKey: mintSigningSecret });
      const bytesBase64 = tx.serialize().toString("base64");
      const inspected = inspectSigned(bytesBase64, expected);
      return { bytesBase64, signature: inspected.signature, blockhash: inspected.blockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight };
    } catch { throw new Error("Test-only Solana mint signing failed"); }
    finally { payerRaw?.fill(0); mintRaw?.fill(0); payerBytes?.fill(0); mintBytes?.fill(0); payerSigningSecret?.fill(0); mintSigningSecret?.fill(0); }
  }
  return { build, inspectSigned, sign, inspectPrepared };
}
