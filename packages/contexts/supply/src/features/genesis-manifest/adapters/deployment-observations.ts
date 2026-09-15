import { keccak_256 } from "@noble/hashes/sha3.js";
import type { ExpectedCreationState } from "../application/deployment-manifest.js";
import { isEvmAddress, type DeploymentConfig, type DeploymentGrant, type Hex } from "../domain/deployment.js";
import { encodeAllocationId, parseCanonicalUint } from "../domain/model.js";

const hex = (bytes: Uint8Array): Hex => `0x${Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")}`;
const hash = (signature: string): Hex => hex(keccak_256(new TextEncoder().encode(signature)));
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const addressWord = (value: string): string => value.slice(2).padStart(64, "0");
const scalar = (value: bigint): Hex => `0x${word(value)}`;
const abiString = (value: string): Hex => {
  const bytes = new TextEncoder().encode(value);
  return `0x${word(32n)}${word(BigInt(bytes.length))}${hex(bytes).slice(2).padEnd(Math.ceil(bytes.length / 32) * 64, "0")}`;
};
const calls = (values: Readonly<Record<string, Hex>>): Readonly<Record<Hex, Hex>> => Object.fromEntries(Object.entries(values).map(([name, result]) => [hash(`${name}()`).slice(0, 10), result]));

export function expectedTokenCalls(config: DeploymentConfig, allocationHash: Hex): ExpectedCreationState {
  return { calls: calls({ name: abiString(config.token.name), symbol: abiString(config.token.symbol), decimals: scalar(9n), totalSupply: scalar(BigInt(config.token.initialSupplyBaseUnits)),
    INITIAL_SUPPLY: scalar(BigInt(config.token.initialSupplyBaseUnits)), GENESIS_ALLOCATION_HASH: allocationHash,
    MAX_GENESIS_ALLOCATIONS: scalar(32n), getCCIPAdmin: `0x${addressWord(config.token.initialCCIPAdmin)}` }),
    logs: config.allocations.flatMap(a => [
      { topics: [hash("Transfer(address,address,uint256)"), scalar(0n), `0x${addressWord(a.recipient)}` as Hex], data: scalar(BigInt(a.amountBaseUnits)) },
      { topics: [hash("GenesisAllocation(bytes32,address,uint256)"), encodeAllocationId(a.id)!, `0x${addressWord(a.recipient)}` as Hex], data: scalar(BigInt(a.amountBaseUnits)) },
    ]) };
}
export function expectedGrantCalls(config: DeploymentConfig, grant: DeploymentGrant, token: Hex): ExpectedCreationState {
  const reserve = config.allocations.find(a => a.id === grant.fundingAllocation)!.recipient;
  const controller = config.custodySafes.find(s => s.id === grant.controllerSafe)!.address;
  const terms = [word(BigInt(grant.amountBaseUnits)), word(BigInt(grant.schedule.start)), word(BigInt(grant.schedule.cliff)), word(BigInt(grant.schedule.end)), word(grant.kind === "founder" ? 0n : 1n), grant.originalPurpose.slice(2)].join("");
  return { calls: calls({ TOKEN: `0x${addressWord(token)}`, BENEFICIARY: `0x${addressWord(grant.beneficiary)}`, ORIGINAL_RESERVE: `0x${addressWord(reserve)}`, CONTROLLER: `0x${addressWord(controller)}`,
    funded: scalar(0n), available: scalar(0n), grant: `0x${terms}${word(0n)}${word(0n)}${word(0n)}${word(1n)}${word(0n)}` }),
    logs: [{ topics: [hash("GrantConfigured(address,address,address,address,(uint256,uint64,uint64,uint64,uint8,bytes32))"), `0x${addressWord(token)}`, `0x${addressWord(grant.beneficiary)}`, `0x${addressWord(reserve)}`], data: `0x${addressWord(controller)}${terms}` }] };
}

/** Direct CREATE identity, using the fixed RLP(sender, nonce) shape; no general RLP framework. */
export function deploymentCreateAddress(sender: Hex, nonce: string): Hex {
  const n = parseCanonicalUint(nonce);
  if (!isEvmAddress(sender) || n === undefined) { throw new Error("DEPLOYMENT_CREATE_IDENTITY"); }
  const nonceHex = n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0");
  const encodedNonce = n === 0n ? "80" : n < 128n ? nonceHex : (128 + nonceHex.length / 2).toString(16) + nonceHex;
  const payload = `94${sender.slice(2)}${encodedNonce}`;
  const preimage = (192 + payload.length / 2).toString(16) + payload;
  const bytes = Uint8Array.from(preimage.match(/../g)!, b => Number.parseInt(b, 16));
  return `0x${hex(keccak_256(bytes)).slice(-40)}`;
}
