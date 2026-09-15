import { encodeAllocationId, type NormalizedAllocation } from "../domain/model.js";
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

export function encodeDeploymentToken(config: DeploymentConfig, allocations: readonly NormalizedAllocation[]): { constructorArgs: Hex; rawAllocationAbi: Hex; genesisAllocationHash: Hex } {
  const body = allocations.map(a => `${a.idBytes32.slice(2)}${addressWord(a.recipient)}${word(BigInt(a.amountBaseUnits))}`).join("");
  const constructorArgs: Hex = `0x${word(BigInt(config.token.initialSupplyBaseUnits))}${word(96n)}${addressWord(config.token.initialCCIPAdmin)}${word(BigInt(allocations.length))}${body}`;
  const commitment = encodeAllocationCommitment({ network: { chainId: config.environment.evmChainId }, token: config.token }, allocations);
  return { constructorArgs, rawAllocationAbi: commitment.rawAbi, genesisAllocationHash: commitment.hash };
}

/** The actual GrantVault constructor: four addresses followed by the six static Terms words. */
export function encodeDeploymentGrant(config: DeploymentConfig, grant: DeploymentGrant, token: Hex): Hex {
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
