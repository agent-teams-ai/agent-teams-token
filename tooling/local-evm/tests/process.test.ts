import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { compileFunction } from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { LocalEvmError } from "../model.ts";
import { authenticateProcess, command, processStartIdentity, startOwnedAnvil } from "../process.ts";
import { pinnedFoundryBinaries } from "../toolchain.ts";
import { assertPayloadStopped, syntheticAnvil, waitForJson } from "./fixtures/synthetic-anvil.ts";
import { createProvisionalRunDirectory, createRunLease, reclaimStaleRuns, registerRunAnvil, } from "../run-lease.ts";

const execute = promisify(execFile); const repositoryRoot = await realpath(resolvePath(import.meta.dirname, "../../..")); const firstAddress = "0x7000000000000000000000000000000000000001"; const secondAddress = "0x7000000000000000000000000000000000000002";

test("Anvil startup failure is fail-closed and leaves no child behind", { timeout: 20_000 }, async (context) => {
  const fixture = await syntheticAnvil(context, "exit");
  await assert.rejects(fixture.start(firstAddress), /exited before listening/);
  const {pid} = await fixture.payload();
  assert.equal(processExists(pid), false);
});

test("a missing Anvil executable rejects through the owned-process API", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-anvil-missing-"));
  try {
    await assert.rejects(startOwnedAnvil(join(directory, "absent-anvil"), firstAddress), /ENOENT/);
  } finally {await rm(directory, { recursive: true, force: true });}
});

test("synchronous supervisor spawn failure disposes control with the pipe held open", {timeout: 10_000}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-supervisor-sync-spawn-")); const observer = join(directory, "observer.mjs"); const report = join(directory, "report.json");
  // Inject only at the inner spawn boundary. E2BIG comes from the real kernel;
  // the supervisor process itself starts with ordinary arguments/environment.
  await writeFile(observer, [
    `import childProcess from "node:child_process";`, `import {syncBuiltinESMExports} from "node:module";`, `import {writeFileSync} from "node:fs";`, `const original = childProcess.spawn;`,
    `const events = [[process.stdin, ["data", "end", "close", "error"]], [process.stdout, ["close", "error"]]];`,
    `const counts = () => events.flatMap(([stream, names]) => names.map(name => stream.listenerCount(name)));`, `const before = counts(); let code; let installed;`,
    `childProcess.spawn = (...args) => {`, `  installed = counts().map((count, index) => count - before[index]);`,
    `  try {return original(process.execPath, ["-e", "", "x".repeat(8 * 1024 * 1024)], {env: {}, stdio: "ignore"});}`, `  catch (error) {code = error.code; throw error;}`, `};`, `syncBuiltinESMExports();`,
    `process.once("beforeExit", () => writeFileSync(${JSON.stringify(report)}, JSON.stringify({code, installed, remaining: counts().map((count, index) => count - before[index]), flowing: process.stdin.readableFlowing})));`,
  ].join("\n"));
  const supervisor = spawn(process.execPath, ["--import", observer,
    fileURLToPath(new URL("../process.ts", import.meta.url)), "--supervise-anvil", process.execPath, firstAddress],
  {stdio: ["pipe", "pipe", "pipe"]});
  supervisor.stdin.on("error", () => {});
  let stderr = "";
  supervisor.stdout.resume();
  supervisor.stderr.on("data", (chunk: Buffer) => {stderr += chunk.toString();});
  let exited = false;
  const closed = new Promise<void>((resolve) => {supervisor.once("close", () => {exited = true; resolve();});});
  try {
    for (let i = 0; i < 250; i += 1) {if (exited) {break;} await delay(10);}
    assert.equal(supervisor.stdin.writableEnded, false, "parent must hold the control pipe open");
    context.diagnostic(`held control pipe; supervisor=${supervisor.pid}; exited=${exited}; stderr=${JSON.stringify(stderr)}`);
    assert.equal(exited, true, "synchronous spawn failure must settle without parent EOF"); assert.equal(supervisor.exitCode, 1); assert.match(stderr, /E2BIG/);
    assert.deepEqual(JSON.parse(await readFile(report, "utf8")), { code: "E2BIG", installed: [1, 1, 1, 1, 1, 1], remaining: [0, 0, 0, 0, 0, 0], flowing: false, });
  } finally {
    if (!exited) {supervisor.kill("SIGKILL");}
    await closed;
    await rm(directory, {recursive: true, force: true});
  }
});

