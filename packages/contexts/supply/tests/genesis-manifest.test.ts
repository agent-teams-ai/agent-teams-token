import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { compileLocalSource } from "../src/features/genesis-manifest/application/compiler.js";
import { parseLocalSource, parseProposal } from "../src/features/genesis-manifest/adapters/strict-source.js";
import { encodeAllocationCommitment } from "../src/features/genesis-manifest/adapters/abi.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";
import { canonicalJson, type JsonValue } from "../src/features/genesis-manifest/application/canonical.js";
import { compileLocalText } from "../src/features/genesis-manifest/composition/compile-local.js";
import { UINT64_MAX, UINT256_MAX, encodeAllocationId, normalizeLocalSource, parseCanonicalUint, type LocalGenesisSource } from "../src/features/genesis-manifest/domain/model.js";

const packageRoot = process.cwd().endsWith("/packages/contexts/supply") ? process.cwd() : resolvePath(process.cwd(), "packages/contexts/supply");
const repositoryRoot = resolvePath(packageRoot, "../../..");
const fixturePath = join(repositoryRoot, "config/genesis/local.fixture.yaml");
const goldenPath = join(packageRoot, "tests/fixtures/local.golden.json");
const base: LocalGenesisSource = {
  schemaVersion: 1, purpose: "local-fixture", status: "test-only", network: { kind: "local-evm", chainId: "31337" },
  token: { name: "Agent Teams AI", symbol: "AGTMAI", decimals: 9, initialSupplyBaseUnits: "1000000000000" },
  allocations: [
    { id: "test-alpha", recipient: "0x0000000000000000000000000000000000001001", amountBaseUnits: "400000000000", bps: 4000 },
    { id: "test-beta", recipient: "0x0000000000000000000000000000000000001002", amountBaseUnits: "350000000000", bps: 3500 },
    { id: "test-gamma", recipient: "0x0000000000000000000000000000000000001003", amountBaseUnits: "250000000000", bps: 2500 },
  ],
};

test("committed source, normalization, raw ABI and allocation hash match the golden vector", async () => {
  const parsed = parseLocalSource(await readFile(fixturePath, "utf8")); assert.deepEqual(parsed.diagnostics, []); assert.ok(parsed.value && parsed.canonicalBytes);
  const compiled = compileLocalSource(parsed.value, { encodeAllocationCommitment, sha256 }); assert.ok(compiled.manifest);
  const golden = JSON.parse(await readFile(goldenPath, "utf8"));
  assert.deepEqual(compiled.manifest.allocations, golden.normalizedAllocations);
  assert.equal(compiled.manifest.rawAllocationAbi, golden.rawAllocationAbi); assert.equal(compiled.manifest.genesisAllocationHash, golden.genesisAllocationHash);
  assert.equal(Buffer.from(compiled.canonicalBytes!).at(-1), 0x7d); // no newline/BOM
});

test("normalization is deterministic and idempotent across input permutations", () => {
  const reversed = { ...base, allocations: base.allocations.toReversed() };
  const first = normalizeLocalSource(reversed), second = normalizeLocalSource({ ...reversed, allocations: first.allocations! });
  assert.deepEqual(first.diagnostics, []); assert.deepEqual(second.allocations, first.allocations);
});

test("direct normalization rejects allocation arrays outside 1 through 32", () => {
  const empty = { ...base, allocations: [] } as LocalGenesisSource;
  const tooMany = { ...base, allocations: Array.from({ length: 33 }, (_, index) => ({
    id: `a${index}`, recipient: `0x${(0x1001 + index).toString(16).padStart(40, "0")}`, amountBaseUnits: "1",
  })) } as LocalGenesisSource;
  for (const source of [empty, tooMany]) {
    assert.ok(normalizeLocalSource(source).diagnostics.some((item) => item.code === "GENESIS_ALLOCATION_COUNT_INVALID"));
  }
});

test("direct normalization fails closed for a non-array runtime allocation value", () => {
  const malformed = { ...base, allocations: null } as unknown as LocalGenesisSource;
  assert.doesNotThrow(() => normalizeLocalSource(malformed));
  assert.ok(normalizeLocalSource(malformed).diagnostics.some((item) => item.code === "GENESIS_ALLOCATION_COUNT_INVALID"));
});

test("compiler derives the source digest from the runtime source internally", () => {
  const compiled = compileLocalSource(base, { encodeAllocationCommitment, sha256 });
  const expected = sha256(new TextEncoder().encode(canonicalJson(base as unknown as JsonValue)));
  assert.equal(compiled.manifest?.sourceSha256, expected);
  assert.equal(compileLocalSource.length, 2);
});

