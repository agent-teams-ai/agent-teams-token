import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournalFile } from "../src/adapters/evm-journal-file.ts";
import type { EvmJournalRecord } from "../src/application/evm-journal.ts";

test("durable private journal survives reopen and excludes a second writer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agtmai-journal-test-"));
  try {
    const path = join(dir, "tx.json");
    const first = createJournalFile(path);
    const second = createJournalFile(path);
    const record = { schema: "agtmai-evm-journal-v1", phase: "signed" } as EvmJournalRecord;
    await assert.rejects(first.read(), /lock required/);
    await first.exclusive(async () => {
      assert.equal(await first.read(), null);
      await assert.rejects(second.exclusive(async () => {}), { code: "EEXIST" });
      await first.write(record);
      assert.deepEqual(await first.read(), record);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    });
    await second.exclusive(async () => { assert.deepEqual(await second.read(), record); });
    await assert.rejects(first.exclusive(async () => { throw new Error("operation failed"); }), /operation failed/);
    await second.exclusive(async () => {});
  } finally { await rm(dir, { recursive: true }); }
});

test("crash lock is preserved and never automatically stolen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agtmai-journal-test-"));
  try {
    const path = join(dir, "tx.json");
    await writeFile(`${path}.lock`, "historical uncertain operation", { mode: 0o600 });
    await assert.rejects(createJournalFile(path).exclusive(async () => assert.fail("must not run")), { code: "EEXIST" });
    await stat(`${path}.lock`);
  } finally { await rm(dir, { recursive: true }); }
});
