import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const POLL_MS = 50;
const REAP_MS = 5_000;

function linuxProcesses() {
  const rows = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/u.test(name)) {continue;}
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      rows.push({ pid: Number(name), state: fields[0], ppid: Number(fields[1]),
        group: Number(fields[2]), session: Number(fields[3]), identity: fields[19] });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") {throw error;}
    }
  }
  return rows;
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The private session is used for discovery only. Signals always name a PID
// whose kernel start time was observed, never a process group or a guessed PID.
export async function superviseCommand(config, adapter = {}) {
  const list = adapter.list ?? linuxProcesses;
  const launch = adapter.spawn ?? spawn;
  const signal = adapter.kill ?? process.kill.bind(process);
  const now = adapter.now ?? Date.now;
  const wait = adapter.wait ?? pause;
  const supported = adapter.supported ?? process.platform === "linux";
  const child = launch(config.command, config.arguments, {
    cwd: config.cwd, env: config.environment,
    detached: process.platform !== "win32",
    stdio: [config.input === undefined ? "ignore" : "pipe", 3, 4],
  });
  if (config.input !== undefined) {child.stdin.end(Buffer.from(config.input, "base64"));}
  const owned = new Map();
  let rootIdentity;
  let rootSession;
  let observationError;
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  let spawnError;
  child.on("error", (error) => {spawnError = { code: error.code, message: error.message }; exited = true;});
  child.on("exit", (code, sig) => {exited = true; exitCode = code; exitSignal = sig;});
  const started = now();
  function observe() {
    if (!supported) {return;}
    try {
      const rows = list();
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      const root = byPid.get(child.pid);
      if (rootIdentity === undefined && root !== undefined) {
        rootIdentity = root.identity;
        rootSession = root.session;
        owned.set(root.pid, root.identity);
      }
      if (root !== undefined && rootIdentity !== root.identity) {
        throw new Error("ROLLBACK_PROCESS_ROOT_IDENTITY_CHANGED");
      }
      // Walk both parent links and the private session. The latter retains
      // ordinary wrapper descendants after their immediate parent exits.
      let changed;
      do {
        changed = false;
        for (const row of rows) {
          if (owned.has(row.pid)) {continue;}
          if ((rootIdentity !== undefined && row.group === child.pid && row.session === rootSession)
            || (owned.has(row.ppid) && owned.get(row.ppid) === byPid.get(row.ppid)?.identity)) {
            owned.set(row.pid, row.identity);
            changed = true;
          }
        }
      } while (changed);
      return rows;
    } catch (error) {
      observationError = error.message;
      return undefined;
    }
  }
  // A normal exit has no reason to send a signal; close confirms that direct
  // stdio writers have finished before the parent hashes the logs.
  let closed = false;
  child.on("close", () => {closed = true;});
  while (!closed && now() - started < config.timeout) {
    observe();
    await wait(POLL_MS);
  }
  const completionRows = observe();
  const liveAtClose = completionRows?.some((row) =>
    owned.get(row.pid) === row.identity && row.state !== "Z");
  if (closed && !liveAtClose) {
    return { status: exitCode, signal: exitSignal, error: spawnError,
      custody: observationError === undefined ? "completed" : "uncertain",
      uncertainty: observationError, ownedPids: [...owned.keys()] };
  }
  const deadline = now() + REAP_MS;
  const signalled = new Set();
  let escalation = false;
  while (now() < deadline) {
    const rows = observe();
    const byPid = new Map((rows ?? []).map((row) => [row.pid, row]));
    const live = [...owned].filter(([pid, identity]) => {
      const row = byPid.get(pid);
      return row !== undefined && row.identity === identity && row.state !== "Z";
    });
    // The direct child is held by a ChildProcess handle even if /proc could
    // not be read. Do not infer authority over any other PID in that case.
    if (!supported || rows === undefined || rootIdentity === undefined) {
      if (!exited) {child.kill(escalation ? "SIGKILL" : "SIGTERM");}
      observationError ??= supported ? "ROLLBACK_PROCESS_ROOT_UNOBSERVED" : "ROLLBACK_PROCESS_PLATFORM_UNSUPPORTED";
    } else {
      for (const [pid, identity] of live.toReversed()) {
        try {
          // A stale PID is never authority. Recheck immediately before each
          // signal, including after a previous signal could have exited a peer.
          const current = list().find((row) => row.pid === pid);
          if (current === undefined || current.state === "Z") {continue;}
          if (current.identity !== identity) {
            observationError = "ROLLBACK_PROCESS_IDENTITY_CHANGED";
            continue;
          }
          signal(pid, escalation ? "SIGKILL" : "SIGTERM");
          signalled.add(pid);
        } catch (error) {
          if (error.code !== "ESRCH") {observationError = error.message;}
        }
      }
    }
    if (exited && live.length === 0 && rows !== undefined) {
      // One last observation catches children spawned during termination.
      await wait(POLL_MS);
      const finalRows = observe();
      const remaining = finalRows?.some((row) => owned.get(row.pid) === row.identity && row.state !== "Z");
      if (finalRows !== undefined && !remaining) {
        return { status: exitCode, signal: exitSignal, error: { code: "ETIMEDOUT" },
          custody: observationError === undefined ? "reaped" : "uncertain",
          uncertainty: observationError, ownedPids: [...owned.keys()], signalledPids: [...signalled] };
      }
    }
    escalation = now() > deadline - REAP_MS / 2;
    await wait(POLL_MS);
  }
  // No success claim if observation or termination could not be confirmed.
  return { status: exitCode, signal: exitSignal, error: { code: "ETIMEDOUT" },
    custody: "uncertain", uncertainty: observationError ?? "ROLLBACK_PROCESS_REAP_UNCONFIRMED",
    ownedPids: [...owned.keys()], signalledPids: [...signalled] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let body = "";
  for await (const chunk of process.stdin) {body += chunk;}
  try {
    const result = await superviseCommand(JSON.parse(body));
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: null, signal: null,
      error: { code: error.code ?? "ESUPERVISOR", message: error.message },
      custody: "uncertain", uncertainty: error.message }));
  }
}
