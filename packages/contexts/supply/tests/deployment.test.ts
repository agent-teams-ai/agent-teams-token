import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateDeployment, isSolanaAddress, type DeploymentConfig } from "../src/features/genesis-manifest/domain/deployment.js";
import { calendarSchedule, acceleratedSchedule } from "../src/features/genesis-manifest/domain/grant-schedule.js";
import { parseDeploymentSource } from "../src/features/genesis-manifest/adapters/deployment-source.js";

// Fixtures are authored independently; their exact values have no product approval.
const fixture = (mode = "local-test"): DeploymentConfig => JSON.parse(readFileSync(`tests/fixtures/deployment/${mode}.json`, "utf8"));
function changed(path: readonly string[], replacement: unknown): unknown {
  const result = fixture() as unknown as Record<string, unknown>;
  let target = result;
  for (const key of path.slice(0, -1)) { target = target[key] as Record<string, unknown>; }
  target[path.at(-1)!] = replacement;
  return result;
}
const codes = (value: unknown): readonly string[] => validateDeployment(value).diagnostics.map(d => d.code);

test("two independent configurations retain supplied amounts, recipients and exact schedules", () => {
  for (const mode of ["local-test", "owned-testnet"]) {
    const source = fixture(mode), result = validateDeployment(source);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.value!.token.initialSupplyBaseUnits, mode === "local-test" ? "1000000" : "37000000");
    assert.equal(result.value!.grants[1]!.beneficiary, mode === "local-test" ? "0x0000000000000000000000000000000000000069" : "0x00000000000000000000000000000000000000cd");
    assert.deepEqual(result.value!.grants[0]!.schedule, source.grants[0]!.schedule);
    assert.equal(result.allocations![0]!.id, "founder-reserve");
  }
});

test("canonical configuration ignores allocation and Safe owner ordering", () => {
  const a = fixture(), b = { ...a, allocations: [...a.allocations].toReversed(), custodySafes: a.custodySafes.map(s => ({ ...s, owners: [...s.owners].toReversed() })) };
  assert.deepEqual(parseDeploymentSource(JSON.stringify(a)).canonicalBytes, parseDeploymentSource(JSON.stringify(b)).canonicalBytes);
});

test("invalid numerical encodings, ABI bounds and reference drift fail closed", () => {
  for (const value of [0, 1000000, "01", "1e6", "1.0", "-1", "18446744073709551616", "9".repeat(100)]) {
    assert.ok(codes(changed(["token", "initialSupplyBaseUnits"], value)).includes("DEPLOYMENT_UINT_INVALID"));
  }
  for (const path of [["grants", "0", "fundingAllocation"], ["grants", "0", "controllerSafe"]]) {
    assert.ok(codes(changed(path, "missing")).some(c => c.endsWith("REFERENCE")));
  }
  assert.ok(codes(changed(["grants", "0", "amountBaseUnits"], "500000")).includes("DEPLOYMENT_RESERVE_INSOLVENT"));
  assert.ok(codes(changed(["allocations", "0", "bps"], 6001)).includes("GENESIS_BPS_AMOUNT_MISMATCH"));
  assert.ok(codes(changed(["allocations", "0", "recipient"], fixture().allocations[1]!.recipient)).includes("GENESIS_RECIPIENT_DUPLICATE"));
  assert.ok(codes(changed(["environment", "evmChainId"], "1")).includes("DEPLOYMENT_VALUE_INVALID"));
  assert.ok(codes(changed(["environment", "evmSelector"], Number("16015286601757825753"))).includes("DEPLOYMENT_UINT_INVALID"));
});

test("addresses, purposes, role aliases and Safe authority expectations are explicit", () => {
  assert.equal(isSolanaAddress("1".repeat(33)), false);
  assert.equal(isSolanaAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), true);
  assert.ok(codes(changed(["grants", "0", "originalPurpose"], "0x" + "0".repeat(64))).includes("DEPLOYMENT_PURPOSE_INVALID"));
  assert.ok(codes(changed(["custodySafes", "0", "threshold"], 1)).includes("DEPLOYMENT_VALUE_INVALID"));
  assert.ok(codes(changed(["custodySafes", "0", "owners", "1"], fixture().custodySafes[0]!.owners[0])).includes("DEPLOYMENT_SAFE_OWNERS"));
  const aliased = changed(["grants", "0", "beneficiary"], fixture().allocations[1]!.recipient) as DeploymentConfig;
  assert.ok(codes(aliased).includes("DEPLOYMENT_ROLE_ALIAS_UNAPPROVED"));
  assert.deepEqual(codes({ ...aliased, roleAliases: [{ address: aliased.allocations[1]!.recipient, roles: ["allocation.founder-reserve.recipient", "grant.founder-one.beneficiary"] }] }), []);
});

test("calendar anniversaries preserve UTC time, including the 2100 non-leap century", () => {
  const start = String(Date.parse("2096-02-29T19:35:47Z") / 1000);
  assert.throws(() => calendarSchedule(start), /ANNIVERSARY_RULE_REQUIRED/);
  const feb = calendarSchedule(start, "february-28"), march = calendarSchedule(start, "march-1");
  assert.equal(new Date(Number(feb.cliff) * 1000).toISOString(), "2097-02-28T19:35:47.000Z");
  assert.equal(new Date(Number(feb.end) * 1000).toISOString(), "2100-02-28T19:35:47.000Z");
  assert.equal(new Date(Number(march.end) * 1000).toISOString(), "2100-03-01T19:35:47.000Z");
  assert.throws(() => calendarSchedule("18446744073709551615"), /RANGE/);
  assert.throws(() => acceleratedSchedule("18446744073709551615", "1", "2"), /INVALID/);
  assert.deepEqual(acceleratedSchedule("100", "12", "48"), { profile: "accelerated-test", start: "100", cliff: "112", end: "148" });
  assert.ok(codes(changed(["grants", "0", "schedule", "cliff"], "1831638601")).includes("DEPLOYMENT_CALENDAR_ANNIVERSARY"));
});

test("production rejects test schedules and an unresolved bridge", () => {
  const source = fixture("owned-testnet");
  const production = { ...source, status: "accepted", environment: { ...source.environment, mode: "mainnet-dry-run", evmChainId: "1" }, testScenario: null };
  assert.ok(codes(production).includes("DEPLOYMENT_TEST_SCHEDULE_FORBIDDEN"));
  assert.ok(codes(production).includes("DEPLOYMENT_BRIDGE_REQUIRED"));
});

test("strict source rejects ambiguous or unbounded documents without printing private input", () => {
  const secret = "secret-example-MUST-NOT-APPEAR";
  const sources = ["a: 1\na: 2", "a: &a x\nb: *a", "a: !!str x", "a: 1\n---\nb: 2", "[".repeat(40) + "]".repeat(40), "x".repeat(1_048_577), `password: ${secret}\na: [`];
  for (const source of sources) {
    const result = parseDeploymentSource(source);
    assert.ok(result.diagnostics.length > 0);
    assert.equal(result.canonicalBytes, undefined);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.ok(codes({ ...fixture(), [secret]: "private" }).includes("DEPLOYMENT_UNKNOWN_FIELD"));
  assert.equal(JSON.stringify(validateDeployment({ ...fixture(), [secret]: "private" })).includes(secret), false);
});
