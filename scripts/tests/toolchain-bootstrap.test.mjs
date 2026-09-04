import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { digest, writeExecutable } from "./toolchain-fixtures.mjs";
const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
export function registerBootstrapTests() {
test("Bash bootstrap starts from checksum-pinned Node without a system Node fallback", () => {
  const bootstrap = readFileSync(join(repositoryRoot, "scripts/bootstrap.sh"), "utf8");
  assert.match(bootstrap, /node-v24\.20\.0-linux-x64\.tar\.xz/);
  assert.match(bootstrap, /2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2/);
  assert.match(bootstrap, /node-v24\.20\.0-darwin-arm64\.tar\.gz/);
  assert.match(bootstrap, /40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8/);
  assert.match(bootstrap, /\.part/);
  assert.match(bootstrap, /local token_part_fd=9[\s\S]*exec 9>/);
  assert.doesNotMatch(bootstrap, /exec \{token_part_fd\}/);
  assert.match(bootstrap, /--output - .*>&"\$token_part_fd"/);
  assert.doesNotMatch(bootstrap, /--output "?\$token_part/);
  assert.match(bootstrap, /token_run_node\(\)[\s\S]*token_pinned_node/);
  assert.match(bootstrap, /fetch --scope=solana/);
  assert.doesNotMatch(bootstrap, /foundry-v1\.8\.0-linux-x64:.*solc-v0\.8\.36-linux-x64/);
  assert.match(bootstrap, /\/usr\/bin\/tar --no-same-owner --no-same-permissions/u);
  assert.match(bootstrap, /exec 7<"\$token_archive_path"/u);
  assert.match(bootstrap, /exec 8<"\$token_archive_path"/u);
  assert.match(bootstrap, /exec 9<"\$token_archive_path"/u);
  assert.match(bootstrap, /exec 10<"\$token_snapshot_path"/u);
  assert.match(bootstrap, /exec 11<"\$token_snapshot_path"/u);
  assert.match(bootstrap, /exec 12<"\$token_snapshot_path"/u);
  assert.match(bootstrap, /token_descriptor_fingerprint\(\)/u);
  assert.match(bootstrap, /%d\|%i\|%p\|%u\|%g\|%z\|%Fm\|%Fc\|%l/u);
  assert.match(bootstrap, /%d\|%i\|%f\|%u\|%g\|%s\|%y\|%z\|%h/u);
  assert.match(bootstrap, /token_path_fingerprint\(\)/u);
  assert.doesNotMatch(bootstrap, /\/dev\/fd\/[789] -ef|-ef \/dev\/fd\/[789]/u);
  assert.doesNotMatch(bootstrap, /stat -f '%d\|%i' -/u);
  assert.match(bootstrap, /\/bin\/dd if=\/dev\/fd\/8 of="\$token_snapshot_path"/u);
  assert.doesNotMatch(bootstrap, /\/bin\/cp \/dev\/fd\//u);
  assert.match(bootstrap, /token_snapshot_sha256=\$\(token_sha256 \/dev\/fd\/10\)/u);
  assert.match(bootstrap, /token_post_extract_snapshot_sha256=\$\(token_sha256 \/dev\/fd\/12\)/u);
  assert.match(bootstrap, /"\$token_node_tar_flag" \/dev\/fd\/11/u);
  assert.match(bootstrap, /token_sha256 \/dev\/fd\/7/u);
  assert.doesNotMatch(bootstrap, /"\$token_node_tar_flag" "\$token_archive_path"/u);
  assert.match(bootstrap, /token_assert_private_snapshot_fingerprint[\s\S]*"\$token_archive_size" 0/u);
  assert.match(bootstrap, /token_run_node "\$token_repo_root\/scripts\/toolchain\.mjs"/u);
  assert.match(bootstrap, /archive\.snapshot/u);
  assert.match(bootstrap, /toolchain-cleanup\.mjs/u);
  assert.doesNotMatch(bootstrap, /rm -rf/u);
  assert.doesNotMatch(bootstrap, /TOKEN_BOOTSTRAP_NODE|\$\{[^}]+:-node\}/);
  assert.ok(bootstrap.indexOf("token_validate_directory \"$token_tools_root\" false") < bootstrap.indexOf("/bin/mkdir -p \"$token_tools_root\""));
  const dev = readFileSync(join(repositoryRoot, "dev"), "utf8");
  assert.doesNotMatch(dev, /exec (?:node|pnpm)|source .*env\.sh/);
  assert.doesNotMatch(bootstrap, /\/bin\/(?:chmod|mkdir|cp|mv|rm)[^\n]* --/);
  assert.doesNotMatch(bootstrap, /dirname --/);
  assert.match(dev, /bootstrap\.sh" doctor/);
  assert.match(dev, /bootstrap\.sh" run-pnpm check/);
});

test("bootstrap rejects a missing Node cache before a hostile PATH binary runs", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-bootstrap-path-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const hostile = join(root, "hostile");
  const markerPath = join(root, "ambient-node-ran");
  mkdirSync(scripts);
  mkdirSync(hostile);
  copyFileSync(join(repositoryRoot, "scripts/bootstrap.sh"), join(scripts, "bootstrap.sh"));
  writeExecutable(join(hostile, "node"), `#!/bin/sh\necho ran > ${JSON.stringify(markerPath)}\n`);
  const result = spawnSync("/bin/bash", [join(scripts, "bootstrap.sh"), "doctor"], {
    encoding: "utf8",
    env: { PATH: hostile },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TOOLCHAIN_OFFLINE_CACHE_MISS/);
  assert.equal(existsSync(markerPath), false);
});

test("Bash download keeps the exclusive part descriptor across a pathname replacement race", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-bootstrap-race-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const payloadRoot = join(root, "payload");
  const nodeDirectory = "node-v24.20.0-linux-x64";
  const nodeBin = join(payloadRoot, nodeDirectory, "bin");
  const archive = join(root, "node-test.tar.gz");
  const archiveName = "node-test.tar.gz";
  const victim = join(root, "victim");
  const part = join(root, ".tools", "downloads", archiveName + ".part");
  const curl = join(root, "race-curl");
  mkdirSync(scripts);
  mkdirSync(nodeBin, { recursive: true });
  copyFileSync(join(repositoryRoot, "scripts/bootstrap.sh"), join(scripts, "bootstrap.sh"));
  writeExecutable(join(nodeBin, "node"), "#!/bin/sh\n[ \"${1:-}\" = --version ] && echo v24.20.0\n");
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", payloadRoot, nodeDirectory]);
  writeFileSync(victim, "victim-safe");
  writeExecutable(curl, `#!/bin/sh\n/bin/rm -f ${JSON.stringify(part)}\n/bin/ln -s ${JSON.stringify(victim)} ${JSON.stringify(part)}\n/bin/cat ${JSON.stringify(archive)}\n`);
  const result = spawnSync("/bin/bash", [join(scripts, "bootstrap.sh"), "fetch"], {
    encoding: "utf8",
    env: {
      PATH: "/hostile",
      TOKEN_BOOTSTRAP_TEST_MODE: "1",
      TOKEN_BOOTSTRAP_TEST_NODE_ARCHIVE: archiveName,
      TOKEN_BOOTSTRAP_TEST_NODE_DIRECTORY: nodeDirectory,
      TOKEN_BOOTSTRAP_TEST_NODE_URL: "https://fixtures.invalid/node-test.tar.gz",
      TOKEN_BOOTSTRAP_TEST_NODE_SHA256: digest(archive),
      TOKEN_BOOTSTRAP_TEST_NODE_TAR_FLAG: "-xzf",
      TOKEN_BOOTSTRAP_TEST_CURL: curl,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TOOLCHAIN_FETCH_PART_UNSTABLE/);
  assert.equal(readFileSync(victim, "utf8"), "victim-safe");
});

test("environment helper requires Bash and runs Zsh portability where required or available", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-env-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const bin = join(root, ".tools", "bin");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
  const pinnedDirectories = {
    [join(root, ".tools", `node-v24.20.0-${platform}`, "bin")]: ["node"],
    [join(root, ".tools", `foundry-v1.8.0-${platform}`)]: ["forge", "cast", "anvil", "chisel"],
    [join(root, ".tools", `solc-v0.8.36-${platform}`)]: ["solc"],
    [join(root, ".tools", `agave-v4.2.1-${platform}`, "bin")]: ["solana", "solana-keygen", "solana-test-validator", "spl-token"],
  };
  for (const [directory, commands] of Object.entries(pinnedDirectories)) {
    mkdirSync(directory, { recursive: true });
    for (const command of commands) { writeExecutable(join(directory, command), "#!/bin/sh\nexit 0\n"); }
  }
  writeExecutable(join(bin, "pnpm"), "#!/bin/sh\nexit 0\n");
  copyFileSync(join(repositoryRoot, "scripts/env.sh"), join(scripts, "env.sh"));
  const probe = join(bin, "agtmai-env-probe");
  writeExecutable(probe, "#!/bin/sh\nexit 0\n");
  const canonicalProbe = realpathSync(probe);
  assert.equal(existsSync("/bin/bash"), true, "Bash is a required portability dependency");
  const shells = ["/bin/bash"];
  const zsh = ["/bin/zsh", "/usr/bin/zsh"].find(existsSync);
  if (process.platform === "darwin") {
    assert.ok(zsh, "Zsh is required on darwin");
  } else if (!zsh) {
    process.stdout.write("PORTABILITY_ZSH_NOT_INSTALLED platform=linux result=explicit-not-run\n");
  }
  if (zsh) {shells.push(zsh);}
  for (const shell of shells) {
    const result = spawnSync(shell, ["-c", `source '${join(scripts, "env.sh")}' && command -v agtmai-env-probe`], { encoding: "utf8" });
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), canonicalProbe);
  }
});
}
