import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Retained executable reproductions of f439's pathname-only finalizer.
test("original populated 0555 cleanup fails under an ordinary nonroot host", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "slither-baseline-mode-"));
  try {
    await mkdir(join(root, "raw"));
    await writeFile(join(root, "raw/output"), "output");
    await chmod(join(root, "raw"), 0o555);
    if (process.getuid?.() === 0) {
      // Root can bypass this defect; controller must run the nonroot-host gate.
      assert.equal((await readFile(join(root, "raw/output"))).toString(), "output");
    } else {
      await assert.rejects(rm(root, { recursive: true, force: true }), (error: NodeJS.ErrnoException) => error.code === "EACCES" || error.code === "EPERM");
      assert.equal(await readFile(join(root, "raw/output"), "utf8"), "output");
    }
  } finally { await chmod(join(root, "raw"), 0o700); await rm(root, { recursive: true, force: true }); }
});

test("original scratch pathname finalizer deletes a populated foreign successor", async () => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "slither-baseline-successor-"));
  const root = join(parent, "scratch");
  try {
    await mkdir(root);
    await writeFile(join(root, "owned"), "owned");
    await rename(root, `${root}-displaced`);
    await mkdir(root);
    await writeFile(join(root, "foreign"), "foreign");
    await rm(root, { recursive: true, force: true });
    await assert.rejects(readFile(join(root, "foreign")), { code: "ENOENT" });
    assert.equal(await readFile(join(`${root}-displaced`, "owned"), "utf8"), "owned");
  } finally { await rm(parent, { recursive: true, force: true }); }
});
