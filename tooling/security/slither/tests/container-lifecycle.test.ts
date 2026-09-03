import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runContainerById } from "../src/adapters/runner.ts";
import type { ProcessPort, ProcessResult } from "../src/application/ports.ts";
test("container lifecycle uses immutable IDs for inspect, start, copy and cleanup",async()=>{const source=await readFile("tooling/security/slither/src/adapters/runner.ts","utf8");for(const command of ['["start", id]','["exec", id','["wait", id]','["cp", `${id}:','["rm", "--force", id]','["container", "inspect", id']) assert.equal(source.includes(command),true,command);assert.doesNotMatch(source,/\["rm",\s*"--force",\s*(?:container)?name/iu);});

test("a timed-out create with a validated immutable ID is re-inspected and removed", async () => {
  const id = "a".repeat(64); const calls: string[][] = [];
  const result = (stdout = "", overrides: Partial<ProcessResult> = {}): ProcessResult => ({exitCode: 0, stdout, stderr: "", timedOut: false, ...overrides});
  const port: ProcessPort = {run: async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "info") {return result(`${JSON.stringify({CgroupDriver: "systemd", CgroupVersion: "2"})}\n`);}
    if (args[0] === "create") {return result(`${id}\n`, {exitCode: null, timedOut: true});}
    if (args[0] === "container") {return result(`${JSON.stringify({Id: id, State: {Running: false}})}\n`);}
    if (args[0] === "rm") {return result();}
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }};
  await assert.rejects(
    runContainerById(port, "/usr/bin/docker", ["create"], "/tmp/not-used", []),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CONTAINER_ID_INVALID",
  );
  assert.deepEqual(calls.at(-1), ["rm", "--force", id]);
});
