import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  assertCustodyCanonicalSpelling,
  assertCustodyStableObject,
  assertCustodyDirectChild,
  forgetCustodyDescriptor,
  registerCustodyDescriptor,
} from "../runtime/custody.mjs";

import { validateExactPath } from "./manifests.mjs";

const rollbackWorkspaceStates = new WeakMap();

function assertRollbackRemovalIdentity(expected, actual, logicalPath) {
  try {
    assertCustodyStableObject(expected, actual);
  } catch (error) {
    throw new Error("ROLLBACK_REMOVAL_IDENTITY_MISMATCH path=" + logicalPath, { cause: error });
  }
}

export function safeCandidatePath(root, path) {
  validateExactPath(path, "candidate");
  const candidate = resolve(root, path);
  if (relative(root, candidate).startsWith("..")) {
    throw new Error(`ROLLBACK_PATH_ESCAPE path=${path}`);
  }
  return candidate;
}

export function parentDirectories(path, ownedRoot) {
  const directories = [];
  let current = dirname(path);
  while (current !== ownedRoot) {
    if (!current.startsWith(ownedRoot + "/")) {
      throw new Error("ROLLBACK_OWNED_DIRECTORY_ESCAPE path=" + path);
    }
    directories.push(current);
    current = dirname(current);
  }
  directories.push(ownedRoot);
  return directories;
}

