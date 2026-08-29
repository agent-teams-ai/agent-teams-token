import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";
import type { ProcessOptions, ProcessPort, ProcessResult } from "../src/application/ports.ts";
import { pullPinnedImage } from "../src/adapters/image-preflight.ts";
import { IMAGE } from "../src/adapters/container-contract.ts";

class FakeProcess implements ProcessPort {
  command = ""; args: readonly string[] = [];
  options: ProcessOptions | undefined;
  observedConfig = "";
  private readonly result: ProcessResult;
  constructor(result: ProcessResult) { this.result = result; }
  async run(command: string, args: readonly string[], _timeout: number, options?: ProcessOptions): Promise<ProcessResult> {
    this.command = command; this.args = args; this.options = options;
    this.observedConfig = await readFile(`${options?.env?.DOCKER_CONFIG}/config.json`, "utf8");
    return this.result;
  }
}

test("image preflight pulls only the exact platform manifest digest", async () => {
  const port = new FakeProcess({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  assert.equal(await pullPinnedImage(port, "/canonical/docker"), true);
  assert.equal(port.command, "/canonical/docker");
  assert.deepEqual(port.args, ["pull", "--platform", "linux/amd64", IMAGE]);
  assert.equal(port.observedConfig, '{"auths":{}}\n');
  assert.equal(port.options?.env?.PATH, "/usr/bin:/bin");
  await assert.rejects(access(port.options?.env?.DOCKER_CONFIG ?? ""));
});

test("image pull failure and timeout fail closed", async () => {
  const failure = new FakeProcess({ exitCode: 1, stdout: "", stderr: "redacted", timedOut: false });
  const timeout = new FakeProcess({ exitCode: null, stdout: "", stderr: "", timedOut: true });
  assert.equal(await pullPinnedImage(failure, "/canonical/docker"), false);
  assert.equal(await pullPinnedImage(timeout, "/canonical/docker"), false);
});
