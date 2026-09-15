import assert from "node:assert/strict";
import test from "node:test";
import { custodyNextAction, custodyVested, verifyCustodySnapshot, verifyCustodyTransition, type CustodyTransition } from "../src/domain/custody.ts";
import type { CustodyIntent } from "../src/domain/custody-intent.ts";
import { hash, blockHash, manifestFixture, snapshotFixture, stateFixture, safeCalldataFixture } from "./fixtures/custody.ts";

function cancellationFixture() {
  const manifest = manifestFixture(), team = manifest.configuration.grants.find(g => g.kind === "team")!;
  const quarter = (BigInt(team.schedule.cliff) + (BigInt(team.schedule.end) - BigInt(team.schedule.cliff)) / 4n).toString();
  const halfway = (BigInt(team.schedule.cliff) + (BigInt(team.schedule.end) - BigInt(team.schedule.cliff)) / 2n).toString();
  const founderBefore = stateFixture(manifest, "founder-one", { funded: true, available: "25000" });
  const teamBefore = stateFixture(manifest, "team-one", { funded: true, released: "50000", lastTransition: quarter });
  const founderAfter = { ...founderBefore, available: "50000" };
  const teamAfter = { ...teamBefore, cancelled: true, frozenEntitlement: "100000", available: "50000", lastTransition: halfway };
  const before = snapshotFixture(manifest, quarter, "7", [founderBefore, teamBefore], ["400000", "300000", "0", "50000", "100000", "150000"]);
  const after = snapshotFixture(manifest, halfway, "8", [founderAfter, teamAfter], ["500000", "300000", "0", "50000", "100000", "50000"]);
  const zero = "0x0000000000000000000000000000000000000000";
  const intent: CustodyIntent = { schema: "agtmai-custody-intent-v2", configurationSha256: hash, operationId: "team-one-cancel-team", operation: "cancel-team",
    environment: "local-test", chainId: "31337", kind: "call", from: manifest.configuration.token.initialCCIPAdmin, to: teamBefore.controller,
    nonce: "9", value: "0", data: "0x12345678", callerRole: "safe-executor", prerequisiteSha256: hash, gasLimit: "200000",
    maxFeePerGasWei: "2000000000", maxPriorityFeePerGasWei: "0", deployment: null, safe: { address: teamBefore.controller, nonce: "0", transactionHash: hash,
      to: teamBefore.address, value: "0", data: "0xea8a1af0", operation: "CALL", safeTxGas: "100000", baseGas: "0", gasPrice: "0", gasToken: zero, refundReceiver: zero } };
  const transition: CustodyTransition = { operationId: intent.operationId, grantId: team.id, operation: "cancel-team", intent: { ...intent, data: safeCalldataFixture(intent.safe!) }, transactionHash: hash,
    block: after.block, before, after, receiptStatus: 1, safeResult: "success", movements: [{ from: teamBefore.address, to: teamBefore.reserve, amount: "100000" }], gasUsed: "65000", effectiveGasPrice: "1000000000" };
  return { manifest, team, transition };
}
test("independent curve has no cliff catch-up, exact end and integer rounding", () => {
  const { team } = cancellationFixture();
  assert.equal(custodyVested(team, team.schedule.start), 0n);
  assert.equal(custodyVested(team, team.schedule.cliff), 0n);
  assert.equal(custodyVested(team, (BigInt(team.schedule.cliff) + 1n).toString()), 0n);
  assert.equal(custodyVested(team, team.schedule.end), 200000n);
  assert.equal(custodyVested(team, (BigInt(team.schedule.end) + 1n).toString()), 200000n);
});
test("positive cancellation returns unvested principal and preserves unpaid vested debt", () => {
  const { manifest, transition } = cancellationFixture();
  const result = verifyCustodyTransition(manifest, transition);
  assert.equal(result.released, "50000"); assert.equal(result.refunded, "100000"); assert.equal(result.vestedDebt, "50000");
  assert.equal(result.remainingPrincipal, "50000"); assert.equal(result.feeWei, "65000000000000");
  assert.equal(result.founderRejection, false);
});
test("refund based on allocation minus released, wrong reserve and successful outer/failed inner all fail", () => {
  const { manifest, transition } = cancellationFixture();
  for (const patch of [{ safeResult: "failure" }, { receiptStatus: 0 }, { block: { ...transition.block, hash } },
    { movements: [{ ...transition.movements[0]!, amount: "150000" }] }, { movements: [{ ...transition.movements[0]!, to: transition.after.grants[1]!.beneficiary }] }]) {
    assert.throws(() => verifyCustodyTransition(manifest, { ...transition, ...patch } as CustodyTransition), /CUSTODY_/);
  }
});
test("later debt release retains the frozen cancellation entitlement and conserves principal", () => {
  const { manifest, team, transition: cancellation } = cancellationFixture();
  verifyCustodyTransition(manifest, cancellation);
  const before = cancellation.after, grant = before.grants[1]!;
  const later = (BigInt(team.schedule.cliff) + (BigInt(team.schedule.end) - BigInt(team.schedule.cliff)) * 3n / 4n).toString();
  const after = snapshotFixture(manifest, later, "9", [
    { ...before.grants[0]!, available: "75000" },
    { ...grant, released: "100000", available: "0", lastTransition: later },
  ], ["500000", "300000", "0", "100000", "100000", "0"]);
  const intent: CustodyIntent = { ...cancellation.intent, operationId: "team-one-claim-debt", operation: "claim-debt",
    from: grant.beneficiary, to: grant.address, callerRole: "beneficiary", data: "0x86d1a69f", safe: null };
  const claim: CustodyTransition = { ...cancellation, operationId: intent.operationId, operation: "claim-debt", intent,
    before, after, block: after.block, safeResult: null, movements: [{ from: grant.address, to: grant.beneficiary, amount: "50000" }] };
  const result = verifyCustodyTransition(manifest, claim);
  assert.equal(result.released, "100000"); assert.equal(result.refunded, "100000");
  assert.equal(result.vestedDebt, "0"); assert.equal(result.remainingPrincipal, "0");
  assert.equal(BigInt(result.released) + BigInt(result.refunded) + BigInt(result.remainingPrincipal), 200000n);
  for (const amount of ["49999", "50001", "100000"]) {
    assert.throws(() => verifyCustodyTransition(manifest, { ...claim, movements: [{ ...claim.movements[0]!, amount }] }), /CUSTODY_TRANSITION_EFFECT_MISMATCH/);
  }
  const wrongFrozen = { ...after, grants: after.grants.map(g => g.grantId === team.id ? { ...g, frozenEntitlement: "150000", released: "150000" } : g) };
  assert.throws(() => verifyCustodyTransition(manifest, { ...claim, after: wrongFrozen }), /CUSTODY_/);
  const wrongBalance = { ...after, balances: after.balances.map(b => b.address === grant.address ? { ...b, amount: "1" } : b) };
  assert.throws(() => verifyCustodyTransition(manifest, { ...claim, after: wrongBalance }), /CUSTODY_INVENTORY_CONSERVATION/);
});
test("changed immutable bindings, supply and omitted or aliased inventories are rejected", () => {
  const { manifest, transition } = cancellationFixture(), snapshot = transition.after;
  for (const patch of [{ totalSupply: "1000001" }, { chainId: "11155111" }, { balances: snapshot.balances.slice(1) },
    { balances: [...snapshot.balances.slice(0, -1), snapshot.balances[0]!] },
    { grants: snapshot.grants.map(g => ({ ...g, controller: manifest.configuration.token.initialCCIPAdmin })) },
    { grants: snapshot.grants.map(g => ({ ...g, originalPurpose: blockHash })) }]) {
    assert.throws(() => verifyCustodySnapshot(manifest, { ...snapshot, ...patch } as typeof snapshot), /CUSTODY_/);
  }
});
test("operation selection refuses late/excess funding and waits for integer-positive debt", () => {
  const { manifest, team, transition } = cancellationFixture(), fresh = stateFixture(manifest, team.id);
  assert.equal(custodyNextAction(team, fresh, team.schedule.start, false), "approve");
  assert.equal(custodyNextAction(team, { ...fresh, allowance: "200000" }, team.schedule.start, false), "fund");
  assert.throws(() => custodyNextAction(team, { ...fresh, allowance: "200001" }, team.schedule.start, false), /EXCESS_ALLOWANCE/);
  assert.throws(() => custodyNextAction(team, fresh, (BigInt(team.schedule.start) + 1n).toString(), false), /DEADLINE/);
  const state = transition.before.grants[1]!;
  assert.equal(custodyNextAction(team, state, transition.before.block.timestamp, false), "wait");
  assert.equal(custodyNextAction(team, state, transition.after.block.timestamp, false), "cancel-team");
  assert.equal(custodyNextAction(team, transition.after.grants[1]!, transition.after.block.timestamp, false), "claim-debt");
  assert.throws(() => custodyNextAction(team, state, team.schedule.end, false), /WINDOW_MISSED/);
});
