import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

import { basicRun, gitExecutable } from "../runtime/candidate.mjs";
import {
  expectedRetainedSharedPaths,
  expectedSharedPaths,
  expectedSlices,
  manifestDirectory,
  manifestNames,
  repositoryRoot,
  rollbackBaselineSha,
  ROLLBACK_MANIFEST_COUNT,
  ROLLBACK_MANIFEST_MAX_BYTES,
  ROLLBACK_MANIFEST_MAX_PATHS,
  ROLLBACK_PATH_MAX_BYTES,
  ROLLBACK_PATH_MAX_DEPTH,
  sliceRoots,
} from "./config.mjs";

function run(command, commandArguments, options = {}) {
  return basicRun(command === "git" ? gitExecutable() : command, commandArguments, {
    ...options,
    cwd: options.cwd ?? repositoryRoot,
  });
}

function hashOrAbsent(root, path) {
  const target = join(root, path);
  try {
    const entry = lstatSync(target);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("ROLLBACK_SHARED_PATH_UNSAFE path=" + path);
    }
    return createHash("sha256").update(readFileSync(target)).digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "absent";
    }
    throw error;
  }
}

export function validateExactPath(path, label) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)
    || path.includes("\\") || path.includes("\0") || /[*?[\]]/u.test(path)
    || normalize(path) !== path || path === "." || path.startsWith(`..${sep}`)
    || path.split("/").includes("..")
    || Buffer.byteLength(path, "utf8") > ROLLBACK_PATH_MAX_BYTES
    || path.split("/").length > ROLLBACK_PATH_MAX_DEPTH) {
    throw new Error(`ROLLBACK_UNSAFE_PATH label=${label} path=${String(path)}`);
  }
}

function sortedUnique(values, label) {
  const sorted = [...values].toSorted();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error(`ROLLBACK_DUPLICATE_ENTRY label=${label}`);
  }
  return sorted;
}

export function readManifests(root = manifestDirectory) {
  return manifestNames.map((name) => {
    const path = join(root, name);
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > ROLLBACK_MANIFEST_MAX_BYTES) {
      throw new Error("ROLLBACK_MANIFEST_FILE_UNSAFE path=" + path);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  });
}

export function requireArray(value, label, maximum = ROLLBACK_MANIFEST_MAX_PATHS) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error("ROLLBACK_MANIFEST_ARRAY_REQUIRED label=" + label);
  }
  return value;
}

function requireExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify([...keys].toSorted())) {
    throw new Error("ROLLBACK_MANIFEST_OBJECT_INVALID label=" + label);
  }
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
}

function assertNoHierarchicalOverlap(paths, label) {
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (pathsOverlap(paths[left], paths[right])) {
        throw new Error(
          "ROLLBACK_PATH_OVERLAP label=" + label + " left=" + paths[left] + " right=" + paths[right],
        );
      }
    }
  }
}

function assertNoCrossOverlap(leftPaths, rightPaths, label, allowedExact = new Set()) {
  for (const left of leftPaths) {
    for (const right of rightPaths) {
      if (pathsOverlap(left, right) && !(left === right && allowedExact.has(left))) {
        throw new Error(
          "ROLLBACK_PATH_OVERLAP label=" + label + " left=" + left + " right=" + right,
        );
      }
    }
  }
}

export function validateManifestSet(manifests, { verifyGitCoverage = false } = {}) {
  validateManifestSetHeader(manifests);
  const coverage = { allOwned: [], allShared: [] };
  for (const manifest of manifests) {
    const normalized = validateManifest(manifest, verifyGitCoverage);
    coverage.allOwned.push(...normalized.ownedPaths.map((path) => ({
      path,
      slice: manifest.sliceId,
    })));
    coverage.allShared.push(...normalized.sharedPaths.map((path) => ({
      path,
      slice: manifest.sliceId,
    })));
  }
  assertManifestSetOwnership(coverage);
  return manifests;
}

