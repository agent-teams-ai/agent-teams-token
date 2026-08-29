import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerRunArguments, IMAGE } from "../src/adapters/container-contract.ts";

test("container contract is digest-pinned and hardened", () => {
  const args = dockerRunArguments({ input: "/tmp/input", output: "/tmp/output", forge: "/tmp/forge", solc: "/tmp/solc", imagePath: "/official/bin:/usr/bin:/bin", pythonPath: "/official/python", containerName: "agtmai-slither-test" });
  const joined = args.join(" ");
  for (const required of [IMAGE, "--name agtmai-slither-test", "--platform linux/amd64", "--network none", "--read-only", "--user 1000:1000", "no-new-privileges=true", "--cap-drop ALL", "--pids-limit 128", "--memory 2g", "--cpus 2", "dst=/input,readonly", "dst=/tools/forge,readonly", "dst=/tools/solc,readonly", "--entrypoint /usr/bin/env", " -i HOME=", "slither . --fail-pedantic --foundry-ignore-compile", "--skip test --skip script", "PYTHONPATH=/official/python", "CapEff", "pids.max", "memory.max", "cpu.max"]) {assert.match(joined, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));}
  assert.equal(joined.match(/--fail-pedantic/gu)?.length, 3);
  assert.equal(joined.includes("--fail-on pedantic"), false);
  assert.match(joined, /test ! -e \/var\/run\/docker\.sock/u);
  for (const forbidden of ["dst=/var/run/docker.sock", "--privileged", "--network host", ":latest"]) {assert.equal(joined.includes(forbidden), false);}
});

test("checkout paths are not used as writable Forge out/cache", () => {
  const joined = dockerRunArguments({ input: "/tmp/input", output: "/tmp/output", forge: "/tmp/forge", solc: "/tmp/solc", imagePath: "/usr/bin:/bin", pythonPath: "/official/python", containerName: "agtmai-slither-test" }).join(" ");
  assert.match(joined, /FOUNDRY_OUT=\/work\/out/u); assert.doesNotMatch(joined, /FOUNDRY_OUT=\/input/u);
});