test("internal local compilation strictly parses before invoking the typed compiler", () => {
  let encodeCalls = 0, digestCalls = 0;
  const ports = {
    encodeAllocationCommitment: (...arguments_: Parameters<typeof encodeAllocationCommitment>) => {encodeCalls += 1; return encodeAllocationCommitment(...arguments_);},
    sha256: (bytes: Uint8Array) => {digestCalls += 1; return sha256(bytes);},
  };
  const source = toYaml(base);
  for (const text of [
    `${source}unknownRoot: forbidden\n`,
    source.replace("    amountBaseUnits: \"400000000000\"", "    amountBaseUnits: \"400000000000\"\n    unknownAllocation: forbidden"),
  ]) {
    const result = compileLocalText(text, ports);
    assert.equal(result.manifest, undefined);
    assert.ok(result.diagnostics.some((item) => item.code === "GENESIS_SCHEMA_UNKNOWN_FIELD"));
    assert.equal(encodeCalls, 0);
    assert.equal(digestCalls, 0);
  }
  assert.ok(compileLocalText(source, ports).manifest);
  assert.equal(encodeCalls, 1);
  assert.ok(digestCalls > 0);
});

test("canonical decimals retain 2^53 and uint256 boundaries without Number", () => {
  for (const value of ["9007199254740991", "9007199254740992", "9007199254740993", UINT256_MAX.toString()]) {assert.equal(parseCanonicalUint(value)?.toString(), value);}
  for (const value of ["", "00", "01", "+1", "-1", "1.0", "1e3", (UINT256_MAX + 1n).toString()]) {assert.equal(parseCanonicalUint(value), undefined);}
});

test("uint64 profile boundaries and allocation sums plus or minus one fail closed", () => {
  assert.equal(parseCanonicalUint(UINT64_MAX.toString(), UINT64_MAX), UINT64_MAX);
  assert.equal(parseCanonicalUint((UINT64_MAX + 1n).toString(), UINT64_MAX), undefined);
  const overflow = { ...base, token: { ...base.token, initialSupplyBaseUnits: (UINT64_MAX + 1n).toString() }, allocations: [{ ...base.allocations[0]!, amountBaseUnits: (UINT64_MAX + 1n).toString(), bps: 10_000 }] } as LocalGenesisSource;
  assert.ok(normalizeLocalSource(overflow).diagnostics.some((item) => item.code === "GENESIS_SPL_SUPPLY_OVERFLOW"));
  for (const delta of [-1n, 1n]) {
    const changed = structuredClone(base); (changed.allocations as unknown as Array<{ amountBaseUnits: string }>)[0]!.amountBaseUnits = (400_000_000_000n + delta).toString();
    assert.ok(normalizeLocalSource(changed).diagnostics.some((item) => item.code === "GENESIS_ALLOCATION_SUM_MISMATCH"));
  }
});

test("optional bps must sum exactly and verify authoritative base-unit amounts exactly", () => {
  const changed = structuredClone(base); (changed.allocations as unknown as Array<{ bps: number }>)[0]!.bps = 3999;
  const codes = normalizeLocalSource(changed).diagnostics.map((item) => item.code);
  assert.ok(codes.includes("GENESIS_BPS_AMOUNT_MISMATCH")); assert.ok(codes.includes("GENESIS_BPS_SUM_MISMATCH"));
});

test("allocation IDs enforce ASCII, NUL, casing, grammar and bytes32 length", () => {
  assert.equal(encodeAllocationId("test-alpha"), "0x746573742d616c70686100000000000000000000000000000000000000000000");
  for (const id of ["", "A", "-a", "a-", "é", "a\0b", "a".repeat(32)]) {assert.equal(encodeAllocationId(id), undefined);}
});

test("semantic failures are aggregated and deterministically ordered", () => {
  const broken = { ...base, token: { ...base.token, initialSupplyBaseUnits: "1000000000001" }, allocations: [
    { ...base.allocations[0]!, recipient: "0x0000000000000000000000000000000000000000" },
    { ...base.allocations[1]!, id: "test-alpha", recipient: "0x0000000000000000000000000000000000001001" },
    { ...base.allocations[2]!, recipient: "0x0000000000000000000000000000000000001001" },
  ] } as LocalGenesisSource;
  const one = normalizeLocalSource(broken).diagnostics, two = normalizeLocalSource(broken).diagnostics;
  assert.deepEqual(one, two); assert.deepEqual(one.map((item) => item.code), ["GENESIS_ALLOCATION_SUM_MISMATCH", "GENESIS_BPS_AMOUNT_MISMATCH", "GENESIS_RECIPIENT_ZERO", "GENESIS_BPS_AMOUNT_MISMATCH", "GENESIS_ID_DUPLICATE", "GENESIS_BPS_AMOUNT_MISMATCH", "GENESIS_RECIPIENT_DUPLICATE"]);
});

