import assert from "node:assert/strict";
import test from "node:test";
import { runCustodyCli } from "../src/composition/custody-cli.ts";

test("custody CLI requires an explicit operation, settings path and injected ports", async () => {
  await assert.rejects(runCustodyCli(["status"]), /CUSTODY_ARGUMENTS/);
  await assert.rejects(runCustodyCli(["status", "--settings", "settings.json"]), /CUSTODY_PORTS_REQUIRED/);
  await assert.rejects(runCustodyCli(["broadcast", "--settings", "settings.json"], { create: async () => { throw new Error("must not create ports"); } }), /CUSTODY_ARGUMENTS/);
});
