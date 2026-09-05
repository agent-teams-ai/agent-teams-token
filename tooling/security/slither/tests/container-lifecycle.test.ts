import assert from "node:assert/strict";
import fs, { chmod, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { getEventListeners } from "node:events";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createContainerRunner } from "../src/adapters/container-runtime.ts";
import type { ProcessOptions, ProcessPort, ProcessResult } from "../src/application/ports.ts";
import { ProcessFailure, SlitherCancellation } from "../src/application/cancellation.ts";
import { OwnedProcess } from "../src/adapters/process.ts";
import { assertContainerResult } from "../src/adapters/container-result.ts";
import { AUTHORIZE_ANALYSIS } from "../src/adapters/container-contract.ts";
import { COMPLETION_READER, exportArguments } from "../src/adapters/container-export.ts";
import { makeTestDirectory } from "./test-directory.ts";
// Only descriptor path access is a fixture; the Linux adapter has dedicated
// syscall tests. Scripted cgroups do not claim Darwin container support.
const fixtureDirectoryPath = (_fd: number, directory: string): string => directory;
const runContainerById = createContainerRunner(fixtureDirectoryPath);
const result = (stdout = "", overrides: Partial<ProcessResult> = {}): ProcessResult => ({exitCode: 0, stdout, stderr: "", timedOut: false, ...overrides});


test("a timed-out create with a validated immutable ID is removed by exact ID", async () => {
  const id = "a".repeat(64); const calls: string[][] = [];
  const port: ProcessPort = {run: async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "info") {return result(`${JSON.stringify({CgroupDriver: "systemd", CgroupVersion: "2"})}\n`);}
    if (args[0] === "create") {return result(`${id}\n`, {exitCode: null, timedOut: true});}
    if (args[0] === "container") {return result(`${JSON.stringify({Id: id, State: {Running: false}})}\n`);}
    if (args[0] === "rm") {return result(`${id}\n`);}
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }};
  await assert.rejects(
    runContainerById(port, "/usr/bin/docker", ["create"], "/tmp/not-used", []),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CONTAINER_ID_INVALID",
  );
  assert.deepEqual(calls.at(-1), ["rm", "--force", id]);
});

test("container lifecycle rejects inexact configured cgroup limits before delegation", async () => {
  const id = "b".repeat(64);
  const calls: string[][] = [];
  const port: ProcessPort = {run: async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "info") {return result(`${JSON.stringify({CgroupDriver: "systemd", CgroupVersion: "2"})}\n`);}
    if (args[0] === "create") {return result(`${id}\n`);}
    if (args[0] === "start") {return result(`${id}\n`);}
    if (args[0] === "container") {return result(`${JSON.stringify({Id: id, State: {Running: true, Paused: false, Pid: 2}, HostConfig: {PidsLimit: 127, Memory: 2147483648, MemorySwap: 2147483648, NanoCpus: 2000000000}})}\n`);}
    if (args[0] === "rm") {return result(`${id}\n`);}
    throw new Error(`unexpected command: ${args.join(" ")}`);
  }};
  await assert.rejects(
    runContainerById(port, "/usr/bin/docker", ["create"], "/tmp/not-used", []),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CGROUP_RUNTIME_UNPROVEN",
  );
  assert.deepEqual(calls.at(-1), ["rm", "--force", id]);
  assert.equal(calls.some((args) => args[0] === "exec"), false);
});


const lifecycleId = "c".repeat(64);
const leaf = `/sys/fs/cgroup/system.slice/docker-${lifecycleId}.scope`;
const parent = "/sys/fs/cgroup/system.slice";

