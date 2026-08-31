#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  abandonCleanupHandle,
  captureCleanupTreeSnapshot,
  cleanupIdentityBoundDirectory,
  createCleanupHandle,
} from "./rollback/runtime/cleanup.mjs";

export function cleanupBootstrapNodeStage({ path, toolsRoot, device, inode, onBoundary }) {
  const handle = createCleanupHandle(path, {
    temporaryRoot: toolsRoot,
    targetPrefix: ".bootstrap-node-part.",
    allowedEntries: ["payload"],
  });
  if (handle.device !== String(device) || handle.inode !== String(inode)) {
    abandonCleanupHandle(handle);
    throw new Error("TOOLCHAIN_BOOTSTRAP_STAGE_IDENTITY_MISMATCH path=" + path);
  }
  captureCleanupTreeSnapshot(handle);
  return cleanupIdentityBoundDirectory(handle, { onBoundary });
}

function cli() {
  const [command, path, toolsRoot, device, inode] = process.argv.slice(2);
  if (command !== "cleanup-bootstrap-stage" || [path, toolsRoot, device, inode].some((value) =>
    typeof value !== "string" || value.length === 0)) {
    throw new Error("Usage: toolchain-cleanup.mjs cleanup-bootstrap-stage PATH TOOLS_ROOT DEVICE INODE");
  }
  cleanupBootstrapNodeStage({
    path: resolve(path),
    toolsRoot: resolve(toolsRoot),
    device,
    inode,
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
