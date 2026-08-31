import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { runDoctor } from "../doctor.mjs";
import { fetchArtifacts, installArtifacts } from "../toolchain.mjs";
import { provenanceFile } from "../toolchain-archive.mjs";
import { makeFixture, writeExecutable } from "./toolchain-fixture.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const platform = "linux-x64";

function createRootFixture(context, { realBootstrap = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agtmai-root-entrypoint-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const pinnedBin = join(root, ".tools", "bin");
  const hostileBin = join(root, "hostile-bin");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(pinnedBin, { recursive: true });
  mkdirSync(hostileBin);
  copyFileSync(join(repositoryRoot, "dev"), join(root, "dev"));
  if (realBootstrap) {
    copyFileSync(join(repositoryRoot, "scripts/bootstrap.sh"), join(scripts, "bootstrap.sh"));
    copyFileSync(join(repositoryRoot, "scripts/toolchain-cleanup.mjs"), join(scripts, "toolchain-cleanup.mjs"));
    mkdirSync(join(scripts, "rollback", "runtime"), { recursive: true });
    for (const name of ["cleanup.mjs", "cleanup-tree.mjs"]) {
      copyFileSync(
        join(repositoryRoot, "scripts", "rollback", "runtime", name),
        join(scripts, "rollback", "runtime", name),
      );
    }
  } else {
    writeExecutable(join(scripts, "bootstrap.sh"), bootstrapProbe());
  }
  writeExecutable(
    join(scripts, "env.sh"),
    "#!/bin/bash\nprintf 'env:\\n' >> \"$TOKEN_TEST_LOG\"\nreturn 0\n",
  );
  writeExecutable(join(pinnedBin, "pnpm"), markerCommand("pinned-pnpm"));
  for (const command of [
    "awk", "bash", "dirname", "docker", "mkdir", "node", "pnpm", "rm",
    "sha256sum", "solana-test-validator", "tar", "uname",
  ]) {
    writeExecutable(join(hostileBin, command), markerCommand(`hostile-${command}`));
  }
  return {
    root,
    log: join(root, "execution.log"),
    marker: join(root, "hostile.marker"),
    hostileBin,
  };
}

function bootstrapProbe() {
  return "#!/bin/bash\n"
    + "printf 'bootstrap:%s\\n' \"$*\" >> \"$TOKEN_TEST_LOG\"\n"
    + "exit \"${TOKEN_TEST_BOOTSTRAP_STATUS:-0}\"\n";
}

function markerCommand(label) {
  const contents = "#!/bin/bash\n"
    + `printf '${label}:%s\\n' "$*" >> "$TOKEN_TEST_LOG"\n`
    + (label.startsWith("hostile-") ? "printf marker >> \"$TOKEN_TEST_MARKER\"\n" : "")
    + "exit 0\n";
  return contents;
}

function runRoot(fixture, args, extraEnvironment = {}) {
  return spawnSync("/bin/bash", [join(fixture.root, "dev"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.hostileBin}:/usr/bin:/bin`,
      TOKEN_TEST_LOG: fixture.log,
      TOKEN_TEST_MARKER: fixture.marker,
      ...extraEnvironment,
    },
  });
}

function prepareBootstrapArchiveFixture(fixture, { snapshotAttack } = {}) {
  const host = bootstrapFixtureHost();
  const payloadRoot = join(fixture.root, "bootstrap-node-payload");
  const nodeDirectory = `node-test-${host.platform}`;
  const nodeBin = join(payloadRoot, nodeDirectory, "bin");
  mkdirSync(nodeBin, { recursive: true });
  writeExecutable(
    join(nodeBin, "node"),
    "#!/bin/bash\n"
      + "if [[ \"${1:-}\" == --version ]]; then printf '%s\\n' v24.20.0; exit 0; fi\n"
      + "if [[ \"${1:-}\" == *toolchain-cleanup.mjs ]]; then "
      + `exec '${process.execPath}' "$@"; fi\n`
      + "for token_test_fd in 7 8 9 10 11 12; do "
      + "if [[ -e /dev/fd/$token_test_fd ]]; then printf 'descriptor-open:%s\\n' \"$token_test_fd\" "
      + `>> '${fixture.log}'; exit 91; fi; done\n`
      + `printf 'descriptors-settled\\narchive-node:%s\\n' "$*" >> '${fixture.log}'\n`,
  );
  const downloads = join(fixture.root, ".tools", "downloads");
  mkdirSync(downloads, { recursive: true });
  const archiveName = `node-test-${host.platform}.${host.extension}`;
  const archive = join(downloads, archiveName);
  execFileSync("/usr/bin/tar", [host.createFlag, archive, "-C", payloadRoot, nodeDirectory]);
  const archiveSha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");

  const bootstrapPath = join(fixture.root, "scripts", "bootstrap.sh");
  let bootstrap = readFileSync(bootstrapPath, "utf8");
  const replacements = [
    [`token_node_archive=${host.productionArchive}`, `token_node_archive=${archiveName}`],
    [`token_node_directory=${host.productionDirectory}`, `token_node_directory=${nodeDirectory}`],
    [`token_node_sha256=${host.productionSha256}`, `token_node_sha256=${archiveSha256}`],
  ];
  for (const [before, after] of replacements) {
    assert.match(bootstrap, new RegExp(before.replaceAll(".", "\\."), "u"));
    bootstrap = bootstrap.replace(before, after);
  }
  let attackProbe;
  let attackRecord;
  if (snapshotAttack !== undefined) {
    attackProbe = join(fixture.root, "snapshot-attack-probe.mjs");
    attackRecord = join(fixture.root, "snapshot-attack-successor.txt");
    const sources = {
      hardlink: "import { linkSync, writeFileSync } from 'node:fs';\nconst successor = `${process.argv[2]}.hardlink`; linkSync(process.argv[2], successor); writeFileSync(process.argv[3], successor);\n",
      rename: "import { renameSync, writeFileSync } from 'node:fs';\nconst successor = `${process.argv[2]}.renamed`; renameSync(process.argv[2], successor); writeFileSync(process.argv[3], successor);\n",
      "same-second-mutation": "import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';\n"
        + "const path = process.argv[2]; const bytes = readFileSync(path); chmodSync(path, 0o600);\n"
        + "const fd = openSync(path, 'r+'); writeSync(fd, Buffer.from([bytes[0] ^ 255]), 0, 1, 0); fsyncSync(fd);\n"
        + "writeSync(fd, bytes, 0, bytes.length, 0); fsyncSync(fd); closeSync(fd); chmodSync(path, 0o400); writeFileSync(process.argv[3], path);\n",
    };
    assert.ok(sources[snapshotAttack], snapshotAttack);
    writeFileSync(attackProbe, sources[snapshotAttack]);
    bootstrap = bootstrap.replace(
      "  local token_snapshot_pre_unlink_fingerprint\n",
      `  "${process.execPath}" "${attackProbe}" "$token_snapshot_path" "${attackRecord}"\n`
        + "  local token_snapshot_pre_unlink_fingerprint\n",
    );
  }
  const snapshotLog = join(fixture.root, "snapshot-extraction.log");
  const descriptorProbe = join(fixture.root, "snapshot-descriptor-probe.mjs");
  writeFileSync(
    descriptorProbe,
    "import { appendFileSync, fstatSync } from 'node:fs';\n"
      + `appendFileSync(${JSON.stringify(snapshotLog)}, \`nlink=\${fstatSync(Number(process.argv[2])).nlink}\\n\`);\n`,
  );
  const tarProbe = join(fixture.root, "tar-descriptor-probe");
  writeExecutable(
    tarProbe,
    "#!/bin/bash\nset -euo pipefail\ntoken_test_archive=\n"
      + "for token_test_argument in \"$@\"; do case \"$token_test_argument\" in /dev/fd/*) token_test_archive=$token_test_argument ;; esac; done\n"
      + "[[ -n \"$token_test_archive\" ]]\n"
      + `"${process.execPath}" "${descriptorProbe}" "\${token_test_archive##*/}"\n`
      + "exec /usr/bin/tar \"$@\"\n",
  );
  bootstrap = bootstrap.replace(
    "/usr/bin/tar --no-same-owner --no-same-permissions",
    `"${tarProbe}" --no-same-owner --no-same-permissions`,
  );
  writeExecutable(bootstrapPath, bootstrap);
  return { archive, archiveSha256, attackProbe, attackRecord, snapshotLog };
}

function bootstrapFixtureHost() {
  if (process.platform === "linux" && process.arch === "x64") {
    return {
      platform: "linux-x64",
      extension: "tar.xz",
      createFlag: "-cJf",
      productionArchive: "node-v24.20.0-linux-x64.tar.xz",
      productionDirectory: "node-v24.20.0-linux-x64",
      productionSha256: "2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2",
    };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      platform: "darwin-arm64",
      extension: "tar.gz",
      createFlag: "-czf",
      productionArchive: "node-v24.20.0-darwin-arm64.tar.gz",
      productionDirectory: "node-v24.20.0-darwin-arm64",
      productionSha256: "40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8",
    };
  }
  throw new Error(`unsupported bootstrap fixture host ${process.platform}-${process.arch}`);
}

function installFixture(context) {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({
    lock: fixture.lock,
    platform,
    toolsRoot: fixture.toolsRoot,
    downloader: fixture.downloader,
  });
  installArtifacts({ lock: fixture.lock, platform, toolsRoot: fixture.toolsRoot, offline: true });
  return fixture;
}

function doctor(fixture) {
  const lines = [];
  const status = runDoctor({
    lock: fixture.lock,
    toolsRoot: fixture.toolsRoot,
    platformResolver: () => platform,
    packageVersionReader: (name) => fixture.lock.tools[
      name === "@agent-teams/engineering-foundation" ? "engineeringFoundation" : name
    ].version,
    environment: {},
    write: (line) => lines.push(line),
  });
  return { lines, status };
}

test("root help is inert even with a hostile PATH", (context) => {
  const fixture = createRootFixture(context);
  const result = runRoot(fixture, ["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: \.\/dev <command>/u);
  const basenameResult = spawnSync("/bin/bash", ["dev", "help"], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.hostileBin}:/usr/bin:/bin`,
      TOKEN_TEST_LOG: fixture.log,
      TOKEN_TEST_MARKER: fixture.marker,
    },
  });
  assert.equal(basenameResult.status, 0, basenameResult.stderr);
  assert.match(basenameResult.stdout, /Usage: \.\/dev <command>/u);
  assert.equal(existsSync(fixture.log), false);
  assert.equal(existsSync(fixture.marker), false);
});

test("root check verifies before env and executes only the absolute pinned wrapper", (context) => {
  const fixture = createRootFixture(context);
  const result = runRoot(fixture, ["check", "--sentinel"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(fixture.log, "utf8").trim().split("\n"), [
    "bootstrap:verify --offline",
    "env:",
    "pinned-pnpm:check --sentinel",
  ]);
  assert.equal(existsSync(fixture.marker), false);
});

test("every tool-executing root command stops on verification failure", (context) => {
  const fixture = createRootFixture(context);
  const cases = [
    [["doctor", "--scope=core"], "bootstrap:doctor --scope=core"],
    [["check"], "bootstrap:verify --offline"],
    [["evm-up"], "bootstrap:verify --offline"],
    [["evm-down"], "bootstrap:verify --offline"],
    [["solana"], "bootstrap:verify --offline --scope=solana"],
  ];
  for (const [args, expected] of cases) {
    rmSync(fixture.log, { force: true });
    const result = runRoot(fixture, args, { TOKEN_TEST_BOOTSTRAP_STATUS: "73" });
    assert.equal(result.status, 73, args[0]);
    assert.equal(readFileSync(fixture.log, "utf8").trim(), expected);
    assert.equal(existsSync(fixture.marker), false);
  }
});

test("bootstrap help is inert and direct doctor fails closed on missing archive authority", (context) => {
  const fixture = createRootFixture(context, { realBootstrap: true });
  const help = runRoot(fixture, ["bootstrap", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(existsSync(join(fixture.root, ".tools", "downloads")), false);
  const basenameHelp = spawnSync("/bin/bash", ["bootstrap.sh", "--help"], {
    cwd: join(fixture.root, "scripts"),
    encoding: "utf8",
    env: { ...process.env, PATH: `${fixture.hostileBin}:/usr/bin:/bin` },
  });
  assert.equal(basenameHelp.status, 0, basenameHelp.stderr);
  assert.equal(existsSync(join(fixture.root, ".tools", "downloads")), false);

  const result = runRoot(fixture, ["doctor"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TOOLCHAIN_OFFLINE_CACHE_MISS tool=node/u);
  assert.equal(existsSync(fixture.log), false);
  assert.equal(existsSync(fixture.marker), false);
});

test("real bootstrap fixture accepts matching held-descriptor and pathname identities", (context) => {
  const fixture = createRootFixture(context, { realBootstrap: true });
  const prepared = prepareBootstrapArchiveFixture(fixture);
  const result = runRoot(fixture, ["bootstrap", "install", "--offline"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(fixture.log, "utf8"), /archive-node:.*toolchain\.mjs install --offline/u);
  assert.match(readFileSync(fixture.log, "utf8"), /descriptors-settled/u);
  assert.equal(readFileSync(prepared.snapshotLog, "utf8"), "nlink=0\n");
  assert.equal(existsSync(fixture.marker), false);
});

for (const snapshotAttack of ["hardlink", "rename", "same-second-mutation"]) {
  test(`real bootstrap rejects snapshot ${snapshotAttack} before staged Node execution`, (context) => {
    const fixture = createRootFixture(context, { realBootstrap: true });
    const prepared = prepareBootstrapArchiveFixture(fixture, { snapshotAttack });
    const result = runRoot(fixture, ["bootstrap", "install", "--offline"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /TOOLCHAIN_ARCHIVE_SNAPSHOT_(?:SUBSTITUTED|UNSAFE)/u);
    assert.equal(existsSync(fixture.log), false, "the archive-derived interpreter must not execute");
    assert.equal(existsSync(fixture.marker), false);
    assert.equal(existsSync(readFileSync(prepared.attackRecord, "utf8")), true);
  });
}

test("doctor wiring verifies and executes through the archive-derived Node", () => {
  const dev = readFileSync(join(repositoryRoot, "dev"), "utf8");
  const bootstrap = readFileSync(join(repositoryRoot, "scripts/bootstrap.sh"), "utf8");
  assert.match(dev, /^#!\/bin\/bash/u);
  assert.match(dev, /exec "\$token_repo_root\/scripts\/bootstrap\.sh" doctor "\$@"/u);
  assert.doesNotMatch(dev, /exec node .*doctor/u);
  const doctorCase = bootstrap.slice(bootstrap.indexOf("  doctor)"), bootstrap.indexOf("  all)"));
  assert.ok(doctorCase.indexOf("toolchain.mjs\" verify --offline") < doctorCase.indexOf("doctor.mjs"));
  assert.equal([...doctorCase.matchAll(/token_run_node/gu)].length, 2);
  assert.match(bootstrap, /\/usr\/bin\/env -i/u);
  assert.match(bootstrap, /^#!\/bin\/bash/u);
  assert.match(bootstrap, /^PATH=\/usr\/bin:\/bin$/mu);
});

test("doctor runs package checks after Node and pnpm authority passes", (context) => {
  const fixture = installFixture(context);
  const result = doctor(fixture);
  assert.equal(result.status, 0);
  assert.match(result.lines.join("\n"), /PACKAGE_OK tool=pnpm expectedVersion=11\.24\.0/u);
  assert.doesNotMatch(result.lines.join("\n"), /PACKAGE_CHECKS_BLOCKED/u);
});

test("doctor never invokes a pnpm wrapper rejected by complete-tree inspection", (context) => {
  const fixture = installFixture(context);
  const marker = join(fixture.root, "rejected-pnpm-wrapper-executed");
  writeExecutable(
    join(fixture.toolsRoot, "bin", "pnpm"),
    `#!/bin/bash\nprintf executed > '${marker}'\nprintf '11.24.0\\n'\n`,
  );
  const result = doctor(fixture);
  assert.equal(result.status, 1);
  assert.match(result.lines.join("\n"), /TOOL_MISMATCH tool=pnpm .*wrapper-missing-or-tampered/u);
  assert.match(result.lines.join("\n"), /PACKAGE_CHECKS_BLOCKED rejected=pnpm/u);
  assert.equal(existsSync(marker), false);
});

test("doctor never invokes a Node binary rejected by complete-tree inspection", (context) => {
  const fixture = installFixture(context);
  const marker = join(fixture.root, "rejected-node-executed");
  writeExecutable(
    join(fixture.toolsRoot, "node-test-linux-x64", "bin", "node"),
    `#!/bin/bash\nprintf executed > '${marker}'\nprintf 'v24.20.0\\n'\n`,
  );
  const result = doctor(fixture);
  assert.equal(result.status, 1);
  assert.match(result.lines.join("\n"), /PACKAGE_CHECKS_BLOCKED rejected=node,pnpm/u);
  assert.equal(existsSync(marker), false);
});

test("invalid provenance and missing archive authority block package markers", (context) => {
  for (const authorityFailure of ["provenance", "archive"]) {
    const fixture = installFixture(context);
    const marker = join(fixture.root, `${authorityFailure}-marker-executed`);
    writeExecutable(
      join(fixture.toolsRoot, "bin", "pnpm"),
      `#!/bin/bash\nprintf executed > '${marker}'\nprintf '11.24.0\\n'\n`,
    );
    if (authorityFailure === "provenance") {
      const provenance = join(fixture.toolsRoot, "pnpm-test", provenanceFile);
      writeFileSync(provenance, '{"schemaVersion":1}\n');
    } else {
      rmSync(join(fixture.toolsRoot, "downloads", fixture.lock.tools.pnpm.archiveName));
    }
    const result = doctor(fixture);
    assert.equal(result.status, 1, authorityFailure);
    assert.match(result.lines.join("\n"), /PACKAGE_CHECKS_BLOCKED rejected=pnpm/u);
    assert.equal(existsSync(marker), false, authorityFailure);
  }
});
