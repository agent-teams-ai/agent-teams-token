import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  compareUtf8,
  descriptorChild,
  openDirectoryDescriptor,
  resolveInside,
  sha256,
  validateTrackedPath,
} from "./common.mjs";

export function assertPathsAbsent(root, paths, label = "rollback") {
  if (!Array.isArray(paths) || paths.length === 0
    || paths.some((path) => typeof path !== "string")) {
    throw new Error("ROLLBACK_FORBIDDEN_PATH_SET_INVALID label=" + label);
  }
  const exactPaths = [...paths].toSorted();
  if (new Set(exactPaths).size !== exactPaths.length) {
    throw new Error("ROLLBACK_FORBIDDEN_PATH_SET_INVALID label=" + label);
  }
  for (const path of exactPaths) {
    validateTrackedPath(path);
    try {
      lstatSync(resolveInside(root, path));
      throw new Error("ROLLBACK_FORBIDDEN_RESIDUE label=" + label + " path=" + path);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return {
    status: "passed",
    pathCount: exactPaths.length,
    pathsSha256: sha256(Buffer.from(JSON.stringify(exactPaths), "utf8")),
  };
}

export function assertExactDirectoryShape(
  root,
  ownedRoot,
  allowedFiles,
  label = "rollback",
) {
  if (typeof ownedRoot !== "string"
    || Buffer.byteLength(ownedRoot, "utf8") > SHAPE_MAX_PATH_BYTES
    || ownedRoot.split("/").length > SHAPE_MAX_DEPTH) {
    throw new Error("ROLLBACK_ALLOWED_SHAPE_INVALID label=" + label);
  }
  validateTrackedPath(ownedRoot);
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0 || allowedFiles.length > 4_096
    || allowedFiles.some((path) => typeof path !== "string"
      || Buffer.byteLength(path, "utf8") > SHAPE_MAX_PATH_BYTES
      || path.split("/").length > SHAPE_MAX_DEPTH)) {
    throw new Error("ROLLBACK_ALLOWED_SHAPE_INVALID label=" + label);
  }
  const exactFiles = [...allowedFiles].toSorted();
  if (new Set(exactFiles).size !== exactFiles.length) {
    throw new Error("ROLLBACK_ALLOWED_SHAPE_INVALID label=" + label);
  }
  const allowedDirectories = new Set([ownedRoot]);
  for (const path of exactFiles) {
    validateTrackedPath(path);
    if (!path.startsWith(ownedRoot + "/")) {
      throw new Error("ROLLBACK_ALLOWED_SHAPE_INVALID label=" + label);
    }
    let current = dirname(path);
    while (current !== ownedRoot) {
      if (!current.startsWith(ownedRoot + "/")) {
        throw new Error("ROLLBACK_ALLOWED_SHAPE_INVALID label=" + label);
      }
      allowedDirectories.add(current);
      current = dirname(current);
    }
  }

  const rootBefore = lstatSync(root, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new Error("ROLLBACK_OWNED_ROOT_UNSAFE label=" + label);
  }
  const rootDescriptor = openDirectoryDescriptor(root);
  let owned;
  try {
    assertShapeIdentity(rootBefore, fstatSync(rootDescriptor, { bigint: true }), ".", label);
    owned = openShapeDirectoryPath(rootDescriptor, ownedRoot, rootBefore, label);
    const ownedIdentity = owned.identity;
    const ownedDescriptor = owned.descriptor;
    owned = undefined;
    const state = {
      discovered: 1,
      expectedFiles: new Set(exactFiles),
      observedFiles: new Set(),
      records: [],
      totalBytes: 0,
    };
    try {
      visitShapeDirectory(ownedDescriptor, ownedIdentity, ownedRoot, ownedRoot.split("/").length, {
        allowedDirectories,
        rootIdentity: rootBefore,
        label,
        state,
      });
    } finally {
      closeSync(ownedDescriptor);
    }
    assertShapeIdentity(rootBefore, lstatSync(root, { bigint: true }), ".", label);
    const finalOwned = openShapeDirectoryPath(rootDescriptor, ownedRoot, rootBefore, label);
    try {
      assertShapeIdentity(ownedIdentity, finalOwned.identity, ownedRoot, label);
    } finally {
      closeSync(finalOwned.descriptor);
    }
    if (JSON.stringify([...state.observedFiles].toSorted()) !== JSON.stringify(exactFiles)) {
      throw new Error("ROLLBACK_ALLOWED_SHAPE_MISSING label=" + label);
    }
    return {
      status: "passed",
      entryCount: state.records.length,
      directoryCount: state.records.filter(({ type }) => type === "directory").length,
      fileCount: state.observedFiles.size,
      totalBytes: state.totalBytes,
      limits: {
        maxDepth: SHAPE_MAX_DEPTH,
        maxEntries: SHAPE_MAX_ENTRIES,
        maxFileBytes: SHAPE_MAX_FILE_BYTES,
        maxPathBytes: SHAPE_MAX_PATH_BYTES,
        maxTotalBytes: SHAPE_MAX_TOTAL_BYTES,
      },
      shapeSha256: sha256(Buffer.from(JSON.stringify(state.records), "utf8")),
    };
  } finally {
    if (owned !== undefined) {
      closeSync(owned.descriptor);
    }
    closeSync(rootDescriptor);
  }
}

const SHAPE_MAX_ENTRIES = 4_096;
const SHAPE_MAX_DEPTH = 128;
const SHAPE_MAX_PATH_BYTES = 16_384;
const SHAPE_MAX_FILE_BYTES = 16 * 1024 * 1024;
const SHAPE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function openShapeDirectoryPath(rootDescriptor, logicalPath, rootIdentity, label) {
  let descriptor = openDirectoryDescriptor(descriptorChild(rootDescriptor, "."));
  let identity = fstatSync(descriptor, { bigint: true });
  try {
    assertShapeIdentity(rootIdentity, identity, ".", label);
    for (const component of logicalPath.split("/")) {
      const candidate = descriptorChild(descriptor, component);
      const before = lstatSync(candidate, { bigint: true });
      assertShapeSafeNode(before, "directory", rootIdentity, logicalPath, label);
      const next = openDirectoryDescriptor(candidate);
      try {
        assertShapeIdentity(before, fstatSync(next, { bigint: true }), logicalPath, label);
      } catch (error) {
        closeSync(next);
        throw error;
      }
      closeSync(descriptor);
      descriptor = next;
      identity = before;
    }
    const result = { descriptor, identity };
    descriptor = undefined;
    return result;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function visitShapeDirectory(
  descriptor,
  identity,
  logicalPath,
  depth,
  context,
) {
  const { allowedDirectories, rootIdentity, label, state } = context;
  assertShapePathBounds(logicalPath, depth, label);
  if (!allowedDirectories.has(logicalPath)) {
    throw new Error("ROLLBACK_FORBIDDEN_DIRECTORY_RESIDUE label=" + label + " path=" + logicalPath);
  }
  state.records.push({ path: logicalPath, type: "directory" });
  const names = readShapeDirectoryNames(descriptor, state, label, true);
  for (const name of names) {
    const child = logicalPath + "/" + name;
    validateTrackedPath(child);
    assertShapePathBounds(child, depth + 1, label);
    const candidate = descriptorChild(descriptor, name);
    const before = lstatSync(candidate, { bigint: true });
    if (before.isDirectory() && !before.isSymbolicLink()) {
      assertShapeSafeNode(before, "directory", rootIdentity, child, label);
      const childDescriptor = openDirectoryDescriptor(candidate);
      try {
        assertShapeIdentity(before, fstatSync(childDescriptor, { bigint: true }), child, label);
        visitShapeDirectory(childDescriptor, before, child, depth + 1, context);
        assertShapeIdentity(before, lstatSync(candidate, { bigint: true }), child, label);
      } finally {
        closeSync(childDescriptor);
      }
      continue;
    }
    if (!before.isFile() || before.isSymbolicLink() || !state.expectedFiles.has(child)) {
      throw new Error("ROLLBACK_FORBIDDEN_RESIDUE label=" + label + " path=" + child);
    }
    assertShapeSafeNode(before, "file", rootIdentity, child, label);
    const fileDescriptor = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      assertShapeIdentity(before, fstatSync(fileDescriptor, { bigint: true }), child, label);
      const file = hashShapeFile(fileDescriptor, before, child, label, state);
      const atPath = lstatSync(candidate, { bigint: true });
      assertShapeIdentity(before, atPath, child, label);
      if (atPath.size !== before.size || atPath.mtimeNs !== before.mtimeNs
        || atPath.ctimeNs !== before.ctimeNs) {
        throw new Error("ROLLBACK_OWNED_ROOT_CONTENT_CHANGED label=" + label + " path=" + child);
      }
      state.observedFiles.add(child);
      state.records.push({
        path: child,
        type: "file",
        mode: Number(before.mode & 0o777n),
        byteLength: file.byteLength,
        sha256: file.sha256,
      });
    } finally {
      closeSync(fileDescriptor);
    }
  }
  const afterNames = readShapeDirectoryNames(descriptor, state, label, false);
  if (JSON.stringify(afterNames) !== JSON.stringify(names)) {
    throw new Error("ROLLBACK_OWNED_ROOT_SHAPE_CHANGED label=" + label + " path=" + logicalPath);
  }
  assertShapeIdentity(identity, fstatSync(descriptor, { bigint: true }), logicalPath, label);
}

function readShapeDirectoryNames(descriptor, state, label, countEntries) {
  const directory = opendirSync(descriptorChild(descriptor, "."), { encoding: "buffer" });
  const names = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) {
        break;
      }
      if (names.length >= SHAPE_MAX_ENTRIES) {
        throw new Error("ROLLBACK_OWNED_ROOT_SHAPE_BOUNDS label=" + label);
      }
      if (countEntries) {
        state.discovered += 1;
        if (state.discovered > SHAPE_MAX_ENTRIES) {
          throw new Error("ROLLBACK_OWNED_ROOT_SHAPE_BOUNDS label=" + label);
        }
      }
      const bytes = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, "utf8");
      const name = bytes.toString("utf8");
      if (!Buffer.from(name, "utf8").equals(bytes) || name === "." || name === ".."
        || name.includes("/") || name.includes("\0") || bytes.length > 255) {
        throw new Error("ROLLBACK_OWNED_ROOT_NAME_UNSAFE label=" + label);
      }
      names.push(name);
    }
  } finally {
    directory.closeSync();
  }
  return names.toSorted(compareUtf8);
}