// Only cgroup reads and Docker responses are scripted. Output decoding,
// exclusive writes, authentication and failure classification are real.
function scriptCgroup(t: TestContext): string[] {
  const reads: string[] = [];
  const originalRead = fs.readFile;
  const originalLink = fs.readlink;
  const originalStat = fs.lstat;
  const files: Record<string, string> = {
    "/proc/2/cgroup": `0::/system.slice/docker-${lifecycleId}.scope\n`,
    [`${parent}/cgroup.controllers`]: "cpu memory pids\n",
    [`${parent}/cgroup.subtree_control`]: "cpu memory pids\n",
    [`${leaf}/pids.max`]: "128\n", [`${leaf}/memory.max`]: "2147483648\n", [`${leaf}/cpu.max`]: "200000 100000\n",
  };
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const path = String(args[0]);
    if (path in files) {reads.push(path); return files[path];}
    return await originalRead(...args);
  });
  t.mock.method(fs, "readlink", async (...args: Parameters<typeof fs.readlink>) => {
    if (String(args[0]) === "/proc/self/ns/pid") {return "pid:[1]";}
    if (String(args[0]) === "/proc/2/ns/pid") {return "pid:[2]";}
    return await originalLink(...args);
  });
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if ([leaf, parent].includes(String(args[0]))) {return {dev: 1n, ino: String(args[0]) === leaf ? 2n : 3n, isDirectory: (): boolean => true, isSymbolicLink: (): boolean => false};}
    return await originalStat(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  return reads;
}

interface LifecycleOptions {
  readonly completion?: ProcessResult;
  readonly output?: Readonly<Record<string, string>>;
  readonly exported?: ProcessResult;
  readonly fault?: "export-throw" | "crash" | "paused" | "pid-change" | "inspect" | "remove" | "remove-timeout" | "remove-throw" | "remove-identity" | "authorize" | "start";
  readonly before?: (args: readonly string[]) => void | Promise<void>;
  readonly signal?: AbortSignal;
  readonly transport?: (args: readonly string[], result: ProcessResult, timeout: number, options?: ProcessOptions) => Promise<ProcessResult>;
}

function removal(fault: LifecycleOptions["fault"]): ProcessResult {
  if (fault === "remove-throw") {throw new Error("scripted removal exception");}
  if (fault === "remove") {return result("", {exitCode: 1});}
  if (fault === "remove-timeout") {return result(`${lifecycleId}\n`, {timedOut: true});}
  if (fault === "remove-identity") {return result("wrong identity\n");}
  return result(`${lifecycleId}\n`);
}

function frame(files: Readonly<Record<string, string>>): string {
  return `SLITHER_EXPORT_V1\n${JSON.stringify(Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, Buffer.byteLength(bytes), Buffer.from(bytes).toString("base64")]))}\nSLITHER_EXPORT_END\n`;
}

async function lifecycle(t: TestContext, options: LifecycleOptions = {}) {
  const cgroupReads = scriptCgroup(t);
  const output = await makeTestDirectory("lifecycle-");
  t.after(async () => {await rm(output, {recursive: true, force: true});});
  const calls: {args: readonly string[]; timeout: number}[] = [];
  let started = false; let authorized = false; let completed = false;
  const execute = (args: readonly string[]): ProcessResult => {
    if (args[2] === "/bin/bash") {
      assert.equal(cgroupReads.length, 6, "live cgroup proof must precede authorization");
      assert.deepEqual(args, ["exec", lifecycleId, "/bin/bash", "-ceu", AUTHORIZE_ANALYSIS]);
      authorized = true; return options.fault === "authorize" ? result("", {exitCode: 1}) : result();
    }
    assert.ok(authorized);
    if (args[6] === COMPLETION_READER) {
      assert.deepEqual(args, ["exec", lifecycleId, "/usr/bin/python3", "-I", "-S", "-c", COMPLETION_READER]);
      completed = true; return options.completion ?? result("SLITHER_COMPLETED_V1 0\n");
    }
    assert.ok(completed);
    const exact = !options.completion || options.completion.stdout === "SLITHER_COMPLETED_V1 0\n";
    assert.deepEqual(args, exportArguments(lifecycleId, exact ? ["slither.exit"] : ["slither.exit", "failure.stage"], exact));
    if (options.fault === "export-throw") {throw new Error("scripted export exception");}
    return options.exported ?? result(frame(options.output ?? {"slither.exit": "0\n"}));
  };
  const scripted: ProcessPort = {run: async (command, args, timeout) => {
    assert.equal(command, "/usr/bin/docker");
    assert.ok(timeout > 0 && timeout <= 600_000);
    calls.push({args: [...args], timeout});
    await options.before?.(args);
    if (args[0] === "info") {return result(JSON.stringify({CgroupDriver: "systemd", CgroupVersion: "2"}));}
    if (args[0] === "create") {return result(`${lifecycleId}\n`);}
    if (args[0] === "rm") {assert.deepEqual(args, ["rm", "--force", lifecycleId]); return removal(options.fault);}
    if (args[0] === "container") {
      assert.deepEqual(args, ["container", "inspect", lifecycleId, "--format", "{{json .}}"]);
      if (options.fault === "inspect") {return result("", {exitCode: 1});}
      return result(JSON.stringify({Id: lifecycleId, State: {Running: started && !(completed && options.fault === "crash"), Paused: completed && options.fault === "paused", Pid: completed && options.fault === "pid-change" ? 3 : 2}, HostConfig: {PidsLimit: 128, Memory: 2147483648, MemorySwap: 2147483648, NanoCpus: 2000000000}}));
    }
    assert.equal(args[1], lifecycleId);
    if (args[0] === "start") {started = true; return options.fault === "start" ? result("", {exitCode: 1}) : result(`${lifecycleId}\n`);}
    if (args[0] === "exec") {return execute(args);}
    throw new Error(`unexpected lifecycle command: ${args.join(" ")}`);
  }};
  const port: ProcessPort = {signal: options.signal, run: async (command, args, timeout, processOptions) => {
    const response = await scripted.run(command, args, timeout, processOptions);
    return options.transport ? await options.transport(args, response, timeout, processOptions) : response;
  }};
  return {output, calls, run: async () => await runContainerById(port, "/usr/bin/docker", ["create"], output, ["slither.exit"])};
}

