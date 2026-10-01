import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createJournalFile } from "../src/adapters/evm-journal-file.ts";
import type { EvmJournalRecord } from "../src/application/evm-journal.ts";

test("writerless private FIFO is rejected promptly and releases the journal lock", {
  skip: process.platform === "win32",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agtmai-journal-fifo-test-"));
  const run = promisify(execFile);
  try {
    const path = join(dir, "tx.json");
    await run("mkfifo", ["-m", "600", path], { timeout: 5_000, killSignal: "SIGKILL" });
    const fifo = await stat(path);
    assert.equal(fifo.isFIFO(), true);
    assert.equal(fifo.mode & 0o777, 0o600);
    // Isolate the open: the old blocking reader must be killed externally, since
    // an in-process timeout cannot cancel its pending filesystem operation.
    await run(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { stat } from "node:fs/promises";
      const { createJournalFile } = await import(process.argv[1]);
      const path = process.argv[2];
      const store = createJournalFile(path);
      await assert.rejects(store.exclusive(() => store.read()), /private regular file/);
      await assert.rejects(stat(path + ".lock"), { code: "ENOENT" });
      await store.exclusive(async () => {});
      await createJournalFile(path).exclusive(async () => {});
    `, new URL("../src/adapters/evm-journal-file.ts", import.meta.url).href, path], {
      timeout: 5_000, killSignal: "SIGKILL",
    });
    assert.equal((await stat(path)).isFIFO(), true);
    await assert.rejects(stat(`${path}.lock`), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

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


test("existing null or primitive journal never means an absent transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agtmai-journal-test-"));
  try {
    const path = join(dir, "tx.json");
    for (const corrupt of ["null", "false", "0", '""', "[]"]) {
      await writeFile(path, corrupt, { mode: 0o600 });
      const store = createJournalFile(path);
      await assert.rejects(store.exclusive(() => store.read()), /malformed/);
    }
  } finally { await rm(dir, { recursive: true }); }
});