for (const {boundary, cleanupFails} of [
  {boundary: "startup", cleanupFails: true}, {boundary: "startup", cleanupFails: false},
  {boundary: "identity", cleanupFails: true}, {boundary: "identity", cleanupFails: false},
  {boundary: "ready", cleanupFails: true}, {boundary: "ready", cleanupFails: false},
  {boundary: "terminal", cleanupFails: true},
  {boundary: "stop", cleanupFails: true}, {boundary: "stop", cleanupFails: false},
] as const) {
  test(`supervisor preserves ${boundary} outcome with cleanup ${cleanupFails ? "failure" : "success"} and settles startup`, {timeout: 3_000}, async (context) => {
    // Evaluate the exact private supervisor/control/listening functions with only
    // OS boundaries supplied. No production exports or fixture hooks are added.
    const source = await readFile(new URL("../process.ts", import.meta.url), "utf8");
    const functions = source.slice(source.indexOf("async function superviseAnvil("), source.indexOf("async function supervisorMessage("))
      + source.slice(source.indexOf("async function listeningUrl("), source.indexOf("async function stopExactChild("));
    const stdin = new PassThrough(); const stdout = new PassThrough(); const child = Object.assign(new EventEmitter(), {pid: 123, stdout: new PassThrough(), stderr: new PassThrough()});
    const primaryCause = new Error("primary cause"); const cleanupCause = new Error("cleanup cause"); const primary = new Error(`${boundary} failed`, {cause: primaryCause}); const cleanup = new Error("cleanup failed", {cause: cleanupCause});
    let stops = 0;
    const evaluate = compileFunction(`${stripTypeScriptTypes(functions)}\nreturn superviseAnvil;`,
      ["spawn", "process", "processStartIdentity", "stopExactChild", "LocalEvmError"]);
    const supervise = evaluate(() => child, {stdin, stdout, env: {}}, async () => "linux:123", async () => {
      stops += 1;
      // Failed cleanup supplies no close: pending startup must be cancelled.
      if (cleanupFails) {throw cleanup;}
      child.emit("close", 0);
    }, LocalEvmError) as (executable: string, address: string) => Promise<void>;
    const write = stdout.write.bind(stdout);
    stdout.write = ((chunk: string, callback: (error?: Error | null) => void): boolean => {
      const message = JSON.parse(chunk) as {type: string};
      if (message.type === boundary) {throw primary;}
      const result = write(chunk, callback);
      if (message.type === "identity") { queueMicrotask(() => { stdin.write("ack\n");
          if (boundary === "startup") {child.emit("error", primary);}
          if (boundary === "ready") {child.stdout.write("Listening on 127.0.0.1:8545\n");}
          if (boundary === "terminal") {stdin.emit("error", primary);}
          if (boundary === "stop") {stdin.write("stop\n");}
        });
      }
      return result;
    }) as typeof stdout.write;
    let deadline: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        supervise("synthetic", firstAddress).then(() => ({cause: undefined}), (cause: unknown) => ({cause})),
        new Promise<never>((_resolve, reject) => {deadline = setTimeout(() => reject(new Error("finalization did not settle within 500ms")), 500);}),
      ]);
      context.diagnostic(`observed=${result.cause instanceof Error ? result.cause.message : String(result.cause)}; cleanupFails=${cleanupFails}`);
      if (cleanupFails && boundary !== "stop") { assert(result.cause instanceof AggregateError);
        assert.deepEqual(result.cause.errors, [primary, cleanup]); assert.equal(result.cause.errors[0], primary); assert.equal(result.cause.errors[1], cleanup); assert.equal(result.cause.cause, primary);
      } else {assert.equal(result.cause, boundary === "stop" ? (cleanupFails ? cleanup : undefined) : primary);}
      assert.equal(primary.cause, primaryCause); assert.equal(cleanup.cause, cleanupCause); assert.equal(stops, 1); assert.equal(stdin.readableFlowing, false);
      for (const name of ["data", "end", "close", "error"]) {assert.equal(stdin.listenerCount(name), 0, `stdin ${name}`);}
      for (const name of ["close", "error"]) {assert.equal(stdout.listenerCount(name), 0, `stdout ${name}`);}
      assert.equal(child.stdout.listenerCount("data"), 0); assert.equal(child.listenerCount("error"), 0); assert.equal(child.listenerCount("close"), 0);
      context.diagnostic(`${boundary}: expected error identities retained; startup settled and all lifecycle listeners removed`);
    } finally {
      if (deadline) {clearTimeout(deadline);}
      // Bound red-run cleanup as well, without supplying close before assertions.
      child.emit("close", 1);
      stdin.destroy(); stdout.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  });
}

test("stopping one owned PID does not affect a neighbouring Anvil", { timeout: 60_000 }, async () => {
  const {anvil: anvilBinary} = pinnedFoundryBinaries(repositoryRoot); const first = await startOwnedAnvil(anvilBinary, firstAddress); const second = await startOwnedAnvil(anvilBinary, secondAddress);
  try {
    assert.notEqual(first.pid, second.pid); assert.equal(await chainId(first.rpcUrl), "0x7a69"); assert.equal(await chainId(second.rpcUrl), "0x7a69");
    await first.stop();
    assert.equal(processExists(first.pid), false); assert.equal(processExists(second.pid), true); assert.equal(await chainId(second.rpcUrl), "0x7a69");
  } finally {await first.stop(); await second.stop();}
  assert.equal(processExists(second.pid), false);
});

