import assert from "node:assert/strict";
import test from "node:test";
import { projectMessage } from "../src/features/ccip-status/message.js";
import type { TransferEvent, TransferIdentity } from "../src/features/ccip-status/message.js";

const identity: TransferIdentity = {
  messageId: "message-1", direction: "ethereum-to-solana", amount: 10_000_000_000n,
  sourceToken: "evm-token", destinationToken: "spl-mint", recipient: "destination-ata",
};
const lock: TransferEvent = {
  ...identity, chain: "ethereum", kind: "lock", transactionId: "lock-tx",
  eventIndex: 0, blockHash: "source-block", blockHeight: 100n, finality: "finalized",
};
const mint: TransferEvent = {
  ...identity, chain: "solana", kind: "mint", transactionId: "mint-tx",
  eventIndex: 1, blockHash: "destination-block", blockHeight: 200n, finality: "finalized",
};

test("lock remains pending until destination finality, including manual execution", () => {
  assert.equal(projectMessage(identity, [lock]).pendingAmount, identity.amount);
  assert.equal(projectMessage(identity, [lock], true).status, "manual-execution");
  assert.equal(projectMessage(identity, [lock, { ...mint, finality: "unfinalized" }]).status, "pending");
  assert.equal(projectMessage(identity, [lock, mint]).status, "settled");
  assert.equal(projectMessage(identity, [lock, mint]).pendingAmount, 0n);
});
test("duplicate observations are idempotent, duplicate effects are inconsistent", () => {
  assert.deepEqual(projectMessage(identity, [lock, mint, mint]), projectMessage(identity, [mint, lock]));
  assert.equal(projectMessage(identity, [lock, mint, { ...mint, transactionId: "another-mint" }]).status, "inconsistent");
});
test("orphan mint, mismatched recipient, amount, and event kind never settle", () => {
  for (const events of [[mint], [lock, { ...mint, recipient: "attacker" }],
    [lock, { ...mint, amount: 11n }], [lock, { ...mint, kind: "burn" as const }]]) {
    assert.equal(projectMessage(identity, events).status, "inconsistent");
  }
});
test("reorgs and nonfinal source observations cannot produce successful delivery", () => {
  assert.equal(projectMessage(identity, [{ ...lock, finality: "reorged" }, mint]).status, "unknown");
  assert.equal(projectMessage(identity, [{ ...lock, finality: "unfinalized" }, mint]).status, "unknown");
  assert.equal(projectMessage(identity, [lock, { ...lock, blockHash: "replacement" }]).status, "inconsistent");
});
test("finality updates merge deterministically; a later reorg revokes settlement", () => {
  const early: TransferEvent = { ...mint, finality: "unfinalized" };
  assert.equal(projectMessage(identity, [lock, early, mint]).status, "settled");
  assert.equal(projectMessage(identity, [mint, early, lock]).status, "settled");
  assert.equal(projectMessage(identity, [lock, mint, { ...mint, finality: "reorged" }]).status, "unknown");
  assert.equal(projectMessage(identity, [lock, mint, { ...mint, finality: "reorged" }]).pendingAmount, null);
  assert.equal(projectMessage(identity, [mint]).pendingAmount, null);
  const reordered = Object.fromEntries(Object.entries(mint).toReversed()) as unknown as TransferEvent;
  assert.equal(projectMessage(identity, [lock, mint, reordered]).status, "settled");
});
test("burn/release direction uses the same exact amount without reversing backing semantics", () => {
  const reverse: TransferIdentity = { ...identity, direction: "solana-to-ethereum",
    sourceToken: "spl-mint", destinationToken: "evm-token", recipient: "evm-recipient" };
  const burn: TransferEvent = { ...mint, ...reverse, kind: "burn" };
  const release: TransferEvent = { ...lock, ...reverse, kind: "release" };
  assert.equal(projectMessage(reverse, [burn]).pendingAmount, identity.amount);
  assert.equal(projectMessage(reverse, [burn, release]).status, "settled");
});