export function createRollbackWorkspaceHandle(root, quarantineRoot) {
  validateRollbackWorkspaceArguments(root, quarantineRoot);
  const checkoutPath = realpathSync(root);
  const quarantinePath = realpathSync(quarantineRoot);
  validateRollbackWorkspacePaths(root, quarantineRoot, checkoutPath, quarantinePath);
  const checkoutIdentity = lstatSync(checkoutPath, { bigint: true });
  const quarantineIdentity = lstatSync(quarantinePath, { bigint: true });
  const owner = String(process.getuid());
  validateRollbackWorkspaceIdentities(checkoutIdentity, quarantineIdentity, owner);
  let checkoutDescriptor;
  let quarantineDescriptor;
  try {
    checkoutDescriptor = openSync(
      checkoutPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    quarantineDescriptor = openSync(
      quarantinePath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    registerCustodyDescriptor(checkoutDescriptor, checkoutPath, checkoutIdentity);
    registerCustodyDescriptor(quarantineDescriptor, quarantinePath, quarantineIdentity);
    assertRollbackRemovalIdentity(
      checkoutIdentity,
      fstatSync(checkoutDescriptor, { bigint: true }),
      ".",
    );
    assertRollbackRemovalIdentity(
      quarantineIdentity,
      fstatSync(quarantineDescriptor, { bigint: true }),
      "gate-tmp",
    );
    const handle = Object.freeze({
      checkoutPath,
      quarantinePath,
      checkoutDevice: String(checkoutIdentity.dev),
      checkoutInode: String(checkoutIdentity.ino),
      quarantineDevice: String(quarantineIdentity.dev),
      quarantineInode: String(quarantineIdentity.ino),
    });
    rollbackWorkspaceStates.set(handle, {
      checkoutRequestedPath: resolve(root),
      checkoutPath,
      quarantinePath,
      checkoutDescriptor,
      quarantineDescriptor,
      checkoutIdentity,
      quarantineIdentity,
      owner,
      closed: false,
    });
    return handle;
  } catch (error) {
    if (quarantineDescriptor !== undefined) {
      forgetCustodyDescriptor(quarantineDescriptor);
      closeSync(quarantineDescriptor);
    }
    if (checkoutDescriptor !== undefined) {
      forgetCustodyDescriptor(checkoutDescriptor);
      closeSync(checkoutDescriptor);
    }
    throw error;
  }
}

function validateRollbackWorkspaceArguments(root, quarantineRoot) {
  if (typeof root !== "string" || typeof quarantineRoot !== "string"
    || !isAbsolute(root) || !isAbsolute(quarantineRoot)) {
    throw new Error("ROLLBACK_REMOVAL_WORKSPACE_INVALID");
  }
}

function validateRollbackWorkspacePaths(root, quarantineRoot, checkoutPath, quarantinePath) {
  assertCustodyCanonicalSpelling({
    requestedPath: root, canonicalPath: checkoutPath, allowDarwinTemporaryAlias: true,
  });
  assertCustodyCanonicalSpelling({
    requestedPath: quarantineRoot, canonicalPath: quarantinePath, allowDarwinTemporaryAlias: true,
  });
  const requestedParent = dirname(resolve(root));
  if (dirname(resolve(quarantineRoot)) !== requestedParent) {
    throw new Error("ROLLBACK_REMOVAL_WORKSPACE_UNSAFE");
  }
  const canonicalParent = dirname(checkoutPath);
  assertCustodyDirectChild(canonicalParent, checkoutPath, "checkout");
  assertCustodyDirectChild(canonicalParent, quarantinePath, "gate-tmp");
}

function validateRollbackWorkspaceIdentities(checkout, quarantine, owner) {
  if (!checkout.isDirectory() || checkout.isSymbolicLink()
    || !quarantine.isDirectory() || quarantine.isSymbolicLink()
    || String(checkout.uid) !== owner || String(quarantine.uid) !== owner
    || String(checkout.dev) !== String(quarantine.dev)
    || (checkout.mode & 0o022n) !== 0n
    || (quarantine.mode & 0o777n) !== 0o700n) {
    throw new Error("ROLLBACK_REMOVAL_WORKSPACE_UNSAFE");
  }
}

export function assertRollbackWorkspaceHandle(handle, root) {
  const state = rollbackWorkspaceStates.get(handle);
  const requestedRoot = root === undefined ? undefined : resolve(root);
  if (state === undefined || state.closed
    || (requestedRoot !== undefined
      && requestedRoot !== state.checkoutRequestedPath
      && requestedRoot !== state.checkoutPath)) {
    throw new Error("ROLLBACK_REMOVAL_WORKSPACE_HANDLE_INVALID");
  }
  try {
    assertRollbackRemovalIdentity(
      state.checkoutIdentity,
      fstatSync(state.checkoutDescriptor, { bigint: true }),
      ".",
    );
    assertRollbackRemovalIdentity(
      state.quarantineIdentity,
      fstatSync(state.quarantineDescriptor, { bigint: true }),
      "gate-tmp",
    );
    const checkoutAtPath = lstatSync(handle.checkoutPath, { bigint: true });
    const quarantineAtPath = lstatSync(handle.quarantinePath, { bigint: true });
    if (checkoutAtPath.isSymbolicLink() || quarantineAtPath.isSymbolicLink()) {
      throw new Error("workspace path became a symlink");
    }
    assertRollbackRemovalIdentity(state.checkoutIdentity, checkoutAtPath, ".");
    assertRollbackRemovalIdentity(state.quarantineIdentity, quarantineAtPath, "gate-tmp");
  } catch (error) {
    throw new Error("ROLLBACK_REMOVAL_WORKSPACE_SUBSTITUTED", { cause: error });
  }
  return {
    checkoutDevice: handle.checkoutDevice,
    checkoutInode: handle.checkoutInode,
    quarantineDevice: handle.quarantineDevice,
    quarantineInode: handle.quarantineInode,
  };
}

export function closeRollbackWorkspaceHandle(handle) {
  const state = rollbackWorkspaceStates.get(handle);
  if (state === undefined || state.closed) {
    return;
  }
  state.closed = true;
  forgetCustodyDescriptor(state.quarantineDescriptor);
  forgetCustodyDescriptor(state.checkoutDescriptor);
  closeSync(state.quarantineDescriptor);
  closeSync(state.checkoutDescriptor);
}

export function rollbackWorkspaceState(handle, root) {
  assertRollbackWorkspaceHandle(handle, root);
  return rollbackWorkspaceStates.get(handle);
}
