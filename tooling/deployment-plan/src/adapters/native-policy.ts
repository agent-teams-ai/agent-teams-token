import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeNoReplacePolicy } from "../application/ports.ts";
import { canonicalJson } from "../domain/identity.ts";
import { fail } from "../domain/model.ts";
import { JSON_LIMITS, parseBoundedJson } from "./bounded-json.ts";

const LOCK = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../toolchain.lock.json");
const HASH = /^0x[0-9a-f]{64}$/u;
const SOURCE_SHA256 = "0xf3bd0279809e011933eb6ed92d55c2c7ee3bb28dedb2294ea47fe49a25483f09";

export async function loadCommittedNativeNoReplacePolicy(): Promise<NativeNoReplacePolicy> {
  return parseNativeNoReplacePolicyLock(await readPolicyBytes());
}

export function parseNativeNoReplacePolicyLock(bytes: Uint8Array): NativeNoReplacePolicy {
  const lock = exactObject(parseBoundedJson(bytes), [
    "schemaVersion", "retrievedAt", "platforms", "coreTools", "nativeBuilds",
    "fixtureTools", "policy", "tools", "securityImages",
  ]);
  if (lock.schemaVersion !== 2) {
    fail("NO_REPLACE_POLICY_INVALID", "toolchain lock schema is invalid");
  }
  const builds = exactObject(lock.nativeBuilds, ["noReplace"]);
  return validateNativeNoReplacePolicy(builds.noReplace);
}

export function validateNativeNoReplacePolicy(value: unknown): NativeNoReplacePolicy {
  const policy = exactObject(value, [
    "schemaVersion", "kind", "sourcePath", "sourceSha256", "compileProfile", "platforms",
  ]);
  if (policy.schemaVersion !== 1
    || policy.kind !== "native-no-replace-build-policy"
    || policy.sourcePath !== "tooling/deployment-plan/native/no-replace.c"
    || policy.sourceSha256 !== SOURCE_SHA256
    || policy.compileProfile !== "c11-o2-werror-stdin-v1") {
    fail("NO_REPLACE_POLICY_INVALID", "native build policy header is invalid");
  }
  const platforms = exactObject(policy.platforms, ["darwin-arm64", "linux-x64"]);
  validatePlatform(platforms["darwin-arm64"], {
    strategy: "verified-path", compilerPath: "/usr/bin/cc",
  });
  validatePlatform(platforms["linux-x64"], {
    strategy: "snapshot-fd", compilerPath: "/usr/bin/x86_64-linux-gnu-gcc-13",
  });
  return policy as unknown as NativeNoReplacePolicy;
}

interface PlatformExpectation {
  readonly strategy: "snapshot-fd" | "verified-path";
  readonly compilerPath: string;
}

function validatePlatform(value: unknown, expected: PlatformExpectation): void {
  const platform = exactObject(value, ["strategy", "tuples"]);
  if (platform.strategy !== expected.strategy || !Array.isArray(platform.tuples)
    || platform.tuples.length < 1 || platform.tuples.length > 2) {
    fail("NO_REPLACE_POLICY_INVALID", "native platform policy is invalid");
  }
  const tuples = platform.tuples.map((item) => validateTuple(item, expected.compilerPath));
  const serialized = tuples.map((tuple) => canonicalJson(tuple));
  const identities = tuples.map((tuple) =>
    `${String(tuple.compilerPath)}|${String(tuple.compilerSha256)}`);
  if (new Set(serialized).size !== serialized.length
    || new Set(identities).size !== identities.length
    || serialized.some((entry, index) => index > 0 && serialized[index - 1]! >= entry)) {
    fail("NO_REPLACE_POLICY_INVALID", "native tuples must be unique and sorted");
  }
}

function validateTuple(value: unknown, compilerPath: string): Record<string, unknown> {
  const tuple = exactObject(value, ["compilerPath", "compilerSha256", "executableSha256"]);
  if (tuple.compilerPath !== compilerPath
    || typeof tuple.compilerSha256 !== "string" || !HASH.test(tuple.compilerSha256)
    || typeof tuple.executableSha256 !== "string" || !HASH.test(tuple.executableSha256)) {
    fail("NO_REPLACE_POLICY_INVALID", "native tuple is malformed");
  }
  return tuple;
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("NO_REPLACE_POLICY_INVALID", "native policy member is not an object");
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).toSorted();
  const expected = [...keys].toSorted();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    fail("NO_REPLACE_POLICY_INVALID", "native policy has missing or unknown members");
  }
  return object;
}

async function readPolicyBytes(): Promise<Uint8Array> {
  const file = await open(LOCK, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1
      || !Number.isSafeInteger(before.size) || before.size > JSON_LIMITS.bytes) {
      fail("JSON_LIMIT_BYTES", "toolchain lock exceeds the byte limit");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) {
        fail("NO_REPLACE_POLICY_INVALID", "toolchain lock became shorter while read");
      }
      offset += result.bytesRead;
    }
    const trailing = Buffer.alloc(1);
    if ((await file.read(trailing, 0, 1, offset)).bytesRead !== 0) {
      fail("NO_REPLACE_POLICY_INVALID", "toolchain lock grew while read");
    }
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      fail("NO_REPLACE_POLICY_INVALID", "toolchain lock changed while read");
    }
    return bytes;
  } finally {
    await file.close();
  }
}
