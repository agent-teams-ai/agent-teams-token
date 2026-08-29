import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
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
    await claim.close();
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
    await claim.close();
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
    await claim.close();
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
    await claim.close();
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
    await claim.close();
  }
});

test("exclusive output files cannot be overwritten", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle");
  try {
    await claim.writeExclusive("deployment-plan.v1.json", Buffer.from("{}\n"));
    await assert.rejects(
      claim.writeExclusive("deployment-plan.v1.json", Buffer.from("forged")),
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

async function canonicalTemporaryDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "deployment-output-")));
}
