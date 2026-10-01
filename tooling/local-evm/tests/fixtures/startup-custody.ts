import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {stripTypeScriptTypes} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {TestContext} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath, pathToFileURL} from "node:url";
import {compileFunction} from "node:vm";
import {cleanupFailures, finishWithCleanup} from "../../cleanup.ts";
import {authenticateProcess, startOwnedAnvil, type OwnedProcessIdentity} from "../../process.ts";
import {createProvisionalRunDirectory, createRunLease, registerRunAnvil, removeOwnedRunDirectory} from "../../run-lease.ts";

export type Caller = "runner" | "proof";

// Evaluate the actual private finalization seams; no production injection hook.
export async function loadFinalizer(caller: Caller) {
  const source = await readFile(new URL(caller === "runner" ? "../../runner.ts" : "../../../../scripts/deployment/local-execution-proof.ts", import.meta.url), "utf8");
  const body = caller === "runner"
    ? source.slice(source.indexOf("async function finalizeLocalRun("), source.indexOf("async function publishProcessId("))
    : `async function finalizeLocalRun({primary, anvil, runDirectory}) {${source.slice(source.lastIndexOf("  finally {", source.indexOf("/* oxlint-enable complexity */")), source.indexOf("/* oxlint-enable complexity */")).replace(/^  finally \{/u, "").replace(/\}\s*\}\s*$/u, "")}}`;
  return compileFunction(`${stripTypeScriptTypes(body)}\nreturn finalizeLocalRun;`,
    ["process", "finishWithCleanup", "cleanupFailures", "removeOwnedRunDirectory"])(process, finishWithCleanup, cleanupFailures, removeOwnedRunDirectory) as (state: {
      primary?: unknown; interrupt?: () => void; runDirectory: string; solc?: {close(): Promise<void>}; anvil?: {stop(): Promise<void>}; interruptedSignal?: NodeJS.Signals;
    }) => Promise<void>;
}

export async function startupCustodyProbe(context: TestContext, caller: Caller | "startup-only", stopFails = true, errorKind = "mutable", closeFails = false): Promise<{
  root: string; directory: string; identity: OwnedProcessIdentity;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "evm-startup-custody-")));
  const preload = join(root, "deny-stop.mjs");
  await writeFile(preload, `import {ChildProcess} from "node:child_process";
    if (process.argv.includes("--supervise-anvil")) ChildProcess.prototype.kill = function() {
      throw Object.assign(new Error("fixture child signal denied"), {code: "EPERM"});
    };`);
  const owner = spawn(process.execPath, [fileURLToPath(import.meta.url), root, caller, errorKind, String(closeFails)], {
    env: {...process.env, NODE_OPTIONS: stopFails ? `--import=${pathToFileURL(preload).href}` : ""},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  owner.stdout.resume();
  owner.stderr.on("data", (chunk: Buffer) => {stderr += chunk.toString();});
  const closed = new Promise<void>((resolve) => {owner.once("close", () => resolve());});
  context.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) {owner.kill("SIGKILL");}
    await closed;
    const identity: OwnedProcessIdentity | null = await readFile(join(root, "identity.json"), "utf8").then(JSON.parse, () => null);
    if (identity && await authenticateProcess(identity) === "owned") {
      process.kill(identity.pid, "SIGKILL");
      // An orphan can be a zombie until its OS parent reaps it; it cannot run.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await authenticateProcess(identity) === "absent") {break;}
        if (process.platform === "linux") {
          const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8").catch(() => "");
          if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) {break;}
        }
        assert(attempt < 199, "fixture child stop must be confirmed before deleting fixture");
        await delay(25);
      }
    }
    await rm(root, {recursive: true, force: true});
  });
  await closed;
  assert.equal(owner.exitCode, 0, stderr);
  return JSON.parse(await readFile(join(root, "result.json"), "utf8"));
}

async function runOwner(): Promise<void> {
  const [root, caller, errorKind, closeFails] = process.argv.slice(2);
  const directory = await createProvisionalRunDirectory(root, "owned");
  await createRunLease(directory);
  await writeFile(join(directory, "custody-sentinel"), "retain", {mode: 0o600});
  const payload = join(root, "payload.mjs");
  await writeFile(payload, "process.stdout.write('Listening on 127.0.0.1:18545\\n');setInterval(() => {}, 1000);");
  const executable = join(root, "anvil.sh");
  await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(payload)}\n`, {mode: 0o700});
  const registration = errorKind === "undefined" ? undefined : errorKind === "primitive" ? "fixture publication EIO" : Object.assign(new Error("fixture publication EIO"), {code: "EIO"});
  if (errorKind === "frozen") {Object.freeze(registration);}
  let identity: OwnedProcessIdentity | undefined;
  const primary = await startOwnedAnvil(executable, "0x7000000000000000000000000000000000000001", async value => {
    identity = value;
    await writeFile(join(root, "identity.json"), JSON.stringify(identity));
    await registerRunAnvil(directory, value, {beforePublish() {throw registration;}});
  }).then(() => assert.fail("publication failure must reject startup"), (cause: unknown) => cause);
  if (process.env.NODE_OPTIONS) {
    const failures = errorKind === "undefined" ? [primary] : primary instanceof AggregateError ? primary.errors.slice(1) : cleanupFailures(primary);
    assert.equal(failures.length, 1);
    assert.equal((failures[0] as {code: string}).code, "LOCAL_EVM_ANVIL_STOP_UNCONFIRMED");
    if (errorKind !== "mutable" && errorKind !== "undefined") {
      assert(primary instanceof AggregateError);
      assert.equal(primary.cause, registration);
      assert.equal(primary.errors[0], registration);
    } else if (errorKind === "mutable") {assert.equal(primary, registration);}
  } else {assert.equal(primary, registration);}
  if (caller === "startup-only") {
    await writeFile(join(root, "result.json"), JSON.stringify({root, directory, identity}));
    return;
  }
  const closeFailure = new Error("fixture descriptor close failed");
  let closed = false;
  const finalize = await loadFinalizer(caller as Caller);
  const rejected = await finalize({primary, runDirectory: directory, interrupt() {}, solc: {async close() {
    closed = true;
    if (closeFails === "true") {throw closeFailure;}
  }}}).then(() => assert.fail("primary must survive finalization"), (cause: unknown) => cause);
  if (caller === "runner") {assert.equal(closed, true);}
  if (closeFails === "true") {
    assert(rejected instanceof AggregateError);
    assert.equal(rejected.cause, primary);
    assert.deepEqual(rejected.errors, [primary, closeFailure]);
    assert.equal((cleanupFailures(primary)[0] as {code: string}).code, "LOCAL_EVM_ANVIL_STOP_UNCONFIRMED");
  } else {assert.equal(rejected, primary);}
  await writeFile(join(root, "result.json"), JSON.stringify({root, directory, identity}));
}

function quote(value: string): string {return `'${value.replaceAll("'", "'\\''")}'`;}

if (process.argv[1] === fileURLToPath(import.meta.url)) {await runOwner();}
