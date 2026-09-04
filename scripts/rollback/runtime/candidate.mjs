import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";

import {
  resolveInside,
  sha256,
  splitNul,
  tail,
  validateTrackedPath,
} from "./common.mjs";
import { trustedChildInvocation } from "../../toolchain-environment.mjs";

const SHA_256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;

export function gitExecutable() {
  const candidate = "/usr/bin/git";
  try {
    const entry = lstatSync(candidate);
    if (entry.isFile() && !entry.isSymbolicLink() && realpathSync(candidate) === candidate
      && (statSync(candidate).mode & 0o111) !== 0) {
      return candidate;
    }
  } catch {
    // The fixed system trust boundary is unavailable.
  }
  throw new Error("ROLLBACK_GIT_EXECUTABLE_UNAVAILABLE path=" + candidate);
}

export function basicRun(command, arguments_, options = {}) {
  const invocation = trustedChildInvocation(command, arguments_, options.env ?? process.env, {
    workingDirectory: options.cwd,
  });
  const result = spawnSync(command, invocation.arguments, {
    cwd: options.cwd,
    encoding: "utf8",
    env: invocation.environment,
    input: options.input,
    maxBuffer: 128 * 1024 * 1024,
    timeout: options.timeout ?? 600_000,
  });
  if (result.error || result.status !== 0) {
    const output = String(result.stdout ?? "") + "\n" + String(result.stderr ?? "");
    throw new Error(
      "ROLLBACK_COMMAND_FAILED command=" + command + " " + arguments_.join(" ")
      + " status=" + String(result.status) + "\n" + tail(output, 80),
      { cause: result.error },
    );
  }
  return result.stdout;
}

function basicRunBuffer(command, arguments_, options = {}) {
  const invocation = trustedChildInvocation(command, arguments_, options.env ?? process.env, {
    workingDirectory: options.cwd,
  });
  const result = spawnSync(command, invocation.arguments, {
    cwd: options.cwd,
    encoding: null,
    env: invocation.environment,
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeout ?? 600_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      "ROLLBACK_COMMAND_FAILED command=" + command + " " + arguments_.join(" ")
      + " status=" + String(result.status),
      { cause: result.error },
    );
  }
  return Buffer.from(result.stdout ?? Buffer.alloc(0));
}

export function assertExactCleanCandidate(root, expectedSha) {
  const git = gitExecutable();
  const sha = basicRun(git, ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: root }).trim();
  if (!GIT_SHA.test(sha)) {
    throw new Error("ROLLBACK_CANDIDATE_SHA_INVALID actual=" + sha);
  }
  if (expectedSha !== undefined && sha !== expectedSha) {
    throw new Error("ROLLBACK_CANDIDATE_SHA_MISMATCH expected=" + expectedSha + " actual=" + sha);
  }
  const status = basicRunBuffer(git, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ], { cwd: root });
  if (status.length !== 0) {
    throw new Error("ROLLBACK_CANDIDATE_DIRTY statusSha256=" + sha256(status));
  }
  basicRun(git, ["diff", "--no-ext-diff", "--quiet", "--ignore-submodules=none"], { cwd: root });
  basicRun(git, ["diff", "--cached", "--no-ext-diff", "--quiet", "--ignore-submodules=none"], { cwd: root });
  const flags = splitNul(basicRunBuffer(git, ["ls-files", "-v", "-z"], { cwd: root }));
  const unsafeFlag = flags.find((entry) => !entry.toString("utf8").startsWith("H "));
  if (unsafeFlag !== undefined) {
    throw new Error("ROLLBACK_CANDIDATE_INDEX_FLAG_UNSAFE entrySha256=" + sha256(unsafeFlag));
  }
  return sha;
}

export function captureGitStatusSnapshot(root) {
  const bytes = basicRunBuffer(gitExecutable(), [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ], { cwd: root });
  return {
    schemaVersion: 1,
    format: "git-status-porcelain-v1-z",
    byteLength: bytes.length,
    sha256: sha256(bytes),
    base64: bytes.toString("base64"),
  };
}