const codeIs = (code: string) => (error: unknown): boolean => error instanceof Error && "code" in error && error.code === code;
const isExport = (args: readonly string[]): boolean => args[0] === "exec" && args.length === 9;

test("public lifecycle exports retained live tmpfs output and reaps only its immutable ID", async (t) => {
  const run = await lifecycle(t);
  assert.deepEqual(await run.run(), {timedOut: false, exitCode: 0});
  assert.equal(await readFile(join(run.output, "slither.exit"), "utf8"), "0\n");
  assert.deepEqual(run.calls.map(({args}) => args[0]), ["info", "create", "container", "start", "container", "exec", "exec", "container", "exec", "container", "rm"]);
});

for (const [stage, code] of [
  ["compiler-build", "COMPILER_BUILD_FAILED"], ["analysis-runtime", "ANALYZER_RUNTIME_FAILED"], ["detector-inventory", "DETECTOR_INVENTORY_INVALID"],
  ["artifact-validation", "ARTIFACT_EXPORT_FAILED"], ["version-inventory", "TOOL_VERSION_MISMATCH"], ["manifest-validation", "TARGET_MANIFEST_INVALID"], ["container-execution", "CONTAINER_FAILED"],
]) {
  test(`failed ${stage} output survives transport with its exit and classification`, async (t) => {
    const run = await lifecycle(t, {completion: result("SLITHER_COMPLETED_V1 42\n"), output: {"failure.stage": `${stage}\n`}});
    const completed = await run.run();
    assert.deepEqual(completed, {timedOut: false, exitCode: 42});
    await assert.rejects(assertContainerResult(completed, run.output), codeIs(code!));
  });
}

test("transport completion preserves Slither policy findings", async (t) => {
  const run = await lifecycle(t, {output: {"slither.exit": "255\n"}});
  assert.deepEqual(await run.run(), {timedOut: false, exitCode: 0});
  assert.equal(await readFile(join(run.output, "slither.exit"), "utf8"), "255\n");
});

for (const stdout of ["", "0\n", "READY\n", "SLITHER_COMPLETED_V1 00\n", "SLITHER_COMPLETED_V1 -1\n", "SLITHER_COMPLETED_V1 256\n", "SLITHER_COMPLETED_V1 999\n", "SLITHER_COMPLETED_V1 0", "SLITHER_COMPLETED_V1 0\nextra", "SLITHER_COMPLETED_V1 0\nSLITHER_COMPLETED_V1 0\n"]) {
  test(`malformed or missing completion ${JSON.stringify(stdout)} cannot authorize export`, async (t) => {
    const run = await lifecycle(t, {completion: result(stdout)});
    await assert.rejects(run.run(), codeIs("CONTAINER_FAILED"));
    assert.equal(run.calls.some(({args}) => isExport(args)), false);
    assert.equal(run.calls.at(-1)?.args[0], "rm");
  });
}

