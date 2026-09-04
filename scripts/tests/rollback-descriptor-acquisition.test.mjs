import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  abandonCleanupHandle,
  createCleanupHandle,
} from "../rollback/runtime/cleanup.mjs";
import {
  preflightCleanupTree,
} from "../rollback/runtime/cleanup-tree.mjs";
import {
  closeDirectoryCustody,
  createDirectoryCustody,
  setCustodyDirectoryAcquisitionBoundaryForTest,
} from "../rollback/runtime/custody.mjs";
import {
  closeRollbackRemovalQuarantine,
  createRollbackRemovalQuarantine,
  setRollbackRemovalParentRealpathForTest,
  snapshotRollbackRemovalPlan,
} from "../rollback/slices/removal-quarantine.mjs";
import {
  closeRollbackSharedPlan,
  openRollbackSharedParent,
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

test("shared snapshot transfers its successor before first traversal close EINTR", () => {
  const fixture = createWorkspace("agtmai-shared-acquisition-");
  mkdirSync(join(fixture.checkout, "a/b"), { recursive: true });
  writeFileSync(join(fixture.checkout, "a/b/file.txt"), "held\n");
  const injection = injectedUncertainClose(0);
  try {
    assert.throws(
      () => snapshotRollbackSharedPaths(
        fixture.checkout,
        ["a/b/file.txt"],
        fixture.workspace,
      ),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_SHARED_PATH_TRAVERSAL_CLOSE_FAILED"
        && error.errors.length === 1
        && error.errors[0].code === "EINTR",
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

test("shared parent traversal closes its successor after first close EINTR", () => {
  const fixture = createWorkspace("agtmai-shared-parent-acquisition-");
  mkdirSync(join(fixture.checkout, "a/b"), { recursive: true });
  writeFileSync(join(fixture.checkout, "a/b/file.txt"), "held\n");
  const plan = snapshotRollbackSharedPaths(
    fixture.checkout,
    ["a/b/file.txt"],
    fixture.workspace,
  );
  const injection = injectedUncertainClose(0);
  try {
    assert.throws(
      () => openRollbackSharedParent(
        fixture.checkout,
        "a/b/file.txt",
        plan,
        fixture.workspace,
      ),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_SHARED_PATH_TRAVERSAL_CLOSE_FAILED"
        && error.errors[0].code === "EINTR",
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
    closeRollbackSharedPlan(plan);
    closeRollbackWorkspaceHandle(fixture.workspace);
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});

test("removal traversal closes its successor after first close EINTR", () => {
  const fixture = createWorkspace("agtmai-removal-acquisition-");
  mkdirSync(join(fixture.checkout, "slice/nested"), { recursive: true });
  writeFileSync(join(fixture.checkout, "slice/nested/file.txt"), "held\n");
  const quarantine = createRollbackRemovalQuarantine(
    fixture.checkout,
    { sliceId: "fixture-slice" },
    { workspaceHandle: fixture.workspace },
  );
  const injection = injectedUncertainClose(0);
  try {
    assert.throws(
      () => snapshotRollbackRemovalPlan(quarantine, [
        { kind: "file", path: "slice/nested/file.txt" },
      ]),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_REMOVAL_TRAVERSAL_CLOSE_FAILED"
        && error.errors[0].code === "EINTR",
    );
  } finally {
    injection.restore();
  }
  const reusedDescriptor = injection.reusedDescriptor();
  try {
    assert.equal(injection.calls.length, 2);
    assertOtherDescriptorsClosed(injection.calls, reusedDescriptor);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
    assert.equal(quarantine.plannedIdentities, undefined);
  } finally {
    closeSync(reusedDescriptor);
    closeRollbackRemovalQuarantine(quarantine);
    closeRollbackWorkspaceHandle(fixture.workspace);
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});

test("removal parent canonicalization failure closes its acquired successor", () => {
  const fixture = createWorkspace("agtmai-removal-realpath-acquisition-");
  mkdirSync(join(fixture.checkout, "slice/nested"), { recursive: true });
  writeFileSync(join(fixture.checkout, "slice/nested/file.txt"), "held\n");
  const quarantine = createRollbackRemovalQuarantine(
    fixture.checkout,
    { sliceId: "fixture-slice" },
    { workspaceHandle: fixture.workspace },
  );
  const canonicalizationFailure = new Error("injected removal parent canonicalization failure");
  const restoreRealpath = setRollbackRemovalParentRealpathForTest(() => {
    throw canonicalizationFailure;
  });
  const injection = injectedUncertainClose(0);
  try {
    assert.throws(
      () => snapshotRollbackRemovalPlan(quarantine, [
        { kind: "file", path: "slice/nested/file.txt" },
      ]),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_REMOVAL_ACQUISITION_CLOSE_FAILED"
        && error.cause === canonicalizationFailure
        && error.errors[0] === canonicalizationFailure
        && error.errors[1]?.code === "EINTR",
    );
  } finally {
    injection.restore();
    restoreRealpath();
  }
  const reusedDescriptor = injection.reusedDescriptor();
  try {
    assert.equal(injection.calls.length, 2);
    assertOtherDescriptorsClosed(injection.calls, reusedDescriptor);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
    assert.equal(quarantine.plannedIdentities, undefined);
  } finally {
    closeSync(reusedDescriptor);
    closeRollbackRemovalQuarantine(quarantine);
    closeRollbackWorkspaceHandle(fixture.workspace);
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});

test("cleanup recursion attempts its remaining descriptor after close EINTR", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agtmai-cleanup-acquisition-root-"));
  chmodSync(temporaryRoot, 0o700);
  const target = mkdtempSync(join(
    temporaryRoot,
    "agtmai-rollback-deployment-plan-",
  ));
  chmodSync(target, 0o700);
  mkdirSync(join(target, "checkout/nested"), { recursive: true });
  const handle = createCleanupHandle(target, {
    allowedEntries: ["checkout"],
    targetPrefix: "agtmai-rollback-deployment-plan-",
    temporaryRoot,
  });
  const injection = injectedUncertainClose(0);
  try {
    assert.throws(
      () => preflightCleanupTree(handle, { count: 0 }),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_CLEANUP_TRAVERSAL_CLOSE_FAILED"
        && error.errors.length === 1
        && error.errors[0].code === "EINTR",
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
    abandonCleanupHandle(handle);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("custody acquisition accepts ordinary sibling churn on an unchanged ancestor", () => {
  const boundary = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-custody-ancestor-churn-")));
  chmodSync(boundary, 0o700);
  const target = join(boundary, "owned");
  const sibling = join(boundary, "ordinary-sibling");
  mkdirSync(target, { mode: 0o700 });
  const restoreBoundary = setCustodyDirectoryAcquisitionBoundaryForTest(({ path }) => {
    if (path === boundary) {
      mkdirSync(sibling);
    }
  });
  let custody;
  try {
    custody = createDirectoryCustody(target, {
      allowDarwinTemporaryAlias: true,
      owned: true,
    });
    assert.equal(custody.canonicalPath, target);
  } finally {
    restoreBoundary();
    closeDirectoryCustody(custody);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("custody acquisition rejects ancestor replacement after opening it", () => {
  const boundary = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-custody-ancestor-replacement-")));
  const displaced = boundary + "-displaced";
  chmodSync(boundary, 0o700);
  const target = join(boundary, "owned");
  mkdirSync(target, { mode: 0o700 });
  const restoreBoundary = setCustodyDirectoryAcquisitionBoundaryForTest(({ path }) => {
    if (path === boundary) {
      renameSync(boundary, displaced);
      mkdirSync(boundary, { mode: 0o700 });
    }
  });
  try {
    assert.throws(
      () => createDirectoryCustody(target, {
        allowDarwinTemporaryAlias: true,
        owned: true,
      }),
      { message: "ROLLBACK_CUSTODY_SUBSTITUTED" },
    );
  } finally {
    restoreBoundary();
    rmSync(boundary, { recursive: true, force: true });
    rmSync(displaced, { recursive: true, force: true });
  }
});

test("custody acquisition retains the owned target's full metadata snapshot", () => {
  const boundary = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-custody-target-churn-")));
  chmodSync(boundary, 0o700);
  const target = join(boundary, "owned");
  mkdirSync(target, { mode: 0o700 });
  const restoreBoundary = setCustodyDirectoryAcquisitionBoundaryForTest(({ path }) => {
    if (path === target) {
      mkdirSync(join(target, "ordinary-child"));
    }
  });
  try {
    assert.throws(
      () => createDirectoryCustody(target, {
        allowDarwinTemporaryAlias: true,
        owned: true,
      }),
      { message: "ROLLBACK_CUSTODY_SUBSTITUTED" },
    );
  } finally {
    restoreBoundary();
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("custody acquisition attempts target and every ancestor after middle close EINTR", () => {
  const boundary = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-custody-acquisition-")));
  chmodSync(boundary, 0o700);
  const target = join(boundary, "not-private");
  const sibling = join(boundary, "ordinary-sibling");
  mkdirSync(target, { mode: 0o755 });
  const restoreBoundary = setCustodyDirectoryAcquisitionBoundaryForTest(({ path }) => {
    if (path === boundary) {
      mkdirSync(sibling);
    }
  });
  const injection = injectedUncertainClose(1);
  try {
    assert.throws(
      () => createDirectoryCustody(target, {
        allowDarwinTemporaryAlias: true,
        owned: true,
      }),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_CUSTODY_ACQUISITION_CLOSE_FAILED"
        && error.cause?.message.includes("ROLLBACK_CUSTODY_OWNED_DIRECTORY_UNSAFE")
        && error.errors[0] === error.cause
        && error.errors[1]?.code === "EINTR",
    );
  } finally {
    injection.restore();
    restoreBoundary();
  }
  const reusedDescriptor = injection.reusedDescriptor();
  try {
    assert.ok(injection.calls.length > 2);
    assertOtherDescriptorsClosed(injection.calls, reusedDescriptor);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
  } finally {
    closeSync(reusedDescriptor);
    rmSync(boundary, { recursive: true, force: true });
  }
});
