import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { ProcessFailure } from "../src/application/cancellation.ts";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { OwnedProcess } from "../src/adapters/process.ts";

const port = new OwnedProcess();
const realSpawn = childProcess.spawn;
const realExecFile = childProcess.execFile;
const realKill = process.kill;
const STDOUT_LIMIT = 4 * Math.ceil(64 * 1024 * 1024 / 3) + 12 * 256;
const STDERR_LIMIT = 1024 * 1024;
const SCHEDULING_ALLOWANCE = 600;

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

function errors(error: unknown): readonly unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(errors) : [error];
}

function matches(error: unknown, pattern: RegExp): boolean {
  return errors(error).some((entry) => entry instanceof Error && pattern.test(entry.message));
}

function treeScript(mode: "wait" | "exit" | "closed-pipes" | "finish", lifetime = 5_000): string {
  const descendant = `
    process.on('SIGTERM', () => {});
    process.stdout.write('grandchild-ready\\n');
    process.stderr.write('grandchild-stderr\\n');
    process.send('ready');
    setTimeout(() => process.exit(0), ${lifetime});
  `;
  const stdio = mode === "closed-pipes" ? ["ignore", "ignore", "ignore", "ipc"] : ["ignore", "inherit", "inherit", "ipc"];
  return `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ${JSON.stringify(stdio)} });
    grandchild.once('message', () => {
      process.stdout.write('parent-ready\\n');
      ${mode === "exit" || mode === "closed-pipes" ? "process.exit(0);" : ""}
    });
    ${mode === "finish" ? "grandchild.once('close', () => process.exit(7));" : "setInterval(() => {}, 1000);"}
    setTimeout(() => process.exit(99), 6_000).unref();
  `;
}

function assertReleased(child: ChildProcess): void {
  assert.ok(child.exitCode !== null || child.signalCode !== null, "direct child was reaped");
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  for (const stream of [child.stdout, child.stderr]) {
    assert.equal(stream?.destroyed, true);
    assert.equal(stream?.closed, true);
    assert.equal(stream?.listenerCount("data"), 0);
    assert.equal(stream?.listenerCount("error"), 0);
  }
}

async function nativeEnvironment(env: NodeJS.ProcessEnv): Promise<unknown> {
  // Native Node may initialize OS-specific keys after spawn (CoreFoundation on
  // macOS). Use an independent child with the exact intended input environment.
  // execFile bounds time/output and calls back after close/reap; bypass track()
  // so its own listeners are not mistaken for OwnedProcess listener leaks.
  const result = await new Promise<{ child: ChildProcess; stdout: string; stderr: string }>((resolve, reject) => {
    const child = realExecFile(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
      env, encoding: "utf8", timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      if (error !== null) { reject(error); } else { resolve({ child, stdout, stderr }); }
    });
  });
  assert.equal(result.child.exitCode, 0);
  assert.equal(result.child.signalCode, null);
  assert.equal(result.stderr, "");
  for (const stream of [result.child.stdout, result.child.stderr]) {
    assert.equal(stream?.destroyed, true);
    assert.equal(stream?.closed, true);
  }
  return JSON.parse(result.stdout) as unknown;
}

