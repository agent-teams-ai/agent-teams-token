import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { descriptorChild } from "./common.mjs";
import {
  closeCustodyDescriptors,
  collectCustodyDescriptorCloseFailure,
  custodyDescriptorDirectory,
  registerCustodyDescriptor,
  retainCustodyDescriptor,
} from "./custody.mjs";
import { throwDescriptorCloseFailures } from "./descriptor-close.mjs";

const RUNTIME_COMPONENT = /^[a-zA-Z0-9.+_-]+$/u;
const RUNTIME_FILE_CLOSE_FAILURE = "ROLLBACK_RUNTIME_FILE_CLOSE_FAILED";

export function openRuntimeRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) {
    throw new Error("ROLLBACK_RUNTIME_ROOT_UNSAFE path=" + String(root));
  }
  let canonical;
  let identity;
  try {
    canonical = realpathSync(root);
    identity = lstatSync(root, { bigint: true });
  } catch (error) {
    throw new Error("ROLLBACK_RUNTIME_ROOT_UNSAFE path=" + root, { cause: error });
  }
  if (canonical !== root || !identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error("ROLLBACK_RUNTIME_ROOT_UNSAFE path=" + root);
  }
  let descriptor;
  try {
    descriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    assertRuntimeIdentity(
      identity,
      fstatSync(descriptor, { bigint: true }),
      "ROLLBACK_RUNTIME_ROOT_IDENTITY_CHANGED",
    );
    assertRuntimeIdentity(
      identity,
      lstatSync(root, { bigint: true }),
      "ROLLBACK_RUNTIME_ROOT_IDENTITY_CHANGED",
    );
    registerCustodyDescriptor(descriptor, canonical, identity);
  } catch (error) {
    const primaryFailure = runtimePathFailure(error, "ROLLBACK_RUNTIME_ROOT_UNSAFE path=" + root);
    const closing = descriptor;
    descriptor = undefined;
    closeCustodyDescriptors([closing], RUNTIME_FILE_CLOSE_FAILURE, primaryFailure);
  }
  return { canonicalPath: canonical, descriptor, identity };
}

export function openRuntimeRegularFile(runtimeRoot, components, options) {
  if (!Array.isArray(components) || components.length < 2
    || components.some((component) => !RUNTIME_COMPONENT.test(component))) {
    throw new Error(options.unsafeCode + " path=" + options.label);
  }
  let directory;
  let file;
  let primaryFailure;
  try {
    directory = openSync(
      custodyDescriptorDirectory(runtimeRoot.descriptor),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    assertRuntimeIdentity(
      runtimeRoot.identity,
      fstatSync(directory, { bigint: true }),
      options.unsafeCode + " path=.",
    );
    registerCustodyDescriptor(directory, runtimeRoot.canonicalPath, runtimeRoot.identity);
    for (const component of components.slice(0, -1)) {
      const candidate = descriptorChild(directory, component);
      const before = readRuntimePathEntry(candidate, options);
      assertRuntimeOwnedDirectory(before, runtimeRoot.identity, options);
      const next = openRuntimeDirectoryEntry(candidate, before, options);
      const previous = directory;
      directory = next;
      closeCustodyDescriptors([previous], RUNTIME_FILE_CLOSE_FAILURE);
    }
    const candidate = descriptorChild(directory, components.at(-1));
    const identity = readRuntimePathEntry(candidate, options);
    assertRuntimeOwnedFile(identity, runtimeRoot.identity, options);
    file = openRuntimeFileEntry(candidate, identity, options);
  } catch (error) {
    primaryFailure = runtimePathFailure(error, options.unsafeCode + " path=" + options.label);
  }
  const closingDirectory = directory;
  directory = undefined;
  const failures = [];
  collectCustodyDescriptorCloseFailure(closingDirectory, failures);
  // Keep the result owned until parent finalization succeeds. Otherwise a
  // finally error after a return expression would strand the open result file.
  if (primaryFailure !== undefined || failures.length > 0) {
    const closingFile = file?.descriptor;
    file = undefined;
    collectCustodyDescriptorCloseFailure(closingFile, failures);
  }
  throwDescriptorCloseFailures(failures, RUNTIME_FILE_CLOSE_FAILURE, primaryFailure);
  const result = file;
  file = undefined;
  return result;
}

function runtimePathFailure(error, code) {
  return error instanceof Error && error.message.startsWith("ROLLBACK_RUNTIME_")
    ? error : new Error(code, { cause: error });
}

function readRuntimePathEntry(candidate, options) {
  try {
    return lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(options.missingCode + " path=" + options.label, { cause: error });
    }
    throw error;
  }
}