test("Anvil account and mnemonic output is never returned by the owned-process API", { timeout: 20_000 }, async () => {
  const {anvil: anvilBinary} = pinnedFoundryBinaries(repositoryRoot); const anvil = await startOwnedAnvil(anvilBinary, firstAddress);
  try {
    assert.deepEqual(Object.keys(anvil).toSorted(), ["pid", "rpcUrl", "stop"]); assert.match(anvil.rpcUrl, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/$/);
    assert.equal(JSON.stringify(anvil).includes("private"), false); assert.equal(JSON.stringify(anvil).includes("mnemonic"), false);
  } finally { await anvil.stop(); }
});

test("concurrent stop callers share cleanup through forced termination", { timeout: 20_000 }, async (context) => {
  const fixture = await syntheticAnvil(context, "stubborn"); const anvil = await fixture.start(firstAddress); const payload = await fixture.payload();
  assert.equal(anvil.pid, payload.pid, "the owned PID must be the actual Node payload");
  const beforeStop = performance.now(); const first = anvil.stop(); const second = anvil.stop();
  assert.equal(first, second); assert.deepEqual(await waitForJson(fixture.signalPath), {pid: payload.pid}); assert.equal(processExists(payload.pid), true, "the payload must really ignore SIGTERM");
  await Promise.all([first, second]);
  assert(performance.now() - beforeStop >= 5_000, "forced termination must wait for the SIGTERM grace period");
  assert.equal(processExists(anvil.pid), false); assert.equal(processExists(payload.pid), false);
});

test("control-channel EOF before registration acknowledgement terminates Anvil", {timeout: 20_000}, async (context) => {
  const fixture = await syntheticAnvil(context); const {directory, executable} = fixture; const identityPath = join(directory, "identity.json");
  const runner = await fixture.runner([
    `import {writeFile} from "node:fs/promises";`, `import {startOwnedAnvil} from ${JSON.stringify(new URL("../process.ts", import.meta.url).href)};`,
    `await startOwnedAnvil(${JSON.stringify(executable)}, ${JSON.stringify(firstAddress)}, async (identity) => {`, `  await writeFile(${JSON.stringify(identityPath)}, JSON.stringify(identity));`, `  await new Promise(() => {});`, `});`,
  ].join("\n"));
  const identity = await waitForJson<{pid: number; processStart: string}>(identityPath); const payload = await fixture.payload();
  assert.equal(identity.pid, payload.pid, "registration must identify the actual Node payload"); assert.equal(await authenticateProcess(identity), "owned");
  await runner.kill();
  await assertPayloadStopped(payload.pid);
  assert.notEqual(await authenticateProcess(identity), "owned");
});

