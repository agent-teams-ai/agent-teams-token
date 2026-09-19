import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { deploymentBytes, type Hex } from "@agent-teams/supply/deployment";
import { qualifySafeArtifacts, requireQualifiedSafeProfile, type QualifiedSafeProfile } from "../src/adapters/safe-artifacts.ts";
import { syntheticSafeArtifacts } from "./fixtures/safe-artifacts.ts";
const digest = (bytes: Uint8Array): Hex => `0x${createHash("sha256").update(bytes).digest("hex")}`;

test("a captured profile cannot select its own artifact authority", () => {
  const { pins, selected, bytes, profile } = syntheticSafeArtifacts();
  requireQualifiedSafeProfile(profile);
  assert.throws(() => requireQualifiedSafeProfile(Object.freeze({ ...profile })), /CUSTODY_SAFE_PROFILE_UNQUALIFIED/);
  assert.throws(() => requireQualifiedSafeProfile(JSON.parse(JSON.stringify(profile)) as QualifiedSafeProfile), /CUSTODY_SAFE_PROFILE_UNQUALIFIED/);
  for (const change of [{ version: "1.3.0" }, { sourceRevision: "2".repeat(40) }, { compilerVersion: "0.8.36" }]) {
    assert.throws(() => qualifySafeArtifacts({ ...pins, ...change } as typeof pins, selected, bytes, profile.singleton), /CUSTODY_SAFE_PROFILE_UNQUALIFIED/);
  }
  for (const key of ["proxy", "singleton", "buildInfo"] as const) {
    assert.throws(() => qualifySafeArtifacts(pins, selected, { ...bytes, [key]: new Uint8Array() }, profile.singleton), /CUSTODY_SAFE_PROFILE_UNQUALIFIED/);
    assert.throws(() => qualifySafeArtifacts(pins, selected, { ...bytes, [key]: new TextEncoder().encode("{}") }, profile.singleton), /CUSTODY_SAFE_PROFILE_UNQUALIFIED/);
  }
});

test("reviewed pins still require consistent ABI, runtime and compiler/source provenance", () => {
  for (const field of ["abiSha256", "runtimeKeccak256", "contractName"] as const) {
    const { pins, bytes, profile } = syntheticSafeArtifacts();
    const changed = { ...pins, proxy: { ...pins.proxy, [field]: field === "contractName" ? "Safe" : `0x${"0".repeat(64)}` } } as typeof pins;
    assert.throws(() => qualifySafeArtifacts(changed, digest(deploymentBytes(changed)), bytes, profile.singleton), /CUSTODY_SAFE_PROFILE_UNQUALIFIED/);
  }
  for (const surface of ["compiler", "bytecode", "source", "metadata"]) {
    const { pins, bytes, profile } = syntheticSafeArtifacts();
    const build = JSON.parse(new TextDecoder().decode(bytes.buildInfo));
    if (surface === "compiler") { build.solcLongVersion = "0.8.36"; }
    if (surface === "bytecode") { build.output.contracts["contracts/Synthetic.sol"].Safe.evm.bytecode.object = "6001"; }
    if (surface === "source") { build.input.sources["contracts/Synthetic.sol"].content += " changed"; }
    if (surface === "metadata") { build.output.contracts["contracts/Synthetic.sol"].Safe.metadata = "{}"; }
    const buildInfo = deploymentBytes(build), changed = { ...pins, buildInfoSha256: digest(buildInfo) };
    assert.throws(() => qualifySafeArtifacts(changed, digest(deploymentBytes(changed)), { ...bytes, buildInfo }, profile.singleton), /CUSTODY_SAFE_PROFILE_UNQUALIFIED/);
  }
});
