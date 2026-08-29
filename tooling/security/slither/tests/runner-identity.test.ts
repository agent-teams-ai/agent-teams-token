import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeCreationBytecode,
  assertSlitherStatus,
  parseOfficialImageEnvironment,
} from "../src/adapters/runner.ts";
import {
  IMAGE_REVISION,
  PINNED_PYTHONPATH,
} from "../src/adapters/container-contract.ts";

const digest = "ghcr.io/trailofbits/eth-security-toolbox@sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0";

function imageInspection(environment: readonly string[]): string {
  return JSON.stringify({
    RepoDigests: [digest],
    Os: "linux",
    Architecture: "amd64",
    Config: {
      Labels: { "org.opencontainers.image.revision": IMAGE_REVISION },
      Env: environment,
    },
  });
}

test("real pinned image environment works without a Config.Env PYTHONPATH", () => {
  const result = parseOfficialImageEnvironment(imageInspection([
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/ethsec/.local/bin:/home/ethsec/.vyper/bin:/home/ethsec/.foundry/bin",
    "QEMU_LD_PREFIX=/usr/x86_64-linux-gnu",
    "HOME=/home/ethsec",
  ]));
  assert.equal(result.pythonPath, PINNED_PYTHONPATH);
  assert.match(result.imagePath, /\/home\/ethsec\/\.local\/bin/u);
});

test("ambiguous or unsafe pinned image PATH fails closed", () => {
  assert.throws(
    () => parseOfficialImageEnvironment(imageInspection(["PATH=/usr/bin:relative"])),
    /unsafe/u,
  );
  assert.throws(
    () => parseOfficialImageEnvironment(imageInspection(["PATH=/usr/bin", "PATH=/bin"])),
    /ambiguous/u,
  );
});

test("creation bytecode identity normalizes Forge's 0x artifact prefix", () => {
  assert.deepEqual(decodeCreationBytecode("0x6001"), decodeCreationBytecode("6001"));
});

test("creation bytecode identity rejects empty, odd, linked or non-hex values", () => {
  for (const value of ["", "0x", "0x1", "0xzz", "__$library$__", null]) {assert.throws(() => decodeCreationBytecode(value));}
});

test("Slither JSON and exit status obey the exact documented matrix", () => {
  assert.doesNotThrow(() => assertSlitherStatus(true, [], 0));
  assert.doesNotThrow(() => assertSlitherStatus(false, ["compile failed"], 255));
  for (const status of [1, 20, 30, 40, 50, 125, 137, 143, 254, 255]) {
    assert.throws(() => assertSlitherStatus(true, [], status), /0\/success or 255\/failure/u);
  }
  assert.throws(() => assertSlitherStatus(false, [], 255));
  assert.throws(() => assertSlitherStatus(true, ["incomplete"], 0));
});
