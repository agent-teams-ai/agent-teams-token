import { keccak_256 } from "@noble/hashes/sha3.js";
import { isDigest, isEvmAddress, parseCanonicalUint, type DeploymentSafe, type Hex } from "@agent-teams/supply/deployment";
import type { CustodySafeCall } from "../domain/custody-intent.ts";

const fail = (reason: string): never => { throw new Error(`CUSTODY_SAFE_${reason}`); };
const word = (v: bigint): string => v.toString(16).padStart(64, "0");
const addr = (v: string): string => v.slice(2).padStart(64, "0");
const fromHex = (v: Hex): Uint8Array => Uint8Array.from(v.slice(2).match(/../g) ?? [], byte => Number.parseInt(byte, 16));
export const custodyKeccak = (bytes: Uint8Array): Hex => `0x${Buffer.from(keccak_256(bytes)).toString("hex")}`;
export const custodyTopic = (signature: string): Hex => custodyKeccak(new TextEncoder().encode(signature));
export const custodySelector = (signature: string): Hex => custodyTopic(signature).slice(0, 10) as Hex;
const zero = `0x${"0".repeat(40)}` as Hex;
const sentinel = `0x${"0".repeat(39)}1` as Hex;
export interface SafeProfile {
  readonly schema: "agtmai-official-safe-profile-v1"; readonly version: "1.4.1";
  readonly source: "safe-global/safe-smart-account"; readonly sourceRevision: string;
  readonly proxyArtifactSha256: Hex; readonly singletonArtifactSha256: Hex;
  readonly proxyRuntimeKeccak256: Hex; readonly singletonRuntimeKeccak256: Hex;
  readonly singleton: Hex;
}
export interface SafeInspection {
  readonly address: Hex; readonly blockHash: Hex; readonly proxyCode: Hex; readonly singletonCode: Hex;
  readonly singletonStorage: Hex; readonly versionResult: Hex; readonly ownersResult: Hex;
  readonly thresholdResult: Hex; readonly nonceResult: Hex; readonly modulesResult: Hex;
  readonly guardStorage: Hex; readonly fallbackStorage: Hex;
  readonly ownerCode: readonly { readonly address: Hex; readonly code: Hex; readonly blockHash: Hex }[];
}
export const safeInspectionCalls = {
  version: custodySelector("VERSION()"), owners: custodySelector("getOwners()"), threshold: custodySelector("getThreshold()"), nonce: custodySelector("nonce()"),
  modules: `${custodySelector("getModulesPaginated(address,uint256)")}${addr(sentinel)}${word(4n)}` as Hex,
  guardSlot: custodyTopic("guard_manager.guard.address"), fallbackSlot: custodyTopic("fallback_manager.handler.address"),
};
/** Caller authenticates the independently selected profile and its official artifacts before this read check. */
export function verifyCustodySafe(expected: DeploymentSafe, profile: SafeProfile, observation: SafeInspection): { readonly nonce: string; readonly owners: readonly Hex[] } {
  verifySafeProfile(profile);
  if (observation.address !== expected.address || !isDigest(observation.blockHash) || observation.singletonStorage !== `0x${addr(profile.singleton)}`
    || custodyKeccak(fromHex(observation.proxyCode)) !== profile.proxyRuntimeKeccak256 || custodyKeccak(fromHex(observation.singletonCode)) !== profile.singletonRuntimeKeccak256) { fail("CODE_IDENTITY"); }
  const version = new TextEncoder().encode("1.4.1");
  if (observation.versionResult !== `0x${word(32n)}${word(BigInt(version.length))}${Buffer.from(version).toString("hex").padEnd(64, "0")}`) { fail("VERSION"); }
  const ownerWords = observation.ownersResult.slice(2).match(/.{64}/g);
  if (!/^0x[0-9a-f]{320}$/.test(observation.ownersResult) || ownerWords?.[0] !== word(32n) || ownerWords[1] !== word(3n)) { fail("OWNERS"); }
  const owners = ownerWords!.slice(2).map(w => `0x${w.slice(24)}` as Hex);
  if (owners.some((o, i) => !isEvmAddress(o) || o === sentinel || o === expected.address || ownerWords![i + 2] !== addr(o)) || new Set(owners).size !== 3
    || owners.toSorted().join() !== [...expected.owners].toSorted().join() || expected.threshold !== 2 || observation.thresholdResult !== `0x${word(2n)}`) { fail("THRESHOLD_OR_OWNERS"); }
  verifyOwnerCode(owners, observation);
  // A single bounded page proves the complete empty module list only when next == SENTINEL_MODULES.
  if (observation.modulesResult !== `0x${word(64n)}${addr(sentinel)}${word(0n)}` || observation.guardStorage !== `0x${word(0n)}`
    || observation.fallbackStorage !== `0x${word(0n)}`) { fail("UNEXPECTED_EXTENSION"); }
  if (!/^0x[0-9a-f]{64}$/.test(observation.nonceResult)) { fail("NONCE"); }
  return { nonce: BigInt(observation.nonceResult).toString(), owners };
}
function verifyOwnerCode(owners: readonly Hex[], observation: SafeInspection): void {
  if (!Array.isArray(observation.ownerCode) || observation.ownerCode.length !== 3
    || new Set(observation.ownerCode.map(o => o.address)).size !== 3
    || observation.ownerCode.some(o => !owners.includes(o.address) || o.code !== "0x" || o.blockHash !== observation.blockHash)) { fail("UNSUPPORTED_OWNER"); }
}
function verifySafeProfile(profile: SafeProfile): void {
  if (profile.schema !== "agtmai-official-safe-profile-v1" || profile.version !== "1.4.1" || profile.source !== "safe-global/safe-smart-account"
    || !/^[0-9a-f]{40}$/.test(profile.sourceRevision) || !isEvmAddress(profile.singleton)
    || ![profile.proxyArtifactSha256, profile.singletonArtifactSha256, profile.proxyRuntimeKeccak256, profile.singletonRuntimeKeccak256].every(isDigest)) { fail("PROFILE_UNQUALIFIED"); }
}
function safeWords(call: CustodySafeCall): string[] {
  if (!isEvmAddress(call.address) || !isEvmAddress(call.to) || call.value !== "0" || call.operation !== "CALL" || call.data !== "0xea8a1af0"
    || call.baseGas !== "0" || call.gasPrice !== "0" || call.gasToken !== zero || call.refundReceiver !== zero
    || parseCanonicalUint(call.safeTxGas) === undefined || parseCanonicalUint(call.nonce) === undefined) { fail("CALL_SCOPE"); }
  return [addr(call.to), word(0n), "", word(0n), word(BigInt(call.safeTxGas)), word(0n), word(0n), addr(zero), addr(zero)];
}
export function custodySafeHash(chainId: "31337" | "11155111", call: CustodySafeCall): Hex {
  if (!["31337", "11155111"].includes(chainId)) { return fail("CHAIN"); }
  const words = safeWords(call); words[2] = custodyKeccak(fromHex(call.data)).slice(2);
  const type = custodyTopic("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)");
  const struct = custodyKeccak(fromHex(`0x${type.slice(2)}${words.join("")}${word(BigInt(call.nonce))}`));
  const domain = custodyKeccak(fromHex(`0x${custodyTopic("EIP712Domain(uint256 chainId,address verifyingContract)").slice(2)}${word(BigInt(chainId))}${addr(call.address)}`));
  return custodyKeccak(fromHex(`0x1901${domain.slice(2)}${struct.slice(2)}`));
}
export interface SafeOwnerSignature { readonly owner: Hex; readonly signature: Hex }
export async function custodySafeCalldata(chainId: "31337" | "11155111", call: CustodySafeCall, expected: DeploymentSafe,
  signatures: readonly SafeOwnerSignature[], verifySignature: (owner: Hex, hash: Hex, signature: Hex) => Promise<boolean>): Promise<Hex> {
  const hash = custodySafeHash(chainId, call);
  if (call.address !== expected.address || hash !== call.transactionHash || expected.threshold !== 2 || signatures.length !== 2) { fail("TRANSACTION_IDENTITY"); }
  const sorted = signatures.toSorted((a, b) => a.owner < b.owner ? -1 : 1);
  if (sorted[0]!.owner === sorted[1]!.owner) { fail("DUPLICATE_OWNER"); }
  for (const signed of sorted) {
    if (!expected.owners.includes(signed.owner) || !/^0x[0-9a-f]{128}(1b|1c)$/.test(signed.signature)) { fail("SIGNATURE_FORMAT"); }
    const r = BigInt(`0x${signed.signature.slice(2, 66)}`), s = BigInt(`0x${signed.signature.slice(66, 130)}`);
    if (r === 0n || s === 0n || s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n
      || !(await verifySignature(signed.owner, hash, signed.signature))) { fail("SIGNATURE_INVALID"); }
  }
  const words = safeWords(call), data = call.data.slice(2), sigs = sorted.map(s => s.signature.slice(2)).join("");
  words[2] = word(320n);
  const dataTail = word(BigInt(data.length / 2)) + data.padEnd(Math.ceil(data.length / 64) * 64, "0");
  words.push(word(320n + BigInt(dataTail.length / 2)));
  return `${custodySelector("execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)")}${words.join("")}${dataTail}${word(BigInt(sigs.length / 2))}${sigs.padEnd(Math.ceil(sigs.length / 64) * 64, "0")}` as Hex;
}
export interface SafeReceiptLog { readonly address: Hex; readonly topics: readonly Hex[]; readonly data: Hex; readonly removed: boolean }
export function custodySafeResult(chainId: "31337" | "11155111", call: CustodySafeCall, logs: readonly SafeReceiptLog[]): "success" | "failure" {
  if (custodySafeHash(chainId, call) !== call.transactionHash) { return fail("TRANSACTION_IDENTITY"); }
  const success = custodyTopic("ExecutionSuccess(bytes32,uint256)"), failure = custodyTopic("ExecutionFailure(bytes32,uint256)");
  const matching = logs.filter(l => l.address === call.address && [success, failure].includes(l.topics[0]!));
  if (matching.length !== 1 || matching[0]!.topics.length !== 1 || matching[0]!.removed || matching[0]!.data !== `${call.transactionHash}${word(0n)}`) { return fail("INNER_RESULT_UNPROVEN"); }
  return matching[0]!.topics[0] === success ? "success" : "failure";
}