function hashShapeFile(descriptor, expected, logicalPath, label, state) {
  if (expected.size < 0n || expected.size > BigInt(SHAPE_MAX_FILE_BYTES)
    || state.totalBytes + Number(expected.size) > SHAPE_MAX_TOTAL_BYTES) {
    throw new Error("ROLLBACK_OWNED_ROOT_SHAPE_BYTES label=" + label + " path=" + logicalPath);
  }
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  const length = Number(expected.size);
  while (offset < length) {
    const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, length - offset), offset);
    if (count === 0) {
      throw new Error("ROLLBACK_OWNED_ROOT_SHORT_READ label=" + label + " path=" + logicalPath);
    }
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  const after = fstatSync(descriptor, { bigint: true });
  assertShapeIdentity(expected, after, logicalPath, label);
  if (after.size !== expected.size || after.mtimeNs !== expected.mtimeNs
    || after.ctimeNs !== expected.ctimeNs) {
    throw new Error("ROLLBACK_OWNED_ROOT_CONTENT_CHANGED label=" + label + " path=" + logicalPath);
  }
  state.totalBytes += length;
  return { byteLength: length, sha256: hash.digest("hex") };
}

function assertShapePathBounds(logicalPath, depth, label) {
  if (depth > SHAPE_MAX_DEPTH || Buffer.byteLength(logicalPath, "utf8") > SHAPE_MAX_PATH_BYTES) {
    throw new Error("ROLLBACK_OWNED_ROOT_SHAPE_BOUNDS label=" + label);
  }
}

function assertShapeSafeNode(identity, kind, rootIdentity, logicalPath, label) {
  if ((kind === "directory" ? !identity.isDirectory() : !identity.isFile())
    || identity.isSymbolicLink() || identity.dev !== rootIdentity.dev
    || identity.uid !== rootIdentity.uid) {
    throw new Error("ROLLBACK_OWNED_ROOT_NODE_UNSAFE label=" + label + " path=" + logicalPath);
  }
}

function assertShapeIdentity(expected, actual, logicalPath, label) {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.uid !== actual.uid
    || expected.mode !== actual.mode || expected.nlink !== actual.nlink
    || expected.isDirectory() !== actual.isDirectory()
    || expected.isFile() !== actual.isFile()
    || expected.isSymbolicLink() !== actual.isSymbolicLink()) {
    throw new Error("ROLLBACK_OWNED_ROOT_IDENTITY_CHANGED label=" + label + " path=" + logicalPath);
  }
}
