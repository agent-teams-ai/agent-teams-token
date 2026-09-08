import { approveForgeArtifact, canonicalBuildInfoSha256, portableCompilerInputSha256, type TrustRoots } from "../src/adapters/artifact.ts";
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
const forgeRoot = "/workspace/contracts/evm";
const build = {
  id: "0123456789abcdef",
  solcVersion: "0.8.36",
  solcLongVersion: "0.8.36",
  input: {
    allowPaths: [forgeRoot, `${forgeRoot}/lib`],
    basePath: forgeRoot,
    includePaths: [forgeRoot],
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
  maximumWorstCaseWei: "1000000",
  gasBufferBps: "0",
  quoteTtlSeconds: "60",
  maximumHeadLag: "1",
  buildInfoSolcVersion: build.solcVersion,
  canonicalBuildInfoSha256: canonicalBuildInfoSha256(build),
  compilerInputSha256: portableCompilerInputSha256(build.input),
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

export { inputs as artifactInputs, roots };
export const approvedArtifact = approveForgeArtifact(inputs, roots);
