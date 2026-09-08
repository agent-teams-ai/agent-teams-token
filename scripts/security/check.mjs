#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function scanTextForSecrets(text, path = "fixture") {
  const patterns = [
    ["pem-private-key", new RegExp(`${["-----", "BEGIN"].join("")} (?:[A-Z0-9]+ )*${["PRIVATE", " KEY-----"].join("")}`)],
    [
      "evm-private-key",
      new RegExp(
        `["']?\\b(?:[a-z0-9_-]+[-_])?(?:${["pri", "vate"].join("")}|deployer|signer|wallet|owner|admin)[-_]?key\\b["']?\\s*[:=]\\s*["']?(?:0x)?[0-9a-f]{64}\\b`,
        "i",
      ),
    ],
    ["aws-access-key", new RegExp(`\\b${["AK", "IA"].join("")}[A-Z0-9]{16}\\b`)],
    ["github-token", new RegExp(`\\b(?:${["gh", "[pousr]_"].join("")}[A-Za-z0-9]{30,}|${["github", "_pat_"].join("")}[A-Za-z0-9_]{40,})\\b`)],
    ["npm-token", new RegExp(`\\b${["npm", "_"].join("")}[A-Za-z0-9]{30,}\\b`)],
    [
      "assigned-recovery-words",
      new RegExp(`\\b(?:${["mnemo", "nic"].join("")}|${["seed", " phrase"].join("")})\\s*[:=]\\s*["']?(?:[a-z]+\\s+){11,23}[a-z]+`, "i"),
    ],
  ];
  return patterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([kind]) => ({ path, kind }));
}
export function scanTrackedFiles({ root = repositoryRoot, git = defaultGit } = {}) {
  const paths = git(root, ["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
  const findings = [];
  let scanned = 0;
  for (const path of paths) {
    const contents = git(root, ["show", `:${path}`]);
    if (contents.includes(0)) {continue;}
    scanned += 1;
    findings.push(...scanTextForSecrets(contents.toString("utf8"), path));
  }
  if (findings.length > 0) {
    throw new Error(`SECURITY_SECRET_SCAN_FAILED findings=${findings.map(({ path, kind }) => `${path}:${kind}`).join(",")}`);
  }
  return { scanned };
}

function defaultGit(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
}

export function parseLockedPackages(lockText) {
  const lines = lockText.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "packages:");
  if (start < 0) {throw new Error("SECURITY_LOCK_PACKAGES_MISSING");}
  const packages = [];
  let current;
  for (const line of lines.slice(start + 1)) {
    if (/^[a-zA-Z][^:]*:$/.test(line)) {break;}
    const keyMatch = /^  (\S.*):$/.exec(line);
    if (keyMatch) {
      if (current) {packages.push(current);}
      current = { key: unquote(keyMatch[1]), resolution: "" };
      continue;
    }
    if (current && line.startsWith("    resolution:")) {current.resolution = line.trim();}
  }
  if (current) {packages.push(current);}
  if (packages.length === 0) {throw new Error("SECURITY_LOCK_EMPTY");}
  return packages.map((entry) => ({ ...entry, ...splitPackageKey(entry.key) }));
}

function unquote(value) {
  return (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))
    ? value.slice(1, -1)
    : value;
}

function splitPackageKey(key) {
  const withoutPeers = key.replace(/\(.+\)$/, "");
  const separator = withoutPeers.lastIndexOf("@");
  if (separator <= 0) {throw new Error(`SECURITY_LOCK_PACKAGE_KEY_INVALID key=${key}`);}
  return { name: withoutPeers.slice(0, separator), version: withoutPeers.slice(separator + 1) };
}

function versionParts(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {throw new Error(`SECURITY_ADVISORY_VERSION_INVALID version=${value}`);}
  return value.split(".").map((part) => Number.parseInt(part, 10));
}

