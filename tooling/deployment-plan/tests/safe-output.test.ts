import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimOwnedOutputDirectory } from "../src/adapters/safe-output.ts";
import { testOnlyNoReplaceDirectoryRename } from "./helpers/no-replace-directory-rename.ts";

test("output claim requires a canonical owned 0700 parent", async () => {
  const base = await canonicalTemporaryDirectory();
  const privateParent = join(base, "private");
  const permissiveParent = join(base, "permissive");
  await mkdir(privateParent, { mode: 0o700 });
  await mkdir(permissiveParent, { mode: 0o700 });
  await chmod(permissiveParent, 0o755);
  await assert.rejects(
    claimOwnedOutputDirectory(permissiveParent, "bundle"),
    /0700/u,
  );
  await assert.rejects(
    claimOwnedOutputDirectory("relative/output", "bundle"),
    /absolute/u,
  );

  const redirectedParent = join(base, "redirected");
  await symlink(privateParent, redirectedParent);
  await assert.rejects(
    claimOwnedOutputDirectory(redirectedParent, "bundle"),
    /symbolic link/u,
  );
});

test("output claim rejects mixed-case staging names", async () => {
  const parent = await canonicalTemporaryDirectory();
  await assert.rejects(
    claimOwnedOutputDirectory(parent, ".StAgInG-ABC"),
    /staging names are reserved/u,
  );
});

test("output claim rejects symlink and pre-existing final targets", async () => {
  const parent = await canonicalTemporaryDirectory();
  const other = join(parent, "other");
  await mkdir(other, { mode: 0o700 });
  await symlink(other, join(parent, "symlink-target"));
  await assert.rejects(
    claimOwnedOutputDirectory(parent, "symlink-target"),
    /already exists/u,
  );
  await writeFile(join(parent, "file-target"), "occupied", { mode: 0o600 });
  await assert.rejects(
    claimOwnedOutputDirectory(parent, "file-target"),
    /already exists/u,
  );
});

test("directory replacement after an exclusive claim fails closed", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle");
  try {
    const displaced = join(parent, "displaced");
    await rename(claim.path, displaced);
    await mkdir(claim.path, { mode: 0o700 });
    await assert.rejects(
      claim.writeExclusive("payload", Buffer.from("ready")),
      /identity changed/u,
    );
  } finally {
    await assert.rejects(claim.close(), /identity changed/u);
  }
  assert.deepEqual(await readdir(claim.path), []);
});

test("publication fails closed when no-replace capability is unavailable", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle");
  try {
    await claim.writeExclusive("payload", Buffer.from("ready"));
    await assert.rejects(
      claim.publish(),
      /native no-replace directory rename primitive/u,
    );
    await assert.rejects(readFile(join(parent, "bundle", "payload")));
  } finally {
    await claim.close();
  }
});

test("owned staging creation failure is reclaimed and a retry can publish", async () => {
  const parent = await canonicalTemporaryDirectory();
  await assert.rejects(
    claimOwnedOutputDirectory(parent, "bundle", {
      async afterStagingDirectoryCreate() { throw new Error("injected creation failure"); },
    }),
    /injected creation failure/u,
  );
  assert.deepEqual(await readdir(parent), []);
  const retry = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
  });
  try {
    await retry.writeExclusive("payload", Buffer.from("ready"));
    assert.equal(await retry.publish(), join(parent, "bundle"));
  } finally {
    await retry.close();
  }
});

test("staging leaf check/open swap cannot produce a publishable bundle", async () => {
  const parent = await canonicalTemporaryDirectory();
  let claimPath = "";
  const displaced = join(parent, "displaced");
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    async beforeStagingLeafOpen() {
      await rename(claimPath, displaced);
      await mkdir(claimPath, { mode: 0o700 });
    },
  });
  claimPath = claim.path;
  try {
    await assert.rejects(claim.writeExclusive("payload", Buffer.from("safe")), /identity changed/u);
    await assert.rejects(readFile(join(displaced, "payload")));
    assert.equal(await readFile(join(claimPath, "payload"), "utf8"), "safe");
    await assert.rejects(claim.publish(), /identity changed/u);
  } finally {
    await assert.rejects(claim.close(), /identity changed/u);
  }
});

