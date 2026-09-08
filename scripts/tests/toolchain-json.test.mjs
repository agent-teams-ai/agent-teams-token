import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseToolchainJson,
  TOOLCHAIN_JSON_LIMITS,
} from "../toolchain-json.mjs";
import { validateLock } from "../toolchain-lock-validation.mjs";

const repositoryRoot = new URL("../..", import.meta.url);
const corpus = JSON.parse(await readFile(
  new URL("tooling/deployment-plan/tests/policy-json-corpus.json", repositoryRoot),
  "utf8",
));

test("bootstrap rejects the shared hostile policy JSON corpus", () => {
  assert.deepEqual(corpus.limits, TOOLCHAIN_JSON_LIMITS);
  for (const entry of corpus.malformed) {
    assert.throws(() => parseToolchainJson(Buffer.from(entry.source)), /TOOLCHAIN_JSON_/);
  }
});

test("bootstrap JSON bounds accept exact boundaries and reject one beyond", () => {
  const limit = TOOLCHAIN_JSON_LIMITS;
  const accepted = [
    `${"[".repeat(limit.depth)}0${"]".repeat(limit.depth)}`,
    `{${Array.from({ length: limit.members }, (_, index) => `"k${index}":0`).join(",")}}`,
    `[${Array.from({ length: limit.arrayItems }, () => "0").join(",")}]`,
    `"${"x".repeat(limit.stringBytes)}"`,
  ];
  const rejected = [
    `${"[".repeat(limit.depth + 1)}0${"]".repeat(limit.depth + 1)}`,
    `{${Array.from({ length: limit.members + 1 }, (_, index) => `"k${index}":0`).join(",")}}`,
    `[${Array.from({ length: limit.arrayItems + 1 }, () => "0").join(",")}]`,
    `"${"x".repeat(limit.stringBytes + 1)}"`,
    " ".repeat(limit.bytes + 1),
  ];
  for (const source of accepted) {
    assert.doesNotThrow(() => parseToolchainJson(Buffer.from(source)));
  }
  assert.doesNotThrow(() => parseToolchainJson(Buffer.concat([
    Buffer.from("0"),
    Buffer.alloc(limit.bytes - 1, 0x20),
  ])));
  for (const source of rejected) {
    assert.throws(
      () => parseToolchainJson(Buffer.from(source)),
      (error) => error instanceof Error && !(error instanceof RangeError),
    );
  }
});

test("bootstrap rejects shared exact-wrapper extra cases", async () => {
  const bytes = await readFile(
    new URL("tooling/toolchain.lock.json", repositoryRoot),
  );
  const lock = parseToolchainJson(bytes);
  assert.doesNotThrow(() => validateLock(lock));
  const duplicate = bytes.toString().replace(
    '"schemaVersion": 2,',
    '"schemaVersion": 2, "schemaVersion": 2,',
  );
  const noncanonical = bytes.toString().replace('"schemaVersion": 2,', '"schemaVersion": 2.0,');
  assert.throws(() => parseToolchainJson(Buffer.from(duplicate)), /DUPLICATE/u);
  assert.throws(() => parseToolchainJson(Buffer.from(noncanonical)), /INVALID/u);
  assert.throws(() => validateLock({
    ...lock,
    [corpus.wrapperExtras[0]]: true,
  }), /TOOLCHAIN_LOCK_WRAPPER/);
  assert.throws(() => validateLock({
    ...lock,
    nativeBuilds: {
      ...lock.nativeBuilds,
      [corpus.wrapperExtras[1]]: true,
    },
  }), /TOOLCHAIN_LOCK_WRAPPER/);
});