export function checkLockIntegrity(lockText) {
  const packages = parseLockedPackages(lockText);
  const failures = [];
  for (const entry of packages) {
    if (!/^resolution: \{integrity: sha512-[A-Za-z0-9+/]{86}==\}$/.test(entry.resolution)) {
      failures.push(`${entry.key}:missing-sha512-integrity`);
    }
    if (/\b(?:tarball|directory|path):|https?:|git\+|github:/i.test(entry.resolution)) {
      failures.push(`${entry.key}:non-registry-resolution`);
    }
  }
  if (failures.length > 0) {throw new Error(`SECURITY_LOCK_INTEGRITY_FAILED findings=${failures.join(",")}`);}
  return packages;
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {return Math.sign(difference);}
  }
  return 0;
}

export function checkFrozenAdvisories(packages, policy, now = new Date()) {
  if (
    policy.schemaVersion !== 1
    || !/^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(policy.frozenAt)
    || !/^\d{4}-\d{2}-\d{2}$/.test(policy.validThrough)
    || !Array.isArray(policy.denylist)
  ) {throw new Error("SECURITY_ADVISORY_POLICY_INVALID");}
  const deadline = new Date(`${policy.validThrough}T23:59:59Z`);
  if (now < new Date(policy.frozenAt) || new Date(policy.frozenAt) > deadline) {
    throw new Error("SECURITY_ADVISORY_POLICY_DATES_INVALID");
  }
  if (now > deadline) {throw new Error(`SECURITY_ADVISORY_POLICY_STALE validThrough=${policy.validThrough}`);}
  const findings = [];
  for (const advisory of policy.denylist) {
    if (!/^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/.test(advisory.id)) {
      throw new Error(`SECURITY_ADVISORY_ID_INVALID id=${advisory.id}`);
    }
    for (const entry of packages.filter(({ name }) => name === advisory.package)) {
      const atOrAboveMinimum = !advisory.minInclusive || compareVersions(entry.version, advisory.minInclusive) >= 0;
      const belowMaximum = !advisory.maxExclusive || compareVersions(entry.version, advisory.maxExclusive) < 0;
      if (atOrAboveMinimum && belowMaximum) {findings.push(`${advisory.id}:${entry.name}@${entry.version}`);}
    }
  }
  if (findings.length > 0) {throw new Error(`SECURITY_ADVISORY_DENYLIST_FAILED findings=${findings.join(",")}`);}
  return { advisories: policy.denylist.length };
}

export function installedPackageManifests(nodeModulesRoot) {
  const virtualStore = join(nodeModulesRoot, ".pnpm");
  if (!existsSync(virtualStore) || !lstatSync(virtualStore).isDirectory()) {
    throw new Error("SECURITY_LICENSE_INSTALL_MISSING");
  }
  const manifests = new Map();
  for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") {continue;}
    const nested = join(virtualStore, entry.name, "node_modules");
    if (!existsSync(nested)) {continue;}
    const dependencies = readdirSync(nested, { withFileTypes: true });
    addDependencyManifests(nested, dependencies, manifests);
  }
  if (manifests.size === 0) {throw new Error("SECURITY_LICENSE_PACKAGES_MISSING");}
  return [...manifests.values()];
}

function addDependencyManifests(nested, dependencies, manifests) {
  for (const dependency of dependencies) {
    if (!dependency.isDirectory() && !dependency.isSymbolicLink()) {continue;}
    if (!dependency.name.startsWith("@")) {
      addManifest(join(nested, dependency.name), manifests);
      continue;
    }
    const scope = join(nested, dependency.name);
    for (const scoped of readdirSync(scope, { withFileTypes: true })) {
      if (scoped.isDirectory() || scoped.isSymbolicLink()) {addManifest(join(scope, scoped.name), manifests);}
    }
  }
}

function addManifest(directory, manifests) {
  const path = join(directory, "package.json");
  if (!existsSync(path)) {return;}
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!manifest.name || !manifest.version) {throw new Error(`SECURITY_LICENSE_MANIFEST_INVALID path=${path}`);}
  manifests.set(`${manifest.name}@${manifest.version}`, manifest);
}

