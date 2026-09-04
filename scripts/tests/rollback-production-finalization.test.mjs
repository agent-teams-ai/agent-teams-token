import assert from "node:assert/strict";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyManifest,
  removeOwnedEmptyDirectories,
} from "../rollback/slices/apply-manifest.mjs";
import {
  closeRollbackWorkspaceHandle,
  createRollbackWorkspaceHandle,
} from "../rollback/slices/workspace-handle.mjs";
import {
  assertOtherDescriptorsClosed,
  injectedUncertainClose,
} from "./rollback-descriptor-close-fixture.mjs";

function createWorkspace(prefix) {
  const boundary = mkdtempSync(join(tmpdir(), prefix));
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  mkdirSync(checkout);
  mkdirSync(quarantineRoot, { mode: 0o700 });
  const workspace = createRollbackWorkspaceHandle(checkout, quarantineRoot);
  return { boundary, checkout, workspace };
}

function removalManifest(ownedPaths) {
  return {
    baselineSha: "0".repeat(40),
    ownedPaths,
    ownedRoot: "slice",
    restoreFromBaseline: [],
    reverseEdits: [],
    sharedPaths: [],
    sliceId: "slither",
  };
}

test("remove-owned success closes production quarantine ownership", () => {
  const fixture = createWorkspace("agtmai-removal-success-");
  mkdirSync(join(fixture.checkout, "slice/empty"), { recursive: true });
  try {
    const result = removeOwnedEmptyDirectories(
      fixture.checkout,
      removalManifest(["slice/empty/file.txt"]),
      { workspaceHandle: fixture.workspace },
    );
    assert.deepEqual(result.quarantinedDirectories, ["slice/empty"]);
    assert.equal(result.quarantinedDirectoryCount, 1);
  } finally {
    closeRollbackWorkspaceHandle(fixture.workspace);
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});

test("invalid apply options fail before production descriptor acquisition", () => {
  const fixture = createWorkspace("agtmai-apply-options-");
  try {
    assert.throws(
      () => applyManifest(
        fixture.checkout,
        removalManifest([]),
        { unsupported: true },
      ),
      /ROLLBACK_APPLY_OPTIONS_INVALID/u,
    );
  } finally {
    closeRollbackWorkspaceHandle(fixture.workspace);
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});

test("apply caller preserves application failure when shared finalization gets EINTR", () => {
  const fixture = createWorkspace("agtmai-apply-shared-finalization-");
  writeFileSync(join(fixture.checkout, "shared.txt"), "original\n");
  const manifest = {
    ...removalManifest([]),
    reverseEdits: [{
      afterSha256: "0".repeat(64),
      beforeSha256: "f".repeat(64),
      path: "shared.txt",
    }],
    sharedPaths: ["shared.txt"],
  };
  const injection = injectedUncertainClose(1);
  try {
    assert.throws(
      () => applyManifest(
        fixture.checkout,
        manifest,
        { workspaceHandle: fixture.workspace },
      ),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_SHARED_PATH_CLOSE_FAILED"
        && error.cause?.message.includes("ROLLBACK_SHARED_EDIT_SOURCE_DRIFT")
        && error.errors[0] === error.cause
        && error.errors[1]?.code === "EINTR",
    );
  } finally {
    injection.restore();
  }
  const reusedDescriptor = injection.reusedDescriptor();
  try {
    assert.equal(injection.calls.length, 2);
    assertOtherDescriptorsClosed(injection.calls, reusedDescriptor);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
  } finally {
    closeSync(reusedDescriptor);
    closeRollbackWorkspaceHandle(fixture.workspace);
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});

test("stage failure remains root cause across every production finalizer", () => {
  const fixture = createWorkspace("agtmai-apply-stage-finalization-");
  mkdirSync(join(fixture.checkout, "slice"), { recursive: true });
  writeFileSync(join(fixture.checkout, "slice/file.txt"), "owned\n");
  const policyFailure = new Error("injected application policy failure");
  let injection;
  try {
    assert.throws(
      () => applyManifest(
        fixture.checkout,
        removalManifest(["slice/file.txt"]),
        {
          onBoundary(stage) {
            if (stage === "before-rollback-removal-quarantine") {
              injection = injectedUncertainClose(0);
              throw policyFailure;
            }
          },
          verifyDeclaredDigests: false,
          workspaceHandle: fixture.workspace,
        },
      ),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_REMOVAL_STAGE_CLOSE_FAILED"
        && error.cause === policyFailure
        && error.errors[0] === policyFailure
        && error.errors[1]?.code === "EINTR",
    );
  } finally {
    injection?.restore();
  }
  const reusedDescriptor = injection.reusedDescriptor();
  try {
    assert.equal(injection.calls.length, 3);
    assertOtherDescriptorsClosed(injection.calls, reusedDescriptor);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
  } finally {
    closeSync(reusedDescriptor);
    closeRollbackWorkspaceHandle(fixture.workspace);
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});
