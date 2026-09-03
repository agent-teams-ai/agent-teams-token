import { spawn, type ChildProcess } from "node:child_process";
import { processStartIdentity } from "./process-identity.ts";

interface StartMessage {
  readonly type: "start";
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly leaseToken: string;
}

type ControlMessage = StartMessage | { readonly type: "acknowledge" } | { readonly type: "stop" };

let validator: ChildProcess | undefined;
let acknowledged = false;
let stopping: Promise<boolean> | undefined;
let validatorStart: string | null = null;

process.on("message", (message: ControlMessage) => {
  if (message.type === "start" && validator === undefined) {
    validator = spawn(message.executable, [...message.args], {
      env: { ...message.env, AGTMAI_LOCAL_SOLANA_LEASE_TOKEN: message.leaseToken },
      stdio: ["ignore", "pipe", "pipe"],
    });
    void (async () => { validatorStart = validator?.pid === undefined ? null : await processStartIdentity(validator.pid).catch(() => null); })();
    validator.stdout?.on("data", (chunk: Buffer) => { send({ type: "output", value: chunk.toString("utf8") }); });
    validator.stderr?.on("data", (chunk: Buffer) => { send({ type: "output", value: chunk.toString("utf8") }); });
    validator.once("spawn", () => { send({ type: "spawned", pid: validator?.pid }); });
    validator.once("error", () => { send({ type: "spawnError" }); });
    validator.once("exit", (code, signal) => { send({ type: "exit", code, signal }); });
    return;
  }
  if (message.type === "acknowledge" && validator !== undefined) {
    acknowledged = true;
    send({ type: "acknowledged" });
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

async function terminateAndExit(): Promise<void> {
  const result = stopping ??= stopValidator();
  if (await result.catch(() => false)) {
    send({ type: "stopped" });
    process.exit(acknowledged ? 0 : 1);
  }
  send({ type: "stopFailed" });
}

async function stopValidator(): Promise<boolean> {
  const child = validator;
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) { return true; }
  const closed = new Promise<void>((resolve) => { child.once("close", () => { resolve(); }); });
  if (validatorStart !== null && await processStartIdentity(child.pid ?? -1).catch(() => null) !== validatorStart) { return false; }
  child.kill("SIGTERM");
  if (!await within(closed, 5_000)) {
    if (validatorStart !== null && await processStartIdentity(child.pid ?? -1).catch(() => null) !== validatorStart) { return false; }
    child.kill("SIGKILL");
    return await within(closed, 5_000);
  }
  return true;
}

async function within(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false); }, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) { clearTimeout(timer); }
  }
}