test("exact staging-directory ABA around leaf open fails on leaf identity", async () => {
  const parent = await canonicalTemporaryDirectory();
  let claimPath = "";
  const displaced = join(parent, "displaced");
  const attacker = join(parent, "attacker");
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    async beforeStagingLeafOpen() {
      await rename(claimPath, displaced);
      await mkdir(claimPath, { mode: 0o700 });
    },
    async afterStagingLeafOpen() {
      await rename(claimPath, attacker);
      await rename(displaced, claimPath);
    },
  });
  claimPath = claim.path;
  try {
    await assert.rejects(
      claim.writeExclusive("payload", Buffer.from("unsafe")),
      /ENOENT|substituted/u,
    );
    await assert.rejects(readFile(join(claimPath, "payload")));
    assert.equal(await readFile(join(attacker, "payload"), "utf8"), "unsafe");
  } finally {
    await assert.rejects(claim.close(), /ENOENT|substituted|foreign entry/u);
    await rm(attacker, { recursive: true, force: true });
  }
});

test("staging swap immediately before rename cannot be accepted as published", async () => {
  const parent = await canonicalTemporaryDirectory();
  let claimPath = "";
  const displaced = join(parent, "displaced");
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    async beforePublishRename() {
      await rename(claimPath, displaced);
      await mkdir(claimPath, { mode: 0o700 });
    },
  });
  claimPath = claim.path;
  try {
    await claim.writeExclusive("payload", Buffer.from("safe"));
    await assert.rejects(claim.publish(), /identity changed/u);
    await assert.rejects(readFile(join(parent, "bundle", "payload")));
    assert.equal(await readFile(join(displaced, "payload"), "utf8"), "safe");
  } finally {
    await assert.rejects(claim.close(), /ENOENT|identity changed/u);
  }
});

test("uncertain publication preserves a published output with a foreign entry", async () => {
  const parent = await canonicalTemporaryDirectory();
  const target = join(parent, "bundle");
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    async afterPublishRename() {
      await writeFile(join(target, "foreign"), "do not delete", { mode: 0o600 });
    },
    async parentDirectorySync() { throw new Error("injected sync failure"); },
  });
  try {
    await claim.writeExclusive("payload", Buffer.from("safe"));
    await assert.rejects(claim.publish(), /target preserved/u);
    assert.equal(await readFile(join(target, "payload"), "utf8"), "safe");
    assert.equal(await readFile(join(target, "foreign"), "utf8"), "do not delete");
  } finally {
    await claim.close();
  }
});

test("uncertain publication preserves a substituted published leaf", async () => {
  const parent = await canonicalTemporaryDirectory();
  const target = join(parent, "bundle");
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    async afterPublishRename() {
      await rm(join(target, "payload"));
      await writeFile(join(target, "payload"), "substituted", { mode: 0o600 });
    },
    async parentDirectorySync() { throw new Error("injected sync failure"); },
  });
  try {
    await claim.writeExclusive("payload", Buffer.from("safe"));
    await assert.rejects(claim.publish(), /target preserved/u);
    assert.equal(await readFile(join(target, "payload"), "utf8"), "substituted");
  } finally {
    await claim.close();
  }
});

test("published-directory substitution after atomic rename fails closed", async () => {
  const parent = await canonicalTemporaryDirectory();
  const target = join(parent, "bundle");
  const displaced = join(parent, "displaced");
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    async afterPublishRename() {
      await rename(target, displaced);
      await mkdir(target, { mode: 0o700 });
    },
  });
  try {
    await claim.writeExclusive("payload", Buffer.from("safe"));
    await assert.rejects(claim.publish(), /identity changed/u);
    await assert.rejects(readFile(join(target, "payload")));
    assert.equal(await readFile(join(displaced, "payload"), "utf8"), "safe");
  } finally {
    await claim.close();
  }
});

test("exclusive output files cannot be overwritten", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
  });
  try {
    await claim.writeExclusive("deployment-plan.v2.json", Buffer.from("{}\n"));
    await assert.rejects(
      claim.writeExclusive("deployment-plan.v2.json", Buffer.from("forged")),
      /EEXIST/u,
    );
    assert.equal(await claim.publish(), join(parent, "bundle"));
    await assert.rejects(
      claim.writeExclusive("payload", Buffer.from("late")),
      /already published/u,
    );
  } finally {
    await claim.close();
  }
});

