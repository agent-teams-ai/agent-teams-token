import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runUnsignedPlanner, type PlannerInput } from "../src/composition/index.ts";
import type { TrustRoots } from "../src/application/ports.ts";
import { canonicalBuildInfoSha256, portableCompilerInputSha256 } from "../src/adapters/artifact.ts";
import { sha256Hex } from "../src/domain/identity.ts";
import { parseNativeNoReplaceEvidence, parseReadyMarker } from "../src/adapters/strict-json.ts";
import { ownedTemporaryDirectory } from "./helpers/temporary-directory.ts";

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
        AGTMAIToken: {
          abi,
          evm: { bytecode: { object: "60016000", linkReferences: {} } },
        },
      },
    },
  },
};
const artifact = { abi, bytecode: { object: "0x60016000" } };
const fixture = {
  initialSupply: "1",
  allocations: [{
    id: `0x${"1".repeat(64)}`,
    recipient: "0x0000000000000000000000000000000000000001",
    amount: "1",
  }],
};
const json = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const artifactBytes = json(artifact);
const abiBytes = json(abi);
const fixtureBytes = json(fixture);
const hash = `0x${"a".repeat(64)}`;
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
  buildInfoSolcVersion: "0.8.36",
  canonicalBuildInfoSha256: canonicalBuildInfoSha256(build),
  compilerInputSha256: portableCompilerInputSha256(build.input),
  compilerSettings: settings,
  artifactSha256: sha256Hex(artifactBytes),
  abiSha256: sha256Hex(abiBytes),
  fixtureSha256: sha256Hex(fixtureBytes),
  fixtureReadySha256: `0x${"0".repeat(64)}`,
  constructorArgumentsHash: "0x9427b845cd0de51bf3d29fe925976e092cc2024522e96766241f685d43937c60",
  creationInputHash: "0x5cc2acd863cd3616f9df0e39cbd0948358b18c0cd4322291b65a65ea68311cb6",
  sourceDependencyClosure: {
    "src/features/token-genesis/AGTMAIToken.sol": sha256Hex(source),
  },
};

test("planner publishes canonical native evidence and READY V3 last", async (context) => {
  context.mock.method(Date, "now", () => 110_000);
  const rpc = await startRpc(() => "0x64");
  try {
    const prepared = await prepare(rpc.url, "complete");
    const result = await runUnsignedPlanner(prepared.input);
    assert.deepEqual((await readdir(result.directory)).toSorted(), ["READY", "deployment-plan.v2.json", "fee-quote.v2.json", "native-no-replace-evidence.v1.json"].toSorted());
    const evidenceBytes = await readFile(join(result.directory, "native-no-replace-evidence.v1.json"));
    const evidence = parseNativeNoReplaceEvidence(evidenceBytes);
    const ready = parseReadyMarker(await readFile(join(result.directory, "READY")));
    const expectedNative = process.platform === "darwin"
      ? { platform: "darwin-arm64", compilerSha256: "0x7588ceab299393618d6f8861502ac0588d1594025f301d9a61a898215b5571d3", executableSha256: "0x333d90f849c3116bf477678e9439abce54bcf2eed1c724652e70172f69ae584e" }
      : { platform: "linux-x64", compilerSha256: "0x1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26", executableSha256: "0x814aba8dfb8f176c252a3fc8f4aa8564723c0790613ee101a9a45fc41f629e9b" };
    assert.equal(evidence.platform, expectedNative.platform);
    assert.equal(evidence.compilerSha256, expectedNative.compilerSha256);
    assert.equal(evidence.executableSha256, expectedNative.executableSha256);
    if (process.platform === "linux") {
      assert.equal(evidence.approvalSha256, "0x1799839fd965cd6297ed95a1676070687d52fbdb5343c54fae05598c14b61e8c");
    }
    assert.equal(result.nativeNoReplaceEvidenceSha256, sha256Hex(evidenceBytes));
    assert.equal(ready.nativeNoReplaceEvidenceSha256, result.nativeNoReplaceEvidenceSha256);
  } finally { await close(rpc.server); }
});

test("estimate N to N+1 during pre-publication verification leaves no output", async (context) => {
  context.mock.method(Date, "now", () => 110_000);
  const rpc = await startRpc((estimateRead) => estimateRead === 1 ? "0x64" : "0x65");
  try {
    const prepared = await prepare(rpc.url, "drift");
    await assert.rejects(runUnsignedPlanner(prepared.input), /estimate changed/u);
    assert.deepEqual(await readdir(prepared.outputParent), []);
  } finally {
    await close(rpc.server);
  }
});

test("expiry during a planner run is caught by the trusted pre-publication clock", async (context) => {
  let clockRead = 0;
  context.mock.method(Date, "now", () => {
    clockRead += 1;
    return clockRead === 1 ? 110_000 : 170_000;
  });
  const rpc = await startRpc(() => "0x64");
  try {
    const prepared = await prepare(rpc.url, "expiry");
    await assert.rejects(runUnsignedPlanner(prepared.input), /expiresAt/u);
    assert(clockRead >= 2, "planner must reread the trusted clock before publication");
    assert.deepEqual(await readdir(prepared.outputParent), []);
  } finally {
    await close(rpc.server);
  }
});

async function prepare(rpcUrl: string, bundleName: string): Promise<{
  readonly input: PlannerInput;
  readonly outputParent: string;
}> {
  const directory = await ownedTemporaryDirectory("deployment-planner-run-");
  const outputParent = await ownedTemporaryDirectory("deployment-planner-output-");
  const paths = {
    buildInfoPath: join(directory, "build.json"),
    artifactPath: join(directory, "artifact.json"),
    abiPath: join(directory, "abi.json"),
    fixturePath: join(directory, "fixture.json"),
    trustRootsPath: join(directory, "roots.json"),
  };
  await Promise.all([
    writeFile(paths.buildInfoPath, json(build)),
    writeFile(paths.artifactPath, artifactBytes),
    writeFile(paths.abiPath, abiBytes),
    writeFile(paths.fixturePath, fixtureBytes),
    writeFile(paths.trustRootsPath, json(roots)),
  ]);
  return {
    outputParent,
    input: {
      rpcUrl,
      ...paths,
      outputParent,
      bundleName,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 2n,
    },
  };
}

async function startRpc(estimate: (read: number) => string): Promise<{
  readonly server: Server;
  readonly url: string;
}> {
  let estimateRead = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const call = JSON.parse(body) as { id: number; method: string };
      const result = rpcResult(call.method, () => estimate(++estimateRead));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function rpcResult(method: string, estimate: () => string): unknown {
  switch (method) {
    case "eth_chainId": return "0x7a69";
    case "eth_getBlockByNumber": return {
      number: "0xa",
      hash,
      timestamp: "0x64",
      gasLimit: "0x3e8",
      baseFeePerGas: "0x1",
    };
    case "eth_feeHistory": return { oldestBlock: "0xa", baseFeePerGas: ["0x1", "0x2"] };
    case "eth_getTransactionCount": return "0x0";
    case "eth_estimateGas": return estimate();
    default: throw new Error(`unexpected RPC method: ${method}`);
  }
}

function close(server: Server): void {
  server.close();
  server.closeAllConnections();
}
