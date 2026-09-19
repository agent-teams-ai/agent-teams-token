import { deploymentBytes, isDigest, isEvmAddress, parseCanonicalUint, UINT64_MAX, UINT256_MAX,
  type Hex } from "@agent-teams/supply/deployment";

export type CustodyOperation = "deploy-token" | "deploy-grant" | "approve" | "fund" | "release" | "cancel-team" | "claim-debt" | "reject-founder-cancel";
export interface CustodySafeCall {
  readonly address: Hex; readonly nonce: string; readonly transactionHash: Hex;
  readonly to: Hex; readonly value: "0"; readonly data: Hex; readonly operation: "CALL";
  readonly safeTxGas: string; readonly baseGas: "0"; readonly gasPrice: "0";
  readonly gasToken: "0x0000000000000000000000000000000000000000";
  readonly refundReceiver: "0x0000000000000000000000000000000000000000";
}
export type CustodyDeployment = {
  readonly contract: "AGTMAICCIPToken"; readonly artifactSha256: Hex;
  readonly creationBytecode: Hex; readonly constructorBytes: Hex; readonly administrator: Hex;
} | {
  readonly contract: "GrantVault"; readonly artifactSha256: Hex;
  readonly creationBytecode: Hex; readonly constructorBytes: Hex;
  readonly token: Hex; readonly beneficiary: Hex; readonly reserve: Hex; readonly controller: Hex;
};
export interface CustodyIntent {
  readonly schema: "agtmai-custody-intent-v2";
  readonly configurationSha256: Hex; readonly operationId: string; readonly operation: CustodyOperation;
  readonly environment: "local-test" | "owned-testnet"; readonly chainId: "31337" | "11155111";
  readonly kind: "deploy" | "call"; readonly from: Hex; readonly to: Hex | null;
  readonly nonce: string; readonly value: "0"; readonly data: Hex;
  readonly callerRole: "deployer" | "reserve" | "beneficiary" | "safe-executor";
  readonly prerequisiteSha256: Hex;
  readonly gasLimit: string; readonly maxFeePerGasWei: string; readonly maxPriorityFeePerGasWei: string;
  readonly deployment: CustodyDeployment | null; readonly safe: CustodySafeCall | null;
}
const invalid = (): never => { throw new Error("CUSTODY_INTENT_INVALID"); };
const exactKeys = (value: object, keys: string): boolean => Object.keys(value).toSorted().join() === keys.split(",").toSorted().join();
const bytes = (value: unknown): value is Hex => typeof value === "string" && /^0x(?:[0-9a-f]{2})+$/.test(value);
const uintWord = (value: string): string => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (value: Hex): string => value.slice(2).padStart(64, "0");
function validateDeployment(intent: CustodyIntent): void {
  const d = intent.deployment;
  if (intent.kind === "call") {
    if (!isEvmAddress(intent.to) || d !== null || intent.data.length < 10 || intent.operation.startsWith("deploy-")) { invalid(); }
    return;
  }
  if (intent.kind !== "deploy" || intent.to !== null || d === null || !isDigest(d.artifactSha256)
    || !bytes(d.creationBytecode) || !bytes(d.constructorBytes) || intent.data !== d.creationBytecode + d.constructorBytes.slice(2)
    || intent.callerRole !== "deployer") { return invalid(); }
  validateConstructorBinding(intent, d);
}
function validateConstructorBinding(intent: CustodyIntent, d: CustodyDeployment): void {
  if (d.contract === "AGTMAICCIPToken") {
    if (!exactKeys(d, "contract,artifactSha256,creationBytecode,constructorBytes,administrator") || intent.operation !== "deploy-token"
      || !isEvmAddress(d.administrator) || d.constructorBytes.slice(130, 194) !== addressWord(d.administrator)) { invalid(); }
  } else if (d.contract === "GrantVault") {
    if (!exactKeys(d, "contract,artifactSha256,creationBytecode,constructorBytes,token,beneficiary,reserve,controller") || intent.operation !== "deploy-grant"
      || ![d.token, d.beneficiary, d.reserve, d.controller].every(isEvmAddress)
      || d.constructorBytes.length !== 2 + 10 * 64
      || d.constructorBytes.slice(2, 258) !== [d.token, d.beneficiary, d.reserve, d.controller].map(addressWord).join("")) { invalid(); }
  } else { invalid(); }
}
function validateSafe(intent: CustodyIntent): void {
  const safe = intent.safe;
  if (safe === null) {
    if (["cancel-team", "reject-founder-cancel"].includes(intent.operation) || intent.callerRole === "safe-executor") { invalid(); }
    return;
  }
  validateSafeShape(safe);
  if (!exactKeys(safe, "address,nonce,transactionHash,to,value,data,operation,safeTxGas,baseGas,gasPrice,gasToken,refundReceiver")
    || intent.kind !== "call" || intent.callerRole !== "safe-executor" || !["cancel-team", "reject-founder-cancel"].includes(intent.operation)
    || safe.address !== intent.to || !isEvmAddress(safe.to) || !isDigest(safe.transactionHash) || parseCanonicalUint(safe.nonce) === undefined
    ) { invalid(); }
  if (BigInt(safe.safeTxGas) > BigInt(intent.gasLimit) || (intent.operation === "reject-founder-cancel" && safe.safeTxGas === "0")) { invalid(); }
  validateSafeCalldata(safe, intent.data);
}
/** Decode the bounded execTransaction ABI used by the two-owner EOA custody profile. */
function validateSafeCalldata(safe: CustodySafeCall, data: Hex): void {
  if (data.slice(0, 10) !== "0x6a761202" || data.length !== 10 + 18 * 64) { invalid(); }
  const words = data.slice(10).match(/.{64}/g)!;
  const expected = [addressWord(safe.to), uintWord(safe.value), uintWord("320"), uintWord("0"),
    uintWord(safe.safeTxGas), uintWord(safe.baseGas), uintWord(safe.gasPrice), addressWord(safe.gasToken),
    addressWord(safe.refundReceiver), uintWord("384"), uintWord("4"), safe.data.slice(2).padEnd(64, "0"), uintWord("130")];
  if (expected.some((value, index) => words[index] !== value)) { invalid(); }
  const signatures = words.slice(13).join("");
  if (!/^(?:[0-9a-f]{128}(?:1b|1c)){2}0{60}$/.test(signatures)) { invalid(); }
}
function validateSafeShape(safe: CustodySafeCall): void {
  const zero = "0x0000000000000000000000000000000000000000";
  if (safe.operation !== "CALL" || safe.value !== "0" || safe.data !== "0xea8a1af0"
    || parseCanonicalUint(safe.safeTxGas, UINT64_MAX) === undefined || safe.baseGas !== "0" || safe.gasPrice !== "0" || safe.gasToken !== zero || safe.refundReceiver !== zero) { invalid(); }
}
/** V2 binds fees, prerequisites and vault/Safe identity. It never interprets V1 journals. */
export function canonicalCustodyIntent(intent: CustodyIntent): string {
  if (!intent || !exactKeys(intent, "schema,configurationSha256,operationId,operation,environment,chainId,kind,from,to,nonce,value,data,callerRole,prerequisiteSha256,gasLimit,maxFeePerGasWei,maxPriorityFeePerGasWei,deployment,safe")
    || intent.schema !== "agtmai-custody-intent-v2" || !isDigest(intent.configurationSha256) || !isDigest(intent.prerequisiteSha256)
    || !/^[a-z][a-z0-9-]{0,95}$/.test(intent.operationId) || !isEvmAddress(intent.from) || intent.value !== "0" || !bytes(intent.data)) { invalid(); }
  if (!(["deploy-token", "deploy-grant", "approve", "fund", "release", "cancel-team", "claim-debt", "reject-founder-cancel"] as const).includes(intent.operation)
    || !["deployer", "reserve", "beneficiary", "safe-executor"].includes(intent.callerRole)
    || !["local-test", "owned-testnet"].includes(intent.environment)
    || intent.chainId !== (intent.environment === "local-test" ? "31337" : "11155111")
    || parseCanonicalUint(intent.nonce, UINT64_MAX - 1n) === undefined) { invalid(); }
  validateFees(intent);
  validateDeployment(intent); validateSafe(intent);
  return new TextDecoder().decode(deploymentBytes(intent));
}
function validateFees(intent: CustodyIntent): void {
  for (const value of [intent.gasLimit, intent.maxFeePerGasWei, intent.maxPriorityFeePerGasWei]) {
    if (parseCanonicalUint(value, UINT256_MAX) === undefined) { invalid(); }
  }
  if (BigInt(intent.gasLimit) === 0n || BigInt(intent.maxFeePerGasWei) === 0n || BigInt(intent.maxPriorityFeePerGasWei) > BigInt(intent.maxFeePerGasWei)) { invalid(); }
}
export function validateCustodyIntent(input: CustodyIntent, expected: CustodyIntent): CustodyIntent {
  const canonical = canonicalCustodyIntent(input);
  if (canonical !== canonicalCustodyIntent(expected)) { invalid(); }
  return JSON.parse(canonical) as CustodyIntent;
}