function validateManifestSetHeader(manifests) {
  requireArray(manifests, "manifestSet", ROLLBACK_MANIFEST_COUNT);
  if (manifests.length !== ROLLBACK_MANIFEST_COUNT
    || manifests.length !== expectedSlices.length) {
    throw new Error("ROLLBACK_MANIFEST_SET_INCOMPLETE");
  }
  const manifestKeys = [
    "baselineSha",
    "ownedPaths",
    "ownedRoot",
    "restoreFromBaseline",
    "retainedSharedPaths",
    "reverseEdits",
    "schemaVersion",
    "sharedPaths",
    "sliceId",
    "survivingGates",
  ];
  for (const [index, manifest] of manifests.entries()) {
    requireExactKeys(manifest, manifestKeys, "manifest:" + String(index));
  }
  const ids = sortedUnique(manifests.map(({ sliceId }) => sliceId), "sliceId");
  if (JSON.stringify(ids) !== JSON.stringify(expectedSlices.toSorted())) {
    throw new Error("ROLLBACK_MANIFEST_IDS_MISMATCH");
  }
}

function validateManifest(manifest, verifyGitCoverage) {
  const slice = manifest.sliceId;
  validateManifestHeader(manifest);
  const fields = normalizedManifestFields(manifest);
  validateManifestFieldPaths(slice, manifest, fields);
  validateManifestPathRelations(slice, fields);
  validateManifestComplements(slice, fields);
  validateManifestOwnership(slice, manifest, fields);
  validateReverseEdits(slice, manifest.reverseEdits, verifyGitCoverage);
  validateRetainedPaths(slice, manifest.retainedSharedPaths);
  if (verifyGitCoverage) {
    validateGitCoverage(manifest, fields);
  }
  return fields;
}

function validateManifestHeader(manifest) {
  const slice = manifest.sliceId;
  if (manifest.schemaVersion !== 1 || manifest.baselineSha !== rollbackBaselineSha) {
    throw new Error("ROLLBACK_MANIFEST_HEADER_INVALID slice=" + slice);
  }
  validateExactPath(manifest.ownedRoot, slice + ":ownedRoot");
  if (manifest.ownedRoot !== sliceRoots[slice]) {
    throw new Error("ROLLBACK_OWNED_ROOT_INVALID slice=" + slice);
  }
}

function normalizedManifestFields(manifest) {
  const slice = manifest.sliceId;
  const raw = {
    ownedPaths: requireArray(manifest.ownedPaths, slice + ":ownedPaths"),
    restoredPaths: requireArray(manifest.restoreFromBaseline, slice + ":restoreFromBaseline"),
    sharedPaths: requireArray(manifest.sharedPaths, slice + ":sharedPaths"),
    retained: requireArray(manifest.retainedSharedPaths, slice + ":retainedSharedPaths"),
    reverse: requireArray(manifest.reverseEdits, slice + ":reverseEdits"),
    survivors: requireArray(manifest.survivingGates, slice + ":survivingGates"),
  };
  return {
    ...raw,
    ownedPaths: sortedUnique(raw.ownedPaths, slice + ":ownedPaths"),
    restoredPaths: sortedUnique(raw.restoredPaths, slice + ":restoreFromBaseline"),
    sharedPaths: sortedUnique(raw.sharedPaths, slice + ":sharedPaths"),
    retainedPaths: sortedUnique(raw.retained.map(({ path }) => path), slice + ":retainedSharedPaths"),
    reversePaths: sortedUnique(raw.reverse.map(({ path }) => path), slice + ":reverseEdits"),
    survivors: sortedUnique(raw.survivors, slice + ":survivingGates"),
  };
}

