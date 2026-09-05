import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";
import { ownedTemporaryDirectory } from "./helpers/temporary-directory.ts";
import { runUnsignedPlanner } from "../src/composition/index.ts";
import { pinnedFoundryBinaries } from "../../local-evm/toolchain.ts";

const repositoryRoot = await realpath(resolvePath(import.meta.dirname, "../../.."));
const anvilBinary = process.env.AGTMAI_ANVIL_BINARY;
const forgeBinary = process.env.AGTMAI_FORGE_BINARY;
const solcBinary = process.env.AGTMAI_SOLC_BINARY;
const anyE2eConfiguration = [anvilBinary, forgeBinary, solcBinary].some(
  (value) => value !== undefined,
);
const noOperation = (): void => {};

test(
  "real loopback Anvil estimates freshly built exact AGTMAIToken initcode within tolerance",
  { skip: !anyE2eConfiguration, timeout: 90_000 },
  async () => {
    const binaries = requireCompleteConfiguration();
    let build: FreshBuild | undefined;
    let child: ChildProcess | undefined;
    let outputParent: string | undefined;
    let testFailure: unknown;
    try {
      build = await freshForgeBuild(binaries.forge, binaries.solc);
      const started = await startAnvil(binaries.anvil);
      child = started.child;
      const { rpcUrl } = started;
      await waitUntilReady(rpcUrl);
      outputParent = await ownedTemporaryDirectory("deployment-plan-anvil-");
      const result = await runUnsignedPlanner({
        rpcUrl,
        buildInfoPath: build.buildInfoPath,
        artifactPath: build.artifactPath,
        abiPath: resolvePath("contracts/evm/abi/AGTMAIToken.abi.json"),
        fixturePath: resolvePath("contracts/evm/evidence/shared-test-vector.json"),
        trustRootsPath: resolvePath("tooling/deployment-plan/trust-roots.v2.json"),
        outputParent,
        bundleName: "estimate",
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 3_000_000_000n,
      });
      const plan = JSON.parse(
        await readFile(join(result.directory, "deployment-plan.v2.json"), "utf8"),
      ) as { planId: string; identity: {
        buildInfoSolcVersion: string;
        rawBuildInfoSha256: string;
        canonicalBuildInfoSha256: string;
        creationInputHash: string;
      } };
      const quote = JSON.parse(
        await readFile(join(result.directory, "fee-quote.v2.json"), "utf8"),
      ) as {
        planId: string;
        creationInputHash: string;
        observation: {
          senderNonce: string;
          expectedCreateAddress: string;
          gasEstimate: string;
        };
      };
      assert.equal(plan.identity.buildInfoSolcVersion, "0.8.36");
      assert.notEqual(
        plan.identity.rawBuildInfoSha256,
        plan.identity.canonicalBuildInfoSha256,
      );
      assert.equal(quote.observation.senderNonce, "0");
      assert.equal(
        quote.observation.expectedCreateAddress,
        "0x522b3294e6d06aa25ad0f1b8891242e335d3b459",
      );
      assert.equal(quote.planId, plan.planId);
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
        trustRootsPath: resolvePath("tooling/deployment-plan/trust-roots.v2.json"),
        outputParent,
        bundleName: "estimate-nonce-one",
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 3_000_000_000n,
      });
      const nonceOnePlan = JSON.parse(
        await readFile(join(nonceOneResult.directory, "deployment-plan.v2.json"), "utf8"),
      ) as { planId: string; identity: { creationInputHash: string } };
      const nonceOneQuote = JSON.parse(
        await readFile(join(nonceOneResult.directory, "fee-quote.v2.json"), "utf8"),
      ) as typeof quote;
      assert.equal(nonceOneQuote.observation.senderNonce, "1");
      assert.equal(
        nonceOneQuote.observation.expectedCreateAddress,
        "0x535b3d7a252fa034ed71f0c53ec0c6f784cb64e1",
      );
      assert.equal(nonceOnePlan.planId, plan.planId);
      assert.equal(nonceOneQuote.planId, nonceOnePlan.planId);
      assert.equal(nonceOnePlan.identity.creationInputHash, plan.identity.creationInputHash);
      assert.equal(nonceOneQuote.creationInputHash, quote.creationInputHash);
      assert.notDeepEqual(nonceOneQuote, quote);
      assert.notEqual(nonceOneQuote.observation.senderNonce, quote.observation.senderNonce);
      assert.notEqual(
        nonceOneQuote.observation.expectedCreateAddress,
        quote.observation.expectedCreateAddress,
      );
    } catch (error) {
      testFailure = error;
    }
    const cleanup = await Promise.allSettled([
      child === undefined ? Promise.resolve() : stop(child),
      outputParent === undefined
        ? Promise.resolve()
        : rm(outputParent, { recursive: true, force: true }),
      build === undefined
        ? Promise.resolve()
        : rm(build.directory, { recursive: true, force: true }),
    ]);
    const cleanupFailure = cleanup.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (testFailure !== undefined && cleanupFailure !== undefined) {
      throw new AggregateError([testFailure, cleanupFailure.reason], "E2E and cleanup failed");
    }
    if (testFailure !== undefined) {
      throw testFailure;
    }
    if (cleanupFailure !== undefined) {
      throw cleanupFailure.reason;
    }
  },
);

