import assert from "node:assert/strict";
import test from "node:test";
import { NodeCommandAdapter, redact } from "../src/adapters/process.ts";

test("process adapter rejects PATH fallback and bounds execution", async () => {
  const adapter = new NodeCommandAdapter();
  await assert.rejects(adapter.run("node", ["--version"]), /SOLANA_EXECUTABLE_ABSOLUTE/u);
  await assert.rejects(adapter.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 30 }), /SOLANA_COMMAND_TIMEOUT/u);
});

test("process interruption terminates only its exact child", async () => {
  const adapter = new NodeCommandAdapter(); const controller = new AbortController();
  const pending = adapter.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /SOLANA_COMMAND_ABORTED/u);
  const neighbour = await adapter.run(process.execPath, ["-e", "process.stdout.write('alive')"]);
  assert.equal(neighbour.stdout, "alive");
});

test("diagnostics redact mnemonic-like values and key paths", () => {
  const value = redact("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu /tmp/run/payer.json");
  assert.equal(value.includes("alpha beta"), false); assert.equal(value.includes("payer.json"), false);
});