function validateManifestFieldPaths(slice, manifest, fields) {
  for (const [label, paths] of Object.entries({
    ownedPaths: manifest.ownedPaths,
    restoreFromBaseline: manifest.restoreFromBaseline,
    sharedPaths: manifest.sharedPaths,
  })) {
    for (const path of paths) {
      validateExactPath(path, slice + ":" + label);
    }
  }
  for (const [index, retained] of fields.retained.entries()) {
    requireExactKeys(retained, ["path", "reason", "sha256"], slice + ":retained:" + String(index));
    validateExactPath(retained.path, slice + ":retainedSharedPath");
  }
  for (const [index, edit] of fields.reverse.entries()) {
    requireExactKeys(
      edit,
      ["afterSha256", "beforeSha256", "path"],
      slice + ":reverseEdit:" + String(index),
    );
    validateExactPath(edit.path, slice + ":reverseEdit");
  }
  if (fields.survivors.some((survivor) => typeof survivor !== "string")) {
    throw new Error("ROLLBACK_SURVIVOR_GATE_INVALID slice=" + slice);
  }
}

function validateManifestPathRelations(slice, fields) {
  for (const [label, paths] of Object.entries({
    ownedPaths: fields.ownedPaths,
    restoreFromBaseline: fields.restoredPaths,
    sharedPaths: fields.sharedPaths,
    retainedSharedPaths: fields.retainedPaths,
  })) {
    assertNoHierarchicalOverlap(paths, slice + ":" + label);
  }
  for (const [label, left, right] of [
    ["owned-vs-restored", fields.ownedPaths, fields.restoredPaths],
    ["owned-vs-shared", fields.ownedPaths, fields.sharedPaths],
    ["owned-vs-retained", fields.ownedPaths, fields.retainedPaths],
    ["shared-vs-retained", fields.sharedPaths, fields.retainedPaths],
    ["restored-vs-retained", fields.restoredPaths, fields.retainedPaths],
  ]) {
    assertNoCrossOverlap(left, right, slice + ":" + label);
  }
  assertNoCrossOverlap(
    fields.restoredPaths,
    fields.sharedPaths,
    slice + ":restored-vs-shared",
    new Set(fields.restoredPaths),
  );
}

function validateManifestComplements(slice, fields) {
  const expectedSurvivors = expectedSlices.filter((value) => value !== slice).toSorted();
  if (JSON.stringify(fields.survivors) !== JSON.stringify(expectedSurvivors)) {
    throw new Error(
      "ROLLBACK_SURVIVOR_COMPLEMENT_INVALID slice=" + slice
      + " expected=" + expectedSurvivors.join(",") + " actual=" + fields.survivors.join(","),
    );
  }
  if (JSON.stringify(fields.reversePaths) !== JSON.stringify(fields.sharedPaths)) {
    throw new Error("ROLLBACK_SHARED_EDIT_COVERAGE slice=" + slice);
  }
  if (!fields.restoredPaths.every((path) => fields.sharedPaths.includes(path))) {
    throw new Error("ROLLBACK_RESTORE_NOT_SHARED slice=" + slice);
  }
  if (JSON.stringify(fields.sharedPaths) !== JSON.stringify(expectedSharedPaths[slice])) {
    throw new Error("ROLLBACK_SHARED_PATH_COVERAGE slice=" + slice);
  }
  if (JSON.stringify(fields.retainedPaths) !== JSON.stringify(expectedRetainedSharedPaths)) {
    throw new Error("ROLLBACK_RETAINED_SHARED_PATH_COVERAGE slice=" + slice);
  }
}

function validateManifestOwnership(slice, manifest, fields) {
  for (const path of fields.ownedPaths) {
    if (!path.startsWith(manifest.ownedRoot + "/")) {
      throw new Error("ROLLBACK_CROSS_SLICE_OWNERSHIP slice=" + slice + " path=" + path);
    }
  }
  for (const path of fields.restoredPaths) {
    if (!path.startsWith(manifest.ownedRoot + "/")) {
      throw new Error("ROLLBACK_RESTORE_OUTSIDE_ROOT slice=" + slice + " path=" + path);
    }
  }
}

