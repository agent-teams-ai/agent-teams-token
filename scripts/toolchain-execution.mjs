/* oxlint-disable max-lines */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseNativeSupervisorReport,
  prepareNativeSupervisor,
  superviseCommand,
} from "./rollback/runtime/process-supervisor.mjs";

const SUPERVISOR_ARGUMENT = "--agtmai-toolchain-process-supervisor";
const TERM_GRACE_MS = 250;
const KILL_GRACE_MS = 1_000;

function typedError(code, detail = "") {return new Error(`${code}${detail ? ` ${detail}` : ""}`);}

function checkedRegularDescriptor(fd) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) {throw typedError("TOOLCHAIN_FILE_IDENTITY_INVALID");}
  return stat;
}

function sameIdentity(left, right) {return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;}

function sameFileMetadata(left, right) {
  return sameIdentity(left, right)
    && left.nlink === 1 && right.nlink === 1
    && left.size === right.size
    && (left.mode & 0o777) === (right.mode & 0o777);
}

function hashDescriptor(fd) {
  const before = checkedRegularDescriptor(fd);
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < before.size) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
    if (count === 0) {throw typedError("TOOLCHAIN_FILE_IDENTITY_CHANGED");}
    hash.update(chunk.subarray(0, count));
    offset += count;
  }
  const after = checkedRegularDescriptor(fd);
  if (!sameFileMetadata(before, after)) {throw typedError("TOOLCHAIN_FILE_IDENTITY_CHANGED");}
  return hash.digest("hex");
}

function openExpectedFile(path, expectedHash) {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const identity = checkedRegularDescriptor(fd);
    const actual = hashDescriptor(fd);
    if (actual !== expectedHash) {
      throw typedError("TOOLCHAIN_EXECUTABLE_CHECKSUM", `expected=${expectedHash} actual=${actual}`);
    }
    return { fd, expectedHash, identity, path };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertPathStillIdentifies(opened) {
  let current;
  try {current = lstatSync(opened.path);} catch {throw typedError("TOOLCHAIN_FILE_IDENTITY_CHANGED");}
  if (!sameFileMetadata(opened.identity, current)) {throw typedError("TOOLCHAIN_FILE_IDENTITY_CHANGED");}
}

function assertOpenedFileStillMatches(opened, expectedHash, errorCode) {
  if (hashDescriptor(opened.fd) !== expectedHash) {throw typedError(errorCode);}
  assertPathStillIdentifies(opened);
}

function sameDirectoryIdentity(left, right) {return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino;}

function assertPrivateDirectory(path, identity) {
  const current = lstatSync(path);
  const owned = typeof process.getuid !== "function" || current.uid === process.getuid();
  if (!sameDirectoryIdentity(identity, current) || !owned || (current.mode & 0o777) !== 0o700) {
    throw typedError("TOOLCHAIN_INVOCATION_DIRECTORY_INVALID");
  }
}

function createPrivateDirectory(path) {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  const identity = lstatSync(path);
  assertPrivateDirectory(path, identity);
  return { identity, path };
}

function createControlledFile(path, contents = "") {
  const fd = openSync(
    path,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (Buffer.isBuffer(contents)) {writeSync(fd, contents, 0, contents.length, 0);}
    else if (contents) {writeSync(fd, contents, 0, "utf8");}
    fchmodSync(fd, 0o600);
    const identity = checkedRegularDescriptor(fd);
    return { expectedHash: hashDescriptor(fd), fd, identity, path };
  } catch (error) {
    const failures = [error];
    try {closeSync(fd);} catch (closeError) {failures.push(closeError);}
    if (failures.length > 1) {
      throw new AggregateError(failures, "TOOLCHAIN_FILE_ACQUISITION_FAILED", { cause: error });
    }
    throw error;
  }
}

function writeAuthenticatedSnapshot(root, opened, leaf) {
  const path = join(root, leaf);
  const fd = openSync(
    path,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o400,
  );
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < opened.identity.size) {
      const count = readSync(opened.fd, chunk, 0, Math.min(chunk.length, opened.identity.size - offset), offset);
      if (count === 0) {throw typedError("TOOLCHAIN_FILE_IDENTITY_CHANGED");}
      let written = 0;
      while (written < count) {written += writeSync(fd, chunk, written, count - written, offset + written);}
      offset += count;
    }
    fchmodSync(fd, 0o400);
    checkedRegularDescriptor(fd);
    if (hashDescriptor(fd) !== opened.expectedHash) {throw typedError("TOOLCHAIN_SNAPSHOT_FILE_INVALID");}
  } catch (error) {
    const failures = [error];
    try {closeSync(fd);} catch (closeError) {failures.push(closeError);}
    if (failures.length > 1) {
      throw new AggregateError(failures, "TOOLCHAIN_FILE_ACQUISITION_FAILED", { cause: error });
    }
    throw error;
  }
  closeSync(fd);
  return openExpectedFile(path, opened.expectedHash);
}

