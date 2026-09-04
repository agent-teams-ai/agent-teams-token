import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  captureCleanupTreeSnapshot,
  cleanupIdentityBoundDirectory as cleanupIdentityBoundDirectoryWithSnapshot,
  createCleanupHandle,
} from "../proof-runtime.mjs";

const targetPrefix = "agtmai-rollback-local-solana-";

function cleanupIdentityBoundDirectory(handle, options) {
  captureCleanupTreeSnapshot(handle);
  return cleanupIdentityBoundDirectoryWithSnapshot(handle, options);
}

function fixture() {
  const boundary = mkdtempSync(join(tmpdir(), "agtmai-rollback-cleanup-safety-test-"));
  const target = mkdtempSync(join(boundary, targetPrefix));
  chmodSync(target, 0o700);
  return {
    boundary,
    target,
    policy: {
      temporaryRoot: boundary,
      targetPrefix,
      allowedEntries: ["checkout"],
    },
  };
}

function checkout(target) {
  const path = join(target, "checkout");
  mkdirSync(path, { mode: 0o700 });
  return path;
}

function caught(action, expected) {
  try {
    action();
  } catch (error) {
    assert.match(error.message, expected);
    return error;
  }
  assert.fail("expected cleanup to fail closed");
}

function preservedQuarantine(error) {
  const match = /preservedQuarantine=([^\s]+)/u.exec(error.message);
  assert.notEqual(match, null, error.message);
  return match[1];
}


export { assert, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, test, captureCleanupTreeSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, targetPrefix, cleanupIdentityBoundDirectory, fixture, checkout, caught, preservedQuarantine };
