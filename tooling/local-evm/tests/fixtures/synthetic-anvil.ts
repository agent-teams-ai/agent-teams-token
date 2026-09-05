import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startOwnedAnvil, type OwnedAnvil, type OwnedProcessIdentity } from "../../process.ts";

interface PayloadIdentity {
  readonly pid: number;
  readonly execPath: string;
}

export async function syntheticAnvil(
  context: Pick<TestContext, "after">,
  mode: "ready" | "stubborn" | "silent" | "exit" = "ready",
) {
  // Exercise shell quoting as well as spaces, without copying the authenticated Node.
  const directory = await mkdtemp(join(tmpdir(), "agtmai synthetic anvil '"));
  const executable = join(directory, "synthetic anvil.sh");
  const payloadPath = join(directory, "payload identity.json");
  const signalPath = join(directory, "sigterm.json");
  const starts: Promise<OwnedAnvil>[] = [];
  const runners: {child: ChildProcess; closed: Promise<Error | undefined>}[] = [];
  context.after(async () => {
    try {
      const results = await Promise.allSettled([
        ...runners.map(async ({child, closed}) => {
          if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}
          await boundedClose(closed);
        }),
        ...starts.map(async (pending) => {
          // startOwnedAnvil owns teardown when startup rejects.
          const anvil = await pending.catch(() => undefined);
          await anvil?.stop();
        }),
      ]);
      const failures: unknown[] = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      try {
        const payload = await readJson<PayloadIdentity>(payloadPath);
        await assertPayloadStopped(payload.pid);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {failures.push(cause);}
      }
      if (failures.length > 0) {throw new AggregateError(failures, "synthetic Anvil cleanup failed");}
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
  const payload = join(directory, "synthetic payload.mjs");
  await writeFile(payload, [
    `import {writeFileSync} from "node:fs";`,
    mode === "stubborn" ? `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(signalPath)}, JSON.stringify({pid: process.pid})));` : "",
    `writeFileSync(${JSON.stringify(payloadPath)}, JSON.stringify({pid: process.pid, execPath: process.execPath}));`,
    mode === "exit" ? "process.exit(17);" : "",
    mode === "silent" ? "" : `process.stdout.write("Listening on 127.0.0.1:18545\\n");`,
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  // /usr/bin/env node selects the pinned Bash supervisor under the official PATH.
  // exec replaces this launcher, so the supervisor's child PID is the payload PID.
  await writeFile(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(payload)} "$@"\n`, {mode: 0o700});
  return {
    directory, executable, signalPath,
    start(address: string, registerIdentity?: (identity: OwnedProcessIdentity) => Promise<void>): Promise<OwnedAnvil> {
      const pending = startOwnedAnvil(executable, address, registerIdentity);
      starts.push(pending);
      return pending;
    },
    async payload(): Promise<PayloadIdentity> {
      const identity = await waitForJson<PayloadIdentity>(payloadPath);
      assert(Number.isSafeInteger(identity.pid) && identity.pid > 0);
      assert.equal(identity.execPath, process.execPath);
      return identity;
    },
    async runner(source: string) {
      const harness = join(directory, "runner.mjs");
      await writeFile(harness, source);
      const child = spawn(process.execPath, [harness], {stdio: "ignore"});
      let spawnError: Error | undefined;
      child.once("error", (cause) => {spawnError = cause;});
      const closed = new Promise<Error | undefined>((resolve) => {child.once("close", () => resolve(spawnError));});
      runners.push({child, closed});
      return {
        async kill(): Promise<void> {
          if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}
          await boundedClose(closed);
        },
      };
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function waitForJson<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {return await readJson<T>(path);}
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT" && !(cause instanceof SyntaxError)) {throw cause;}
      await delay(25);
    }
  }
  throw new Error(`synthetic Anvil did not publish ${path} within 5000ms`);
}

export async function assertPayloadStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && processExists(pid); attempt += 1) {await delay(25);}
  assert.equal(processExists(pid), false, `synthetic payload ${pid} must be reaped`);
}

function processExists(pid: number): boolean {
  try {process.kill(pid, 0); return true;}
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") {return false;}
    throw cause;
  }
}

async function boundedClose(closed: Promise<Error | undefined>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const cause = await Promise.race([
      closed,
      new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("synthetic runner did not close within 5000ms")), 5_000);}),
    ]);
    if (cause) {throw cause;}
  } finally {
    clearTimeout(timer);
  }
}