interface E2eBinaries {
  readonly anvil: string;
  readonly forge: string;
  readonly solc: string;
}

interface FreshBuild {
  readonly directory: string;
  readonly artifactPath: string;
  readonly buildInfoPath: string;
}

function requireCompleteConfiguration(): E2eBinaries {
  assert(
    anvilBinary && forgeBinary && solcBinary,
    "Anvil E2E requires AGTMAI_ANVIL_BINARY, AGTMAI_FORGE_BINARY, and AGTMAI_SOLC_BINARY together",
  );
  const foundry = pinnedFoundryBinaries(repositoryRoot);
  return { anvil: foundry.anvil, forge: foundry.forge, solc: solcBinary };
}

async function freshForgeBuild(forge: string, solc: string): Promise<FreshBuild> {
  const directory = await ownedTemporaryDirectory("deployment-plan-forge-");
  const output = join(directory, "out");
  const cache = join(directory, "cache");
  const buildInfo = join(directory, "build-info");
  try {
    await runProcess(forge, [
      "build",
      "--offline",
      "--no-auto-detect",
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
    ], {environment: await privateFoundryEnvironment(directory), timeoutMs: 60_000});
    const buildInfoFiles = (await readdir(buildInfo)).filter((name) => name.endsWith(".json"));
    assert.equal(
      buildInfoFiles.length,
      1,
      `fresh Forge build produced ${buildInfoFiles.length} build-info files instead of one`,
    );
    return {
      directory,
      artifactPath: join(output, "AGTMAIToken.sol", "AGTMAIToken.json"),
      buildInfoPath: join(buildInfo, buildInfoFiles[0] as string),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function privateFoundryEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, name] of [
    ["HOME", "home"],
    ["XDG_CACHE_HOME", "xdg-cache"],
    ["XDG_CONFIG_HOME", "xdg-config"],
    ["XDG_DATA_HOME", "xdg-data"],
    ["XDG_RUNTIME_DIR", "xdg-runtime"],
  ] as const) {
    const path = join(root, name);
    await mkdir(path, {mode: 0o700});
    environment[key] = path;
  }
  return environment;
}

async function runProcess(
  binary: string,
  arguments_: string[],
  options: {readonly environment?: NodeJS.ProcessEnv; readonly shutdownGraceMs?: number; readonly timeoutMs?: number} = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const shutdownGraceMs = options.shutdownGraceMs ?? 1_000;
  const child = spawn(binary, arguments_, {
    stdio: ["ignore", "ignore", "pipe"],
    env: options.environment ?? {},
  });
  let standardError = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    standardError += chunk;
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        stop(child, shutdownGraceMs)
          .then((escalated) => reject(new Error(
            `process timed out after ${timeoutMs}ms${escalated ? " and escalated to SIGKILL" : ""}`,
          )), reject);
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timeout);
        if (!timedOut) {
          reject(error);
        }
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        if (!timedOut) {
          resolve({ code, signal });
        }
      });
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

async function startAnvil(binary: string): Promise<{
  readonly child: ChildProcess;
  readonly rpcUrl: string;
}> {
  const child = spawn(binary, [
    "--host", "127.0.0.1", "--port", "0", "--chain-id", "31337",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {},
  });
  const rpcUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Anvil did not report its owned listener: ${output.slice(-2_000)}`));
    }, 5_000);
    const consume = (chunk: Buffer | string): void => {
      output += chunk.toString();
      const match = /Listening on 127\.0\.0\.1:(\d+)/u.exec(output);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}/`);
      }
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Anvil exited before reporting its listener (${signal ?? code}): ${output.slice(-2_000)}`));
    });
  }).catch(async (error: unknown) => {
    await stop(child);
    throw error;
  });
  return { child, rpcUrl };
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

async function stop(
  child: ChildProcess,
  graceMs = 1_000,
  killWaitMs = 1_000,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return false;
  }
  child.kill("SIGTERM");
  if (await waitForExit(child, graceMs)) {
    return false;
  }
  child.kill("SIGKILL");
  if (!await waitForExit(child, killWaitMs)) {
    throw new Error("child did not exit after SIGKILL");
  }
  return true;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  let onExit: () => void = noOperation;
  const exited = new Promise<boolean>((resolve) => {
    onExit = () => resolve(true);
    child.once("exit", onExit);
  });
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([exited, deadline]);
  clearTimeout(timeout);
  child.removeListener("exit", onExit);
  return result;
}

test("bounded shutdown escalates a SIGTERM-resistant child to SIGKILL", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
  ], { stdio: ["ignore", "pipe", "ignore"], env: {} });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.once("data", () => resolve());
  });
  assert.equal(await stop(child, 50), true);
  assert.equal(child.signalCode, "SIGKILL");
});

test("process execution timeout is bounded", async () => {
  await assert.rejects(
    runProcess(process.execPath, [
      "-e",
      "setInterval(()=>{},1000)",
    ], {timeoutMs: 100, shutdownGraceMs: 50}),
    /timed out/u,
  );
});