function createInvocation(entries, platform) {
  const root = mkdtempSync(join(tmpdir(), "agtmai-toolchain-exec-"));
  chmodSync(root, 0o700);
  const rootIdentity = lstatSync(root);
  const directories = [];
  const files = [];
  try {
    assertPrivateDirectory(root, rootIdentity);
    const home = createPrivateDirectory(join(root, "home"));
    const config = createPrivateDirectory(join(root, "config"));
    const cache = createPrivateDirectory(join(root, "cache"));
    const data = createPrivateDirectory(join(root, "data"));
    const state = createPrivateDirectory(join(root, "state"));
    const runtime = createPrivateDirectory(join(root, "runtime"));
    const pnpmHome = createPrivateDirectory(join(root, "pnpm-home"));
    const corepackHome = createPrivateDirectory(join(root, "corepack-home"));
    directories.push(home, config, cache, data, state, runtime, pnpmHome, corepackHome);
    const npmrc = createControlledFile(join(root, "npmrc"));
    files.push(npmrc);
    const npmGlobalrc = createControlledFile(join(root, "npm-globalrc"));
    files.push(npmGlobalrc);
    const status = createControlledFile(join(root, "supervisor-status"));
    files.push(status);
    const snapshots = platform === "darwin"
      ? entries.map((entry) => {
        const snapshot = entry.snapshotOnDarwin
          ? writeAuthenticatedSnapshot(root, entry.opened, entry.leaf)
          : undefined;
        if (snapshot) {files.push(snapshot);}
        return snapshot;
      })
      : [];
    for (const [index, snapshot] of snapshots.entries()) {
      if (!snapshot) {continue;}
      if (snapshot.expectedHash !== entries[index].expectedHash
        || !sameIdentity(snapshot.identity, fstatSync(snapshot.fd))
        || (snapshot.identity.mode & 0o777) !== 0o400) {
        throw typedError("TOOLCHAIN_SNAPSHOT_FILE_INVALID");
      }
    }
    for (const entry of entries) {
      assertOpenedFileStillMatches(entry.opened, entry.expectedHash, "TOOLCHAIN_FILE_IDENTITY_CHANGED");
    }
    return {
      directories,
      env: {
        HOME: home.path,
        XDG_CONFIG_HOME: config.path,
        XDG_CACHE_HOME: cache.path,
        XDG_DATA_HOME: data.path,
        XDG_STATE_HOME: state.path,
        XDG_RUNTIME_DIR: runtime.path,
        PNPM_HOME: pnpmHome.path,
        COREPACK_HOME: corepackHome.path,
        npm_config_cache: cache.path,
        NPM_CONFIG_CACHE: cache.path,
        npm_config_userconfig: npmrc.path,
        NPM_CONFIG_USERCONFIG: npmrc.path,
        npm_config_globalconfig: npmGlobalrc.path,
        NPM_CONFIG_GLOBALCONFIG: npmGlobalrc.path,
      },
      files,
      root,
      rootIdentity,
      snapshots,
      status,
    };
  } catch (error) {
    const failures = [error];
    // Each successful acquisition is registered immediately. Attempt every
    // owner once, even if an earlier close consumed its FD and then threw.
    for (const file of files) {
      try {closeSync(file.fd);} catch (closeError) {failures.push(closeError);}
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, `TOOLCHAIN_INVOCATION_ACQUISITION_FAILED invocation=${root}`, { cause: error });
    }
    throw error;
  }
}

function minimalSubprocessEnv(invocation, executableDirectories = []) {
  return {
    PATH: [...executableDirectories, "/usr/bin", "/bin"].join(":"),
    ...invocation.env,
    LANG: "C",
    LC_ALL: "C",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    NO_UPDATE_NOTIFIER: "1",
    npm_config_update_notifier: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    pnpm_config_verify_deps_before_run: "false",
    PNPM_DISABLE_SELF_UPDATE_CHECK: "1",
  };
}

function validateInvocationFile(file, errorCode) {
  const descriptor = fstatSync(file.fd);
  if (!sameFileMetadata(file.identity, descriptor)
    || (descriptor.mode & 0o777) !== (file.identity.mode & 0o777)
    || hashDescriptor(file.fd) !== file.expectedHash) {
    throw typedError(errorCode);
  }
  const pathFd = openSync(file.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const pathname = fstatSync(pathFd);
    if (!sameFileMetadata(file.identity, pathname)
      || hashDescriptor(pathFd) !== file.expectedHash) {
      throw typedError(errorCode);
    }
  } finally {
    closeSync(pathFd);
  }
}

