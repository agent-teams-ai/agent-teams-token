import assert from "node:assert/strict";
import {test} from "node:test";
import {
  cleanupFailures,
  finishWithCleanup,
} from "../cleanup.ts";
import {LocalEvmError} from "../model.ts";

test("cleanup attempts every action and preserves the primary failure", async () => {
  const primary = new LocalEvmError(
    "LOCAL_EVM_PRIMARY_FIXTURE",
    "primary fixture failure",
  );
  const firstClose = new Error("first close fixture");
  const thirdClose = new Error("third close fixture");
  const attempts: number[] = [];
  const rejected = await finishWithCleanup(primary, [
    () => {
      attempts.push(1);
      throw firstClose;
    },
    () => {
      attempts.push(2);
    },
    async () => {
      attempts.push(3);
      throw thirdClose;
    },
  ]).then(
    () => assert.fail("cleanup must preserve the primary rejection"),
    (cause: unknown) => cause,
  );

  assert.equal(rejected, primary);
  assert.equal((rejected as LocalEvmError).code, "LOCAL_EVM_PRIMARY_FIXTURE");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(cleanupFailures(primary), [firstClose, thirdClose]);
  assert.equal(primary.message.includes(firstClose.message), false);
  assert.equal(primary.message.includes(thirdClose.message), false);
});

test("multiple cleanup-only failures use a redacted aggregate message", async () => {
  const rejected = await finishWithCleanup(undefined, [
    () => {
      throw new Error("sensitive command output fixture");
    },
    () => {
      throw new Error("private path fixture");
    },
  ]).then(
    () => assert.fail("cleanup-only failures must reject"),
    (cause: unknown) => cause,
  );

  assert(rejected instanceof AggregateError);
  assert.equal(rejected.errors.length, 2);
  assert.equal(rejected.message, "multiple local EVM cleanup operations failed");
  assert.equal(rejected.message.includes("sensitive"), false);
  assert.equal(rejected.message.includes("private path"), false);
});
