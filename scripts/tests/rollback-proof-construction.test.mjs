import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRollbackProofWorkspace,
  failRollbackProofWorkspace,
  setProofWorkspaceConstructionBoundaryForTest,
} from "../rollback/slices/proof-workspace.mjs";
import { assertRollbackWorkspaceHandle } from "../rollback/slices/workspace-handle.mjs";

const stages = [
  "temporary-parent",
  "cleanup-handle",
  "checkout-directory",
  "gate-directory",
  "workspace-handle",
  "workspace-identity",
];

test("downstream context failure finalizes the fully constructed workspace", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agtmai-proof-context-root-"));
  chmodSync(temporaryRoot, 0o700);
  let workspace;
  const primary = new Error("TEST_PROOF_CONTEXT_PRIMARY");
  try {
    workspace = createRollbackProofWorkspace({
      temporaryRoot,
      targetPrefix: "agtmai-rollback-local-solana-",
    });
    assert.throws(
      () => failRollbackProofWorkspace(workspace, primary, "test context finalization failed"),
      (error) => error === primary,
    );
    assert.equal(workspace.cleanupHandle.closed, true);
    assert.throws(
      () => assertRollbackWorkspaceHandle(workspace.workspaceHandle),
      /ROLLBACK_REMOVAL_WORKSPACE_HANDLE_INVALID/u,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

for (const stage of stages) {
  test(`proof workspace finalizes partial ownership after ${stage}`, () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agtmai-proof-construction-root-"));
    chmodSync(temporaryRoot, 0o700);
    const primary = new Error("TEST_PROOF_CONSTRUCTION_PRIMARY stage=" + stage);
    let observed;
    const restore = setProofWorkspaceConstructionBoundaryForTest((details) => {
      if (details.stage === stage) {
        observed = details;
        throw primary;
      }
    });
    try {
      assert.throws(
        () => createRollbackProofWorkspace({
          temporaryRoot,
          targetPrefix: "agtmai-rollback-local-solana-",
        }),
        (error) => error === primary,
      );
      assert.ok(observed);
      if (observed.cleanupHandle === undefined) {
        assert.equal(existsSync(observed.temporaryParent), false);
      } else {
        assert.equal(observed.cleanupHandle.closed, true);
        assert.equal(observed.cleanupHandle.descriptor, undefined);
        assert.equal(observed.cleanupHandle.rootDescriptor, undefined);
        assert.equal(existsSync(observed.temporaryParent), true);
      }
      if (observed.workspaceHandle !== undefined) {
        assert.throws(
          () => assertRollbackWorkspaceHandle(observed.workspaceHandle),
          /ROLLBACK_REMOVAL_WORKSPACE_HANDLE_INVALID/u,
        );
      }
    } finally {
      restore();
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
}
