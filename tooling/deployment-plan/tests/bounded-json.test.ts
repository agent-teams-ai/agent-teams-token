import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSON_LIMITS, parseBoundedJson } from "../src/adapters/bounded-json.ts";
import { parseNativeNoReplacePolicyLock } from "../src/adapters/native-policy.ts";
import { DeploymentPlanError } from "../src/domain/model.ts";

interface Corpus {
  readonly malformed: readonly { readonly name: string; readonly source: string }[];
  readonly wrapperExtras: readonly string[];
  readonly limits: typeof JSON_LIMITS;
}

const corpus = JSON.parse(await readFile(
  new URL("./policy-json-corpus.json", import.meta.url),
  "utf8",
)) as Corpus;

test("shared hostile policy JSON corpus is rejected with bounded domain errors", () => {
  assert.deepEqual(corpus.limits, JSON_LIMITS);
  for (const entry of corpus.malformed) {
    assert.throws(
      () => parseBoundedJson(Buffer.from(entry.source)),
      (error: unknown) => error instanceof DeploymentPlanError && !(error instanceof RangeError),
      entry.name,
    );
  }
});

test("JSON bounds accept every exact boundary", () => {
  const depth = `${"[".repeat(JSON_LIMITS.depth)}0${"]".repeat(JSON_LIMITS.depth)}`;
  const members = `{${Array.from(
    { length: JSON_LIMITS.members },
    (_, index) => `"k${index}":0`,
  ).join(",")}}`;
  const array = `[${Array.from({ length: JSON_LIMITS.arrayItems }, () => "0").join(",")}]`;
  const string = `"${"x".repeat(JSON_LIMITS.stringBytes)}"`;
  for (const source of [depth, members, array, string]) {
    assert.doesNotThrow(() => parseBoundedJson(Buffer.from(source)));
  }
  assert.doesNotThrow(() => parseBoundedJson(Buffer.concat([
    Buffer.from("0"),
    Buffer.alloc(JSON_LIMITS.bytes - 1, 0x20),
  ])));
});

test("JSON limits reject one beyond every boundary without RangeError", () => {
  const sources = [
    `${"[".repeat(JSON_LIMITS.depth + 1)}0${"]".repeat(JSON_LIMITS.depth + 1)}`,
    `{${Array.from(
      { length: JSON_LIMITS.members + 1 },
      (_, index) => `"k${index}":0`,
    ).join(",")}}`,
    `[${Array.from({ length: JSON_LIMITS.arrayItems + 1 }, () => "0").join(",")}]`,
    `"${"x".repeat(JSON_LIMITS.stringBytes + 1)}"`,
    " ".repeat(JSON_LIMITS.bytes + 1),
  ];
  for (const source of sources) {
    assert.throws(
      () => parseBoundedJson(Buffer.from(source)),
      (error: unknown) => error instanceof DeploymentPlanError && !(error instanceof RangeError),
    );
  }
});

test("native policy lock rejects exact-wrapper extras", async () => {
  const bytes = await readFile(new URL("../../toolchain.lock.json", import.meta.url));
  const lock = JSON.parse(bytes.toString()) as Record<string, unknown>;
  assert.doesNotThrow(() => parseNativeNoReplacePolicyLock(bytes));
  const duplicate = bytes.toString().replace(
    '"schemaVersion": 2,',
    '"schemaVersion": 2, "schemaVersion": 2,',
  );
  const noncanonical = bytes.toString().replace('"schemaVersion": 2,', '"schemaVersion": 2.0,');
  assert.throws(() => parseNativeNoReplacePolicyLock(Buffer.from(duplicate)), /duplicate/u);
  assert.throws(() => parseNativeNoReplacePolicyLock(Buffer.from(noncanonical)), /malformed/u);
  assert.throws(
    () => parseNativeNoReplacePolicyLock(Buffer.from(JSON.stringify({
      ...lock,
      [corpus.wrapperExtras[0]!]: true,
    }))),
    /unknown/u,
  );
  const nativeBuilds = lock.nativeBuilds as Record<string, unknown>;
  assert.throws(
    () => parseNativeNoReplacePolicyLock(Buffer.from(JSON.stringify({
      ...lock,
      nativeBuilds: { ...nativeBuilds, [corpus.wrapperExtras[1]!]: true },
    }))),
    /unknown/u,
  );
});