export function checkInstalledLicenses(manifests, policy) {
  if (
    policy.schemaVersion !== 1
    || !Array.isArray(policy.allowedSpdx)
    || !policy.exceptions
    || typeof policy.exceptions !== "object"
    || Array.isArray(policy.exceptions)
  ) {
    throw new Error("SECURITY_LICENSE_POLICY_INVALID");
  }
  const allowed = new Set(policy.allowedSpdx);
  const findings = [];
  for (const manifest of manifests) {
    const packageId = `${manifest.name}@${manifest.version}`;
    const legacyLicenses = Array.isArray(manifest.licenses)
      ? manifest.licenses.map((entry) => typeof entry === "string" ? entry : entry?.type).filter(Boolean)
      : [];
    const license = typeof manifest.license === "string"
      ? manifest.license
      : legacyLicenses.length > 0 ? legacyLicenses.join(" OR ") : "MISSING";
    if (policy.exceptions[packageId] === license) {continue;}
    const identifiers = license.match(/[A-Za-z0-9.-]+/g)?.filter((value) => !["AND", "OR", "WITH"].includes(value)) ?? [];
    if (identifiers.length === 0 || identifiers.some((identifier) => !allowed.has(identifier))) {
      findings.push(`${packageId}:${license.replaceAll(/\s+/g, "_")}`);
    }
  }
  if (findings.length > 0) {throw new Error(`SECURITY_LICENSE_ALLOWLIST_FAILED findings=${findings.join(",")}`);}
  return { packages: manifests.length };
}

export function checkVendoredDependencies(manifest, { root = repositoryRoot, allowedSpdx = [] } = {}) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.dependencies) || manifest.dependencies.length === 0) {
    throw new Error("SECURITY_VENDOR_POLICY_INVALID");
  }
  const allowed = new Set(allowedSpdx);
  let fileCount = 0;
  for (const dependency of manifest.dependencies) {
    validateVendorMetadata(dependency, allowed);
    const vendorRoot = resolveVendorRoot(root, dependency.root);
    const actualFiles = listVendoredFiles(vendorRoot).toSorted();
    const expectedFiles = Object.keys(dependency.files).toSorted();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(`SECURITY_VENDOR_FILE_SET_FAILED dependency=${dependency.name}`);
    }
    for (const path of expectedFiles) {
      validateRelativePath(path, "SECURITY_VENDOR_FILE_PATH_INVALID");
      const contents = readFileSync(join(vendorRoot, ...path.split("/")));
      const digest = createHash("sha256").update(contents).digest("hex");
      if (dependency.files[path] !== digest) {
        throw new Error(`SECURITY_VENDOR_CHECKSUM_FAILED dependency=${dependency.name} file=${path}`);
      }
      if (path.endsWith(".sol") && contents.toString("utf8").split(/\r?\n/, 1)[0] !== `// SPDX-License-Identifier: ${dependency.license}`) {
        throw new Error(`SECURITY_VENDOR_SPDX_FAILED dependency=${dependency.name} file=${path}`);
      }
    }
    validateVendorIdentity(vendorRoot, dependency);
    fileCount += expectedFiles.length;
  }
  return { packages: manifest.dependencies.length, files: fileCount };
}

function validateVendorMetadata(dependency, allowed) {
  if (
    !dependency
    || typeof dependency.name !== "string"
    || !/^\d+\.\d+\.\d+$/.test(dependency.version)
    || !/^[0-9a-f]{40}$/.test(dependency.sourceCommit)
    || typeof dependency.license !== "string"
    || !allowed.has(dependency.license)
    || typeof dependency.root !== "string"
    || !dependency.files
    || typeof dependency.files !== "object"
    || Array.isArray(dependency.files)
    || Object.keys(dependency.files).length === 0
    || Object.values(dependency.files).some((digest) => !/^[0-9a-f]{64}$/.test(digest))
  ) {
    throw new Error("SECURITY_VENDOR_METADATA_INVALID");
  }
}

