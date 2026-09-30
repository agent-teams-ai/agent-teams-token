import assert from "node:assert/strict";
import test from "node:test";
import { validateLocalPurposeGenesis, PURPOSE_ALLOCATION_IDS } from "../src/features/genesis-manifest/domain/local-purpose-genesis.js";
import { validateProductionDeployment } from "../src/features/genesis-manifest/domain/production-deployment.js";
import { validateReserveGenesis } from "../src/features/genesis-manifest/domain/reserve-genesis.js";
import { syntheticProductionEnvelope } from "./production-fixture.js";

type Mutable = Record<string, any>;
function fixture(): Mutable {
  const production = syntheticProductionEnvelope() as Mutable;
  const { schema: _schema, status: _status, ...reserve } = production.reserveGenesis;
  return {
    schema: "agtmai-local-purpose-genesis-v1", status: "test-only", chainId: "31337",
    tokenContract: "AGTMAICCIPToken", reserve,
    custodySafes: production.deployment.custodySafes,
    roleAliases: [
      { address: production.deployment.custodySafes[0].address, roles: ["safe.project-controller.address", "token.initialCCIPAdmin", "founder.controller", "contributors.controller"] },
      { address: production.deployment.custodySafes[1].address, roles: ["safe.founder-beneficiary.address", "founder.beneficiary"] },
    ],
    projectControllerSafeId: "project-controller", founderBeneficiarySafeId: "founder-beneficiary",
    purposeVaults: PURPOSE_ALLOCATION_IDS.map((allocationId, i) => ({ allocationId, opensAt: String(1900000000 + i * 1000),
      windowSeconds: String(86400 + i), rollingCapBaseUnits: "1000000000000000" })),
    execution: { sender: `0x${"9".repeat(40)}`, startingNonce: "8", fundingDeadline: "1799999940",
      fundingLeadSeconds: "60", executionDeadline: "1800000100", maxFeePerGasWei: "10000000000",
      maxPriorityFeePerGasWei: "1000000000", maxGasPerTransaction: "6000000", maxTotalFeeWei: "300000000000000000" },
  };
}
function invalid(mutator: (value: Mutable) => void): void {
  const value = fixture(); mutator(value);
  assert.throws(() => validateLocalPurposeGenesis(value), /LOCAL_PURPOSE_GENESIS_INVALID/);
}

test("accepts a detached, sorted six-vault local policy while both production entrypoints reject it", () => {
  const source = fixture();
  source.purposeVaults.reverse();
  const value = validateLocalPurposeGenesis(source);
  assert.deepEqual(value.purposeVaults.map(p => p.allocationId), PURPOSE_ALLOCATION_IDS);
  assert.equal(value.reserve.allocations.length, 8);
  source.purposeVaults[0].rollingCapBaseUnits = "0";
  assert.equal(value.purposeVaults[5]?.rollingCapBaseUnits, "1000000000000000");
  assert.throws(() => validateReserveGenesis(fixture()), /RESERVE_GENESIS_INVALID/);
  assert.equal(validateProductionDeployment(fixture()).value, undefined);
  invalid(v => { v.status = "accepted"; });
  invalid(v => { v.reserve.status = "accepted"; });
  invalid(v => { v.bridge = null; });
});

test("rejects missing, duplicated and extra purpose policies and allocation drift", () => {
  invalid(v => { v.purposeVaults.pop(); });
  invalid(v => { v.purposeVaults[0].allocationId = "users"; });
  invalid(v => { v.purposeVaults.push({ ...v.purposeVaults[0], allocationId: "treasury" }); });
  invalid(v => { v.reserve.allocations.find((a: Mutable) => a.id === "users").amountBaseUnits = "1"; });
  invalid(v => { v.reserve.allocations[0].bps = 1700; });
  invalid(v => { v.reserve.allocations[0].recipient = v.reserve.allocations[1].recipient; });
});

test("rejects noncanonical and out-of-range amounts, windows and opening times", () => {
  const exactCap = fixture();
  exactCap.purposeVaults[0].rollingCapBaseUnits = "30000000000000000";
  assert.equal(validateLocalPurposeGenesis(exactCap).purposeVaults[0]?.rollingCapBaseUnits, "30000000000000000");
  for (const cap of ["0", "01", "-1", "30000000000000001", "18446744073709551616", 1]) {
    invalid(v => { v.purposeVaults[0].rollingCapBaseUnits = cap; });
  }
  for (const width of ["0", "01", "18446744073709551616", 1]) {
    invalid(v => { v.purposeVaults[0].windowSeconds = width; });
    invalid(v => { v.purposeVaults[0].opensAt = width; });
  }
  invalid(v => { v.reserve.initialSupplyBaseUnits = "0100000000000000000"; });
  invalid(v => { v.execution.startingNonce = "18446744073709551607"; });
});

test("equal-share purpose policy swaps remain explicit authored facts", () => {
  const first = validateLocalPurposeGenesis(fixture());
  const changed = fixture();
  [changed.purposeVaults[0].allocationId, changed.purposeVaults[1].allocationId] =
    [changed.purposeVaults[1].allocationId, changed.purposeVaults[0].allocationId];
  const second = validateLocalPurposeGenesis(changed);
  assert.notDeepEqual(first.purposeVaults, second.purposeVaults);
  assert.equal(second.purposeVaults[0]?.opensAt, first.purposeVaults[1]?.opensAt);
});

