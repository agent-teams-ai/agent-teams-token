import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("doctor wiring verifies and executes through the archive-derived Node", () => {
  const dev = readFileSync(join(repositoryRoot, "dev"), "utf8");
  const bootstrap = readFileSync(join(repositoryRoot, "scripts/bootstrap.sh"), "utf8");
  assert.match(dev, /^#!\/bin\/bash/u);
  assert.match(dev, /exec "\$token_repo_root\/scripts\/bootstrap\.sh" doctor "\$@"/u);
  assert.doesNotMatch(dev, /exec node .*doctor/u);
  const doctorCase = bootstrap.slice(bootstrap.indexOf("  doctor)"), bootstrap.indexOf("  all)"));
  assert.ok(doctorCase.indexOf("toolchain.mjs\" verify --offline") < doctorCase.indexOf("doctor.mjs"));
  assert.equal([...doctorCase.matchAll(/"\$token_pinned_node"/gu)].length, 2);
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