for (const completion of [result("SLITHER_COMPLETED_V1 0\n", {exitCode: 1}), result("SLITHER_COMPLETED_V1 0\n", {timedOut: true}), result("SLITHER_COMPLETED_V1 0\n", {stderr: "unexpected"})]) {
  test(`failed completion exec (${completion.exitCode}, timeout ${completion.timedOut}, stderr ${completion.stderr}) fails closed`, async (t) => {
    const run = await lifecycle(t, {completion});
    await assert.rejects(run.run(), codeIs(completion.timedOut ? "CONTAINER_TIMEOUT" : "CONTAINER_FAILED"));
    assert.equal(run.calls.some(({args}) => isExport(args)), false);
    assert.equal(run.calls.at(-1)?.args[0], "rm");
  });
}

for (const fault of ["export-throw", "crash", "paused", "pid-change", "inspect", "remove", "remove-timeout", "remove-throw", "remove-identity", "authorize", "start"] as const) {
  test(`${fault} failure cannot return success or skip exact-ID cleanup`, async (t) => {
    const run = await lifecycle(t, {fault});
    const codes: Record<string, string> = {"export-throw": "", "crash": "CONTAINER_ID_INVALID", "inspect": "CONTAINER_ID_INVALID", "start": "CONTAINER_ID_INVALID", "authorize": "CGROUP_RUNTIME_UNPROVEN", "paused": "ARTIFACT_EXPORT_FAILED", "pid-change": "ARTIFACT_EXPORT_FAILED"};
    await assert.rejects(run.run(), codeIs(fault === "export-throw" ? "ARTIFACT_EXPORT_FAILED" : codes[fault] ?? "CONTAINER_FAILED"));
    assert.equal(run.calls.at(-1)?.args[0], "rm");
  });
}

for (const exported of [result("", {exitCode: 1}), result("", {timedOut: true}), result(frame({"slither.exit": "0\n"}), {stderr: "untrusted diagnostic"}), result("SLITHER_EXPORT_V1\n[["), result(frame({"slither.exit": "0\n"}) + "extra")]) {
  test(`failed or malformed export (${JSON.stringify(exported)}) cannot return success`, async (t) => {
    const run = await lifecycle(t, {exported});
    await assert.rejects(run.run(), codeIs("ARTIFACT_EXPORT_FAILED"));
    assert.equal(run.calls.at(-1)?.args[0], "rm");
  });
}

test("cleanup failure retains the original failure as well as its own cause", async (t) => {
  const run = await lifecycle(t, {completion: result("bad completion"), fault: "remove"});
  await assert.rejects(run.run(), (error: unknown) => {
    assert.ok(error instanceof Error && error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.length, 2);
    assert.match(error.cause.errors[0].message, /completion is missing or malformed/u);
    assert.match(error.cause.errors[1].message, /removal did not complete/u);
    return true;
  });
});

test("cleanup failure includes a transported nonzero analysis exit", async (t) => {
  const run = await lifecycle(t, {completion: result("SLITHER_COMPLETED_V1 255\n"), output: {"failure.stage": "analysis-runtime\n"}, fault: "remove"});
  await assert.rejects(run.run(), /cleanup is unconfirmed after analysis exit 255/u);
  assert.equal(await readFile(join(run.output, "failure.stage"), "utf8"), "analysis-runtime\n");
});

const invalidOutputs: readonly Record<string, string>[] = [{}, {"slither.exit": "0\n", "gate-completion": "SLITHER_COMPLETED_V1 0\n"}, {"failure.stage": "compiler-build\n"}];
for (const output of invalidOutputs) {
  test("empty, partial-success or extra output is rejected before success", async (t) => {
    const run = await lifecycle(t, {output});
    await assert.rejects(run.run(), codeIs("ARTIFACT_EXPORT_FAILED"));
    assert.equal(run.calls.at(-1)?.args[0], "rm");
  });
}