/** Bounded direct setup only: no delegatecall, handler or payment; factory/batch forms remain unqualified. */
export function custodySafeSetupOwners(safe: Hex, data: Hex): readonly Hex[] {
  const selector = custodySelector("setup(address[],uint256,address,bytes,address,address,uint256,address)");
  if (!data.startsWith(selector) || !/^0x[0-9a-f]{840}$/.test(data)) { return fail("INITIALIZATION"); }
  const words = data.slice(10).match(/.{64}/g)!;
  const expected = [word(256n), word(2n), word(0n), word(384n), word(0n), word(0n), word(0n), word(0n), word(3n)];
  if (expected.some((value, index) => words[index] !== value) || words[12] !== word(0n)) { return fail("INITIALIZATION"); }
  const owners = words.slice(9, 12).map(value => `0x${value.slice(24)}` as Hex);
  if (new Set(owners).size !== 3 || owners.some((owner, i) => !isEvmAddress(owner) || owner === sentinel || owner === safe || words[i + 9] !== addr(owner))) { return fail("INITIALIZATION"); }
  return owners;
}

export function verifyCustodySafeSetupEvent(safe: Hex, initiator: Hex, owners: readonly Hex[], logs: readonly SafeReceiptLog[]): void {
  const matching = logs.filter(log => log.address === safe && log.topics[0] === custodyTopic("SafeSetup(address,address[],uint256,address,address)"));
  const expectedData = `0x${word(128n)}${word(2n)}${word(0n)}${word(0n)}${word(3n)}${owners.map(addr).join("")}`;
  if (matching.length !== 1 || matching[0]!.removed || matching[0]!.topics.length !== 2
    || matching[0]!.topics[1] !== `0x${addr(initiator)}` || matching[0]!.data !== expectedData) { fail("INITIALIZATION"); }
}