function sameNodeMetadata(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
    && left.size === right.size && left.mode === right.mode && left.uid === right.uid;
}

function sameOwnedDirectory(left, right) {
  return sameDirectoryIdentity(left, right) && left.mode === right.mode && left.uid === right.uid;
}

function hashPathNoFollow(path) {
  const opened = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {return hashDescriptor(opened);} finally {closeSync(opened);}
}

function snapshotOwnedTree(root) {
  const nodes = [];
  const visit = (path) => {
    const identity = lstatSync(path);
    const owned = typeof process.getuid !== "function" || identity.uid === process.getuid();
    if (!owned || (!identity.isDirectory() && !identity.isFile() && !identity.isSymbolicLink())) {
      throw typedError("TOOLCHAIN_INVOCATION_TREE_INVALID");
    }
    let expectedHash;
    let leaves;
    if (identity.isDirectory()) {
      leaves = readdirSync(path).toSorted();
      for (const leaf of leaves) {visit(join(path, leaf));}
    } else if (identity.isFile()) {
      if (identity.nlink !== 1) {throw typedError("TOOLCHAIN_INVOCATION_TREE_INVALID");}
      expectedHash = hashPathNoFollow(path);
    }
    nodes.push({ expectedHash, identity, leaves, path });
  };
  visit(root);
  return nodes;
}

function validateOwnedTree(nodes) {
  for (const node of nodes) {
    const current = lstatSync(node.path);
    if (current.isDirectory()) {
      if (!sameOwnedDirectory(node.identity, current)) {throw typedError("TOOLCHAIN_INVOCATION_TREE_INVALID");}
      if (JSON.stringify(readdirSync(node.path).toSorted()) !== JSON.stringify(node.leaves)) {
        throw typedError("TOOLCHAIN_INVOCATION_TREE_INVALID");
      }
    } else {
      if (!sameNodeMetadata(node.identity, current)) {throw typedError("TOOLCHAIN_INVOCATION_TREE_INVALID");}
      if (current.isFile() && hashPathNoFollow(node.path) !== node.expectedHash) {
        throw typedError("TOOLCHAIN_INVOCATION_TREE_INVALID");
      }
    }
  }
}

function removeOwnedTree(nodes) {
  for (const node of nodes) {
    const current = lstatSync(node.path);
    if (current.isDirectory()) {
      if (!sameOwnedDirectory(node.identity, current) || readdirSync(node.path).length !== 0) {
        throw typedError("TOOLCHAIN_INVOCATION_TREE_INVALID");
      }
      rmdirSync(node.path);
    } else {
      if (!sameNodeMetadata(node.identity, current)) {throw typedError("TOOLCHAIN_INVOCATION_TREE_INVALID");}
      unlinkSync(node.path);
    }
  }
}

function removeInvocation(invocation, quiescent) {
  if (!quiescent) {return false;}
  try {
    assertPrivateDirectory(invocation.root, invocation.rootIdentity);
    for (const directory of invocation.directories) {assertPrivateDirectory(directory.path, directory.identity);}
    for (const file of invocation.files) {
      validateInvocationFile(file, file.expectedHash === invocation.status.expectedHash
        ? "TOOLCHAIN_INVOCATION_STATUS_INVALID"
        : "TOOLCHAIN_SNAPSHOT_FILE_INVALID");
    }
    const expectedRootLeaves = [
      ...invocation.directories.map(({ path }) => path.slice(invocation.root.length + 1)),
      ...invocation.files.map(({ path }) => path.slice(invocation.root.length + 1)),
    ].toSorted();
    if (JSON.stringify(readdirSync(invocation.root).toSorted()) !== JSON.stringify(expectedRootLeaves)) {return false;}
    const environmentTrees = invocation.directories.map(({ path }) => snapshotOwnedTree(path));
    for (const tree of environmentTrees) {validateOwnedTree(tree);}
    for (const tree of environmentTrees) {removeOwnedTree(tree);}
    for (const file of invocation.files) {unlinkSync(file.path);}
    assertPrivateDirectory(invocation.root, invocation.rootIdentity);
    rmdirSync(invocation.root);
    return true;
  } catch (error) {
    throw new Error(`TOOLCHAIN_INVOCATION_CLEANUP_UNCERTAIN invocation=${invocation.root}`, { cause: error });
  }
}