for (const outputMode of ["file", "pipe"] as const) {
  test(`control-channel EOF after ack during delayed startup reaps Anvil (${outputMode})`, {timeout: 20_000}, async (context) => {
    const fixture = await syntheticAnvil(context, "delayed"); const ackPath = join(fixture.directory, "ack.json"); const eofPath = join(fixture.directory, "eof.json");
    const exitPath = join(fixture.directory, "exit.json"); const identityPath = join(fixture.directory, "supervisor.json"); const outputPath = join(fixture.directory, "supervisor-output.jsonl"); const observer = join(fixture.directory, "observe-control.mjs");
    // Observe actual ack handling and EOF, with startup held by a file barrier.
    // File output isolates EOF; piped output also disappears with the killed parent.
    // The observer never reads, resumes, pauses or writes the control stream.
    await writeFile(observer, [
      `import {writeFileSync} from "node:fs";`, `process.stdin.on("data", (chunk) => {if (String(chunk) === "ack\\n") {`, `  setImmediate(() => writeFileSync(${JSON.stringify(ackPath)}, "{}"));`,
      `}});`, `process.stdin.once("end", () => writeFileSync(${JSON.stringify(eofPath)}, "{}"));`, `process.once("exit", (code) => writeFileSync(${JSON.stringify(exitPath)}, JSON.stringify({code})));`,
    ].join("\n"));
    const runner = await fixture.runner([
      `import {spawn} from "node:child_process";`, `import {closeSync, openSync, readFileSync, writeFileSync, writeSync} from "node:fs";`,
      `const output = openSync(${JSON.stringify(outputPath)}, "wx", 0o600);`, `const child = spawn(process.execPath, ["--import", ${JSON.stringify(observer)},`,
      `  ${JSON.stringify(fileURLToPath(new URL("../process.ts", import.meta.url)))},`, `  "--supervise-anvil", ${JSON.stringify(fixture.executable)}, ${JSON.stringify(firstAddress)}],`,
      `  {stdio: ["pipe", ${outputMode === "pipe" ? '"pipe"' : "output"}, "ignore"]});`,
      outputMode === "pipe" ? `child.stdout.on("data", (chunk) => writeSync(output, chunk));` : `closeSync(output);`,
      `const timer = setInterval(() => {`, `  const line = readFileSync(${JSON.stringify(outputPath)}, "utf8").split("\\n")[0];`, `  if (line) {`, `    const message = JSON.parse(line);`,
      `    if (message.type === "identity") {`, `      writeFileSync(${JSON.stringify(identityPath)}, JSON.stringify({parentPid: process.pid, supervisorPid: child.pid, ...message}));`,
      `      child.stdin.write("ack\\n");`, `      clearInterval(timer);`, `    }`, `  }`, `}, 10);`,
    ].join("\n"));
    const identity = await waitForJson<{parentPid: number; supervisorPid: number; pid: number; processStart: string}>(identityPath); const payload = await fixture.payload();
    assert.equal(identity.pid, payload.pid);
    const supervisorIdentity = {pid: identity.supervisorPid, processStart: await processStartIdentity(identity.supervisorPid)};
    let supervisorExited = false;
    try {
      await waitForJson(ackPath);
      assert.equal((await readFile(outputPath, "utf8")).includes('"type":"ready"'), false);
      await runner.kill();
      assert.equal(processExists(identity.parentPid), false);
      await waitForJson(eofPath);
      context.diagnostic(`ack handled; parent ${identity.parentPid} SIGKILL completed; EOF observed before startup release; supervisor=${identity.supervisorPid}, payload=${payload.pid}`);
      await fixture.releaseStartup();
      await assertPayloadStopped(payload.pid);
      const exit = await waitForJson(exitPath);
      supervisorExited = true;
      assert.deepEqual(exit, {code: 0}); assert.equal((await readFile(outputPath, "utf8")).includes('"type":"ready"'), false);
      context.diagnostic(`owned payload ${payload.pid} reaped; supervisor ${identity.supervisorPid} exited 0`);
    } finally {
      if (await authenticateProcess(identity) === "owned") { process.kill(payload.pid, "SIGTERM");
        await assertPayloadStopped(payload.pid);
        context.diagnostic(`failure cleanup: exact owned payload ${payload.pid} terminated and reaped`);
      }
      // The supervisor owns the child reaper; terminate it only after the child is gone.
      if (!supervisorExited && await authenticateProcess(supervisorIdentity) === "owned") { await signalSupervisor(identity.supervisorPid);
        context.diagnostic(`cleanup: signaled only authenticated supervisor ${identity.supervisorPid} after child reaping`);
      }
    }
  });
}