function resolveVendorRoot(root, path) {
  validateRelativePath(path, "SECURITY_VENDOR_ROOT_INVALID");
  const resolvedRoot = resolve(root);
  const resolvedVendor = resolve(root, ...path.split("/"));
  if (!resolvedVendor.startsWith(`${resolvedRoot}${sep}`) || !lstatSync(resolvedVendor).isDirectory()) {
    throw new Error("SECURITY_VENDOR_ROOT_INVALID");
  }
  return resolvedVendor;
}

function validateRelativePath(path, errorCode) {
  if (
    typeof path !== "string"
    || path.length === 0
    || isAbsolute(path)
    || path.includes("\\")
    || path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(errorCode);
  }
}

function listVendoredFiles(directory, base = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {throw new Error("SECURITY_VENDOR_SYMLINK_FAILED");}
    if (stat.isDirectory()) {
      files.push(...listVendoredFiles(path, base));
    } else if (stat.isFile()) {
      files.push(relative(base, path).split(sep).join("/"));
    } else {
      throw new Error("SECURITY_VENDOR_FILE_TYPE_FAILED");
    }
  }
  return files;
}

function validateVendorIdentity(vendorRoot, dependency) {
  const pinned = readFileSync(join(vendorRoot, "PINNED_VERSION"), "utf8");
  if (!pinned.includes(`v${dependency.version}\n`) || !pinned.includes(`Source commit: ${dependency.sourceCommit}\n`)) {
    throw new Error(`SECURITY_VENDOR_IDENTITY_FAILED dependency=${dependency.name}`);
  }
  const license = readFileSync(join(vendorRoot, "LICENSE"), "utf8");
  if (dependency.license === "MIT" && !license.startsWith("The MIT License (MIT)\n")) {
    throw new Error(`SECURITY_VENDOR_LICENSE_FAILED dependency=${dependency.name}`);
  }
}

export function runSecurityCheck({ root = repositoryRoot, now = new Date() } = {}) {
  const secrets = scanTrackedFiles({ root });
  const npmrc = readFileSync(join(root, ".npmrc"), "utf8");
  const registryLines = npmrc.split(/\r?\n/).filter((line) => /registry=/.test(line));
  if (JSON.stringify(registryLines) !== JSON.stringify(["registry=https://registry.npmjs.org/"])) {
    throw new Error("SECURITY_REGISTRY_POLICY_FAILED expected=https://registry.npmjs.org/");
  }
  const lockText = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const packages = checkLockIntegrity(lockText);
  const advisoryPolicy = JSON.parse(readFileSync(join(root, "tooling/security/advisory-denylist.json"), "utf8"));
  const advisories = checkFrozenAdvisories(packages, advisoryPolicy, now);
  const licensePolicy = JSON.parse(readFileSync(join(root, "tooling/security/license-allowlist.json"), "utf8"));
  const manifests = installedPackageManifests(join(root, "node_modules"));
  const licenses = checkInstalledLicenses(manifests, licensePolicy);
  const vendorPolicy = JSON.parse(readFileSync(join(root, "tooling/security/vendor-dependencies.json"), "utf8"));
  const vendored = checkVendoredDependencies(vendorPolicy, { root, allowedSpdx: licensePolicy.allowedSpdx });
  return {
    trackedFiles: secrets.scanned,
    lockedPackages: packages.length,
    installedPackages: licenses.packages,
    vendoredPackages: vendored.packages,
    vendoredFiles: vendored.files,
    frozenAdvisories: advisories.advisories,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runSecurityCheck();
    process.stdout.write(`SECURITY_SCAN_OK trackedFiles=${result.trackedFiles} lockedPackages=${result.lockedPackages} installedPackages=${result.installedPackages} vendoredPackages=${result.vendoredPackages} vendoredFiles=${result.vendoredFiles} frozenAdvisories=${result.frozenAdvisories}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
