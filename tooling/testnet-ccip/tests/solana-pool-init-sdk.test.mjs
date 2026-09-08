import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createSolanaPoolInitSdk } from "../src/adapters/solana-pool-init-sdk.mjs";
import { BURNMINT_PROGRAM } from "../src/domain/solana-pool-init.ts";
const provider = process.env.AGTMAI_TEST_SOLANA_PROVIDER;
test("official frozen SDK rejects invalid signatures/instructions and validates exact initialized state", { skip: !provider }, async () => {
  const sdk = await createSolanaPoolInitSdk(provider);
  const require = createRequire(resolve(provider, "package.json"));
  const { PublicKey, Keypair, Transaction } = require("@solana/web3.js");
  const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
  // Disposable deterministic test identities only. Nothing is submitted or stored.
  const payer = Keypair.fromSeed(new Uint8Array(32).fill(17));
  const mint = Keypair.fromSeed(new Uint8Array(32).fill(18)).publicKey;
  const program = new PublicKey(BURNMINT_PROGRAM);
  const pool = PublicKey.findProgramAddressSync([Buffer.from("ccip_tokenpool_config"), mint.toBuffer()], program)[0];
  const expected = { testOnly: true, cluster: "solana-devnet", payer: payer.publicKey.toBase58(), mint: mint.toBase58(), pool: pool.toBase58() };
  const built = sdk.build(expected, { blockhash: Keypair.fromSeed(new Uint8Array(32).fill(19)).publicKey.toBase58(), lastValidBlockHeight: "100" });
  assert.throws(() => sdk.inspectSigned(built.bytesBase64, expected), /signature/);
  const tx = Transaction.from(Buffer.from(built.bytesBase64, "base64")); tx.sign(payer);
  const signed = tx.serialize();
  assert.equal(sdk.inspectSigned(signed.toString("base64"), expected).envelope.pool, expected.pool);
  const corrupted = Buffer.from(signed); corrupted[1] ^= 1;
  assert.throws(() => sdk.inspectSigned(corrupted.toString("base64"), expected), /signature/);
  tx.instructions[0].data[0] ^= 1; tx.sign(payer);
  assert.throws(() => sdk.inspectSigned(tx.serialize().toString("base64"), expected), /initialization/);
  assert.throws(() => sdk.build({ ...expected, pool: mint.toBase58() }, { blockhash: built.blockhash, lastValidBlockHeight: "100" }), /PDA/);
  const state = Buffer.alloc(368);
  createHash("sha256").update("account:State").digest().copy(state, 0, 0, 8); state[8] = 1; state[73] = 9;
  const signer = PublicKey.findProgramAddressSync([Buffer.from("ccip_tokenpool_signer"), mint.toBuffer()], program)[0];
  const router = new PublicKey("Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C");
  for (const [offset, key] of [[9, TOKEN_PROGRAM_ID], [41, mint], [74, signer], [106, getAssociatedTokenAddressSync(mint, signer, true)],
    [138, payer.publicKey], [202, payer.publicKey], [234, PublicKey.findProgramAddressSync([Buffer.from("external_token_pools_signer"), program.toBuffer()], router)[0]],
    [266, router], [336, new PublicKey("RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7")]]) { key.toBuffer().copy(state, offset); }
  assert.equal(sdk.verifyState(state.toString("base64"), expected).verified, true);
  for (const offset of [0, 8, 9, 41, 73, 74, 106, 138, 170, 202, 234, 266, 298, 330, 331, 332, 336]) {
    const wrong = Buffer.from(state); wrong[offset] ^= 1;
    assert.throws(() => sdk.verifyState(wrong.toString("base64"), expected));
  }
  assert.throws(() => sdk.verifyState(Buffer.concat([state, Buffer.alloc(1)]).toString("base64"), expected));
});
