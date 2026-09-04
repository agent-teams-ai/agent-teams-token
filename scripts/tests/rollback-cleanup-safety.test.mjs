const registeredCleanupSuites = await Promise.all([
  import("../rollback/test-support/cleanup-cases.mjs"),
  import("../rollback/test-support/cleanup-substitution-cases.mjs"),
]);

if (registeredCleanupSuites.length !== 2) {
  throw new Error("ROLLBACK_CLEANUP_TEST_DISCOVERY_INCOMPLETE");
}
