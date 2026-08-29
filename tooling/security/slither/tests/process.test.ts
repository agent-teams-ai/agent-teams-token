import assert from "node:assert/strict";
import { test } from "node:test";
import { OwnedProcess } from "../src/adapters/process.ts";

test("owned process reports exact exit and bounded timeout", async () => {
  const port = new OwnedProcess();
  const clean = await port.run(process.execPath, ["-e", "process.stdout.write('ok')"], 5_000);
  assert.deepEqual(clean, { exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
  const timeout = await port.run(process.execPath, ["-e", "setTimeout(() => undefined, 10_000)"], 20);
  assert.equal(timeout.timedOut, true); assert.notEqual(timeout.exitCode, 0);
});
