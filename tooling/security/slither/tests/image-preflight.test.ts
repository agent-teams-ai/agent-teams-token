import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProcessPort, ProcessResult } from "../src/application/ports.ts";
import { pullPinnedImage } from "../src/adapters/image-preflight.ts";
import { IMAGE } from "../src/adapters/container-contract.ts";

class FakeProcess implements ProcessPort {
  command = ""; args: readonly string[] = [];
  private readonly result: ProcessResult;
  constructor(result: ProcessResult) { this.result = result; }
  async run(command: string, args: readonly string[]): Promise<ProcessResult> { this.command = command; this.args = args; return this.result; }
}

test("image preflight pulls only the exact platform manifest digest", async () => {
  const port = new FakeProcess({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  assert.equal(await pullPinnedImage(port), true); assert.equal(port.command, "/usr/bin/docker"); assert.deepEqual(port.args, ["pull", "--platform", "linux/amd64", IMAGE]);
});

test("image pull failure and timeout fail closed", async () => {
  assert.equal(await pullPinnedImage(new FakeProcess({ exitCode: 1, stdout: "", stderr: "redacted", timedOut: false })), false);
  assert.equal(await pullPinnedImage(new FakeProcess({ exitCode: null, stdout: "", stderr: "", timedOut: true })), false);
});
