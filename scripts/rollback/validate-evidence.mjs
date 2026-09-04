#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const schemaPath = join(repositoryRoot, "architecture/rollback/recovery-evidence.schema.json");
const expectedSlices = ["local-solana", "deployment-plan", "slither"];
const expectedBaselineSha = "b7a868f85d89c4bb7a9aeed1d854a5f949306a45";
const commonGateIds = [
  "doctor-core",
  "foundation-assert-dev-only",
  "foundation-assert-registry",
  "foundation-check",
  "lint",
  "typecheck",
  "build",
  "package-tests",
  "linux-parity",
  "genesis-vector",
  "security-check",
  "local-evm-unit",
  "local-evm-integration",
  "genesis-local-verifier",
  "forge-format",
  "forge-build",
  "forge-unit-fuzz",
  "forge-invariants",
  "forge-gas-size",
];
const survivorGateIds = {
  "local-solana": [
    "solana-offline-toolchain-verify",
    "solana-unit-and-strict-real",
    "solana-real-fixture",
  ],
  "deployment-plan": ["deployment-unit-suite", "deployment-strict-anvil"],
  slither: ["slither-unit", "slither-real-analyzer", "slither-evidence-validate"],
};
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {throw new Error("RECOVERY_EVIDENCE_CANONICAL_NUMBER_UNSAFE");}
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value).toSorted().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("RECOVERY_EVIDENCE_CANONICAL_VALUE_UNSUPPORTED");
}

function parseJson(bytes, label) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`RECOVERY_EVIDENCE_UTF8_INVALID file=${label}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`RECOVERY_EVIDENCE_JSON_INVALID file=${label}`, { cause: error });
  }
}

function readStableFile(path, label) {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`RECOVERY_EVIDENCE_FILE_UNSAFE file=${label}`);
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
    || before.uid !== after.uid || before.gid !== after.gid || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error(`RECOVERY_EVIDENCE_FILE_CHANGED file=${label}`);
  }
  return bytes;
}

function safeBundlePath(bundle, path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)
    || path.includes("\\") || path.includes("\0")
    || path.split("/").some((component) => component === "" || component === "." || component === "..")) {
    throw new Error(`RECOVERY_EVIDENCE_PATH_UNSAFE path=${String(path)}`);
  }
  const resolved = resolve(bundle, path);
  const inside = relative(bundle, resolved);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`)) {
    throw new Error(`RECOVERY_EVIDENCE_PATH_ESCAPE path=${path}`);
  }
  return resolved;
}

function resolveReference(rootSchema, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/$defs/")) {
    throw new Error(`RECOVERY_EVIDENCE_SCHEMA_REF_UNSUPPORTED ref=${String(reference)}`);
  }
  const name = reference.slice("#/$defs/".length);
  const resolved = rootSchema.$defs?.[name];
  if (resolved === undefined) {
    throw new Error(`RECOVERY_EVIDENCE_SCHEMA_REF_MISSING ref=${reference}`);
  }
  return resolved;
}

function schemaTypeMatches(value, type) {
  if (type === "object") {return value !== null && typeof value === "object" && !Array.isArray(value);}
  if (type === "array") {return Array.isArray(value);}
  if (type === "integer") {return Number.isSafeInteger(value);}
  return typeof value === type;
}

function validateSchema(value, schema, rootSchema, location = "$") {
  if (schema.$ref !== undefined) {
    validateSchema(value, resolveReference(rootSchema, schema.$ref), rootSchema, location);
    return;
  }
  validateSchemaScalar(value, schema, location);
  if (Array.isArray(value)) {
    validateSchemaArray(value, schema, rootSchema, location);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    validateSchemaObject(value, schema, rootSchema, location);
  }
}

