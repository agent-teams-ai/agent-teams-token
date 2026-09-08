import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { OwnedProcess } from "../src/adapters/process.ts";

const realSpawn = childProcess.spawn;
const realExecFile = childProcess.execFile;
const realKill = process.kill;

interface Fixture {
  readonly children: ChildProcess[];
  readonly groups: Set<number>;
  readonly spawnArguments: Parameters<typeof realSpawn>[];
}

// Every fixture has a natural watchdog as well as explicit, bounded teardown.
// Only PIDs/PGIDs returned by fresh test spawns are ever signalled.
function track(t: TestContext, setup?: (child: ChildProcess) => void): Fixture {
  const fixture: Fixture = { children: [], groups: new Set<number>(), spawnArguments: [] };
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof realSpawn>): ReturnType<typeof realSpawn> => {
    const child = Reflect.apply(realSpawn, childProcess, args) as ReturnType<typeof realSpawn>;
    fixture.spawnArguments.push(args);
    fixture.children.push(child);
    if (child.pid !== undefined) { fixture.groups.add(child.pid); }
    setup?.(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const child of fixture.children) {
      // Teardown can signal only a still-owned unreaped group leader. Never
      // turn a ps row for a stored/reaped PGID into renewed kill authority.
      if (child.pid !== undefined && fixture.groups.has(child.pid) && child.exitCode === null && child.signalCode === null) {
        try { realKill(-child.pid, "SIGKILL"); } catch (error) { if (code(error) !== "ESRCH") { throw error; } }
      }
    }
    for (const child of fixture.children) {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); }
    }
    await waitForQuiet(fixture);
  });
  return fixture;
}

async function liveGroups(): Promise<Set<number>> {
  const text = await new Promise<string>((resolve, reject) => {
    realExecFile("/bin/ps", ["-axo", "pgid=,stat="], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    }, (error, stdout) => { if (error !== null) { reject(error); } else { resolve(stdout); } });
  });
  const groups = new Set<number>();
  for (const line of text.trim().split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)/u.exec(line);
    assert.ok(match, `malformed fixture process observation: ${line}`);
    if (!match[2]!.startsWith("Z")) { groups.add(Number(match[1])); }
  }
  return groups;
}

async function waitForQuiet(fixture: Fixture): Promise<void> {
  const deadline = performance.now() + 1_500;
  while (true) {
    const groups = await liveGroups();
    const reaped = fixture.children.every((child) => child.pid === undefined || child.exitCode !== null || child.signalCode !== null);
    if (reaped && [...fixture.groups].every((pgid) => !groups.has(pgid))) { return; }
    assert.ok(performance.now() < deadline, "fresh fixture processes did not terminate and reap under teardown deadline");
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
}

function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

// Cancellation is a port capability, not an import-time global signal handler.
test("already cancelled work cannot spawn; explicit cleanup remains independent", async (t) => {
  const fixture = track(t);
  const controller = new AbortController();
  const reason = new Error("owned work interrupted");
  controller.abort(reason);
  const cancelled = new OwnedProcess(controller.signal);
  await assert.rejects(cancelled.run(process.execPath, ["-e", "process.exit(0)"], 1_000), (error: unknown) => error === reason);
  assert.equal(fixture.children.length, 0);
  assert.deepEqual(await cancelled.run(process.execPath, ["-e", "process.stdout.write('cleanup')"], 1_000, {signal: null}), {exitCode: 0, stdout: "cleanup", stderr: "", timedOut: false});
});

test("abort listeners are removed after success, interruption and independent cleanup", async (t) => {
  const fixture = track(t);
  const controller = new AbortController();
  const owned = new OwnedProcess(controller.signal);
  await owned.run(process.execPath, ["-e", "process.exit(0)"], 2_000);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const pending = owned.run(process.execPath, ["-e", "setTimeout(()=>{},5000)"], 5_000);
  controller.abort(new Error("interrupted"));
  await assert.rejects(pending);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await owned.run(process.execPath, ["-e", "process.exit(0)"], 2_000, {signal: null});
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await waitForQuiet(fixture);
});
