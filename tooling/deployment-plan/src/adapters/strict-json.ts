import type { FeeQuote, StablePlan } from "../application/builder.ts";
import type {
  NativeNoReplaceEvidence,
  RawArtifactJsonInput,
  TrustRoots,
} from "../application/ports.ts";
import type { ReadyMarker } from "../application/verifier.ts";
import { fail, parseUint } from "../domain/model.ts";
import {
  FORGE_ARTIFACT_JSON_LIMITS,
  FORGE_BUILD_INFO_JSON_LIMITS,
  POLICY_JSON_LIMITS,
  parseBoundedJson,
} from "./bounded-json.ts";

const HASH = /^0x[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const HEX = /^0x(?:[0-9a-f]{2})*$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;

const ROOT_KEYS = [
  "schemaVersion", "testOnly", "productionApproved", "mainnetAllowed",
  "chainId", "contractFqn", "buildProfile", "from", "maximumWorstCaseWei",
  "gasBufferBps", "quoteTtlSeconds", "maximumHeadLag", "buildInfoSolcVersion",
  "canonicalBuildInfoSha256", "compilerInputSha256",
  "compilerSettings", "artifactSha256", "abiSha256", "fixtureSha256",
  "fixtureReadySha256", "constructorArgumentsHash", "creationInputHash",
  "sourceDependencyClosure",
] as const;
const PLAN_KEYS = [
  "schemaVersion", "kind", "planId", "identity", "broadcastAllowed",
  "testOnly", "productionApproved", "mainnetAllowed",
] as const;
const IDENTITY_KEYS = [
  "contractFqn", "buildProfile", "sourceDependencyClosure", "rawBuildInfoSha256",
  "canonicalBuildInfoSha256", "compilerInputSha256",
  "artifactSha256", "abiSha256", "fixtureSha256", "fixtureReadySha256",
  "buildInfoSolcVersion", "compilerSettings", "creationBytecodeHash",
  "constructorAbiBytes", "constructorAbiHash", "constructorArguments",
  "constructorArgumentsHash", "creationInput", "creationInputHash", "chainId", "from",
  "value", "capPolicy", "broadcastAllowed",
] as const;
const QUOTE_KEYS = [
  "schemaVersion", "kind", "planId", "creationInputHash", "observation",
  "bufferBps", "gasLimit", "effectiveFeePerGas", "estimatedWei", "worstCaseWei",
  "expiresAt",
] as const;
const OBSERVATION_KEYS = [
  "chainId", "blockNumber", "blockHash", "blockTimestamp", "currentHeadNumber",
  "currentHeadHash", "feeHistoryNewestBlock", "senderNonce", "expectedCreateAddress", "gasEstimate", "blockGasLimit",
  "baseFeePerGas", "maxPriorityFeePerGas", "maxFeePerGas", "observedAt",
] as const;
const READY_KEYS = [
  "schemaVersion", "planSha256", "quoteSha256", "nativeNoReplaceEvidenceSha256", "planId", "creationInputHash",
] as const;
const NATIVE_EVIDENCE_KEYS = [
  "schemaVersion", "kind", "platform", "sourcePath", "sourceSha256",
  "compileProfile", "compilerExecution", "compilerPath", "compilerSha256",
  "executableSha256", "approvalSha256",
] as const;

export function parseTrustRoots(bytes: Uint8Array): TrustRoots {
  const root = object(parseJsonWithoutDuplicates(bytes), "TRUST_ROOTS_SCHEMA");
  requireV2(root, "TRUST_ROOTS_SCHEMA");
  const rootKeys = ROOT_KEYS;
  exactKeys(root, rootKeys, "TRUST_ROOTS_SCHEMA");
  constants(root, {
    schemaVersion: 2, testOnly: true, productionApproved: false,
    mainnetAllowed: false, chainId: "31337",
  }, "TRUST_ROOTS_SCHEMA");
  strings(root, ["contractFqn", "buildProfile", "buildInfoSolcVersion"]);
  match(root.from, ADDRESS, "TRUST_ROOTS_SCHEMA", "from");
  decimals(root, ["maximumWorstCaseWei", "gasBufferBps", "quoteTtlSeconds", "maximumHeadLag"]);
  hashes(root, ["canonicalBuildInfoSha256", "compilerInputSha256", "artifactSha256", "abiSha256", "fixtureSha256", "fixtureReadySha256", "constructorArgumentsHash", "creationInputHash"]);
  object(root.compilerSettings, "TRUST_ROOTS_SCHEMA");
  hashMap(root.sourceDependencyClosure, "TRUST_ROOTS_SCHEMA");
  return root as unknown as TrustRoots;
}

export function parseStablePlan(bytes: Uint8Array): StablePlan {
  const plan = object(parseJsonWithoutDuplicates(bytes), "PLAN_SCHEMA");
  requireV2(plan, "PLAN_SCHEMA");
  exactKeys(plan, PLAN_KEYS, "PLAN_SCHEMA");
  constants(plan, {
    schemaVersion: 2, kind: "deployment-plan", broadcastAllowed: false,
    testOnly: true, productionApproved: false, mainnetAllowed: false,
  }, "PLAN_SCHEMA");
  match(plan.planId, HASH, "PLAN_SCHEMA", "planId");
  const identity = object(plan.identity, "PLAN_IDENTITY_SCHEMA");
  exactKeys(identity, IDENTITY_KEYS, "PLAN_IDENTITY_SCHEMA");
  strings(identity, ["contractFqn", "buildProfile", "buildInfoSolcVersion", "chainId", "value"]);
  hashes(identity, ["rawBuildInfoSha256", "canonicalBuildInfoSha256", "compilerInputSha256", "artifactSha256", "abiSha256", "fixtureSha256", "fixtureReadySha256", "creationBytecodeHash", "constructorAbiHash", "constructorArgumentsHash", "creationInputHash"]);
  match(identity.constructorAbiBytes, HEX, "PLAN_IDENTITY_SCHEMA", "constructorAbiBytes");
  match(identity.constructorArguments, HEX, "PLAN_IDENTITY_SCHEMA", "constructorArguments");
  match(identity.creationInput, HEX, "PLAN_IDENTITY_SCHEMA", "creationInput");
  match(identity.from, ADDRESS, "PLAN_IDENTITY_SCHEMA", "from");
  if (identity.broadcastAllowed !== false) {
    fail("PLAN_IDENTITY_SCHEMA", "identity broadcastAllowed must be false");
  }
  object(identity.compilerSettings, "PLAN_IDENTITY_SCHEMA");
  hashMap(identity.sourceDependencyClosure, "PLAN_IDENTITY_SCHEMA");
  const cap = object(identity.capPolicy, "PLAN_CAP_SCHEMA");
  exactKeys(cap, ["maximumWorstCaseWei", "testOnly"], "PLAN_CAP_SCHEMA");
  decimal(cap.maximumWorstCaseWei, "PLAN_CAP_SCHEMA", "maximumWorstCaseWei");
  if (cap.testOnly !== true) {
    fail("PLAN_CAP_SCHEMA", "cap testOnly must be true");
  }
  return plan as unknown as StablePlan;
}

export function parseFeeQuote(bytes: Uint8Array): FeeQuote {
  const quote = object(parseJsonWithoutDuplicates(bytes), "QUOTE_SCHEMA");
  requireV2(quote, "QUOTE_SCHEMA");
  exactKeys(quote, QUOTE_KEYS, "QUOTE_SCHEMA");
  constants(quote, { schemaVersion: 2, kind: "fee-quote" }, "QUOTE_SCHEMA");
  hashes(quote, ["planId", "creationInputHash"]);
  decimals(quote, ["bufferBps", "gasLimit", "effectiveFeePerGas", "estimatedWei", "worstCaseWei", "expiresAt"]);
  const observation = object(quote.observation, "QUOTE_OBSERVATION_SCHEMA");
  exactKeys(observation, OBSERVATION_KEYS, "QUOTE_OBSERVATION_SCHEMA");
  decimals(observation, ["chainId", "blockNumber", "blockTimestamp", "currentHeadNumber", "feeHistoryNewestBlock", "senderNonce", "gasEstimate", "blockGasLimit", "baseFeePerGas", "maxPriorityFeePerGas", "maxFeePerGas", "observedAt"]);
  hashes(observation, ["blockHash", "currentHeadHash"]);
  match(observation.expectedCreateAddress, ADDRESS, "QUOTE_OBSERVATION_SCHEMA", "expectedCreateAddress");
  return quote as unknown as FeeQuote;
}

export function parseReadyMarker(bytes: Uint8Array): ReadyMarker {
  const ready = object(parseJsonWithoutDuplicates(bytes), "READY_SCHEMA");
  if (ready.schemaVersion !== 3) {
    fail("READY_LEGACY_UNSUPPORTED", "READY must be regenerated as V3");
  }
  exactKeys(ready, READY_KEYS, "READY_SCHEMA");
  hashes(ready, ["planSha256", "quoteSha256", "nativeNoReplaceEvidenceSha256", "planId", "creationInputHash"]);
  return ready as unknown as ReadyMarker;
}

export function parseNativeNoReplaceEvidence(bytes: Uint8Array): NativeNoReplaceEvidence {
  const evidence = object(parseJsonWithoutDuplicates(bytes), "NATIVE_EVIDENCE_SCHEMA");
  exactKeys(evidence, NATIVE_EVIDENCE_KEYS, "NATIVE_EVIDENCE_SCHEMA");
  constants(evidence, { schemaVersion: 1, kind: "native-no-replace-evidence" }, "NATIVE_EVIDENCE_SCHEMA");
  if (evidence.platform !== "darwin-arm64" && evidence.platform !== "linux-x64") {
    fail("NATIVE_EVIDENCE_SCHEMA", "platform is invalid");
  }
  if (evidence.sourcePath !== "tooling/deployment-plan/native/no-replace.c" || evidence.compileProfile !== "c11-o2-werror-stdin-v1") {
    fail("NATIVE_EVIDENCE_SCHEMA", "source or compile profile is invalid");
  }
  if (evidence.compilerExecution !== "snapshot-fd" && evidence.compilerExecution !== "verified-path") {
    fail("NATIVE_EVIDENCE_SCHEMA", "compiler execution is invalid");
  }
  const compilerPath = evidence.platform === "darwin-arm64"
    ? "/usr/bin/cc" : "/usr/bin/x86_64-linux-gnu-gcc-13";
  if (evidence.compilerPath !== compilerPath) {
    fail("NATIVE_EVIDENCE_SCHEMA", "compiler path is invalid");
  }
  hashes(evidence, ["sourceSha256", "compilerSha256", "executableSha256", "approvalSha256"]);
  return evidence as unknown as NativeNoReplaceEvidence;
}

export function parseJsonWithoutDuplicates(bytes: Uint8Array): unknown {
  return parseBoundedJson(bytes, POLICY_JSON_LIMITS);
}

export function parseRawArtifactJson(
  bytes: Uint8Array,
  input: RawArtifactJsonInput,
): unknown {
  if (input === "build-info") {
    return parseBoundedJson(bytes, FORGE_BUILD_INFO_JSON_LIMITS);
  }
  if (input === "artifact" || input === "abi") {
    return parseBoundedJson(bytes, FORGE_ARTIFACT_JSON_LIMITS);
  }
  return parseBoundedJson(bytes, POLICY_JSON_LIMITS);
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, "expected object");
  }
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, "object has missing or unknown members");
  }
}
function requireV2(value: Record<string, unknown>, code: string): void {
  if (value.schemaVersion === 1) {
    fail("V1_UNSUPPORTED", `${code} V1 uses legacy numeric semantics; regenerate as V2`);
  }
}
function constants(value: Record<string, unknown>, expected: Record<string, unknown>, code: string): void {
  for (const [key, wanted] of Object.entries(expected)) {
    if (value[key] !== wanted) {
      fail(code, `${key} is invalid`);
    }
  }
}
function strings(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      fail("SCHEMA_INVALID", `${key} must be a nonempty string`);
    }
  }
}
function match(value: unknown, pattern: RegExp, code: string, field: string): void {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(code, `${field} is malformed`);
  }
}
function hashes(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    match(value[key], HASH, "SCHEMA_INVALID", key);
  }
}
function decimals(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    decimal(value[key], "SCHEMA_INVALID", key);
  }
}
function decimal(value: unknown, code: string, field: string): void {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    fail(code, `${field} is malformed`);
  }
  parseUint(value, field);
}
function hashMap(value: unknown, code: string): void {
  const map = object(value, code);
  for (const [key, digest] of Object.entries(map)) {
    if (key.length === 0) {
      fail(code, "empty source path");
    }
    match(digest, HASH, code, key);
  }
}
