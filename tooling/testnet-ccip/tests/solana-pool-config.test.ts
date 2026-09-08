import assert from "node:assert/strict";
import test from "node:test";
import { POOL_CONFIG_OPERATIONS, poolConfigInstructions, verifySolanaPoolConfigIntent } from "../src/domain/solana-pool-config.ts";
import type { SolanaPoolConfigExpectation } from "../src/domain/solana-pool-config.ts";
import { runSolanaPoolConfigJournal } from "../src/application/solana-pool-config-journal.ts";
import type { SolanaPoolConfigRecord, SolanaPoolConfigPorts, PoolConfigStateEvidence } from "../src/application/solana-pool-config-journal.ts";
import type { SolanaObservation } from "../src/application/solana-transaction-journal.ts";
import { readPoolConfigSnapshot } from "../src/adapters/solana-pool-config-rpc.ts";
const key = (n: number) => "1".repeat(31) + "123456789ABCDEFG"[n];
function expectation(operation: SolanaPoolConfigExpectation["operation"]): SolanaPoolConfigExpectation {
  const withAlt = ["create-lookup-table", "set-pool", "repair-remote-pool-encoding"].includes(operation);
  const rates = Buffer.alloc(66);
  for (const offset of [0, 33]) { rates[offset + 16] = 1; rates.writeBigUInt64LE(10_000_000_000n, offset + 17); rates.writeBigUInt64LE(1_000_000_000n, offset + 25); }
  return { testOnly: true, cluster: "solana-devnet", operation, payer: key(1), mint: key(2), pool: key(3), chain: key(4),
    signer: key(5), ata: key(6), registry: key(7), routerConfig: key(8), feeTokenConfig: key(9), routerPoolSigner: key(10),
    ...(operation === "repair-remote-pool-encoding" ? { repairRateLimitsBase64: rates.toString("base64") } : {}),
    alt: withAlt ? key(11) : null, recentSlot: withAlt ? "100" : null, altBump: withAlt ? 255 : null };
}
test("all six instruction allowlists reject altered bytes, accounts/privileges, extras and ALT identity mutation", () => {
  for (const operation of POOL_CONFIG_OPERATIONS) {
    const expected = expectation(operation), instructions = poolConfigInstructions(expected);
    const verify = (ixs = instructions) => verifySolanaPoolConfigIntent({ feePayer: expected.payer, instructions: ixs }, expected);
    assert.equal(verify().operation, operation);
    assert.throws(() => verify([...instructions, instructions[0]]));
    for (let index = 0; index < instructions.length; index++) {
      const ix = instructions[index];
      for (let at = 0; at < ix.accounts.length; at++) {
        for (const field of ["address", "isSigner", "isWritable"] as const) {
          const bad = structuredClone(instructions);
          bad[index] = { ...ix, accounts: ix.accounts.map((a, i) => i === at ? { ...a, [field]: field === "address" ? key(12) : !a[field] } : a) };
          assert.throws(() => verify(bad));
        }
      }
      const bytes = Buffer.from(ix.dataBase64, "base64");
      for (let at = 0; at < bytes.length; at++) {
        const bad = structuredClone(instructions), changed = Buffer.from(bytes); changed[at] ^= 1;
        bad[index] = { ...ix, dataBase64: changed.toString("base64") }; assert.throws(() => verify(bad));
      }
    }
    if (expected.alt) {
      if (operation === "create-lookup-table") { assert.throws(() => verifySolanaPoolConfigIntent({ feePayer: expected.payer, instructions }, { ...expected, recentSlot: "101" })); }
      assert.throws(() => poolConfigInstructions({ ...expected, recentSlot: "9007199254740992" }));
    }
  }
});
function setup(operation: SolanaPoolConfigExpectation["operation"]) {
  const e = expectation(operation), instructions = poolConfigInstructions(e), signature = "2".repeat(88), blockhash = "3".repeat(44), messageBase64 = "bWVzc2FnZQ==";
  const state = { record: null as SolanaPoolConfigRecord | null, signs: 0, sends: 0, fail: "",
    observation: { kind: "not-found" } as SolanaObservation<PoolConfigStateEvidence> };
  const ports: SolanaPoolConfigPorts = { exclusive: async f => f(), read: async () => state.record,
    write: async record => { state.record = structuredClone(record); if (state.fail === record.phase) { throw new Error("crash after durable write"); } },
    sign: async () => { state.signs++; return { bytesBase64: "c2lnbmVk", signature, blockhash, lastValidBlockHeight: "150" }; },
    inspectSigned: async () => ({ signature, blockhash, messageBase64, intent: { feePayer: e.payer, instructions } }),
    observe: async () => state.observation,
    broadcast: async () => { assert.equal(state.record?.phase, "submitting"); state.sends++; return signature; },
  };
  const finalized = (): SolanaObservation<PoolConfigStateEvidence> => ({ kind: "finalized", signature, messageBase64, slot: "100", err: null,
    state: { operation, mint: e.mint, verified: true } });
  return { state, e, ports, finalized, run: () => runSolanaPoolConfigJournal(e, ports) };
}
test("each config journal never replaces/resends unknown or expired bytes; terminal unreadability stays unresolved", async () => {
  for (const operation of POOL_CONFIG_OPERATIONS) {
    const { state, run, finalized } = setup(operation); state.fail = "submitting";
    await assert.rejects(run()); state.fail = "";
    for (const kind of ["unknown", "expired", "not-found"] as const) { state.observation = { kind }; assert.equal((await run()).status, "unresolved"); }
    assert.equal(state.signs, 1); assert.equal(state.sends, 0);
    state.observation = finalized(); assert.equal((await run()).status, "succeeded");
    state.observation = { kind: "unknown" }; assert.equal((await run()).status, "unresolved"); assert.equal(state.record?.phase, "succeeded");
  }
});
test("stored ALT recentSlot changes and foreign operation outcomes cannot authorize new effects", async () => {
  const { state, e, ports, finalized, run } = setup("create-lookup-table"); await run();
  await assert.rejects(runSolanaPoolConfigJournal({ ...e, recentSlot: "101" }, ports));
  const outcome = finalized(); if (outcome.kind !== "finalized") { assert.fail(); }
  state.observation = { ...outcome, state: { operation: "set-pool", mint: e.mint, verified: true } };
  assert.equal((await run()).status, "unresolved");
  state.observation = { ...outcome, state: null, err: { transactionError: "InvalidAccount" } };
  assert.equal((await run()).status, "failed"); assert.equal(state.sends, 1);
});
test("coherent pool config read propagates actual finalized slot and rejects stale or partial evidence", async () => {
  const e = expectation("set-pool"), addresses = Array.from({ length: 8 }, (_, i) => key(i + 1));
  let called = 0;
  const sdk = { snapshotAddresses: () => addresses, verifySnapshot: (_values: unknown[], _e: SolanaPoolConfigExpectation, phase: string, slot: number, txSlot: number) => {
    called++; assert.equal(phase, "after"); assert.equal(slot, 201); assert.equal(txSlot, 200);
    return { operation: e.operation, mint: e.mint, verified: true as const };
  } };
  const read = async (method: string, params: unknown[]) => {
    assert.equal(method, "getMultipleAccounts"); assert.deepEqual(params, [addresses, { encoding: "base64", commitment: "finalized", minContextSlot: 200 }]);
    return { context: { slot: 201 }, value: addresses };
  };
  assert.equal((await readPoolConfigSnapshot(read, sdk, e, "after", 200)).verified, true);
  for (const result of [{ context: { slot: 199 }, value: addresses }, { context: { slot: "201" }, value: addresses }, { context: { slot: 201 }, value: [] }]) {
    await assert.rejects(readPoolConfigSnapshot(async () => result, sdk, e, "after", 200));
  }
  assert.equal(called, 1);
});


