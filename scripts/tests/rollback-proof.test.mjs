const registeredRollbackSuites = await Promise.all([
  import("./rollback-ci-history.test.mjs"),
  import("./rollback-cleanup-safety.test.mjs"),
  import("./rollback-descriptor-teardown.test.mjs"),
  import("../rollback/test-support/proof-manifests.mjs"),
  import("../rollback/test-support/proof-replay.mjs"),
  import("../rollback/test-support/proof-custody.mjs"),
  import("../rollback/test-support/proof-portable-custody.mjs"),
  import("../rollback/test-support/proof-removal.mjs"),
  import("../rollback/test-support/proof-runtime.mjs"),
  import("../rollback/test-support/proof-gates.mjs"),
  import("../rollback/test-support/proof-contract.mjs"),
  import("../rollback/test-support/proof-wiring.mjs"),
]);

if (registeredRollbackSuites.length !== 12) {
  throw new Error("ROLLBACK_TEST_DISCOVERY_INCOMPLETE");
}