for (const boundary of ["identity pipe", "ready pipe", "ack EOF", "coalesced ack EOF", "coalesced stop", "stdin error"] as const) {
  test(`supervisor terminal channel during startup: ${boundary}`, {timeout: 20_000}, async (context) => {
    const fixture = await syntheticAnvil(context, "delayed"); const neighbourFixture = await syntheticAnvil(context); const neighbour = await neighbourFixture.start(secondAddress);
    const gate = join(fixture.directory, "observer-release.json"); const ack = join(fixture.directory, "observed-ack.json"); const uncaught = join(fixture.directory, "uncaught.json"); const observer = join(fixture.directory, "terminal-observer.mjs");
    // Keep a broken baseline alive only to reap its exact child after assertion failure.
    // This does not handle stream errors or alter the production control reader.
    await writeFile(observer, [
      `import {existsSync, writeFileSync} from "node:fs";`,
      // Hold the first real write until the payload can be identified for red cleanup.
      boundary === "identity pipe" ? `const write = process.stdout.write.bind(process.stdout); process.stdout.write = (...args) => {const timer = setInterval(() => {if (existsSync(${JSON.stringify(join(fixture.directory, "identity-write-release.json"))})) {clearInterval(timer); write(...args);}}, 10); return true;};` : "",
      `process.setUncaughtExceptionCaptureCallback((error) => writeFileSync(${JSON.stringify(uncaught)}, JSON.stringify({message:error.message})));`, `process.stdin.on("data", () => setImmediate(() => {`, `  writeFileSync(${JSON.stringify(ack)}, "{}");`,
      boundary === "stdin error" ? `  process.stdin.emit("error", new Error("synthetic control failure"));` : "",
      `}));`, `await new Promise((resolve) => {const timer = setInterval(() => {if (existsSync(${JSON.stringify(gate)})) {clearInterval(timer); resolve();}}, 10);});`,
    ].join("\n"));
    const supervisor = spawn(process.execPath, ["--import", observer,
      fileURLToPath(new URL("../process.ts", import.meta.url)), "--supervise-anvil", fixture.executable, firstAddress],
    {stdio: ["pipe", "pipe", "pipe"]});
    supervisor.stdin.on("error", () => {});
    let output = "";
    let stderr = "";
    supervisor.stdout.on("data", (chunk: Buffer) => {output += chunk.toString();});
    supervisor.stderr.on("data", (chunk: Buffer) => {stderr += chunk.toString();});
    let exited = false;
    const closed = new Promise<void>((resolve) => {supervisor.once("close", () => {exited = true; resolve();});});
    let identity: {pid: number; processStart: string} | undefined;
    try {
      if (boundary === "identity pipe") { const outputClosed = new Promise<void>((resolve) => {supervisor.stdout.once("close", resolve);});
        supervisor.stdout.destroy();
        await outputClosed;
      }
      await writeFile(gate, "{}");
      const payload = await fixture.payload();
      identity = {pid: payload.pid, processStart: await processStartIdentity(payload.pid)};
      if (boundary === "identity pipe") {await writeFile(join(fixture.directory, "identity-write-release.json"), "{}");}
      if (boundary !== "identity pipe") { for (let i = 0; i < 200 && !output.includes("\n"); i += 1) {await delay(10);} assert.equal(JSON.parse(output.split("\n")[0]!).pid, payload.pid);
        if (boundary === "coalesced ack EOF") {supervisor.stdin.end("ack\n");}
        else if (boundary === "coalesced stop") {supervisor.stdin.write("ack\nstop\n");}
        else {
          supervisor.stdin.write("ack\n");
          await waitForJson(ack);
          if (boundary === "ack EOF") {supervisor.stdin.end();}
          if (boundary === "ready pipe") { const outputClosed = new Promise<void>((resolve) => {supervisor.stdout.once("close", resolve);});
            supervisor.stdout.destroy();
            await outputClosed;
            await fixture.releaseStartup();
          }
        }
      }
      // EOF/stop/error must cancel the held startup, without waiting for its 10s timeout.
      for (let i = 0; i < 250; i += 1) {if (exited) {break;} await delay(10);}
      if (!exited) { const captured = await readFile(uncaught, "utf8").catch(() => "none");
        context.diagnostic(`${boundary}: supervisor=${supervisor.pid} still running; payload=${payload.pid}; captured uncaught=${captured}; stderr=${JSON.stringify(stderr)}`);
      }
      assert.equal(exited, true, `${boundary}: supervisor must exit while startup is held`); assert.equal(processExists(payload.pid), false, "owned payload must already be reaped at supervisor exit");
      await assert.rejects(readFile(uncaught), {code: "ENOENT"});
      if (boundary.includes("pipe")) {assert.match(stderr, /EPIPE|broken pipe/i); assert.equal(supervisor.exitCode, 1);}
      else if (boundary === "stdin error") {assert.match(stderr, /synthetic control failure/); assert.equal(supervisor.exitCode, 1);}
      else {assert.equal(stderr, ""); assert.equal(supervisor.exitCode, 0);}
      assert.equal(processExists(neighbour.pid), true);
      context.diagnostic(`${boundary}: supervisor=${supervisor.pid} exit=${supervisor.exitCode}; payload=${payload.pid} reaped; neighbour=${neighbour.pid} alive; stderr=${JSON.stringify(stderr)}`);
    } finally {
      if (identity && await authenticateProcess(identity) === "owned") { process.kill(identity.pid, "SIGTERM");
        await assertPayloadStopped(identity.pid);
        context.diagnostic(`failure cleanup: exact payload ${identity.pid} reaped by supervisor ${supervisor.pid}`);
      }
      if (!exited) {supervisor.kill("SIGKILL");}
      await closed;
      await neighbour.stop();
    }
  });
}

test("synthetic Anvil startup timeout reaps the actual payload", {timeout: 20_000}, async (context) => {
  const fixture = await syntheticAnvil(context, "silent");
  await assert.rejects(fixture.start(firstAddress), /did not publish its private listening address/);
  const payload = await fixture.payload();
  assert.equal(processExists(payload.pid), false);
});

test("oversized control input is rejected before acknowledgement", {timeout: 20_000}, async (context) => {
  const fixture = await syntheticAnvil(context);
  const result = await command(process.execPath, [
    fileURLToPath(new URL("../process.ts", import.meta.url)),
    "--supervise-anvil", fixture.executable, firstAddress,
  ], {stdin: `${" ".repeat(4097)}ack\n`, timeoutMs: 15_000});
  assert.equal(result.exitCode, 0); assert.equal(result.stderr, "");
  const messages = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as {type: string; pid: number});
  assert.deepEqual(messages.map((message) => message.type), ["identity"]); assert.equal(processExists(messages[0]!.pid), false);
});

