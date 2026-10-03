import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const source = fileURLToPath(new URL("./subreaper.c", import.meta.url));
const compiler = "/usr/bin/x86_64-linux-gnu-gcc-13";
// The exact source, compiler and resulting ELF are reviewed as one build tuple.
const pins = {
  source: "49d155937ed05346fc0260ce79dcd63f2de41d6463ecba4b8947bdf80249c496",
  compiler: "1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26",
  executable: "ba1e163135594195d1c3233da681436af7de81985f7c7c28bb23e18b9d0c9486",
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Deterministic gzip (level 9, mtime 0) of the pinned ELF. Build this image
// with the exact compiler flags and isolated environment in the native test.
// Provisioning bytes never starts GCC or any of its descendants in a run.
const helperImage = [
  "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",
  "+P3f5Xn2RRhUAAA=",
].join("");


function verifyPinnedFile(path, expectedHash) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let failure;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024) {
      throw new Error("ROLLBACK_PROCESS_BUILD_PREREQUISITE_MISMATCH");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (count === 0) {throw new Error("ROLLBACK_PROCESS_BUILD_PREREQUISITE_MISMATCH");}
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mode !== after.mode || after.nlink !== 1
      || hash.digest("hex") !== expectedHash) {
      throw new Error("ROLLBACK_PROCESS_BUILD_PREREQUISITE_MISMATCH");
    }
  } catch (error) {failure = error;}
  // Attempt a single close; a rejected close is never retried.
  try {closeSync(fd);} catch (error) {
    if (failure) {throw new AggregateError([failure, error], "ROLLBACK_PROCESS_PIN_CLOSE_FAILED", { cause: failure });}
    throw error;
  }
  if (failure) {throw failure;}
}

// The existing Token build tuple stays local to this product boundary. Provision
// only reviewed bytes into the caller's private invocation; never invoke GCC.
export function prepareNativeSupervisor(path) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("ROLLBACK_PROCESS_PLATFORM_UNSUPPORTED");
  }
  verifyPinnedFile(source, pins.source);
  verifyPinnedFile(compiler, pins.compiler);
  const bytes = gunzipSync(Buffer.from(helperImage, "base64"));
  if (digest(bytes) !== pins.executable) {throw new Error("ROLLBACK_PROCESS_BUILD_UNVERIFIED");}
  writeFileSync(path, bytes, { flag: "wx", mode: 0o700 });
  return pins.executable;
}

// The invocation owns every descriptor, including file-backed helper output.
// Executing the inherited read-only FD binds the loaded ELF to its pinned bytes.
// The outer SIGKILL watchdog is deliberately independent of native drain/reaping.
export function superviseCommand(config) {
  return spawnSync(`/proc/self/fd/${config.executableFd}`,
    [String(config.timeout), "5000", "1000", config.command, ...config.arguments], {
      cwd: config.cwd,
      env: config.environment,
      stdio: config.stdio,
      timeout: config.outerTimeout,
      killSignal: "SIGKILL",
    });
}

export function parseNativeSupervisorReport(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).toSorted().join(",") !== "custody,error,signal,signalledCount,status,uncertainty"
    || !["completed", "reaped", "uncertain"].includes(value.custody)
    || (value.status !== null && (!Number.isInteger(value.status) || value.status < 0 || value.status > 255))
    || (value.signal !== null && (typeof value.signal !== "string" || !/^SIG[A-Z0-9]+$/u.test(value.signal)))
    || (value.error !== null && (typeof value.error !== "object" || Array.isArray(value.error)
      || Object.keys(value.error).join(",") !== "code" || typeof value.error.code !== "string"
      || !/^E[A-Z0-9]+$/u.test(value.error.code)))
    || (value.uncertainty !== null && typeof value.uncertainty !== "string")
    || !Number.isSafeInteger(value.signalledCount) || value.signalledCount < 0 || value.signalledCount > 8192
    || (value.custody !== "uncertain" && (value.uncertainty !== null
      || (value.status === null && value.signal === null)))
    || (value.custody === "completed" && ["ELEAK", "ETIMEDOUT", "ECANCELLED"].includes(value.error?.code))
    || (value.custody === "reaped" && !["ELEAK", "ETIMEDOUT", "ECANCELLED"].includes(value.error?.code))
    || (value.status !== null && value.signal !== null)) {
    throw new Error("ROLLBACK_PROCESS_REPORT_INVALID");
  }
  return value;
}
