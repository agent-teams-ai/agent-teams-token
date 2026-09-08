import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSolanaRegistrationSdk } from "../src/adapters/solana-registration-sdk.mjs";
import { BURNMINT_PROGRAM } from "../src/domain/solana-pool-init.ts";
import { REGISTRATION_OPERATIONS, ROUTER_PROGRAM } from "../src/domain/solana-registration.ts";
const provider = process.env.AGTMAI_TEST_SOLANA_PROVIDER;
  const anchor = (name, size) => { const bytes = Buffer.alloc(size); createHash("sha256").update("account:" + name).digest().copy(bytes, 0, 0, 8); bytes[8] = 1; return bytes; };
  const raw = (data, owner) => ({ data: [data.toString("base64"), "base64"], owner, executable: false, lamports: 10_000_000, rentEpoch: 0 });
async function fixture() {
  const sdk = await createSolanaRegistrationSdk(provider), require = createRequire(resolve(provider, "package.json"));
  const web3 = require("@solana/web3.js"), spl = require("@solana/spl-token");
  const { PublicKey, Keypair, Transaction } = web3;
  const payer = Keypair.fromSeed(new Uint8Array(32).fill(27)), mint = Keypair.fromSeed(new Uint8Array(32).fill(28)).publicKey;
  const program = new PublicKey(BURNMINT_PROGRAM), router = new PublicKey(ROUTER_PROGRAM);
  const expected = sdk.derive({ testOnly: true, cluster: "solana-devnet", operation: "create-token-account", payer: payer.publicKey.toBase58(),
    mint: mint.toBase58(), pool: PublicKey.findProgramAddressSync([Buffer.from("ccip_tokenpool_config"), mint.toBuffer()], program)[0].toBase58() });
  const latest = { blockhash: Keypair.fromSeed(new Uint8Array(32).fill(29)).publicKey.toBase58(), lastValidBlockHeight: "100" };
  const key = (data, offset, address) => new PublicKey(address).toBuffer().copy(data, offset);
  const mintBytes = Buffer.alloc(82); mintBytes.writeUInt32LE(1, 0); key(mintBytes, 4, expected.payer); mintBytes[44] = 9; mintBytes[45] = 1;
  const pool = anchor("State", 368); pool[73] = 9;
  for (const [offset, address] of [[9, spl.TOKEN_PROGRAM_ID], [41, mint], [74, expected.signer], [106, expected.ata], [138, expected.payer],
    [202, expected.payer], [234, PublicKey.findProgramAddressSync([Buffer.from("external_token_pools_signer"), program.toBuffer()], router)[0]],
    [266, ROUTER_PROGRAM], [336, "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7"]]) { key(pool, offset, address); }
  const ata = Buffer.alloc(165); key(ata, 0, mint); key(ata, 32, expected.signer); ata[108] = 1;
  const global = anchor("PoolConfig", 74); global[9] = 1; key(global, 10, ROUTER_PROGRAM); key(global, 42, "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7");
  const config = anchor("Config", 210); config[9] = 1; config.writeBigUInt64LE(16423721717087811551n, 10);
  key(config, 82, "FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi"); key(config, 114, "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7");
  const registry = anchor("TokenAdminRegistry", 170); registry[8] = 2; key(registry, 41, expected.payer); key(registry, 137, expected.mint);
  const registryAccepted = Buffer.from(registry); registryAccepted.fill(0, 41, 73); key(registryAccepted, 9, expected.payer);
  const values = (operation, phase) => {
    const mintData = Buffer.from(mintBytes);
    if (operation === "transfer-mint-authority" && phase === "after") { key(mintData, 4, expected.signer); }
    const hasRegistry = operation === "accept-admin-role" || operation === "transfer-mint-authority" || operation === "owner-propose-administrator" && phase === "after";
    const accepted = operation === "transfer-mint-authority" || operation === "accept-admin-role" && phase === "after";
    return [raw(mintData, spl.TOKEN_PROGRAM_ID.toBase58()), raw(pool, BURNMINT_PROGRAM),
      operation === "create-token-account" && phase === "before" ? null : raw(ata, spl.TOKEN_PROGRAM_ID.toBase58()),
      hasRegistry ? raw(accepted ? registryAccepted : registry, ROUTER_PROGRAM) : null,
      raw(global, BURNMINT_PROGRAM), raw(config, ROUTER_PROGRAM)];
  };
  return { sdk, expected, latest, payer, mint, web3, spl, Transaction, values };
}
test("native frozen SDK matches official four instructions and rejects tampered signatures and derivations", { skip: !provider }, async () => {
  const { sdk, expected, latest, payer, mint, web3, spl, Transaction } = await fixture();
  const { InstructionBuilder } = await import(pathToFileURL(resolve(provider, "dist/programs/router/instructions.js")).href);
  const idl = JSON.parse(await readFile(resolve(provider, "dist/programs/router/idl.json"), "utf8"));
  const router = new InstructionBuilder(new web3.PublicKey(ROUTER_PROGRAM), idl);
  for (const operation of REGISTRATION_OPERATIONS) {
    const e = { ...expected, operation }, built = sdk.build(e, latest);
    const tx = Transaction.from(Buffer.from(built.bytesBase64, "base64"));
    let official;
    if (operation === "create-token-account") { official = spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, new web3.PublicKey(e.ata), new web3.PublicKey(e.signer), mint); }
    else if (operation === "owner-propose-administrator") { official = await router.ownerProposeAdministrator(mint, payer.publicKey, payer.publicKey); }
    else if (operation === "accept-admin-role") { official = await router.acceptAdminRoleTokenAdminRegistry(mint, payer.publicKey); }
    else { official = spl.createSetAuthorityInstruction(mint, payer.publicKey, spl.AuthorityType.MintTokens, new web3.PublicKey(e.signer)); }
    const officialTx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(official);
    assert.deepEqual(tx.serializeMessage(), officialTx.serializeMessage());
    assert.throws(() => sdk.inspectSigned(built.bytesBase64, e), /signature/);
    tx.sign(payer); const signed = tx.serialize();
    assert.equal(sdk.inspectSigned(signed.toString("base64"), e).envelope.operation, operation);
    const corrupt = Buffer.from(signed); corrupt[1] ^= 1;
    assert.throws(() => sdk.inspectSigned(corrupt.toString("base64"), e), /signature/);
    const message = tx.compileMessage();
    const programIndex = message.instructions[0].programIdIndex;
    // Every readonly unsigned account at or after this index becomes writable.
    const promoted = new web3.Message({ header: { ...message.header, numReadonlyUnsignedAccounts: message.accountKeys.length - programIndex - 1 },
      accountKeys: message.accountKeys, recentBlockhash: message.recentBlockhash, instructions: message.instructions });
    const signRaw = rawMessage => {
      const secret = createPrivateKey({ format: "der", type: "pkcs8", key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(payer.secretKey.subarray(0, 32))]) });
      const bytes = rawMessage.serialize();
      return Buffer.concat([Buffer.from([1]), sign(null, bytes, secret), bytes]).toString("base64");
    };
    assert.throws(() => sdk.inspectSigned(signRaw(promoted), e));
    const extra = new web3.Message({ header: { ...message.header, numReadonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts + 1 },
      accountKeys: [...message.accountKeys, web3.Keypair.fromSeed(new Uint8Array(32).fill(31)).publicKey],
      recentBlockhash: message.recentBlockhash, instructions: message.instructions });
    assert.throws(() => sdk.inspectSigned(signRaw(extra), e), /account/);
    tx.instructions[0].data[0] ^= 1; tx.sign(payer);
    assert.throws(() => sdk.inspectSigned(tx.serialize().toString("base64"), e), /instruction/);
    for (const field of ["pool", "signer", "ata", "registry", "routerConfig"]) {
      assert.throws(() => sdk.build({ ...e, [field]: e.mint }, latest));
    }
  }
});
test("native snapshots enforce all four prerequisite/poststate transitions and exact account layouts", { skip: !provider }, async () => {
  const { sdk, expected, values } = await fixture();
  for (const operation of REGISTRATION_OPERATIONS) {
    const e = { ...expected, operation };
    for (const phase of ["before", "after"]) {
      const snapshot = values(operation, phase);
      assert.equal(sdk.verifySnapshot(snapshot, e, phase).verified, true);
      for (let index = 0; index < snapshot.length; index++) {
        if (snapshot[index] === null) { continue; }
        const wrongOwner = structuredClone(snapshot); wrongOwner[index].owner = e.payer;
        assert.throws(() => sdk.verifySnapshot(wrongOwner, e, phase));
        const trailing = structuredClone(snapshot); trailing[index].data[0] = Buffer.concat([Buffer.from(trailing[index].data[0], "base64"), Buffer.alloc(1)]).toString("base64");
        assert.throws(() => sdk.verifySnapshot(trailing, e, phase));
      }
    }
    // The operation's successful state cannot authorize a fresh repeat.
    assert.throws(() => sdk.verifySnapshot(values(operation, "after"), e, "before"));
    assert.throws(() => sdk.verifySnapshot(values(operation, "before"), e, "after"));
  }
  const e = { ...expected, operation: "transfer-mint-authority" };
  const invalidMintState = values(e.operation, "after");
  const invalidMintBytes = Buffer.from(invalidMintState[0].data[0], "base64"); invalidMintBytes[45] = 2;
  invalidMintState[0].data[0] = invalidMintBytes.toString("base64");
  assert.throws(() => sdk.verifySnapshot(invalidMintState, e, "after"), /mint layout/);
  const invalidAtaState = values(e.operation, "after");
  const invalidAtaBytes = Buffer.from(invalidAtaState[2].data[0], "base64"); invalidAtaBytes[108] = 3;
  invalidAtaState[2].data[0] = invalidAtaBytes.toString("base64");
  assert.throws(() => sdk.verifySnapshot(invalidAtaState, e, "after"), /ATA layout/);
  for (const [index, offsets] of [[0, [0, 4, 36, 44, 45, 46]], [2, [0, 32, 64, 72, 108, 109, 121, 129]], [3, [0, 8, 9, 41, 73, 105, 137, 169]], [4, [0, 8, 9, 10, 42]], [5, [0, 8, 9, 10, 82, 114]]]) {
    for (const offset of offsets) {
      const bad = values(e.operation, "after"), bytes = Buffer.from(bad[index].data[0], "base64"); bytes[offset] ^= 1;
      bad[index].data[0] = bytes.toString("base64");
      assert.throws(() => sdk.verifySnapshot(bad, e, "after"), `account ${index}, offset ${offset}`);
    }
  }
});

