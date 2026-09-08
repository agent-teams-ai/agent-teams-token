/** Pure intent checking. Expected intents must originate in the decoded deployment plan. */
export type DecimalInput = bigint | string;
export interface DeploymentBinding {
  readonly artifactId: string;
  readonly artifactSha256: string;
  readonly creationBytecode: string;
  readonly constructorBytes: string;
  readonly administrator: string;
  /** Pool owner is its deployer; AGTMAICCIPToken admin is constructor word 2. */
  readonly administratorBinding: "sender" | "constructor-word-2";
}
export interface SepoliaIntentInput {
  readonly chainId: DecimalInput;
  readonly kind: "deploy" | "call";
  readonly from: string;
  readonly nonce: DecimalInput;
  readonly value: DecimalInput;
  readonly data: string;
  readonly to?: string;
  readonly deployment?: DeploymentBinding;
}
export interface SepoliaIntentEnvelope {
  readonly schema: "agtmai-sepolia-intent-v1";
  readonly chainId: "11155111";
  readonly kind: "deploy" | "call";
  readonly from: string;
  readonly nonce: string;
  readonly value: string;
  readonly data: string;
  readonly to: string | null;
  readonly deployment: DeploymentBinding | null;
}
const UINT256_MAX = (1n << 256n) - 1n;
const fail = (field: string): never => { throw new Error(`Invalid Sepolia intent: ${field}`); };
function decimal(value: DecimalInput, field: string, maximum = UINT256_MAX): string {
  if (typeof value !== "bigint" && (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))) {
    return fail(field);
  }
  const number = BigInt(value);
  if (number < 0n || number > maximum) {return fail(field);}
  return number.toString();
}
function hex(value: string, field: string, empty = false): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || (!empty && value === "0x")) {
    return fail(field);
  }
  return value.toLowerCase();
}
function address(value: string, field: string): string {
  const result = hex(value, field);
  if (result.length !== 42 || /^0x0+$/.test(result)) {return fail(field);}
  return result;
}
function normalize(input: SepoliaIntentInput): SepoliaIntentEnvelope {
  if (!input || decimal(input.chainId, "chainId") !== "11155111") {return fail("chainId");}
  const from = address(input.from, "from");
  const nonce = decimal(input.nonce, "nonce", (1n << 64n) - 2n);
  const value = decimal(input.value, "value");
  const data = hex(input.data, "data");
  let deployment: DeploymentBinding | null = null;
  let to: string | null = null;
  if (input.kind === "deploy") {
    if (input.to !== undefined || !input.deployment) {return fail("deployment shape");}
    const binding = input.deployment;
    if (typeof binding.artifactId !== "string" || !/^[A-Za-z0-9_./:@-]{1,256}$/.test(binding.artifactId)) {
      return fail("artifactId");
    }
    if (typeof binding.artifactSha256 !== "string" || !/^[0-9a-f]{64}$/.test(binding.artifactSha256)) {
      return fail("artifactSha256");
    }
    const creationBytecode = hex(binding.creationBytecode, "creationBytecode");
    const constructorBytes = hex(binding.constructorBytes, "constructorBytes", true);
    const administrator = address(binding.administrator, "administrator");
    if (data !== creationBytecode + constructorBytes.slice(2)) {return fail("deployment calldata");}
    if (binding.administratorBinding === "sender") {
      if (administrator !== from) {return fail("deployer administrator");}
    } else if (binding.administratorBinding === "constructor-word-2") {
      const adminWord = constructorBytes.slice(130, 194);
      if (adminWord !== "0".repeat(24) + administrator.slice(2)) {return fail("constructor administrator");}
    } else {return fail("administratorBinding");}
    deployment = {
      artifactId: binding.artifactId, artifactSha256: binding.artifactSha256,
      creationBytecode, constructorBytes, administrator,
      administratorBinding: binding.administratorBinding,
    };
  } else if (input.kind === "call") {
    if (input.deployment !== undefined || input.to === undefined || data.length < 10) {return fail("call shape");}
    to = address(input.to, "to");
  } else {return fail("kind");}
  return {
    schema: "agtmai-sepolia-intent-v1", chainId: "11155111", kind: input.kind,
    from, nonce, value, data, to, deployment,
  };
}
/** Stable JSON bytes for the journal's SHA-256; input property order is immaterial. */
export function canonicalIntentJson(envelope: SepoliaIntentEnvelope): string {
  const input: SepoliaIntentInput = {
    chainId: envelope.chainId, kind: envelope.kind, from: envelope.from,
    nonce: envelope.nonce, value: envelope.value, data: envelope.data,
    ...(envelope.to === null ? {} : { to: envelope.to }),
    ...(envelope.deployment === null ? {} : { deployment: envelope.deployment }),
  };
  if (envelope.schema !== "agtmai-sepolia-intent-v1") {return fail("schema");}
  return JSON.stringify(normalize(input));
}
/** Exact authorization comparison, not an ABI decoder or proof of artifact provenance. */
export function validateSepoliaIntent(
  input: SepoliaIntentInput, expected: SepoliaIntentInput,
): SepoliaIntentEnvelope {
  const actual = normalize(input);
  if (canonicalIntentJson(actual) !== canonicalIntentJson(normalize(expected))) {return fail("expected intent mismatch");}
  return actual;
}