function validateReverseEdits(slice, reverseEdits, verifyGitCoverage) {
  for (const edit of reverseEdits) {
    validateReverseEditDigests(slice, edit);
    if (verifyGitCoverage) {
      const actualDigest = hashOrAbsent(repositoryRoot, edit.path);
      if (actualDigest !== edit.beforeSha256) {
        throw new Error(
          "ROLLBACK_INTEGRATOR_REHASH_REQUIRED slice=" + slice + " path=" + edit.path
          + " expected=" + edit.beforeSha256 + " actual=" + actualDigest,
        );
      }
    }
  }
}

function validateReverseEditDigests(slice, edit) {
  for (const field of ["beforeSha256", "afterSha256"]) {
    if (edit[field] !== "absent" && !/^[a-f0-9]{64}$/u.test(edit[field])) {
      throw new Error(
        "ROLLBACK_SHARED_EDIT_DIGEST slice=" + slice + " path=" + edit.path + " field=" + field,
      );
    }
  }
  if (edit.beforeSha256 === edit.afterSha256) {
    throw new Error("ROLLBACK_SHARED_EDIT_NOOP slice=" + slice + " path=" + edit.path);
  }
}

function validateRetainedPaths(slice, retainedPaths) {
  for (const retained of retainedPaths) {
    if (!/^[a-f0-9]{64}$/u.test(retained.sha256) || typeof retained.reason !== "string"
      || retained.reason.trim().length < 20) {
      throw new Error(
        "ROLLBACK_RETAINED_SHARED_PATH_INVALID slice=" + slice + " path=" + retained.path,
      );
    }
    if (hashOrAbsent(repositoryRoot, retained.path) !== retained.sha256) {
      throw new Error(
        "ROLLBACK_RETAINED_SHARED_PATH_DRIFT slice=" + slice + " path=" + retained.path,
      );
    }
  }
}

function validateGitCoverage(manifest, fields) {
  const additions = gitDiffPaths(manifest, "A");
  if (JSON.stringify(additions) !== JSON.stringify(fields.ownedPaths)) {
    throw new Error("ROLLBACK_OWNED_PATH_COVERAGE slice=" + manifest.sliceId);
  }
  const nonAdditions = gitDiffPaths(manifest, "DMRTUXB");
  if (JSON.stringify(nonAdditions) !== JSON.stringify(fields.restoredPaths)) {
    throw new Error("ROLLBACK_RESTORE_PATH_COVERAGE slice=" + manifest.sliceId);
  }
  for (const path of fields.restoredPaths) {
    const baseline = run("git", ["show", manifest.baselineSha + ":" + path]);
    const edit = fields.reverse.find((candidate) => candidate.path === path);
    const baselineDigest = createHash("sha256").update(baseline).digest("hex");
    if (edit?.afterSha256 !== baselineDigest) {
      throw new Error("ROLLBACK_RESTORE_DIGEST_MISMATCH slice=" + manifest.sliceId + " path=" + path);
    }
  }
}

function gitDiffPaths(manifest, filter) {
  return run("git", [
    "diff",
    "--name-only",
    "--diff-filter=" + filter,
    manifest.baselineSha + "..HEAD",
    "--",
    manifest.ownedRoot,
  ]).trim().split("\n").filter(Boolean).toSorted();
}

function assertManifestSetOwnership({ allOwned, allShared }) {
  for (let left = 0; left < allOwned.length; left += 1) {
    for (let right = left + 1; right < allOwned.length; right += 1) {
      if (pathsOverlap(allOwned[left].path, allOwned[right].path)) {
        throw new Error(
          "ROLLBACK_OWNERSHIP_OVERLAP left=" + allOwned[left].path
          + " right=" + allOwned[right].path,
        );
      }
    }
  }
  for (const owned of allOwned) {
    for (const shared of allShared) {
      if (pathsOverlap(owned.path, shared.path)) {
        throw new Error(
          "ROLLBACK_OWNERSHIP_SHARED_OVERLAP owned=" + owned.path + " shared=" + shared.path,
        );
      }
    }
  }
}
