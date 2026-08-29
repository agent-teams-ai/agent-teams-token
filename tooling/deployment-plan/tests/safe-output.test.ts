import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  symlink,
  writeFile,
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

test("exclusive output files cannot be overwritten", async () => {
  const parent = await canonicalTemporaryDirectory();
  const claim = await claimOwnedOutputDirectory(parent, "bundle");
  try {
    await claim.writeExclusive("deployment-plan.v1.json", Buffer.from("{}\n"));
    await assert.rejects(
      claim.writeExclusive("deployment-plan.v1.json", Buffer.from("forged")),
      /EEXIST/u,
    );
  } finally {
    await claim.close();
  }
});

async function canonicalTemporaryDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "deployment-output-")));
}
