import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { classifyGateFailure, FAILURE_REGISTRY } from "../src/application/failure.ts";

test("compiler, artifact, analyzer and environment failures have stable evidence exits", () => {
  assert.deepEqual(classifyGateFailure("COMPILER_BUILD_FAILED"), { category: "output-failure", exitCode: 40, stage: "compiler-build" });
  assert.deepEqual(classifyGateFailure("BUILD_INFO_INVALID"), { category: "output-failure", exitCode: 40, stage: "artifact-validation" });
  assert.deepEqual(classifyGateFailure("ARTIFACT_EXPORT_FAILED"), { category: "output-failure", exitCode: 40, stage: "artifact-validation" });
  assert.deepEqual(classifyGateFailure("ANALYZER_RUNTIME_FAILED"), { category: "tool-failure", exitCode: 30, stage: "analysis-runtime" });
  assert.deepEqual(classifyGateFailure("IMAGE_UNAVAILABLE"), { category: "environment-failure", exitCode: 50, stage: "image-preflight" });
});

test("serialized failure variants exactly equal the exhaustive typed registry", async () => {
  const serialized = new Map<string, { category: string; exitCode: number; stage: string }>();
  for (const category of ["tool-failure", "output-failure", "environment-failure"] as const) {
    const schema = JSON.parse(await readFile(`tooling/security/slither/${category}.schema.v1.json`, "utf8")) as {
      oneOf: { properties: { stage: { const: string }; errorCode: { const: string } } }[];
      properties: { category: { const: string }; exitCode: { const: number } };
    };
    for (const variant of schema.oneOf) {
      serialized.set(variant.properties.errorCode.const, { category: schema.properties.category.const, exitCode: schema.properties.exitCode.const, stage: variant.properties.stage.const });
    }
  }
  assert.deepEqual(Object.fromEntries([...serialized].toSorted(([left], [right]) => left.localeCompare(right))), FAILURE_REGISTRY);
});

test("every literal SlitherGateError code is registered", async () => {
  const sourceFiles = await typescriptFiles("tooling/security/slither/src");
  const emitted = new Set<string>();
  for (const path of sourceFiles) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/new\s+SlitherGateError\(\s*["']([A-Z0-9_]+)["']/gu)) {emitted.add(match[1]!);}
  }
  assert.deepEqual([...emitted].filter((code) => !(code in FAILURE_REGISTRY)), []);
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory()
    ? await typescriptFiles(join(directory, entry.name))
    : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []))).flat();
}
