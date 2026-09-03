import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { assertSerializedAgainstSchema } from "../src/adapters/json-schema.ts";
import { writeFailureEvidence } from "../src/adapters/evidence.ts";
import { makeTestDirectory } from "./test-directory.ts";
import { testPublication } from "./test-publication.ts";

const schemaDirectory = "tooling/security/slither";

test("duplicate keys are rejected before ordinary JSON parsing", async () => {
  const serialized = '{"schemaVersion":1,"schemaVersion":1,"findings":[]}\n';
  await assert.rejects(
    assertSerializedAgainstSchema(serialized, `${schemaDirectory}/triage-ledger.schema.v1.json`),
    /malformed JSON/u,
  );
});

test("date-time validates the exact UTC calendar value", async () => {
  const serialized = `${JSON.stringify({ schemaVersion: 1, findings: [{ schemaVersion: 1, fingerprint: `sha256:${"1".repeat(64)}`, owner: "security", disposition: "accepted-design", rationale: "A sufficiently long reviewed rationale.", reviewedAt: "2026-02-30T00:00:00.000Z" }] })}\n`;
  await assert.rejects(
    assertSerializedAgainstSchema(serialized, `${schemaDirectory}/triage-ledger.schema.v1.json`),
    /invalid date-time/u,
  );
});

test("cross-category failure mutations are impossible to publish", async () => {
  const parent = await makeTestDirectory("cross-category-");
  try {
    await assert.rejects(writeFailureEvidence({
      output: join(parent, "bundle"), candidateSha: "a".repeat(40), category: "tool-failure",
      exitCode: 30, stage: "artifact-parsing", errorCode: "MALFORMED_JSON",
      schemaDirectory, assertReadyPrecondition: async () => {}, publication: testPublication(),
    }), /exhaustive registry/u);
  } finally {await rm(parent, { recursive: true, force: true });}
});
