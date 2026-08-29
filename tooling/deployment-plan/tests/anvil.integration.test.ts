import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runUnsignedPlanner } from "../src/composition/index.ts";

const binary = process.env.AGTMAI_ANVIL_BINARY; const buildInfo = process.env.AGTMAI_BUILD_INFO; const artifact = process.env.AGTMAI_CONTRACT_ARTIFACT;
test("real loopback Anvil estimates exact AGTMAIToken creation input within Foundry tolerance", { skip: !binary || !buildInfo || !artifact, timeout: 30_000 }, async () => {
  assert(binary && buildInfo && artifact); const port = await unusedPort(); const child = spawn(binary, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], { stdio: ["ignore", "ignore", "pipe"], env: {} });
  const rpcUrl = `http://127.0.0.1:${port}/`; try {
    await ready(rpcUrl); const outputParent = await mkdtemp(join(tmpdir(), "deployment-plan-anvil-"));
    const result = await runUnsignedPlanner({ rpcUrl, buildInfoPath: resolve(buildInfo), artifactPath: resolve(artifact), abiPath: resolve("contracts/evm/abi/AGTMAIToken.abi.json"), fixturePath: resolve("contracts/evm/evidence/shared-test-vector.json"), trustRootsPath: resolve("tooling/deployment-plan/trust-roots.v1.json"), outputParent, bundleName: "estimate", nowSeconds: BigInt(Math.floor(Date.now() / 1000)), maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 3_000_000_000n });
    const quote = JSON.parse(await readFile(join(result.directory, "fee-quote.v1.json"), "utf8")) as { observation: { gasEstimate: string } }; const estimate = BigInt(quote.observation.gasEstimate); const foundryMeasured = 540_495n; const difference = estimate > foundryMeasured ? estimate - foundryMeasured : foundryMeasured - estimate;
    assert(difference * 10_000n <= foundryMeasured * 3_000n, `estimate ${estimate} exceeds documented 30% tolerance from measured ${foundryMeasured}`);
  } finally { child.kill("SIGTERM"); await new Promise<void>((resolveDone) => child.once("exit", () => resolveDone())); }
});
async function unusedPort(): Promise<number> { const server = createServer(); await new Promise<void>((resolveDone) => server.listen(0, "127.0.0.1", resolveDone)); const address = server.address(); assert(address && typeof address === "object"); const port = address.port; await new Promise<void>((resolveDone) => server.close(() => resolveDone())); return port; }
async function ready(url: string): Promise<void> { for (let attempt = 0; attempt < 100; attempt += 1) { try { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }); if (response.ok) return; } catch { /* bounded readiness retry before any mutation */ } await new Promise((resolveDone) => setTimeout(resolveDone, 50)); } throw new Error("Anvil readiness timeout"); }
