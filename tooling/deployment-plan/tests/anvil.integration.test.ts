import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";
import { runUnsignedPlanner } from "../src/composition/index.ts";

const anvilBinary = process.env.AGTMAI_ANVIL_BINARY;
const forgeBinary = process.env.AGTMAI_FORGE_BINARY;
const solcBinary = process.env.AGTMAI_SOLC_BINARY;
const anyE2eConfiguration = [anvilBinary, forgeBinary, solcBinary].some(
  (value) => value !== undefined,
);

test(
  "real loopback Anvil estimates freshly built exact AGTMAIToken initcode within tolerance",
  { skip: !anyE2eConfiguration, timeout: 30_000 },
  async () => {
    const binaries = requireCompleteConfiguration();
    const build = await freshForgeBuild(binaries.forge, binaries.solc);
    const port = await unusedPort();
    const child = spawn(binaries.anvil, [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      "31337",
      "--silent",
    ], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {},
    });
    const rpcUrl = `http://127.0.0.1:${port}/`;
    try {
      await waitUntilReady(rpcUrl);
      const outputParent = await realpath(
        await mkdtemp(join(tmpdir(), "deployment-plan-anvil-")),
      );
      const result = await runUnsignedPlanner({
        rpcUrl,
        buildInfoPath: build.buildInfoPath,
        artifactPath: build.artifactPath,
        abiPath: resolvePath("contracts/evm/abi/AGTMAIToken.abi.json"),
        fixturePath: resolvePath("contracts/evm/evidence/shared-test-vector.json"),
        trustRootsPath: resolvePath("tooling/deployment-plan/trust-roots.v1.json"),
        outputParent,
        bundleName: "estimate",
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 3_000_000_000n,
      });
      const plan = JSON.parse(
        await readFile(join(result.directory, "deployment-plan.v1.json"), "utf8"),
      ) as { planId: string; identity: {
        buildInfoSolcVersion: string;
        creationInputHash: string;
        senderNonce: string;
        expectedCreateAddress: string;
      } };
      const quote = JSON.parse(
        await readFile(join(result.directory, "fee-quote.v1.json"), "utf8"),
      ) as { creationInputHash: string; observation: { gasEstimate: string } };
      assert.equal(plan.identity.buildInfoSolcVersion, "0.8.36");
      assert.equal(plan.identity.senderNonce, "0");
      assert.equal(plan.identity.expectedCreateAddress, "0x522b3294e6d06aa25ad0f1b8891242e335d3b459");
      assert.equal(quote.creationInputHash, plan.identity.creationInputHash);
      assertWithinFoundryTolerance(BigInt(quote.observation.gasEstimate));

      await testOnlyRpc(rpcUrl, "anvil_setNonce", [
        "0x0000000000000000000000000000000000000001", "0x1",
      ]);
      const nonceOneResult = await runUnsignedPlanner({
        rpcUrl,
        buildInfoPath: build.buildInfoPath,
        artifactPath: build.artifactPath,
        abiPath: resolvePath("contracts/evm/abi/AGTMAIToken.abi.json"),
        fixturePath: resolvePath("contracts/evm/evidence/shared-test-vector.json"),
        trustRootsPath: resolvePath("tooling/deployment-plan/trust-roots.v1.json"),
        outputParent,
        bundleName: "estimate-nonce-one",
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 3_000_000_000n,
      });
      const nonceOnePlan = JSON.parse(
        await readFile(join(nonceOneResult.directory, "deployment-plan.v1.json"), "utf8"),
      ) as { planId: string; identity: { senderNonce: string; expectedCreateAddress: string } };
      assert.equal(nonceOnePlan.identity.senderNonce, "1");
      assert.equal(
        nonceOnePlan.identity.expectedCreateAddress,
        "0x535b3d7a252fa034ed71f0c53ec0c6f784cb64e1",
      );
      assert.notEqual(nonceOnePlan.planId, plan.planId);
    } finally {
      await stop(child);
    }
  },
);

interface E2eBinaries {
  readonly anvil: string;
  readonly forge: string;
  readonly solc: string;
}

interface FreshBuild {
  readonly artifactPath: string;
  readonly buildInfoPath: string;
}

function requireCompleteConfiguration(): E2eBinaries {
  assert(
    anvilBinary && forgeBinary && solcBinary,
    "Anvil E2E requires AGTMAI_ANVIL_BINARY, AGTMAI_FORGE_BINARY, and AGTMAI_SOLC_BINARY together",
  );
  return { anvil: anvilBinary, forge: forgeBinary, solc: solcBinary };
}

async function freshForgeBuild(forge: string, solc: string): Promise<FreshBuild> {
  const directory = await mkdtemp(join(tmpdir(), "deployment-plan-forge-"));
  const output = join(directory, "out");
  const cache = join(directory, "cache");
  const buildInfo = join(directory, "build-info");
  await runProcess(forge, [
    "build",
    "--root",
    resolvePath("contracts/evm"),
    "--use",
    resolvePath(solc),
    "--out",
    output,
    "--cache-path",
    cache,
    "--build-info",
    "--build-info-path",
    buildInfo,
    "--no-lint",
    "src/features/token-genesis/AGTMAIToken.sol",
  ]);
  const buildInfoFiles = (await readdir(buildInfo)).filter((name) => name.endsWith(".json"));
  assert.equal(
    buildInfoFiles.length,
    1,
    `fresh Forge build produced ${buildInfoFiles.length} build-info files instead of one`,
  );
  return {
    artifactPath: join(output, "AGTMAIToken.sol", "AGTMAIToken.json"),
    buildInfoPath: join(buildInfo, buildInfoFiles[0] as string),
  };
}

async function runProcess(binary: string, arguments_: string[]): Promise<void> {
  const child = spawn(binary, arguments_, {
    stdio: ["ignore", "ignore", "pipe"],
    env: {},
  });
  let standardError = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    standardError += chunk;
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  assert.equal(
    exit.code,
    0,
    `fresh Forge build failed (${exit.signal ?? exit.code}): ${standardError}`,
  );
}

function assertWithinFoundryTolerance(estimate: bigint): void {
  const foundryMeasured = 540_495n;
  const difference = estimate > foundryMeasured
    ? estimate - foundryMeasured
    : foundryMeasured - estimate;
  assert(
    difference * 10_000n <= foundryMeasured * 3_000n,
    `estimate ${estimate} exceeds documented 30% tolerance from measured ${foundryMeasured}`,
  );
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const { port } = address;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

async function waitUntilReady(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Bounded readiness retry before any mutation.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error("Anvil readiness timeout");
}

async function testOnlyRpc(url: string, method: string, params: readonly unknown[]): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert(response.ok, `test-only Anvil RPC ${method} returned HTTP ${response.status}`);
  const body = await response.json() as { result?: unknown; error?: unknown };
  assert.equal(body.error, undefined, `test-only Anvil RPC ${method} failed`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}
