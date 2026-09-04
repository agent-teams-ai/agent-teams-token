import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  abandonCleanupHandle,
  captureCleanupTreeSnapshot,
  createCleanupHandle,
} from "../rollback/runtime/cleanup.mjs";
import {
  finalizeRollbackTemporaryParent,
} from "../rollback/slices/gate-execution.mjs";
import {
  closeRollbackWorkspaceHandle,
  createRollbackWorkspaceHandle,
  rollbackWorkspaceState,
} from "../rollback/slices/workspace-handle.mjs";
import {
  assertOtherDescriptorsClosed,
  injectedUncertainClose,
} from "./rollback-descriptor-close-fixture.mjs";

function fixture() {
  const boundary = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-finalizer-test-")));
  const temporaryParent = mkdtempSync(join(boundary, "agtmai-rollback-slither-"));
  const cleanupHandle = createCleanupHandle(temporaryParent, {
    temporaryRoot: boundary,
    targetPrefix: "agtmai-rollback-slither-",
    allowedEntries: ["checkout", "gate-tmp"],
  });
  const checkout = join(temporaryParent, "checkout");
  const quarantineRoot = join(temporaryParent, "gate-tmp");
  mkdirSync(checkout, { mode: 0o700 });
  mkdirSync(quarantineRoot, { mode: 0o700 });
  writeFileSync(join(checkout, "owned.txt"), "preserve on proof failure\n");
  const workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
  const { quarantineDescriptor, checkoutDescriptor } = rollbackWorkspaceState(workspaceHandle);
  captureCleanupTreeSnapshot(cleanupHandle);
  return {
    boundary,
    temporaryParent,
    checkout,
    cleanupHandle,
    workspaceHandle,
    workspaceDescriptors: [quarantineDescriptor, checkoutDescriptor],
  };
}

function releaseFixture(value, injection) {
  injection.restore();
  const reusedDescriptor = injection.reusedDescriptor();
  try {
    closeRollbackWorkspaceHandle(value.workspaceHandle);
    if (!value.cleanupHandle.closed) {
      abandonCleanupHandle(value.cleanupHandle);
    }
  } finally {
    if (Number.isInteger(reusedDescriptor)) {
      closeSync(reusedDescriptor);
    }
    rmSync(value.boundary, { recursive: true, force: true });
  }
}

function assertTerminalWorkspaceClose(value, injection) {
  for (const descriptor of value.workspaceDescriptors) {
    assert.equal(injection.calls.filter((called) => called === descriptor).length, 1);
  }
  const reusedDescriptor = injection.reusedDescriptor();
  assert.equal(reusedDescriptor, value.workspaceDescriptors[0]);
  assertOtherDescriptorsClosed(injection.calls, reusedDescriptor);
  assert.doesNotThrow(() => fstatSync(reusedDescriptor));
  const count = injection.calls.length;
  assert.doesNotThrow(() => closeRollbackWorkspaceHandle(value.workspaceHandle));
  assert.equal(injection.calls.length, count);
  assert.doesNotThrow(() => fstatSync(reusedDescriptor));
}

for (const mode of ["proof-failure", "cleanup-failure", "proof-and-cleanup-failure", "clean-removal"]) {
  test(`temporary finalizer retains ordered failures after real close: ${mode}`, () => {
    const value = fixture();
    const primaryFailure = mode.startsWith("proof-") ? new Error("original proof failure") : undefined;
    if (mode === "cleanup-failure") {
      writeFileSync(join(value.checkout, "foreign-successor.txt"), "do not remove\n");
    }
    if (mode === "proof-and-cleanup-failure") {
      // A consumed cleanup owner must fail validation, not erase the proof
      // error or prevent terminal workspace closure.
      abandonCleanupHandle(value.cleanupHandle);
    }
    const injection = injectedUncertainClose(
      (_index, descriptor) => descriptor === value.workspaceDescriptors[0],
    );
    try {
      const result = finalizeRollbackTemporaryParent({
        cleanupHandle: value.cleanupHandle,
        workspaceHandle: value.workspaceHandle,
        primaryFailure,
      });
      assert.equal(result.primaryFailure, primaryFailure);
      assert.equal(result.cleanup.status, "failed");
      const compoundCleanup = mode.includes("cleanup-failure");
      const closeFailure = compoundCleanup
        ? result.cleanupFailure.errors[1]
        : result.cleanupFailure;
      if (compoundCleanup) {
        assert.ok(result.cleanupFailure instanceof AggregateError);
        assert.equal(result.cleanupFailure.errors.length, 2);
        assert.equal(result.cleanupFailure.cause, result.cleanupFailure.errors[0]);
        assert.match(result.cleanupFailure.errors[0].message, /ROLLBACK_CLEANUP_/u);
      }
      assert.ok(closeFailure instanceof AggregateError);
      assert.equal(closeFailure.message, "ROLLBACK_REMOVAL_WORKSPACE_CLOSE_FAILED");
      assert.equal(closeFailure.errors.length, 1);
      assert.equal(closeFailure.errors[0].code, "EINTR");
      assert.equal(result.cleanup.error, result.cleanupFailure.message);
      assertTerminalWorkspaceClose(value, injection);
      if (mode === "clean-removal") {
        assert.equal(result.cleanup.result.result, "contents-removed");
        assert.equal(existsSync(value.temporaryParent), false);
      } else {
        assert.equal(readFileSync(join(value.checkout, "owned.txt"), "utf8"), "preserve on proof failure\n");
        if (mode === "cleanup-failure") {
          assert.equal(readFileSync(join(value.checkout, "foreign-successor.txt"), "utf8"), "do not remove\n");
        }
      }
    } finally {
      releaseFixture(value, injection);
    }
  });
}
