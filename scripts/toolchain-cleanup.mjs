#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  abandonCleanupHandle,
  captureCleanupTreeSnapshot,
  cleanupIdentityBoundDirectory,
  createCleanupHandle,
} from "./rollback/runtime/cleanup.mjs";

function bootstrapCleanupHandle({ path, toolsRoot, device, inode }) {
  const handle = createCleanupHandle(path, {
    temporaryRoot: toolsRoot,
    targetPrefix: ".bootstrap-node-part.",
    allowedEntries: ["payload"],
  });
  if (handle.device !== String(device) || handle.inode !== String(inode)) {
    abandonCleanupHandle(handle);
    throw new Error("TOOLCHAIN_BOOTSTRAP_STAGE_IDENTITY_MISMATCH path=" + path);
  }
  return handle;
}

export function captureBootstrapNodeStageCustody(args) {
  const handle = bootstrapCleanupHandle(args);
  try {
    return captureCleanupTreeSnapshot(handle).custodySha256;
  } finally {
    if (!handle.closed) {abandonCleanupHandle(handle);}
  }
}

export function cleanupBootstrapNodeStage({
  path,
  toolsRoot,
  device,
  inode,
  custodySha256,
  onBoundary,
}) {
  const handle = bootstrapCleanupHandle({ path, toolsRoot, device, inode });
  const captured = captureCleanupTreeSnapshot(handle);
  if (captured.custodySha256 !== custodySha256) {
    abandonCleanupHandle(handle);
    throw new Error("TOOLCHAIN_BOOTSTRAP_STAGE_CUSTODY_MISMATCH path=" + path);
  }
  return cleanupIdentityBoundDirectory(handle, { onBoundary });
}

function cli() {
  const [command, path, toolsRoot, device, inode, custodySha256] = process.argv.slice(2);
  if (!["capture-bootstrap-stage-custody", "cleanup-bootstrap-stage"].includes(command)
    || [path, toolsRoot, device, inode].some((value) =>
    typeof value !== "string" || value.length === 0)) {
    throw new Error(
      "Usage: toolchain-cleanup.mjs capture-bootstrap-stage-custody|cleanup-bootstrap-stage PATH TOOLS_ROOT DEVICE INODE [CUSTODY_SHA256]",
    );
  }
  const args = {
    path: resolve(path),
    toolsRoot: resolve(toolsRoot),
    device,
    inode,
  };
  if (command === "capture-bootstrap-stage-custody") {
    process.stdout.write(captureBootstrapNodeStageCustody(args) + "\n");
    return;
  }
  if (!/^[a-f0-9]{64}$/u.test(custodySha256 ?? "")) {
    throw new Error("TOOLCHAIN_BOOTSTRAP_STAGE_CUSTODY_INVALID");
  }
  cleanupBootstrapNodeStage({
    ...args,
    custodySha256,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
