import assert from "node:assert/strict";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { resolveDockerCli } from "../src/adapters/executable.ts";
import { makeTestDirectory } from "./test-directory.ts";

test("Linux Docker CLI binding resolves an executable regular file", async () => {
  const root = await makeTestDirectory("linux-docker-");
  try {
    const docker = join(root, "usr/bin/docker");
    await mkdir(join(root, "usr/bin"), { recursive: true });
    await writeFile(docker, "test executable");
    await chmod(docker, 0o700);
    assert.equal(await resolveDockerCli(docker), docker);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS Docker Desktop symlink binding canonicalizes before execution", async () => {
  const root = await makeTestDirectory("macos-docker-");
  try {
    const canonical = join(root, "Applications/Docker.app/Contents/Resources/bin/docker");
    const binding = join(root, "usr/local/bin/docker");
    await mkdir(join(root, "Applications/Docker.app/Contents/Resources/bin"), { recursive: true });
    await mkdir(join(root, "usr/local/bin"), { recursive: true });
    await writeFile(canonical, "test executable");
    await chmod(canonical, 0o700);
    await symlink(canonical, binding);
    assert.equal(await resolveDockerCli(binding), canonical);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid Docker CLI bindings fail with a sanitised environment code", async () => {
  const root = await makeTestDirectory("invalid-docker-");
  try {
    const nonExecutable = join(root, "docker");
    await writeFile(nonExecutable, "not executable");
    for (const path of ["docker", join(root, "missing"), root, nonExecutable]) {
      await assert.rejects(resolveDockerCli(path), { code: "DOCKER_CLI_INVALID" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
