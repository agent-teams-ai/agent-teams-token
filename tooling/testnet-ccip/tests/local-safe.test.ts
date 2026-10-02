import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Hex } from "@agent-teams/supply/deployment";
import { executeLocalSafe, settleOwnedSignerWork, type LocalSafePorts } from "../src/adapters/local-safe.ts";
import { custodySafeHash } from "../src/adapters/safe-custody.ts";

const address = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;

test("six-owner batch drains launched work before failure, cleanup or readiness continuations", async t => {
  const failed = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
  t.after(() => { failed.resolve(); held.resolve(); });
  const failure = new Error("PROOF_SIGNER_GENERATION_FAILED"), events: string[] = [];
  const work = Array.from({ length: 6 }, async (_, i) => {
    events.push(`start-${i}`);
    try { if (i === 0) { await failed.promise; } if (i === 1) { await held.promise; } return i; }
    finally { events.push(`settled-${i}`); }
  });
  const outcome = settleOwnedSignerWork(work).finally(() => { events.push("cleanup"); }).then(() => events.push("READY"), cause => {
    assert.equal(cause, failure); return events.push("failed");
  });
  failed.reject(failure);
  await nextTurn();
  assert.equal(events.filter(e => e.startsWith("start-")).length, 6);
  assert.ok(events.includes("settled-0"));
  assert.equal(events.includes("settled-1"), false);
  assert.deepEqual({ failed: events.includes("failed"), cleanup: events.includes("cleanup") },
    { failed: false, cleanup: false }, "failure diagnostics and custody cleanup must wait for held work");
  held.resolve(); await outcome;
  assert.equal(events.filter(e => e.startsWith("settled-")).length, 6);
  assert.deepEqual(events.slice(-3), ["settled-1", "cleanup", "failed"]);
  assert.equal(events.includes("READY"), false);
});

test("Safe signing rejection waits for the other injected signature without sending", async t => {
  const safe = { safe: address(10), owners: [address(11), address(12), address(13)], setup: { status: "0x1", transactionHash: `0x${"a".repeat(64)}` as Hex } };
  const to = address(20), data = "0xea8a1af0" as Hex;
  const zero = "0x0000000000000000000000000000000000000000";
  const hash = custodySafeHash("31337", { address: safe.safe, nonce: "7", transactionHash: safe.setup.transactionHash, to, value: "0", data,
    operation: "CALL", safeTxGas: "4000000", baseGas: "0", gasPrice: "0", gasToken: zero, refundReceiver: zero });
  const failed = Promise.withResolvers<Hex>(), held = Promise.withResolvers<Hex>();
  t.after(() => { failed.resolve("0x"); held.resolve("0x"); });
  const failure = new Error("ASSEMBLY_CAST_FAILED"), events: string[] = [];
  const forbidden = async (): Promise<never> => { events.push("unexpected-effect"); throw new Error("SIGNING_MUST_NOT_CONTINUE"); };
  const ports: LocalSafePorts = { chainId: "31337", relayer: address(99), rpc: forbidden, encode: forbidden, send: forbidden, verifySignature: forbidden,
    call: async (_, signature) => signature === "nonce()" ? "0x7" : hash,
    sign: async (owner, requestedHash) => {
      assert.equal(requestedHash, hash); events.push(`start-${owner}`);
      try { return await (owner === safe.owners[0] ? failed.promise : held.promise); }
      finally { events.push(`settled-${owner}`); }
    },
  };
  const outcome = executeLocalSafe(ports, safe, to, data).finally(() => { events.push("cleanup"); }).then(() => events.push("success"), cause => {
    assert.equal(cause, failure); return events.push("failed");
  });
  await nextTurn();
  assert.deepEqual(events, safe.owners.slice(0, 2).map(owner => `start-${owner}`));
  failed.reject(failure); await nextTurn();
  assert.equal(events.includes(`settled-${safe.owners[0]}`), true);
  assert.deepEqual({ failed: events.includes("failed"), cleanup: events.includes("cleanup") },
    { failed: false, cleanup: false }, "Safe must not return while another signer is pending");
  held.resolve("0x"); await outcome;
  assert.deepEqual(events.slice(-3), [`settled-${safe.owners[1]}`, "cleanup", "failed"]);
  assert.equal(events.includes("unexpected-effect"), false, "no verification, encoding, RPC or send after signing failure");
  assert.equal(events.includes("success"), false);
});
