import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";

import { createCleanupHandle } from "../runtime/cleanup.mjs";
import { assertCustodyIdentity, custodyIdentity } from "../runtime/custody.mjs";
import { finalizeRollbackTemporaryParent } from "./gate-execution.mjs";
import {
  assertRollbackWorkspaceHandle,
  createRollbackWorkspaceHandle,
} from "./workspace-handle.mjs";

let constructionBoundary = () => {};

export function setProofWorkspaceConstructionBoundaryForTest(implementation) {
  if (typeof implementation !== "function") {
    throw new Error("ROLLBACK_PROOF_WORKSPACE_BOUNDARY_INVALID");
  }
  const previous = constructionBoundary;
  constructionBoundary = implementation;
  let restored = false;
  return () => {
    if (!restored) {
      restored = true;
      constructionBoundary = previous;
    }
  };
}

function notifyConstructionBoundary(stage, workspace) {
  constructionBoundary(Object.freeze({
    checkout: workspace.checkout,
    cleanupHandle: workspace.cleanupHandle,
    gateTemporaryDirectory: workspace.gateTemporaryDirectory,
    stage,
    temporaryParent: workspace.temporaryParent,
    workspaceHandle: workspace.workspaceHandle,
  }));
}

function throwFinalizedConstructionFailure(workspace, primaryFailure, message) {
  if (workspace.cleanupHandle === undefined) {
    let cleanupFailure;
    try {
      assertCustodyIdentity(
        workspace.temporaryIdentity,
        lstatSync(workspace.temporaryParent, { bigint: true }),
        "ROLLBACK_PROOF_WORKSPACE_TEMPORARY_SUBSTITUTED",
      );
      rmdirSync(workspace.temporaryParent);
    } catch (error) {
      cleanupFailure = error;
    }
    if (cleanupFailure !== undefined) {
      throw new AggregateError([primaryFailure, cleanupFailure], message, {
        cause: primaryFailure,
      });
    }
    throw primaryFailure;
  }
  const finalized = finalizeRollbackTemporaryParent({
    cleanupHandle: workspace.cleanupHandle,
    workspaceHandle: workspace.workspaceHandle,
    primaryFailure,
  });
  if (finalized.cleanupFailure !== undefined) {
    throw new AggregateError(
      [finalized.primaryFailure, finalized.cleanupFailure],
      message,
      { cause: finalized.primaryFailure },
    );
  }
  throw finalized.primaryFailure;
}

export function failRollbackProofWorkspace(workspace, primaryFailure, message) {
  throwFinalizedConstructionFailure(workspace, primaryFailure, message);
}

export function createRollbackProofWorkspace({ temporaryRoot, targetPrefix }) {
  const temporaryParent = mkdtempSync(join(temporaryRoot, targetPrefix));
  const workspace = {
    checkout: join(temporaryParent, "checkout"),
    cleanupHandle: undefined,
    gateTemporaryDirectory: join(temporaryParent, "gate-tmp"),
    temporaryIdentity: undefined,
    temporaryParent,
    workspaceHandle: undefined,
  };
  try {
    workspace.temporaryIdentity = custodyIdentity(lstatSync(temporaryParent, { bigint: true }));
    notifyConstructionBoundary("temporary-parent", workspace);
    workspace.cleanupHandle = createCleanupHandle(temporaryParent, {
      temporaryRoot,
      targetPrefix,
      allowedEntries: ["checkout", "gate-tmp"],
    });
    notifyConstructionBoundary("cleanup-handle", workspace);
    mkdirSync(workspace.checkout, { mode: 0o700 });
    notifyConstructionBoundary("checkout-directory", workspace);
    mkdirSync(workspace.gateTemporaryDirectory, { mode: 0o700 });
    notifyConstructionBoundary("gate-directory", workspace);
    workspace.workspaceHandle = createRollbackWorkspaceHandle(
      workspace.checkout,
      workspace.gateTemporaryDirectory,
    );
    notifyConstructionBoundary("workspace-handle", workspace);
    workspace.workspaceIdentity = assertRollbackWorkspaceHandle(
      workspace.workspaceHandle,
      workspace.checkout,
    );
    notifyConstructionBoundary("workspace-identity", workspace);
    return workspace;
  } catch (error) {
    throwFinalizedConstructionFailure(
      workspace,
      error,
      "rollback proof workspace construction and finalization both failed",
    );
  }
}
