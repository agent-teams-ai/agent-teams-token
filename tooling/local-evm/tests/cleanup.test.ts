import assert from "node:assert/strict";
import {test} from "node:test";
import {spawn, type ChildProcess} from "node:child_process";
import {mkdtemp, open, readFile, readdir, realpath, rm, writeFile} from "node:fs/promises";
import {stripTypeScriptTypes} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileFunction} from "node:vm";
import {fileURLToPath} from "node:url";
import {syntheticAnvil} from "./fixtures/synthetic-anvil.ts";
import {loadFinalizer, startupCustodyProbe} from "./fixtures/startup-custody.ts";
import {authenticateProcess, processStartIdentity, redact, startOwnedAnvil} from "../process.ts";
import {createProvisionalRunDirectory, createRunLease, reclaimStaleRuns, registerRunAnvil} from "../run-lease.ts";
import {
  cleanupFailures,
  finishWithCleanup,
} from "../cleanup.ts";
import {LocalEvmError} from "../model.ts";

test("cleanup attempts every action and preserves the primary failure", async () => {
  const primary = new LocalEvmError(
    "LOCAL_EVM_PRIMARY_FIXTURE",
    "primary fixture failure",
  );
  const firstClose = new Error("first close fixture");
  const thirdClose = new Error("third close fixture");
  const attempts: number[] = [];
  const rejected = await finishWithCleanup(primary, [
    () => {
      attempts.push(1);
      throw firstClose;
    },
    () => {
      attempts.push(2);
    },
    async () => {
      attempts.push(3);
      throw thirdClose;
    },
  ]).then(
    () => assert.fail("cleanup must preserve the primary rejection"),
    (cause: unknown) => cause,
  );

  assert.equal(rejected, primary);
  assert.equal((rejected as LocalEvmError).code, "LOCAL_EVM_PRIMARY_FIXTURE");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(cleanupFailures(primary), [firstClose, thirdClose]);
  assert.equal(primary.message.includes(firstClose.message), false);
  assert.equal(primary.message.includes(thirdClose.message), false);
});

test("multiple cleanup-only failures use a redacted aggregate message", async () => {
  const rejected = await finishWithCleanup(undefined, [
    () => {
      throw new Error("sensitive command output fixture");
    },
    () => {
      throw new Error("private path fixture");
    },
  ]).then(
    () => assert.fail("cleanup-only failures must reject"),
    (cause: unknown) => cause,
  );

  assert(rejected instanceof AggregateError);
  assert.equal(rejected.errors.length, 2);
  assert.equal(rejected.message, "multiple local EVM cleanup operations failed");
  assert.equal(rejected.message.includes("sensitive"), false);
  assert.equal(rejected.message.includes("private path"), false);
});

// Exercise the runner's real finalization seam, supplying only its external
// resources. Keep the function private in production, as in the supervisor tests.
const finalize = await loadFinalizer("runner");

for (const caller of ["runner", "proof"] as const) {
  for (const stopFails of [true, false]) {
    test(`${caller} startup publication failure ${stopFails ? "retains" : "removes"} custody after real supervisor cleanup`, {timeout: 20_000}, async context => {
      const {root, directory, identity} = await startupCustodyProbe(context, caller, stopFails);
      assert.equal(await authenticateProcess(identity), stopFails ? "owned" : "absent");
      if (stopFails) {
        const lease = JSON.parse(await readFile(join(directory, "lease.v1.json"), "utf8"));
        assert.equal(lease.anvil, null);
        assert.equal(await authenticateProcess(lease.runner), "absent");
        await assert.rejects(reclaimStaleRuns(root), {code: "LOCAL_EVM_RUN_ANVIL_STILL_OWNED"});
        assert.equal(await readFile(join(directory, "custody-sentinel"), "utf8"), "retain");
      } else {await assert.rejects(readFile(join(directory, "lease.v1.json")), {code: "ENOENT"});}
    });
  }
}

for (const errorKind of ["frozen", "primitive", "undefined"] as const) {
  test(`startup ${errorKind} primary aggregation retains custody`, {timeout: 20_000}, async context => {
    const {directory, identity} = await startupCustodyProbe(context, "runner", true, errorKind);
    assert.equal(await authenticateProcess(identity), "owned");
    assert.equal(JSON.parse(await readFile(join(directory, "lease.v1.json"), "utf8")).anvil, null);
    assert.equal(await readFile(join(directory, "custody-sentinel"), "utf8"), "retain");
  });
}

