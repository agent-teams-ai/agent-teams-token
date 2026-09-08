import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export async function loadSolanaProvider(providerDirectory) {
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
  return { web3: require("@solana/web3.js"), spl: require("@solana/spl-token"), bs58: require("bs58").default };
}
export function createSolanaTransactionSdk(provider, validate, instruction) {
  const { Transaction, PublicKey, Keypair } = provider.web3;
  const { bs58 } = provider;
  function decode(tx, expected) {
    const message = tx.compileMessage();
    if (message.header.numRequiredSignatures !== 1 || message.accountKeys[0].toBase58() !== expected.payer) { throw new Error("Wrong Solana signer"); }
    const intent = { feePayer: tx.feePayer.toBase58(), instructions: tx.instructions.map(ix => ({
      programId: ix.programId.toBase58(), dataBase64: ix.data.toString("base64"),
      accounts: ix.keys.map(k => ({ address: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })) })) };
    const allowed = new Set([expected.payer, ...intent.instructions.flatMap(ix => [ix.programId, ...ix.accounts.map(a => a.address)])]);
    if (message.accountKeys.length !== allowed.size || message.accountKeys.some(k => !allowed.has(k.toBase58()))) { throw new Error("Unexpected message account"); }
    for (const ix of intent.instructions) {
      const index = message.accountKeys.findIndex(key => key.toBase58() === ix.programId);
      if (index < 0 || message.isAccountWritable(index) || message.isAccountSigner(index)) {
        throw new Error("Unexpected program privilege");
      }
    }
    return { intent, envelope: validate(intent, expected), messageBase64: tx.serializeMessage().toString("base64") };
  }
  function build(expected, latest) {
    if (!/^[1-9][0-9]*$/.test(latest.lastValidBlockHeight) || new PublicKey(latest.blockhash).toBase58() !== latest.blockhash) { throw new Error("Invalid block validity"); }
    const tx = new Transaction({ feePayer: new PublicKey(expected.payer), recentBlockhash: latest.blockhash });
    tx.add(instruction(expected));
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
  return { build, sign, inspectSigned };
}
