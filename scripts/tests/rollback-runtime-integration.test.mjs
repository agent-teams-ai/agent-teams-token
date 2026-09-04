import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { invokePinnedRuntime, pinnedRuntimeFixture } from "../rollback/test-support/proof-fixture.mjs";

test("actual pinned Linux Node preserves failures and finalizes every runtime owner", (context) => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    context.skip("Linux x64 supplies the actual /proc/self/exe binding; Darwin must remain fail-closed");
    return;
  }
  // Reuse one real installation for all fault cases. Each public proof still
  // creates and disposes its own authenticated extraction custody.
  const fixture = pinnedRuntimeFixture();
  try {
    for (const scenario of [
      "root-close", "binary-close", "proof-root-close", "proof-binary-close",
      "archive-read-close", "provenance-read-close", "loaded-stat-close",
      "prepared-archive-close",
    ]) {
      const result = invokePinnedRuntime(fixture, {
        setup: `
          import { installRuntimeFinalizationProbe } from ${JSON.stringify(new URL("./rollback-runtime-probe-fixture.mjs", import.meta.url).href)};
          installRuntimeFinalizationProbe(${JSON.stringify({
            root: fixture.root,
            executable: fixture.executable,
            archive: fixture.archive,
            provenance: fixture.provenance,
          })}, ${JSON.stringify(scenario)});
        `,
      });
      assert.equal(result.status, 0, scenario + "\n" + result.stderr);
      const evidence = JSON.parse(result.stdout);
      assert.equal(evidence.scenario, scenario);
      assert.equal(evidence.status, "expected-failure-verified");
      assert.equal(evidence.closeFailures, 1);
      assert.ok(evidence.observedDescriptors > 0);
      context.diagnostic(JSON.stringify(evidence));
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
