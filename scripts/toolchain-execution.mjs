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
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
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
    if (contents) {writeSync(fd, contents, 0, "utf8");}
    fchmodSync(fd, 0o600);
    const identity = checkedRegularDescriptor(fd);
    return { expectedHash: hashDescriptor(fd), fd, identity, path };
  } catch (error) {
    closeSync(fd);
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
    closeSync(fd);
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
    const npmGlobalrc = createControlledFile(join(root, "npm-globalrc"));
    const status = createControlledFile(join(root, "supervisor-status"));
    files.push(npmrc, npmGlobalrc, status);
    const snapshots = platform === "darwin"
      ? entries.map((entry) => entry.snapshotOnDarwin
        ? writeAuthenticatedSnapshot(root, entry.opened, entry.leaf)
        : undefined)
      : [];
    files.push(...snapshots.filter(Boolean));
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
    for (const file of files) {try {closeSync(file.fd);} catch {}}
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
  const pathFd = openSync(file.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
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
  const opened = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
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
  } catch {
    return false;
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
      } catch {}
    }
    return members;
  }
  if (process.platform !== "darwin") {throw typedError("TOOLCHAIN_PROCESS_GROUP_INSPECTION_FAILED");}
  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" });
  if (result.status !== 0) {throw typedError("TOOLCHAIN_PROCESS_GROUP_INSPECTION_FAILED");}
  return result.stdout.split("\n").map((line) => line.trim().split(/\s+/))
    .filter(([pid, group, state]) => Number(pid) > 0 && Number(group) === pgid && !state?.startsWith("Z"))
    .map(([pid]) => Number(pid));
}

function groupHasLiveMembers(pgid) {return processGroupMembers(pgid).length > 0;}

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

async function waitForGroupDisappearance(pgid, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (groupHasLiveMembers(pgid) && Date.now() < deadline) {await delay(10);}
  return !groupHasLiveMembers(pgid);
}

function writeSupervisorStatus(fd, status) {
  const payload = `${JSON.stringify(status)}\n`;
  ftruncateSync(fd, 0);
  writeSync(fd, payload, 0, "utf8");
}

async function supervisorMain(encoded) {
  const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  let child;
  let timedOut = false;
  let termination;
  let supervisorError;
  try {
    child = spawn(config.command, config.args, {
      detached: true,
      env: process.env,
      stdio: config.childStdio,
    });
    writeSupervisorStatus(config.statusFd, { error: null, pgid: child.pid, quiescent: false });
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        termination = terminateProcessGroup(child.pid).catch((error) => {supervisorError ??= error;});
      }, config.timeoutMs);
      child.once("error", (error) => resolve({ error }));
      child.once("exit", (status, signal) => {
        clearTimeout(timer);
        resolve({ signal, status });
      });
    });
    if (termination) {await termination;}
    if (groupHasLiveMembers(child.pid)) {
      signalGroup(child.pid, "SIGTERM");
      await delay(TERM_GRACE_MS);
      if (groupHasLiveMembers(child.pid)) {signalGroup(child.pid, "SIGKILL");}
    }
    const quiescent = await waitForGroupDisappearance(child.pid, KILL_GRACE_MS);
    writeSupervisorStatus(config.statusFd, {
      error: outcome.error?.code ?? supervisorError?.code ?? null,
      pgid: child.pid,
      quiescent,
      signal: outcome.signal ?? null,
      status: outcome.status ?? null,
      timedOut,
    });
    if (!quiescent || supervisorError) {process.exitCode = 125;}
    else if (timedOut) {process.exitCode = 124;}
    else if (outcome.error) {process.exitCode = 126;}
    else if (outcome.signal) {process.exitCode = 128;}
    else {process.exitCode = outcome.status ?? 1;}
  } catch (error) {
    try {writeSupervisorStatus(config.statusFd, { error: error?.code ?? "unknown", quiescent: false });} catch {}
    process.exitCode = 125;
  }
}

function readSupervisorStatus(invocation) {
  try {
    const descriptor = fstatSync(invocation.status.fd);
    if (!sameIdentity(invocation.status.identity, descriptor)
      || descriptor.nlink !== 1
      || (descriptor.mode & 0o777) !== 0o600
      || descriptor.size > 4_096) {return;}
    const buffer = Buffer.alloc(descriptor.size);
    if (readSync(invocation.status.fd, buffer, 0, buffer.length, 0) !== buffer.length) {return;}
    const payload = buffer.toString("utf8");
    const status = JSON.parse(payload);
    invocation.status.expectedHash = createHash("sha256").update(payload).digest("hex");
    invocation.status.identity = descriptor;
    return status;
  } catch {return;}
}

function supervisedSpawn({ args, command, env, invocation, stdio, targetFds = [], timeoutMs }) {
  const statusFd = 3 + targetFds.length;
  const config = {
    args,
    childStdio: [
      ...stdio.map((entry) => entry === "pipe" ? "inherit" : entry),
      ...targetFds.map((_, index) => index + 3),
    ],
    command,
    statusFd,
    timeoutMs,
  };
  const result = spawnSync(process.execPath, [
    fileURLToPath(import.meta.url),
    SUPERVISOR_ARGUMENT,
    Buffer.from(JSON.stringify(config)).toString("base64url"),
  ], {
    encoding: stdio[1] === "inherit" ? undefined : "utf8",
    env,
    stdio: [...stdio, ...targetFds, invocation.status.fd],
    timeout: timeoutMs + TERM_GRACE_MS + KILL_GRACE_MS + 2_000,
  });
  const status = readSupervisorStatus(invocation);
  if (!status?.quiescent) {
    if (Number.isSafeInteger(status?.pgid) && status.pgid > 1) {
      try {
        signalGroup(status.pgid, "SIGTERM");
        spawnSync("/bin/sleep", [String(TERM_GRACE_MS / 1_000)]);
        signalGroup(status.pgid, "SIGKILL");
      } catch {}
    }
    throw typedError("TOOLCHAIN_PROCESS_GROUP_QUIESCENCE_UNCERTAIN", `invocation=${invocation.root}`);
  }
  return { ...result, status: status.status, targetStatus: status };
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
  const invocation = createInvocation(entries, platform);
  let quiescent = false;
  let outcome;
  let failure;
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
    failure = error;
  }
  try {validateTargets();} catch (error) {failure = error;}
  const removed = removeInvocation(invocation, quiescent);
  for (const file of invocation.files) {try {closeSync(file.fd);} catch {}}
  if (quiescent && !removed) {
    throw typedError("TOOLCHAIN_INVOCATION_CLEANUP_UNCERTAIN", `invocation=${invocation.root}`);
  }
  if (failure) {throw failure;}
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

export function executeOpenedNode({ node, script, args, stdio = "pipe", platform = process.platform, subprocessPath = [], timeoutMs }) {
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
      env: minimalSubprocessEnv(invocation, [dirname(targets[0]), dirname(node.path), ...subprocessPath]),
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
