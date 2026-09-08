import { spawnSync } from "node:child_process";
import {
  constants,
  existsSync,
  lstatSync,
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
import { closeCommandLogDescriptors, selectedEnvironment } from "./evidence-command.mjs";
import { trustedChildInvocation } from "../../toolchain-environment.mjs";
import { throwDescriptorCloseFailures } from "./descriptor-close.mjs";
import {
  assertCustodyCanonicalSpelling,
  assertCustodyIdentity,
  assertCustodyStableObject,
  custodyIdentity,
  closeDirectoryCustody,
  createDirectoryCustody,
  refreshDirectoryCustody,
  verifyDirectoryCustody,
} from "./custody.mjs";

function evidenceTarget(value) {
  if (typeof value === "string") {
    return { custody: undefined, path: value };
  }
  if (value === null || typeof value !== "object" || typeof value.path !== "string"
    || !("custody" in value)) {
    throw new Error("ROLLBACK_EVIDENCE_TARGET_INVALID");
  }
  return value;
}

export function evidenceDirectoryPath(value) {
  return evidenceTarget(value).path;
}

export function verifyEvidenceDirectory(
  value,
  code = "ROLLBACK_EVIDENCE_CUSTODY_SUBSTITUTED",
) {
  const target = evidenceTarget(value);
  if (target.custody !== undefined) {
    verifyDirectoryCustody(target.custody, code);
  }
  return target.path;
}

function mutateEvidenceDirectory(value, code, action) {
  const target = evidenceTarget(value);
  verifyEvidenceDirectory(target);
  let result;
  let primaryFailure;
  try {
    result = action(target.path);
  } catch (error) {
    primaryFailure = error;
  }
  const finalizationFailures = [];
  if (target.custody !== undefined) {
    try {
      refreshDirectoryCustody(target.custody);
    } catch (error) {
      finalizationFailures.push(error);
    }
  }
  throwDescriptorCloseFailures(finalizationFailures, code, primaryFailure);
  return result;
}

export function closeEvidenceDirectory(value) {
  const target = evidenceTarget(value);
  if (target.custody !== undefined) {
    closeDirectoryCustody(target.custody);
  }
}

function combinedEvidenceFailure(message, primary, secondary) {
  return new AggregateError([primary, secondary], message, { cause: primary });
}

function annotateEvidenceFailure(error, path) {
  try {
    if (error instanceof Error) {
      error.message += "\nROLLBACK_EVIDENCE path=" + path;
    }
  } catch (annotationError) {
    return combinedEvidenceFailure("ROLLBACK_EVIDENCE_ANNOTATION_FAILED", error, annotationError);
  }
  return error;
}

// Stage lifecycle-owned READY until validation and every custody close succeed.
// Failed bundles retain only READY.pending, which is never independent proof.
const evidencePublications = new Map();

function prepareEvidenceSettlement(value, publication) {
  if (publication.pending === undefined) {
    return;
  }
  const path = verifyEvidenceDirectory(value);
  const ancestors = [];
  for (let parent = dirname(path);; parent = dirname(parent)) {
    ancestors.push({ path: parent, identity: custodyIdentity(lstatSync(parent, { bigint: true })) });
    if (parent === dirname(parent)) {break;}
  }
  publication.ancestors = ancestors;
  publication.directory = custodyIdentity(lstatSync(path, { bigint: true }));
}

function settleEvidencePublication(path, publication) {
  if (publication.pending === undefined) {
    return;
  }
  const code = "ROLLBACK_EVIDENCE_SETTLEMENT_SUBSTITUTED";
  for (const ancestor of publication.ancestors) {
    assertCustodyStableObject(ancestor.identity, lstatSync(ancestor.path, { bigint: true }), code);
  }
  assertCustodyIdentity(publication.directory, lstatSync(path, { bigint: true }), code);
  assertCustodyIdentity(publication.pending, lstatSync(join(path, "READY.pending"), { bigint: true }), code);
  if (lstatSync(join(path, "READY"), { throwIfNoEntry: false }) !== undefined) {
    throw new Error("ROLLBACK_EVIDENCE_READY_EXISTS");
  }
  // No live descriptors or fallible work after this final syscall. Node lacks
  // renameat2(RENAME_NOREPLACE): the accepted same-UID final-syscall race applies.
  renameSync(join(path, "READY.pending"), join(path, "READY"));
}

export function runEvidenceLifecycle(value, createRecorder, action) {
  const path = evidenceDirectoryPath(value);
  if (evidencePublications.has(path)) {
    throw new Error("ROLLBACK_EVIDENCE_LIFECYCLE_ALREADY_ACTIVE");
  }
  const publication = {};
  evidencePublications.set(path, publication);
  let failure;
  let recorder;
  let result;
  try {
    recorder = createRecorder();
    result = action(recorder);
    prepareEvidenceSettlement(value, publication);
  } catch (error) {
    failure = annotateEvidenceFailure(error, path);
    if (recorder !== undefined) {
      try {
        recorder.finalize("failed", error);
      } catch (finalizationError) {
        failure = combinedEvidenceFailure(
          "ROLLBACK_EVIDENCE_FAILURE_FINALIZATION_FAILED",
          failure,
          finalizationError,
        );
      }
    }
  } finally {
    evidencePublications.delete(path);
    try {
      closeEvidenceDirectory(value);
    } catch (closeError) {
      failure = failure === undefined
        ? closeError
        : combinedEvidenceFailure("ROLLBACK_EVIDENCE_CUSTODY_CLOSE_FAILED", failure, closeError);
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
  settleEvidencePublication(path, publication);
  return result;
}

export class EvidenceRecorder {
  constructor(directory, initial) {
    this.target = evidenceTarget(directory);
    this.directory = this.target.path;
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
  target;

  #survivorDirectories = new Map();

  prepareSurvivorDirectory(survivor) {
    if (survivor !== "slither" && survivor !== "local-solana") {
      throw new Error("ROLLBACK_EVIDENCE_SURVIVOR_INVALID");
    }
    let path = this.directory;
    for (const component of ["survivors", survivor]) {
      path = join(path, component);
      mutateEvidenceDirectory(this.target, "ROLLBACK_EVIDENCE_SURVIVOR_DIRECTORY_FAILED", () => {
        // Only reuse directories created by this recorder. Never adopt an
        // existing foreign directory or refresh custody before verification.
        const owned = this.#survivorDirectories.get(path);
        if (owned === undefined) {
          mkdirSync(path, { mode: 0o700 });
          this.#survivorDirectories.set(path, custodyIdentity(lstatSync(path, { bigint: true })));
        } else {
          assertCustodyStableObject(
            owned,
            lstatSync(path, { bigint: true }),
            "ROLLBACK_EVIDENCE_SURVIVOR_DIRECTORY_SUBSTITUTED",
          );
        }
      });
    }
    return path;
  }

  writeArtifact(relativePath, value) {
    const path = resolveInside(this.directory, relativePath);
    mutateEvidenceDirectory(this.target, "ROLLBACK_EVIDENCE_ARTIFACT_DIRECTORY_FAILED", () => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    });
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", "utf8");
    mutateEvidenceDirectory(this.target, "ROLLBACK_EVIDENCE_ARTIFACT_WRITE_FAILED", () => {
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    });
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
    mutateEvidenceDirectory(this.target, "ROLLBACK_EVIDENCE_COMMAND_DIRECTORY_FAILED", () => {
      mkdirSync(dirname(stdoutPath), { recursive: true, mode: 0o700 });
    });
    const startedAt = new Date();
    const started = Date.now();
    let stdoutDescriptor;
    let stderrDescriptor;
    let result;
    let invocation;
    let primaryFailure;
    try {
      stdoutDescriptor = mutateEvidenceDirectory(
        this.target,
        "ROLLBACK_EVIDENCE_COMMAND_STDOUT_CREATE_FAILED",
        () => openSync(stdoutPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600),
      );
      stderrDescriptor = mutateEvidenceDirectory(
        this.target,
        "ROLLBACK_EVIDENCE_COMMAND_STDERR_CREATE_FAILED",
        () => openSync(stderrPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600),
      );
      invocation = trustedChildInvocation(command, arguments_, options.env ?? process.env, {
        workingDirectory: options.cwd,
      });
      try {
        result = spawnSync(command, invocation.arguments, {
          cwd: options.cwd,
          env: invocation.environment,
          input: options.input,
          stdio: [options.input === undefined ? "ignore" : "pipe", stdoutDescriptor, stderrDescriptor],
          timeout: options.timeout ?? 600_000,
        });
      } catch (error) {
        result = { error, status: null, signal: null };
      }
    } catch (error) {
      primaryFailure = error;
    }
    // Disarm before attempting close: a rejected close may already have
    // consumed the descriptor. Attempt all owners, never retry an FD number.
    const descriptors = [stdoutDescriptor, stderrDescriptor];
    stdoutDescriptor = undefined;
    stderrDescriptor = undefined;
    const finalizationFailures = closeCommandLogDescriptors(descriptors);
    if (primaryFailure !== undefined) {
      throwDescriptorCloseFailures(finalizationFailures, "ROLLBACK_COMMAND_FINALIZATION_FAILED", primaryFailure);
    }
    const commandPassed = !result.error && result.status === 0;
    if (!commandPassed) {
      primaryFailure = new Error(
        "ROLLBACK_COMMAND_FAILED group=" + group + " id=" + id
        + " status=" + String(result.status) + " signal=" + String(result.signal),
        { cause: result.error },
      );
    }
    let recorded;
    try {
      verifyEvidenceDirectory(this.target);
      const stdout = readFileSync(stdoutPath);
      const stderr = readFileSync(stderrPath);
      if (primaryFailure !== undefined) {
        primaryFailure.message += "\n" + tail(stdout.toString("utf8") + "\n" + stderr.toString("utf8"), 80);
      }
      const entry = {
        sequence: this.sequence,
        group,
        id,
        phase: options.phase ?? "preparation",
        command,
        arguments: invocation.arguments,
        cwd: options.cwd,
        environment: selectedEnvironment(invocation.environment),
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - started,
        exitCode: result.status,
        signal: result.signal,
        timedOut: result.error?.code === "ETIMEDOUT",
        spawnError: result.error?.code ?? null,
        status: commandPassed && finalizationFailures.length === 0 ? "passed" : "failed",
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
      recorded = { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), entry };
    } catch (error) {
      if (primaryFailure !== undefined || finalizationFailures.length > 0) {
        finalizationFailures.push(error);
      } else {
        primaryFailure = error;
      }
    }
    throwDescriptorCloseFailures(finalizationFailures, "ROLLBACK_COMMAND_FINALIZATION_FAILED", primaryFailure);
    return recorded;
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
    mutateEvidenceDirectory(this.target, "ROLLBACK_EVIDENCE_DIAGNOSTICS_WRITE_FAILED", () => {
      writeFileSync(partial, JSON.stringify(this.document, null, 2) + "\n", { mode: 0o600 });
    });
    mutateEvidenceDirectory(this.target, "ROLLBACK_EVIDENCE_DIAGNOSTICS_PUBLISH_FAILED", () => {
      renameSync(partial, path);
    });
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
  const target = evidenceTarget(directory);
  const statementCanonical = Buffer.from(canonicalJson(statement), "utf8");
  const statementBytes = Buffer.concat([statementCanonical, Buffer.from("\n", "utf8")]);
  const statementPath = join(target.path, "statement.json");
  mutateEvidenceDirectory(target, "ROLLBACK_EVIDENCE_STATEMENT_WRITE_FAILED", () => {
    writeFileSync(statementPath, statementBytes, { flag: "wx", mode: 0o600 });
  });
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
  mutateEvidenceDirectory(target, "ROLLBACK_EVIDENCE_SEAL_WRITE_FAILED", () => {
    writeFileSync(join(target.path, "seal.json"), sealBytes, { flag: "wx", mode: 0o600 });
  });
  return { seal, sealSha256: sha256(sealBytes), statement };
}

export function publishReadyMarker(directory, publication) {
  const target = evidenceTarget(directory);
  const lifecycle = evidencePublications.get(target.path);
  const ready = {
    schemaVersion: 1,
    kind: "agtmai-recovery-proof-ready",
    candidateSha: publication.statement.candidate.sha,
    sealSha256: publication.sealSha256,
    proofDigestSha256: publication.seal.statement.canonicalSha256,
  };
  mutateEvidenceDirectory(target, "ROLLBACK_EVIDENCE_READY_WRITE_FAILED", () => {
    writeFileSync(
      join(target.path, lifecycle === undefined ? "READY" : "READY.pending"),
      Buffer.from(canonicalJson(ready) + "\n", "utf8"),
      { flag: "wx", mode: 0o400 },
    );
    if (lifecycle !== undefined) {
      lifecycle.pending = custodyIdentity(lstatSync(join(target.path, "READY.pending"), { bigint: true }));
    }
  });
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
    const requestedParent = dirname(directory);
    const parent = realpathSync(requestedParent);
    try {
      assertCustodyCanonicalSpelling({
        allowDarwinTemporaryAlias: true,
        canonicalPath: parent,
        requestedPath: requestedParent,
      });
    } catch {
      throw new Error("ROLLBACK_EVIDENCE_PARENT_SUBSTITUTED path=" + dirname(directory));
    }
    mkdirSync(directory, { mode: 0o700 });
  }
  const real = realpathSync(directory);
  const repositoryRelative = relative(repositoryRoot, real);
  if (repositoryRelative === "" || (!repositoryRelative.startsWith(".." + sep) && repositoryRelative !== "..")) {
    throw new Error("ROLLBACK_EVIDENCE_INSIDE_REPOSITORY path=" + real);
  }
  const custody = createDirectoryCustody(real, {
    allowDarwinTemporaryAlias: true,
    owned: true,
  });
  return Object.freeze({ custody, path: real });
}
