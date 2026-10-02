import type { LocalPurposeGenesis } from "../domain/local-purpose-genesis.js";
import { validateReserveGenesis } from "../domain/reserve-genesis.js";
import { canonicalJson, type JsonValue } from "./canonical.js";
import type { ValidatedProductionDeployment } from "../domain/production-deployment.js";

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
    name: "Agent Teams AI", symbol: "AGTMAI", decimals: 9,
    initialSupplyBaseUnits: config.initialSupplyBaseUnits, allocations: config.allocations,
    founder: { ...config.founder, bps: 300, revocable: false },
    contributors: { ...config.contributors, bps: 1700, revocable: true, cliffMonths: 12,
      fullyVestedMonth: 48, vestedAtCliffBaseUnits: "0", refund: "unvested-only-to-original-reserve" },
    commitmentPolicy: { windowSeconds: "31536000", interval: "(now-window,now]",
      basis: "gross-funded-allocation", refundsRestoreCapacity: false, unusedCapacityRollsOver: false },
  } as const;
  return { facts, canonicalBytes: new TextEncoder().encode(canonicalJson(facts as unknown as JsonValue)) };
}

/** Projection of admitted v2 inputs. Approval digests identify inputs, not the approving human. */
export function projectAssemblyFacts(config: ValidatedProductionDeployment, assemblyConfigurationSha256: string) {
  if (config.schema !== "agtmai-production-deployment-v2" || config.purposeVaults === undefined) {
    throw new Error("PRODUCTION_ASSEMBLY_V2_REQUIRED");
  }
  return assemblyFacts({ reserveGenesis: config.reserveGenesis, purposeVaults: config.purposeVaults }, assemblyConfigurationSha256);
}
function assemblyFacts(config: { reserveGenesis: LocalPurposeGenesis["reserve"]; purposeVaults: LocalPurposeGenesis["purposeVaults"] }, assemblyConfigurationSha256: string) {
  return { broadcastAllowed: false as const, evidence: "unsigned-preparation" as const, deploymentVerified: false as const,
    configuration: "accepted-production-configuration" as const, assemblyConfigurationSha256,
    actualProductionDeployment: "unavailable" as const, syntheticLocalObservation: "pending" as const,
    reserve: config.reserveGenesis, purposeVaults: config.purposeVaults.map(policy => ({ ...policy,
      recipient: config.reserveGenesis.allocations.find(a => a.id === policy.allocationId)!.recipient,
      controller: config.reserveGenesis.contributors.controller })),
    disclosure: "A full cap can leave at opening. The controller selects recipients; downstream transfers are unrestricted. Refunds do not restore gross capacity; expiry restores rolling capacity. No lifetime cap exists." };
}

/** Selected synthetic policy is not an accepted production configuration. */
export function projectLocalAssemblyFacts(config: LocalPurposeGenesis, configurationSha256: string) {
  return { ...assemblyFacts({ reserveGenesis: config.reserve, purposeVaults: config.purposeVaults }, configurationSha256),
    evidence: "synthetic-local-observation" as const, configuration: "selected-test-only-policy" as const,
    syntheticLocalObservation: "observed-owned-loopback-chain-1" as const, approval: null, deploymentVerified: false as const };
}
