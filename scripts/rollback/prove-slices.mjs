#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runCli } from "./slices/cli.mjs";

export { applyManifest, removeOwnedEmptyDirectories } from "./slices/apply-manifest.mjs";
export {
  applyExactSliceState,
  expectedGateIds,
  gateCoverageSnapshot,
  parseStrictTap,
  rollbackGateCoverage,
  verifyAppliedState,
} from "./slices/gate-contract.mjs";
export {
  finalizeRollbackTemporaryParent,
  preflightPinnedEnvironment,
  preflightPinnedSlitherImage,
} from "./slices/gate-execution.mjs";
export {
  deterministicProofStatement,
  parseCliArguments,
} from "./slices/cli.mjs";
export { manifestFingerprint } from "./slices/manifest-proof.mjs";
export { validateManifestSet } from "./slices/manifests.mjs";
export { editPackage } from "./slices/transforms.mjs";
export {
  assertRollbackWorkspaceHandle,
  closeRollbackWorkspaceHandle,
  createRollbackWorkspaceHandle,
} from "./slices/workspace-handle.mjs";

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.stack : String(error)) + "\n");
    process.exitCode = 1;
  }
}
