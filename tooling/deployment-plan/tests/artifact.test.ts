import assert from "node:assert/strict";
import test from "node:test";
import {
  approveForgeArtifact,
  encodeConstructor,
  portableCompilerInputSha256,
  type TrustRoots,
} from "../src/adapters/artifact.ts";
import { canonicalJson, sha256Hex } from "../src/domain/identity.ts";
import { UINT256_MAX } from "../src/domain/model.ts";

const source = "contract X {}";
const settings = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "paris",
  metadata: { bytecodeHash: "ipfs", appendCBOR: true },
};
const constructor = {
  type: "constructor",
  stateMutability: "nonpayable",
  inputs: [
    { name: "initialSupply", type: "uint256" },
    {
      name: "sortedAllocations",
      type: "tuple[]",
      components: [
        { name: "id", type: "bytes32" },
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
  ],
};
const abi = [constructor];
const bytecode = "60016000";
const build = {
  solcVersion: "0.8.36",
  solcLongVersion: "0.8.36",
  input: {
    settings,
    sources: { "src/features/token-genesis/AGTMAIToken.sol": { content: source } },
  },
  output: {
    contracts: {
      "src/features/token-genesis/AGTMAIToken.sol": {
        AGTMAIToken: { abi, evm: { bytecode: { object: bytecode, linkReferences: {} } } },
      },
    },
  },
};
const artifact = { abi, bytecode: { object: `0x${bytecode}` } };
const fixture = {
  initialSupply: "1",
  allocations: [{
    id: `0x${"1".repeat(64)}`,
    recipient: "0x0000000000000000000000000000000000000001",
    amount: "1",
  }],
};
const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const inputs = {
  buildInfoBytes: bytes(build),
  artifactBytes: bytes(artifact),
  abiBytes: bytes(abi),
  fixtureBytes: bytes(fixture),
  constructorValues: fixture,
};
const roots: TrustRoots = {
  schemaVersion: 2,
  testOnly: true,
  productionApproved: false,
  mainnetAllowed: false,
  chainId: "31337",
  contractFqn: "src/features/token-genesis/AGTMAIToken.sol:AGTMAIToken",
  buildProfile: "default",
  from: "0x0000000000000000000000000000000000000001",
  maximumWorstCaseWei: "1",
  gasBufferBps: "0",
  quoteTtlSeconds: "60",
  maximumHeadLag: "1",
  buildInfoSolcVersion: build.solcVersion,
  buildInfoSha256: sha256Hex(inputs.buildInfoBytes),
  compilerInputSha256: sha256Hex(canonicalJson(build.input)),
  compilerSettings: settings,
  artifactSha256: sha256Hex(inputs.artifactBytes),
  abiSha256: sha256Hex(inputs.abiBytes),
  fixtureSha256: sha256Hex(inputs.fixtureBytes),
  fixtureReadySha256: `0x${"0".repeat(64)}`,
  constructorArgumentsHash: "0x9427b845cd0de51bf3d29fe925976e092cc2024522e96766241f685d43937c60",
  creationInputHash: "0x5cc2acd863cd3616f9df0e39cbd0948358b18c0cd4322291b65a65ea68311cb6",
  sourceDependencyClosure: {
    "src/features/token-genesis/AGTMAIToken.sol": sha256Hex(source),
  },
};

test("golden constructor vector binds build, ABI, bytecode and exact initcode", () => {
  const approved = approveForgeArtifact(inputs, roots);
  assert.equal(approved.constructorArguments, encodeConstructor(fixture));
  assert.equal(
    approved.creationInput,
    `${approved.creationBytecode}${approved.constructorArguments.slice(2)}`,
  );
  assert.equal(approved.creationInputHash.length, 66);
  assert.equal(approved.buildInfoSolcVersion, "0.8.36");
  assert.equal(approved.compilerInputSha256, roots.compilerInputSha256);
});

test("byte-oriented SHA-256 uses the shared cross-tool vector", () => {
  assert.equal(
    sha256Hex(Buffer.from("01020304", "hex")),
    "0x9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
  );
});

test("full canonical compiler input is an immutable trust root", () => {
  const variants = [
    { ...build.input, settings: { ...settings, viaIR: true } },
    { ...build.input, settings: { ...settings, optimizer: { ...settings.optimizer, details: { yul: true } } } },
    { ...build.input, settings: { ...settings, libraries: { "X.sol": { X: "0x0000000000000000000000000000000000000001" } } } },
    { ...build.input, settings: { ...settings, remappings: ["lib/=vendor/"] } },
    { ...build.input, settings: { ...settings, outputSelection: { "*": { "*": ["abi"] } } } },
  ];
  for (const input of variants) {
    const buildInfoBytes = bytes({ ...build, input });
    assert.throws(
      () => approveForgeArtifact(
        { ...inputs, buildInfoBytes },
        { ...roots, buildInfoSha256: sha256Hex(buildInfoBytes) },
      ),
      /compiler input/u,
    );
  }
});

test("compiler input identity is portable but validates Forge root paths exactly", () => {
  const firstRoot = "/Users/example/project/contracts/evm";
  const secondRoot = "/home/runner/work/project/contracts/evm";
  const withRoot = (basePath: string) => ({
    ...build.input,
    allowPaths: [basePath, `${basePath}/lib`],
    basePath,
    includePaths: [basePath],
  });
  assert.equal(
    portableCompilerInputSha256(withRoot(firstRoot)),
    portableCompilerInputSha256(withRoot(secondRoot)),
  );
  assert.throws(
    () => portableCompilerInputSha256({
      ...withRoot(firstRoot),
      allowPaths: [firstRoot, "/tmp/untrusted"],
    }),
    /compiler input Forge paths/u,
  );
  assert.throws(
    () => portableCompilerInputSha256({
      ...withRoot(firstRoot),
      basePath: `${firstRoot}/../evm`,
    }),
    /compiler input Forge paths/u,
  );
});

test("constructor integers enforce the exact uint256 boundary", () => {
  assert.doesNotThrow(() => encodeConstructor({ ...fixture, initialSupply: UINT256_MAX.toString() }));
  assert.throws(
    () => encodeConstructor({ ...fixture, initialSupply: (UINT256_MAX + 1n).toString() }),
    /uint256/u,
  );
});

test("build/artifact/ABI/constructor mismatches fail independently", () => {
  const alteredArtifact = { ...artifact, bytecode: { object: "0x00" } };
  assert.throws(
    () => approveForgeArtifact(
      { ...inputs, artifactBytes: bytes(alteredArtifact) },
      { ...roots, artifactSha256: sha256Hex(bytes(alteredArtifact)) },
    ),
    /differs/u,
  );
  const alteredAbi = [{ ...constructor, stateMutability: "payable" }];
  assert.throws(
    () => approveForgeArtifact(
      { ...inputs, abiBytes: bytes(alteredAbi) },
      { ...roots, abiSha256: sha256Hex(bytes(alteredAbi)) },
    ),
    /ABI\/build/u,
  );
  assert.throws(
    () => approveForgeArtifact(
      { ...inputs, constructorValues: { ...fixture, initialSupply: "x" } },
      roots,
    ),
    /integer/u,
  );
});

test("exact build-info bytes are an independent trust root", () => {
  const alteredBytes = bytes({ ...build, solcLongVersion: "0.8.36+untrusted-label" });
  assert.throws(
    () => approveForgeArtifact({ ...inputs, buildInfoBytes: alteredBytes }, roots),
    /build-info digest/u,
  );
});

test("compiler trust binds Forge build-info solcVersion exactly", () => {
  const alteredBuild = {
    ...build,
    solcVersion: "0.8.35",
    solcLongVersion: roots.buildInfoSolcVersion,
  };
  const buildInfoBytes = bytes(alteredBuild);
  assert.throws(
    () => approveForgeArtifact(
      { ...inputs, buildInfoBytes },
      { ...roots, buildInfoSha256: sha256Hex(buildInfoBytes) },
    ),
    /solcVersion/u,
  );
});
