import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { verifySolanaMintIntent } from "../domain/solana-mint.ts";

function decode(transaction, expected) {
  const message = transaction.compileMessage();
  if (message.header.numRequiredSignatures !== 2 || message.accountKeys.length !== 4 ||
    message.accountKeys[0].toBase58() !== expected.payer || message.accountKeys[1].toBase58() !== expected.mint) {
    throw new Error("Unexpected mint transaction signers/accounts");
  }
  const intent = {
    feePayer: transaction.feePayer.toBase58(),
    instructions: transaction.instructions.map(ix => ({ programId: ix.programId.toBase58(),
      accounts: ix.keys.map(key => ({ address: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })),
      dataBase64: ix.data.toString("base64") })),
  };
  return { intent, envelope: verifySolanaMintIntent(intent, expected),
    messageBase64: transaction.serializeMessage().toString("base64") };
}

/** Loads the official provider's frozen dependency tree; no install or key generation. */
export async function createSolanaMintSdk(providerDirectory) {
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
  const { PublicKey, SystemProgram, Transaction, Keypair } = require("@solana/web3.js");
  const { createInitializeMint2Instruction, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
  const bs58 = require("bs58").default;
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
  function inspectSigned(bytesBase64, expected) {
    const bytes = Buffer.from(bytesBase64, "base64");
    if (bytes.length > 1232 || bytes.toString("base64") !== bytesBase64) { throw new Error("Invalid mint transaction bytes"); }
    const tx = Transaction.from(bytes);
    if (!tx.verifySignatures(true) || tx.signatures.length !== 2 || !tx.signature) {
      throw new Error("Invalid mint transaction signatures");
    }
    return { signature: bs58.encode(tx.signature), blockhash: tx.recentBlockhash, ...decode(tx, expected) };
  }
  async function sign(prepared, expected, testKeys) {
    if (testKeys.testOnly !== true) { throw new Error("Test-only mint keys required"); }
    let payerBytes, mintBytes;
    try {
      payerBytes = Uint8Array.from(JSON.parse(await readFile(testKeys.payerFile, "utf8")));
      mintBytes = Uint8Array.from(JSON.parse(await readFile(testKeys.mintFile, "utf8")));
      const payer = Keypair.fromSecretKey(payerBytes), mint = Keypair.fromSecretKey(mintBytes);
      if (payer.publicKey.toBase58() !== expected.payer || mint.publicKey.toBase58() !== expected.mint) {
        throw new Error("Wrong test keys");
      }
      const tx = Transaction.from(Buffer.from(prepared.bytesBase64, "base64"));
      decode(tx, expected);
      if (tx.recentBlockhash !== prepared.blockhash) { throw new Error("Wrong prepared blockhash"); }
      tx.sign(payer, mint);
      const bytesBase64 = tx.serialize().toString("base64");
      const inspected = inspectSigned(bytesBase64, expected);
      return { bytesBase64, signature: inspected.signature, blockhash: inspected.blockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight };
    } catch { throw new Error("Test-only Solana mint signing failed"); }
    finally { payerBytes?.fill(0); mintBytes?.fill(0); }
  }
  return { build, inspectSigned, sign };
}