function assertRuntimeOwnedDirectory(identity, rootIdentity, options) {
  if (!identity.isDirectory() || identity.isSymbolicLink()
    || identity.dev !== rootIdentity.dev || identity.uid !== rootIdentity.uid) {
    throw new Error(options.unsafeCode + " path=" + options.label);
  }
}

function openRuntimeDirectoryEntry(candidate, identity, options) {
  return retainCustodyDescriptor(openSync(
    candidate,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ), RUNTIME_FILE_CLOSE_FAILURE, (descriptor) => {
    assertRuntimeIdentity(
      identity,
      fstatSync(descriptor, { bigint: true }),
      options.unsafeCode + " path=" + options.label,
    );
    assertRuntimeIdentity(
      identity,
      lstatSync(candidate, { bigint: true }),
      options.unsafeCode + " path=" + options.label,
    );
    registerCustodyDescriptor(descriptor, realpathSync(candidate), identity);
  });
}

function assertRuntimeOwnedFile(identity, rootIdentity, options) {
  const executableUnsafe = options.executable === true && (identity.mode & 0o111n) === 0n;
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n
    || identity.dev !== rootIdentity.dev || identity.uid !== rootIdentity.uid
    || identity.size < 0n || identity.size > BigInt(options.maxBytes) || executableUnsafe) {
    throw new Error(options.unsafeCode + " path=" + options.label);
  }
}

function openRuntimeFileEntry(candidate, identity, options) {
  const descriptor = retainCustodyDescriptor(
    openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW),
    RUNTIME_FILE_CLOSE_FAILURE,
    (opened) => assertRuntimeIdentity(identity, fstatSync(opened, { bigint: true }),
      options.unsafeCode + " path=" + options.label),
  );
  return { descriptor, identity, maxBytes: options.maxBytes };
}

export function readRuntimeFile(file, unsafeCode, { captureBytes = false } = {}) {
  const length = Number(file.identity.size);
  if (!Number.isSafeInteger(length) || length < 0 || length > file.maxBytes) {
    throw new Error(unsafeCode + " size=" + String(file.identity.size));
  }
  const hash = createHash("sha256");
  const chunks = captureBytes ? [] : undefined;
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < length) {
    const count = readSync(
      file.descriptor,
      buffer,
      0,
      Math.min(buffer.length, length - offset),
      offset,
    );
    if (count === 0) {
      throw new Error(unsafeCode + " reason=short-read");
    }
    const chunk = Buffer.from(buffer.subarray(0, count));
    chunks?.push(chunk);
    hash.update(chunk);
    offset += count;
  }
  const after = fstatSync(file.descriptor, { bigint: true });
  assertRuntimeIdentity(file.identity, after, unsafeCode + " reason=identity-changed");
  if (after.size !== file.identity.size || after.mtimeNs !== file.identity.mtimeNs
    || after.ctimeNs !== file.identity.ctimeNs) {
    throw new Error(unsafeCode + " reason=content-changed");
  }
  return {
    bytes: captureBytes ? Buffer.concat(chunks, length) : undefined,
    sha256: hash.digest("hex"),
  };
}

export function assertRuntimeIdentity(expected, actual, code) {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino
    || expected.mode !== actual.mode || expected.uid !== actual.uid || expected.gid !== actual.gid
    || expected.isDirectory() !== actual.isDirectory()
    || expected.isFile() !== actual.isFile()
    || expected.isSymbolicLink() !== actual.isSymbolicLink()) {
    throw new Error(code);
  }
}
