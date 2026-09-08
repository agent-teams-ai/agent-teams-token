import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs, { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrivateRunStore } from "../src/adapters/filesystem.ts";

function error(code: string): Error {
  return Object.assign(new Error(code), { code });
}

for (const scenario of ["term-zombie", "term-absent", "proc-disappears", "kill-zombie", "pre-kill-absent", "term-esrch", "kill-esrch", "replacement-live", "replacement-zombie", "field-mismatch", "ambiguous", "malformed", "permission", "io", "kill-ambiguous", "proc-missing-live", "term-esrch-unproven", "kill-esrch-unproven", "pre-kill-mismatch", "kill-replacement", "kill-field-mismatch", "term-environment-zombie", "term-executable-zombie", "kill-absent"] as const) {
  test(`reclaim exit observation: ${scenario}`, { skip: process.platform !== "linux" }, async (t) => {
    const boundary = await realpath(await mkdtemp(join(tmpdir(), "agtmai-reclaim-observation-")));
    const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
    const originalRead = fs.readFile; const originalRealpath = fs.realpath; const originalKill = process.kill;
    const pid = 2_000_000_000; const signals: string[] = []; let polls = 0; let absent = false; let clock = 0; let authenticatedReads = 0; let signalledReads = 0; let lastProcRead = "";
    try {
      const paths = await store.create(); const marker = join(paths.directory, ".agtmai-local-solana-lease.json");
      const lease = JSON.parse(await readFile(marker, "utf8")); lease.processStart = "linux:0";
      const executable = await realpath(process.execPath);
      const command = Buffer.from(["validator", "--ledger", paths.ledger, "--bind-address", "127.0.0.1", "--rpc-port", "30000", ""].join("\0"));
      lease.validator = { pid, platform: "linux", startTime: "linux:123", executable, ledger: paths.ledger, commandHash: createHash("sha256").update(command).digest("hex"), bindAddress: "127.0.0.1", rpcPort: 30000, leaseTokenHash: createHash("sha256").update(lease.token).digest("hex") };
      await writeFile(marker, JSON.stringify(lease)); await writeFile(paths.payerKey, "PRESERVED_SENTINEL");
      t.mock.method(Date, "now", () => { clock += 1000; return clock; });
      t.mock.method(process, "kill", (target: number, signal: number | string = 0) => {
        if (target !== pid) { return originalKill(target, signal as NodeJS.Signals); }
        if (signal === 0) { if (absent) { throw error("ESRCH"); } return true; }
        assert.equal(lastProcRead, `/proc/${pid}/environ`, "signal must immediately follow full authentication");
        assert.ok(authenticatedReads > signalledReads, "every signal requires fresh full identity observation"); signalledReads = authenticatedReads;
        signals.push(String(signal)); polls = 0;
        if (scenario === "term-esrch-unproven" || (scenario === "kill-esrch-unproven" && signals.length === 2)) { throw error("ESRCH"); }
        if (scenario === "term-esrch" || (scenario === "kill-esrch" && signals.length === 2)) { absent = true; throw error("ESRCH"); }
        return true;
      });
      t.mock.method(fs, "realpath", new Proxy(originalRealpath, { apply(method, receiver, args) {
        if (args[0] === `/proc/${pid}/exe`) {
          if (signals.length > 0 && scenario === "term-executable-zombie") { return Promise.reject(error("ENOENT")); }
          return Promise.resolve(executable);
        }
        return Reflect.apply(method, receiver, args);
      } }));
      function renderStat(post: boolean, killing: boolean): Promise<string> {
        const replacement = post && (scenario.startsWith("replacement-") || (scenario === "kill-replacement" && killing));
        const zombie = post && ((["term-zombie", "term-environment-zombie", "term-executable-zombie"].includes(scenario) && polls >= 4) || (scenario === "kill-zombie" && killing && polls >= 4) || scenario === "replacement-zombie");
        return Promise.resolve(`${pid} (validator) ${[zombie ? "Z" : "R", ...Array(18).fill("0"), replacement ? "456" : "123"].join(" ")}`);
      }
      function readStat(post: boolean, killing: boolean): Promise<string> {
        if (post) { polls += 1; }
        if (post && scenario === "proc-missing-live") { return Promise.reject(error("ENOENT")); }
        if (post && scenario === "proc-disappears") { absent = true; return Promise.reject(error("ENOENT")); }
        if (post && ["malformed", "permission", "io"].includes(scenario)) {
          return scenario === "malformed" ? Promise.resolve("malformed") : Promise.reject(error(scenario === "permission" ? "EACCES" : "EIO"));
      }
      if (post && (scenario === "term-absent" || (scenario === "kill-absent" && killing)) && polls >= 4) { absent = true; return Promise.reject(error("ESRCH")); }
      return renderStat(post, killing);
      }
      function readCommand(post: boolean, killing: boolean): Promise<Buffer> {
        if (post && scenario === "pre-kill-absent" && clock >= 6000) { absent = true; return Promise.reject(error("ESRCH")); }
        if (post && (["term-zombie", "term-absent", "ambiguous"].includes(scenario) || (killing && ["kill-zombie", "kill-ambiguous", "kill-absent"].includes(scenario)))) { return Promise.reject(error("ESRCH")); }
        if (post && scenario === "term-environment-zombie") { return Promise.resolve(Buffer.alloc(0)); }
        return Promise.resolve(command);
      }
      function readEnvironment(post: boolean, killing: boolean): Promise<Buffer> {
        if (post && scenario === "term-environment-zombie") { return Promise.reject(error("ESRCH")); }
        authenticatedReads += 1;
        const mismatch = post && (scenario === "field-mismatch" || (scenario === "kill-field-mismatch" && killing) || (scenario === "pre-kill-mismatch" && clock >= 6000));
        return Promise.resolve(Buffer.from(`AGTMAI_LOCAL_SOLANA_LEASE_TOKEN=${mismatch ? "wrong" : lease.token}\0`));
      }
      t.mock.method(fs, "readFile", new Proxy(originalRead, { apply(method, receiver, args) {
        const path = String(args[0]); if (!path.startsWith(`/proc/${pid}/`)) { return Reflect.apply(method, receiver, args); }
        lastProcRead = path;
        const post = signals.length > 0;
        const killing = signals.length === 2;
        if (path.endsWith("/stat")) { return readStat(post, killing); }
        if (path.endsWith("/cmdline")) { return readCommand(post, killing); }
        if (path.endsWith("/environ")) { return readEnvironment(post, killing); }
        throw new Error(`unexpected proc read: ${path}`);
      } }));
      syncBuiltinESMExports();
      const rejected = ["replacement-live", "replacement-zombie", "field-mismatch", "ambiguous", "malformed", "permission", "io", "kill-ambiguous", "proc-missing-live", "term-esrch-unproven", "kill-esrch-unproven", "pre-kill-mismatch", "kill-replacement", "kill-field-mismatch"].includes(scenario);
      if (rejected) {
        await assert.rejects(store.reclaimStale(), /SOLANA_RECLAIM_(IDENTITY|TIMEOUT)|ESRCH/u);
        assert.equal(await readFile(paths.payerKey, "utf8"), "PRESERVED_SENTINEL");
        assert.equal((await lstat(paths.directory, { bigint: true })).ino.toString(), paths.directoryIdentity.ino);
        assert.equal(await readFile(marker, "utf8"), JSON.stringify(lease));
      } else { assert.equal(await store.reclaimStale(), 1); await assert.rejects(lstat(paths.directory), { code: "ENOENT" }); }
      assert.deepEqual(signals, scenario.startsWith("kill-") ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"]);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(boundary, { recursive: true, force: true }); }
  });
}
