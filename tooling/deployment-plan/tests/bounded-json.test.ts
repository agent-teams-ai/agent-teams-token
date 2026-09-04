import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  FORGE_ARTIFACT_JSON_LIMITS,
  FORGE_BUILD_INFO_JSON_LIMITS,
  POLICY_JSON_LIMITS,
  parseBoundedJson,
  type JsonLimits,
} from "../src/adapters/bounded-json.ts";
import { parseRawArtifactJson } from "../src/adapters/strict-json.ts";
import { parseNativeNoReplacePolicyLock } from "../src/adapters/native-policy.ts";
import { DeploymentPlanError } from "../src/domain/model.ts";

interface Corpus {
  readonly malformed: readonly { readonly name: string; readonly source: string }[];
  readonly wrapperExtras: readonly string[];
  readonly limits: JsonLimits;
}

const corpus = JSON.parse(await readFile(
  new URL("./policy-json-corpus.json", import.meta.url),
  "utf8",
)) as Corpus;

test("shared hostile policy JSON corpus is rejected with bounded domain errors", () => {
  assert.deepEqual(corpus.limits, POLICY_JSON_LIMITS);
  for (const entry of corpus.malformed) {
    assert.throws(
      () => parseBoundedJson(Buffer.from(entry.source), POLICY_JSON_LIMITS),
      (error: unknown) => error instanceof DeploymentPlanError && !(error instanceof RangeError),
      entry.name,
    );
  }
});

const PROFILES = [
  ["policy/evidence/READY", POLICY_JSON_LIMITS],
  ["Forge artifact", FORGE_ARTIFACT_JSON_LIMITS],
  ["Forge build-info", FORGE_BUILD_INFO_JSON_LIMITS],
] as const satisfies readonly (readonly [string, Readonly<JsonLimits>])[];

test("JSON limit profiles are immutable", () => {
  for (const [name, limits] of PROFILES) {
    assert.equal(Object.isFrozen(limits), true, name);
  }
});

test("every JSON profile accepts each exact boundary", () => {
  for (const [name, limits] of PROFILES) {
    const depth = `${"[".repeat(limits.depth)}0${"]".repeat(limits.depth)}`;
    const members = `{${Array.from(
      { length: limits.members },
      (_, index) => `"k${index}":0`,
    ).join(",")}}`;
    const array = `[${Array.from({ length: limits.arrayItems }, () => "0").join(",")}]`;
    const string = `"${"x".repeat(limits.stringBytes)}"`;
    for (const candidate of [depth, members, array, string]) {
      assert.doesNotThrow(() => parseBoundedJson(Buffer.from(candidate), limits), name);
    }
    assert.doesNotThrow(() => parseBoundedJson(Buffer.concat([
      Buffer.from("0"),
      Buffer.alloc(limits.bytes - 1, 0x20),
    ]), limits), name);
  }
});

test("every JSON profile rejects one beyond each boundary without RangeError", () => {
  for (const [name, limits] of PROFILES) {
    const candidates = [
      `${"[".repeat(limits.depth + 1)}0${"]".repeat(limits.depth + 1)}`,
      `{${Array.from(
        { length: limits.members + 1 },
        (_, index) => `"k${index}":0`,
      ).join(",")}}`,
      `[${Array.from({ length: limits.arrayItems + 1 }, () => "0").join(",")}]`,
      `"${"x".repeat(limits.stringBytes + 1)}"`,
      " ".repeat(limits.bytes + 1),
    ];
    for (const candidate of candidates) {
      assert.throws(
        () => parseBoundedJson(Buffer.from(candidate), limits),
        (error: unknown) => error instanceof DeploymentPlanError && !(error instanceof RangeError),
        name,
      );
    }
  }
});

test("representative Forge 1.8.0 build-info uses only the build-info profile", async () => {
  const bytes = await readFile(new URL(
    "./fixtures/forge-build-info-1.8.0-representative.json",
    import.meta.url,
  ));
  assert(bytes.byteLength > POLICY_JSON_LIMITS.bytes);
  assert.doesNotThrow(() => parseRawArtifactJson(bytes, "build-info"));
  assert.throws(
    () => parseBoundedJson(bytes, POLICY_JSON_LIMITS),
    (error: unknown) => error instanceof DeploymentPlanError
      && error.code === "JSON_LIMIT_BYTES",
  );
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
