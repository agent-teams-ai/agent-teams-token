import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { calendarSchedule, type Hex } from "@agent-teams/supply/deployment";
import { loadPreparedProductionPackage } from "@agent-teams/supply/deployment-files";
import { startOwnedAnvil } from "../../local-evm/process.ts";
import { authenticateFoundryBinaries, pinnedFoundryBinary } from "../../local-evm/toolchain.ts";
import { qualifySafeArtifacts, type SafeArtifactPins } from "../../testnet-ccip/src/adapters/safe-artifacts.ts";
import { custodyKeccak, custodySelector, custodyTopic } from "../../testnet-ccip/src/adapters/safe-custody.ts";
import { createContributorCommitmentIntent, type ContributorCapacityObservation, type ContributorCommitmentInput } from "../src/composition/contributor-commitment-intent.ts";
import { createRealProductionPackage } from "./helpers/real-production-package.ts";

// Test-only: official Safe 1.4.1 bytes, disposable keys, isolated chain, synthetic production package.
const ZERO = `0x${"0".repeat(40)}` as Hex;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const amount = 5_000_000_000_000_000n;
const firstAmount = 1_000_000_000_000_000n;
const cap = 16_000_000_000_000_000n;
const execAbi = "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)";
const hashAbi = "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)";

async function setupLocalSafe(t: TestContext) {
  const root = resolvePath(".");
  const temporary = await mkdtemp(join(tmpdir(), "agtmai-contributor-safe-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const install = join(root, ".tools/foundry-v1.8.0-linux-x64");
  const foundry = authenticateFoundryBinaries(root, { anvil: join(install, "anvil"), cast: join(install, "cast"), forge: join(install, "forge") });
  const cast = pinnedFoundryBinary(root, foundry, "cast");
  const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile(cast, args, { timeout: 30_000, maxBuffer: 2_000_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
  const keys: { owner: Hex; path: string }[] = [];
  for (const name of ["owner-a", "owner-b", "owner-c", "executor"]) {
    await run(["wallet", "new", temporary, name, "--unsafe-password", "local-test-only"]);
    const path = join(temporary, name);
    keys.push({ path, owner: (await run(["wallet", "address", "--keystore", path, "--password", "local-test-only"])).toLowerCase() as Hex });
  }
  const executor = keys[3]!;
  const anvil = await startOwnedAnvil(pinnedFoundryBinary(root, foundry, "anvil"), executor.owner, undefined, { timestamp: "1799999900" });
  t.after(() => anvil.stop());
  let id = 0;
  const rpc = async (method: string, params: unknown[] = []): Promise<any> => {
    const response = await fetch(anvil.rpcUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    return body.result;
  };
  assert.equal(await rpc("eth_chainId"), "0x7a69");
  const encode = (signature: string, args: string[]) => run(["calldata", signature, ...args]) as Promise<Hex>;
  const call = async (to: Hex, signature: string, args: string[] = []) => rpc("eth_call", [{ to, data: await encode(signature, args) }, "latest"]) as Promise<Hex>;
  const send = async (to: Hex | null, data: Hex) => {
    const hash = await run(["send", "--rpc-url", anvil.rpcUrl, "--chain", "31337", "--keystore", executor.path, "--password", "local-test-only", "--gas-limit", "6000000", "--async", ...(to ? [to, data] : ["--create", data])]);
    for (let attempt = 0; attempt < 200; attempt++) {
      const receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (receipt) { return receipt; }
      await delay(25);
    }
    throw new Error(`Unresolved local transaction ${hash}; do not resubmit`);
  };
  const deploy = async (initcode: Hex): Promise<Hex> => {
    const receipt = await send(null, initcode);
    assert.equal(receipt.status, "0x1");
    return receipt.contractAddress as Hex;
  };
  let selected = process.env.AGTMAI_SAFE_PINS_SHA256 as Hex | undefined;
  let directory = process.env.AGTMAI_SAFE_ARTIFACT_DIRECTORY;
  if (!selected || !directory) {
    // The deployment-plan CI job does not provision Safe artifacts. Use the existing
    // pinned, checksum-verifying provisioning script for this disposable local test.
    const provisioned = await new Promise<string>((resolve, reject) => {
      execFile("bash", [resolvePath(root, "scripts/prepare-safe-artifacts.sh"), "--fetch"], { timeout: 180_000, maxBuffer: 2_000 },
        (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    directory = provisioned.match(/^AGTMAI_SAFE_ARTIFACT_DIRECTORY=(.+)$/m)?.[1];
    selected = provisioned.match(/^AGTMAI_SAFE_PINS_SHA256=(0x[0-9a-f]{64})$/m)?.[1] as Hex | undefined;
    assert.ok(directory && selected, "Pinned Safe provisioning returned no artifact identity");
    const ownedDirectory = directory;
    t.after(() => rm(ownedDirectory, { recursive: true, force: true }));
  }
  assert.ok(selected && directory, "Official Safe 1.4.1 artifacts and reviewed pins are required");
  const pins = JSON.parse(await readFile(join(directory, "pins.json"), "utf8")) as SafeArtifactPins;
  const bytes = { proxy: await readFile(join(directory, "SafeProxy.json")), singleton: await readFile(join(directory, "Safe.json")), buildInfo: await readFile(join(directory, "build-info.json")) };
  qualifySafeArtifacts(pins, selected, bytes, "0x0000000000000000000000000000000000000099");
  const singleton = await deploy(JSON.parse(bytes.singleton.toString()).bytecode);
  qualifySafeArtifacts(pins, selected, bytes, singleton);
  const safe = await deploy(`${JSON.parse(bytes.proxy.toString()).bytecode}${word(BigInt(singleton))}` as Hex);
  const owners = keys.slice(0, 3).map(key => key.owner);
  assert.equal((await send(safe, await encode("setup(address[],uint256,address,bytes,address,address,uint256,address)", [`[${owners.join(",")}]`, "2", ZERO, "0x", ZERO, ZERO, "0", ZERO]))).status, "0x1");
  assert.equal(await call(safe, "VERSION()"), `0x${word(32n)}${word(5n)}${Buffer.from("1.4.1").toString("hex").padEnd(64, "0")}`);
  assert.equal(BigInt(await call(safe, "getThreshold()")), 2n);
  const ownerResult = await call(safe, "getOwners()");
  assert.equal(BigInt(`0x${ownerResult.slice(66, 130)}`), 3n);
  assert.deepEqual([0, 1, 2].map(index => `0x${ownerResult.slice(130 + index * 64 + 24, 130 + (index + 1) * 64)}`).toSorted(), owners.toSorted());
  assert.equal(BigInt(await call(safe, "nonce()")), 0n);
  const singletonCode = await rpc("eth_getCode", [singleton, "latest"]) as Hex;
  const proxyCode = await rpc("eth_getCode", [safe, "latest"]) as Hex;
  assert.equal(custodyKeccak(Buffer.from(singletonCode.slice(2), "hex")), pins.singleton.runtimeKeccak256);
  assert.equal(custodyKeccak(Buffer.from(proxyCode.slice(2), "hex")), pins.proxy.runtimeKeccak256);
  return { root, temporary, executor, rpc, call, send, safe, owners, singleton, pins, keys, run, encode };
}

test("test-only unsigned contributor intent executes through official 2-of-3 Safe and real reserve", { timeout: 240_000 }, async t => {
  const { root, temporary, executor, rpc, call, send, safe, owners, singleton, pins, keys, run, encode } = await setupLocalSafe(t);
  while (BigInt(await rpc("eth_getTransactionCount", [executor.owner, "latest"])) < 7n) {
    assert.equal((await send(executor.owner, "0x")).status, "0x1");
  }
  const fixture = await createRealProductionPackage(root, join(temporary, "prepared"), executor.owner, { address: safe, owners, singletonAddress: singleton, singletonCodeHash: pins.singleton.runtimeKeccak256, proxyCodeHash: pins.proxy.runtimeKeccak256 });
  const prepared = await loadPreparedProductionPackage(fixture.preparedDirectory);
  for (const operation of prepared.operations.filter(candidate => candidate.kind === "create")) {
    const receipt = await send(null, operation.initcode!);
    assert.equal(receipt.status, "0x1", operation.id);
    assert.equal(receipt.contractAddress.toLowerCase(), operation.expectedAddress);
  }
  const token = prepared.operations[0]!.expectedAddress!;
  const reserve = prepared.operations[2]!.expectedAddress!;
  const policy = prepared.configuration.reserveGenesis.contributors;
  const balance = async (address: Hex) => BigInt(await call(token, "balanceOf(address)", [address]));
  const counter = async (signature: string) => BigInt(await call(reserve, signature));
  assert.equal(await balance(reserve), 17_000_000_000_000_000n);
  assert.equal(await counter("rollingCommitted()"), 0n);
  assert.equal(await call(reserve, "CONTROLLER()"), `0x${safe.slice(2).padStart(64, "0")}`);
  const schedule = calendarSchedule("1800000000");
  const beneficiary = `0x${"9".repeat(40)}` as Hex;
  const snapshot = async (): Promise<ContributorCapacityObservation> => {
    const block = await rpc("eth_getBlockByNumber", ["latest", false]);
    return { schema: "agtmai-contributor-capacity-observation-v1", provenance: "supplied-unverified", chainId: "1", blockNumber: BigInt(block.number).toString(), blockHash: block.hash, blockTimestamp: BigInt(block.timestamp).toString(), observedAt: BigInt(block.timestamp).toString(), token, reserve, projectControllerSafe: safe, safeNonce: BigInt(await call(safe, "nonce()")).toString(), safeThreshold: 2, safeOwners: owners, safeProxyCodeHash: pins.proxy.runtimeKeccak256, safeSingletonCodeHash: pins.singleton.runtimeKeccak256, safeSingletonAddress: singleton, controllerToken: token, controllerSafe: safe, controllerPurpose: policy.purpose, rollingCapBaseUnits: policy.rollingCapBaseUnits, perGrantCapBaseUnits: policy.perGrantCapBaseUnits, controllerWindowSeconds: "31536000", rollingCommittedBaseUnits: (await counter("rollingCommitted()")).toString(), grossCommittedBaseUnits: (await counter("grossCommitted()")).toString(), reserveBalanceBaseUnits: (await balance(reserve)).toString() };
  };
  const input = (observation: ContributorCapacityObservation, value: bigint, start: string): ContributorCommitmentInput => ({ schema: "agtmai-contributor-commitment-input-v1", chainId: "1", token, reserve, projectControllerSafe: safe, safeNonce: observation.safeNonce, beneficiary, amountBaseUnits: value.toString(), purpose: policy.purpose, schedule: calendarSchedule(start), configurationSha256: prepared.configurationSha256, reserveConfigurationSha256: prepared.reserveConfigurationSha256, artifactPinsSha256: prepared.expectations.artifactPinsSha256, sourceRevision: prepared.expectations.sourceRevision });
  const safeExec = async (to: Hex, data: Hex) => {
    const nonce = BigInt(await call(safe, "nonce()"));
    const fields = [to, "0", data, "0", "4000000", "0", "0", ZERO, ZERO];
    const hash = await call(safe, hashAbi, [...fields, nonce.toString()]);
    const signatures = await Promise.all(keys.slice(0, 2).map(async key => ({ owner: key.owner, signature: await run(["wallet", "sign", "--no-hash", hash, "--keystore", key.path, "--password", "local-test-only"]) })));
    const packed = `0x${signatures.toSorted((a, b) => a.owner < b.owner ? -1 : 1).map(value => value.signature.slice(2)).join("")}`;
    const receipt = await send(safe, await encode(execAbi, [...fields, packed]));
    assert.equal(receipt.status, "0x1");
    assert.equal(BigInt(await call(safe, "nonce()")), nonce + 1n);
    const inner = receipt.logs.filter((log: { address: Hex; topics: Hex[] }) => log.address.toLowerCase() === safe && [custodyTopic("ExecutionSuccess(bytes32,uint256)"), custodyTopic("ExecutionFailure(bytes32,uint256)")].includes(log.topics[0]!));
    assert.equal(inner.length, 1);
    assert.equal(inner[0]!.topics[1], hash);
    assert.equal(inner[0]!.topics.length, 2);
    assert.equal(inner[0]!.data, `0x${word(0n)}`);
    assert.equal(inner[0]!.removed, false);
    return { receipt, success: inner[0]!.topics[0] === custodyTopic("ExecutionSuccess(bytes32,uint256)") };
  };
  const firstObservation = await snapshot();
  const first = createContributorCommitmentIntent(prepared, input(firstObservation, firstAmount, schedule.start), firstObservation, BigInt(firstObservation.observedAt));
  assert.equal(first.broadcastAllowed, false);
  assert.deepEqual(Object.keys(first.safeTransaction).toSorted(), ["data", "operation", "to", "value"]);
  assert.equal(first.safeTransaction.to, reserve);
  assert.equal(first.safeTransaction.value, "0");
  assert.equal(first.safeTransaction.operation, 0);
  const initialReserveBalance = await balance(reserve);
  const firstResult = await safeExec(first.safeTransaction.to as Hex, first.safeTransaction.data);
  assert.equal(firstResult.success, true);
  const committed = firstResult.receipt.logs.filter((log: { address: Hex; topics: Hex[] }) => log.address.toLowerCase() === reserve && log.topics[0] === custodyTopic("GrantCommitted(address,address,uint256)"));
  assert.equal(committed.length, 1);
  const vault = `0x${committed[0]!.topics[1].slice(-40)}` as Hex;
  assert.equal(`0x${committed[0]!.topics[2].slice(-40)}`, beneficiary);
  assert.equal(BigInt(committed[0]!.data), firstAmount);
  assert.equal(await balance(reserve), initialReserveBalance - firstAmount);
  assert.notEqual(await rpc("eth_getCode", [vault, "latest"]), "0x");
  assert.equal(await balance(vault), firstAmount);
  assert.equal(BigInt(await call(vault, "funded()")), 1n);
  assert.equal(await call(vault, "BENEFICIARY()"), `0x${beneficiary.slice(2).padStart(64, "0")}`);
  assert.equal(await call(vault, "ORIGINAL_RESERVE()"), `0x${reserve.slice(2).padStart(64, "0")}`);
  const grantWords = (await call(vault, "grant()")).slice(2).match(/.{64}/g)!;
  assert.deepEqual(grantWords.slice(0, 6), [word(firstAmount), word(BigInt(schedule.start)), word(BigInt(schedule.cliff)), word(BigInt(schedule.end)), word(1n), policy.purpose.slice(2)]);
  assert.equal(await counter("grossCommitted()"), firstAmount);
  assert.equal(await counter("rollingCommitted()"), firstAmount);
  await rpc("evm_setNextBlockTimestamp", [Number(BigInt(schedule.cliff) - 10n)]);
  await rpc("evm_mine");
  // Recent grants saturate the live window before the older grant is cancelled.
  const recentSchedule = calendarSchedule((BigInt(schedule.cliff) + 1000n).toString());
  for (const value of [amount, amount, amount, firstAmount]) {
    const data = await encode("commit(address,(uint256,uint64,uint64,uint64,uint8,bytes32))", [beneficiary, `(${value},${recentSchedule.start},${recentSchedule.cliff},${recentSchedule.end},1,${policy.purpose})`]);
    assert.equal((await safeExec(reserve, data)).success, true);
  }
  assert.equal(await counter("rollingCommitted()"), cap);
  await rpc("evm_setNextBlockTimestamp", [Number(BigInt(schedule.cliff) + 1n)]);
  await rpc("evm_mine");
  const beforeRefund = await balance(reserve);
  const cancelled = await safeExec(vault, custodySelector("cancel()"));
  assert.equal(cancelled.success, true);
  const cancelLog = cancelled.receipt.logs.find((log: { address: Hex; topics: Hex[] }) => log.address.toLowerCase() === vault && log.topics[0] === custodyTopic("TeamGrantCancelled(bytes32,uint256,uint256,uint64)"));
  assert.ok(cancelLog);
  assert.equal(cancelLog.topics[1], policy.purpose);
  const [frozenHex, refundHex] = (cancelLog.data as string).slice(2).match(/.{64}/g)!.map((value: string) => BigInt(`0x${value}`));
  const frozen = frozenHex!;
  const refund = refundHex!;
  const cancellationBlock = await rpc("eth_getBlockByHash", [cancelled.receipt.blockHash, false]);
  const elapsed = BigInt(cancellationBlock.timestamp) - BigInt(schedule.cliff);
  assert.equal(frozen, firstAmount * elapsed / (BigInt(schedule.end) - BigInt(schedule.cliff)));
  assert.ok(frozen > 0n && frozen < firstAmount);
  assert.equal(refund, firstAmount - frozen);
  assert.equal(await balance(reserve) - beforeRefund, refund);
  assert.equal(await balance(vault), frozen);
  assert.equal(BigInt(await call(vault, "available()")), frozen);
  const cancelledGrant = (await call(vault, "grant()")).slice(2).match(/.{64}/g)!;
  assert.equal(BigInt(`0x${cancelledGrant[7]}`), frozen);
  assert.equal(BigInt(`0x${cancelledGrant[10]}`), 1n);
  assert.equal(await counter("rollingCommitted()"), cap);
  assert.equal(await counter("grossCommitted()"), firstAmount + cap);
  const afterRefund = await snapshot();
  assert.throws(() => createContributorCommitmentIntent(prepared, input(afterRefund, 1n, (BigInt(schedule.cliff) + 2000n).toString()), afterRefund, BigInt(afterRefund.observedAt)), /COMMIT_CAP/);
  const excess = await encode("commit(address,(uint256,uint64,uint64,uint64,uint8,bytes32))", [beneficiary, `(1,${BigInt(schedule.cliff) + 2000n},${calendarSchedule((BigInt(schedule.cliff) + 2000n).toString()).cliff},${calendarSchedule((BigInt(schedule.cliff) + 2000n).toString()).end},1,${policy.purpose})`]);
  const failed = await safeExec(reserve, excess);
  assert.equal(failed.success, false, "outer status 1 with Safe ExecutionFailure is not a grant");
  assert.equal(failed.receipt.logs.some((log: { address: Hex; topics: Hex[] }) => log.address.toLowerCase() === reserve && log.topics[0] === custodyTopic("GrantCommitted(address,address,uint256)")), false);
  assert.equal(await counter("rollingCommitted()"), cap);
  assert.equal(await counter("grossCommitted()"), firstAmount + cap);
  assert.equal(await balance(reserve), beforeRefund + refund);
});