test("source-derived schema and semantic diagnostics retain deterministic spans", () => {
  const text = toYaml(base).replace(
    "0x0000000000000000000000000000000000001001",
    "0x0000000000000000000000000000000000002001",
  ).replace("symbol: AGTMAI", "symbol: AGTMAI\n  unexpected: true");
  const first = parseLocalSource(text).diagnostics;
  const second = parseLocalSource(text).diagnostics;
  assert.deepEqual(first, second);
  assert.ok(first.some((item) => item.code === "GENESIS_SCHEMA_UNKNOWN_FIELD"));
  assert.ok(first.some((item) => item.code === "GENESIS_RECIPIENT_NOT_ALLOWLISTED"));
  assert.ok(first.every((item) => item.position && item.position.line > 0 && item.position.column > 0));
});

test("wrong-case and non-allowlisted local recipients fail", () => {
  const upper = structuredClone(base); (upper.allocations as unknown as Array<{recipient:string}>)[0]!.recipient = "0x000000000000000000000000000000000000A001";
  assert.ok(normalizeLocalSource(upper).diagnostics.some((item) => item.code === "GENESIS_RECIPIENT_INVALID"));
  const external = structuredClone(base); (external.allocations as unknown as Array<{recipient:string}>)[0]!.recipient = "0x0000000000000000000000000000000000002001";
  assert.ok(normalizeLocalSource(external).diagnostics.some((item) => item.code === "GENESIS_RECIPIENT_NOT_ALLOWLISTED"));
});

test("strict YAML rejects duplicate, alias, merge, tag, multi-doc, float, scientific and unknown fields", () => {
  const samples = ["a: 1\na: 2\n", "a: &x 1\nb: *x\n", "a: &x { b: 1 }\nc: { <<: *x }\n", "a: !thing x\n", "a: 1\n---\nb: 2\n", "a: 1.5\n", "a: 1e3\n", "a: 0x10\n", "a: 01\n"];
  for (const sample of samples) {assert.notEqual(parseLocalSource(sample).diagnostics.length, 0);}
  const unknown = `${toYaml(base)}unknown: true\n`; assert.ok(parseLocalSource(unknown).diagnostics.some((item) => item.code === "GENESIS_SCHEMA_UNKNOWN_FIELD"));
});

test("strict YAML rejects explicit standard tags before value conversion", () => {
  const source = toYaml(base);
  for (const tagged of [
    source.replace("purpose: local-fixture", "purpose: !!str local-fixture"),
    source.replace("schemaVersion: 1", "schemaVersion: !!int 1"),
  ]) {
    assert.ok(parseLocalSource(tagged).diagnostics.some((item) => item.code === "GENESIS_SOURCE_TAG_FORBIDDEN"));
  }
});

test("JSON duplicate members are rejected before last-wins object conversion", () => {
  const parsed = parseLocalSource('{"schemaVersion":1,"schemaVersion":1}');
  assert.ok(parsed.diagnostics.some((item) => item.code === "GENESIS_SOURCE_SYNTAX"));
});

test("empty and whitespace-only sources return a stable diagnostic", () => {
  for (const source of ["", " \t\r\n"]) {
    const first = parseLocalSource(source).diagnostics;
    assert.deepEqual(first, parseLocalSource(source).diagnostics);
    assert.deepEqual(first.map((item) => item.code), ["GENESIS_SOURCE_EMPTY"]);
  }
});

test("proposal is validation-only with exact bps and cannot parse as a local source", async () => {
  const text = await readFile(join(repositoryRoot, "config/tokenomics.proposal.yaml"), "utf8");
  assert.deepEqual(parseProposal(text).diagnostics, []);
  assert.ok(parseProposal(text.replace("allocationBps: 4500", "allocationBps: 4499")).diagnostics.some((item) => item.code === "GENESIS_PROPOSAL_BPS_SUM_MISMATCH"));
  assert.notEqual(parseLocalSource(text).diagnostics.length, 0);
});

