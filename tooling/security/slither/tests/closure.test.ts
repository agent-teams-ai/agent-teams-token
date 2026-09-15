import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { DetectorInventoryDocument, GateManifest } from "../src/domain/model.ts";
import { sha256 } from "../src/adapters/fingerprint.ts";
import { assertProductionCoverage } from "../src/application/coverage.ts";

test("committed closure assigns every tracked production source to analysis", async () => {
  const manifest = JSON.parse(await readFile("tooling/security/slither/production-closure.v1.json", "utf8")) as GateManifest;
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "contracts/evm/src"], { encoding: "utf8" })
    .split("\0").filter((path) => path.endsWith(".sol")).toSorted();
  assertProductionCoverage(tracked, manifest);
  assert.deepEqual(manifest.targets, [
    { path: "contracts/evm/src/features/token-genesis/AGTMAIToken.sol", contract: "AGTMAIToken" },
    { path: "contracts/evm/src/features/token-genesis/AGTMAICCIPToken.sol", contract: "AGTMAICCIPToken" },
    { path: "contracts/evm/src/features/contributor-grants/GrantAccounting.sol", contract: "GrantAccounting" },
  ]);
  for (const target of manifest.targets) {
    assert.ok(manifest.expectedContracts.includes(target.contract));
    assert.throws(() => assertProductionCoverage(tracked, {
      ...manifest,
      targets: manifest.targets.filter(({ path }) => path !== target.path),
    }), { code: "PRODUCTION_SOURCE_UNASSIGNED" });
  }
});

test("committed production closure has exact source and config hashes", async () => {
  const root = process.cwd();
  const manifest = JSON.parse(await readFile(`${root}/tooling/security/slither/production-closure.v1.json`, "utf8")) as GateManifest;
  for (const entry of [...manifest.sources, ...manifest.config]) {assert.equal(sha256(await readFile(`${root}/${entry.path}`)), entry.sha256, entry.path);}
  assert.equal(manifest.sources.some(({ path }) => path.includes("/test/") || path.includes("/script/")), false);
  assert.equal(manifest.sources.some(({ path }) => path.endsWith("AGTMAIToken.sol")), true);
  const inventory = JSON.parse(
    await readFile(`${root}/${manifest.detectorInventory.path}`, "utf8"),
  ) as DetectorInventoryDocument;
  assert.equal(
    sha256(await readFile(`${root}/${manifest.detectorInventory.path}`)),
    manifest.detectorInventory.sha256,
  );
  assert.equal(inventory.slitherVersion, "0.11.6");
  assert.equal(inventory.detectors.length, 101);
  assert.deepEqual(inventory.detectors, inventory.detectors.toSorted());
  assert.equal(new Set(inventory.detectors).size, 101);
  assert.equal(manifest.creationBytecodeSha256, "56d021ec13df6cccbc5d330ccad2acd567f5b4cb75665a0d9982604306c92493");
});

test("synthetic vulnerable fixture is outside the production closure", async () => {
  const manifest = JSON.parse(await readFile("tooling/security/slither/production-closure.v1.json", "utf8")) as GateManifest;
  const vulnerable = await readFile("tooling/security/slither/tests/fixtures/Vulnerable.sol", "utf8");
  assert.match(vulnerable, /selfdestruct/u);
  assert.equal(manifest.sources.some(({ path }) => path.includes("Vulnerable.sol")), false);
});

test("Slither configuration contains no detector or path exclusions", async () => {
  const config = JSON.parse(await readFile("tooling/security/slither/slither.config.json", "utf8")) as Record<string, unknown>;
  assert.equal(config.exclude_dependencies, false); assert.equal("detectors_to_exclude" in config, false); assert.equal("filter_paths" in config, false);
});
