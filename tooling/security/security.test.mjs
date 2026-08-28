import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkFrozenAdvisories,
  checkInstalledLicenses,
  checkLockIntegrity,
  checkVendoredDependencies,
  installedPackageManifests,
  scanTextForSecrets,
} from "../../scripts/security/check.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const safeLock = `lockfileVersion: '9.0'

packages:

  safe-package@2.0.0:
    resolution: {integrity: sha512-${"A".repeat(86)}==}
    peerDependencies:
      fixture-peer: ^1.0.0

snapshots:
`;

test("tracked-secret scanner detects representative credential fixtures", () => {
  const pem = ["-----BEGIN", "PRIVATE KEY-----", "fixture", "-----END", "PRIVATE KEY-----"].join(" ");
  const rsaPem = ["-----BEGIN", "RSA PRIVATE KEY-----", "fixture"].join(" ");
  const accessKey = `${["AK", "IA"].join("")}ABCDEFGHIJKLMNOP`;
  const recoveryWords = `${["seed", " phrase"].join("")} = abandon ability able about above absent absorb abstract absurd abuse access accident`;
  const evmPrivateKey = `${["MAINNET", "PRIVATE", "KEY"].join("_")} = "${"0x"}${"1".repeat(64)}"`;
  const ordinaryDigest = `sha256 = "${"0x"}${"2".repeat(64)}"`;
  assert.deepEqual(scanTextForSecrets("ordinary source text"), []);
  assert.deepEqual(scanTextForSecrets(pem).map(({ kind }) => kind), ["pem-private-key"]);
  assert.deepEqual(scanTextForSecrets(rsaPem).map(({ kind }) => kind), ["pem-private-key"]);
  assert.deepEqual(scanTextForSecrets(accessKey).map(({ kind }) => kind), ["aws-access-key"]);
  assert.deepEqual(scanTextForSecrets(recoveryWords).map(({ kind }) => kind), ["assigned-recovery-words"]);
  assert.deepEqual(scanTextForSecrets(evmPrivateKey).map(({ kind }) => kind), ["evm-private-key"]);
  assert.deepEqual(scanTextForSecrets(ordinaryDigest), []);
});
test("lock scan requires sha512 integrity and rejects non-registry resolutions", () => {
  assert.equal(checkLockIntegrity(safeLock).length, 1);
  assert.throws(
    () => checkLockIntegrity(safeLock.replace(/resolution:.+/, "resolution: {tarball: https://example.invalid/package.tgz}")),
    /missing-sha512-integrity.*non-registry-resolution/,
  );
  assert.throws(
    () => checkLockIntegrity(safeLock.replace(/    resolution:.+\n/, "")),
    /missing-sha512-integrity/,
  );
});

test("frozen advisory fixture denies an affected version and expires closed", () => {
  const policy = {
    schemaVersion: 1,
    frozenAt: "2026-08-28T00:00:00Z",
    validThrough: "2026-09-27",
    denylist: [{
      id: "GHSA-3h5v-q93c-6h6q",
      package: "safe-package",
      minInclusive: "1.0.0",
      maxExclusive: "2.1.0",
    }],
  };
  const packages = checkLockIntegrity(safeLock);
  assert.throws(
    () => checkFrozenAdvisories(packages, policy, new Date("2026-08-28T12:00:00Z")),
    /SECURITY_ADVISORY_DENYLIST_FAILED/,
  );
  assert.throws(
    () => checkFrozenAdvisories([], policy, new Date("2026-09-28T00:00:00Z")),
    /SECURITY_ADVISORY_POLICY_STALE/,
  );
});

test("installed license scan reads pnpm layout and fails outside the allowlist", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-license-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, ".pnpm", "fixture-package@1.0.0", "node_modules", "fixture-package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "fixture-package",
    version: "1.0.0",
    license: "MIT",
  }));
  const manifests = installedPackageManifests(root);
  assert.equal(checkInstalledLicenses(manifests, {
    schemaVersion: 1,
    allowedSpdx: ["MIT"],
    exceptions: {},
  }).packages, 1);
  assert.equal(checkInstalledLicenses([{ name: "legacy", version: "1.0.0", licenses: [{ type: "MIT" }] }], {
    schemaVersion: 1,
    allowedSpdx: ["MIT"],
    exceptions: {},
  }).packages, 1);
  assert.throws(
    () => checkInstalledLicenses([{ ...manifests[0], license: "Proprietary-Fixture" }], {
      schemaVersion: 1,
      allowedSpdx: ["MIT"],
      exceptions: {},
    }),
    /SECURITY_LICENSE_ALLOWLIST_FAILED/,
  );
});

test("vendored dependency policy binds identity, license, SPDX and the exact file closure", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-vendor-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const vendorRoot = join(root, "vendor", "fixture");
  const contractRoot = join(vendorRoot, "contracts");
  mkdirSync(contractRoot, { recursive: true });
  const license = "The MIT License (MIT)\nfixture\n";
  const pinned = "Fixture v1.2.3\nSource commit: 1111111111111111111111111111111111111111\n";
  const source = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\n";
  writeFileSync(join(vendorRoot, "LICENSE"), license);
  writeFileSync(join(vendorRoot, "PINNED_VERSION"), pinned);
  writeFileSync(join(contractRoot, "Fixture.sol"), source);
  const manifest = {
    schemaVersion: 1,
    dependencies: [{
      name: "fixture",
      version: "1.2.3",
      sourceCommit: "1".repeat(40),
      license: "MIT",
      root: "vendor/fixture",
      files: {
        "LICENSE": sha256(license),
        "PINNED_VERSION": sha256(pinned),
        "contracts/Fixture.sol": sha256(source),
      },
    }],
  };
  assert.deepEqual(checkVendoredDependencies(manifest, { root, allowedSpdx: ["MIT"] }), { packages: 1, files: 3 });

  const badSource = source.replace("MIT", "Proprietary");
  writeFileSync(join(contractRoot, "Fixture.sol"), badSource);
  const badSpdxManifest = structuredClone(manifest);
  badSpdxManifest.dependencies[0].files["contracts/Fixture.sol"] = sha256(badSource);
  assert.throws(
    () => checkVendoredDependencies(badSpdxManifest, { root, allowedSpdx: ["MIT"] }),
    /SECURITY_VENDOR_SPDX_FAILED/,
  );
  assert.throws(
    () => checkVendoredDependencies(manifest, { root, allowedSpdx: ["MIT"] }),
    /SECURITY_VENDOR_CHECKSUM_FAILED/,
  );
});