test("startup stop failure and later descriptor failure both survive finalization", {timeout: 20_000}, async context => {
  const {directory, identity} = await startupCustodyProbe(context, "runner", true, "mutable", true);
  assert.equal(await authenticateProcess(identity), "owned");
  assert.equal(await readFile(join(directory, "custody-sentinel"), "utf8"), "retain");
});

test("proof stop rejection retains custody even if the registered child has exited", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "evm-proof-stop-")));
  const directory = await createProvisionalRunDirectory(root, "proof");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
  assert(child.pid);
  const closed = new Promise<void>((resolve) => {child.once("close", () => resolve());});
  const stopFailure = new Error("stop rejected");
  // Real owned-run deletion must not be attempted after a rejected stop.
  await createRunLease(directory);
  await registerRunAnvil(directory, {pid: child.pid, processStart: await processStartIdentity(child.pid)});
  await reapSyntheticChild(child, closed);
  const proof = await loadFinalizer("proof");
  try {
    await assert.rejects(proof({runDirectory: directory, anvil: {async stop() {throw stopFailure;}}}), cause => cause === stopFailure);
    assert.equal(JSON.parse(await readFile(join(directory, "lease.v1.json"), "utf8")).anvil.pid, child.pid);
  } finally {await reapSyntheticChild(child, closed); await rm(root, {recursive: true, force: true});}
});

for (const outcome of ["failed-primary", "failed-only", "failed-reaped", "fulfilled-live", "missing-handle", "reused-identity", "success"] as const) {
  test(`runner finalization retains recovery custody unless termination succeeds: ${outcome}`, {timeout: 10_000}, async (context) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "evm-finalization-")));
    const directory = await createProvisionalRunDirectory(root, "retention");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
    assert(child.pid);
    const closed = new Promise<void>((resolve) => {child.once("close", () => resolve());});
    const terminate = async (): Promise<void> => {await reapSyntheticChild(child, closed);};
    let interrupts = 0;
    const interrupt = (): void => {interrupts += 1;};
    const previousExitCode = process.exitCode;
    const primary = new LocalEvmError("LOCAL_EVM_PRIMARY_FIXTURE", "operation failed");
    const stopFailure = new LocalEvmError("LOCAL_EVM_PROCESS_STOP_TIMEOUT", "stop unconfirmed");
    const closeFailure = new Error("descriptor finalization failed");
    let stopAttempts = 0;
    let closeAttempts = 0;
    try {
      const identity = {pid: child.pid, processStart: await processStartIdentity(child.pid)};
      await createRunLease(directory);
      await registerRunAnvil(directory, outcome === "reused-identity"
        ? {pid: child.pid, processStart: process.platform === "darwin" ? "darwin:00" : "linux:0"}
        : identity);
      await writeFile(join(directory, "recovery-sentinel"), "preserve", {mode: 0o600});
      const leasePath = join(directory, "lease.v1.json");
      const lease = await readFile(leasePath);
      // A held real descriptor must close even when stopping Anvil fails.
      const descriptor = await open(join(directory, "recovery-sentinel"), "r");
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      const result = await finalize({
        primary: outcome === "failed-primary" ? primary : undefined,
        interrupt, runDirectory: directory, interruptedSignal: "SIGTERM",
        solc: {async close() {
          closeAttempts += 1;
          await descriptor.close();
          if (outcome === "failed-primary") {throw closeFailure;}
        }},
        anvil: outcome === "missing-handle" ? undefined : {async stop() {
          stopAttempts += 1;
          if (outcome === "success" || outcome === "failed-reaped") {await terminate();}
          if (outcome.startsWith("failed-")) {throw stopFailure;}
        }},
      }).then(() => null, (cause: unknown) => cause);
      assert.equal(interrupts, 0);
      assert.equal(closeAttempts, 1);
      await assert.rejects(descriptor.stat(), {code: "EBADF"});
      assert.equal(process.listeners("SIGINT").includes(interrupt), false);
      assert.equal(process.listeners("SIGTERM").includes(interrupt), false);
      assert.equal(process.exitCode, 143, "independent interruption cleanup still runs");
      assert.equal(stopAttempts, outcome === "missing-handle" ? 0 : 1);
      const childState = await authenticateProcess(identity);
      context.diagnostic(`stop outcome=${outcome}; directory entries=${JSON.stringify(await readdir(root))}; actual child=${childState}`);
      assert.equal(childState, outcome === "success" || outcome === "failed-reaped" ? "absent" : "owned");
      if (outcome === "success" || outcome === "reused-identity") {
        assert.equal(result, null);
        assert.deepEqual(await readdir(root), []);
        assert.equal(await authenticateProcess(identity), outcome === "reused-identity" ? "owned" : "absent");
      } else {
        if (outcome === "failed-primary") {
          assert.equal(result, primary);
          assert.deepEqual(cleanupFailures(primary), [closeFailure, stopFailure]);
        } else if (outcome.startsWith("failed-")) {assert.equal(result, stopFailure);}
        else {
          assert(result instanceof LocalEvmError);
          assert.equal(result.code, "LOCAL_EVM_RUN_ANVIL_STILL_OWNED");
        }
        assert.deepEqual(await readdir(root), [directory.slice(root.length + 1)], "retain the original recovery path");
        assert.deepEqual(await readFile(leasePath), lease, "retain the exact registered recovery identity");
        assert.equal(await readFile(join(directory, "recovery-sentinel"), "utf8"), "preserve");
        assert.equal(await authenticateProcess(identity), outcome === "failed-reaped" ? "absent" : "owned");
      }
    } finally {
      process.exitCode = previousExitCode;
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      await terminate();
      await rm(root, {recursive: true, force: true});
    }
  });
}