test("native registry decoder requires exact v2 layout and canonical boolean", { skip: !provider }, async () => {
  const { sdk, expected, values } = await fixture();
  const e = { ...expected, operation: "owner-propose-administrator" };
  const snapshot = values(e.operation, "after"), registry = snapshot[3];
  const zero = "11111111111111111111111111111111";
  assert.deepEqual(sdk.decodeRegistry(registry), { administrator: zero, pendingAdministrator: e.payer,
    lookupTable: zero, writableIndexes: "0x" + "00".repeat(32), mint: e.mint, supportsAutoDerivation: false });
  const bytes = Buffer.from(registry.data[0], "base64");
  for (const [length, version, flag] of [[169, 1, 0], [170, 1, 0], [169, 2, 0], [171, 2, 0], [170, 2, 2]]) {
    const bad = Buffer.alloc(length); bytes.copy(bad); bad[8] = version;
    if (length > 169) { bad[169] = flag; }
    assert.throws(() => sdk.decodeRegistry(raw(bad, ROUTER_PROGRAM)), /TokenAdminRegistry/);
  }
  assert.throws(() => sdk.decodeRegistry({ ...registry, owner: e.payer }), /owner/);
  const wrongDiscriminator = Buffer.from(bytes); wrongDiscriminator[0] ^= 1;
  assert.throws(() => sdk.decodeRegistry(raw(wrongDiscriminator, ROUTER_PROGRAM)), /layout/);
  const auto = Buffer.from(bytes); auto[169] = 1;
  assert.equal(sdk.decodeRegistry(raw(auto, ROUTER_PROGRAM)).supportsAutoDerivation, true);
  snapshot[3] = raw(auto, ROUTER_PROGRAM);
  assert.throws(() => sdk.verifySnapshot(snapshot, e, "after"), /configuration/);
});
