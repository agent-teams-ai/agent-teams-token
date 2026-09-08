import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

// Only OS identity observations are simulated. Lease bytes, modes, links,
// renames and deletions use the real private temporary filesystem.
export function simulateDarwinClaimIdentity(context: TestContext): {
  directoryIdentity: string;
  start(): string;
  reusePid(): void;
  bindDirectory(directory: string): Promise<void>;
  restore(): void;
} {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const pid = Object.getOwnPropertyDescriptor(process, "pid")!;
  const stat = fs.lstat;
  let start = "Mon Sep  7 15:00:00 2026";
  Object.defineProperty(process, "platform", {...platform, value: "darwin"});
  Object.defineProperty(process, "pid", {...pid, value: 12345});
  context.mock.method(process, "kill", (target: number, signal: string | number) => {
    assert.equal(signal, 0);
    if (target === 12345) {return true;}
    throw Object.assign(new Error("absent fixture process"), {code: "ESRCH"});
  });
  context.mock.method(childProcess, "execFile", (...args: unknown[]) => {
    assert.equal(args[0], "/bin/ps");
    assert.deepEqual(args[1], ["-o", "lstart=", "-p", "12345"]);
    (args[3] as (error: null, stdout: string) => void)(null, `${start}\n`);
  });
  syncBuiltinESMExports();
  return {
    directoryIdentity: "16777234:123456789:1788793200000000000",
    start: () => `darwin:${Buffer.from(start).toString("hex")}`,
    reusePid: () => {start = "Mon Sep  7 15:01:00 2026";},
    async bindDirectory(directory) {
      const original = await stat(directory, {bigint: true});
      context.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
        const entry = await stat(...args);
        if (entry.isDirectory() && entry.ino === original.ino && entry.dev === original.dev) {
          return Object.assign(entry, {dev: 16777234n, ino: 123456789n, birthtimeNs: 1788793200000000000n});
        }
        return entry;
      });
      syncBuiltinESMExports();
    },
    restore() {
      Object.defineProperty(process, "platform", platform);
      Object.defineProperty(process, "pid", pid);
    },
  };
}
