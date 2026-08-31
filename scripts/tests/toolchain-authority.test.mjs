import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  fetchArtifacts,
  inspectInstallation,
  installArtifacts,
  loadLock,
  prepareVerifiedPayload,
  verifyCache,
} from "../toolchain.mjs";
import {
  inventoryInstallation,
  inventorySha256,
  provenanceFile,
} from "../toolchain-archive.mjs";
import { makeFixture } from "./toolchain-fixture.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const platform = "linux-x64";

function installFixture(context) {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({ lock: fixture.lock, platform, toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  installArtifacts({ lock: fixture.lock, platform, toolsRoot: fixture.toolsRoot, offline: true });
  return fixture;
}

function forgeInventoryProvenance(destination) {
  const path = join(destination, provenanceFile);
  const provenance = JSON.parse(readFileSync(path, "utf8"));
  provenance.inventorySha256 = inventorySha256(
    inventoryInstallation(destination, { exclude: [provenanceFile] }),
  );
  writeFileSync(path, `${JSON.stringify(provenance, null, 2)}\n`);
}

function inspectPnpm(fixture) {
  const tool = fixture.lock.tools.pnpm;
  return inspectInstallation({
    name: "pnpm",
    tool,
    artifact: tool,
    platform,
    destination: join(fixture.toolsRoot, tool.installDirectory),
    toolsRoot: fixture.toolsRoot,
    lock: fixture.lock,
  });
}

function markerPayload(marker) {
  return `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed\\n");\nprocess.stdout.write("11.24.0\\n");\n`;
}

export function registerToolchainAuthorityTests() {
test("all pinned archive artifacts declare complete-tree installation authority", () => {
  const lock = loadLock(join(repositoryRoot, "tooling/toolchain.lock.json"));
  assert.equal(lock.tools.pnpm.installationAuthority, "pinned-archive-complete-tree-v1");
  for (const name of [...lock.coreTools, ...lock.fixtureTools]) {
    for (const supportedPlatform of lock.platforms) {
      assert.equal(
        lock.tools[name].platforms[supportedPlatform].installationAuthority,
        "pinned-archive-complete-tree-v1",
      );
    }
  }
});

test("official pnpm archive yields a complete canonical transitive inventory", () => {
  const lock = loadLock(join(repositoryRoot, "tooling/toolchain.lock.json"));
  const toolsRoot = join(repositoryRoot, ".tools");
  const artifact = lock.tools.pnpm;
  const prepared = prepareVerifiedPayload({
    name: "pnpm",
    platform: "shared",
    artifact,
    archive: join(toolsRoot, "downloads", artifact.archiveName),
    toolsRoot,
    missingCode: "TEST_ARCHIVE_MISSING",
  });
  try {
    assert.ok(Object.keys(prepared.inventory).length >= artifact.expectedFiles.length);
    for (const path of artifact.expectedFiles) {assert.equal(prepared.inventory[path].type, "file");}
    assert.equal(prepared.inventory["bin/pnpm.mjs"].type, "file");
    assert.equal(prepared.inventory["dist/pnpm.mjs"].type, "file");
    assert.ok(Object.keys(prepared.inventory).length > 400);
  } finally {
    rmSync(prepared.stageRoot, { recursive: true, force: true });
  }
});

test("tampered pnpm secondary entrypoint with forged provenance is rejected before execution", (context) => {
  const fixture = installFixture(context);
  const destination = join(fixture.toolsRoot, fixture.lock.tools.pnpm.installDirectory);
  const marker = join(fixture.root, "secondary-entrypoint-executed");
  const secondary = join(destination, "bin", "pnpm.mjs");
  writeFileSync(secondary, markerPayload(marker));
  chmodSync(secondary, 0o755);
  forgeInventoryProvenance(destination);

  const result = inspectPnpm(fixture);
  assert.deepEqual(result, { ok: false, code: "file-checksum:bin/pnpm.mjs", actualVersion: "unknown" });
  assert.equal(existsSync(marker), false);
});

test("tampered pnpm transitive payload preserving its version is rejected before execution", (context) => {
  const fixture = installFixture(context);
  const destination = join(fixture.toolsRoot, fixture.lock.tools.pnpm.installDirectory);
  const marker = join(fixture.root, "transitive-payload-executed");
  writeFileSync(join(destination, "dist", "pnpm.mjs"), markerPayload(marker));
  forgeInventoryProvenance(destination);

  const result = inspectPnpm(fixture);
  assert.equal(result.code, "file-checksum:dist/pnpm.mjs");
  assert.equal(existsSync(marker), false);
});

test("pnpm inspection rejects a forged pinned Node before trusting its self-reported version", (context) => {
  const fixture = installFixture(context);
  const nodeDestination = join(fixture.toolsRoot, "node-test-linux-x64");
  const marker = join(fixture.root, "forged-node-executed");
  const node = join(nodeDestination, "bin", "node");
  writeFileSync(node, `#!/bin/sh\nprintf executed > '${marker}'\necho 'v24.20.0'\n`);
  chmodSync(node, 0o755);
  forgeInventoryProvenance(nodeDestination);

  const result = inspectPnpm(fixture);
  assert.equal(result.code, "pinned-node-file-checksum:bin/node");
  assert.equal(existsSync(marker), false);
});

test("injected files, executable-mode drift and package-resolution symlinks fail closed", (context) => {
  const fixture = installFixture(context);
  const destination = join(fixture.toolsRoot, fixture.lock.tools.pnpm.installDirectory);
  const injected = join(destination, "dist", "injected.mjs");
  writeFileSync(injected, "process.stdout.write('11.24.0\\n');\n");
  forgeInventoryProvenance(destination);
  assert.equal(inspectPnpm(fixture).code, "entry-injected:dist/injected.mjs");

  rmSync(injected);
  const secondary = join(destination, "bin", "pnpm.mjs");
  chmodSync(secondary, 0o644);
  forgeInventoryProvenance(destination);
  assert.equal(inspectPnpm(fixture).code, "entry-mode:bin/pnpm.mjs");

  installArtifacts({ lock: fixture.lock, platform, toolsRoot: fixture.toolsRoot, offline: true });
  const transitive = join(destination, "dist", "pnpm.mjs");
  rmSync(transitive);
  symlinkSync("../bin/pnpm.mjs", transitive);
  forgeInventoryProvenance(destination);
  assert.equal(inspectPnpm(fixture).code, "entry-type:dist/pnpm.mjs");
});

test("complete-tree checks cover non-entrypoint Node and Foundry files", (context) => {
  const fixture = installFixture(context);
  const nodeMetadata = join(fixture.toolsRoot, "node-test-linux-x64", "lib", "runtime-metadata.json");
  writeFileSync(nodeMetadata, '{"runtime":"forged"}\n');
  assert.throws(
    () => verifyCache({ lock: fixture.lock, platform, toolsRoot: fixture.toolsRoot, offline: true }),
    /TOOLCHAIN_INSTALL_INVALID tool=node.*file-checksum:lib\/runtime-metadata\.json/u,
  );
  installArtifacts({ lock: fixture.lock, platform, toolsRoot: fixture.toolsRoot, offline: true });

  const foundryMetadata = join(fixture.toolsRoot, "foundry-test-linux-x64", "release-metadata.json");
  writeFileSync(foundryMetadata, '{"release":"forged"}\n');
  assert.throws(
    () => verifyCache({ lock: fixture.lock, platform, toolsRoot: fixture.toolsRoot, offline: true }),
    /TOOLCHAIN_INSTALL_INVALID tool=foundry.*file-checksum:release-metadata\.json/u,
  );
});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  registerToolchainAuthorityTests();
}
