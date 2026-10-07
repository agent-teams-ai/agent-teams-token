import assert from "node:assert/strict";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { descriptorRoot, executeVerifiedFile } from "../toolchain.mjs";
import { executeOpenedNode } from "../toolchain-execution.mjs";
import { assertDarwinDescriptorEntrypointIsSemanticallyWrong, assertDarwinMjsSnapshotEntrypointWorks, assertDarwinOriginalPathBehavior, assertPrivateInvocationRejectsAmbientConfig, assertTimedOutProcessGroupCannotWriteLate } from "../toolchain-test-fixture.mjs";
import { digest, writeExecutable } from "./toolchain-fixtures.mjs";
export function registerExecutionTests() {
test("verified execution fails closed when the pathname is replaced after hashing", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-exec-race-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "tool");
  const markerPath = join(root, "attacker-ran");
  writeExecutable(executable, "#!/bin/sh\necho verified\n");
  const expectedSha256 = digest(executable);
  assert.throws(() => executeVerifiedFile({
    path: executable,
    expectedSha256,
    beforeSpawn: () => {
      renameSync(executable, executable + ".verified");
      writeExecutable(executable, `#!/bin/sh\necho attacker > ${JSON.stringify(markerPath)}\n`);
    },
  }), /TOOLCHAIN_FILE_IDENTITY_CHANGED/);
  assert.equal(existsSync(markerPath), false);
});

test("descriptor execution rejects unsupported hosts", () => {
  assert.throws(() => descriptorRoot("win32"), /TOOLCHAIN_DESCRIPTOR_EXECUTION_UNSUPPORTED/);
});

test("Darwin executes native targets at verified original paths and snapshots pnpm data", assertDarwinOriginalPathBehavior);

test("Darwin dev-fd entrypoint loses pathname-sensitive pnpm output", {
  skip: process.platform === "darwin" ? false : `Darwin-only semantic check (host=${process.platform})`,
}, assertDarwinDescriptorEntrypointIsSemanticallyWrong);

test("Darwin authenticated mjs snapshot preserves pathname-sensitive pnpm output", assertDarwinMjsSnapshotEntrypointWorks);

test("private invocation environment behaviorally ignores ambient pnpm config poisoning", assertPrivateInvocationRejectsAmbientConfig);

test("generic opened Node execution does not inherit ambient Foundry paths", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-generic-node-env-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "probe.mjs");
  writeFileSync(script, "process.stdout.write([process.env.AGTMAI_ANVIL_BINARY, process.env.AGTMAI_FORGE_BINARY, process.env.AGTMAI_SOLC_BINARY].map((value) => value ?? 'unset').join(','));\n");
  const keys = ["AGTMAI_ANVIL_BINARY", "AGTMAI_FORGE_BINARY", "AGTMAI_SOLC_BINARY"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {process.env[key] = "/attacker/unauthenticated";}
    assert.equal(executeOpenedNode({
      node: { path: process.execPath, sha256: digest(process.execPath) },
      script: { path: script, sha256: digest(script) },
      args: [],
    }), "unset,unset,unset");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {delete process.env[key];}
      else {process.env[key] = previous[key];}
    }
  }
});

test("timeout kills a TERM-ignoring process group before its grandchild writes", assertTimedOutProcessGroupCannotWriteLate);

test("Linux verified execution retains proc descriptor execution", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-linux-exec-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "tool");
  writeExecutable(executable, "#!/bin/sh\nprintf '%s\\n' \"$0\"\n");
  if (process.platform !== "linux") {return;}
  assert.equal(executeVerifiedFile({
    path: executable,
    expectedSha256: digest(executable),
    platform: "linux",
  }), "/proc/self/fd/3");
  assert.equal(descriptorRoot("linux"), "/proc/self/fd");
});

}
