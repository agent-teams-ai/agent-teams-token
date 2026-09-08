import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { poolConfigFixture, repairRates, observedPoolRepair } from "./solana-pool-config-fixture.mjs";
import { BURNMINT_PROGRAM } from "../src/domain/solana-pool-init.ts";
import { ROUTER_PROGRAM } from "../src/domain/solana-registration.ts";
import { POOL_CONFIG_OPERATIONS, SEPOLIA_SELECTOR, REMOTE_POOL, REMOTE_TOKEN, altAddresses } from "../src/domain/solana-pool-config.ts";
const provider = process.env.AGTMAI_TEST_SOLANA_PROVIDER;
const forOperation = (fixture, operation) => fixture.sdk.derive({ ...fixture.expected, operation,
  recentSlot: ["create-lookup-table", "set-pool", "repair-remote-pool-encoding"].includes(operation) ? "100" : null,
  ...(operation === "repair-remote-pool-encoding" ? { repairRateLimitsBase64: repairRates.toString("base64") } : {}) });
test("native six config operations equal official builders including atomic ALT create plus extend", { skip: !provider }, async () => {
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
    else if (operation === "append-remote-pool-addresses") { instructions = [await pool.appendRemotePoolAddresses(mint, payer.publicKey, BigInt(SEPOLIA_SELECTOR), [REMOTE_POOL])]; }
    else if (operation === "repair-remote-pool-encoding") { instructions = [await pool.editChainRemoteConfig(mint, payer.publicKey, BigInt(SEPOLIA_SELECTOR), [REMOTE_POOL], REMOTE_TOKEN, 9)]; }
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
  for (const [accountIndex, offsets] of [[3, [8, 73, 120, 169]], [6, [8, 12, 16, 36, 40, 72, 89, 90, 98, 122, 123, 131]], [7, [0, 4, 20, 21, 22, 54, 56, 88, 120, 152, 184, 216, 248, 280, 312, 344]]]) {
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

test("native chain allocation matches finalized147-byte evidence and rejects compact or malformed reserved slack", { skip: !provider }, async () => {
  const f = await poolConfigFixture(provider), { sdk, values } = f;
  // Public finalized init transaction slot494854806. Rust INIT_SPACE includes64
  // token-address bytes, but this serialized EVM token uses32 bytes.
  const observed = "DbHpjdQdlDgAAAAAIAAAAAAAAAAAAAAAAAAAAL7pG6PKlN18Y57mwbHC/BoZls3JCQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const initial = forOperation(f, "init-chain-remote-config"), actual = values(initial, "after");
  assert.equal(Buffer.from(observed, "base64").length, 147);
  assert.equal(actual[6].data[0], observed);
  actual[6].data[0] = observed;
  assert.equal(sdk.verifySnapshot(actual, initial, "after", 494855030, 494854806).verified, true);
  for (const operation of ["init-chain-remote-config", "append-remote-pool-addresses"]) {
    const e = forOperation(f, operation), snapshot = values(e, "after"), bytes = Buffer.from(snapshot[6].data[0], "base64");
    assert.equal(bytes.length, operation === "init-chain-remote-config" ? 147 : 171);
    for (const invalid of [bytes.subarray(0, bytes.length - 32), bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.alloc(1)])]) {
      const bad = structuredClone(snapshot); bad[6].data[0] = invalid.toString("base64");
      assert.throws(() => sdk.verifySnapshot(bad, e, "after", 200, 175));
    }
    for (let offset = bytes.length - 32; offset < bytes.length; offset++) {
      const bad = structuredClone(snapshot), changed = Buffer.from(bytes); changed[offset] = 1;
      bad[6].data[0] = changed.toString("base64");
      assert.throws(() => sdk.verifySnapshot(bad, e, "after", 200, 175), /allocation slack/);
    }
  }
});


test("official repair simulation preserves both rate buckets and rejects any residual-byte mutation", { skip: !provider }, async () => {
  const f = await poolConfigFixture(provider);
  const before = Buffer.from(observedPoolRepair.before, "base64"), after = Buffer.from(observedPoolRepair.after, "base64");
  assert.equal(before.length, 183); assert.equal(after.length, 171);
  const transformed = Buffer.from(before.subarray(0, 171)), length = Buffer.alloc(4); length.writeUInt32LE(20);
  Buffer.concat([before.subarray(0, 12), length, Buffer.from(REMOTE_POOL.slice(2), "hex"), before.subarray(48, 151)]).copy(transformed);
  assert.deepEqual(after, transformed);
  const e = f.sdk.derive({ ...forOperation(f, "repair-remote-pool-encoding"), repairRateLimitsBase64: before.subarray(85, 151).toString("base64") });
  for (const phase of ["before", "after"]) {
    const snapshot = f.values(e, phase); snapshot[6].data[0] = observedPoolRepair[phase];
    assert.equal(f.sdk.verifySnapshot(snapshot, e, phase, observedPoolRepair.slot, observedPoolRepair.slot).verified, true);
    const bytes = Buffer.from(snapshot[6].data[0], "base64");
    for (let offset = phase === "before" ? 85 : 73; offset < bytes.length; offset++) {
      const bad = structuredClone(snapshot), changed = Buffer.from(bytes); changed[offset] ^= 1;
      bad[6].data[0] = changed.toString("base64");
      assert.throws(() => f.sdk.verifySnapshot(bad, e, phase, observedPoolRepair.slot, observedPoolRepair.slot), `repair changed byte ${offset}`);
    }
  }
  const wrong = f.values(e, "before"); wrong[6].data[0] = observedPoolRepair.after;
  assert.throws(() => f.sdk.verifySnapshot(wrong, e, "before", observedPoolRepair.slot));
});


test("actual failed release CPI requires raw20 pool while legacy padded32 differs", () => {
  const cpi = Buffer.from("XGSWxvw/pOQUAAAAJ17nKMSRALVtSqN8AOLcj/xeXfbZGtnJT7pB3m6q9VKp7+tqbFXjZoXwCJ7WOKlA9+Wyt3CeQ0YUocZvAMqaOwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAnUk3K6kUCknjhOegI6j1Jz57G5+HAzzrXOWcEW6QAhQAAAAkUI4us77cCGMYq8BUFT/YOCOk4iAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACQAAAAA=", "base64");
  const legacy = Buffer.from(observedPoolRepair.before, "base64"), canonical = Buffer.from(observedPoolRepair.after, "base64");
  assert.equal(cpi.readUInt32LE(136), 20);
  assert.equal(cpi.subarray(140, 160).toString("hex"), REMOTE_POOL.slice(2));
  assert.notDeepEqual(legacy.subarray(16, 48), cpi.subarray(140, 160));
  assert.deepEqual(canonical.subarray(16, 36), cpi.subarray(140, 160));
});