export function assertGitStatusSnapshotEqual(expected, actual, label = "rollback") {
  for (const snapshot of [expected, actual]) {
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)
      || snapshot.schemaVersion !== 1
      || snapshot.format !== "git-status-porcelain-v1-z"
      || !Number.isSafeInteger(snapshot.byteLength) || snapshot.byteLength < 0
      || !SHA_256.test(snapshot.sha256)
      || typeof snapshot.base64 !== "string") {
      throw new Error("ROLLBACK_STATUS_SNAPSHOT_INVALID label=" + label);
    }
    const bytes = Buffer.from(snapshot.base64, "base64");
    if (bytes.length !== snapshot.byteLength
      || bytes.toString("base64") !== snapshot.base64
      || sha256(bytes) !== snapshot.sha256) {
      throw new Error("ROLLBACK_STATUS_SNAPSHOT_INVALID label=" + label);
    }
  }
  if (expected.byteLength !== actual.byteLength
    || expected.sha256 !== actual.sha256
    || expected.base64 !== actual.base64) {
    throw new Error(
      "ROLLBACK_STATUS_MISMATCH label=" + label
      + " expected=" + expected.sha256 + " actual=" + actual.sha256,
    );
  }
}

export function trackedCandidateInventory(root, treeish = "HEAD") {
  const git = gitExecutable();
  const tree = basicRun(git, ["rev-parse", "--verify", treeish + "^{tree}"], { cwd: root }).trim();
  const records = splitNul(basicRunBuffer(git, [
    "ls-tree",
    "-rz",
    "--full-tree",
    treeish,
  ], { cwd: root }));
  const entries = [];
  let totalBytes = 0;
  for (const raw of records) {
    const tab = raw.indexOf(0x09);
    if (tab < 0) {
      throw new Error("ROLLBACK_INVENTORY_RECORD_INVALID");
    }
    const header = raw.subarray(0, tab).toString("ascii").split(" ");
    const pathBytes = raw.subarray(tab + 1);
    const path = pathBytes.toString("utf8");
    if (!Buffer.from(path, "utf8").equals(pathBytes) || header.length !== 3) {
      throw new Error("ROLLBACK_INVENTORY_RECORD_INVALID");
    }
    const [mode, type, oid] = header;
    validateTrackedPath(path);
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
      throw new Error("ROLLBACK_INVENTORY_ENTRY_UNSUPPORTED path=" + path + " mode=" + mode + " type=" + type);
    }
    const candidate = resolveInside(root, path);
    const entry = lstatSync(candidate);
    let bytes;
    if (mode === "120000") {
      if (!entry.isSymbolicLink()) {
        throw new Error("ROLLBACK_INVENTORY_TYPE_MISMATCH path=" + path);
      }
      bytes = Buffer.from(readlinkSync(candidate), "utf8");
    } else {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("ROLLBACK_INVENTORY_TYPE_MISMATCH path=" + path);
      }
      const executable = (entry.mode & 0o111) !== 0;
      if (executable !== (mode === "100755")) {
        throw new Error("ROLLBACK_INVENTORY_MODE_MISMATCH path=" + path);
      }
      bytes = readFileSync(candidate);
    }
    totalBytes += bytes.length;
    entries.push({
      path,
      mode,
      gitObject: oid,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    });
  }
  const digest = sha256(Buffer.from(JSON.stringify(entries), "utf8"));
  return {
    schemaVersion: 1,
    tree,
    entryCount: entries.length,
    totalBytes,
    sha256: digest,
    entries,
  };
}

export function assertInventoryEqual(expected, actual, label = "checkout") {
  if (expected.tree !== actual.tree
    || expected.entryCount !== actual.entryCount
    || expected.totalBytes !== actual.totalBytes
    || expected.sha256 !== actual.sha256
    || JSON.stringify(expected.entries) !== JSON.stringify(actual.entries)) {
    const maximum = Math.max(expected.entries.length, actual.entries.length);
    let mismatch = "<summary>";
    for (let index = 0; index < maximum; index += 1) {
      if (JSON.stringify(expected.entries[index]) !== JSON.stringify(actual.entries[index])) {
        mismatch = expected.entries[index]?.path ?? actual.entries[index]?.path ?? "<missing>";
        break;
      }
    }
    throw new Error("ROLLBACK_INVENTORY_MISMATCH label=" + label + " path=" + mismatch);
  }
}