test("publication durably syncs staging before rename and parent after rename", async () => {
  const parent = await canonicalTemporaryDirectory();
  const operations: string[] = [];
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    async beforeStagingDirectorySync() { operations.push("before-staging-sync"); },
    async afterStagingDirectorySync() { operations.push("after-staging-sync"); },
    async beforePublishRename() { operations.push("before-rename"); },
    async afterPublishRename() { operations.push("after-rename"); },
    async beforeParentDirectorySync() { operations.push("before-parent-sync"); },
    async afterParentDirectorySync() { operations.push("after-parent-sync"); },
  });
  try {
    await claim.writeExclusive("payload", Buffer.from("ready"));
    await claim.publish();
    assert.deepEqual(operations, [
      "before-staging-sync", "after-staging-sync", "before-rename",
      "after-rename", "before-parent-sync", "after-parent-sync",
    ]);
  } finally {
    await claim.close();
  }
});

test("staging sync failure prevents publication", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    async beforeStagingDirectorySync() { throw new Error("injected staging sync failure"); },
  });
  try {
    await claim.writeExclusive("payload", Buffer.from("ready"));
    await assert.rejects(claim.publish(), /injected staging sync failure/u);
    await assert.rejects(readFile(join(parent, "bundle", "payload")));
  } finally {
    await claim.close();
  }
  assert.deepEqual(await readdir(parent), []);
});

test("post-rename parent sync uncertainty preserves target without READY", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    async parentDirectorySync() { throw new Error("injected parent fsync failure"); },
  });
  try {
    await claim.writeExclusive("payload", Buffer.from("ready"));
    await assert.rejects(
      claim.publish(),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "OUTPUT_PUBLICATION_UNCERTAIN",
    );
    assert.equal(await readFile(join(parent, "bundle", "payload"), "utf8"), "ready");
    await assert.rejects(readFile(join(parent, "bundle", "READY")));
  } finally {
    await claim.close();
  }
  assert.deepEqual(await readdir(join(parent, "bundle")), ["payload"]);
});

test("READY is committed only after durable publication", async () => {
  const parent = await canonicalTemporaryDirectory();
  const operations: string[] = [];
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    async noReplaceDirectoryRename(source, target) {
      operations.push(target.endsWith("READY") ? "ready-rename" : "publish-rename");
      await testOnlyNoReplaceDirectoryRename(source, target);
    },
    async afterParentDirectorySync() { operations.push("published-durable"); },
    async beforeFinalMarkerRename() { operations.push("ready-commit"); },
    async beforeFinalMarkerDirectorySync() { operations.push("before-ready-directory-sync"); },
    async afterFinalMarkerDirectorySync() { operations.push("after-ready-directory-sync"); },
  });
  try {
    await assert.rejects(
      claim.writeExclusive("READY", Buffer.from("premature")),
      /reserved for the final durability commit/u,
    );
    await claim.writeExclusive("payload", Buffer.from("payload"));
    await claim.publish();
    await claim.finalizeReady("READY", Buffer.from("ready"));
    assert.deepEqual(operations, [
      "publish-rename", "published-durable", "ready-commit",
      "ready-rename", "before-ready-directory-sync", "after-ready-directory-sync",
    ]);
    assert.equal(await readFile(join(parent, "bundle", "READY"), "utf8"), "ready");
  } finally {
    await claim.close();
  }
});

test("post-rename READY sync uncertainty preserves target and READY", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    async finalMarkerDirectorySync() { throw new Error("injected READY directory fsync failure"); },
  });
  try {
    await claim.writeExclusive("payload", Buffer.from("payload"));
    await claim.publish();
    await assert.rejects(
      claim.finalizeReady("READY", Buffer.from("ready")),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "OUTPUT_PUBLICATION_UNCERTAIN",
    );
    assert.equal(await readFile(join(parent, "bundle", "payload"), "utf8"), "payload");
    assert.equal(await readFile(join(parent, "bundle", "READY"), "utf8"), "ready");
  } finally {
    await claim.close();
  }
  assert.deepEqual(
    (await readdir(join(parent, "bundle"))).toSorted(),
    ["payload", "READY"].toSorted(),
  );
});

