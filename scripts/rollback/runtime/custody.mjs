import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Backend-neutral custody for recovery filesystem authority.
 *
 * Linux traverses children through /proc/self/fd. Darwin retains a canonical
 * path alongside every held directory FD because /dev/fd/N/child cannot be
 * traversed there. Node exposes no *at(2), so a same-UID peer can still race the
 * final pathname syscall after the last check. Mutation callers must provide an
 * injectable boundary and recheck immediately after it.
 */
export const CUSTODY_IDENTITY_FIELDS = Object.freeze([
  "birthtimeNs", "ctimeNs", "dev", "gid", "ino", "mode", "mtimeNs", "nlink",
  "size", "uid",
]);

const descriptorRecords = new Map();
const custodyRecords = new WeakMap();

export function custodyKind(stat) {
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    return "directory";
  }
  if (stat.isFile() && !stat.isSymbolicLink()) {
    return "file";
  }
  if (stat.isSymbolicLink()) {
    return "symlink";
  }
  return "unsafe";
}

export function custodyIdentity(stat) {
  const value = { kind: custodyKind(stat) };
  for (const field of CUSTODY_IDENTITY_FIELDS) {
    value[field] = stat[field];
  }
  return Object.freeze(value);
}

export function custodyIdentityJson(identity) {
  const value = { kind: identity.kind };
  for (const field of CUSTODY_IDENTITY_FIELDS) {
    value[field] = String(identity[field]);
  }
  return Object.freeze(value);
}

export function assertCustodyIdentity(expected, actual, code = "ROLLBACK_CUSTODY_SUBSTITUTED") {
  const baseline = expected.kind === undefined ? custodyIdentity(expected) : expected;
  const observed = actual.kind === undefined ? custodyIdentity(actual) : actual;
  if (baseline.kind !== observed.kind
    || CUSTODY_IDENTITY_FIELDS.some((field) => baseline[field] !== observed[field])) {
    throw new Error(code);
  }
  return observed;
}

export function assertCustodyStableObject(expected, actual, code) {
  const baseline = expected.kind === undefined ? custodyIdentity(expected) : expected;
  const observed = actual.kind === undefined ? custodyIdentity(actual) : actual;
  if (baseline.kind !== observed.kind || baseline.dev !== observed.dev
    || baseline.ino !== observed.ino || baseline.mode !== observed.mode
    || baseline.uid !== observed.uid || baseline.gid !== observed.gid) {
    throw new Error(code ?? "ROLLBACK_CUSTODY_SUBSTITUTED");
  }
  return observed;
}

export function validateCustodyComponent(component) {
  if (typeof component !== "string" || component.length === 0 || component === "."
    || component === ".." || component.includes("/") || component.includes("\0")) {
    throw new Error("ROLLBACK_CUSTODY_COMPONENT_UNSAFE component=" + String(component));
  }
  return component;
}

export function custodyBackendChild(platform, descriptor, canonicalPath, component) {
  validateCustodyComponent(component);
  if (platform === "linux") {
    return `/proc/self/fd/${descriptor}/${component}`;
  }
  if (platform === "darwin") {
    if (typeof canonicalPath !== "string" || !isAbsolute(canonicalPath)) {
      throw new Error("ROLLBACK_CUSTODY_CANONICAL_PATH_REQUIRED");
    }
    return join(canonicalPath, component);
  }
  throw new Error("ROLLBACK_CUSTODY_PLATFORM_UNSUPPORTED platform=" + platform);
}

export function custodyBackendDirectory(platform, descriptor, canonicalPath) {
  if (platform === "linux") {
    return `/proc/self/fd/${descriptor}/.`;
  }
  if (platform === "darwin") {
    return canonicalPath;
  }
  throw new Error("ROLLBACK_CUSTODY_PLATFORM_UNSUPPORTED platform=" + platform);
}

export function assertCustodyCanonicalSpelling({
  requestedPath,
  canonicalPath,
  platform = process.platform,
  allowDarwinTemporaryAlias = false,
}) {
  const requested = resolve(requestedPath);
  if (canonicalPath === requested) {
    return;
  }
  if (platform === "darwin" && allowDarwinTemporaryAlias
    && requested.startsWith("/var/folders/") && canonicalPath === "/private" + requested) {
    return;
  }
  throw new Error("ROLLBACK_CUSTODY_CANONICALIZATION_UNSAFE requested=" + requestedPath
    + " canonical=" + canonicalPath);
}

