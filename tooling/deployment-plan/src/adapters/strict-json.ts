import type { FeeQuote, StablePlan } from "../application/builder.ts";
import type { TrustRoots } from "../application/ports.ts";
import type { ReadyMarker } from "../application/verifier.ts";
import { fail, parseUint } from "../domain/model.ts";

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
  "schemaVersion", "planSha256", "quoteSha256", "planId", "creationInputHash",
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
  requireV2(ready, "READY_SCHEMA");
  exactKeys(ready, READY_KEYS, "READY_SCHEMA");
  constants(ready, { schemaVersion: 2 }, "READY_SCHEMA");
  hashes(ready, ["planSha256", "quoteSha256", "planId", "creationInputHash"]);
  return ready as unknown as ReadyMarker;
}

export function parseJsonWithoutDuplicates(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("JSON_INVALID", "JSON is not strict UTF-8");
  }
  return new Parser(text).parse();
}

class Parser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): unknown {
    const result = this.value();
    this.space();
    if (this.index !== this.source.length) {
      this.invalid();
    }
    return result;
  }

  private value(): unknown {
    this.space();
    const character = this.source[this.index];
    if (character === "{") {
      return this.object();
    }
    if (character === "[") {
      return this.array();
    }
    if (character === '"') {
      return this.string();
    }
    for (const [token, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (this.source.startsWith(token, this.index)) {
        this.index += token.length;
        return value;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.source.slice(this.index));
    if (number) {
      this.index += number[0].length;
      const parsed = Number(number[0]);
      if (!Number.isFinite(parsed)) {
        this.invalid();
      }
      return parsed;
    }
    return this.invalid();
  }

  private object(): Record<string, unknown> {
    this.index += 1;
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.space();
    if (this.take("}")) {
      return result;
    }
    while (true) {
      this.space();
      if (this.source[this.index] !== '"') {
        this.invalid();
      }
      const key = this.string();
      if (keys.has(key)) {
        fail("JSON_DUPLICATE_KEY", `duplicate JSON member: ${key}`);
      }
      keys.add(key);
      this.space();
      if (!this.take(":")) {
        this.invalid();
      }
      result[key] = this.value();
      this.space();
      if (this.take("}")) {
        return result;
      }
      if (!this.take(",")) {
        this.invalid();
      }
    }
  }

  private array(): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.space();
    if (this.take("]")) {
      return result;
    }
    while (true) {
      result.push(this.value());
      this.space();
      if (this.take("]")) {
        return result;
      }
      if (!this.take(",")) {
        this.invalid();
      }
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === '"') {
        try { return JSON.parse(this.source.slice(start, this.index)) as string; }
        catch { return this.invalid(); }
      }
      if (character === "\\") {
        this.index += 1;
      } else if (character.charCodeAt(0) < 0x20) {
        this.invalid();
      }
    }
    return this.invalid();
  }

  private space(): void {
    while (/\s/u.test(this.source[this.index] ?? "")) {
      this.index += 1;
    }
  }
  private take(character: string): boolean {
    if (this.source[this.index] !== character) {
      return false;
    }
    this.index += 1;
    return true;
  }
  private invalid(): never { fail("JSON_INVALID", `malformed JSON at byte ${this.index}`); }
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
