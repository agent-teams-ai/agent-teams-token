import assert from "node:assert/strict";
import { test } from "node:test";
import { validateReserveGenesis, type ReserveGenesis } from "../src/features/genesis-manifest/domain/reserve-genesis.js";
import { verifyReserveFacts } from "../src/features/genesis-manifest/application/reserve-facts.js";
import { calendarSchedule } from "../src/features/genesis-manifest/domain/grant-schedule.js";
import { canonicalJson, type JsonValue } from "../src/features/genesis-manifest/application/canonical.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";

function fixture(): ReserveGenesis {
  const shares = [3000, 3000, 300, 1700, 900, 500, 500, 100];
  return {
    schema: "agtmai-reserve-genesis-v1", status: "accepted", initialSupplyBaseUnits: "1000000",
    allocations: shares.map((bps, i) => ({ id: i === 2 ? "founder" : i === 3 ? "contributors" : `fixture-${i}`,
      recipient: `0x${String(i + 1).padStart(40, "0")}`, bps, amountBaseUnits: String(bps * 100) })),
    founder: { beneficiary: `0x${"a".repeat(40)}`, controller: `0x${"b".repeat(40)}`,
      purpose: `0x${"1".repeat(64)}`, schedule: calendarSchedule("1800000000") },
    contributors: { controller: `0x${"b".repeat(40)}`, purpose: `0x${"2".repeat(64)}`,
      rollingCapBaseUnits: "20000", perGrantCapBaseUnits: "5000" },
  };
}
function approval(input: ReserveGenesis): `0x${string}` {
  return sha256(new TextEncoder().encode(canonicalJson(validateReserveGenesis(input) as unknown as JsonValue)));
}

test("offline facts bind exact allocation, founder rights and gross cap inputs deterministically", () => {
  const source = fixture(), hash = approval(source);
  const first = verifyReserveFacts(source, hash, { sha256 });
  const reversed = { ...source, allocations: source.allocations.toReversed() };
  assert.deepEqual(verifyReserveFacts(reversed, hash, { sha256 }).canonicalBytes, first.canonicalBytes);
  assert.equal(first.facts.allocations.reduce((sum, a) => sum + BigInt(a.amountBaseUnits), 0n), 1000000n);
  assert.equal(first.facts.founder.revocable, false);
  assert.equal(first.facts.contributors.bps, 1700);
  assert.equal(first.facts.commitmentPolicy.refundsRestoreCapacity, false);
  assert.equal(first.facts.deploymentVerified, false);
  assert.equal(first.facts.broadcastAllowed, false);
  assert.throws(() => verifyReserveFacts({ ...source, contributors: { ...source.contributors,
    perGrantCapBaseUnits: "4999" } }, hash, { sha256 }), /APPROVAL_MISMATCH/);
});

test("reject draft, unknown fields, supply drift, incorrect percentages and recipient aliases", () => {
  const source = fixture();
  for (const input of [null, {}, { ...source, status: "draft" }, { ...source, network: "mainnet" },
    { ...source, initialSupplyBaseUnits: "1000001" },
    { ...source, allocations: source.allocations.map((a, i) => i === 0 ? { ...a, amountBaseUnits: "1" } : a) },
    { ...source, allocations: source.allocations.map((a, i) => i === 2 ? { ...a, id: "renamed-founder" } : a) },
    { ...source, allocations: source.allocations.map((a, i) => i === 0 ? { ...a, recipient: source.allocations[1]!.recipient } : a) },
  ]) { assert.throws(() => validateReserveGenesis(input), /RESERVE_GENESIS_INVALID/); }
});

test("reject invalid caps, accelerated schedules and calendar drift", () => {
  const source = fixture();
  for (const cap of ["0", "20001", "01", 5000]) {
    assert.throws(() => validateReserveGenesis({ ...source, contributors: { ...source.contributors,
      perGrantCapBaseUnits: cap } }), /RESERVE_GENESIS_INVALID/);
  }
  for (const schedule of [{ ...source.founder.schedule, profile: "accelerated-test" },
    { ...source.founder.schedule, cliff: String(BigInt(source.founder.schedule.cliff) + 1n) },
    { ...source.founder.schedule, hidden: true }]) {
    assert.throws(() => validateReserveGenesis({ ...source, founder: { ...source.founder, schedule } }), /RESERVE_GENESIS_INVALID/);
  }
});

test("leap-day schedules require explicit anniversary policy and preserve exact UTC seconds", () => {
  const start = String(Date.parse("2028-02-29T12:34:56Z") / 1000);
  assert.throws(() => calendarSchedule(start), /ANNIVERSARY_RULE_REQUIRED/);
  const source = fixture();
  const result = validateReserveGenesis({ ...source, founder: { ...source.founder,
    schedule: calendarSchedule(start, "february-28") } });
  assert.equal(result.founder.schedule.cliff, String(Date.parse("2029-02-28T12:34:56Z") / 1000));
  assert.equal(result.founder.schedule.end, String(Date.parse("2032-02-29T12:34:56Z") / 1000));
});

test("exact integral allocation does not require supply divisible by 10000", () => {
  const source = fixture();
  const minimal = { ...source, initialSupplyBaseUnits: "100",
    allocations: source.allocations.map(a => ({ ...a, amountBaseUnits: String(a.bps / 100) })),
    contributors: { ...source.contributors, rollingCapBaseUnits: "2", perGrantCapBaseUnits: "1" } };
  assert.equal(validateReserveGenesis(minimal).allocations.reduce((sum, a) => sum + BigInt(a.amountBaseUnits), 0n), 100n);
  assert.throws(() => validateReserveGenesis({ ...minimal, initialSupplyBaseUnits: "101" }), /RESERVE_GENESIS_INVALID/);
});
