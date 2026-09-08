import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { after, test } from "node:test";

const roots: string[] = [];
const cli = resolvePath(import.meta.dirname, "../verify-cli.ts");

after(async () => { await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true }))); });

test("malformed and unreadable verifier inputs emit one redacted structured failure", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-verify-cli-")));
  roots.push(root);
  const malformed = join(root, "malformed-input.json");
  const absent = join(root, "absent-input.json");
  await writeFile(malformed, "{");

  const cases = [
    { path: malformed, diagnostic: "VERIFY_INPUT_JSON_INVALID" },
    { path: absent, diagnostic: "LOCAL_EVM_VERIFICATION_INPUT_ENOENT" },
  ];
  for (const value of cases) {
    const result = await execute(value.path);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "");
    const lines = result.stdout.trim().split(/\r?\n/u);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!), { status: "failed", diagnostic: value.diagnostic });
    assert.equal(`${result.stdout}${result.stderr}`.includes(root), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes("at "), false);
  }
});

async function execute(inputPath: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, inputPath], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exitCode, stdout, stderr };
}
