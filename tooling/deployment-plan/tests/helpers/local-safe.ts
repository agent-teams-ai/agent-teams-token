import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import type { Hex } from "@agent-teams/supply/deployment";
import { startOwnedAnvil } from "../../../local-evm/process.ts";
import { authenticateFoundryBinaries, pinnedFoundryBinary } from "../../../local-evm/toolchain.ts";
import { qualifySafeArtifacts, type SafeArtifactPins } from "../../../testnet-ccip/src/adapters/safe-artifacts.ts";
import { custodyKeccak, custodyTopic } from "../../../testnet-ccip/src/adapters/safe-custody.ts";

export const ZERO = `0x${"0".repeat(40)}` as Hex;
export const word = (value: bigint) => value.toString(16).padStart(64, "0");
const execAbi = "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)";
const hashAbi = "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)";
type Key = { owner: Hex; path: string };

/** Owned chain, test-only identities and official provisioned Safe 1.4.1 bytes. */
export async function setupLocalSafes(t: TestContext, count: 1 | 2 = 1) {
  const root = resolve(".");
  const selected = process.env.AGTMAI_SAFE_PINS_SHA256 as Hex | undefined;
  const directory = process.env.AGTMAI_SAFE_ARTIFACT_DIRECTORY;
  assert.ok(directory && selected, "SAFE_OFFICIAL_ARTIFACTS_REQUIRED: set AGTMAI_SAFE_ARTIFACT_DIRECTORY and AGTMAI_SAFE_PINS_SHA256");
  const temporary = await mkdtemp(join(tmpdir(), "agtmai-local-safe-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const install = join(root, ".tools/foundry-v1.8.0-linux-x64");
  const foundry = authenticateFoundryBinaries(root, { anvil: join(install, "anvil"), cast: join(install, "cast"), forge: join(install, "forge") });
  const cast = pinnedFoundryBinary(root, foundry, "cast");
  const run = (args: string[]): Promise<string> => new Promise((done, reject) => {
    execFile(cast, args, { timeout: 30_000, maxBuffer: 2_000_000 }, (error, stdout) => error ? reject(error) : done(stdout.trim()));
  });
  const keys: Key[] = [];
  for (const name of [...Array.from({ length: count * 3 }, (_, i) => `owner-${i}`), "executor"]) {
    await run(["wallet", "new", temporary, name, "--unsafe-password", "local-test-only"]);
    const path = join(temporary, name);
    keys.push({ path, owner: (await run(["wallet", "address", "--keystore", path, "--password", "local-test-only"])).toLowerCase() as Hex });
  }
  const executor = keys.at(-1)!;
  const anvil = await startOwnedAnvil(pinnedFoundryBinary(root, foundry, "anvil"), executor.owner, undefined, { timestamp: "1799999900" });
  t.after(() => anvil.stop());
  let id = 0;
  const rpc = async (method: string, params: unknown[] = []): Promise<any> => {
    const response = await fetch(anvil.rpcUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
    return body.result;
  };
  assert.equal(await rpc("eth_chainId"), "0x7a69");
  await rpc("anvil_setBlockTimestampInterval", [1]);
  const beforeSlowOperation = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  await delay(1_200);
  await rpc("evm_mine");
  assert.equal(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp), beforeSlowOperation + 1n);
  const encode = (signature: string, args: string[]) => run(["calldata", signature, ...args]) as Promise<Hex>;
  const call = async (to: Hex, signature: string, args: string[] = [], options: { from?: Hex; block?: Hex } = {}) => rpc("eth_call", [{ to, data: await encode(signature, args), ...(options.from ? { from: options.from } : {}) }, options.block ?? "latest"]) as Promise<Hex>;
  const send = async (to: Hex | null, data: Hex) => {
    const nonce = await rpc("eth_getTransactionCount", [executor.owner, "latest"]);
    const hash = await run(["send", "--rpc-url", anvil.rpcUrl, "--chain", "31337", "--keystore", executor.path, "--password", "local-test-only", "--gas-limit", "6000000", "--async", ...(to ? [to, data] : ["--create", data])]);
    for (let attempt = 0; attempt < 200; attempt++) {
      const receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (receipt) {
        const transaction = await rpc("eth_getTransactionByHash", [hash]);
        assert.equal(transaction.from.toLowerCase(), executor.owner);
        assert.equal(transaction.nonce, nonce);
        assert.equal(transaction.input.toLowerCase(), data.toLowerCase());
        assert.equal(transaction.to?.toLowerCase() ?? null, to?.toLowerCase() ?? null);
        return receipt;
      }
      await delay(25);
    }
    throw new Error(`Unresolved local transaction ${hash}; do not resubmit`);
  };
  const deploy = async (initcode: Hex): Promise<Hex> => {
    const receipt = await send(null, initcode);
    assert.equal(receipt.status, "0x1");
    return (receipt.contractAddress as Hex).toLowerCase() as Hex;
  };
  const pins = JSON.parse(await readFile(join(directory, "pins.json"), "utf8")) as SafeArtifactPins;
  const bytes = { proxy: await readFile(join(directory, "SafeProxy.json")), singleton: await readFile(join(directory, "Safe.json")), buildInfo: await readFile(join(directory, "build-info.json")) };
  qualifySafeArtifacts(pins, selected, bytes, "0x0000000000000000000000000000000000000099");
  const singleton = await deploy(JSON.parse(bytes.singleton.toString()).bytecode);
  qualifySafeArtifacts(pins, selected, bytes, singleton);
  const safes: { safe: Hex; owners: Hex[]; keys: Key[]; setup: { status: string; transactionHash: Hex } }[] = [];
  for (let index = 0; index < count; index++) {
    const safe = await deploy(`${JSON.parse(bytes.proxy.toString()).bytecode}${word(BigInt(singleton))}` as Hex);
    const owners = keys.slice(index * 3, index * 3 + 3);
    const setup = await send(safe, await encode("setup(address[],uint256,address,bytes,address,address,uint256,address)", [`[${owners.map(key => key.owner).join(",")}]`, "2", ZERO, "0x", ZERO, ZERO, "0", ZERO]));
    assert.equal(setup.status, "0x1");
    assert.equal(await call(safe, "VERSION()"), `0x${word(32n)}${word(5n)}${Buffer.from("1.4.1").toString("hex").padEnd(64, "0")}`);
    assert.equal(BigInt(await call(safe, "getThreshold()")), 2n);
    const ownerResult = await call(safe, "getOwners()");
    assert.equal(BigInt(`0x${ownerResult.slice(66, 130)}`), 3n);
    assert.deepEqual([0, 1, 2].map(i => `0x${ownerResult.slice(130 + i * 64 + 24, 130 + (i + 1) * 64)}`).toSorted(), owners.map(key => key.owner).toSorted());
    assert.equal(BigInt(await call(safe, "nonce()")), 0n);
    const modules = await call(safe, "getModulesPaginated(address,uint256)", ["0x0000000000000000000000000000000000000001", "10"]);
    assert.equal(BigInt(`0x${modules.slice(66, 130)}`), 1n);
    assert.equal(BigInt(`0x${modules.slice(130, 194)}`), 0n);
    assert.equal(BigInt(await rpc("eth_getStorageAt", [safe, "0x0", "latest"])), BigInt(singleton));
    assert.equal(custodyKeccak(Buffer.from((await rpc("eth_getCode", [safe, "latest"])).slice(2), "hex")), pins.proxy.runtimeKeccak256);
    safes.push({ safe, owners: owners.map(key => key.owner), keys: owners, setup });
  }
  assert.equal(custodyKeccak(Buffer.from((await rpc("eth_getCode", [singleton, "latest"])).slice(2), "hex")), pins.singleton.runtimeKeccak256);
  const safeExec = async (selectedSafe: typeof safes[number], to: Hex, data: Hex, signatureCount = 2): Promise<{ receipt: any; success: boolean }> => {
    const nonce = BigInt(await call(selectedSafe.safe, "nonce()"));
    const fields = [to, "0", data, "0", "4000000", "0", "0", ZERO, ZERO];
    const hash = await call(selectedSafe.safe, hashAbi, [...fields, nonce.toString()]);
    const signatures = await Promise.all(selectedSafe.keys.slice(0, signatureCount).map(async key => ({ owner: key.owner, signature: await run(["wallet", "sign", "--no-hash", hash, "--keystore", key.path, "--password", "local-test-only"]) })));
    const packed = `0x${signatures.toSorted((a, b) => a.owner < b.owner ? -1 : 1).map(value => value.signature.slice(2)).join("")}` as Hex;
    if (signatureCount < 2) {
      await assert.rejects(call(selectedSafe.safe, execAbi, [...fields, packed]));
      assert.equal(BigInt(await call(selectedSafe.safe, "nonce()")), nonce);
      return { success: false, receipt: null };
    }
    const receipt = await send(selectedSafe.safe, await encode(execAbi, [...fields, packed]));
    assert.equal(receipt.status, "0x1");
    assert.equal(BigInt(await call(selectedSafe.safe, "nonce()")), nonce + 1n);
    const inner = receipt.logs.filter((log: { address: Hex; topics: Hex[] }) => log.address.toLowerCase() === selectedSafe.safe && [custodyTopic("ExecutionSuccess(bytes32,uint256)"), custodyTopic("ExecutionFailure(bytes32,uint256)")].includes(log.topics[0]!));
    assert.equal(inner.length, 1);
    assert.equal(inner[0]!.topics[1], hash);
    assert.equal(inner[0]!.topics.length, 2);
    assert.equal(inner[0]!.data, `0x${word(0n)}`);
    assert.equal(inner[0]!.removed, false);
    return { receipt, success: inner[0]!.topics[0] === custodyTopic("ExecutionSuccess(bytes32,uint256)") };
  };
  const cleanup = async () => { await anvil.stop(); await rm(temporary, { recursive: true, force: true }); };
  return { root, temporary, executor, rpc, call, send, deploy, safes, safe: safes[0]!.safe, owners: safes[0]!.owners, singleton, pins, keys: safes[0]!.keys, run, encode, safeExec, cleanup };
}
