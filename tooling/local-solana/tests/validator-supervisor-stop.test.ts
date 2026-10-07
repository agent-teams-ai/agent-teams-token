import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrivateRunStore } from "../src/adapters/filesystem.ts";
import { reserveStartupCustody } from "../src/adapters/startup-custody.ts";

test("marker ENOSPC during stopping still terminates the authenticated child and retains uncertainty", { skip: process.platform !== "linux", timeout: 10_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-supervisor-stop-")));
  const paths = await new PrivateRunStore(join(root, "runs"), join(root, "out")).create();
  const custody = await reserveStartupCustody(paths.ledger, paths.leaseToken);
  const supervisor = fork(join(import.meta.dirname, "../src/adapters/validator-supervisor.ts"), [], {
    execArgv: ["--import", join(import.meta.dirname, "helpers/fail-stopping-write.ts")],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let childPid: number | undefined;
  try {
    const spawned = new Promise<number>((resolve, reject) => {
      supervisor.on("message", (message: { type: string; pid?: number }) => {
        if (message.type === "spawned" && message.pid !== undefined) { resolve(message.pid); }
        if (message.type === "startupFailure") { reject(new Error("fixture failed before stop")); }
      });
    });
    supervisor.send({ type: "start", executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)", "--", "--ledger", paths.ledger, "--bind-address", "127.0.0.1", "--rpc-port", "30000"], env: {}, custody, leaseToken: paths.leaseToken });
    childPid = await spawned;
    const closed = once(supervisor, "close").then(() => true);
    supervisor.send({ type: "stop" });
    const exited = await Promise.race([closed, new Promise<false>((resolve) => { setTimeout(() => resolve(false), 2_500); })]);
    assert.equal(exited, true, "supervisor must finish bounded stop after marker failure");
    assert.throws(() => { process.kill(childPid!, 0); }, { code: "ESRCH" });
    const marker = JSON.parse(await readFile(join(paths.directory, ".agtmai-validator-startup.json"), "utf8")) as { settled: boolean };
    assert.equal(marker.settled, false);
  } finally {
    if (childPid !== undefined) { try { process.kill(childPid, "SIGKILL"); } catch {} }
    if (supervisor.exitCode === null && supervisor.signalCode === null) { supervisor.kill("SIGKILL"); }
    await rm(root, { recursive: true, force: true });
  }
});

test("rejected spawned stage cannot bypass authenticated child termination", { skip: process.platform !== "linux", timeout: 10_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-supervisor-start-fail-")));
  const paths = await new PrivateRunStore(join(root, "runs"), join(root, "out")).create();
  const custody = await reserveStartupCustody(paths.ledger, paths.leaseToken);
  const pidFile = join(paths.directory, "spawned-pid");
  const supervisor = fork(join(import.meta.dirname, "../src/adapters/validator-supervisor.ts"), [], {
    execArgv: ["--import", join(import.meta.dirname, "helpers/fail-stopping-write.ts")],
    env: { ...process.env, AGTMAI_TEST_FAIL_STAGE: "spawned", AGTMAI_TEST_PID_FILE: pidFile },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let childPid: number | undefined;
  try {
    const closed = once(supervisor, "close").then(() => true);
    const failed = new Promise<void>((resolve) => {
      supervisor.on("message", (message: { type: string }) => { if (message.type === "startupFailure") { resolve(); } });
    });
    const script = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
    supervisor.send({ type: "start", executable: process.execPath, args: ["-e", script, "--", pidFile, "--ledger", paths.ledger, "--bind-address", "127.0.0.1", "--rpc-port", "30000"], env: {}, custody, leaseToken: paths.leaseToken });
    await failed;
    childPid = Number(await readFile(pidFile, "utf8"));
    const exited = await Promise.race([closed, new Promise<false>((resolve) => { setTimeout(() => resolve(false), 2_500); })]);
    assert.equal(exited, true, "supervisor must stop even when starting rejects after spawn");
    assert.throws(() => { process.kill(childPid!, 0); }, { code: "ESRCH" });
  } finally {
    if (childPid !== undefined) { try { process.kill(childPid, "SIGKILL"); } catch {} }
    if (supervisor.exitCode === null && supervisor.signalCode === null) { supervisor.kill("SIGKILL"); }
    await rm(root, { recursive: true, force: true });
  }
});

test("timed out spawned stage still stops its authenticated child", { skip: process.platform !== "linux", timeout: 12_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-supervisor-start-hang-")));
  const paths = await new PrivateRunStore(join(root, "runs"), join(root, "out")).create();
  const custody = await reserveStartupCustody(paths.ledger, paths.leaseToken);
  const pidFile = join(paths.directory, "spawned-pid");
  const supervisor = fork(join(import.meta.dirname, "../src/adapters/validator-supervisor.ts"), [], {
    execArgv: ["--import", join(import.meta.dirname, "helpers/fail-stopping-write.ts")],
    env: { ...process.env, AGTMAI_TEST_HANG_STAGE: "spawned", AGTMAI_TEST_PID_FILE: pidFile },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let childPid: number | undefined;
  try {
    const closed = once(supervisor, "close").then(() => true);
    const script = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
    supervisor.send({ type: "start", executable: process.execPath, args: ["-e", script, "--", pidFile, "--ledger", paths.ledger, "--bind-address", "127.0.0.1", "--rpc-port", "30000"], env: {}, custody, leaseToken: paths.leaseToken });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observedPid = await readFile(pidFile, "utf8").then(Number, () => null);
      if (observedPid !== null) { childPid = observedPid; break; }
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    assert.ok(childPid, "fixture child must be live before stop");
    supervisor.send({ type: "stop" });
    const exited = await Promise.race([closed, new Promise<false>((resolve) => { setTimeout(() => resolve(false), 5_000); })]);
    assert.equal(exited, true, "supervisor must stop after the starting write times out");
    assert.throws(() => { process.kill(childPid!, 0); }, { code: "ESRCH" });
    const marker = JSON.parse(await readFile(join(paths.directory, ".agtmai-validator-startup.json"), "utf8")) as { settled: boolean };
    assert.equal(marker.settled, false);
  } finally {
    if (childPid !== undefined) { try { process.kill(childPid, "SIGKILL"); } catch {} }
    if (supervisor.exitCode === null && supervisor.signalCode === null) { supervisor.kill("SIGKILL"); }
    await rm(root, { recursive: true, force: true });
  }
});

test("captured validator identity permits stop after first child start observation fails", { skip: process.platform !== "linux", timeout: 10_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-supervisor-start-id-")));
  const paths = await new PrivateRunStore(join(root, "runs"), join(root, "out")).create();
  const custody = await reserveStartupCustody(paths.ledger, paths.leaseToken);
  const pidFile = join(paths.directory, "spawned-pid");
  const supervisor = fork(join(import.meta.dirname, "../src/adapters/validator-supervisor.ts"), [], {
    execArgv: ["--import", join(import.meta.dirname, "helpers/fail-stopping-write.ts")],
    env: { ...process.env, AGTMAI_TEST_FAIL_STAGE: "spawned", AGTMAI_TEST_PID_FILE: pidFile, AGTMAI_TEST_FAIL_FIRST_STAT: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let childPid: number | undefined;
  try {
    const closed = once(supervisor, "close").then(() => true);
    const failed = new Promise<void>((resolve) => {
      supervisor.on("message", (message: { type: string }) => { if (message.type === "startupFailure") { resolve(); } });
    });
    const script = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
    supervisor.send({ type: "start", executable: process.execPath, args: ["-e", script, "--", pidFile, "--ledger", paths.ledger, "--bind-address", "127.0.0.1", "--rpc-port", "30000"], env: {}, custody, leaseToken: paths.leaseToken });
    await failed;
    childPid = Number(await readFile(pidFile, "utf8"));
    const exited = await Promise.race([closed, new Promise<false>((resolve) => { setTimeout(() => resolve(false), 3_000); })]);
    assert.equal(exited, true, "authenticated capture must recover a failed first start observation");
    assert.throws(() => { process.kill(childPid!, 0); }, { code: "ESRCH" });
  } finally {
    if (childPid !== undefined) { try { process.kill(childPid, "SIGKILL"); } catch {} }
    if (supervisor.exitCode === null && supervisor.signalCode === null) { supervisor.kill("SIGKILL"); }
    await rm(root, { recursive: true, force: true });
  }
});