test("READY replacement before final directory sync is uncertain and preserved", async () => {
  await assertReadyReplacementPreserved("beforeFinalMarkerDirectorySync", "foreign-before-sync");
});

test("READY replacement after final directory sync is uncertain and preserved", async () => {
  await assertReadyReplacementPreserved("afterFinalMarkerDirectorySync", "foreign-after-sync");
});

test("READY finalization cannot succeed before its post-rename directory sync", async () => {
  const parent = await canonicalTemporaryDirectory();
  let releaseSync: (() => void) | undefined;
  let reportSyncEntered: (() => void) | undefined;
  const syncEntered = new Promise<void>((resolve) => { reportSyncEntered = resolve; });
  const allowSync = new Promise<void>((resolve) => { releaseSync = resolve; });
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    async finalMarkerDirectorySync() {
      reportSyncEntered?.();
      await allowSync;
    },
  });
  try {
    await claim.writeExclusive("payload", Buffer.from("payload"));
    await claim.publish();
    let finalized = false;
    const finalization = (async () => {
      await claim.finalizeReady("READY", Buffer.from("ready"));
      finalized = true;
    })();
    await syncEntered;
    assert.equal(await readFile(join(parent, "bundle", "READY"), "utf8"), "ready");
    assert.equal(finalized, false);
    releaseSync?.();
    await finalization;
    assert.equal(finalized, true);
  } finally {
    await claim.close();
  }
});

test("replacement race before final marker preserves both trees without acceptable READY", async () => {
  const parent = await canonicalTemporaryDirectory();
  const target = join(parent, "bundle");
  const displaced = join(parent, "displaced");
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    async beforeFinalMarkerRename() {
      await rename(target, displaced);
      await mkdir(target, { mode: 0o700 });
    },
  });
  try {
    await claim.writeExclusive("payload", Buffer.from("owned"));
    await claim.publish();
    await assert.rejects(claim.finalizeReady("READY", Buffer.from("ready")), /identity changed/u);
    await assert.rejects(readFile(join(target, "READY")));
    await assert.rejects(readFile(join(displaced, "READY")));
    assert.equal(await readFile(join(displaced, "payload"), "utf8"), "owned");
  } finally {
    await claim.close();
  }
});

test("cleanup refuses a hostile staging replacement", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle");
  const displaced = join(parent, "displaced");
  await claim.writeExclusive("payload", Buffer.from("owned"));
  await rename(claim.path, displaced);
  await mkdir(claim.path, { mode: 0o700 });
  await writeFile(join(claim.path, "foreign"), "preserve", { mode: 0o600 });
  await assert.rejects(claim.close(), /identity changed/u);
  assert.equal(await readFile(join(claim.path, "foreign"), "utf8"), "preserve");
  assert.equal(await readFile(join(displaced, "payload"), "utf8"), "owned");
});

test("cleanup rejects and preserves a foreign staging entry", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle");
  await claim.writeExclusive("payload", Buffer.from("owned"));
  await writeFile(join(claim.path, "foreign"), "preserve", { mode: 0o600 });
  await assert.rejects(claim.close(), /foreign entry/u);
  assert.equal(await readFile(join(claim.path, "payload"), "utf8"), "owned");
  assert.equal(await readFile(join(claim.path, "foreign"), "utf8"), "preserve");
});

async function assertReadyReplacementPreserved(
  hook: "beforeFinalMarkerDirectorySync" | "afterFinalMarkerDirectorySync",
  foreign: string,
): Promise<void> {
  const parent = await canonicalTemporaryDirectory();
  const ready = join(parent, "bundle", "READY");
  const replaceReady = async (): Promise<void> => {
    await rm(ready);
    await writeFile(ready, foreign, { mode: 0o600 });
  };
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename,
    [hook]: replaceReady,
  });
  try {
    await claim.writeExclusive("payload", Buffer.from("payload"));
    await claim.publish();
    await assert.rejects(
      claim.finalizeReady("READY", Buffer.from("ready")),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "OUTPUT_PUBLICATION_UNCERTAIN",
    );
    assert.equal(await readFile(ready, "utf8"), foreign);
    assert.equal(await readFile(join(parent, "bundle", "payload"), "utf8"), "payload");
  } finally {
    await claim.close();
  }
}

async function canonicalTemporaryDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "deployment-output-")));
}