test("declared YAML integers reject unsafe Number boundaries without returning a rounded proposal", async () => {
  const text = await readFile(join(repositoryRoot, "config/tokenomics.proposal.yaml"), "utf8");
  const pointer = "/allocations/communityDistributions/initialProgramMaximumWaves";
  const withInteger = (value: string): string => text.replace("initialProgramMaximumWaves: 6", `initialProgramMaximumWaves: ${value}`);
  const maximumSafe = parseProposal(withInteger("9007199254740991"));
  assert.ok(maximumSafe.value);
  assert.equal(maximumSafe.diagnostics.some((item) => item.code === "GENESIS_SCHEMA_TYPE" && item.pointer === pointer), false);
  for (const value of ["9007199254740992", "9007199254740993"]) {
    const parsed = parseProposal(withInteger(value));
    assert.equal(parsed.value, undefined);
    assert.ok(parsed.diagnostics.some((item) => item.code === "GENESIS_SCHEMA_TYPE" && item.pointer === pointer));
  }
});

test("proposal rejects nested unknown, missing, and wrong-type fields at every object level", async () => {
  const text = await readFile(join(repositoryRoot, "config/tokenomics.proposal.yaml"), "utf8");
  const nestedUnknown = text.replace("  workingName: Agent Teams AI", "  workingName: Agent Teams AI\n  unknownTokenField: forbidden");
  const deeplyUnknown = text.replace("    allocationBps: 4500", "    allocationBps: 4500\n    unknownAllocationField: forbidden");
  const missing = text.replace("  bridgeAdminSafeThreshold: 3\n", "");
  const wrongType = text.replace("  controlledWalletsPublished: true", "  controlledWalletsPublished: not-a-boolean");
  for (const sample of [nestedUnknown, deeplyUnknown]) {
    assert.ok(parseProposal(sample).diagnostics.some((item) => item.code === "GENESIS_SCHEMA_UNKNOWN_FIELD"));
  }
  assert.ok(parseProposal(missing).diagnostics.some((item) => item.code === "GENESIS_SCHEMA_REQUIRED" && item.pointer === "/governance/bridgeAdminSafeThreshold"));
  assert.ok(parseProposal(wrongType).diagnostics.some((item) => item.code === "GENESIS_SCHEMA_TYPE" && item.pointer === "/transparency/controlledWalletsPublished"));
});

test("all three committed schemas are strict and conform to accepted runtime values", async () => {
  const proposalText = await readFile(join(repositoryRoot, "config/tokenomics.proposal.yaml"), "utf8");
  const localText = await readFile(fixturePath, "utf8");
  const proposal = parseProposal(proposalText).value;
  const local = parseLocalSource(localText);
  assert.ok(proposal && local.value && local.canonicalBytes);
  const compiled = compileLocalSource(local.value, { encodeAllocationCommitment, sha256 });
  assert.ok(compiled.manifest);
  const fixtures = [["proposal", proposal], ["local-source", local.value], ["local-manifest", compiled.manifest]] as const;
  for (const [name, value] of fixtures) {
    const schema = JSON.parse(await readFile(join(repositoryRoot, `config/genesis/${name}.schema.json`), "utf8"));
    assert.deepEqual(validateSchema(schema, value), [], name);
    assert.deepEqual(findOpenObjectShapes(schema), [], `${name} must close every declared object shape`);

    const negative = structuredClone(value) as Record<string, unknown>;
    if (name === "proposal") {(negative.token as Record<string, unknown>).unexpected = true;}
    if (name === "local-source") {(negative.network as Record<string, unknown>).unexpected = true;}
    if (name === "local-manifest") {(negative.tool as Record<string, unknown>).unexpected = true;}
    assert.ok(validateSchema(schema, negative).some((item) => item.endsWith("/unexpected:unknown")), `${name} nested unknown fixture`);
  }
});

test("CLI distinguishes validation and I/O exits and exposes no production command", async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(Object.keys(packageJson.scripts).some((name) => name.includes("production")), false);
  const cli = pathToFileURL(join(packageRoot, ".local/tests/src/features/genesis-manifest/composition/cli.js"));
  assert.equal((await runCli(cli, ["compile-local", join(repositoryRoot, "config/tokenomics.proposal.yaml"), join(repositoryRoot, ".local/proposal-must-not-compile")])).code, 2);
  assert.equal((await runCli(cli, ["validate-proposal", ".local/does-not-exist.yaml"])).code, 3);
  assert.equal((await runCli(cli, ["compile-production"])).code, 2);
});

function toYaml(source: LocalGenesisSource): string {
  return `schemaVersion: 1\npurpose: local-fixture\nstatus: test-only\nnetwork:\n  kind: local-evm\n  chainId: "31337"\ntoken:\n  name: Agent Teams AI\n  symbol: AGTMAI\n  decimals: 9\n  initialSupplyBaseUnits: "1000000000000"\nallocations:\n${source.allocations.map((a) => `  - id: ${a.id}\n    recipient: "${a.recipient}"\n    amountBaseUnits: "${a.amountBaseUnits}"\n`).join("")}`;
}

