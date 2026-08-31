import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { resolveInside, safeLabel, sha256, tail } from "./common.mjs";

const EVIDENCE_ENVIRONMENT_KEYS = [
  "AGTMAI_ROLLBACK_EVIDENCE_DIRECTORY",
  "AGTMAI_ROLLBACK_TMPDIR",
  "AGTMAI_ANVIL_BINARY",
  "AGTMAI_FORGE_BINARY",
  "AGTMAI_SOLANA_REAL_TESTS_REQUIRED",
  "AGTMAI_SOLC_BINARY",
  "CI",
  "FOUNDRY_PROFILE",
  "GITHUB_SHA",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SLITHER_CANDIDATE_SHA",
  "SLITHER_DOCKER_PATH",
  "SLITHER_EVIDENCE_DIRECTORY",
  "SLITHER_FORGE_PATH",
  "SLITHER_REPOSITORY_ROOT",
  "SLITHER_SOLC_PATH",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
];

function selectedEnvironment(environment) {
  return Object.fromEntries(
    EVIDENCE_ENVIRONMENT_KEYS
      .filter((key) => environment[key] !== undefined)
      .map((key) => [key, String(environment[key])]),
  );
}

export class EvidenceRecorder {
  constructor(directory, initial) {
    this.directory = directory;
    this.document = {
      schemaVersion: 1,
      kind: "agtmai-slice-rollback-proof",
      status: "running",
      startedAt: new Date().toISOString(),
      commands: [],
      stages: [],
      slices: [],
      ...initial,
    };
    this.sequence = 0;
    this.flush();
  }

  directory;
  document;
  sequence;

  writeArtifact(relativePath, value) {
    const path = resolveInside(this.directory, relativePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", "utf8");
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    return {
      path: relativePath,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    };
  }

  run(group, id, command, arguments_, options = {}) {
    this.sequence += 1;
    const stem = String(this.sequence).padStart(3, "0") + "-" + safeLabel(group) + "-" + safeLabel(id);
    const stdoutRelative = "commands/" + stem + ".stdout.log";
    const stderrRelative = "commands/" + stem + ".stderr.log";
    const stdoutPath = resolveInside(this.directory, stdoutRelative);
    const stderrPath = resolveInside(this.directory, stderrRelative);
    mkdirSync(dirname(stdoutPath), { recursive: true, mode: 0o700 });
    const stdoutDescriptor = openSync(stdoutPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const stderrDescriptor = openSync(stderrPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const startedAt = new Date();
    const started = Date.now();
    let result;
    try {
      try {
        result = spawnSync(command, arguments_, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          input: options.input,
          stdio: [options.input === undefined ? "ignore" : "pipe", stdoutDescriptor, stderrDescriptor],
          timeout: options.timeout ?? 600_000,
        });
      } catch (error) {
        result = { error, status: null, signal: null };
      }
    } finally {
      closeSync(stdoutDescriptor);
      closeSync(stderrDescriptor);
    }
    const stdout = readFileSync(stdoutPath);
    const stderr = readFileSync(stderrPath);
    const passed = !result.error && result.status === 0;
    const entry = {
      sequence: this.sequence,
      group,
      id,
      phase: options.phase ?? "preparation",
      command,
      arguments: arguments_,
      cwd: options.cwd,
      environment: selectedEnvironment(options.env ?? process.env),
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - started,
      exitCode: result.status,
      signal: result.signal,
      timedOut: result.error?.code === "ETIMEDOUT",
      spawnError: result.error?.code ?? null,
      status: passed ? "passed" : "failed",
      stdout: {
        path: stdoutRelative,
        byteLength: stdout.length,
        sha256: sha256(stdout),
      },
      stderr: {
        path: stderrRelative,
        byteLength: stderr.length,
        sha256: sha256(stderr),
      },
    };
    this.document.commands.push(entry);
    this.flush();
    if (!passed) {
      const diagnostic = tail(stdout.toString("utf8") + "\n" + stderr.toString("utf8"), 80);
      throw new Error(
        "ROLLBACK_COMMAND_FAILED group=" + group + " id=" + id
        + " status=" + String(result.status) + " signal=" + String(result.signal)
        + "\n" + diagnostic,
        { cause: result.error },
      );
    }
    return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), entry };
  }

