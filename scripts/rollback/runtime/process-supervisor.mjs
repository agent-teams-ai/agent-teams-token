import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./subreaper.c", import.meta.url));
const compiler = "/usr/bin/x86_64-linux-gnu-gcc-13";
// The exact source, compiler and resulting ELF are reviewed as one build tuple.
const pins = {
  source: "7956cad529929cbdb14f0831c872449fa0f94088bdcd178f29fe96aa00ab16c0",
  compiler: "1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26",
  executable: "032c6386f941f677b054e4fcc2c296881d0dcff127928e1971d64af61f449deb",
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function buildHelper() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("ROLLBACK_PROCESS_PLATFORM_UNSUPPORTED");
  }
  const sourceBytes = readFileSync(source);
  if (digest(sourceBytes) !== pins.source || digest(readFileSync(compiler)) !== pins.compiler) {
    throw new Error("ROLLBACK_PROCESS_BUILD_PREREQUISITE_MISMATCH");
  }
  const directory = mkdtempSync(join(tmpdir(), "rollback-subreaper-"));
  const executable = join(directory, "subreaper");
  try {
    const snapshot = join(directory, "subreaper.c");
    writeFileSync(snapshot, sourceBytes, { flag: "wx", mode: 0o600 });
    const built = spawnSync(compiler, ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "-fno-ident", "-o", executable, snapshot], { encoding: "utf8", timeout: 30_000 });
    if (built.error || built.status !== 0 || digest(readFileSync(executable)) !== pins.executable) {
      throw new Error("ROLLBACK_PROCESS_BUILD_UNVERIFIED " + (built.stderr ?? built.error?.message ?? ""));
    }
    chmodSync(executable, 0o700);
    return { directory, executable };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

// Synchronous callers keep evidence descriptors open until native custody
// proves ECHILD or reports uncertainty. There is no outer timeout.
export function superviseCommand(config) {
  let helper;
  try {
    helper = buildHelper();
    const result = spawnSync(helper.executable,
      [String(config.timeout), String(config.drainMs ?? 5000),
        String(config.termMs ?? 1000), config.command, ...config.arguments], {
        cwd: config.cwd, env: config.environment,
        input: config.input === undefined ? undefined : Buffer.from(config.input, "base64"),
        encoding: "utf8", maxBuffer: 1024 * 1024,
        stdio: [config.input === undefined ? "ignore" : "pipe", "pipe", "pipe",
          config.stdoutDescriptor, config.stderrDescriptor],
      });
    if (result.error || result.status !== 0) {
      throw new Error("ROLLBACK_PROCESS_HELPER_UNCONFIRMED " + (result.error?.message ?? result.stderr ?? ""));
    }
    const report = JSON.parse(result.stdout);
    if (!["completed", "reaped", "uncertain"].includes(report.custody)) {
      throw new Error("ROLLBACK_PROCESS_REPORT_INVALID");
    }
    return report;
  } catch (error) {
    return { status: null, signal: null, error: { code: "ESUPERVISOR", message: error.message },
      custody: "uncertain", uncertainty: error.message };
  } finally {
    if (helper) {rmSync(helper.directory, { recursive: true, force: true });}
  }
}