const source = await readFile(new URL("../process.ts", import.meta.url), "utf8");
const functions = source.slice(source.indexOf("export async function startOwnedAnvil("), source.indexOf("async function superviseAnvil("))
  + source.slice(source.indexOf("async function supervisorMessage("), source.indexOf("export async function processStartIdentity("))
  + source.slice(source.indexOf("async function stopExactChild("), source.indexOf('if (process.argv[1]'));
// Real protocol pipes and exit status; replace only the spawn boundary to
// supply a failing supervisor without a production-only injection hook.
const evaluateParentStart = compileFunction(`${stripTypeScriptTypes(functions.replaceAll("export ", "").replace("import.meta.url", JSON.stringify(import.meta.url)))}\nreturn startOwnedAnvil;`,
  ["spawn", "process", "fileURLToPath", "LocalEvmError", "authenticateProcess", "finishWithCleanup", "redact"]);

test("parent owned-Anvil API preserves a redacted early protocol exit", {timeout: 10_000}, async () => {
  const syntheticValue = `0x${"11".repeat(32)}`;
  const supervisor = spawn(process.execPath, ["--eval", `process.stderr.write("fixture ${syntheticValue}"); process.exitCode = 17;`],
    {stdio: ["pipe", "pipe", "pipe"]});
  const closed = new Promise<void>((resolve) => {supervisor.once("close", () => resolve());});
  const start = evaluateParentStart(() => supervisor, process, fileURLToPath, LocalEvmError, authenticateProcess, finishWithCleanup, redact) as typeof startOwnedAnvil;
  try {
    await assert.rejects(start("synthetic", "0x7000000000000000000000000000000000000001"), (cause: unknown) => {
      assert(cause instanceof LocalEvmError);
      assert.equal(cause.code, "LOCAL_EVM_ANVIL_EARLY_EXIT");
      assert.match(cause.message, /exited 17: fixture \[REDACTED_32_BYTE_VALUE\]/u);
      assert.equal(cause.message.includes(syntheticValue), false);
      return true;
    });
  } finally {await reapSyntheticChild(supervisor, closed);}
});