test("exact exit, signal, UTF-8 capture and explicit minimal environment", { timeout: 10_000 }, async (t) => {
  const fixture = track(t);
  const clean = await port.run(process.execPath, ["-e", "process.stdout.write('ok'); process.stderr.write('err');"], 5_000);
  assert.deepEqual(clean, { exitCode: 0, stdout: "ok", stderr: "err", timedOut: false });
  const nonzero = await port.run(process.execPath, ["-e", "process.exit(23)"], 5_000);
  assert.deepEqual(nonzero, { exitCode: 23, stdout: "", stderr: "", timedOut: false });
  const signal = await port.run(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], 5_000);
  assert.deepEqual(signal, { exitCode: null, stdout: "", stderr: "", timedOut: false });
  const unicode = await port.run(process.execPath, ["-e", "const b=Buffer.from('€😀'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),20)"], 5_000);
  assert.equal(unicode.stdout, "€😀");
  const environmentScript = "process.stdout.write(JSON.stringify(process.env))";
  const nativeMinimal = await nativeEnvironment({ PATH: "/usr/bin:/bin" });
  const minimal = await port.run(process.execPath, ["-e", environmentScript], 5_000);
  assert.deepEqual(fixture.spawnArguments.at(-1)?.[2], {
    detached: true, shell: false, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.deepEqual(JSON.parse(minimal.stdout), nativeMinimal);
  const nativeExplicit = await nativeEnvironment({ SLITHER_SYNTHETIC: "only" });
  const explicit = await port.run(process.execPath, ["-e", environmentScript], 5_000, { env: { SLITHER_SYNTHETIC: "only" } });
  assert.deepEqual(fixture.spawnArguments.at(-1)?.[2], {
    detached: true, shell: false, env: { SLITHER_SYNTHETIC: "only" }, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.deepEqual(JSON.parse(explicit.stdout), nativeExplicit);
  assert.equal(fixture.children.length, 6, "native oracles bypass OwnedProcess spawn tracking");
  for (const child of fixture.children) { assertReleased(child); }
});

test("invalid budgets and expired budget spawn nothing; spawn errors remain errors", async (t) => {
  const fixture = track(t);
  for (const budget of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await assert.rejects(port.run(process.execPath, [], budget), /PROCESS_BUDGET_INVALID/u);
  }
  assert.deepEqual(await port.run(process.execPath, [], 0), { exitCode: null, stdout: "", stderr: "", timedOut: true });
  assert.equal(fixture.children.length, 0);
  await assert.rejects(port.run(`${process.execPath}/synthetic-missing`, [], 1_000), (error: unknown) => code(error) === "ENOTDIR");
  await assert.rejects(port.run("\0", [], 1_000), (error: unknown) => code(error) === "ERR_INVALID_ARG_VALUE");
});

test("100ms inherited-pipe regression cannot wait for a 1600ms grandchild", { timeout: 5_000 }, async (t) => {
  const fixture = track(t);
  const script = `
    require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1600)'], {stdio: ['ignore','inherit','inherit']});
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(99), 3000).unref();
  `;
  const start = performance.now();
  try {
    const result = await port.run(process.execPath, ["-e", script], 100);
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  } catch (error) {
    // A loaded scheduler can exhaust the cleanup reserve. Explicit uncertainty
    // is acceptable; waiting for inherited pipes or reporting success is not.
    assert.ok(matches(error, /PROCESS_CLEANUP_UNCONFIRMED/u));
  }
  assert.ok(performance.now() - start < 100 + SCHEDULING_ALLOWANCE, "inherited pipe exceeded the absolute caller budget and scheduling allowance");
  await waitForQuiet(fixture);
  assertReleased(fixture.children[0]!);
});

test("ready TERM-ignoring grandchild and waiting parent are killed and reaped within one budget", { timeout: 5_000 }, async (t) => {
  const fixture = track(t);
  const start = performance.now();
  const result = await port.run(process.execPath, ["-e", treeScript("wait")], 1_000);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.match(result.stdout, /grandchild-ready\nparent-ready/u);
  assert.match(result.stderr, /grandchild-stderr/u);
  assert.ok(performance.now() - start < 1_000 + SCHEDULING_ALLOWANCE);
  await waitForQuiet(fixture);
  assertReleased(fixture.children[0]!);
});

for (const mode of ["exit", "closed-pipes"] as const) {
  test(`early exit with surviving ${mode} descendants is cleaned and rejected`, { timeout: 5_000 }, async (t) => {
    const fixture = track(t);
    const start = performance.now();
    await assert.rejects(port.run(process.execPath, ["-e", treeScript(mode)], 3_000), (error: unknown) => matches(error, /PROCESS_DESCENDANTS/u));
    assert.ok(performance.now() - start < 1_500, "cleanup must start at direct exit, including when inherited pipes stay open");
    await waitForQuiet(fixture);
    assertReleased(fixture.children[0]!);
  });
}

test("a parent that reaps its descendant retains exact exit and complete output", async (t) => {
  const fixture = track(t);
  const result = await port.run(process.execPath, ["-e", treeScript("finish", 50)], 3_000);
  assert.deepEqual(result, { exitCode: 7, stdout: "grandchild-ready\nparent-ready\n", stderr: "grandchild-stderr\n", timedOut: false });
  assertReleased(fixture.children[0]!);
});

test("complete 64MiB JSON/base64 frame fits the exact stdout bound with independent stderr", { timeout: 15_000 }, async (t) => {
  const fixture = track(t);
  const script = `
    const { writeSync } = require('node:fs');
    const data = Buffer.alloc(16*1024*1024, 97).toString('base64');
    const frame = JSON.stringify({files: Array.from({length:4}, (_,i) => ({name:'file'+i,data}))});
    writeSync(1, frame);
    writeSync(1, ' '.repeat(${STDOUT_LIMIT}-Buffer.byteLength(frame)));
    writeSync(2, 'z'.repeat(${STDERR_LIMIT}));
  `;
  const result = await port.run(process.execPath, ["-e", script], 10_000);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(Buffer.byteLength(result.stdout), STDOUT_LIMIT);
  assert.equal(result.stderr, "z".repeat(STDERR_LIMIT));
  const frame = JSON.parse(result.stdout) as { files: { name: string; data: string }[] };
  assert.equal(frame.files.length, 4);
  for (const file of frame.files) {
    const raw = Buffer.from(file.data, "base64");
    assert.equal(raw.length, 16 * 1024 * 1024);
    assert.equal(raw.equals(Buffer.alloc(raw.length, 97)), true);
  }
  assertReleased(fixture.children[0]!);
});

for (const [name, fd, limit] of [["stdout", 1, STDOUT_LIMIT], ["stderr", 2, STDERR_LIMIT]] as const) {
  test(`${name} overflow rejects instead of returning truncated success`, { timeout: 10_000 }, async (t) => {
    const fixture = track(t);
    const script = `
      const { writeSync } = require('node:fs');
      const block = Buffer.alloc(65536, 97);
      for (let n=0; n<${limit + 1}; n+=block.length) writeSync(${fd}, block.subarray(0, Math.min(block.length, ${limit + 1}-n)));
      setInterval(() => {}, 1000);
      setTimeout(() => process.exit(99), 5000).unref();
    `;
    await assert.rejects(port.run(process.execPath, ["-e", script], 5_000), (error: unknown) => matches(error, new RegExp(`PROCESS_OUTPUT_LIMIT: ${name}`, "u")));
    await waitForQuiet(fixture);
    assertReleased(fixture.children[0]!);
  });
}

test("multibyte stderr is bounded by bytes", async (t) => {
  track(t);
  await assert.rejects(port.run(process.execPath, ["-e", "process.stderr.write('€'.repeat(400000))"], 3_000), /PROCESS_OUTPUT_LIMIT: stderr/u);
});

test("group signal failure is preserved after direct-child fallback cleanup", async (t) => {
  const fixture = track(t);
  const denied = Object.assign(new Error("synthetic group denial"), { code: "EPERM" });
  t.mock.method(process, "kill", (pid: number, signal?: string | number): true => {
    if (pid < 0 && signal === "SIGKILL") { throw denied; }
    return realKill(pid, signal);
  });
  const start = performance.now();
  await assert.rejects(port.run(process.execPath, ["-e", "setTimeout(()=>{},5000)"], 500), (error: unknown) => {
    assert.ok(matches(error, /PROCESS_GROUP_KILL_FAILED/u));
    assert.ok(errors(error).some((entry) => entry instanceof Error && entry.cause === denied));
    return true;
  });
  assert.ok(performance.now() - start < 500 + SCHEDULING_ALLOWANCE);
  assertReleased(fixture.children[0]!);
});

test("capture and stream finalization failures are both retained while other resources close", async (t) => {
  const primary = new Error("synthetic stream read failure");
  const cleanup = new Error("synthetic stream close failure");
  const fixture = track(t, (child) => {
    const stream = child.stdout!;
    const destroy = stream.destroy.bind(stream);
    t.mock.method(stream, "destroy", (error?: Error) => {
      if (stream.closed) { throw cleanup; }
      return destroy(error);
    });
    child.once("spawn", () => { stream.emit("error", primary); });
  });
  await assert.rejects(port.run(process.execPath, ["-e", "setTimeout(()=>{},5000)"], 1_000), (error: unknown) => {
    assert.deepEqual(errors(error), [primary, cleanup]);
    return true;
  });
  assertReleased(fixture.children[0]!);
});

test("failed group and direct kills reject at the deadline without waiting forever for close", { timeout: 4_000 }, async (t) => {
  const fixture = track(t, (child) => { t.mock.method(child, "kill", () => false); });
  const groupSignals: number[] = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number): true => {
    if (pid < 0 && signal === "SIGKILL") {
      groupSignals.push(pid);
      throw Object.assign(new Error("synthetic kill denial"), { code: "EPERM" });
    }
    return realKill(pid, signal);
  });
  const start = performance.now();
  await assert.rejects(port.run(process.execPath, ["-e", "setTimeout(()=>{},5000)"], 500), (error: unknown) => {
    assert.ok(matches(error, /PROCESS_GROUP_KILL_FAILED/u));
    assert.ok(matches(error, /PROCESS_CHILD_KILL_UNCONFIRMED/u));
    assert.ok(matches(error, /PROCESS_CLEANUP_UNCONFIRMED/u));
    return true;
  });
  assert.ok(performance.now() - start < 500 + SCHEDULING_ALLOWANCE);
  assert.deepEqual(groupSignals, [-fixture.children[0]!.pid!]);
  assert.equal(fixture.children[0]!.stdout!.destroyed, true);
  assert.equal(fixture.children[0]!.stderr!.destroyed, true);
  // Teardown restores the real syscalls and terminates this deliberately held fixture.
});

function substituteObserver(t: TestContext, fixture: Fixture, script: string): void {
  // Force an observation even on hosts whose init promptly reaps orphan zombies.
  t.mock.method(process, "kill", (pid: number, signal?: string | number): true => {
    if (signal === 0 && fixture.groups.has(-pid)) { return true; }
    return realKill(pid, signal);
  });
  t.mock.method(childProcess, "execFile", (...args: unknown[]): ChildProcess => {
    assert.equal(args[0], "/bin/ps");
    const observer = Reflect.apply(realExecFile, childProcess, [process.execPath, ["-e", script], args[2], args[3]]) as ChildProcess;
    fixture.children.push(observer);
    return observer;
  });
  syncBuiltinESMExports();
}

for (const [name, script, pattern] of [
  ["nonzero", "process.exit(23)", /PROCESS_GROUP_INSPECTION_FAILED/u],
  ["malformed", "process.stdout.write('not a process table')", /PROCESS_GROUP_INSPECTION_FAILED/u],
  ["oversized", "process.stdout.write('x'.repeat(300000))", /PROCESS_GROUP_INSPECTION_FAILED/u],
  ["stalled", "setTimeout(()=>{},5000)", /PROCESS_CLEANUP_UNCONFIRMED|PROCESS_GROUP_INSPECTION_FAILED/u],
] as const) {
  test(`real ${name} observer fails closed within the caller budget`, { timeout: 4_000 }, async (t) => {
    const fixture = track(t);
    substituteObserver(t, fixture, script);
    const start = performance.now();
    await assert.rejects(port.run(process.execPath, ["-e", "setTimeout(()=>{},5000)"], 800), (error: unknown) => matches(error, pattern));
    assert.ok(performance.now() - start < 800 + SCHEDULING_ALLOWANCE);
    assert.ok(fixture.children.length >= 2, "a real observer was started");
  });
}

test("successful repeated runs leave no command listeners, streams or timers", async (t) => {
  const fixture = track(t);
  const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  for (let index = 0; index < 12; index++) {
    const result = await port.run(process.execPath, ["-e", "process.stdout.write('ok')"], 2_000);
    assert.deepEqual(result, { exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
  }
  for (const child of fixture.children) { assertReleased(child); }
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length, before);
});

test("termination targets its own new group while another synthetic group stays alive", async (t) => {
  const fixture = track(t);
  const neighbour = realSpawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
  fixture.children.push(neighbour);
  fixture.groups.add(neighbour.pid!);
  const result = await port.run(process.execPath, ["-e", treeScript("wait")], 1_000);
  assert.equal(result.timedOut, true);
  assert.equal(neighbour.exitCode, null);
  assert.equal(neighbour.signalCode, null);
  assert.equal(realKill(neighbour.pid!, 0), true);
});

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

test("cancellation kills and reaps the owned real tree once within finalization budget", async (t) => {
  const controller = new AbortController();
  const reason = new Error("owned work interrupted");
  const fixture = track(t, (child) => {
    child.stdout!.on("data", function ready(chunk: Buffer) {
      if (chunk.toString().includes("parent-ready")) { child.stdout!.off("data", ready); controller.abort(reason); }
    });
  });
  const killed: number[] = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number): true => {
    if (signal === "SIGKILL") { killed.push(pid); }
    return realKill(pid, signal);
  });
  const start = performance.now();
  await assert.rejects(new OwnedProcess(controller.signal).run(process.execPath, ["-e", treeScript("wait")], 5_000), (error: unknown) => errors(error).includes(reason));
  assert.ok(performance.now() - start < 2_000);
  assert.deepEqual(killed, [-fixture.children[0]!.pid!]);
  await waitForQuiet(fixture);
  assertReleased(fixture.children[0]!);
});

