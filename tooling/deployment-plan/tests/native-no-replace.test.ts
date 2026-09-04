import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm,
  symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertNativeNoReplacePlatform,
  createNativeNoReplaceCapability,
  isExecutableCustodySafe,
  nativeCompilerExecutionStrategy,
} from "../src/adapters/native-no-replace.ts";
import type { NoReplaceRenameRequest } from "../src/adapters/safe-output.ts";

const SAFE_EXECUTABLE = {
  isFile: true, uid: 501, nlink: 1, mode: 0o100755,
} as const;
const NATIVE_SOURCE = fileURLToPath(new URL("../native/no-replace.c", import.meta.url));

test("compiler custody permits only policy-approved executable identities", () => {
  assert.equal(isExecutableCustodySafe(
    { ...SAFE_EXECUTABLE, uid: 0, nlink: 3 },
    { expectedUid: 501, allowRootOwnedMultipleLinks: true },
  ), true);
  assert.equal(isExecutableCustodySafe(
    { ...SAFE_EXECUTABLE, uid: 0, nlink: 3 },
    { expectedUid: 501, allowRootOwnedMultipleLinks: false },
  ), false);
  assert.equal(isExecutableCustodySafe(
    { ...SAFE_EXECUTABLE, uid: 0, nlink: 3, mode: 0o100775 },
    { expectedUid: 501, allowRootOwnedMultipleLinks: true },
  ), false);
  assert.equal(isExecutableCustodySafe(
    { ...SAFE_EXECUTABLE, nlink: 2 },
    { expectedUid: 501, allowRootOwnedMultipleLinks: true },
  ), false);
});

test("unsupported platforms fail closed", () => {
  assert.throws(() => assertNativeNoReplacePlatform("win32"), /only Linux and macOS/u);
});

test("platform strategy snapshots only Linux compilers and keeps Darwin on verified paths", () => {
  assert.equal(nativeCompilerExecutionStrategy("linux"), "snapshot-fd");
  assert.equal(nativeCompilerExecutionStrategy("darwin"), "verified-path");
});