test("completion exhaustion leaves only the reserved reap interval", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const run = await lifecycle(t, {before: (args) => {now += args[6] === COMPLETION_READER ? 565_000 : 1_000;}});
  await assert.rejects(run.run(), codeIs("CONTAINER_TIMEOUT"));
  assert.equal(run.calls.at(-2)?.timeout, 564_000);
  assert.equal(run.calls.at(-1)?.timeout, 29_000);
  assert.equal(run.calls.at(-1)?.args[0], "rm");
  assert.equal(run.calls.some(({args}) => isExport(args)), false);
});

for (const late of [30_001, 570_000]) {
  test(`late export (${late} ms) cannot return success and still has bounded cleanup`, async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const run = await lifecycle(t, {before: (args) => {if (isExport(args)) {now = late;}}});
    await assert.rejects(run.run(), codeIs("ARTIFACT_EXPORT_FAILED"));
    assert.equal(run.calls.at(-1)?.timeout, 30_000);
    assert.equal(run.calls.at(-1)?.args[0], "rm");
  });
}

test("cleanup returning after the absolute deadline cannot accept a successful transfer", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const run = await lifecycle(t, {before: (args) => {if (args[0] === "rm") {now = 600_001;}}});
  await assert.rejects(run.run(), codeIs("CONTAINER_FAILED"));
});


test("unsafe host destination cannot skip exact-ID cleanup", async (t) => {
  const run = await lifecycle(t);
  await chmod(run.output, 0o755);
  await assert.rejects(run.run(), codeIs("ARTIFACT_EXPORT_FAILED"));
  assert.equal(run.calls.at(-1)?.args[0], "rm");
});

test("host authentication consumes the same deadline and retains the cleanup reserve", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const run = await lifecycle(t);
  const originalStat = fs.lstat;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const info = await originalStat(...args);
    if (String(args[0]) === run.output) {now = 570_001;}
    return info;
  });
  syncBuiltinESMExports();
  await assert.rejects(run.run(), codeIs("CONTAINER_TIMEOUT"));
  assert.equal(run.calls.at(-1)?.timeout, 29_999);
  assert.equal(run.calls.at(-1)?.args[0], "rm");
});

function includesFailure(error: unknown, expected: unknown): boolean {
  if (error === expected) { return true; }
  if (error instanceof AggregateError && error.errors.some((entry: unknown) => includesFailure(entry, expected))) { return true; }
  return error instanceof Error && error.cause !== undefined && includesFailure(error.cause, expected);
}