function deniedObservation(t: TestContext, fixture: Fixture, failureCode = "EPERM"): number[] {
  const kills: number[] = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number): true => {
    if (signal === 0 && fixture.groups.has(-pid)) { throw Object.assign(new Error("synthetic observer denial"), {code: failureCode}); }
    if (signal === "SIGKILL") { kills.push(pid); }
    return realKill(pid, signal);
  });
  return kills;
}

test("EPERM signal-0 uncertainty resolves through real fixed ps after the owned child reaps", async (t) => {
  const fixture = track(t);
  const kills = deniedObservation(t, fixture);
  let observations = 0;
  t.mock.method(childProcess, "execFile", (...args: Parameters<typeof realExecFile>) => {
    assert.equal(args[0], "/bin/ps");
    assert.deepEqual(args[1], ["-axo", "pgid=,stat="]);
    observations++;
    return Reflect.apply(realExecFile, childProcess, args);
  });
  syncBuiltinESMExports();
  const result = await port.run(process.execPath, ["-e", "setTimeout(()=>{},5000)"], 800);
  assert.equal(result.timedOut, true);
  assert.ok(observations > 0);
  assert.deepEqual(kills, [-fixture.children[0]!.pid!]);
  assertReleased(fixture.children[0]!);
});

for (const [name, script] of [
  ["empty", ""], ["nonzero", "process.exit(23)"],
  ["malformed", "process.stdout.write('not a process table')"],
  ["oversized", "process.stdout.write('x'.repeat(300000))"],
  ["stalled", "setTimeout(()=>{},5000)"],
] as const) {
  test(`EPERM plus real ${name} observer preserves uncertainty without another group kill`, async (t) => {
    const fixture = track(t);
    substituteObserver(t, fixture, script);
    const kills = deniedObservation(t, fixture);
    const start = performance.now();
    await assert.rejects(port.run(process.execPath, ["-e", "setTimeout(()=>{},5000)"], 800), (error: unknown) => matches(error, /PROCESS_GROUP_INSPECTION_FAILED|PROCESS_CLEANUP_UNCONFIRMED/u));
    assert.ok(performance.now() - start < 800 + SCHEDULING_ALLOWANCE);
    assert.deepEqual(kills, [-fixture.children[0]!.pid!]);
    assert.ok(fixture.children.length > 1);
  });
}