test("append accepts literal raw20 pool, ABI32 token remains unchanged and legacy append journal fails closed", async () => {
  const e = expectation("append-remote-pool-addresses"), instructions = poolConfigInstructions(e);
  const bytes = Buffer.from(instructions[0].dataBase64, "base64");
  assert.equal(bytes.readUInt32LE(48), 1); assert.equal(bytes.readUInt32LE(52), 20);
  assert.equal(bytes.subarray(56).toString("hex"), "24508e2eb3bedc086318abc054153fd83823a4e2");
  const repair = Buffer.from(poolConfigInstructions(expectation("repair-remote-pool-encoding"))[0].dataBase64, "base64");
  assert.equal(repair.readUInt32LE(76), 32);
  assert.equal(repair.subarray(80, 112).toString("hex"), "000000000000000000000000bee91ba3ca94dd7c639ee6c1b1c2fc1a1996cdc9");
  assert.equal(repair[112], 9);
  const f = setup("append-remote-pool-addresses"); await f.run();
  const legacy = Buffer.concat([bytes.subarray(0, 52), Buffer.from([32, 0, 0, 0]), Buffer.alloc(12), bytes.subarray(56)]);
  f.state.record = { ...f.state.record!, intent: { ...f.state.record!.intent, instructions: [{ ...instructions[0], dataBase64: legacy.toString("base64") }] } };
  await assert.rejects(f.run(), /instructions/);
  assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1);
});
