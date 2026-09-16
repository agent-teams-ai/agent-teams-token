export interface SupplySnapshot {
  readonly fixedSupply: bigint;
  readonly lockedOnEthereum: bigint;
  readonly supplyOnSolana: bigint;
  readonly pendingEthereumToSolana: bigint;
  readonly pendingSolanaToEthereum: bigint;
}

export type BackingStatus = "under-backed" | "exact" | "surplus";

export interface SupplyReconciliation {
  readonly adjustedGlobalSupply: bigint;
  readonly backingSurplus: bigint;
  readonly status: BackingStatus;
}

const assertNonNegative = (label: string, value: bigint): void => {
  if (value < 0n) {
    throw new RangeError(`${label} must not be negative`);
  }
};

export const reconcileSupply = (
  snapshot: SupplySnapshot,
): SupplyReconciliation => {
  const fields = [
    "fixedSupply",
    "lockedOnEthereum",
    "supplyOnSolana",
    "pendingEthereumToSolana",
    "pendingSolanaToEthereum",
  ] as const satisfies readonly (keyof SupplySnapshot)[];
  for (const field of fields) {
    assertNonNegative(field, snapshot[field]);
  }

  const pending =
    snapshot.pendingEthereumToSolana + snapshot.pendingSolanaToEthereum;
  const backingSurplus =
    snapshot.lockedOnEthereum - snapshot.supplyOnSolana - pending;
  const adjustedGlobalSupply =
    snapshot.fixedSupply -
    snapshot.lockedOnEthereum +
    snapshot.supplyOnSolana +
    pending;

  return {
    adjustedGlobalSupply,
    backingSurplus,
    status:
      backingSurplus < 0n
        ? "under-backed"
        : backingSurplus > 0n
          ? "surplus"
          : "exact",
  };
};
