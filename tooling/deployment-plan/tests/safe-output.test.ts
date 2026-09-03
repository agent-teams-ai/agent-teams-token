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
      claim.writeExclusive("READY", Buffer.from("ready")),
      /identity changed/u,
    );
  } finally {
    await assert.rejects(claim.close(), /identity changed/u);
  }
  assert.deepEqual(await readdir(claim.path), []);
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
  const retry = await claimOwnedOutputDirectory(parent, "bundle");
  try {
    await retry.writeExclusive("READY", Buffer.from("ready"));
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
    async beforeStagingLeafOpen() {
      await rename(claimPath, displaced);
      await mkdir(claimPath, { mode: 0o700 });
    },
  });
  claimPath = claim.path;
  try {
    await assert.rejects(claim.writeExclusive("READY", Buffer.from("safe")), /identity changed/u);
    await assert.rejects(readFile(join(displaced, "READY")));
    assert.equal(await readFile(join(claimPath, "READY"), "utf8"), "safe");
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
      claim.writeExclusive("READY", Buffer.from("unsafe")),
      /ENOENT|substituted/u,
    );
    await assert.rejects(readFile(join(claimPath, "READY")));
    assert.equal(await readFile(join(attacker, "READY"), "utf8"), "unsafe");
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
    async beforePublishRename() {
      await rename(claimPath, displaced);
      await mkdir(claimPath, { mode: 0o700 });
    },
  });
  claimPath = claim.path;
  try {
    await claim.writeExclusive("READY", Buffer.from("safe"));
    await assert.rejects(claim.publish(), /identity changed/u);
    await assert.rejects(readFile(join(parent, "bundle", "READY")));
    assert.equal(await readFile(join(displaced, "READY"), "utf8"), "safe");
  } finally {
    await assert.rejects(claim.close(), /ENOENT|identity changed/u);
  }
});

test("published-directory substitution after atomic rename fails closed", async () => {
  const parent = await canonicalTemporaryDirectory();
  const target = join(parent, "bundle");
  const displaced = join(parent, "displaced");
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    async afterPublishRename() {
      await rename(target, displaced);
      await mkdir(target, { mode: 0o700 });
    },
  });
  try {
    await claim.writeExclusive("READY", Buffer.from("safe"));
    await assert.rejects(claim.publish(), /identity changed/u);
    await assert.rejects(readFile(join(target, "READY")));
    assert.equal(await readFile(join(displaced, "READY"), "utf8"), "safe");
  } finally {
    await assert.rejects(claim.close(), /ENOENT|identity changed/u);
  }
});

test("exclusive output files cannot be overwritten", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle");
  try {
    await claim.writeExclusive("deployment-plan.v2.json", Buffer.from("{}\n"));
    await assert.rejects(
      claim.writeExclusive("deployment-plan.v2.json", Buffer.from("forged")),
      /EEXIST/u,
    );
    assert.equal(await claim.publish(), join(parent, "bundle"));
    await assert.rejects(
      claim.writeExclusive("READY", Buffer.from("late")),
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
    async beforeStagingDirectorySync() { operations.push("before-staging-sync"); },
    async afterStagingDirectorySync() { operations.push("after-staging-sync"); },
    async beforePublishRename() { operations.push("before-rename"); },
    async afterPublishRename() { operations.push("after-rename"); },
    async beforeParentDirectorySync() { operations.push("before-parent-sync"); },
    async afterParentDirectorySync() { operations.push("after-parent-sync"); },
  });
  try {
    await claim.writeExclusive("READY", Buffer.from("ready"));
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
    async beforeStagingDirectorySync() { throw new Error("injected staging sync failure"); },
  });
  try {
    await claim.writeExclusive("READY", Buffer.from("ready"));
    await assert.rejects(claim.publish(), /injected staging sync failure/u);
    await assert.rejects(readFile(join(parent, "bundle", "READY")));
  } finally {
    await claim.close();
  }
  assert.deepEqual(await readdir(parent), []);
});

test("parent sync failure rolls READY back and leaves no acceptable bundle", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle", {
    async parentDirectorySync() { throw new Error("injected parent fsync failure"); },
  });
  try {
    await claim.writeExclusive("READY", Buffer.from("ready"));
    await assert.rejects(claim.publish(), /injected parent fsync failure/u);
    await assert.rejects(readFile(join(parent, "bundle", "READY")));
  } finally {
    await claim.close();
  }
  assert.deepEqual(await readdir(parent), []);
});

test("cleanup refuses a hostile staging replacement", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle");
  const displaced = join(parent, "displaced");
  await claim.writeExclusive("READY", Buffer.from("owned"));
  await rename(claim.path, displaced);
  await mkdir(claim.path, { mode: 0o700 });
  await writeFile(join(claim.path, "foreign"), "preserve", { mode: 0o600 });
  await assert.rejects(claim.close(), /identity changed/u);
  assert.equal(await readFile(join(claim.path, "foreign"), "utf8"), "preserve");
  assert.equal(await readFile(join(displaced, "READY"), "utf8"), "owned");
});

test("cleanup rejects and preserves a foreign staging entry", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle");
  await claim.writeExclusive("READY", Buffer.from("owned"));
  await writeFile(join(claim.path, "foreign"), "preserve", { mode: 0o600 });
  await assert.rejects(claim.close(), /foreign entry/u);
  assert.equal(await readFile(join(claim.path, "READY"), "utf8"), "owned");
  assert.equal(await readFile(join(claim.path, "foreign"), "utf8"), "preserve");
});

async function canonicalTemporaryDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "deployment-output-")));
}
