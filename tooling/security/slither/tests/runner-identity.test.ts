import assert from "node:assert/strict";
import { test } from "node:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeCreationBytecode,
  assertSlitherStatus,
  parseSlitherExit,
  parseOfficialImageEnvironment,
  verifyVersions,
} from "../src/adapters/runner.ts";
import {
  IMAGE_REVISION,
  PINNED_PYTHONPATH,
} from "../src/adapters/container-contract.ts";
import { makeTestDirectory } from "./test-directory.ts";

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

test("Slither JSON, errors, exact finding count and exit obey the exhaustive status matrix", () => {
  const booleans = [false, true] as const;
  const errorSets = [[], ["compile failed"]] as const;
  const findingCounts = [-1, 0, 1, 11, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY] as const;
  const statuses = [-1, ...Array.from({ length: 256 }, (_, status) => status), 256];
  const cases = booleans.flatMap((success) => errorSets.flatMap((errors) => findingCounts.flatMap(
    (findingCount) => statuses.map((status) => ({ success, errors, findingCount, status })),
  )));
  for (const { success, errors, findingCount, status } of cases) {
    const valid = Number.isSafeInteger(findingCount) && findingCount >= 0 && (success
      ? errors.length === 0 && ((findingCount === 0 && status === 0) || (findingCount > 0 && status === 255))
      : errors.length > 0 && status === 255);
    const invocation = () => assertSlitherStatus(success, errors, findingCount, status);
    if (valid) {assert.doesNotThrow(invocation);}
    else {assert.throws(invocation, /success, errors, finding count and exit status/u);}
  }
});

test("real Slither 0.11.6 production semantics accept successful JSON with findings and exit 255", () => {
  assert.doesNotThrow(() => assertSlitherStatus(true, [], 11, 255));
});

test("Slither exit files accept only canonical 0 or 255 with an optional trailing LF", () => {
  for (const [raw, expected] of [["0", 0], ["0\n", 0], ["255", 255], ["255\n", 255]] as const) {
    assert.equal(parseSlitherExit(raw), expected);
  }
  for (const raw of [
    "", "\n", " ", "0junk", "0\n255", "255\n0", "+0", "-0", "+255", "-255",
    "0.0", "255.0", "00", "0255", " 0", "0 ", "0\r\n", "255\n\n", "1", "254", "256",
  ]) {
    assert.throws(() => parseSlitherExit(raw), { code: "SLITHER_EXIT_INVALID" });
  }
});


test("solc version parser requires the exact pinned Linux.g++ suffix", async () => {
  const root = await makeTestDirectory("version-");
  try {
    await writeFile(join(root, "solc.version"), "solc, the solidity compiler commandline interface\nVersion: 0.8.36+commit.8a079791.Linux.g++\n");
    await writeFile(join(root, "slither.version"), "0.11.6\n");
    await writeFile(join(root, "crytic-compile.version"), "0.4.2\n");
    await writeFile(join(root, "forge.version"), "forge Version: 1.8.0\n");
    await verifyVersions(root);
    for (const forged of ["Version: 0.8.36+commit.8a079791\n", "Version: 0.8.36+commit.deadbeef.Linux.g++\n", "Version: 0.8.36+commit.8a079791.Linux.g++-forged\n"]) {
      await writeFile(join(root, "solc.version"), `solc, the solidity compiler commandline interface\n${forged}`);
      await assert.rejects(verifyVersions(root), { code: "TOOL_VERSION_MISMATCH" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("crytic-compile accepts the observed bare pinned CLI version and rejects contamination", async () => {
  const root = await makeTestDirectory("crytic-version-");
  try {
    await writeFile(join(root, "solc.version"), "solc, the solidity compiler commandline interface\nVersion: 0.8.36+commit.8a079791.Linux.g++\n");
    await writeFile(join(root, "slither.version"), "0.11.6\n");
    await writeFile(join(root, "forge.version"), "forge Version: 1.8.0\nCommit SHA: 61ae26af36320d4fa1020f7db53785885e29eeb5\nBuild Timestamp: 2026-08-26T13:14:38.112964122Z (1787750078)\nBuild Profile: dist\n");
    for (const raw of ["0.4.2\n", "0.4.2"]) {
      await writeFile(join(root, "crytic-compile.version"), raw);
      await verifyVersions(root);
    }
    for (const raw of [
      "", "\n", "0.4.1\n", "0.4.20\n", "10.4.2\n", "0.4.2-dev\n", "0.4.2+build\n",
      "crytic-compile 0.4.2\n", "Version: 0.4.2\n", " 0.4.2\n", "0.4.2 \n", "0.4.2\t\n",
      "0.4.2\r\n", "0.4.2\n\n", "\n0.4.2\n", "0.4.2\n0.4.2\n", "0.4.2\nwarning\n",
      "warning\n0.4.2\n", "0.4.2\0", "0.4.2\u2028", "0.4.2\u2029",
    ]) {
      await writeFile(join(root, "crytic-compile.version"), raw);
      await assert.rejects(verifyVersions(root), { code: "TOOL_VERSION_MISMATCH" }, JSON.stringify(raw));
    }
    await rm(join(root, "crytic-compile.version"));
    await assert.rejects(verifyVersions(root), { code: "TOOL_VERSION_MISMATCH" });
  } finally {await rm(root, { recursive: true, force: true });}
});