test("a live or recycled PGID observation after EPERM never authorizes another kill", async (t) => {
  const fixture = track(t);
  const kills = deniedObservation(t, fixture);
  t.mock.method(childProcess, "execFile", (...args: unknown[]): ChildProcess => {
    const script = `process.stdout.write('${fixture.children[0]!.pid!} S\\n')`;
    const observer = Reflect.apply(realExecFile, childProcess, [process.execPath, ["-e", script], args[2], args[3]]) as ChildProcess;
    fixture.children.push(observer);
    return observer;
  });
  syncBuiltinESMExports();
  await assert.rejects(port.run(process.execPath, ["-e", "setTimeout(()=>{},5000)"], 800), (error: unknown) => matches(error, /PROCESS_CLEANUP_UNCONFIRMED|PROCESS_GROUP_INSPECTION_FAILED/u));
  assert.deepEqual(kills, [-fixture.children[0]!.pid!]);
});

test("non-EPERM observer syscall failures remain explicit failures", async (t) => {
  const fixture = track(t);
  deniedObservation(t, fixture, "EINVAL");
  await assert.rejects(port.run(process.execPath, ["-e", "setTimeout(()=>{},5000)"], 800), (error: unknown) => matches(error, /PROCESS_GROUP_INSPECTION_FAILED/u));
});