test("synthetic Anvil registration failure reaps the actual payload", {timeout: 20_000}, async (context) => {
  const fixture = await syntheticAnvil(context); const failure = new Error("registration rejected");
  await assert.rejects(fixture.start(firstAddress, async (identity) => {
    assert.equal(identity.pid, (await fixture.payload()).pid);
    throw failure;
  }), (cause: unknown) => cause === failure);
  assert.equal(processExists((await fixture.payload()).pid), false);
});

test("synthetic forced termination preserves a neighbouring payload", {timeout: 20_000}, async (context) => {
  const fixture = await syntheticAnvil(context, "stubborn"); const neighbourFixture = await syntheticAnvil(context); const anvil = await fixture.start(firstAddress); const neighbour = await neighbourFixture.start(secondAddress);
  assert.equal(anvil.pid, (await fixture.payload()).pid); assert.equal(neighbour.pid, (await neighbourFixture.payload()).pid); assert.notEqual(anvil.pid, neighbour.pid);
  const identity = {pid: neighbour.pid, processStart: await processStartIdentity(neighbour.pid)};
  await anvil.stop();
  assert.equal(processExists(anvil.pid), false); assert.equal(processExists(neighbour.pid), true); assert.equal(await authenticateProcess(identity), "owned");
  await neighbour.stop();
  assert.equal(processExists(neighbour.pid), false);
});

test("stale-run recovery fails closed instead of signaling a process from a stale identity read", { timeout: 20_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-reclaim-")));
  // macOS mkdtemp() may emit upper-case characters in its random suffix.
  const runDirectory = join(root, "run-dead-owner-Z9");
  await mkdir(runDirectory, { mode: 0o700 });
  const owned = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); const neighbour = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert(owned.pid && neighbour.pid);
  try {
    const anvil = { pid: owned.pid, processStart: await processStartIdentity(owned.pid) }; const staleRunnerStart = process.platform === "darwin" ? "darwin:00" : "linux:0";
    await writeFile(join(runDirectory, "lease.v1.json"), `${JSON.stringify({
      schemaVersion: 1,
      kind: "agtmai-local-evm-run",
      runner: { pid: process.pid, processStart: staleRunnerStart },
      anvil,
    })}\n`, { mode: 0o600 });
    await assert.rejects(reclaimStaleRuns(root), (cause: unknown) => cause instanceof Error
      && "code" in cause && cause.code === "LOCAL_EVM_RUN_ANVIL_STILL_OWNED");
    assert.equal(processExists(owned.pid), true); assert.equal(processExists(neighbour.pid), true); assert.equal((await stat(runDirectory)).isDirectory(), true);
  } finally {
    if (processExists(owned.pid)) { owned.kill("SIGKILL"); }
    if (processExists(neighbour.pid)) { neighbour.kill("SIGKILL"); }
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel recovery preserves a run while the production atomic lease writer initializes it", { timeout: 10_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-initializing-"))); const runDirectory = await createProvisionalRunDirectory(root, "initializing-Z9");
  const writer = (async () => {
    await delay(50);
    await createRunLease(runDirectory);
  })();
  try {
    assert.equal(await reclaimStaleRuns(root), 0);
    await writer;
    assert.equal((await stat(runDirectory)).isDirectory(), true);
  } finally {await writer.catch(() => {}); await rm(root, { recursive: true, force: true });}
});

test("initial lease publication preserves a preexisting foreign sentinel", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-lease-sentinel-"))); const runDirectory = await createProvisionalRunDirectory(root, "sentinel-Z9"); const leasePath = join(runDirectory, "lease.v1.json");
  await writeFile(leasePath, "foreign-sentinel", {mode: 0o600});
  try {
    await assert.rejects(createRunLease(runDirectory));
    assert.equal(await readFile(leasePath, "utf8"), "foreign-sentinel");
  } finally {await rm(root, {recursive: true, force: true});}
});

test("stale-run lease reads promptly reject and preserve a foreign FIFO", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-lease-fifo-"))); const runDirectory = join(root, "run-fifo-Z9"); const leasePath = join(runDirectory, "lease.v1.json");
  await mkdir(runDirectory, {mode: 0o700});
  await execute("/usr/bin/mkfifo", [leasePath]);
  try {
    assert.deepEqual( await runBoundedLeaseFixture(["reclaim", root]), {status: "rejected", code: "LOCAL_EVM_RUN_LEASE_NOT_REGULAR"}, ); assert.equal((await lstat(leasePath)).isFIFO(), true);
    assert.deepEqual( (await readdir(runDirectory)).filter((name) => name.endsWith(".tmp")), [], );
  } finally {await rm(root, {recursive: true, force: true});}
});