test("cancelled lifecycle starts no process and leaves no signal listeners", async (t) => {
  const controller = new AbortController(); const reason = new SlitherCancellation("SIGTERM");
  controller.abort(reason);
  const run = await lifecycle(t, {signal: controller.signal});
  await assert.rejects(run.run(), (error: unknown) => error === reason);
  assert.deepEqual(run.calls, []);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const point of ["create", "authorize", "completion", "export", "remove"] as const) {
  test(`real child cancellation during ${point} settles custody and performs exact-ID cleanup`, async (t) => {
    const controller = new AbortController(); const reason = new SlitherCancellation("SIGINT");
    const processPort = new OwnedProcess(controller.signal);
    let triggered = false;
    const run = await lifecycle(t, {signal: controller.signal, transport: async (args, response, timeout, options) => {
      const matches = point === "create" ? args[0] === "create" : point === "remove" ? args[0] === "rm" : point === "authorize" ? args[2] === "/bin/bash" : point === "completion" ? args[6] === COMPLETION_READER : isExport(args);
      if (args[0] === "rm") { assert.equal(options?.signal, null, "cleanup is independently runnable"); }
      if (!matches || triggered) { return response; }
      triggered = true;
      const timer = setTimeout(() => { controller.abort(reason); controller.abort(new SlitherCancellation("SIGTERM")); }, 100);
      try {
        // Real pipes and process reap. Acquisition deliberately returns its ID
        // after cancellation; work deliberately waits for adapter termination.
        const shielded = point === "create" || point === "remove";
        return await processPort.run(process.execPath, ["-e", `setTimeout(() => {process.stdout.write(${JSON.stringify(response.stdout)});}, ${shielded ? 200 : 4000});`], Math.min(timeout, 5_000), options);
      } finally { clearTimeout(timer); }
    }});
    const start = performance.now();
    await assert.rejects(run.run(), (error: unknown) => includesFailure(error, reason));
    assert.ok(performance.now() - start < 2_000);
    assert.equal(triggered, true);
    assert.deepEqual(run.calls.at(-1)?.args, ["rm", "--force", lifecycleId]);
    assert.equal(run.calls.filter(({args}) => args[0] === "rm").length, 1);
    if (point === "create") { assert.equal(run.calls.some(({args}) => args[0] === "start"), false); }
    if (point === "completion") { assert.equal(run.calls.some(({args}) => isExport(args)), false); }
    if (point !== "remove") { await assert.rejects(readFile(join(run.output, "slither.exit"))); }
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

for (const fault of ["remove", "remove-timeout", "remove-throw", "remove-identity"] as const) {
  test(`cancellation plus ${fault} retains the original interruption before cleanup failure`, async (t) => {
    const controller = new AbortController(); const reason = new SlitherCancellation("SIGTERM");
    const run = await lifecycle(t, {signal: controller.signal, fault, before: (args) => {if (args[6] === COMPLETION_READER) {controller.abort(reason);}}});
    await assert.rejects(run.run(), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof AggregateError);
      assert.equal(error.cause.errors[0], reason);
      assert.ok(error.cause.errors.length >= 2);
      return true;
    });
    assert.deepEqual(run.calls.at(-1)?.args, ["rm", "--force", lifecycleId]);
  });
}

test("cancellation with an invalid creation ID reports unknown ownership and never guesses a removal target", async (t) => {
  const controller = new AbortController(); const reason = new SlitherCancellation("SIGTERM");
  const run = await lifecycle(t, {signal: controller.signal, transport: async (args, response) => {
    if (args[0] === "create") {controller.abort(reason); return result("owned-name-not-an-id\n");}
    return response;
  }});
  await assert.rejects(run.run(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ownership is unknown/u);
    assert.ok(includesFailure(error, reason));
    return true;
  });
  assert.equal(run.calls.some(({args}) => args[0] === "rm" || args[0] === "start"), false);
});

for (const stdoutComplete of [true, false]) {
  test(`failed create with ${stdoutComplete ? "complete" : "incomplete"} captured output preserves exact-ID authority`, async (t) => {
    const controller = new AbortController(); const reason = new SlitherCancellation("SIGINT");
    const processFailure = new Error("synthetic observer finalization failure");
    const run = await lifecycle(t, {signal: controller.signal, transport: async (args, response) => {
      if (args[0] === "create") {controller.abort(reason); throw new ProcessFailure([processFailure], response, stdoutComplete);}
      return response;
    }});
    await assert.rejects(run.run(), (error: unknown) => includesFailure(error, reason) && includesFailure(error, processFailure));
    assert.equal(run.calls.some(({args}) => args[0] === "rm"), stdoutComplete);
    assert.equal(run.calls.some(({args}) => args[0] === "start"), false);
  });
}

test("cancellation does not renew an exhausted lifecycle cleanup deadline", async (t) => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const controller = new AbortController(); const reason = new SlitherCancellation("SIGTERM");
  const run = await lifecycle(t, {signal: controller.signal, before: (args) => {
    if (args[6] === COMPLETION_READER) { now = 599_000; controller.abort(reason); }
  }});
  await assert.rejects(run.run(), (error: unknown) => includesFailure(error, reason));
  assert.deepEqual(run.calls.at(-1), {args: ["rm", "--force", lifecycleId], timeout: 1_000});
});

test("production completion followed by cancellation cannot start the next container lifecycle", async (t) => {
  const controller = new AbortController(); const reason = new SlitherCancellation("SIGTERM");
  const run = await lifecycle(t, {signal: controller.signal});
  assert.deepEqual(await run.run(), {timedOut: false, exitCode: 0});
  const calls = run.calls.length;
  controller.abort(reason);
  await assert.rejects(run.run(), (error: unknown) => error === reason);
  assert.equal(run.calls.length, calls, "the fixture stage cannot even query the daemon");
});