test("failed process finalization retains complete captured stdout for acquisition custody", async (t) => {
  track(t);
  t.mock.method(process, "kill", (pid: number, signal?: string | number): true => {
    if (pid < 0 && signal === "SIGKILL") { throw Object.assign(new Error("synthetic actual group-kill denial"), {code: "EPERM"}); }
    return realKill(pid, signal);
  });
  const id = "e".repeat(64);
  await assert.rejects(port.run(process.execPath, ["-e", `process.stdout.write('${id}\\n')`], 2_000), (error: unknown) => {
    assert.ok(error instanceof ProcessFailure);
    assert.equal(error.result.stdout, `${id}\n`);
    assert.equal(error.stdoutComplete, true);
    assert.ok(matches(error, /PROCESS_GROUP_KILL_FAILED/u));
    return true;
  });
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

test("stdout read failure cannot turn a captured ID prefix into complete acquisition authority", async (t) => {
  const fixture = track(t, (child) => {
    child.once("spawn", () => {child.stdout!.once("data", () => {child.stdout!.emit("error", new Error("synthetic stdout read failure"));});});
  });
  await assert.rejects(port.run(process.execPath, ["-e", `process.stdout.write('${"e".repeat(64)}\\n');setTimeout(()=>{},5000)`], 2_000), (error: unknown) => {
    assert.ok(error instanceof ProcessFailure);
    assert.equal(error.stdoutComplete, false);
    return true;
  });
  await waitForQuiet(fixture);
});

test("complete stdout remains container-ID authority even when direct-child reap is unconfirmed", async (t) => {
  track(t, (child) => {t.mock.method(child, "kill", () => false);});
  t.mock.method(process, "kill", (pid: number, signal?: string | number): true => {
    if (pid < 0 && signal === "SIGKILL") {throw Object.assign(new Error("synthetic kill denial"), {code: "EPERM"});}
    return realKill(pid, signal);
  });
  const id = "f".repeat(64);
  await assert.rejects(port.run(process.execPath, ["-e", `process.stdout.end('${id}\\n');setTimeout(()=>{},5000)`], 800), (error: unknown) => {
    assert.ok(error instanceof ProcessFailure);
    assert.equal(error.result.stdout, `${id}\n`);
    assert.equal(error.stdoutComplete, true);
    assert.ok(matches(error, /PROCESS_CLEANUP_UNCONFIRMED/u));
    return true;
  });
});