test("two concurrent lease creators publish exactly one owned lease", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-lease-race-"))); const runDirectory = await createProvisionalRunDirectory(root, "race-Z9");
  try {
    const results = await Promise.allSettled([ createRunLease(runDirectory), createRunLease(runDirectory), ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1); assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const entry = await lstat(join(runDirectory, "lease.v1.json"));
    assert.equal(entry.nlink, 1); assert.equal(entry.mode & 0o777, 0o600);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("normal create and authenticated Anvil registration retain update semantics", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-lease-update-"))); const runDirectory = await createProvisionalRunDirectory(root, "update-Z9");
  try {
    await createRunLease(runDirectory);
    const identity = { pid: process.pid, processStart: await processStartIdentity(process.pid), };
    await registerRunAnvil(runDirectory, identity);
    const lease = JSON.parse( await readFile(join(runDirectory, "lease.v1.json"), "utf8"), ) as Record<string, unknown>;
    assert.deepEqual(lease.anvil, identity);
    const entry = await lstat(join(runDirectory, "lease.v1.json"));
    assert.equal(entry.nlink, 1); assert.equal(entry.mode & 0o777, 0o600);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("authenticated lease update preserves a substituted foreign successor", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-lease-substitution-"))); const runDirectory = await createProvisionalRunDirectory(root, "substitution-Z9");
  const leasePath = join(runDirectory, "lease.v1.json"); const displaced = join(runDirectory, "authenticated-predecessor");
  try {
    await createRunLease(runDirectory);
    const predecessor = await readFile(leasePath, "utf8"); const identity = { pid: process.pid, processStart: await processStartIdentity(process.pid), };
    await assert.rejects(registerRunAnvil(runDirectory, identity, { beforePublish: async () => { await rename(leasePath, displaced);
        await writeFile(leasePath, "foreign-successor", {mode: 0o600});
      },
    }), (cause: unknown) => cause instanceof Error
      && "code" in cause
      && cause.code === "LOCAL_EVM_UPDATED_FILE_CHANGED");
    assert.equal(await readFile(leasePath, "utf8"), "foreign-successor"); assert.equal(await readFile(displaced, "utf8"), predecessor);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("authenticated lease update promptly rejects and preserves a substituted FIFO", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-update-fifo-"))); const runDirectory = await createProvisionalRunDirectory(root, "fifo-Z9");
  const leasePath = join(runDirectory, "lease.v1.json"); const displaced = join(runDirectory, "authenticated-predecessor");
  try {
    assert.deepEqual( await runBoundedLeaseFixture(["register", runDirectory, displaced]), {status: "rejected", code: "LOCAL_EVM_UPDATED_FILE_CHANGED", predecessorPreserved: true}, );
    assert.equal((await lstat(leasePath)).isFIFO(), true); assert.deepEqual( (await readdir(runDirectory)).filter((name) => name.endsWith(".tmp")), [], );
  } finally {await rm(root, {recursive: true, force: true});}
});

test("authenticated lease update rejects an in-place predecessor rewrite", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-lease-rewrite-"))); const runDirectory = await createProvisionalRunDirectory(root, "rewrite-Z9"); const leasePath = join(runDirectory, "lease.v1.json");
  try {
    await createRunLease(runDirectory);
    const predecessor = await readFile(leasePath); const mutated = Buffer.alloc(predecessor.byteLength, 0x78); const identity = { pid: process.pid, processStart: await processStartIdentity(process.pid), };
    await assert.rejects( registerRunAnvil(runDirectory, identity, { beforePublish: async () => { await writeFile(leasePath, mutated);
        },
      }),
      (cause: unknown) => cause instanceof Error
        && "code" in cause
        && cause.code === "LOCAL_EVM_UPDATED_FILE_CHANGED",
    );
    assert.deepEqual(await readFile(leasePath), mutated); assert.equal((await lstat(leasePath)).nlink, 1);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("two reclaimers atomically claim one stale run without recreating it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-concurrent-reclaim-"))); const runDirectory = join(root, "run-stale-concurrent-Z9");
  await mkdir(runDirectory, {mode: 0o700});
  await writeFile(join(runDirectory, "lease.v1.json"), `${JSON.stringify({
    schemaVersion: 1, kind: "agtmai-local-evm-run",
    runner: {pid: 2147483647, processStart: "linux:1"}, anvil: null,
  })}\n`, {mode: 0o600});
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {release = resolve;}); const afterDirectoryList = async (): Promise<void> => {arrivals += 1; if (arrivals === 2) {release();} await barrier;};
  try {
    const results = await Promise.all([ reclaimStaleRuns(root, {afterDirectoryList}), reclaimStaleRuns(root, {afterDirectoryList}), ]);
    assert.deepEqual(results.toSorted(), [0, 1]); assert.equal((await readdir(root)).some((name) => name === "run-stale-concurrent-Z9"), false);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("reclaimer never deletes a hostile directory substituted after validation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-reclaim-substitution-"))); const runDirectory = join(root, "run-stale-substitution-Z9"); const displaced = join(root, "displaced-owned-run");
  await mkdir(runDirectory, {mode: 0o700});
  const staleLease = `${JSON.stringify({schemaVersion: 1, kind: "agtmai-local-evm-run", runner: {pid: 2147483647, processStart: "linux:1"}, anvil: null})}\n`;
  await writeFile(join(runDirectory, "lease.v1.json"), staleLease, {mode: 0o600});
  try {
    await assert.rejects(reclaimStaleRuns(root, {afterDirectoryList: async () => {
      await rename(runDirectory, displaced);
      await mkdir(runDirectory, {mode: 0o700});
      await writeFile(join(runDirectory, "foreign-sentinel"), "preserve", {mode: 0o600});
      await writeFile(join(runDirectory, "lease.v1.json"), staleLease, {mode: 0o600});
    }}), (cause: unknown) => cause instanceof Error && "code" in cause
      && cause.code === "LOCAL_EVM_RUN_DIRECTORY_CHANGED");
    const claim = (await readdir(root)).find((name) => name.startsWith(".reclaim-v1-"));
    assert(claim);
    assert.equal(await readFile(join(root, claim, "foreign-sentinel"), "utf8"), "preserve");
    await assert.rejects(reclaimStaleRuns(root), (cause: unknown) => cause instanceof Error
      && "code" in cause && cause.code === "LOCAL_EVM_RUN_DIRECTORY_CHANGED");
    assert.equal(await readFile(join(root, claim, "foreign-sentinel"), "utf8"), "preserve"); assert.equal((await stat(displaced)).isDirectory(), true);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("a later reclaimer completes an inode-bound claim abandoned by a crashed reclaimer", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-abandoned-claim-"))); const runName = "run-stale-abandoned-Z9"; const runDirectory = join(root, runName);
  await mkdir(runDirectory, {mode: 0o700});
  await writeFile(join(runDirectory, "lease.v1.json"), `${JSON.stringify({
    schemaVersion: 1, kind: "agtmai-local-evm-run",
    runner: {pid: 2147483647, processStart: "linux:1"}, anvil: null,
  })}\n`, {mode: 0o600});
  const identity = await lstat(runDirectory, {bigint: true}); const abandoned = join(root, `.reclaim-v1-${identity.dev}-${identity.ino}-${identity.birthtimeNs}-999-${"a".repeat(24)}-${runName}`);
  await rename(runDirectory, abandoned);
  try {
    assert.equal(await reclaimStaleRuns(root), 1); assert.deepEqual(await readdir(root), []);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("stale authenticated provisional directory is reclaimed without a lease", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-provisional-"))); const initializer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
  assert(initializer.pid);
  const identity = await processStartIdentity(initializer.pid); const runDirectory = await mkdtemp(join(root, `run-init-${initializer.pid}-${identity.replace(":", "x")}-killed-Z9-`));
  const closed = new Promise<void>((resolve) => {initializer.once("close", () => resolve());});
  initializer.kill("SIGKILL");
  await closed;
  try {
    assert.equal(await reclaimStaleRuns(root), 1);
    await assert.rejects(stat(runDirectory));
  } finally {await rm(root, {recursive: true, force: true});}
});

test("unauthenticated markerless directory is preserved fail-closed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-unauthenticated-"))); const runDirectory = join(root, "run-unknown-Z9");
  await mkdir(runDirectory, {mode: 0o700});
  try {
    await assert.rejects(reclaimStaleRuns(root), (cause: unknown) => cause instanceof Error
      && "code" in cause && cause.code === "LOCAL_EVM_RUN_INITIALIZER_INVALID");
    assert.equal((await stat(runDirectory)).isDirectory(), true);
  } finally {await rm(root, {recursive: true, force: true});}
});

function processExists(pid: number): boolean {try {process.kill(pid, 0); return true;} catch {return false;}}

interface LeaseFixtureResult {
  readonly status: "fulfilled" | "rejected"; readonly code?: string; readonly predecessorPreserved?: boolean;
}

async function runBoundedLeaseFixture(args: readonly string[]): Promise<LeaseFixtureResult> { const fixture = fileURLToPath(new URL("./fixtures/fifo-lease-child.ts", import.meta.url));
  const {stdout, stderr} = await execute( process.execPath, [fixture, ...args], {timeout: 2_000, killSignal: "SIGKILL"}, );
  assert.equal(stderr, "");
  return JSON.parse(stdout) as LeaseFixtureResult;
}

async function chainId(url: string): Promise<string> { const {cast: castBinary} = pinnedFoundryBinaries(repositoryRoot);
  const { stdout } = await execute(castBinary, ["chain-id", "--rpc-url", url], { timeout: 30_000, killSignal: "SIGKILL" });
  return `0x${BigInt(stdout.trim()).toString(16)}`;
}

async function signalSupervisor(pid: number): Promise<void> {
  try {process.kill(pid, "SIGTERM");} catch (cause) {if ((cause as NodeJS.ErrnoException).code !== "ESRCH") {throw cause;}}
}
