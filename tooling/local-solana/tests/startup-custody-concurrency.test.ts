import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, realpath, rm, unlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordStartupStage, reserveStartupCustody, startupCustodySettled, updateStartupCustody } from "../src/adapters/startup-custody.ts";

test("a registered write cannot overwrite stopping or settled custody", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agtmai-startup-race-")));
  const marker = join(directory, ".agtmai-validator-startup.json");
  const originalOpen = fs.open;
  let releaseWrite: (() => void) | undefined;
  let enteredWrite: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { enteredWrite = resolve; });
  const release = new Promise<void>((resolve) => { releaseWrite = resolve; });
  try {
    await mkdir(join(directory, "ledger"));
    const custody = await reserveStartupCustody(join(directory, "ledger"), "a".repeat(64));
    await updateStartupCustody(custody, false);
    let pause = true;
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === marker && pause) {
        pause = false;
        const truncate = handle.truncate.bind(handle);
        handle.truncate = async (size?: number) => {
          enteredWrite?.();
          await release;
          return await truncate(size);
        };
      }
      return handle;
    }) as typeof fs.open;
    syncBuiltinESMExports();
    const registered = recordStartupStage(custody, "registered");
    await entered;
    const stopping = recordStartupStage(custody, "stopping");
    const settled = updateStartupCustody(custody, true);
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    releaseWrite?.();
    await Promise.all([registered, stopping, settled]);
    const record = JSON.parse(await readFile(marker, "utf8")) as { settled: boolean; diagnostic: { stage: string } };
    assert.equal(record.settled, true);
    assert.equal(record.diagnostic.stage, "settled");
  } finally {
    releaseWrite?.();
    fs.open = originalOpen;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing startup marker cannot invoke legacy fallback while a pending guard exists", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agtmai-startup-missing-")));
  try {
    await mkdir(join(directory, "ledger"));
    const token = "c".repeat(64);
    await reserveStartupCustody(join(directory, "ledger"), token);
    await unlink(join(directory, ".agtmai-validator-startup.json"));
    assert.equal(await startupCustodySettled(directory, token, true), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed settlement sync retains durable uncertainty even when marker bytes say settled", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agtmai-startup-sync-fail-")));
  const marker = join(directory, ".agtmai-validator-startup.json");
  const originalOpen = fs.open;
  try {
    await mkdir(join(directory, "ledger"));
    const token = "b".repeat(64);
    const custody = await reserveStartupCustody(join(directory, "ledger"), token);
    await updateStartupCustody(custody, false);
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === marker) {
        const write = handle.write.bind(handle);
        const sync = handle.sync.bind(handle);
        let settlementWritten = false;
        handle.write = ((...values: Parameters<typeof write>) => {
          if (Buffer.isBuffer(values[0]) && values[0].toString("utf8").includes('"stage":"settled"')) { settlementWritten = true; }
          return write(...values);
        }) as typeof handle.write;
        handle.sync = async () => {
          if (settlementWritten) { throw Object.assign(new Error("injected sync failure"), { code: "ENOSPC" }); }
          return await sync();
        };
      }
      return handle;
    }) as typeof fs.open;
    syncBuiltinESMExports();
    await assert.rejects(updateStartupCustody(custody, true), { code: "ENOSPC" });
    assert.equal(await startupCustodySettled(directory, token), false);
    await assert.rejects(reserveStartupCustody(join(directory, "ledger"), token), /SOLANA_STARTUP_CUSTODY|EEXIST/u);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});