for (const scenario of ["failed-live", "failed-stopped", "already-failed-live", "signal-live", "zero-live", "zero-stopped", "startup-failed-live"] as const) {
  test(`parent owned-Anvil API validates supervisor termination: ${scenario}`, {timeout: 10_000}, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "evm-parent-stop-"));
    const payload = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
    assert(payload.pid);
    const payloadClosed = new Promise<void>((resolve) => {payload.once("close", () => resolve());});
    const identity = {pid: payload.pid, processStart: await processStartIdentity(payload.pid)};
    const supervisorPath = join(directory, "supervisor.mjs");
    await writeFile(supervisorPath, [
      `process.stdout.write(JSON.stringify({type: "identity", ...${JSON.stringify(identity)}}) + "\\n");`,
      `process.stdin.setEncoding("utf8");`,
      `process.stdin.on("data", (chunk) => {`,
      `  if (chunk === "ack\\n") {process.stdout.write(JSON.stringify({type: "ready", rpcUrl: "http://127.0.0.1:18545/"}) + "\\n");${scenario === "already-failed-live" ? "setTimeout(() => process.exit(1), 10);" : ""}}`,
      `  else {process.exit(${scenario.startsWith("zero-") ? 0 : 1});}`,
      `});`,
    ].join("\n"));
    const supervisor = spawn(process.execPath, [supervisorPath], {stdio: ["pipe", "pipe", "pipe"]});
    const supervisorClosed = new Promise<void>((resolve) => {supervisor.once("close", () => resolve());});
    const start = evaluateParentStart(() => supervisor, process, fileURLToPath, LocalEvmError, authenticateProcess, finishWithCleanup, redact) as typeof startOwnedAnvil;
    const primary = new Error("registration failed");
    const stopPayload = async (): Promise<void> => {await reapSyntheticChild(payload, payloadClosed);};
    try {
      if (scenario === "startup-failed-live") {
        await assert.rejects(start("synthetic", "0x7000000000000000000000000000000000000001", async () => {throw primary;}), (cause) => cause === primary);
        const failures = cleanupFailures(primary);
        assert.equal(failures.length, 1);
        assert(failures[0] instanceof LocalEvmError);
        assert.equal(failures[0].code, "LOCAL_EVM_ANVIL_STOP_UNCONFIRMED");
      } else {
        const anvil = await start("synthetic", "0x7000000000000000000000000000000000000001");
        assert.equal(anvil.pid, payload.pid);
        if (scenario === "signal-live") {supervisor.kill("SIGKILL");}
        if (scenario === "already-failed-live" || scenario === "signal-live") {await supervisorClosed;}
        if (scenario.endsWith("stopped")) {await stopPayload();}
        if (scenario === "zero-stopped") {await anvil.stop();}
        else {await assert.rejects(anvil.stop(), (cause: unknown) => {
          assert(cause instanceof LocalEvmError);
          assert.equal(cause.code, scenario === "failed-stopped" ? "LOCAL_EVM_ANVIL_SUPERVISOR_FAILED" : "LOCAL_EVM_ANVIL_STOP_UNCONFIRMED");
          return true;
        });}
      }
      await supervisorClosed;
      assert.equal(supervisor.exitCode, scenario === "signal-live" ? null : scenario.startsWith("zero-") ? 0 : 1);
      assert.equal(supervisor.signalCode, scenario === "signal-live" ? "SIGKILL" : null);
      assert.equal(await authenticateProcess(identity), scenario.endsWith("stopped") ? "absent" : "owned",
        "parent must neither mistake supervisor exit for payload exit nor signal a non-child PID");
      context.diagnostic(`supervisor exit=${supervisor.exitCode}; actual payload=${await authenticateProcess(identity)}`);
    } finally {
      // Reap only children spawned by this test; retain fixture if reaping fails.
      await stopPayload();
      await reapSyntheticChild(supervisor, supervisorClosed);
      await rm(directory, {recursive: true, force: true});
    }
  });
}


test("successful real supervisor finalization deletes its registered lease and run", {timeout: 10_000}, async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "evm-successful-finalization-")));
  const directory = await createProvisionalRunDirectory(root, "success");
  await createRunLease(directory);
  const fixture = await syntheticAnvil(context);
  const anvil = await fixture.start("0x7000000000000000000000000000000000000001", async (identity) => {
    await registerRunAnvil(directory, identity);
  });
  const interrupt = (): void => {assert.fail(`unexpected interruption for owned Anvil ${anvil.pid}`);};
  try {
    const identity = {pid: anvil.pid, processStart: await processStartIdentity(anvil.pid)};
    const descriptor = await open(join(directory, "lease.v1.json"), "r");
    await finalize({interrupt, runDirectory: directory, anvil, solc: {async close() {await descriptor.close();}}});
    await assert.rejects(descriptor.stat(), {code: "EBADF"});
    assert.equal(await authenticateProcess(identity), "absent");
    assert.deepEqual(await readdir(root), [], "successful supervised teardown removes all owned run resources");
  } finally {
    await anvil.stop();
    await rm(root, {recursive: true, force: true});
  }
});

async function reapSyntheticChild(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("synthetic child termination unconfirmed; retaining fixture")), 5_000);
      }),
    ]);
  } finally {clearTimeout(timer);}
}
