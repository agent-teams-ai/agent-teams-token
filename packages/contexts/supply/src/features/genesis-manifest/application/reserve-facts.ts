import { validateReserveGenesis } from "../domain/reserve-genesis.js";
import { canonicalJson, type JsonValue } from "./canonical.js";

export interface ReserveFactsPorts { readonly sha256: (bytes: Uint8Array) => `0x${string}` }

/** Verify a separately selected configuration hash before publishing deterministic authored facts.
 * A matching hash establishes input identity; it does not authenticate the approving human. */
export function verifyReserveFacts(input: unknown, approvedConfigurationSha256: string, ports: ReserveFactsPorts) {
  const config = validateReserveGenesis(input);
  const configurationSha256 = ports.sha256(new TextEncoder().encode(canonicalJson(config as unknown as JsonValue)));
  if (!/^0x[0-9a-f]{64}$/.test(approvedConfigurationSha256) || configurationSha256 !== approvedConfigurationSha256) {
    throw new Error("RESERVE_GENESIS_APPROVAL_MISMATCH");
  }
  const facts = {
    schema: "agtmai-reserve-public-facts-v1", evidence: "verified-configuration-only",
    broadcastAllowed: false, deploymentVerified: false, configurationSha256,
    initialSupplyBaseUnits: config.initialSupplyBaseUnits, allocations: config.allocations,
    founder: { ...config.founder, bps: 300, revocable: false },
    contributors: { ...config.contributors, bps: 1700, revocable: true, cliffMonths: 12,
      fullyVestedMonth: 48, vestedAtCliffBaseUnits: "0", refund: "unvested-only-to-original-reserve" },
    commitmentPolicy: { windowSeconds: "31536000", interval: "(now-window,now]",
      basis: "gross-funded-allocation", refundsRestoreCapacity: false, unusedCapacityRollsOver: false },
  } as const;
  return { facts, canonicalBytes: new TextEncoder().encode(canonicalJson(facts as unknown as JsonValue)) };
}
