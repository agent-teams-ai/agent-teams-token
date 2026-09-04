import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";

import { observeConsumerDescriptors } from "./rollback-consumer-close-fixture.mjs";

export function installRuntimeFinalizationProbe(fixture, scenario) {
  const baseline = fs.readdirSync(join(fixture.root, ".tools")).toSorted();
  const primary = new Error(`ROLLBACK_RUNTIME_INJECTED_PRIMARY ${scenario}`);
  const proofFailure = scenario.startsWith("proof-");
  const readPath = scenario === "archive-read-close" ? fixture.archive
    : scenario === "provenance-read-close" ? fixture.provenance : fixture.executable;
  const observation = observeConsumerDescriptors({
    beforeRead(record) {
      if ((proofFailure || scenario.endsWith("read-close"))
        && record.path === readPath && record.occurrence === 1) { throw primary; }
    },
    beforeStat(record) {
      if (scenario === "loaded-stat-close" && record.requestedPath === "/proc/self/exe") {
        throw primary;
      }
    },
    closeTarget(record) {
      if (scenario === "prepared-archive-close") {
        return record.path === fixture.archive && record.occurrence === 2;
      }
      if (scenario.endsWith("root-close")) { return record.path === fixture.root && record.occurrence === 1; }
      if (scenario === "loaded-stat-close") { return record.requestedPath === "/proc/self/exe"; }
      return record.path === readPath && record.occurrence === 1;
    },
  });
  process.once("uncaughtException", (error) => {
    observation.restore();
    try {
      assert.ok(error instanceof AggregateError, error.stack);
      const expectedPrimary = proofFailure || scenario.endsWith("read-close") || scenario === "loaded-stat-close"
        ? primary : undefined;
      if (expectedPrimary !== undefined) { assert.equal(error.cause, primary); }
      assert.deepEqual(error.errors, expectedPrimary === undefined
        ? observation.state.closeErrors : [primary, ...observation.state.closeErrors]);
      assert.equal(observation.state.closeErrors.length, 1);
      observation.assertReleased();
      assert.deepEqual(fs.readdirSync(join(fixture.root, ".tools")).toSorted(), baseline,
        "prepared payload must be cleaned even after executable/root close failure");
      process.stdout.write(JSON.stringify({
        scenario,
        status: "expected-failure-verified",
        primaryPreserved: expectedPrimary !== undefined,
        observedDescriptors: observation.state.records.length,
        closeFailures: observation.state.closeErrors.length,
      }));
      process.exitCode = 0;
    } catch (assertionFailure) {
      process.stderr.write(assertionFailure.stack + "\n");
      process.exitCode = 1;
    } finally {
      observation.cleanupLeakedTestDescriptors();
    }
  });
}
