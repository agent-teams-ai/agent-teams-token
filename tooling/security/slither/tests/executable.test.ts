import assert from "node:assert/strict";
import { chmod, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { resolveDockerCli } from "../src/adapters/executable.ts";
import { makeTestDirectory } from "./test-directory.ts";

test("Docker CLI rejects a replaceable executable under a temporary ancestor", async () => {
  const root = await makeTestDirectory("linux-docker-");
  try {
    const docker = join(root, "usr/bin/docker");
    await mkdir(join(root, "usr/bin"), { recursive: true });
    await writeFile(docker, "test executable");
    await chmod(docker, 0o700);
    await assert.rejects(resolveDockerCli(docker), { code: "DOCKER_CLI_INVALID" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Docker CLI rejects a symlink to replaceable temporary executable authority", async () => {
  const root = await makeTestDirectory("macos-docker-");
  try {
    const canonical = join(root, "Applications/Docker.app/Contents/Resources/bin/docker");
    const binding = join(root, "usr/local/bin/docker");
    await mkdir(join(root, "Applications/Docker.app/Contents/Resources/bin"), { recursive: true });
    await mkdir(join(root, "usr/local/bin"), { recursive: true });
    await writeFile(canonical, "test executable");
    await chmod(canonical, 0o700);
    await symlink(canonical, binding);
    await assert.rejects(resolveDockerCli(binding), { code: "DOCKER_CLI_INVALID" });
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

// No Docker process is launched: use a system executable to exercise custody.
test("root-owned system executable authority is accepted", async () => {
  // Sandboxed synthetic workers may map even / to the nonroot host UID.
  if ((await lstat("/")).uid !== 0) {
    await assert.rejects(resolveDockerCli("/usr/bin/true"), { code: "DOCKER_CLI_INVALID" });
  } else { assert.equal(await resolveDockerCli("/usr/bin/true"), "/usr/bin/true"); }
});