test("verified-path compiler fallback rejects a user-owned original path", async () => {
  const compiler = join(await canonicalTemporaryDirectory(), "cc");
  const previous = process.env.AGTMAI_CC_BINARY;
  await writeFile(compiler, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
  process.env.AGTMAI_CC_BINARY = compiler;
  try {
    await assert.rejects(createNativeNoReplaceCapability(), /root-owned and non-writable/u);
  } finally {
    if (previous === undefined) { delete process.env.AGTMAI_CC_BINARY; }
    else { process.env.AGTMAI_CC_BINARY = previous; }
    await rm(dirname(compiler), { recursive: true, force: true });
  }
});

test("Darwin verified-path compiler retains its acquisition custody policy", {
  skip: process.platform !== "darwin",
}, async () => {
  const capability = await createNativeNoReplaceCapability();
  try {
    assert.match(capability.compilerSha256, /^0x[0-9a-f]{64}$/u);
    assert.match(capability.executableSha256, /^0x[0-9a-f]{64}$/u);
  } finally {
    await capability.close();
    await rm(capability.custodyPath, { recursive: true, force: true });
  }
});

test("native helper uses held parents and source identity for exclusive rename", async () => {
  const root = await canonicalTemporaryDirectory();
  const parent = join(root, "parent");
  const heldParentPath = join(root, "held-parent");
  await mkdir(parent, { mode: 0o700 });
  const source = join(parent, "source");
  await mkdir(source, { mode: 0o700 });
  const parentHandle = await openDirectory(parent);
  const sourceHandle = await openDirectory(source);
  const capability = await createNativeNoReplaceCapability();
  try {
    await rename(parent, heldParentPath);
    await mkdir(parent, { mode: 0o700 });
    await capability.rename(renameRequest(parentHandle, sourceHandle, "source", "target"));
    await writeFile(join(heldParentPath, "target", "owned"), "owned", { mode: 0o600 });
    await assert.rejects(readFile(join(parent, "target", "owned")));

    const second = join(heldParentPath, "second");
    await mkdir(second, { mode: 0o700 });
    const secondHandle = await openDirectory(second);
    try {
      await assert.rejects(
        capability.rename(renameRequest(parentHandle, secondHandle, "second", "target")),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "EEXIST",
      );
    } finally { await secondHandle.close(); }
    assert.equal(await readFile(join(heldParentPath, "target", "owned"), "utf8"), "owned");
  } finally {
    await Promise.all([parentHandle.close(), sourceHandle.close(), capability.close()]);
    await rm(capability.custodyPath, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("native ABI rejects malformed leaves, symlinks, and regular-file hardlinks", async () => {
  const parent = await canonicalTemporaryDirectory();
  const source = join(parent, "source");
  await writeFile(source, "owned", { mode: 0o600 });
  const parentHandle = await openDirectory(parent);
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const capability = await createNativeNoReplaceCapability();
  try {
    for (const leaf of ["", ".", "..", "a/b", "x".repeat(256)]) {
      await assert.rejects(
        capability.rename(renameRequest(parentHandle, sourceHandle, leaf, "target")),
        /valid single-component leaf/u,
      );
    }
    await symlink("source", join(parent, "alias"));
    await assert.rejects(
      capability.rename(renameRequest(parentHandle, sourceHandle, "alias", "target")),
      /source leaf does not name the held object/u,
    );
    await rm(join(parent, "alias"));
    await link(source, join(parent, "hardlink"));
    await assert.rejects(
      capability.rename(renameRequest(parentHandle, sourceHandle, "source", "target")),
      /invalid inherited descriptors/u,
    );
    assert.equal(await readFile(source, "utf8"), "owned");
  } finally {
    await Promise.all([parentHandle.close(), sourceHandle.close(), capability.close()]);
    await rm(capability.custodyPath, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("compiler consumes pinned source bytes from stdin after pathname replacement", async () => {
  const displaced = `${NATIVE_SOURCE}.held-test`;
  let capability: Awaited<ReturnType<typeof createNativeNoReplaceCapability>> | undefined;
  try {
    capability = await createNativeNoReplaceCapability({
      async afterSourceRead(source) {
        await rename(source, displaced);
        await writeFile(source, "this is not valid C\n", { mode: 0o600 });
      },
    });
    assert.match(capability.executableSha256, /^0x[0-9a-f]{64}$/u);
  } finally {
    if (capability !== undefined) {
      await capability.close();
      await rm(capability.custodyPath, { recursive: true, force: true });
    }
    await rm(NATIVE_SOURCE, { force: true });
    await rename(displaced, NATIVE_SOURCE);
  }
});

test("Linux compiler execution remains bound after the trusted original pathname is replaced", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, async () => {
  const compiler = join(dirname(NATIVE_SOURCE), `.replace-cc-${String(process.pid)}`);
  const displaced = `${compiler}.held`;
  const sentinel = `${compiler}.called`;
  const previous = process.env.AGTMAI_CC_BINARY;
  await writeFile(compiler, "#!/bin/sh\nexec /usr/bin/cc \"$@\"\n", { mode: 0o500 });
  process.env.AGTMAI_CC_BINARY = compiler;
  let capability: Awaited<ReturnType<typeof createNativeNoReplaceCapability>> | undefined;
  try {
    capability = await createNativeNoReplaceCapability({
      async afterCompilerSnapshot(_snapshot, original) {
        await rename(original, displaced);
        await writeFile(original, `#!/bin/sh\ntouch '${sentinel}'\nexit 99\n`, { mode: 0o500 });
      },
    });
    await assert.rejects(readFile(sentinel));
    assert.match(capability.executableSha256, /^0x[0-9a-f]{64}$/u);
  } finally {
    if (previous === undefined) { delete process.env.AGTMAI_CC_BINARY; }
    else { process.env.AGTMAI_CC_BINARY = previous; }
    if (capability !== undefined) {
      await capability.close();
      await rm(capability.custodyPath, { recursive: true, force: true });
    }
    await rm(compiler, { force: true });
    await rm(displaced, { force: true });
    await rm(sentinel, { force: true });
  }
});

test("Linux executes compiler and helper through held descriptors despite pathname replacement", {
  skip: process.platform !== "linux",
}, async () => {
  let compilerDecoy = "";
  let helperDecoy = "";
  let compilerDisplaced = "";
  let helperDisplaced = "";
  let helperHookRan = false;
  const capability = await createNativeNoReplaceCapability({
    async afterCompilerSnapshot(snapshot) {
      compilerDecoy = `${snapshot}.decoy-called`;
      compilerDisplaced = `${snapshot}.held`;
      await rename(snapshot, compilerDisplaced);
      await writeFile(snapshot, `#!/bin/sh\ntouch '${compilerDecoy}'\nexit 99\n`, { mode: 0o500 });
    },
    async beforeHelperSpawn(snapshot) {
      if (helperHookRan) { return; }
      helperHookRan = true;
      helperDecoy = `${snapshot}.decoy-called`;
      helperDisplaced = `${snapshot}.held`;
      await rename(snapshot, helperDisplaced);
      await writeFile(snapshot, `#!/bin/sh\ntouch '${helperDecoy}'\nexit 99\n`, { mode: 0o500 });
    },
  });
  const parent = await canonicalTemporaryDirectory();
  await mkdir(join(parent, "source"), { mode: 0o700 });
  const parentHandle = await openDirectory(parent);
  const sourceHandle = await openDirectory(join(parent, "source"));
  try {
    await capability.rename(renameRequest(parentHandle, sourceHandle, "source", "target"));
    await assert.rejects(readFile(compilerDecoy));
    await assert.rejects(readFile(helperDecoy));
    assert.ok((await readFile(compilerDisplaced)).length > 0);
    assert.ok((await readFile(helperDisplaced)).length > 0);
  } finally {
    await Promise.all([parentHandle.close(), sourceHandle.close(), capability.close()]);
    await rm(capability.custodyPath, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("Darwin rejects private helper pathname substitution before spawn", {
  skip: process.platform !== "darwin",
}, async () => {
  let replaced = false;
  const capability = await createNativeNoReplaceCapability({
    async beforeHelperSpawn(snapshot) {
      if (replaced) { return; }
      replaced = true;
      await rename(snapshot, `${snapshot}.held`);
      await writeFile(snapshot, "#!/bin/sh\nexit 99\n", { mode: 0o500 });
    },
  });
  const parent = await canonicalTemporaryDirectory();
  await mkdir(join(parent, "source"), { mode: 0o700 });
  const parentHandle = await openDirectory(parent);
  const sourceHandle = await openDirectory(join(parent, "source"));
  try {
    await assert.rejects(
      capability.rename(renameRequest(parentHandle, sourceHandle, "source", "target")),
      /native executable changed/u,
    );
  } finally {
    await Promise.all([parentHandle.close(), sourceHandle.close(), capability.close()]);
    await rm(capability.custodyPath, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("timeout TERM/KILLs a TERM-ignoring descendant, drains streams, and reaps the group", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, async () => {
  const compiler = join(dirname(NATIVE_SOURCE), `.timeout-cc-${String(process.pid)}`);
  const previous = process.env.AGTMAI_CC_BINARY;
  await writeFile(compiler, `#!/bin/sh
out=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "-o" ]; then out="$argument"; break; fi
  previous="$argument"
done
cat >/dev/null
printf '%s\\n' '#!/bin/sh' 'kid=""' \
  'on_term() { kill -KILL "$kid"; wait "$kid" 2>/dev/null; while :; do :; done; }' \
  'trap on_term TERM' \
  '(trap "" TERM; echo descendant >&2; while :; do :; done) &' \
  'kid=$!' 'while :; do wait "$kid"; done' > "$out"
chmod 500 "$out"
`, { mode: 0o500 });
  process.env.AGTMAI_CC_BINARY = compiler;
  let capability: Awaited<ReturnType<typeof createNativeNoReplaceCapability>> | undefined;
  const parent = await canonicalTemporaryDirectory();
  await mkdir(join(parent, "source"), { mode: 0o700 });
  const parentHandle = await openDirectory(parent);
  const sourceHandle = await openDirectory(join(parent, "source"));
  try {
    capability = await createNativeNoReplaceCapability({
      helperTimeoutMs: 100, termGraceMs: 100, groupReapMs: 2_000,
    });
    await assert.rejects(
      capability.rename(renameRequest(parentHandle, sourceHandle, "source", "target")),
      /process group timed out and was reaped/u,
    );
  } finally {
    if (previous === undefined) { delete process.env.AGTMAI_CC_BINARY; }
    else { process.env.AGTMAI_CC_BINARY = previous; }
    await Promise.allSettled([parentHandle.close(), sourceHandle.close(), capability?.close()]);
    if (capability !== undefined) { await rm(capability.custodyPath, { recursive: true, force: true }); }
    await rm(compiler, { force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("close is idempotent and preserves authenticated and substituted custody evidence", async () => {
  let foreignCustody = "";
  let ownedEvidence = "";
  const capability = await createNativeNoReplaceCapability({
    async beforeCleanup(custody) {
      foreignCustody = custody;
      ownedEvidence = `${custody}.owned-evidence`;
      await rename(custody, ownedEvidence);
      await mkdir(custody, { mode: 0o700 });
      await writeFile(join(custody, "foreign-sentinel"), "preserve", { mode: 0o600 });
    },
  });
  try {
    await capability.close();
    await capability.close();
    assert.equal(await readFile(join(foreignCustody, "foreign-sentinel"), "utf8"), "preserve");
    const minimumOwnedEvidenceEntries = process.platform === "linux" ? 2 : 1;
    assert.ok(
      (await readdir(ownedEvidence)).length >= minimumOwnedEvidenceEntries,
      `${process.platform} custody preserves at least ${minimumOwnedEvidenceEntries} authenticated evidence entries`,
    );
  } finally {
    await rm(foreignCustody, { recursive: true, force: true });
    await rm(ownedEvidence, { recursive: true, force: true });
  }
});

test("native helper build is deterministic for one compiler identity", async () => {
  const first = await createNativeNoReplaceCapability();
  const second = await createNativeNoReplaceCapability();
  try {
    assert.equal(first.compilerSha256, second.compilerSha256);
    assert.equal(first.executableSha256, second.executableSha256);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await Promise.all([
      rm(first.custodyPath, { recursive: true, force: true }),
      rm(second.custodyPath, { recursive: true, force: true }),
    ]);
  }
});

function renameRequest(
  parent: Awaited<ReturnType<typeof open>>,
  source: Awaited<ReturnType<typeof open>>,
  sourceLeaf: string,
  destinationLeaf: string,
): NoReplaceRenameRequest {
  return { sourceParent: parent, source, destinationParent: parent, sourceLeaf, destinationLeaf };
}

async function openDirectory(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

async function canonicalTemporaryDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "native-no-replace-test-")));
}
