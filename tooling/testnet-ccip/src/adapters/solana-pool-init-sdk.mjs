import { createHash } from "node:crypto";
import { loadSolanaProvider, createSolanaTransactionSdk } from "./solana-transaction-sdk.mjs";
import { verifySolanaPoolInitIntent, BURNMINT_PROGRAM, BURNMINT_PROGRAM_DATA, POOL_GLOBAL } from "../domain/solana-pool-init.ts";
export async function createSolanaPoolInitSdk(providerDirectory) {
  const provider = await loadSolanaProvider(providerDirectory);
  const { PublicKey, SystemProgram, TransactionInstruction } = provider.web3;
  const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = provider.spl;
  const program = new PublicKey(BURNMINT_PROGRAM);
  function addresses(expected) {
    const mint = new PublicKey(expected.mint);
    const pool = PublicKey.findProgramAddressSync([Buffer.from("ccip_tokenpool_config"), mint.toBuffer()], program)[0];
    if (pool.toBase58() !== expected.pool) { throw new Error("Wrong pool PDA"); }
    const signer = PublicKey.findProgramAddressSync([Buffer.from("ccip_tokenpool_signer"), mint.toBuffer()], program)[0];
    return { mint, pool, signer, ata: getAssociatedTokenAddressSync(mint, signer, true) };
  }
  const { build, sign, inspectSigned } = createSolanaTransactionSdk(provider,
    (intent, expected) => { addresses(expected); return verifySolanaPoolInitIntent(intent, expected); },
    expected => {
      addresses(expected);
      const keys = [expected.pool, expected.mint, expected.payer, SystemProgram.programId.toBase58(), BURNMINT_PROGRAM, BURNMINT_PROGRAM_DATA, POOL_GLOBAL];
      return new TransactionInstruction({ programId: program, data: Buffer.from("afaf6d1f0d989bed", "hex"),
        keys: keys.map((address, i) => ({ pubkey: new PublicKey(address), isSigner: i === 2, isWritable: i === 0 || i === 2 })) });
    });
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
