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
  assertRollbackPathAbsentFromCheckout,
  createRollbackSharedFile,
  editRollbackSharedText,
  readRollbackSharedBytes,
  restoreRollbackSharedFile,
} from "../rollback/slices/shared-file-operations.mjs";
import {
  closeRollbackSharedPlan,
  snapshotRollbackSharedPaths,
} from "../rollback/slices/shared-paths.mjs";
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

function assertInjectedSharedClose(action, validateError, expectedCalls) {
  const injection = injectedUncertainClose(0);
  try {
    assert.throws(action, validateError);
  } finally {
    injection.restore();
  }
  const reusedDescriptor = injection.reusedDescriptor();
  try {
    assert.equal(injection.calls.length, expectedCalls);
    assertOtherDescriptorsClosed(injection.calls, reusedDescriptor);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
  } finally {
    closeSync(reusedDescriptor);
  }
}

function isSharedCloseFailure(error) {
  return error instanceof AggregateError
    && error.message === "ROLLBACK_SHARED_PATH_CLOSE_FAILED"
    && error.errors.length === 1
    && error.errors[0].code === "EINTR";
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

test("actual shared read closes file and parent after checkout close EINTR", () => {
  const fixture = createWorkspace("agtmai-shared-read-close-");
  writeFileSync(join(fixture.checkout, "shared.txt"), "original\n");
  const plan = snapshotRollbackSharedPaths(
    fixture.checkout,
    ["shared.txt"],
    fixture.workspace,
  );
  try {
    assertInjectedSharedClose(
      () => readRollbackSharedBytes(
        fixture.checkout,
        "shared.txt",
        plan,
        fixture.workspace,
      ),
      isSharedCloseFailure,
      3,
    );
  } finally {
    closeRollbackSharedPlan(plan);
    closeRollbackWorkspaceHandle(fixture.workspace);
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});

test("actual shared edit preserves callback failure and appends close EINTR", () => {
  const fixture = createWorkspace("agtmai-shared-edit-close-");
  writeFileSync(join(fixture.checkout, "shared.txt"), "original\n");
  const plan = snapshotRollbackSharedPaths(
    fixture.checkout,
    ["shared.txt"],
    fixture.workspace,
  );
  const callbackFailure = new Error("injected shared edit callback failure");
  try {
    assertInjectedSharedClose(
      () => editRollbackSharedText(
        fixture.checkout,
        "shared.txt",
        plan,
        fixture.workspace,
        () => {
          throw callbackFailure;
        },
      ),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_SHARED_PATH_CLOSE_FAILED"
        && error.cause === callbackFailure
        && error.errors[0] === callbackFailure
        && error.errors[1]?.code === "EINTR",
      2,
    );
  } finally {
    closeRollbackSharedPlan(plan);
    closeRollbackWorkspaceHandle(fixture.workspace);
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});

test("actual shared restore closes file and parent after checkout close EINTR", () => {
  const fixture = createWorkspace("agtmai-shared-restore-close-");
  writeFileSync(join(fixture.checkout, "shared.txt"), "original\n");
  const plan = snapshotRollbackSharedPaths(
    fixture.checkout,
    ["shared.txt"],
    fixture.workspace,
  );
  try {
    assertInjectedSharedClose(
      () => restoreRollbackSharedFile(
        fixture.checkout,
        "shared.txt",
        plan,
        fixture.workspace,
        "restored\n",
      ),
      isSharedCloseFailure,
      3,
    );
  } finally {
    closeRollbackSharedPlan(plan);
    closeRollbackWorkspaceHandle(fixture.workspace);
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});

test("actual shared create closes created file and parent after checkout close EINTR", () => {
  const fixture = createWorkspace("agtmai-shared-create-close-");
  const plan = snapshotRollbackSharedPaths(
    fixture.checkout,
    ["created.txt"],
    fixture.workspace,
  );
  try {
    assertInjectedSharedClose(
      () => createRollbackSharedFile(
        fixture.checkout,
        "created.txt",
        plan,
        fixture.workspace,
        "created\n",
      ),
      isSharedCloseFailure,
      3,
    );
  } finally {
    closeRollbackSharedPlan(plan);
    closeRollbackWorkspaceHandle(fixture.workspace);
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});

test("gate-contract absence traversal closes successor after predecessor EINTR", () => {
  const fixture = createWorkspace("agtmai-shared-absence-close-");
  mkdirSync(join(fixture.checkout, "slice/nested"), { recursive: true });
  try {
    assertInjectedSharedClose(
      () => assertRollbackPathAbsentFromCheckout(
        fixture.checkout,
        "slice/nested/missing.txt",
        fixture.workspace,
      ),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_SHARED_PATH_TRAVERSAL_CLOSE_FAILED"
        && error.errors.length === 1
        && error.errors[0].code === "EINTR",
      2,
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
  // Snapshot traversal and the three read-owned closes precede plan teardown.
  const injection = injectedUncertainClose(4);
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
    assert.equal(injection.calls.length, 5);
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
