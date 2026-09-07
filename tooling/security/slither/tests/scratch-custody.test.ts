import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, realpath, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalizeScratch, ScratchCustody } from "../src/adapters/scratch-custody.ts";
import { receiveOutput } from "../src/adapters/container-export.ts";
import { writeContainerReadableFile } from "../src/adapters/container-input.ts";

for (const replacement of ["root", "child", "unknown", "sealed"]) {
  test(`scratch custody: ${replacement} preserves authority and cleanup semantics`, async () => {
    const parent = await mkdtemp(join(await realpath(tmpdir()), "slither-custody-"));
    const root = join(parent, "scratch");
    await mkdir(root, { mode: 0o700 });
    const custody = await ScratchCustody.acquire(root);
    try {
      const child = join(root, "raw");
      await custody.directory(child, 0o700);
      await writeContainerReadableFile(join(child, "owned"), "owned", custody);
      await chmod(child, 0o555);
      if (replacement === "sealed") {
        // This deletion requires restoring owner write bits when the host is nonroot.
        await custody.cleanup();
        await assert.rejects(lstat(root), { code: "ENOENT" });
      } else {
        const replaced = replacement === "root" ? root : child;
        if (replacement !== "unknown") {
          await rename(replaced, `${replaced}-displaced`);
          await mkdir(replaced, { mode: 0o700 });
        } else { await chmod(child, 0o755); }
        const sentinel = join(replaced, "foreign");
        await writeFile(sentinel, "must survive");
        const before = await lstat(replaced);
        await assert.rejects(custody.cleanup(), { code: "TEMP_ROOT_INVALID" });
        assert.equal(await readFile(sentinel, "utf8"), "must survive");
        assert.equal((await lstat(replaced)).mode, before.mode);
      }
    } finally {
      // Test owns the displaced trees as well; production never follows them.
      for (const path of [join(root, "raw"), join(root, "raw-displaced"), join(`${root}-displaced`, "raw")]) {
        await chmod(path, 0o700).catch(() => {});
      }
      await rm(parent, { recursive: true, force: true });
    }
  });
}

for (const primary of [new Error("primary failure"), undefined]) {
  test(`scratch finalization retains primary rejection ${String(primary)}`, async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "slither-custody-errors-"));
    const custody = await ScratchCustody.acquire(root);
    try {
      await writeFile(join(root, "unknown"), "preserve");
      await assert.rejects(finalizeScratch(custody, [primary]), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.equal(error.errors[0], primary);
        assert.equal(error.errors[1].code, "TEMP_ROOT_INVALID");
        return true;
      });
      assert.equal(await readFile(join(root, "unknown"), "utf8"), "preserve");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("received analyzer files enter scratch inventory before sealed output cleanup", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "slither-custody-export-"));
  const custody = await ScratchCustody.acquire(root);
  const output = join(root, "raw");
  try {
    await custody.directory(output, 0o700);
    const frame = `SLITHER_EXPORT_V1\n${JSON.stringify([["slither.exit", 2, Buffer.from("0\n").toString("base64")]])}\nSLITHER_EXPORT_END\n`;
    await receiveOutput(frame, output, ["slither.exit"], true, { directoryPath: (_fd, path) => path, custody });
    await custody.chmod(output, 0o555);
    await custody.cleanup();
    await assert.rejects(readFile(join(output, "slither.exit")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a separately acquired successor descriptor cannot inherit owned identity", async () => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "slither-custody-handle-"));
  const root = join(parent, "owned");
  await mkdir(root);
  const custody = await ScratchCustody.acquire(root);
  try {
    const original = `${root}-original`;
    await rename(root, original);
    await mkdir(root);
    const successor = await open(root, "r");
    await rename(root, `${root}-successor`);
    await rename(original, root);
    try { await assert.rejects(custody.assertHandle(root, successor), { code: "TEMP_ROOT_INVALID" }); }
    finally { await successor.close(); }
    await custody.cleanup();
  } finally { await rm(parent, { recursive: true, force: true }); }
});
