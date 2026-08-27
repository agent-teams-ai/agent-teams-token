import assert from "node:assert/strict";
import test from "node:test";

import { reconcileSupply, type SupplySnapshot } from "./supply.js";

const fixedSupply = 100_000_000_000_000_000n;

const reconcile = (
  overrides: Partial<SupplySnapshot> = {},
): ReturnType<typeof reconcileSupply> =>
  reconcileSupply({
    fixedSupply,
    lockedOnEthereum: 0n,
    supplyOnSolana: 0n,
    pendingEthereumToSolana: 0n,
    pendingSolanaToEthereum: 0n,
    ...overrides,
  });

test("initial and quiescent states reconcile exactly", () => {
  assert.deepEqual(reconcile(), {
    adjustedGlobalSupply: fixedSupply,
    backingSurplus: 0n,
    status: "exact",
  });

  assert.equal(
    reconcile({ lockedOnEthereum: 1_000n, supplyOnSolana: 1_000n }).status,
    "exact",
  );
});

test("Ethereum to Solana in-flight value remains accounted for", () => {
  const result = reconcile({
    lockedOnEthereum: 1_000n,
    pendingEthereumToSolana: 1_000n,
  });

  assert.equal(result.adjustedGlobalSupply, fixedSupply);
  assert.equal(result.status, "exact");
});

test("Solana to Ethereum in-flight value remains accounted for", () => {
  const result = reconcile({
    lockedOnEthereum: 1_000n,
    supplyOnSolana: 600n,
    pendingSolanaToEthereum: 400n,
  });

  assert.equal(result.adjustedGlobalSupply, fixedSupply);
  assert.equal(result.status, "exact");
});

test("an unexplained remote mint is under-backed", () => {
  const result = reconcile({
    lockedOnEthereum: 1_000n,
    supplyOnSolana: 1_001n,
  });

  assert.equal(result.adjustedGlobalSupply, fixedSupply + 1n);
  assert.equal(result.backingSurplus, -1n);
  assert.equal(result.status, "under-backed");
});

test("negative inputs are rejected", () => {
  assert.throws(
    () => reconcile({ pendingSolanaToEthereum: -1n }),
    /must not be negative/,
  );
});

