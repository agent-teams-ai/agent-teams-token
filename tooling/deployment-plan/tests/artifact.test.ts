import assert from "node:assert/strict";
import test from "node:test";
import { approveForgeArtifact, encodeConstructor, type TrustRoots } from "../src/adapters/artifact.ts";
import { sha256Hex } from "../src/domain/identity.ts";

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
  schemaVersion: 1,
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
  compilerSettings: settings,
  artifactSha256: sha256Hex(inputs.artifactBytes),
  abiSha256: sha256Hex(inputs.abiBytes),
  fixtureSha256: sha256Hex(inputs.fixtureBytes),
  fixtureReadySha256: `0x${"0".repeat(64)}`,
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

test("compiler trust binds only Forge build-info solcVersion exactly", () => {
  assert.throws(
    () => approveForgeArtifact({
      ...inputs,
      buildInfoBytes: bytes({
        ...build,
        solcVersion: "0.8.35",
        solcLongVersion: roots.buildInfoSolcVersion,
      }),
    }, roots),
    /solcVersion/u,
  );
  const differentLongLabel = approveForgeArtifact({
    ...inputs,
    buildInfoBytes: bytes({
      ...build,
      solcLongVersion: "0.8.36+commit.not-evidence",
    }),
  }, roots);
  assert.equal(differentLongLabel.buildInfoSolcVersion, roots.buildInfoSolcVersion);
});