  stage(group, id, action, summarize = () => {}) {
    const entry = {
      group,
      id,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    const started = Date.now();
    this.document.stages.push(entry);
    this.document.phase = id;
    this.flush();
    try {
      const value = action();
      const result = summarize(value);
      entry.status = "passed";
      entry.durationMs = Date.now() - started;
      if (result !== undefined) {
        entry.result = result;
      }
      this.flush();
      return value;
    } catch (error) {
      entry.status = "failed";
      entry.durationMs = Date.now() - started;
      entry.error = {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      };
      this.flush();
      throw error;
    }
  }

  update(mutator) {
    mutator(this.document);
    this.flush();
  }

  finalize(status, error) {
    this.document.status = status;
    this.document.phase = "finished";
    this.document.finishedAt = new Date().toISOString();
    if (error !== undefined) {
      this.document.error = {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    this.flush();
  }

  flush() {
    const path = join(this.directory, "diagnostics.json");
    const partial = path + ".part";
    writeFileSync(partial, JSON.stringify(this.document, null, 2) + "\n", { mode: 0o600 });
    renameSync(partial, path);
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {throw new Error("ROLLBACK_CANONICAL_NUMBER_UNSAFE");}
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value).toSorted().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("ROLLBACK_CANONICAL_VALUE_UNSUPPORTED");
}

export function publishEvidenceSeal(directory, statement, schemaPath) {
  const statementCanonical = Buffer.from(canonicalJson(statement), "utf8");
  const statementBytes = Buffer.concat([statementCanonical, Buffer.from("\n", "utf8")]);
  const statementPath = join(directory, "statement.json");
  writeFileSync(statementPath, statementBytes, { flag: "wx", mode: 0o600 });
  const schemaBytes = readFileSync(schemaPath);
  const seal = {
    schemaVersion: 1,
    kind: "agtmai-recovery-proof-seal",
    candidateSha: statement.candidate.sha,
    schema: {
      path: "architecture/rollback/recovery-evidence.schema.json",
      byteLength: schemaBytes.length,
      sha256: sha256(schemaBytes),
    },
    statement: {
      path: "statement.json",
      byteLength: statementBytes.length,
      sha256: sha256(statementBytes),
      canonicalSha256: sha256(statementCanonical),
    },
  };
  const sealBytes = Buffer.from(canonicalJson(seal) + "\n", "utf8");
  writeFileSync(join(directory, "seal.json"), sealBytes, { flag: "wx", mode: 0o600 });
  return { seal, sealSha256: sha256(sealBytes), statement };
}

export function publishReadyMarker(directory, publication) {
  const ready = {
    schemaVersion: 1,
    kind: "agtmai-recovery-proof-ready",
    candidateSha: publication.statement.candidate.sha,
    sealSha256: publication.sealSha256,
    proofDigestSha256: publication.seal.statement.canonicalSha256,
  };
  writeFileSync(
    join(directory, "READY"),
    Buffer.from(canonicalJson(ready) + "\n", "utf8"),
    { flag: "wx", mode: 0o400 },
  );
  return ready;
}

export function createEvidenceDirectory(configuredPath, temporaryRoot, repositoryRoot) {
  let directory;
  if (configuredPath === undefined) {
    directory = mkdtempSync(join(temporaryRoot, "agtmai-rollback-evidence-"));
  } else {
    if (!isAbsolute(configuredPath)) {
      throw new Error("ROLLBACK_EVIDENCE_PATH_NOT_ABSOLUTE");
    }
    directory = resolve(configuredPath);
    if (existsSync(directory)) {
      throw new Error("ROLLBACK_EVIDENCE_PATH_EXISTS path=" + directory);
    }
    const parent = realpathSync(dirname(directory));
    if (dirname(directory) !== parent) {
      throw new Error("ROLLBACK_EVIDENCE_PARENT_SUBSTITUTED path=" + dirname(directory));
    }
    mkdirSync(directory, { mode: 0o700 });
  }
  const real = realpathSync(directory);
  const repositoryRelative = relative(repositoryRoot, real);
  if (repositoryRelative === "" || (!repositoryRelative.startsWith(".." + sep) && repositoryRelative !== "..")) {
    throw new Error("ROLLBACK_EVIDENCE_INSIDE_REPOSITORY path=" + real);
  }
  return real;
}
