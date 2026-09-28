import { spawn, type ChildProcess } from "node:child_process";
import { authenticateValidatorIdentity, captureValidatorIdentity, processStartIdentity } from "./process-identity.ts";
import type { ValidatorIdentity } from "../application/ports.ts";

import { recordStartupStage, startupFailureCode, updateStartupCustody, type StartupCustody, type StartupStage } from "./startup-custody.ts";

interface StartMessage {
  readonly type: "start";
  readonly custody: StartupCustody;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly leaseToken: string;
}

type ControlMessage = StartMessage | { readonly type: "acknowledge" } | { readonly type: "stop" };

let custody: StartupCustody | undefined;
let starting: Promise<void> | undefined;
let closing = false;
let validator: ChildProcess | undefined;
let acknowledged = false;
let stopping: Promise<boolean> | undefined;
let validatorIdentity: Promise<ValidatorIdentity | null> | undefined;
let capturedValidatorIdentity: ValidatorIdentity | null | undefined;
let validatorStartIdentity: Promise<string | null> | undefined;
let leaseToken: string | undefined;
let acknowledgementTimer: NodeJS.Timeout | undefined;
let stage: StartupStage = "reserved";
let portCollision = false;
let failing = false;

async function advance(next: StartupStage): Promise<void> {
  if (custody === undefined) { return; }
  await recordStartupStage(custody, next);
  stage = next;
  send({ type: "stage", stage: next });
}

process.on("message", (message: ControlMessage) => {
  if (message.type === "start" && starting === undefined && !closing) {
    custody = message.custody;
    starting = (async () => {
      await updateStartupCustody(message.custody, false);
      stage = "supervisor-acquired";
      send({ type: "stage", stage });
      if (closing) { return; }
      await advance("spawn-requested");
      if (closing) { return; }
      validator = spawn(message.executable, [...message.args], {
        env: { ...message.env, AGTMAI_LOCAL_SOLANA_LEASE_TOKEN: message.leaseToken },
        stdio: ["ignore", "pipe", "pipe"],
      });
      leaseToken = message.leaseToken;
      validatorStartIdentity = new Promise((resolve) => {
        validator?.once("spawn", () => { void processStartIdentity(validator?.pid ?? -1).then(resolve, () => { resolve(null); }); });
        validator?.once("error", () => { resolve(null); });
      });
      const ledgerIndex = message.args.indexOf("--ledger"); const ledger = ledgerIndex < 0 ? undefined : message.args[ledgerIndex + 1];
      validatorIdentity = new Promise((resolve) => {
        validator?.once("spawn", () => { void (async () => { resolve(validator?.pid === undefined || ledger === undefined ? null : await captureValidatorIdentity(validator.pid, message.executable, ledger, message.leaseToken).catch(() => null)); })(); });
        validator?.once("error", () => { resolve(null); });
      });
      const classify = (chunk: Buffer): void => {
        if (!portCollision && /address already in use|os error 98|eaddrinuse/iu.test(chunk.toString("utf8"))) { portCollision = true; send({ type: "portCollision" }); }
      };
      validator.stdout?.on("data", classify);
      validator.stderr?.on("data", classify);
      void validatorIdentity.then(async (identity) => {
        try { await starting; } catch { return; }
        if (closing || failing) { return; }
        capturedValidatorIdentity = identity;
        if (identity === null) { void failStartup("spawned", { code: "SOLANA_VALIDATOR_IDENTITY" }); }
        else { void advance("identity-captured").then(() => { send({ type: "spawned", pid: validator?.pid, identity }); }, (cause) => { void failStartup("identity-captured", cause); }); }
        return null;
      });
      validator.once("error", (cause) => { void failStartup("spawned", cause); });
      validator.once("exit", (code, signal) => { send({ type: "exit", code, signal }); });
      await advance("spawned");
      acknowledgementTimer = setTimeout(() => { void terminateAndExit(); }, 15_000);
    })();
    void starting.catch((cause) => { void failStartup(stage, cause); });
    return;
  }
  if (message.type === "acknowledge" && validator !== undefined && !closing && !failing) {
    acknowledged = true;
    clearAcknowledgementTimer();
    void advance("registered").then(() => { send({ type: "acknowledged" }); }, (cause) => { void failStartup("registered", cause); });
    return;
  }
  if (message.type === "stop") { void terminateAndExit(); }
});

process.once("disconnect", () => { void terminateAndExit(); });
process.once("SIGINT", () => { void terminateAndExit(); });
process.once("SIGTERM", () => { void terminateAndExit(); });

function send(message: object): void {
  if (process.connected) { process.send?.(message, () => {}); }
}

async function failStartup(phase: StartupStage, cause: unknown): Promise<void> {
  if (failing) { return; }
  failing = true;
  const code = startupFailureCode(cause);
  if (starting !== undefined) { await within(starting, 1_500); }
  if (custody !== undefined && stage !== "reserved") {
    if (await within(recordStartupStage(custody, "failed", { phase, cause }), 1_500)) { stage = "failed"; }
  }
  send({ type: "startupFailure", phase, code });
  await terminateAndExit();
}

async function terminateAndExit(): Promise<void> {
  closing = true;
  clearAcknowledgementTimer();
  const result = stopping ??= (async () => {
    if (starting !== undefined && !await within(starting, 1_500)) { return false; }
    if (custody !== undefined && stage !== "reserved") { await advance("stopping"); }
    if (!await stopValidator()) { return false; }
    if (custody !== undefined) { await updateStartupCustody(custody, true); }
    return true;
  })();
  if (await result.catch(() => false)) {
    send({ type: "stopped" });
    process.exit(acknowledged ? 0 : 1);
  }
  send({ type: "stopFailed", stage });
  if (validator === undefined) { process.exitCode = 1; process.disconnect?.(); }
}

async function stopValidator(): Promise<boolean> {
  const child = validator;
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) { return true; }
  const closed = new Promise<void>((resolve) => { child.once("close", () => { resolve(); }); });
  const startIdentity = await Promise.race([validatorStartIdentity ?? Promise.resolve(null), new Promise<null>((resolve) => { setTimeout(() => resolve(null), 1_500); })]);
  if (startIdentity === null) { return false; }
  const identity = capturedValidatorIdentity;
  if (identity !== undefined && identity !== null && (leaseToken === undefined || !await authenticateValidatorIdentity(identity, leaseToken))) { return false; }
  if (!await stillExactChild(child, startIdentity)) { return child.exitCode !== null || child.signalCode !== null; }
  child.kill("SIGTERM");
  if (!await within(closed, 5_000)) {
    if (!await stillExactChild(child, startIdentity)) { return child.exitCode !== null || child.signalCode !== null; }
    child.kill("SIGKILL");
    return await within(closed, 5_000);
  }
  return true;
}

async function stillExactChild(child: ChildProcess, startIdentity: string): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) { return false; }
  return await processStartIdentity(child.pid).then((current) => current === startIdentity, () => false);
}

function clearAcknowledgementTimer(): void {
  if (acknowledgementTimer !== undefined) { clearTimeout(acknowledgementTimer); acknowledgementTimer = undefined; }
}

async function within(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false); }, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) { clearTimeout(timer); }
  }
}