function signalGroup(pgid, signal) {
  try {process.kill(-pgid, signal);} catch (error) {if (error?.code !== "ESRCH") {throw error;}}
}

function processGroupMembers(pgid) {
  if (process.platform === "linux") {
    const members = [];
    for (const leaf of readdirSync("/proc")) {
      if (!/^\d+$/.test(leaf)) {continue;}
      try {
        const stat = readFileSync(`/proc/${leaf}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) === pgid && fields[0] !== "Z") {members.push(Number(leaf));}
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error?.code)) {throw error;}
      }
    }
    return members;
  }
  if (process.platform !== "darwin") {throw typedError("TOOLCHAIN_PROCESS_GROUP_INSPECTION_FAILED");}
  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: KILL_GRACE_MS, killSignal: "SIGKILL" });
  if (result.status !== 0) {throw typedError("TOOLCHAIN_PROCESS_GROUP_INSPECTION_FAILED");}
  return result.stdout.split("\n").map((line) => line.trim().split(/\s+/))
    .filter(([pid, group, state]) => Number(pid) > 0 && Number(group) === pgid && !state?.startsWith("Z"))
    .map(([pid]) => Number(pid));
}

function signalProcess(pid, signal) {
  try {process.kill(pid, signal);} catch (error) {if (error?.code !== "ESRCH") {throw error;}}
}

async function terminateProcessGroup(pgid) {
  signalGroup(pgid, "SIGTERM");
  await delay(TERM_GRACE_MS);
  for (const pid of processGroupMembers(pgid)) {
    if (pid !== pgid) {signalProcess(pid, "SIGKILL");}
  }
  await delay(50);
  signalProcess(pgid, "SIGKILL");
}

function delay(milliseconds) {
  return new Promise((resolve) => {setTimeout(resolve, milliseconds);});
}

function writeSupervisorStatus(fd, status) {
  const payload = `${JSON.stringify(status)}\n`;
  ftruncateSync(fd, 0);
  writeSync(fd, payload, 0, "utf8");
}

function writeSupervisorFailure(statusFd, error, child, outcome, timedOut) {
  try {writeSupervisorStatus(statusFd, {
    error: error?.code ?? "ESUPERVISOR", finished: false, supervisorPid: process.pid, pgid: child?.pid, quiescent: false,
    signal: outcome?.signal ?? null, status: outcome?.status ?? null, timedOut,
  });} catch {}
}

async function supervisorMain(encoded) {
  const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  let child;
  let timedOut = false;
  let termination;
  let supervisorError;
  let outcome;
  try {
    writeSupervisorStatus(config.statusFd, {
      error: null, finished: false, quiescent: false, supervisorPid: process.pid,
    });
    child = spawn(config.command, config.args, {
      cwd: config.cwd,
      detached: true,
      env: process.env,
      stdio: config.childStdio,
    });
    writeSupervisorStatus(config.statusFd, {
      error: null, finished: false, pgid: child.pid, quiescent: false, supervisorPid: process.pid,
    });
    outcome = await new Promise((resolve) => {
      const stop = () => {
        termination ??= terminateProcessGroup(child.pid).catch((error) => {supervisorError ??= error;});
      };
      const timer = setTimeout(() => {timedOut = true; stop();}, config.timeoutMs);
      const captureTimer = setInterval(() => {
        try {
          if (config.captureFds.some((fd) => fstatSync(fd).size > config.maxBuffer)) {
            supervisorError ??= { code: "ENOBUFS" };
            stop();
          }
        } catch (error) {supervisorError ??= error; stop();}
      }, 10);
      const finish = (childOutcome) => {
        clearTimeout(timer);
        clearInterval(captureTimer);
        resolve(childOutcome);
      };
      child.once("error", (error) => finish({ error }));
      child.once("exit", (status, signal) => finish({ signal, status }));
    });
    if (termination) {await termination;}
    // The enclosing native subreaper owns settlement, including escaped sessions.
    // Exiting this observer lets native custody detect and reap any leaked child.
    const quiescent = false;
    writeSupervisorStatus(config.statusFd, {
      error: outcome.error?.code ?? (supervisorError ? supervisorError.code ?? "ESUPERVISOR" : null),
      finished: true,
      spawnFailed: outcome.error !== undefined,
      supervisionFailed: supervisorError !== undefined,
      supervisorPid: process.pid,
      pgid: child.pid,
      quiescent,
      signal: outcome.signal ?? null,
      status: outcome.status ?? null,
      timedOut,
    });
    if (supervisorError) {process.exitCode = 125;}
    else if (timedOut) {process.exitCode = 124;}
    else if (outcome.error) {process.exitCode = 126;}
    else if (outcome.signal) {process.exitCode = 128;}
    else {process.exitCode = outcome.status ?? 1;}
  } catch (error) {
    writeSupervisorFailure(config.statusFd, error, child, outcome, timedOut);
    process.exitCode = 125;
  }
}

function readSupervisorStatus(invocation, file = invocation.status) {
  try {
    const descriptor = fstatSync(file.fd);
    if (!sameIdentity(file.identity, descriptor)
      || descriptor.nlink !== 1
      || (descriptor.mode & 0o777) !== 0o600
      || descriptor.size > 4_096) {return;}
    const buffer = Buffer.alloc(descriptor.size);
    if (readSync(file.fd, buffer, 0, buffer.length, 0) !== buffer.length) {return;}
    const payload = buffer.toString("utf8");
    const status = JSON.parse(payload);
    file.expectedHash = createHash("sha256").update(payload).digest("hex");
    file.identity = descriptor;
    return status;
  } catch {return;}
}

function readCapturedOutput(captures, status, maxBuffer, encoding) {
  const output = [null, null, null];
  const captureFailures = [];
  for (const [index, file] of captures.entries()) {
    if (!file) {continue;}
    try {
      file.identity = checkedRegularDescriptor(file.fd);
      if (status?.quiescent === true) {file.expectedHash = hashDescriptor(file.fd);}
      if (index === 0) {continue;}
      if (file.identity.size > maxBuffer && status) {status.error ??= "ENOBUFS";}
      const buffer = Buffer.alloc(Math.min(file.identity.size, maxBuffer));
      const count = readSync(file.fd, buffer, 0, buffer.length, 0);
      output[index] = encoding ? buffer.subarray(0, count).toString(encoding) : buffer.subarray(0, count);
    } catch (error) {captureFailures.push(error);}
  }
  return { output, captureFailures };
}

function fallbackTerminateUncertainGroup(status) {
  const failures = [];
  if (status?.quiescent === true) {return failures;}
  // Exact recorded groups are a best-effort fallback only. Killing them cannot
  // substitute for the missing native report or authorize invocation deletion.
  if (Number.isSafeInteger(status?.pgid) && status.pgid > 1) {
    try {
      signalGroup(status.pgid, "SIGTERM");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TERM_GRACE_MS);
      signalGroup(status.pgid, "SIGKILL");
    } catch (error) {failures.push(error);}
  }
  if (Number.isSafeInteger(status?.supervisorPid) && status.supervisorPid > 1) {
    try {signalGroup(status.supervisorPid, "SIGKILL");} catch (error) {failures.push(error);}
  }
  return failures;
}

function supervisedOutcome(result, status, output, native) {
  const errorCode = status?.timedOut ? "ETIMEDOUT" : status?.error;
  const observedError = errorCode ? Object.assign(new Error(errorCode), { code: errorCode }) : result.error;
  const quiescent = status?.quiescent === true;
  return {
    ...result, error: observedError, output, stdout: output[1], stderr: output[2],
    signal: status?.signal ?? null, status: status?.status ?? null,
    targetStatus: status ?? { quiescent: false },
    custody: !quiescent ? "uncertain"
      : native.custody === "reaped" || status.timedOut || status.error === "ENOBUFS" ? "reaped" : "completed",
    uncertainty: !quiescent ? native?.uncertainty ?? "ROLLBACK_PROCESS_CUSTODY_UNCONFIRMED" : null,
    signalledCount: native?.signalledCount ?? 0,
    // A native report describes the Node observer; without it, retain the
    // native helper's outer watchdog result. Neither is the target outcome.
    supervisorStatus: {
      status: native === undefined ? result.status : native.status,
      signal: native === undefined ? result.signal : native.signal,
      error: result.error?.code ?? (status?.finished !== true && native?.error?.code === "ETIMEDOUT" ? "ETIMEDOUT" : null),
    },
  };
}

function supervisedSpawn({ args, command, cwd, env, input, invocation, stdio, targetFds = [], timeoutMs,
  encoding = "utf8", maxBuffer = 1024 * 1024 }) {
  // File-backed pipes keep the outer sync watchdog bounded even if a lost
  // supervisor leaves a descendant holding its streams open.
  const captures = [];
  let supervisorStdio;
  let nativeStatus;
  let nativeErrors;
  let helper;
  try {
    supervisorStdio = stdio.map((entry, index) => {
      if (entry !== "pipe") {return entry;}
      const file = createControlledFile(join(invocation.root, `stdio-${index}`), index === 0 ? input : "");
      invocation.files.push(file);
      captures[index] = file;
      return file.fd;
    });
    nativeStatus = createControlledFile(join(invocation.root, "native-status"));
    invocation.files.push(nativeStatus);
    nativeErrors = createControlledFile(join(invocation.root, "native-stderr"));
    invocation.files.push(nativeErrors);
    const helperPath = join(invocation.root, "native-subreaper");
    const helperHash = prepareNativeSupervisor(helperPath);
    helper = openExpectedFile(helperPath, helperHash);
    invocation.files.push(helper);
  } catch (error) {
    error.execution = { launched: false, quiescent: true };
    throw error;
  }
  const statusFd = 5 + targetFds.length;
  const config = {
    args,
    captureFds: [1, 2].filter((index) => captures[index]),
    childStdio: [
      ...stdio.map((entry) => entry === "ignore" ? "ignore" : "inherit"),
      ...targetFds.map((_, index) => index + 5),
    ],
    command,
    cwd,
    maxBuffer,
    statusFd,
    timeoutMs,
  };
  const result = superviseCommand({
    command: process.execPath,
    arguments: [fileURLToPath(import.meta.url), SUPERVISOR_ARGUMENT,
      Buffer.from(JSON.stringify(config)).toString("base64url")],
    environment: env,
    cwd,
    // Native stdout/stderr are private files. The C root redirects 3/4 to
    // the observer's 1/2; authenticated target FDs survive at 5+, then are
    // remapped by the observer back to the target's original 3+ contract.
    stdio: [supervisorStdio[0], nativeStatus.fd, nativeErrors.fd,
      supervisorStdio[1], supervisorStdio[2], ...targetFds, invocation.status.fd, helper.fd],
    executableFd: statusFd + 1,
    timeout: timeoutMs + 1_000,
    outerTimeout: timeoutMs + TERM_GRACE_MS + KILL_GRACE_MS + 2_000,
  });
  const recorded = readSupervisorStatus(invocation);
  let native;
  try {native = parseNativeSupervisorReport(readSupervisorStatus(invocation, nativeStatus));} catch {}
  const settled = native !== undefined && native.custody !== "uncertain" && native.uncertainty === null;
  const recordedOutcome = recorded?.finished === true
    && typeof recorded.timedOut === "boolean" && typeof recorded.spawnFailed === "boolean"
    && typeof recorded.supervisionFailed === "boolean"
    && Number.isSafeInteger(recorded.supervisorPid) && recorded.supervisorPid > 1
    && (recorded.error === null || (typeof recorded.error === "string" && /^E[A-Z0-9]+$/u.test(recorded.error)))
    && (recorded.status === null || (Number.isInteger(recorded.status) && recorded.status >= 0 && recorded.status <= 255))
    && (recorded.signal === null || (typeof recorded.signal === "string" && /^SIG[A-Z0-9]+$/u.test(recorded.signal)))
    && (recorded.status === null || recorded.signal === null)
    && (recorded.status !== null || recorded.signal !== null || recorded.error !== null);
  const observerExit = !recordedOutcome ? undefined
    : recorded.supervisionFailed ? 125 : recorded.timedOut ? 124 : recorded.spawnFailed ? 126
      : recorded.signal !== null ? 128 : recorded.status ?? 1;
  const finished = recordedOutcome && native?.signal === null && native.status === observerExit;
  const status = {
    ...recorded,
    finished,
    error: recordedOutcome ? recorded.error ?? native?.error?.code ?? result.error?.code ?? null
      : result.error?.code ?? native?.error?.code ?? "ESUPERVISOR",
    quiescent: finished && settled && result.error === undefined && result.status === 0 && result.signal === null,
    // An observed target outcome survives a later native drain/watchdog loss.
    // It still cannot authorize success or cleanup without matched settlement.
    status: recordedOutcome ? recorded.status : null,
    signal: recordedOutcome ? recorded.signal : null,
    timedOut: recorded?.timedOut === true || result.error?.code === "ETIMEDOUT" || native?.error?.code === "ETIMEDOUT",
  };
  // Refresh both private protocol files only after their bounded readers have
  // verified identities. Missing/corrupt native custody always stays uncertain.
  // ECHILD already rules out surviving owned groups, even if the command
  // observer was lost. Do not signal stale IDs in that case; overall custody
  // remains uncertain and cannot authorize removal without the observer.
  const kernelSettled = settled && result.error === undefined && result.status === 0 && result.signal === null;
  const failures = fallbackTerminateUncertainGroup(kernelSettled ? { ...status, quiescent: true } : status);
  const { output, captureFailures } = readCapturedOutput(captures, status, maxBuffer, encoding);
  try {
    nativeErrors.identity = checkedRegularDescriptor(nativeErrors.fd);
    if (status.quiescent) {nativeErrors.expectedHash = hashDescriptor(nativeErrors.fd);}
  } catch (error) {captureFailures.push(error);}
  const outcome = supervisedOutcome(result, status, output, native);
  if (status?.quiescent !== true) {
    const error = new Error(`TOOLCHAIN_PROCESS_GROUP_QUIESCENCE_UNCERTAIN invocation=${invocation.root}`,
      { cause: result.error ?? outcome.error });
    error.code = "TOOLCHAIN_PROCESS_GROUP_QUIESCENCE_UNCERTAIN";
    // Supervisor exit/signal is distinct from the target's observed outcome.
    // Killing the group is a fallback, not a proof that every child is gone.
    error.result = outcome;
    if (failures.length + captureFailures.length > 0) {
      const failure = new AggregateError([error, ...failures, ...captureFailures], error.message, { cause: error });
      failure.result = outcome;
      throw failure;
    }
    throw error;
  }
  if (captureFailures.length > 0) {
    const failure = new AggregateError(captureFailures, "TOOLCHAIN_CAPTURE_FAILED", { cause: captureFailures[0] });
    failure.result = outcome;
    throw failure;
  }
  return outcome;
}

// Rollback supplies its own trusted environment and log descriptors; verified
// toolchain entrypoints retain their descriptor binding and private environment.
// maxBuffer bounds each captured "pipe". As with Node's spawnSync, inherited
// streams and caller-supplied FDs are not captured or bounded by this option.
export function executeSupervisedCommand({ command, args = [], cwd, env, input, encoding = "utf8",
  stdio = [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  maxBuffer = 1024 * 1024, timeoutMs = 600_000 }) {
  return withInvocation([], process.platform, ({ invocation }) => supervisedSpawn({
    args, command, cwd, env, input, encoding, invocation, maxBuffer, stdio, timeoutMs,
  }));
}

function singleLine(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim();
}

function checkedSpawn(result) {
  if (result.targetStatus?.timedOut) {throw typedError("TOOLCHAIN_PROCESS_GROUP_TIMEOUT");}
  if (result.targetStatus?.error || result.error) {
    throw typedError("TOOLCHAIN_DESCRIPTOR_EXECUTION_UNSUPPORTED", `cause=${result.targetStatus?.error ?? result.error?.code ?? "unknown"}`);
  }
  if (result.status !== 0) {
    throw typedError("TOOLCHAIN_VERSION_COMMAND_FAILED", `status=${result.status} stderr=${singleLine(result.stderr)}`);
  }
  return String(result.stdout).trim();
}

function withInvocation(entries, platform, execute) {
  let invocation;
  try {invocation = createInvocation(entries, platform);} catch (error) {
    // This boundary has not invoked a supervisor or target. Preserve the real
    // acquisition error (including all closes), without inventing a result.
    error.execution = { launched: false, quiescent: true };
    throw error;
  }
  let quiescent = false;
  let outcome;
  const failures = [];
  const validateTargets = () => {
    for (const entry of entries) {
      assertOpenedFileStillMatches(entry.opened, entry.expectedHash, "TOOLCHAIN_FILE_IDENTITY_CHANGED");
    }
    for (const snapshot of invocation.snapshots.filter(Boolean)) {
      assertOpenedFileStillMatches(snapshot, snapshot.expectedHash, "TOOLCHAIN_SNAPSHOT_FILE_INVALID");
    }
  };
  try {
    const targets = platform === "darwin"
      ? entries.map((entry, index) => invocation.snapshots[index]?.path ?? entry.opened.path)
      : entries.map((_, index) => `${descriptorRoot(platform)}/${index + 3}`);
    assertPrivateDirectory(invocation.root, invocation.rootIdentity);
    validateTargets();
    outcome = execute({ invocation, targets });
    quiescent = outcome.targetStatus.quiescent;
  } catch (error) {
    outcome = error.result;
    quiescent = outcome?.targetStatus.quiescent === true
      || (error.execution?.launched === false && error.execution.quiescent === true);
    failures.push(error);
  }
  try {validateTargets();} catch (error) {failures.push(error);}
  try {
    if (!removeInvocation(invocation, quiescent) && quiescent) {
      throw typedError("TOOLCHAIN_INVOCATION_CLEANUP_UNCERTAIN", `invocation=${invocation.root}`);
    }
  } catch (error) {failures.push(error);}
  // A rejected close may have consumed/reused the FD. Disarm all owners
  // before attempting every close once; never retry an uncertain number.
  const files = invocation.files;
  invocation.files = [];
  for (const file of files) {
    try {closeSync(file.fd);} catch (error) {failures.push(error);}
  }
  if (failures.length > 0) {
    const failure = failures.length === 1 ? failures[0] : new AggregateError(
      failures, `TOOLCHAIN_INVOCATION_FINALIZATION_FAILED invocation=${invocation.root}`, { cause: failures[0] },
    );
    // Cleanup uncertainty cannot erase an already observed process result.
    // Callers still reject the failure; rollback can record the separate facts.
    if (outcome !== undefined) {failure.result = outcome;}
    else if (failures[0].execution !== undefined) {failure.execution = failures[0].execution;}
    throw failure;
  }
  return outcome;
}

export function descriptorRoot(platform = process.platform) {
  if (platform === "linux") {return "/proc/self/fd";}
  if (platform === "darwin") {return "/dev/fd";}
  throw typedError("TOOLCHAIN_DESCRIPTOR_EXECUTION_UNSUPPORTED", `platform=${platform}`);
}

export function executeVerifiedFile({ path, expectedSha256, args = [], beforeSpawn, platform = process.platform, timeoutMs = 15_000 }) {
  const opened = openExpectedFile(path, expectedSha256);
  try {
    beforeSpawn?.();
    assertPathStillIdentifies(opened);
    const result = withInvocation(
      [{ opened, expectedHash: expectedSha256, leaf: "executable" }],
      platform,
      ({ invocation, targets }) => supervisedSpawn({
        args,
        command: targets[0],
        env: minimalSubprocessEnv(invocation),
        invocation,
        stdio: ["ignore", "pipe", "pipe"],
        targetFds: platform === "linux" ? [opened.fd] : [],
        timeoutMs,
      }),
    );
    return checkedSpawn(result);
  } finally {
    closeSync(opened.fd);
  }
}

export function executeOpenedNode({ node, script, args, stdio = "pipe", platform = process.platform, subprocessPath = [], authenticatedToolBinaries, safeArtifactEnvironment, timeoutMs }) {
  const openedNode = openExpectedFile(node.path, node.sha256);
  let openedScript;
  try {
    openedScript = openExpectedFile(script.path, script.sha256);
    assertPathStillIdentifies(openedNode);
    assertPathStillIdentifies(openedScript);
    const inherited = stdio === "inherit" ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"];
    const result = withInvocation([
      { opened: openedNode, expectedHash: node.sha256, leaf: "node" },
      { opened: openedScript, expectedHash: script.sha256, leaf: "pnpm.mjs", snapshotOnDarwin: true },
    ], platform, ({ invocation, targets }) => supervisedSpawn({
      args: [targets[1], ...args],
      command: targets[0],
      // Keep the generic private environment fixed. runPnpm supplies only
      // validated Safe inputs and authenticated binary paths explicitly.
      env: {
        ...minimalSubprocessEnv(invocation, [dirname(targets[0]), dirname(node.path), ...subprocessPath]),
        ...(authenticatedToolBinaries === undefined ? {} : {
          AGTMAI_ANVIL_BINARY: authenticatedToolBinaries.anvil,
          AGTMAI_FORGE_BINARY: authenticatedToolBinaries.forge,
          AGTMAI_SOLC_BINARY: authenticatedToolBinaries.solc,
        }),
        ...(safeArtifactEnvironment === undefined ? {} : {
          AGTMAI_SAFE_ARTIFACT_DIRECTORY: safeArtifactEnvironment.directory,
          AGTMAI_SAFE_PINS_SHA256: safeArtifactEnvironment.pinsSha256,
        }),
      },
      invocation,
      stdio: inherited,
      targetFds: platform === "linux" ? [openedNode.fd, openedScript.fd] : [],
      timeoutMs: timeoutMs ?? (stdio === "inherit" ? 1_200_000 : 15_000),
    }));
    if (stdio === "inherit") {
      if (result.targetStatus.error || result.error) {
        throw typedError("TOOLCHAIN_DESCRIPTOR_EXECUTION_UNSUPPORTED", `cause=${result.targetStatus.error ?? result.error?.code ?? "unknown"}`);
      }
      if (result.targetStatus.timedOut) {throw typedError("TOOLCHAIN_PROCESS_GROUP_TIMEOUT");}
      return result.status ?? 1;
    }
    return checkedSpawn(result);
  } finally {
    if (openedScript) {closeSync(openedScript.fd);}
    closeSync(openedNode.fd);
  }
}

if (process.argv[2] === SUPERVISOR_ARGUMENT) {await supervisorMain(process.argv[3]);}
