import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import test from "node:test";

interface Result { readonly code: number | null; readonly stdout: string; readonly stderr: string }

async function subprocess(entrypoint: string, args: readonly string[]): Promise<Result> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code) => { resolve({ code, stdout, stderr }); });
  });
}

const composition = resolvePath(import.meta.dirname, "../src/composition/index.ts");
const wrapper = resolvePath(import.meta.dirname, "../../../scripts/solana/local-fixture.ts");
const helper = resolvePath(import.meta.dirname, "helpers/cli-boundary.ts");

test("direct and wrapper entrypoints share the sanitized pre-mutation CLI boundary", async () => {
  for (const entrypoint of [composition, wrapper]) {
    const result = await subprocess(entrypoint, ["--bad", "/private/secret/path"]);
    assert.equal(result.code, 1); assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), { status: "FAILED", diagnosticCode: "SOLANA_CLI_USAGE" });
    assert.doesNotMatch(result.stderr, /private|path|usage:/iu);
  }
});

test("post-mutation failures expose only an allowlisted stable diagnostic", async () => {
  const result = await subprocess(helper, ["failure"]);
  assert.equal(result.code, 1); assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { status: "FAILED", diagnosticCode: "SOLANA_FIXTURE_FAILED" });
  assert.doesNotMatch(result.stderr, /private|payer|http|rpc body|raw post/iu);
});

test("success output exposes only an opaque evidence bundle id", async () => {
  const result = await subprocess(helper, ["success"]);
  assert.equal(result.code, 0); assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { status: "READY", bundleId: "evidence-opaque-123" });
  assert.doesNotMatch(result.stdout, /private|output|report\.v1|\.json|\.md|\//iu);
});

test("output failures are also contained by the process boundary", async () => {
  const result = await subprocess(helper, ["output-failure"]);
  assert.equal(result.code, 1); assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { status: "FAILED", diagnosticCode: "SOLANA_FIXTURE_FAILED" });
  assert.doesNotMatch(result.stderr, /private|key|http|raw output/iu);
});
