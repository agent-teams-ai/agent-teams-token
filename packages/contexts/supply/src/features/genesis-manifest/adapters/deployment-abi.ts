import { encodeAllocationId, EXPECTED_TOKEN, type NormalizedAllocation } from "../domain/model.js";
import { isEvmAddress, type DeploymentConfig, type DeploymentGrant, type Hex } from "../domain/deployment.js";
import { encodeAllocationCommitment } from "./abi.js";

const word = (value: bigint): string => {
  if (value < 0n || value >= 1n << 256n) { throw new Error("DEPLOYMENT_ABI_UINT_WIDTH"); }
  return value.toString(16).padStart(64, "0");
};
const addressWord = (value: string): string => {
  if (!isEvmAddress(value)) { throw new Error("DEPLOYMENT_ABI_ADDRESS"); }
  return value.slice(2).padStart(64, "0");
};
const productionWord = (value: bigint): string => {
  if (value < 0n || value >= 1n << 256n) { throw new Error("DEPLOYMENT_ABI_UINT_WIDTH"); }
  return value.toString(16).padStart(64, "0");
};

export function encodeDeploymentToken(config: DeploymentConfig, allocations: readonly NormalizedAllocation[]): { constructorArgs: Hex; rawAllocationAbi: Hex; genesisAllocationHash: Hex } {
  return encodeLocalPurposeToken(config.environment.evmChainId, config.token.initialSupplyBaseUnits, config.token.initialCCIPAdmin, allocations);
}

export function encodeLocalPurposeToken(chainId: string, supply: string, administrator: Hex, allocations: readonly NormalizedAllocation[]): { constructorArgs: Hex; rawAllocationAbi: Hex; genesisAllocationHash: Hex } {
  const body = allocations.map(a => `${a.idBytes32.slice(2)}${addressWord(a.recipient)}${word(BigInt(a.amountBaseUnits))}`).join("");
  const constructorArgs: Hex = `0x${word(BigInt(supply))}${word(96n)}${addressWord(administrator)}${word(BigInt(allocations.length))}${body}`;
  const commitment = encodeAllocationCommitment({ network: { chainId }, token: { ...EXPECTED_TOKEN, initialSupplyBaseUnits: supply } }, allocations);
  return { constructorArgs, rawAllocationAbi: commitment.rawAbi, genesisAllocationHash: commitment.hash };
}

export function encodeLocalPurposeVault(input: { token: Hex; controller: Hex; purpose: Hex; opensAt: string; windowSeconds: string; rollingCap: string }): Hex {
  return `0x${[addressWord(input.token), addressWord(input.controller), input.purpose.slice(2), word(BigInt(input.opensAt)), word(BigInt(input.windowSeconds)), word(BigInt(input.rollingCap))].join("")}`;
}

/** The actual GrantVault constructor: four addresses followed by the six static Terms words. */
export function encodeDeploymentGrant(config: DeploymentConfig, grant: DeploymentGrant, token: Hex): Hex {
  // Recheck the enum at this runtime boundary, including callers outside the validator.
  if (grant.kind !== "founder" && grant.kind !== "team") { throw new Error("DEPLOYMENT_ABI_GRANT_KIND"); }
  const reserve = config.allocations.find(a => a.id === grant.fundingAllocation);
  const safe = config.custodySafes.find(s => s.id === grant.controllerSafe);
  if (!reserve || !safe || !encodeAllocationId(grant.id)) { throw new Error("DEPLOYMENT_ABI_BINDINGS"); }
  for (const seconds of [grant.schedule.start, grant.schedule.cliff, grant.schedule.end]) {
    if (BigInt(seconds) >= 1n << 64n) { throw new Error("DEPLOYMENT_ABI_TIME_WIDTH"); }
  }
  return `0x${[addressWord(token), addressWord(grant.beneficiary), addressWord(reserve.recipient), addressWord(safe.address),
    word(BigInt(grant.amountBaseUnits)), word(BigInt(grant.schedule.start)), word(BigInt(grant.schedule.cliff)), word(BigInt(grant.schedule.end)),
    word(grant.kind === "founder" ? 0n : 1n), grant.originalPurpose.slice(2)].join("")}`;
}

export interface ProductionFounderReserveInput {
  readonly token: Hex;
  readonly beneficiary: Hex;
  readonly controller: Hex;
  readonly allocation: string;
  readonly start: string;
  readonly cliff: string;
  readonly end: string;
  readonly purpose: Hex;
}

export function encodeProductionFounderReserve(input: ProductionFounderReserveInput): Hex {
  return `0x${[addressWord(input.token), addressWord(input.beneficiary), addressWord(input.controller), productionWord(BigInt(input.allocation)), productionWord(BigInt(input.start)), productionWord(BigInt(input.cliff)), productionWord(BigInt(input.end)), productionWord(0n), input.purpose.slice(2)].join("")}`;
}

/** The child constructor is encoded from its authenticated parent inputs, never a fabricated grant record. */
export function encodeProductionFounderVault(input: ProductionFounderReserveInput & { readonly reserve: Hex }): Hex {
  return `0x${[addressWord(input.token), addressWord(input.beneficiary), addressWord(input.reserve), addressWord(input.controller),
    productionWord(BigInt(input.allocation)), productionWord(BigInt(input.start)), productionWord(BigInt(input.cliff)),
    productionWord(BigInt(input.end)), productionWord(0n), input.purpose.slice(2)].join("")}`;
}

export function encodeProductionReserveController(token: Hex, controller: Hex, purpose: Hex, rollingCap: string, perGrantCap: string): Hex {
  return `0x${[addressWord(token), addressWord(controller), purpose.slice(2), productionWord(BigInt(rollingCap)), productionWord(BigInt(perGrantCap))].join("")}`;
}
