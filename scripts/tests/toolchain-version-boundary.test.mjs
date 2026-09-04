import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fetchArtifacts, installArtifacts, inspectInstallation } from "../toolchain.mjs";
import { makeFixture } from "./toolchain-fixture.mjs";

export function registerVersionBoundaryTests() {
  test("pnpm store creation tolerates a concurrent winner only after full authority validation", (context) => {
    const fixture = makeFixture();
    context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
    const args = { ...fixture, platform, offline: true };
    fetchArtifacts(args);
    installArtifacts(args);
    const bin = join(fixture.toolsRoot, "bin");
    const wrapperPath = join(bin, "pnpm");
    const wrapper = fs.readFileSync(wrapperPath, "utf8");
    const store = join(fixture.toolsRoot, "pnpm-store");
    const marker = join(fixture.root, "store-authorized");
    // Stop at the handoff to Node: this regression exercises the shell store
    // admission boundary, while separate tests authenticate both wrappers.
    fs.writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf authorized > '${marker}'\n`, { mode: 0o755 });
    for (const competitor of ["private-directory", "writable-directory", "symlink", "absent"]) {
      fs.rmSync(store, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
      const creation = competitor === "symlink"
        ? `/bin/ln -s '${fixture.root}' "$token_pnpm_store"`
        : competitor === "absent" ? ":"
          : `/bin/mkdir -m ${competitor === "private-directory" ? "700" : "777"} "$token_pnpm_store"`;
      // Deterministically interpose a competing creation after the absence
      // check, then return the mkdir failure the losing invocation observes.
      const raced = wrapper.replace('/bin/mkdir -m 700 "$token_pnpm_store"', `{ ${creation}; false; }`);
      assert.notEqual(raced, wrapper);
      if (competitor === "private-directory") {
        const beforeFix = raced.replace(' || [[ -d "$token_pnpm_store" ]]', "");
        assert.notEqual(beforeFix, raced);
        fs.writeFileSync(wrapperPath, beforeFix);
        assert.equal(spawnSync(wrapperPath, ["--version"]).status, 1);
        assert.equal(fs.existsSync(marker), false);
        fs.rmSync(store, { recursive: true });
      }
      fs.writeFileSync(wrapperPath, raced);
      const result = spawnSync(wrapperPath, ["--version"], { encoding: "utf8" });
      assert.equal(result.status, competitor === "private-directory" ? 0 : 1, result.stderr);
      assert.equal(fs.existsSync(marker), competitor === "private-directory");
    }
  });

  test("direct Node wrapper rejects injected PATH entries and forged pnpm wrapper bytes", (context) => {
    const fixture = makeFixture();
    context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
    const args = { ...fixture, platform, offline: true };
    fetchArtifacts(args);
    installArtifacts(args);
    const bin = join(fixture.toolsRoot, "bin");
    const wrapper = fs.readFileSync(join(bin, "node"), "utf8");
    assert.ok(wrapper.includes('token_node_private_root=$(/usr/bin/mktemp -d /tmp/agtmai-node-environment.XXXXXX)\ntoken_node_private_root=$(CDPATH= cd -- "$token_node_private_root" && pwd -P)'));
    const tempProbe = spawnSync(join(bin, "node"), ["--eval",
      "process.stdout.write(JSON.stringify([process.env.TMPDIR, require('node:fs').realpathSync(process.env.TMPDIR)]))"],
    { encoding: "utf8" });
    assert.equal(tempProbe.status, 0, tempProbe.stderr);
    const [temporary, canonical] = JSON.parse(tempProbe.stdout);
    assert.equal(temporary, canonical, "fresh wrapper temp root uses physical spelling, including Darwin /tmp");
    const pathProbe = spawnSync(join(bin, "node"), ["--eval", "process.stdout.write(process.env.PATH)"], { encoding: "utf8" });
    assert.equal(pathProbe.status, 0, pathProbe.stderr);
    assert.deepEqual(pathProbe.stdout.split(":"), [bin, "/usr/bin", "/bin", "/usr/lib/git-core"]);
    const marker = join(fixture.root, "unsafe-path-command-ran");
    for (const name of ["injected-command", "pnpm"]) {
      const command = join(bin, name);
      fs.writeFileSync(command, `#!/bin/sh\nprintf unsafe > '${marker}'\n`, { mode: 0o755 });
      const result = spawnSync(join(bin, "node"), ["--eval",
        `require('node:child_process').spawnSync(${JSON.stringify(name)})`], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /TOOLCHAIN_WRAPPER_DIRECTORY_UNAUTHENTICATED/u);
      assert.equal(fs.existsSync(marker), false);
      if (name === "injected-command") { fs.unlinkSync(command); }
    }
  });

  for (const target of ["solc", "node", "pnpm"]) {
    test(`${target} version check rejects bytes changed after tree inspection at the execution open`, (context) => {
      const fixture = makeFixture();
      context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
      const args = { ...fixture, platform: "linux-x64", offline: true };
      fetchArtifacts(args);
      installArtifacts(args);
      const name = target === "solc" ? "solc" : "pnpm";
      const tool = fixture.lock.tools[name];
      const artifact = name === "pnpm" ? tool : tool.platforms[args.platform];
      const path = target === "solc" ? join(fixture.toolsRoot, "solc-test-linux-x64", "solc")
        : target === "node" ? join(fixture.toolsRoot, "node-test-linux-x64", "bin", "node")
          : join(fixture.toolsRoot, "pnpm-test", "dist", "pnpm.mjs");
      const marker = join(fixture.root, "unsafe-version-ran");
      const open = fs.openSync;
      let attacked = false;
      fs.openSync = (openedPath, flags, ...rest) => {
        if (!attacked && openedPath === path && typeof flags === "number" && (flags & fs.constants.O_NOFOLLOW)) {
          attacked = true;
          fs.writeFileSync(path, target === "pnpm"
            ? `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe');\n`
            : `#!/bin/sh\nprintf unsafe > '${marker}'\n`);
        }
        return open(openedPath, flags, ...rest);
      };
      syncBuiltinESMExports();
      try {
        const result = inspectInstallation({ ...args, name, tool, artifact,
          destination: join(fixture.toolsRoot, artifact.installDirectory) });
        assert.equal(attacked, true);
        assert.equal(result.ok, false);
        assert.equal(result.code, "version-command");
        assert.match(result.actualVersion, /TOOLCHAIN_EXECUTABLE_CHECKSUM/u);
        assert.equal(fs.existsSync(marker), false);
      } finally { fs.openSync = open; syncBuiltinESMExports(); }
    });
  }
}
