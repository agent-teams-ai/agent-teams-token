import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { verifySolanaPoolInitIntent, BURNMINT_PROGRAM, BURNMINT_PROGRAM_DATA, POOL_GLOBAL } from "../domain/solana-pool-init.ts";
export async function createSolanaPoolInitSdk(providerDirectory) {
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
  const { PublicKey, SystemProgram, Transaction, TransactionInstruction, Keypair } = require("@solana/web3.js");
  const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
  const bs58 = require("bs58").default;

  const program = new PublicKey(BURNMINT_PROGRAM);
  function addresses(expected) {
    const mint = new PublicKey(expected.mint);
    const pool = PublicKey.findProgramAddressSync([Buffer.from("ccip_tokenpool_config"), mint.toBuffer()], program)[0];
    if (pool.toBase58() !== expected.pool) { throw new Error("Wrong pool PDA"); }
    const signer = PublicKey.findProgramAddressSync([Buffer.from("ccip_tokenpool_signer"), mint.toBuffer()], program)[0];
    return { mint, pool, signer, ata: getAssociatedTokenAddressSync(mint, signer, true) };
  }
  function decode(tx, expected) {
    addresses(expected);
    const message = tx.compileMessage();
    if (message.header.numRequiredSignatures !== 1 || message.accountKeys.length !== 7 ||
      message.accountKeys[0].toBase58() !== expected.payer) { throw new Error("Wrong pool init accounts"); }
    const intent = { feePayer: tx.feePayer.toBase58(), instructions: tx.instructions.map(ix => ({
      programId: ix.programId.toBase58(), dataBase64: ix.data.toString("base64"),
      accounts: ix.keys.map(k => ({ address: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })) })) };
    return { intent, envelope: verifySolanaPoolInitIntent(intent, expected), messageBase64: tx.serializeMessage().toString("base64") };
  }
  function build(expected, latest) {
    addresses(expected);
    if (!/^[1-9][0-9]*$/.test(latest.lastValidBlockHeight) || new PublicKey(latest.blockhash).toBase58() !== latest.blockhash) { throw new Error("Invalid block validity"); }
    const keys = [expected.pool, expected.mint, expected.payer, SystemProgram.programId.toBase58(), BURNMINT_PROGRAM, BURNMINT_PROGRAM_DATA, POOL_GLOBAL];
    const tx = new Transaction({ feePayer: new PublicKey(expected.payer), recentBlockhash: latest.blockhash });
    tx.add(new TransactionInstruction({ programId: program, data: Buffer.from("afaf6d1f0d989bed", "hex"),
      keys: keys.map((address, i) => ({ pubkey: new PublicKey(address), isSigner: i === 2, isWritable: i === 0 || i === 2 })) }));
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return { bytesBase64: bytes.toString("base64"), ...latest, ...decode(Transaction.from(bytes), expected) };
  }
  function inspectSigned(bytesBase64, expected) {
    const bytes = Buffer.from(bytesBase64, "base64");
    if (bytes.length > 1232 || bytes.toString("base64") !== bytesBase64) { throw new Error("Invalid pool transaction encoding"); }
    const tx = Transaction.from(bytes);
    if (!tx.verifySignatures(true) || tx.signatures.length !== 1 || !tx.signature) { throw new Error("Invalid pool signature"); }
    return { signature: bs58.encode(tx.signature), blockhash: tx.recentBlockhash, ...decode(tx, expected) };
  }
  async function sign(prepared, expected, testKeys) {
    if (testKeys.testOnly !== true) { throw new Error("Test-only pool key required"); }
    let secret;
    try {
      const raw = JSON.parse(await readFile(testKeys.payerFile, "utf8"));
      if (!Array.isArray(raw) || raw.length !== 64 || raw.some(v => !Number.isInteger(v) || v < 0 || v > 255)) { throw new Error("Invalid test key"); }
      secret = Uint8Array.from(raw); raw.fill(0);
      const payer = Keypair.fromSecretKey(secret);
      if (payer.publicKey.toBase58() !== expected.payer) { throw new Error("Wrong payer"); }
      const tx = Transaction.from(Buffer.from(prepared.bytesBase64, "base64"));
      decode(tx, expected);
      if (tx.recentBlockhash !== prepared.blockhash) { throw new Error("Wrong prepared blockhash"); }
      tx.sign(payer);
      const bytesBase64 = tx.serialize().toString("base64"), inspected = inspectSigned(bytesBase64, expected);
      return { bytesBase64, signature: inspected.signature, blockhash: inspected.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight };
    } catch { throw new Error("Test-only pool signing failed"); }
    finally { secret?.fill(0); }
  }
  function verifyState(bytesBase64, expected) {
    const a = addresses(expected), data = Buffer.from(bytesBase64, "base64");
    const discriminator = createHash("sha256").update("account:State").digest().subarray(0, 8);
    const key = offset => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    // Pinned official State: version followed by BaseConfig. Never accept a mint-only success.
    if (data.toString("base64") !== bytesBase64 || data.length !== 368 || !data.subarray(0, 8).equals(discriminator) || data[8] !== 1 ||
      key(9) !== TOKEN_PROGRAM_ID.toBase58() || key(41) !== expected.mint || data[73] !== 9 ||
      key(74) !== a.signer.toBase58() || key(106) !== a.ata.toBase58() || key(138) !== expected.payer ||
      key(170) !== SystemProgram.programId.toBase58() || key(202) !== expected.payer ||
      key(266) !== "Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C" ||
      key(234) !== PublicKey.findProgramAddressSync([Buffer.from("external_token_pools_signer"), program.toBuffer()], new PublicKey(key(266)))[0].toBase58() ||
      key(298) !== SystemProgram.programId.toBase58() || data[330] !== 0 || data[331] !== 0 || data.readUInt32LE(332) !== 0 ||
      key(336) !== "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7") { throw new Error("Wrong initialized pool state"); }
    return { address: expected.pool, mint: expected.mint, owner: expected.payer, verified: true };
  }
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
  return { build, sign, inspectSigned, verifyState, verifyGlobal };
}
