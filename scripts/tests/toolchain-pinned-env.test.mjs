import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fetchArtifacts, installArtifacts, runPnpm } from "../toolchain.mjs";
import { makeFixture } from "../toolchain-test-fixture.mjs";

function probeRunPnpmBinaryEnvironment(overrides = {}) {
  const fixture = makeFixture();
  const project = join(fixture.root, "pinned-env-probe");
  const keys = ["AGTMAI_ANVIL_BINARY", "AGTMAI_FORGE_BINARY", "AGTMAI_SOLC_BINARY"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
    installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), `${JSON.stringify({
      name: "pinned-env-probe",
      private: true,
      scripts: {
        probe: "printf '%s\\n' \"${AGTMAI_ANVIL_BINARY-unset}\" \"${AGTMAI_FORGE_BINARY-unset}\" \"${AGTMAI_SOLC_BINARY-unset}\" \"$HOME\" \"$COREPACK_ENABLE_DOWNLOAD_PROMPT\" \"$COREPACK_ENABLE_PROJECT_SPEC\" > binary-environment",
      },
    })}\n`);
    for (const key of keys) {
      if (overrides[key] === undefined) {delete process.env[key];}
      else {process.env[key] = overrides[key];}
    }
    assert.equal(runPnpm({
      lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot,
      args: ["--dir", project, "run", "probe"],
    }), 0);
    return {
      values: readFileSync(join(project, "binary-environment"), "utf8").trimEnd().split("\n"),
      expected: [
        join(fixture.toolsRoot, "foundry-test-linux-x64", "anvil"),
        join(fixture.toolsRoot, "foundry-test-linux-x64", "forge"),
        join(fixture.toolsRoot, "solc-test-linux-x64", "solc"),
      ],
    };
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {delete process.env[key];}
      else {process.env[key] = previous[key];}
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

export function registerPinnedEnvTests() {
  test("run-pnpm gives its child the exact authenticated Foundry and solc paths", () => {
    const { values, expected } = probeRunPnpmBinaryEnvironment();
    assert.deepEqual(values.slice(0, 3), expected);
    assert.match(values[3], /\/agtmai-toolchain-exec-[^/]+\/home$/u);
    assert.deepEqual(values.slice(4), ["0", "0"]);
  });

  test("run-pnpm rejects ambient Foundry and solc path overrides", () => {
    const malicious = "/attacker/unauthenticated";
    const { values, expected } = probeRunPnpmBinaryEnvironment({
      AGTMAI_ANVIL_BINARY: `${malicious}/anvil`,
      AGTMAI_FORGE_BINARY: `${malicious}/forge`,
      AGTMAI_SOLC_BINARY: `${malicious}/solc`,
    });
    assert.deepEqual(values.slice(0, 3), expected);
    assert.equal(values.some((value) => value.startsWith(malicious)), false);
  });
}
