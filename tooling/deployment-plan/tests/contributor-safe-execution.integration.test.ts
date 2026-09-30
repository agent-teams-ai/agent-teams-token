import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { calendarSchedule, type Hex } from "@agent-teams/supply/deployment";
import { loadPreparedProductionPackage } from "@agent-teams/supply/deployment-files";
import { custodySelector, custodyTopic } from "../../testnet-ccip/src/adapters/safe-custody.ts";
import { createContributorCommitmentIntent, type ContributorCapacityObservation, type ContributorCommitmentInput } from "../src/composition/contributor-commitment-intent.ts";
import { createRealProductionPackage } from "./helpers/real-production-package.ts";
import { setupLocalSafes, word } from "./helpers/local-safe.ts";

// Test-only: official Safe 1.4.1 bytes, disposable keys, isolated chain, synthetic production package.
const amount = 5_000_000_000_000_000n;
const firstAmount = 1_000_000_000_000_000n;
const cap = 16_000_000_000_000_000n;

test("test-only unsigned contributor intent executes through official 2-of-3 Safe and real reserve", { timeout: 240_000 }, async t => {
  const { root, temporary, executor, rpc, call, send, safe, owners, singleton, pins, encode, safeExec, safes } = await setupLocalSafes(t);
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
  const execute = (to: Hex, data: Hex) => safeExec(safes[0]!, to, data);
  const firstObservation = await snapshot();
  assert.ok(BigInt(firstObservation.blockTimestamp) < BigInt(schedule.start), "First grant must still begin in the future");
  const first = createContributorCommitmentIntent(prepared, input(firstObservation, firstAmount, schedule.start), firstObservation, BigInt(firstObservation.observedAt));
  assert.equal(first.broadcastAllowed, false);
  assert.deepEqual(Object.keys(first.safeTransaction).toSorted(), ["data", "operation", "to", "value"]);
  assert.equal(first.safeTransaction.to, reserve);
  assert.equal(first.safeTransaction.value, "0");
  assert.equal(first.safeTransaction.operation, 0);
  const initialReserveBalance = await balance(reserve);
  const firstResult = await execute(first.safeTransaction.to as Hex, first.safeTransaction.data);
  assert.equal(BigInt((await rpc("eth_getBlockByHash", [firstResult.receipt.blockHash, false])).timestamp), BigInt(firstObservation.blockTimestamp) + 1n);
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
  let recentBlockTimestamp = BigInt(schedule.cliff) - 10n;
  assert.equal(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp), recentBlockTimestamp);
  // Recent grants saturate the live window before the older grant is cancelled.
  const recentSchedule = calendarSchedule((BigInt(schedule.cliff) + 1000n).toString());
  for (const value of [amount, amount, amount, firstAmount]) {
    const data = await encode("commit(address,(uint256,uint64,uint64,uint64,uint8,bytes32))", [beneficiary, `(${value},${recentSchedule.start},${recentSchedule.cliff},${recentSchedule.end},1,${policy.purpose})`]);
    const result = await execute(reserve, data);
    assert.equal(result.success, true);
    recentBlockTimestamp += 1n;
    assert.equal(BigInt((await rpc("eth_getBlockByHash", [result.receipt.blockHash, false])).timestamp), recentBlockTimestamp);
  }
  assert.equal(await counter("rollingCommitted()"), cap);
  assert.ok(recentBlockTimestamp < BigInt(schedule.cliff) + 1n,
    "Second calendar jump must remain ahead of all intervening transactions");
  await rpc("evm_setNextBlockTimestamp", [Number(BigInt(schedule.cliff) + 1n)]);
  await rpc("evm_mine");
  assert.equal(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp), BigInt(schedule.cliff) + 1n);
  const beforeRefund = await balance(reserve);
  const cancelled = await execute(vault, custodySelector("cancel()"));
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
  const failed = await execute(reserve, excess);
  assert.equal(failed.success, false, "outer status 1 with Safe ExecutionFailure is not a grant");
  assert.equal(failed.receipt.logs.some((log: { address: Hex; topics: Hex[] }) => log.address.toLowerCase() === reserve && log.topics[0] === custodyTopic("GrantCommitted(address,address,uint256)")), false);
  assert.equal(await counter("rollingCommitted()"), cap);
  assert.equal(await counter("grossCommitted()"), firstAmount + cap);
  assert.equal(await balance(reserve), beforeRefund + refund);
});