function validateSchemaScalar(value, schema, location) {
  if (schema.const !== undefined && canonicalJson(value) !== canonicalJson(schema.const)) {
    throw new Error(`RECOVERY_EVIDENCE_SCHEMA_CONST location=${location}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((entry) => canonicalJson(entry) === canonicalJson(value))) {
    throw new Error(`RECOVERY_EVIDENCE_SCHEMA_ENUM location=${location}`);
  }
  if (schema.type !== undefined && !schemaTypeMatches(value, schema.type)) {
    throw new Error(`RECOVERY_EVIDENCE_SCHEMA_TYPE location=${location} expected=${schema.type}`);
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
    throw new Error(`RECOVERY_EVIDENCE_SCHEMA_PATTERN location=${location}`);
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    throw new Error(`RECOVERY_EVIDENCE_SCHEMA_MINIMUM location=${location}`);
  }
}

function validateSchemaArray(value, schema, rootSchema, location) {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new Error(`RECOVERY_EVIDENCE_SCHEMA_MIN_ITEMS location=${location}`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw new Error(`RECOVERY_EVIDENCE_SCHEMA_MAX_ITEMS location=${location}`);
  }
  if (schema.uniqueItems === true
    && new Set(value.map((entry) => canonicalJson(entry))).size !== value.length) {
    throw new Error(`RECOVERY_EVIDENCE_SCHEMA_UNIQUE location=${location}`);
  }
  if (schema.items !== undefined) {
    value.forEach((entry, index) =>
      validateSchema(entry, schema.items, rootSchema, `${location}[${index}]`));
  }
}

function validateSchemaObject(value, schema, rootSchema, location) {
  const required = schema.required ?? [];
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`RECOVERY_EVIDENCE_SCHEMA_REQUIRED location=${location}.${key}`);
    }
  }
  const properties = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    const extra = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
    if (extra !== undefined) {
      throw new Error(`RECOVERY_EVIDENCE_SCHEMA_ADDITIONAL location=${location}.${extra}`);
    }
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) {
      validateSchema(value[key], childSchema, rootSchema, `${location}.${key}`);
    }
  }
}

function exactKeys(value, keys, label) {
  assert.deepEqual(Object.keys(value).toSorted(), [...keys].toSorted(), `RECOVERY_EVIDENCE_KEYS file=${label}`);
}

function validateArtifact(bundle, reference, label) {
  const path = safeBundlePath(bundle, reference.path);
  const bytes = readStableFile(path, label);
  if (bytes.length !== reference.byteLength || sha256(bytes) !== reference.sha256) {
    throw new Error(`RECOVERY_EVIDENCE_ARTIFACT_MISMATCH file=${label}`);
  }
  return { bytes, value: parseJson(bytes, label) };
}

function validateInventoryArtifact(bundle, reference, facts, label) {
  const { value } = validateArtifact(bundle, reference, label);
  exactKeys(value, ["schemaVersion", "tree", "entryCount", "totalBytes", "sha256", "entries"], label);
  validateInventoryHeader(value, label);
  const total = validateInventoryEntries(bundle, value.entries, label);
  if (total !== value.totalBytes || sha256(Buffer.from(JSON.stringify(value.entries), "utf8")) !== value.sha256
    || value.tree !== facts.tree || value.sha256 !== facts.inventorySha256
    || value.entryCount !== facts.entryCount || value.totalBytes !== facts.totalBytes) {
    throw new Error(`RECOVERY_EVIDENCE_INVENTORY_FACT_MISMATCH file=${label}`);
  }
}

function validateInventoryHeader(value, label) {
  if (value.schemaVersion !== 1 || !GIT_SHA.test(value.tree) || !SHA256.test(value.sha256)
    || !Number.isSafeInteger(value.entryCount) || value.entryCount < 1
    || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1
    || !Array.isArray(value.entries) || value.entries.length !== value.entryCount) {
    throw new Error(`RECOVERY_EVIDENCE_INVENTORY_INVALID file=${label}`);
  }
}

function validateInventoryEntries(bundle, entries, label) {
  let total = 0;
  let prior;
  for (const [index, entry] of entries.entries()) {
    exactKeys(entry, ["path", "mode", "gitObject", "byteLength", "sha256"], `${label}:${index}`);
    safeBundlePath(bundle, entry.path);
    validateInventoryEntry(entry, label, index);
    if (prior !== undefined && Buffer.compare(Buffer.from(prior), Buffer.from(entry.path)) >= 0) {
      throw new Error(`RECOVERY_EVIDENCE_INVENTORY_ORDER file=${label}`);
    }
    prior = entry.path;
    total += entry.byteLength;
  }
  return total;
}

function validateInventoryEntry(entry, label, index) {
  if (!["100644", "100755", "120000"].includes(entry.mode) || !GIT_SHA.test(entry.gitObject)
    || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || !SHA256.test(entry.sha256)) {
    throw new Error(`RECOVERY_EVIDENCE_INVENTORY_ENTRY_INVALID file=${label} index=${index}`);
  }
}

function validateStatusArtifact(bundle, reference, expectedSha256, label) {
  const { value } = validateArtifact(bundle, reference, label);
  exactKeys(value, ["schemaVersion", "format", "byteLength", "sha256", "base64"], label);
  const bytes = Buffer.from(value.base64, "base64");
  if (value.schemaVersion !== 1 || value.format !== "git-status-porcelain-v1-z"
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0
    || !SHA256.test(value.sha256) || bytes.length !== value.byteLength
    || bytes.toString("base64") !== value.base64 || sha256(bytes) !== value.sha256
    || value.sha256 !== expectedSha256) {
    throw new Error(`RECOVERY_EVIDENCE_STATUS_INVALID file=${label}`);
  }
}

function validateManifestArtifact(bundle, fact) {
  const label = `manifest:${fact.sliceId}`;
  const { value } = validateArtifact(bundle, fact.artifact, label);
  exactKeys(value, [
    "schemaVersion", "sliceId", "baselineSha", "ownedRoot", "ownedPaths", "restoreFromBaseline",
    "sharedPaths", "reverseEdits", "retainedSharedPaths", "survivingGates",
  ], label);
  if (value.schemaVersion !== 1 || value.sliceId !== fact.sliceId
    || value.baselineSha !== expectedBaselineSha
    || sha256(Buffer.from(JSON.stringify(value), "utf8")) !== fact.sha256) {
    throw new Error(`RECOVERY_EVIDENCE_MANIFEST_INVALID slice=${fact.sliceId}`);
  }
}

function validateStatementArtifacts(bundle, statement) {
  if (statement.candidate.inventory.path !== "candidate-inventory.v1.json") {
    throw new Error("RECOVERY_EVIDENCE_ARTIFACT_PATH_INVALID file=candidate-inventory");
  }
  validateInventoryArtifact(bundle, statement.candidate.inventory, statement.candidate, "candidate-inventory");
  for (const manifest of statement.manifests) {
    if (manifest.artifact.path !== `slices/${manifest.sliceId}/manifest.v1.json`) {
      throw new Error(`RECOVERY_EVIDENCE_ARTIFACT_PATH_INVALID file=manifest:${manifest.sliceId}`);
    }
    validateManifestArtifact(bundle, manifest);
  }
  for (const slice of statement.slices) {
    const prefix = `slices/${slice.sliceId}`;
    const expectedPaths = {
      preStatus: `${prefix}/pre-state-status.v1.json`,
      preInventory: `${prefix}/pre-state-inventory.v1.json`,
      rollbackStatus: `${prefix}/executed-rollback-status.v1.json`,
      rollbackInventory: `${prefix}/executed-rollback-inventory.v1.json`,
    };
    if (slice.preState.status.path !== expectedPaths.preStatus
      || slice.preState.inventory.path !== expectedPaths.preInventory
      || slice.rollback.status.path !== expectedPaths.rollbackStatus
      || slice.rollback.inventory.path !== expectedPaths.rollbackInventory) {
      throw new Error(`RECOVERY_EVIDENCE_ARTIFACT_PATH_INVALID file=slice:${slice.sliceId}`);
    }
    validateStatusArtifact(bundle, slice.preState.status, slice.preState.statusSha256, `${slice.sliceId}:pre-status`);
    validateInventoryArtifact(bundle, slice.preState.inventory, slice.preState, `${slice.sliceId}:pre-inventory`);
    validateStatusArtifact(bundle, slice.rollback.status, slice.rollback.statusSha256, `${slice.sliceId}:rollback-status`);
    validateInventoryArtifact(bundle, slice.rollback.inventory, slice.rollback, `${slice.sliceId}:rollback-inventory`);
  }
}

function validateSemanticStatement(statement, expectedSha) {
  assert.deepEqual(statement.manifests.map(({ sliceId }) => sliceId), expectedSlices);
  assert.deepEqual(statement.slices.map(({ sliceId }) => sliceId), expectedSlices);
  if (statement.baselineSha !== expectedBaselineSha) {
    throw new Error(
      `RECOVERY_EVIDENCE_BASELINE_MISMATCH expected=${expectedBaselineSha} actual=${statement.baselineSha}`,
    );
  }
  if (expectedSha !== undefined && statement.candidate.sha !== expectedSha) {
    throw new Error(`RECOVERY_EVIDENCE_CANDIDATE_MISMATCH expected=${expectedSha} actual=${statement.candidate.sha}`);
  }
  for (const [index, slice] of statement.slices.entries()) {
    const manifest = statement.manifests[index];
    const survivors = expectedSlices.filter((value) => value !== slice.sliceId);
    const exactGateIds = [
      ...commonGateIds,
      ...survivors.flatMap((survivor) => survivorGateIds[survivor]),
    ];
    if (slice.manifestSha256 !== manifest.sha256 || slice.candidateSha !== statement.candidate.sha
      || slice.checkoutInventorySha256 !== statement.candidate.inventorySha256
      || slice.application.candidateSha !== statement.candidate.sha
      || slice.application.tree !== statement.candidate.tree
      || slice.preState.sha !== slice.rollback.sha || slice.preState.tree !== slice.rollback.tree
      || slice.preState.statusSha256 !== slice.rollback.statusSha256
      || slice.preState.inventorySha256 !== slice.rollback.inventorySha256
      || canonicalJson(slice.expectedGateIds) !== canonicalJson(exactGateIds)
      || canonicalJson(slice.executedGateIds) !== canonicalJson(exactGateIds)) {
      throw new Error(`RECOVERY_EVIDENCE_SLICE_FACT_MISMATCH slice=${slice.sliceId}`);
    }
  }
}

export function validateEvidenceBundle({ bundlePath, expectedSha, requireReady = true }) {
  if (!isAbsolute(bundlePath)) {throw new Error("RECOVERY_EVIDENCE_BUNDLE_NOT_ABSOLUTE");}
  const bundle = realpathSync(bundlePath);
  const bundleEntry = lstatSync(bundle, { bigint: true });
  if (!bundleEntry.isDirectory() || bundleEntry.isSymbolicLink() || (statSync(bundle).mode & 0o777) !== 0o700) {
    throw new Error("RECOVERY_EVIDENCE_BUNDLE_UNSAFE");
  }
  const schemaBytes = readStableFile(schemaPath, "schema");
  const schema = parseJson(schemaBytes, "schema");
  const statementBytes = readStableFile(join(bundle, "statement.json"), "statement.json");
  const statement = parseJson(statementBytes, "statement.json");
  const statementCanonical = Buffer.from(canonicalJson(statement), "utf8");
  if (!statementBytes.equals(Buffer.concat([statementCanonical, Buffer.from("\n")]))) {
    throw new Error("RECOVERY_EVIDENCE_STATEMENT_NOT_CANONICAL");
  }
  validateSchema(statement, schema.$defs.statement, schema);
  validateSemanticStatement(statement, expectedSha);
  validateStatementArtifacts(bundle, statement);

  const sealBytes = readStableFile(join(bundle, "seal.json"), "seal.json");
  const seal = parseJson(sealBytes, "seal.json");
  if (!sealBytes.equals(Buffer.from(canonicalJson(seal) + "\n", "utf8"))) {
    throw new Error("RECOVERY_EVIDENCE_SEAL_NOT_CANONICAL");
  }
  validateSchema(seal, schema.$defs.seal, schema);
  if (seal.candidateSha !== statement.candidate.sha
    || seal.schema.byteLength !== schemaBytes.length || seal.schema.sha256 !== sha256(schemaBytes)
    || seal.statement.byteLength !== statementBytes.length || seal.statement.sha256 !== sha256(statementBytes)
    || seal.statement.canonicalSha256 !== sha256(statementCanonical)) {
    throw new Error("RECOVERY_EVIDENCE_SEAL_MISMATCH");
  }

  if (requireReady) {
    const readyBytes = readStableFile(join(bundle, "READY"), "READY");
    const ready = parseJson(readyBytes, "READY");
    if (!readyBytes.equals(Buffer.from(canonicalJson(ready) + "\n", "utf8"))) {
      throw new Error("RECOVERY_EVIDENCE_READY_NOT_CANONICAL");
    }
    validateSchema(ready, schema.$defs.ready, schema);
    if (ready.candidateSha !== statement.candidate.sha || ready.sealSha256 !== sha256(sealBytes)
      || ready.proofDigestSha256 !== seal.statement.canonicalSha256) {
      throw new Error("RECOVERY_EVIDENCE_READY_MISMATCH");
    }
  }
  return {
    candidateSha: statement.candidate.sha,
    sealSha256: sha256(sealBytes),
    proofDigestSha256: seal.statement.canonicalSha256,
  };
}

function cli() {
  const cliArguments = process.argv.slice(2);
  const bundleArgument = cliArguments.find((value) => value.startsWith("--bundle="));
  const expectedArgument = cliArguments.find((value) => value.startsWith("--expected-sha="));
  const allowed = new Set(["--allow-missing-ready"]);
  for (const argument of cliArguments) {
    if (!argument.startsWith("--bundle=") && !argument.startsWith("--expected-sha=") && !allowed.has(argument)) {
      throw new Error(`RECOVERY_EVIDENCE_ARGUMENT_INVALID value=${argument}`);
    }
  }
  if (bundleArgument === undefined || bundleArgument.slice("--bundle=".length).length === 0) {
    throw new Error("RECOVERY_EVIDENCE_BUNDLE_REQUIRED");
  }
  const expectedSha = expectedArgument?.slice("--expected-sha=".length);
  if (expectedSha !== undefined && !GIT_SHA.test(expectedSha)) {
    throw new Error("RECOVERY_EVIDENCE_EXPECTED_SHA_INVALID");
  }
  const result = validateEvidenceBundle({
    bundlePath: bundleArgument.slice("--bundle=".length),
    expectedSha,
    requireReady: !cliArguments.includes("--allow-missing-ready"),
  });
  process.stdout.write(
    `RECOVERY_EVIDENCE_VALID candidate=${result.candidateSha}`
    + ` proof=${result.proofDigestSha256} seal=${result.sealSha256}\n`,
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