test("binds two distinct qualified Safes, declared overlaps and synthetic sender", () => {
  invalid(v => { v.custodySafes[1].address = v.custodySafes[0].address; });
  invalid(v => { v.custodySafes[0].owners[1] = v.custodySafes[0].owners[0]; });
  invalid(v => { v.custodySafes[0].threshold = 1; });
  invalid(v => { v.custodySafes[0].disclosure = ""; });
  invalid(v => { v.reserve.contributors.controller = v.custodySafes[1].address; });
  invalid(v => { v.reserve.founder.beneficiary = v.custodySafes[0].address; });
  invalid(v => { v.roleAliases.pop(); });
  invalid(v => { v.roleAliases[0].roles.pop(); });
  invalid(v => { v.execution.sender = v.custodySafes[0].address; });
  invalid(v => { v.reserve.allocations[0].recipient = v.custodySafes[0].address; });
  // Shared owner keys are admissible only when their duplicated role is disclosed exactly.
  invalid(v => { v.custodySafes[1].owners[0] = v.custodySafes[0].owners[0]; });
  const shared = fixture();
  shared.custodySafes[1].owners[0] = shared.custodySafes[0].owners[0];
  shared.roleAliases.push({ address: shared.custodySafes[0].owners[0], roles: ["safe.project-controller.owner", "safe.founder-beneficiary.owner"] });
  assert.doesNotThrow(() => validateLocalPurposeGenesis(shared));
});

test("rejects deadlines that leave no founder lead or open a vault before execution ends", () => {
  invalid(v => { v.execution.fundingDeadline = v.execution.executionDeadline; });
  invalid(v => { v.execution.fundingLeadSeconds = "61"; });
  invalid(v => { v.execution.executionDeadline = v.purposeVaults[0].opensAt; });
  invalid(v => { v.execution.maxPriorityFeePerGasWei = "10000000001"; });
  invalid(v => { v.execution.maxTotalFeeWei = "00"; });
});

test("rejects sparse or decorated inventories before a policy can be normalized", () => {
  // A hole retains array length, so skipping it could publish fewer than six policies.
  invalid(v => { delete v.purposeVaults[5]; });
  invalid(v => { delete v.reserve.allocations[7]; });
  // A missing index could otherwise reduce the actual Safe quorum or overlap declaration.
  invalid(v => { delete v.custodySafes[0].owners[2]; });
  invalid(v => { delete v.roleAliases[0].roles[2]; });
  for (const select of [
    (v: Mutable) => v.purposeVaults,
    (v: Mutable) => v.reserve.allocations,
    (v: Mutable) => v.custodySafes[0].owners,
    (v: Mutable) => v.roleAliases[0].roles,
  ]) {
    // Unvalidated array properties must not disappear from the normalized policy.
    invalid(v => { select(v).extra = "unknown"; });
    invalid(v => { Object.defineProperty(select(v), "hidden", { value: "unknown" }); });
    invalid(v => { Object.defineProperty(select(v), "0", { get: () => select(fixture())[0], enumerable: true, configurable: true }); });
  }
});

test("rejects hidden required fields, unknown substitutes and accessors at object boundaries", () => {
  // Unknown keys once compensated for hidden required fields, then clone dropped the required field.
  invalid(v => { Object.defineProperty(v.purposeVaults[0], "opensAt", { enumerable: false }); v.purposeVaults[0].extra = "unknown"; });
  invalid(v => { Object.defineProperty(v, "status", { enumerable: false }); v.bridge = null; });
  for (const [select, key] of [
    [(v: Mutable) => v, "status"],
    [(v: Mutable) => v.purposeVaults[0], "opensAt"],
    [(v: Mutable) => v.custodySafes[0], "threshold"],
    [(v: Mutable) => v.roleAliases[0], "roles"],
    [(v: Mutable) => v.execution, "fundingDeadline"],
    [(v: Mutable) => v.reserve, "initialSupplyBaseUnits"],
    [(v: Mutable) => v.reserve.allocations[0], "bps"],
    [(v: Mutable) => v.reserve.founder, "schedule"],
    [(v: Mutable) => v.reserve.founder.schedule, "start"],
    [(v: Mutable) => v.reserve.contributors, "controller"],
  ] as const) {
    invalid(v => { Object.defineProperty(select(v), key, { enumerable: false }); });
    invalid(v => {
      const record = select(v);
      const oldValue = record[key];
      Object.defineProperty(record, key, { get: () => oldValue, enumerable: true, configurable: true });
    });
    invalid(v => { select(v).unknown = "unvalidated"; });
  }
});

test("normalization returns a detached configuration accepted unchanged on revalidation", () => {
  const source = fixture();
  source.custodySafes.reverse();
  source.purposeVaults.reverse();
  source.roleAliases.reverse();
  const normalized = validateLocalPurposeGenesis(source);
  assert.deepEqual(validateLocalPurposeGenesis(normalized), normalized);
  source.execution.maxFeePerGasWei = "1";
  assert.equal(normalized.execution.maxFeePerGasWei, "10000000000");
  const shared = fixture();
  shared.custodySafes[1].owners[0] = shared.custodySafes[0].owners[0];
  shared.roleAliases.push({ address: shared.custodySafes[0].owners[0],
    roles: ["safe.project-controller.owner", "safe.founder-beneficiary.owner"] });
  const normalizedShared = validateLocalPurposeGenesis(shared);
  assert.deepEqual(validateLocalPurposeGenesis(normalizedShared), normalizedShared);
});