function flags(kind, write = false) {
  if (!Number.isInteger(constants.O_NOFOLLOW)
    || (kind === "directory" && !Number.isInteger(constants.O_DIRECTORY))) {
    throw new Error("ROLLBACK_CUSTODY_NOFOLLOW_UNAVAILABLE");
  }
  return (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW
    | (kind === "directory" ? constants.O_DIRECTORY : 0);
}

function openDirectoryRecord(path) {
  const identity = custodyIdentity(lstatSync(path, { bigint: true }));
  const descriptor = openSync(path, flags("directory"));
  try {
    if (identity.kind !== "directory") {
      throw new Error("ROLLBACK_CUSTODY_NOT_DIRECTORY");
    }
    assertCustodyIdentity(identity, fstatSync(descriptor, { bigint: true }));
    assertCustodyIdentity(identity, lstatSync(path, { bigint: true }));
    return { canonicalPath: path, descriptor, identity };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function ancestorsOf(path) {
  const paths = [];
  let current = dirname(path);
  while (current !== dirname(current)) {
    paths.push(current);
    current = dirname(current);
  }
  paths.push(current);
  const records = [];
  try {
    for (const ancestorPath of paths.toReversed()) {
      records.push(openDirectoryRecord(ancestorPath));
    }
    return records;
  } catch (error) {
    for (const record of records.toReversed()) {
      closeSync(record.descriptor);
    }
    throw error;
  }
}

function assertDirectoryPolicy(record, options) {
  const uid = BigInt(process.getuid());
  if (options.owned === true
    && (record.identity.uid !== uid || (record.identity.mode & 0o777n) !== 0o700n)) {
    throw new Error("ROLLBACK_CUSTODY_OWNED_DIRECTORY_UNSAFE path=" + record.canonicalPath);
  }
  if (options.authorityRoot === true) {
    const ownedPrivate = record.identity.uid === uid && (record.identity.mode & 0o022n) === 0n;
    const rootSticky = record.identity.uid === 0n && (record.identity.mode & 0o1000n) !== 0n
      && (record.identity.mode & 0o002n) !== 0n;
    if (!ownedPrivate && !rootSticky) {
      throw new Error("ROLLBACK_CUSTODY_AUTHORITY_ROOT_UNSAFE path=" + record.canonicalPath);
    }
  }
}

export function createDirectoryCustody(requestedPath, options = {}) {
  if (typeof requestedPath !== "string" || !isAbsolute(requestedPath)
    || requestedPath.includes("\0")) {
    throw new Error("ROLLBACK_CUSTODY_PATH_UNSAFE path=" + String(requestedPath));
  }
  const platform = options.platform ?? process.platform;
  if (!["linux", "darwin"].includes(platform) || typeof process.getuid !== "function") {
    throw new Error("ROLLBACK_CUSTODY_PLATFORM_UNSUPPORTED platform=" + platform);
  }
  const canonicalPath = realpathSync(requestedPath);
  assertCustodyCanonicalSpelling({ requestedPath, canonicalPath, platform,
    allowDarwinTemporaryAlias: options.allowDarwinTemporaryAlias === true });
  const ancestors = ancestorsOf(canonicalPath);
  let target;
  try {
    target = openDirectoryRecord(canonicalPath);
    assertDirectoryPolicy(target, options);
    const handle = Object.freeze({
      requestedPath,
      canonicalPath,
      descriptor: target.descriptor,
      expectedPermissions: options.owned === true ? "0700" : undefined,
      identity: target.identity,
      ancestorChain: Object.freeze(ancestors.map((entry) => Object.freeze({
        canonicalPath: entry.canonicalPath,
        descriptor: entry.descriptor,
        identity: entry.identity,
      }))),
    });
    const state = {
      ...target,
      ancestors,
      authorityRoot: options.authorityRoot === true,
      closed: false,
      owned: options.owned === true,
      platform,
    };
    custodyRecords.set(handle, state);
    registerCustodyDescriptor(target.descriptor, canonicalPath, target.identity);
    for (const ancestor of ancestors) {
      registerCustodyDescriptor(ancestor.descriptor, ancestor.canonicalPath, ancestor.identity);
    }
    return handle;
  } catch (error) {
    if (target !== undefined) {
      closeSync(target.descriptor);
    }
    for (const ancestor of ancestors.toReversed()) {
      closeSync(ancestor.descriptor);
    }
    throw error;
  }
}

function stateOf(handle) {
  const state = custodyRecords.get(handle);
  if (state === undefined || state.closed) {
    throw new Error("ROLLBACK_CUSTODY_HANDLE_CLOSED");
  }
  return state;
}

function verifyStableRecord(record, code) {
  // Harmless sibling churn changes directory ctime/mtime/nlink/size. Ancestor
  // authority binds stable object identity, ownership and mode; specific leaves
  // and transitions continue to use the complete fingerprint.
  assertCustodyStableObject(record.identity, fstatSync(record.descriptor, { bigint: true }), code);
  assertCustodyStableObject(record.identity, lstatSync(record.canonicalPath, { bigint: true }), code);
}

export function verifyDirectoryCustody(handle, code = "ROLLBACK_CUSTODY_ANCESTOR_SUBSTITUTED") {
  const state = stateOf(handle);
  for (const ancestor of state.ancestors) {
    verifyStableRecord(ancestor, code);
  }
  assertCustodyIdentity(state.identity, fstatSync(state.descriptor, { bigint: true }), code);
  assertCustodyIdentity(state.identity, lstatSync(state.canonicalPath, { bigint: true }), code);
  return custodyIdentityJson(state.identity);
}

export function refreshDirectoryCustody(handle) {
  const state = stateOf(handle);
  for (const ancestor of state.ancestors) {
    verifyStableRecord(ancestor, "ROLLBACK_CUSTODY_ANCESTOR_SUBSTITUTED");
  }
  const next = custodyIdentity(fstatSync(state.descriptor, { bigint: true }));
  assertCustodyStableObject(
    state.identity,
    next,
    "ROLLBACK_CUSTODY_DIRECTORY_TRANSITION_UNSAFE",
  );
  assertCustodyIdentity(next, lstatSync(state.canonicalPath, { bigint: true }));
  try {
    assertDirectoryPolicy({ canonicalPath: state.canonicalPath, identity: next }, {
      authorityRoot: state.authorityRoot,
      owned: state.owned,
    });
  } catch (error) {
    throw new Error("ROLLBACK_CUSTODY_DIRECTORY_TRANSITION_UNSAFE", { cause: error });
  }
  state.identity = next;
  registerCustodyDescriptor(state.descriptor, state.canonicalPath, next);
  return Object.freeze({ identity: custodyIdentityJson(next), status: "verified" });
}

export function closeDirectoryCustody(handle) {
  const state = custodyRecords.get(handle);
  if (state === undefined || state.closed) {
    return;
  }
  state.closed = true;
  const failures = [];
  const close = (descriptor) => {
    try {
      // close(2) may have released the descriptor even when it reports EINTR;
      // never retry and risk closing a subsequently reused descriptor number.
      closeCustodyDescriptor(descriptor);
    } catch (error) {
      failures.push(error);
    }
  };
  close(state.descriptor);
  for (const ancestor of state.ancestors.toReversed()) {
    close(ancestor.descriptor);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "ROLLBACK_CUSTODY_CLOSE_FAILED");
  }
}

export function registerCustodyDescriptor(descriptor, canonicalPath, identity) {
  if (!Number.isInteger(descriptor) || typeof canonicalPath !== "string"
    || !isAbsolute(canonicalPath)) {
    throw new Error("ROLLBACK_CUSTODY_DESCRIPTOR_INVALID");
  }
  const captured = identity.kind === undefined ? custodyIdentity(identity) : identity;
  if (CUSTODY_IDENTITY_FIELDS.some((field) => typeof captured[field] !== "bigint")) {
    throw new Error("ROLLBACK_CUSTODY_DESCRIPTOR_IDENTITY_INVALID");
  }
  descriptorRecords.set(descriptor, { canonicalPath, identity: captured });
}

export function forgetCustodyDescriptor(descriptor) { descriptorRecords.delete(descriptor); }

export function closeCustodyDescriptor(descriptor) {
  forgetCustodyDescriptor(descriptor);
  closeSync(descriptor);
}
export function updateCustodyDescriptor(descriptor, canonicalPath, identity) {
  const previous = descriptorRecords.get(descriptor);
  if (previous === undefined) {
    throw new Error("ROLLBACK_CUSTODY_DESCRIPTOR_UNREGISTERED");
  }
  const observed = custodyIdentity(fstatSync(descriptor, { bigint: true }));
  assertCustodyStableObject(identity ?? previous.identity, observed);
  registerCustodyDescriptor(descriptor, canonicalPath, observed);
  return custodyIdentityJson(observed);
}

export function assertCustodyDescriptor(
  descriptor,
  code = "ROLLBACK_CUSTODY_PARENT_SUBSTITUTED",
) {
  const record = descriptorRecords.get(descriptor);
  if (record === undefined) {
    throw new Error("ROLLBACK_CUSTODY_DESCRIPTOR_UNREGISTERED");
  }
  verifyStableRecord({ descriptor, ...record }, code);
  return record;
}

export function custodyDescriptorChild(descriptor, component) {
  const record = descriptorRecords.get(descriptor);
  if (process.platform === "darwin") {
    assertCustodyDescriptor(descriptor);
  }
  return custodyBackendChild(process.platform, descriptor, record?.canonicalPath, component);
}

export function custodyDescriptorDirectory(descriptor) {
  const record = descriptorRecords.get(descriptor);
  if (process.platform === "darwin") {
    assertCustodyDescriptor(descriptor);
  }
  return custodyBackendDirectory(process.platform, descriptor, record?.canonicalPath);
}

export function openCustodyEntry(descriptor, component, options = {}) {
  validateCustodyComponent(component);
  const parent = assertCustodyDescriptor(descriptor);
  const path = custodyDescriptorChild(descriptor, component);
  const before = custodyIdentity(lstatSync(path, { bigint: true }));
  if (options.kind !== undefined && before.kind !== options.kind) {
    throw new Error("ROLLBACK_CUSTODY_ENTRY_TYPE_UNSAFE component=" + component);
  }
  if (before.kind === "symlink") {
    const first = readlinkSync(path, { encoding: "buffer" });
    assertCustodyIdentity(before, lstatSync(path, { bigint: true }));
    const second = readlinkSync(path, { encoding: "buffer" });
    if (!first.equals(second)) {
      throw new Error("ROLLBACK_CUSTODY_SYMLINK_CHANGED");
    }
    assertCustodyDescriptor(descriptor);
    return { identity: before, linkBytes: first, path };
  }
  if (!["directory", "file"].includes(before.kind)) {
    throw new Error("ROLLBACK_CUSTODY_ENTRY_TYPE_UNSAFE component=" + component);
  }
  const held = openSync(path, flags(before.kind, options.write === true));
  try {
    assertCustodyIdentity(before, fstatSync(held, { bigint: true }));
    assertCustodyIdentity(before, lstatSync(path, { bigint: true }));
    registerCustodyDescriptor(held, join(parent.canonicalPath, component), before);
    assertCustodyDescriptor(descriptor);
    return { descriptor: held, identity: before, path };
  } catch (error) {
    closeSync(held);
    throw error;
  }
}

export function assertCustodySymlink(path, expectedIdentity, expectedBytes) {
  const first = custodyIdentity(lstatSync(path, { bigint: true }));
  assertCustodyIdentity(expectedIdentity, first);
  const firstBytes = readlinkSync(path, { encoding: "buffer" });
  const second = custodyIdentity(lstatSync(path, { bigint: true }));
  const secondBytes = readlinkSync(path, { encoding: "buffer" });
  assertCustodyIdentity(first, second);
  if (!firstBytes.equals(expectedBytes) || !secondBytes.equals(expectedBytes)) {
    throw new Error("ROLLBACK_CUSTODY_SYMLINK_CHANGED");
  }
}

export function assertCustodyDirectChild(parentCanonicalPath, childCanonicalPath, component) {
  validateCustodyComponent(component);
  if (dirname(childCanonicalPath) !== parentCanonicalPath
    || relative(parentCanonicalPath, childCanonicalPath) !== component) {
    throw new Error("ROLLBACK_CUSTODY_NOT_DIRECT_CHILD");
  }
}