async function runCli(cli: URL, arguments_: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => { const child = spawn(process.execPath, [cli.pathname, ...arguments_], { cwd: process.cwd() }); let stdout = "", stderr = ""; child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; }); child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; }); child.on("error", reject); child.on("close", (code) => { resolve({ code, stdout, stderr }); }); });
}

function validateSchema(schemaRoot: Record<string, unknown>, value: unknown): string[] {
  const errors: string[] = [];
  validateSchemaNode(schemaRoot, schemaRoot, value, "", errors);
  return errors.toSorted();
}

function validateSchemaNode(schemaRoot: Record<string, unknown>, rawSchema: unknown, candidate: unknown, pointer: string, errors: string[]): void {
  const schema = resolveSchema(schemaRoot, rawSchema);
  if ("const" in schema && candidate !== schema.const) {errors.push(`${pointer}:const`);}
  if (schema.type === "object") {
    validateObjectSchema(schemaRoot, schema, candidate, pointer, errors);
  } else if (schema.type === "array") {
    validateArraySchema(schemaRoot, schema, candidate, pointer, errors);
  } else {
    validateScalarSchema(schema, candidate, pointer, errors);
  }
  validateSchemaConstraints(schema, candidate, pointer, errors);
}

function resolveSchema(schemaRoot: Record<string, unknown>, rawSchema: unknown): Record<string, unknown> {
  const schema = rawSchema as Record<string, unknown>;
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/$defs/")) {return schema;}
  return (schemaRoot.$defs as Record<string, Record<string, unknown>>)[schema.$ref.slice(8)]!;
}

function validateObjectSchema(schemaRoot: Record<string, unknown>, schema: Record<string, unknown>, candidate: unknown, pointer: string, errors: string[]): void {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    errors.push(`${pointer}:object`);
    return;
  }
  const object = candidate as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown>;
  for (const required of (schema.required as string[] ?? [])) {
    if (!(required in object)) {errors.push(`${pointer}/${required}:required`);}
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(object)) {
      if (!(key in properties)) {errors.push(`${pointer}/${key}:unknown`);}
    }
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (key in object) {validateSchemaNode(schemaRoot, childSchema, object[key], `${pointer}/${key}`, errors);}
  }
}

function validateArraySchema(schemaRoot: Record<string, unknown>, schema: Record<string, unknown>, candidate: unknown, pointer: string, errors: string[]): void {
  if (!Array.isArray(candidate)) {
    errors.push(`${pointer}:array`);
    return;
  }
  if (typeof schema.minItems === "number" && candidate.length < schema.minItems) {errors.push(`${pointer}:minItems`);}
  if (typeof schema.maxItems === "number" && candidate.length > schema.maxItems) {errors.push(`${pointer}:maxItems`);}
  candidate.forEach((item, index) => validateSchemaNode(schemaRoot, schema.items, item, `${pointer}/${index}`, errors));
}

function validateScalarSchema(schema: Record<string, unknown>, candidate: unknown, pointer: string, errors: string[]): void {
  if (schema.type === "integer" && !Number.isInteger(candidate)) {errors.push(`${pointer}:integer`);}
  else if (schema.type === "string" && typeof candidate !== "string") {errors.push(`${pointer}:string`);}
  else if (schema.type === "boolean" && typeof candidate !== "boolean") {errors.push(`${pointer}:boolean`);}
}

function validateSchemaConstraints(schema: Record<string, unknown>, candidate: unknown, pointer: string, errors: string[]): void {
  if (typeof schema.pattern === "string" && (typeof candidate !== "string" || !new RegExp(schema.pattern).test(candidate))) {errors.push(`${pointer}:pattern`);}
  if (typeof schema.minimum === "number" && typeof candidate === "number" && candidate < schema.minimum) {errors.push(`${pointer}:minimum`);}
  if (typeof schema.maximum === "number" && typeof candidate === "number" && candidate > schema.maximum) {errors.push(`${pointer}:maximum`);}
}

function findOpenObjectShapes(schemaRoot: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown, pointer: string): void => {
    if (!value || typeof value !== "object" || seen.has(value)) {return;}
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${pointer}/${index}`));
      return;
    }
    const schema = value as Record<string, unknown>;
    if (schema.type === "object" && schema.additionalProperties !== false) {errors.push(pointer || "/");}
    for (const [key, child] of Object.entries(schema)) {walk(child, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);}
  };
  walk(schemaRoot, "");
  return errors.toSorted();
}
