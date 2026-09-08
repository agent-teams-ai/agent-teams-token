import assert from "node:assert/strict";
import {
  chmodSync,
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
  abandonCleanupHandle,
  cleanupIdentityBoundDirectory,
  createCleanupHandle,
} from "../rollback/runtime/cleanup.mjs";
import {
  closeCustodyDescriptor,
  closeDirectoryCustody,
  createDirectoryCustody,
  verifyDirectoryCustody,
} from "../rollback/runtime/custody.mjs";
import {
  closeRollbackRemovalPlan,
  createRollbackRemovalQuarantine,
  snapshotRollbackRemovalPlan,
} from "../rollback/slices/removal-quarantine.mjs";
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

test("cleanup teardown preserves its primary failure and never retries an uncertain close", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agtmai-cleanup-close-root-"));
  chmodSync(temporaryRoot, 0o700);
  const target = mkdtempSync(join(
    temporaryRoot,
    "agtmai-rollback-deployment-plan-",
  ));
  chmodSync(target, 0o700);
  const handle = createCleanupHandle(target, {
    allowedEntries: ["checkout"],
    targetPrefix: "agtmai-rollback-deployment-plan-",
    temporaryRoot,
  });
  const descriptors = [handle.descriptor, handle.rootDescriptor];
  const injection = injectedUncertainClose(0);
  let failure;
  try {
    assert.throws(
      () => cleanupIdentityBoundDirectory(handle, { unsupported: true }),
      (error) => {
        failure = error;
        return error instanceof AggregateError
          && error.message === "ROLLBACK_CLEANUP_CLOSE_FAILED"
          && error.cause?.message === "ROLLBACK_CLEANUP_OPTIONS_INVALID"
          && error.errors[0] === error.cause
          && error.errors[1]?.code === "EINTR";
      },
    );
  } finally {
    injection.restore();
  }
  const reusedDescriptor = injection.reusedDescriptor();
  try {
    assert.equal(handle.closed, true);
    assert.equal(handle.descriptor, undefined);
    assert.equal(handle.rootDescriptor, undefined);
    assert.equal(injection.calls.length, 2);
    assertOtherDescriptorsClosed(descriptors, reusedDescriptor);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
    assert.throws(
      () => abandonCleanupHandle(handle),
      /ROLLBACK_CLEANUP_HANDLE_CLOSED/u,
    );
    assert.equal(injection.calls.length, 2);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
    assert.equal(failure.errors.length, 2);
  } finally {
    closeSync(reusedDescriptor);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("workspace teardown attempts both descriptors and is terminal after first-close EINTR", () => {
  const boundary = mkdtempSync(join(tmpdir(), "agtmai-workspace-close-"));
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  mkdirSync(checkout);
  mkdirSync(quarantineRoot, { mode: 0o700 });
  const handle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
  const injection = injectedUncertainClose(0);
  try {
    assert.throws(
      () => closeRollbackWorkspaceHandle(handle),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_REMOVAL_WORKSPACE_CLOSE_FAILED"
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
    assert.doesNotThrow(() => closeRollbackWorkspaceHandle(handle));
    assert.equal(injection.calls.length, 2);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
  } finally {
    closeSync(reusedDescriptor);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("custody teardown attempts descriptors after a middle uncertain close", () => {
  const boundary = mkdtempSync(join(tmpdir(), "agtmai-custody-close-"));
  chmodSync(boundary, 0o700);
  const target = join(boundary, "owned");
  mkdirSync(target, { mode: 0o700 });
  const custody = createDirectoryCustody(target, {
    allowDarwinTemporaryAlias: true,
    owned: true,
  });
  const expectedCount = 1 + custody.ancestorChain.length;
  const injection = injectedUncertainClose(1);
  try {
    assert.throws(
      () => closeDirectoryCustody(custody),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_CUSTODY_CLOSE_FAILED"
        && error.errors.length === 1
        && error.errors[0].code === "EINTR",
    );
  } finally {
    injection.restore();
  }
  const reusedDescriptor = injection.reusedDescriptor();
  try {
    assert.equal(injection.calls.length, expectedCount);
    assertOtherDescriptorsClosed(injection.calls, reusedDescriptor);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
    assert.doesNotThrow(() => closeDirectoryCustody(custody));
    assert.throws(
      () => verifyDirectoryCustody(custody),
      /ROLLBACK_CUSTODY_HANDLE_CLOSED/u,
    );
    assert.equal(injection.calls.length, expectedCount);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
  } finally {
    closeSync(reusedDescriptor);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("shared-plan teardown attempts descriptors after a middle uncertain close", () => {
  const boundary = mkdtempSync(join(tmpdir(), "agtmai-shared-close-"));
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  mkdirSync(join(checkout, "a/b"), { recursive: true });
  writeFileSync(join(checkout, "a/b/file.txt"), "held\n");
  mkdirSync(quarantineRoot, { mode: 0o700 });
  const workspace = createRollbackWorkspaceHandle(checkout, quarantineRoot);
  const plan = snapshotRollbackSharedPaths(
    checkout,
    ["a/b/file.txt"],
    workspace,
    { holdDescriptors: true },
  );
  const injection = injectedUncertainClose(1);
  try {
    assert.throws(
      () => closeRollbackSharedPlan(plan),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_SHARED_PATH_CLOSE_FAILED"
        && error.errors.length === 1
        && error.errors[0].code === "EINTR",
    );
  } finally {
    injection.restore();
  }
  const reusedDescriptor = injection.reusedDescriptor();
  try {
    assert.equal(injection.calls.length, 3);
    assertOtherDescriptorsClosed(injection.calls, reusedDescriptor);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
    assert.doesNotThrow(() => closeRollbackSharedPlan(plan));
    assert.equal(injection.calls.length, 3);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
  } finally {
    closeSync(reusedDescriptor);
    closeRollbackWorkspaceHandle(workspace);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("removal-plan teardown disarms every descriptor before middle-close EINTR", () => {
  const boundary = mkdtempSync(join(tmpdir(), "agtmai-removal-close-"));
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  mkdirSync(join(checkout, "slice"), { recursive: true });
  writeFileSync(join(checkout, "slice/a.txt"), "a\n");
  writeFileSync(join(checkout, "slice/b.txt"), "b\n");
  writeFileSync(join(checkout, "slice/c.txt"), "c\n");
  mkdirSync(quarantineRoot, { mode: 0o700 });
  const workspace = createRollbackWorkspaceHandle(checkout, quarantineRoot);
  const quarantine = createRollbackRemovalQuarantine(
    checkout,
    { sliceId: "fixture-slice" },
    { workspaceHandle: workspace },
  );
  snapshotRollbackRemovalPlan(quarantine, [
    { kind: "file", path: "slice/a.txt" },
    { kind: "file", path: "slice/b.txt" },
    { kind: "file", path: "slice/c.txt" },
  ]);
  const planned = quarantine.plannedIdentities;
  const injection = injectedUncertainClose(1);
  try {
    assert.throws(
      () => closeRollbackRemovalPlan(quarantine),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_REMOVAL_DESCRIPTOR_CLOSE_FAILED"
        && error.errors.length === 1
        && error.errors[0].code === "EINTR",
    );
  } finally {
    injection.restore();
  }
  const reusedDescriptor = injection.reusedDescriptor();
  try {
    assert.equal(quarantine.plannedIdentities, undefined);
    assert.equal(injection.calls.length, 3);
    for (const entry of planned.values()) {
      assert.equal(entry.descriptor, undefined);
    }
    assertOtherDescriptorsClosed(injection.calls, reusedDescriptor);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
    assert.doesNotThrow(() => closeRollbackRemovalPlan(quarantine));
    assert.equal(injection.calls.length, 3);
    assert.doesNotThrow(() => fstatSync(reusedDescriptor));
  } finally {
    closeSync(reusedDescriptor);
    closeCustodyDescriptor(quarantine.descriptor);
    closeRollbackWorkspaceHandle(workspace);
    rmSync(boundary, { recursive: true, force: true });
  }
});
