import assert from "node:assert/strict";
import fs from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { fetchArtifacts, installArtifacts, verifyCache, inspectInstallation } from "../toolchain.mjs";
import { makeFixture } from "./toolchain-fixture.mjs";
import { observeConsumerDescriptors } from "./rollback-consumer-close-fixture.mjs";

function contains(error, expected) {
  return error === expected || error?.cause && contains(error.cause, expected)
    || error instanceof AggregateError && error.errors.some((entry) => contains(entry, expected));
}

export function registerInstallationFinalizationTests() {
  for (const scenario of ["install-new", "install-present", "verify-ok", "install-invalid", "verify-invalid"]) {
    test(`${scenario} preserves primary errors and withholds success until cleanup finishes`, (context) => {
      const fixture = makeFixture();
      context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
      const args = { ...fixture, platform: "linux-x64", offline: true };
      fetchArtifacts(args);
      if (["install-present", "verify-ok", "verify-invalid"].includes(scenario)) { installArtifacts(args); }
      if (scenario === "install-invalid") {
        fixture.lock.tools.node.platforms["linux-x64"].versionChecks[0].pattern = "^impossible-version$";
      }
      if (scenario === "verify-invalid") {
        fs.writeFileSync(join(fixture.toolsRoot, "node-test-linux-x64", "bin", "node"), "tampered");
      }
      const observation = observeConsumerDescriptors({
        closeTarget(record) { return record.identity.isDirectory() && basename(record.path).startsWith(".install-part-"); },
      });
      const write = process.stdout.write;
      const output = [];
      process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
      try {
        assert.throws(() => scenario.startsWith("verify") ? verifyCache(args) : installArtifacts(args), (error) => {
          assert.ok(error instanceof AggregateError);
          assert.ok(observation.state.closeErrors.length > 0);
          for (const closeError of observation.state.closeErrors) { assert.ok(contains(error, closeError)); }
          if (scenario === "install-invalid") { assert.match(error.cause.message, /version-mismatch/u); }
          if (scenario === "verify-invalid") { assert.match(error.cause.message, /TOOLCHAIN_INSTALL_INVALID/u); }
          return true;
        });
        assert.equal(output.join(""), "");
        observation.restore();
        observation.assertReleased();
      } finally {
        process.stdout.write = write;
        observation.restore();
        observation.cleanupLeakedTestDescriptors();
      }
    });
  }

  test("nested pnpm Node authority failures retain both cleanup failures and the failed inspection", (context) => {
    const fixture = makeFixture();
    context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const args = { ...fixture, platform: "linux-x64", offline: true };
    fetchArtifacts(args);
    installArtifacts(args);
    fs.writeFileSync(join(fixture.toolsRoot, "node-test-linux-x64", "bin", "node"), "tampered");
    const observation = observeConsumerDescriptors({
      closeTarget(record) { return record.identity.isDirectory() && basename(record.path).startsWith(".install-part-"); },
    });
    try {
      const tool = fixture.lock.tools.pnpm;
      assert.throws(() => inspectInstallation({ ...args, name: "pnpm", tool, artifact: tool,
        destination: join(fixture.toolsRoot, tool.installDirectory) }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.cause.message, /file-checksum:bin\/node/u);
        assert.ok(observation.state.closeErrors.length >= 2);
        for (const closeError of observation.state.closeErrors) { assert.ok(contains(error, closeError)); }
        return true;
      });
      observation.restore();
      observation.assertReleased();
    } finally { observation.restore(); observation.cleanupLeakedTestDescriptors(); }
  });
}
