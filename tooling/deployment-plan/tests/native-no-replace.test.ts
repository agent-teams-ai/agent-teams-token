import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNativeNoReplaceCapability,
  isExecutableCustodySafe,
} from "../src/adapters/native-no-replace.ts";

const SAFE_EXECUTABLE = {
  isFile: true,
  uid: 501,
  nlink: 1,
  mode: 0o100755,
} as const;

test("compiler custody permits macOS root-owned multi-hardlink system executables", () => {
  assert.equal(isExecutableCustodySafe(
    { ...SAFE_EXECUTABLE, uid: 0, nlink: 3 },
    { expectedUid: 501, allowRootOwnedMultipleLinks: true },
  ), true);
  assert.equal(isExecutableCustodySafe(
    { ...SAFE_EXECUTABLE, uid: 0, nlink: 3, mode: 0o100775 },
    { expectedUid: 501, allowRootOwnedMultipleLinks: true },
  ), false);
});

test("compiler custody does not relax multi-hardlink policy for user-owned executables", () => {
  assert.equal(isExecutableCustodySafe(
    { ...SAFE_EXECUTABLE, nlink: 2 },
    { expectedUid: 501, allowRootOwnedMultipleLinks: true },
  ), false);
  assert.equal(isExecutableCustodySafe(
    { ...SAFE_EXECUTABLE, uid: 0, nlink: 2 },
    { expectedUid: 501, allowRootOwnedMultipleLinks: false },
  ), false);
});

test("native helper performs exclusive rename and fails closed on an occupied target", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "native-no-replace-test-")));
  const capability = await createNativeNoReplaceCapability();
  try {
    assert.match(capability.executableSha256, /^0x[0-9a-f]{64}$/u);
    assert.match(capability.compilerSha256, /^0x[0-9a-f]{64}$/u);
    const source = join(parent, "source");
    const target = join(parent, "target");
    await mkdir(source, { mode: 0o700 });
    await capability.rename(source, target);
    await writeFile(join(target, "owned"), "owned", { mode: 0o600 });

    const secondSource = join(parent, "second-source");
    await mkdir(secondSource, { mode: 0o700 });
    await assert.rejects(
      capability.rename(secondSource, target),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "EEXIST",
    );
    assert.equal(await readFile(join(target, "owned"), "utf8"), "owned");
    await writeFile(join(secondSource, "preserved"), "preserved", { mode: 0o600 });
    assert.equal(await readFile(join(secondSource, "preserved"), "utf8"), "preserved");
  } finally {
    await capability.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("native helper build is deterministic for one compiler identity", async () => {
  const first = await createNativeNoReplaceCapability();
  const second = await createNativeNoReplaceCapability();
  try {
    assert.equal(first.compilerSha256, second.compilerSha256);
    assert.equal(first.executableSha256, second.executableSha256);
  } finally {
    await first.close();
    await second.close();
  }
});
