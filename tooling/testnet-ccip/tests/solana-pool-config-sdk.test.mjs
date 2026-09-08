import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { poolConfigFixture } from "./solana-pool-config-fixture.mjs";
import { BURNMINT_PROGRAM } from "../src/domain/solana-pool-init.ts";
import { ROUTER_PROGRAM } from "../src/domain/solana-registration.ts";
import { POOL_CONFIG_OPERATIONS, SEPOLIA_SELECTOR, REMOTE_POOL, REMOTE_TOKEN, altAddresses, remoteBytes } from "../src/domain/solana-pool-config.ts";
const provider = process.env.AGTMAI_TEST_SOLANA_PROVIDER;
const forOperation = (fixture, operation) => fixture.sdk.derive({ ...fixture.expected, operation,
  recentSlot: ["create-lookup-table", "set-pool"].includes(operation) ? "100" : null });
test("native five config operations equal official builders including atomic ALT create plus extend", { skip: !provider }, async () => {
  const f = await poolConfigFixture(provider), { sdk, mint, payer, latest, web3, Transaction } = f;
  const load = async name => {
    const { InstructionBuilder } = await import(pathToFileURL(resolve(provider, `dist/programs/${name}/instructions.js`)).href);
    const idl = JSON.parse(await readFile(resolve(provider, `dist/programs/${name}/idl.json`), "utf8"));
    return new InstructionBuilder(new web3.PublicKey(name === "router" ? ROUTER_PROGRAM : BURNMINT_PROGRAM), idl);
  };
  const pool = await load("burnmint-token-pool"), router = await load("router");
  for (const operation of POOL_CONFIG_OPERATIONS) {
    const e = forOperation(f, operation), built = sdk.build(e, latest), tx = Transaction.from(Buffer.from(built.bytesBase64, "base64"));
    let instructions;
    if (operation === "init-chain-remote-config") { instructions = [await pool.initChainRemoteConfig(mint, payer.publicKey, BigInt(SEPOLIA_SELECTOR), [], REMOTE_TOKEN, 9)]; }
    else if (operation === "append-remote-pool-addresses") { instructions = [await pool.appendRemotePoolAddresses(mint, payer.publicKey, BigInt(SEPOLIA_SELECTOR), ["0x" + remoteBytes(REMOTE_POOL).toString("hex")])]; }
    else if (operation === "set-chain-rate-limit") {
      const rate = { enabled: true, capacity: 10_000_000_000n, rate: 1_000_000_000n };
      instructions = [await pool.setChainRateLimit(mint, payer.publicKey, BigInt(SEPOLIA_SELECTOR), rate, rate)];
    } else if (operation === "set-pool") { instructions = [await router.setPool(mint, new web3.PublicKey(e.alt), payer.publicKey, [3, 4, 7])]; }
    else {
      const [create, address] = web3.AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: 100 });
      assert.equal(address.toBase58(), e.alt);
      instructions = [create, web3.AddressLookupTableProgram.extendLookupTable({ authority: payer.publicKey, payer: payer.publicKey,
        lookupTable: address, addresses: altAddresses(e).map(a => new web3.PublicKey(a)) })];
    }
    const official = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(...instructions);
    assert.deepEqual(tx.serializeMessage(), official.serializeMessage());
    assert.throws(() => sdk.inspectSigned(built.bytesBase64, e), /signature/);
    tx.sign(payer); assert.equal(sdk.inspectSigned(tx.serialize().toString("base64"), e).envelope.operation, operation);
    for (const field of ["chain", "feeTokenConfig", "routerPoolSigner", ...(e.alt ? ["alt", "recentSlot"] : [])]) {
      assert.throws(() => sdk.build({ ...e, [field]: field === "recentSlot" ? "101" : e.mint }, latest));
    }
    for (let i = 0; i < tx.instructions.length; i++) {
      const bad = Transaction.from(Buffer.from(built.bytesBase64, "base64")); bad.instructions[i].data[0] ^= 1; bad.sign(payer);
      assert.throws(() => sdk.inspectSigned(bad.serialize().toString("base64"), e), /instructions/);
    }
  }
});
test("native config snapshots reject malformed vectors, rates, registry phase and ALT metadata/order/slot", { skip: !provider }, async () => {
  const f = await poolConfigFixture(provider), { sdk, values } = f;
  for (const operation of POOL_CONFIG_OPERATIONS) {
    const e = forOperation(f, operation);
    for (const phase of ["before", "after"]) {
      const snapshot = values(e, phase), transactionSlot = phase === "after" ? operation === "create-lookup-table" ? 150 : 175 : 0;
      assert.equal(sdk.verifySnapshot(snapshot, e, phase, 200, transactionSlot).verified, true);
      for (let i = 0; i < snapshot.length; i++) {
        if (snapshot[i] === null) { continue; }
        const wrong = structuredClone(snapshot); wrong[i].owner = e.payer;
        assert.throws(() => sdk.verifySnapshot(wrong, e, phase, 200, transactionSlot));
        const trailing = structuredClone(snapshot); trailing[i].data[0] = Buffer.concat([Buffer.from(trailing[i].data[0], "base64"), Buffer.alloc(1)]).toString("base64");
        assert.throws(() => sdk.verifySnapshot(trailing, e, phase, 200, transactionSlot));
      }
    }
    assert.throws(() => sdk.verifySnapshot(values(e, "after"), e, "before", 200));
  }
  const e = forOperation(f, "set-pool");
  for (const [accountIndex, offsets] of [[3, [8, 73, 120, 169]], [6, [8, 12, 16, 48, 52, 84, 101, 102, 110, 134, 135, 143]], [7, [0, 4, 20, 21, 22, 54, 56, 88, 120, 152, 184, 216, 248, 280, 312, 344]]]) {
    for (const offset of offsets) {
      const bad = values(e, "after"), bytes = Buffer.from(bad[accountIndex].data[0], "base64"); bytes[offset] ^= 1;
      bad[accountIndex].data[0] = bytes.toString("base64");
      assert.throws(() => sdk.verifySnapshot(bad, e, "after", 200, 175), `account ${accountIndex}, byte ${offset}`);
    }
  }
  assert.throws(() => sdk.verifySnapshot(values(e, "before"), e, "before", 150), /later actual slot/);
  assert.throws(() => sdk.verifySnapshot(values(e, "after"), e, "after", 200, 150), /later actual slot/);
  const create = forOperation(f, "create-lookup-table");
  assert.throws(() => sdk.verifySnapshot(values(create, "after"), create, "after", 200, 0), /transaction slot required/);
  assert.throws(() => sdk.verifySnapshot(values(create, "before"), create, "before", 612), /recentSlot/);
  assert.throws(() => sdk.verifySnapshot(values(create, "after"), create, "after", 200, 151), /later actual slot/);
});
