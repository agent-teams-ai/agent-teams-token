import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { calendarSchedule, deploymentBytes, type Hex, type LocalPurposeArtifact, type LocalPurposeGenesis, type PreparedLocalPurposeGenesis, materializeObservedAssemblyManifest, checkPassport, generatePassport } from "@agent-teams/supply/deployment";
import { localPurposeCompilerPorts, readLocalPurposeArtifactPins, verifyDeploymentFiles } from "@agent-teams/supply/deployment-files";
import { encodeAllocationId, sha256 } from "@agent-teams/supply/genesis-manifest";
import { deriveCreateAddress } from "../src/domain/identity.ts";
import { parseProductionObservation } from "../src/adapters/production-inputs.ts";
import { qualifySafeArtifacts, type SafeArtifactPins } from "../../testnet-ccip/src/adapters/safe-artifacts.ts";
import { custodySafeSetupOwners, verifyCustodySafeSetupEvent, custodySelector, custodyTopic } from "../../testnet-ccip/src/adapters/safe-custody.ts";
import { setupLocalSafes, word } from "./helpers/local-safe.ts";
import { runLocalAssemblyProof, reconstructLocalAssemblyPackage, type LocalAssemblyScenarioContext } from "../../../scripts/deployment/local-execution-proof.ts";
import { removeOwnedRunDirectory } from "../../local-evm/run-lease.ts";

const contracts = ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController", "PurposeReserveVault", "GrantVault"] as const;
const paths = contracts.map(name => name === "AGTMAICCIPToken" ? `src/features/token-genesis/${name}.sol` : name === "PurposeReserveVault" ? `src/features/purpose-reserves/${name}.sol` : `src/features/contributor-grants/${name}.sol`);
const purposes = ["long-term", "users", "operations", "ecosystem", "financing", "liquidity"] as const;
const unit = 1_000_000_000n;
const syntheticExecution = { initialTimestamp: "1799999800", gasBufferBps: 2000, gasFundingWei: "700000000000000000",
  bootstrapGas: { gasLimit: "6000000", maxFeePerGas: "10000000000", maxPriorityFeePerGas: "1000000000" } };
const asAddress = (value: Hex) => `0x${value.slice(-40)}` as Hex;
const blockIdentity = (block: { hash: Hex; number: Hex; timestamp: Hex }) => ({ blockHash: block.hash, blockNumber: BigInt(block.number).toString(), timestamp: BigInt(block.timestamp).toString() });

async function buildCandidateArtifacts(root: string, temporary: string) {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(revision.status, 0);
  const candidateRevision = revision.stdout.trim();
  const buildRoot = join(temporary, "forge");
  const build = spawnSync(join(root, ".tools/foundry-v1.8.0-linux-x64/forge"), ["build", ...paths, "--offline", "--no-auto-detect", "--out", join(buildRoot, "out"), "--build-info", "--build-info-path", join(buildRoot, "build-info"), "--cache-path", join(buildRoot, "cache"), "--use", join(root, ".tools/solc-v0.8.36-linux-x64/solc")], { cwd: join(root, "contracts/evm"), encoding: "utf8", env: { ...process.env, HOME: temporary } });
  assert.equal(build.status, 0, build.stderr);
  const buildInfo = await readFile(join(buildRoot, "build-info", (await readdir(join(buildRoot, "build-info")))[0]!));
  const sourceInputs = (JSON.parse(buildInfo.toString()) as { input: { sources: Record<string, { content: string }> } }).input.sources;
  for (const [path, source] of Object.entries(sourceInputs)) {
    // Bind compiler input to the actual candidate tree, including pinned dependencies.
    const committed = spawnSync("git", ["show", `${candidateRevision}:contracts/evm/${path}`], { cwd: root, encoding: "utf8" });
    assert.equal(committed.status, 0, `Uncommitted or missing candidate source: ${path}`);
    assert.equal(source.content, committed.stdout, `Candidate source differs: ${path}`);
  }
  const artifactDir = join(temporary, "artifacts");
  await mkdir(artifactDir);
  const pins = [];
  for (const name of contracts) {
    const artifact = await readFile(join(buildRoot, "out", `${name}.sol`, `${name}.json`));
    const artifactPath = `${name.toLowerCase()}.artifact.json`, buildInfoPath = `${name.toLowerCase()}.build-info.json`;
    await writeFile(join(artifactDir, artifactPath), artifact);
    await writeFile(join(artifactDir, buildInfoPath), buildInfo);
    pins.push({ contract: name, artifactPath, artifactSha256: sha256(artifact), buildInfoPath, buildInfoSha256: sha256(buildInfo) });
  }
  const pinPath = join(artifactDir, "pins.json");
  await writeFile(pinPath, deploymentBytes({ schema: "agtmai-local-purpose-artifact-pins-v1", sourceRevision: candidateRevision, artifacts: pins }));
  // Admission reads the clean selected Git tree and independently recompiles with pinned solc.
  const candidate = { repositoryRoot: root, revision: candidateRevision };
  const loaded = await readLocalPurposeArtifactPins(pinPath, candidate);
  await assert.rejects(readLocalPurposeArtifactPins(pinPath, { ...candidate, revision: "0".repeat(40) }), /ARTIFACT|INVALID|PIN/u);
  return { candidateRevision, loaded };
}

// Catch misrouted genesis balances, altered runtime/immutables and unenforced six-vault policy.
async function assertGenesis(local: Pick<LocalAssemblyScenarioContext, "rpc" | "call" | "safes" | "executor" | "safeExec" | "encode">, prepared: PreparedLocalPurposeGenesis, expectations: {
  tokenTransactionHash: Hex; predicted: readonly Hex[]; caps: readonly bigint[];
  config: Pick<LocalPurposeGenesis, "reserve" | "purposeVaults">; artifacts: readonly LocalPurposeArtifact[];
}) {
  const { rpc, call, safes, executor } = local;
  const { tokenTransactionHash, predicted, caps, config, artifacts } = expectations;
  const reserve = config.reserve;
  const token = predicted[0]!, founder = predicted[1]!, controller = predicted[2]!, nested = prepared.operations[1]!.nestedAddress!;
  const tokenReceipt = await rpc("eth_getTransactionReceipt", [tokenTransactionHash]);
  const allocations = tokenReceipt.logs.filter((log: { address: Hex; topics: Hex[] }) => log.address.toLowerCase() === token && log.topics[0] === custodyTopic("GenesisAllocation(bytes32,address,uint256)"));
  assert.equal(allocations.length, 8);
  for (const allocation of reserve.allocations) {
    assert.equal(allocations.filter((log: { topics: Hex[]; data: Hex }) => log.topics[1] === encodeAllocationId(allocation.id) && asAddress(log.topics[2]!) === allocation.recipient && BigInt(log.data) === BigInt(allocation.amountBaseUnits)).length, 1, allocation.id);
  }
  const verifyRuntime = async (address: Hex, name: typeof contracts[number], values: Record<string, bigint | Hex>) => {
    const artifact = artifacts.find(item => item.contract === name)!;
    const actual = (await rpc("eth_getCode", [address, "latest"]) as Hex).slice(2).toLowerCase();
    const template = artifact.runtimeBytecode.slice(2).toLowerCase();
    assert.equal(actual.length, template.length, `${name} runtime length`);
    const covered = new Set<number>();
    const checkedGetters = new Set<string>();
    for (const ref of artifact.immutableReferences) {
      const expected = word(BigInt(values[ref.name]!));
      assert.equal(actual.slice(ref.start * 2, (ref.start + 32) * 2), expected, `${name}.${ref.name} immutable`);
      if (!checkedGetters.has(ref.name)) {
        const getter = ref.name === "INITIAL_CCIP_ADMIN" ? "getCCIPAdmin" : ref.name;
        assert.equal(await call(address, `${getter}()`), `0x${expected}`, `${name}.${ref.name} getter`);
        checkedGetters.add(ref.name);
      }
      for (let byte = ref.start; byte < ref.start + 32; byte++) { covered.add(byte); }
    }
    for (let byte = 0; byte < actual.length / 2; byte++) {
      if (!covered.has(byte)) { assert.equal(actual.slice(byte * 2, byte * 2 + 2), template.slice(byte * 2, byte * 2 + 2), `${name} runtime byte ${byte}`); }
    }
  };
  await verifyRuntime(token, "AGTMAICCIPToken", { GENESIS_ALLOCATION_HASH: prepared.genesisAllocationHash, INITIAL_CCIP_ADMIN: safes[0]!.safe, INITIAL_SUPPLY: 100_000_000n * unit });
  await verifyRuntime(founder, "FounderGrantReserve", { TOKEN: token, VAULT: nested });
  await verifyRuntime(controller, "ReserveController", { TOKEN: token, CONTROLLER: safes[0]!.safe, PURPOSE: reserve.contributors.purpose as Hex, ROLLING_CAP: BigInt(reserve.contributors.rollingCapBaseUnits), PER_GRANT_CAP: BigInt(reserve.contributors.perGrantCapBaseUnits) });
  await verifyRuntime(nested, "GrantVault", { TOKEN: token, BENEFICIARY: safes[1]!.safe, ORIGINAL_RESERVE: founder, CONTROLLER: safes[0]!.safe });
  const balance = async (address: Hex, block?: Hex) => BigInt(await call(token, "balanceOf(address)", [address], { block }));
  assert.equal(BigInt(await call(token, "totalSupply()")), 100_000_000n * unit);
  assert.equal(BigInt(await call(token, "INITIAL_SUPPLY()")), 100_000_000n * unit);
  assert.equal(BigInt(await call(token, "decimals()")), 9n);
  assert.equal(asAddress(await call(token, "getCCIPAdmin()")), safes[0]!.safe);
  assert.equal(await call(token, "GENESIS_ALLOCATION_HASH()"), prepared.genesisAllocationHash);
  assert.equal(await balance(controller), 17_000_000n * unit);
  assert.equal(await balance(nested), 3_000_000n * unit);
  assert.equal(await balance(founder), 0n);
  assert.equal(await balance(executor.owner), 0n);
  assert.equal(BigInt(await call(nested, "funded()")), 1n);
  assert.equal(asAddress(await call(nested, "BENEFICIARY()")), safes[1]!.safe);
  assert.equal(asAddress(await call(nested, "ORIGINAL_RESERVE()")), founder);
  const founderTerms = (await call(nested, "grant()")).slice(2).match(/.{64}/g)!;
  assert.deepEqual(founderTerms.slice(0, 6), [word(3_000_000n * unit), word(BigInt(reserve.founder.schedule.start)), word(BigInt(reserve.founder.schedule.cliff)), word(BigInt(reserve.founder.schedule.end)), word(0n), reserve.founder.purpose.slice(2)]);
  assert.equal(BigInt(await call(token, "allowance(address,address)", [founder, nested])), 0n);
  const vaults = predicted.slice(3);
  assert.equal((await Promise.all(vaults.map(address => balance(address)))).reduce((a, b) => a + b), 80_000_000n * unit);
  for (let i = 0; i < vaults.length; i++) {
    const vault = vaults[i]!;
    const allocation = reserve.allocations.find(item => item.id === purposes[i])!;
    assert.equal(await balance(vault), BigInt(allocation.amountBaseUnits), `${purposes[i]} genesis funding`);
    assert.notEqual(await rpc("eth_getCode", [vault, "latest"]), "0x");
    await verifyRuntime(vault, "PurposeReserveVault", { TOKEN: token, CONTROLLER: safes[0]!.safe, PURPOSE: encodeAllocationId(purposes[i]!)!, OPENS_AT: BigInt(config.purposeVaults[i]!.opensAt), WINDOW_SECONDS: BigInt(config.purposeVaults[i]!.windowSeconds), ROLLING_CAP: caps[i]! * unit });
    assert.equal(asAddress(await call(vault, "TOKEN()")), token);
    assert.equal(asAddress(await call(vault, "CONTROLLER()")), safes[0]!.safe);
    assert.equal(await call(vault, "PURPOSE()"), encodeAllocationId(purposes[i]!));
    assert.equal(BigInt(await call(vault, "ROLLING_CAP()")), caps[i]! * unit);
    assert.equal(BigInt(await call(vault, "grossOutflow()")), 0n);
    assert.equal(BigInt(await call(vault, "rollingOutflow()")), 0n);
  }
  return { token, controller, nested, vaults, balance };
}

async function assertFounderIrrevocable(local: Pick<LocalAssemblyScenarioContext, "rpc" | "call" | "safes" | "executor" | "safeExec" | "encode">, token: Hex, vault: Hex, reserve: Hex) {
  const { call, safes, safeExec, encode } = local;
  const founderState = async () => ({
    grant: await call(vault, "grant()"), funded: await call(vault, "funded()"),
    balances: await Promise.all([vault, reserve, ...safes.map(safe => safe.safe)].map(address => call(token, "balanceOf(address)", [address]))),
    totalSupply: await call(token, "totalSupply()"),
  });
  const before = await founderState();
  const cancelled = await safeExec(safes[0]!, vault, await encode("cancel()", []));
  assert.equal(cancelled.success, false, "funded founder grant cannot be cancelled by its actual controller Safe");
  assert.equal(cancelled.receipt.logs.filter((log: { address: Hex }) => [vault, token].includes(log.address.toLowerCase() as Hex)).length, 0, "denied founder cancellation emits no grant or token event");
  assert.deepEqual(await founderState(), before, "denied founder cancellation preserves the full grant and balances");
  return cancelled;
}

async function assertOpeningBoundary(local: Pick<LocalAssemblyScenarioContext, "rpc" | "call" | "safes" | "executor" | "safeExec" | "encode">, vault: Hex, opensAt: bigint, outflow: (vault: Hex, value: bigint) => ReturnType<typeof local.safeExec>) {
  const { rpc, call } = local;
  await rpc("evm_setNextBlockTimestamp", [Number(opensAt - 1n)]);
  const beforeOpening = await outflow(vault, 1n);
  assert.equal(beforeOpening.success, false, "one second before opening denies the controller Safe");
  assert.equal(BigInt((await rpc("eth_getBlockByHash", [beforeOpening.receipt.blockHash, false])).timestamp), opensAt - 1n);
  assert.equal(BigInt(await call(vault, "grossOutflow()")), 0n);
  assert.equal(BigInt(await call(vault, "rollingOutflow()")), 0n);
  await rpc("evm_setNextBlockTimestamp", [Number(opensAt)]);
  // One base unit of early headroom cannot mask a late expiry of the saturation checkpoint.
  const atOpening = await outflow(vault, 1n);
  assert.equal(atOpening.success, true, "exact opening permits the controller Safe");
  assert.equal(BigInt((await rpc("eth_getBlockByHash", [atOpening.receipt.blockHash, false])).timestamp), opensAt);
  assert.equal(BigInt(await call(vault, "grossOutflow()")), 1n);
  assert.equal(BigInt(await call(vault, "rollingOutflow()")), 1n);
  return atOpening;
}

async function exerciseAssemblyScenarios(local: LocalAssemblyScenarioContext, caps: readonly bigint[]) {

  const { prepared, receipts, rpc, call, send, safes, safeExec, encode, executor } = local;
  const config = prepared.configuration, reserve = config.reserve;
  const predicted = prepared.operations.filter(op => op.kind === "create").map(op => op.expectedAddress!);
  const genesisBlock = await rpc("eth_getBlockByNumber", ["latest", false]);
  const { token, controller, nested, vaults, balance } = await assertGenesis(local, prepared, { tokenTransactionHash: receipts[0]!.transactionHash, predicted, caps, config, artifacts: prepared.artifacts });
  assert.equal((await rpc("eth_getBlockByNumber", ["latest", false])).hash, genesisBlock.hash);
  const vaultStatesAt = (block: Hex) => Promise.all(vaults.map(async (vault, i) => ({ allocationId: purposes[i], address: vault, balance: (await balance(vault, block)).toString(), grossOutflow: BigInt(await call(vault, "grossOutflow()", [], { block })).toString(), rollingOutflow: BigInt(await call(vault, "rollingOutflow()", [], { block })).toString() })));
  const genesisVaultStates = await vaultStatesAt(genesisBlock.number);
  const recipient = executor.owner;
  const scenarioReceipts: { scenario: string; transactionHash: Hex; blockHash: Hex; blockNumber: string; timestamp: string; innerSuccess: boolean; safeTransactionHash: Hex; safeNonce: string }[] = [];
  const recordSafe = async (scenario: string, result: Awaited<ReturnType<typeof safeExec>>) => {
    if (result.receipt) {
      const block = await rpc("eth_getBlockByHash", [result.receipt.blockHash, false]);
      scenarioReceipts.push({ scenario, transactionHash: result.receipt.transactionHash, blockHash: result.receipt.blockHash, blockNumber: BigInt(result.receipt.blockNumber).toString(), timestamp: BigInt(block.timestamp).toString(), innerSuccess: result.success, safeTransactionHash: result.transactionHash, safeNonce: result.nonce });
    }
    return result;
  };
  await recordSafe("founder-cancel-denied", await assertFounderIrrevocable(local, token, nested, predicted[1]!));
  const outflow = async (vault: Hex, value: bigint) => {
    const beforeVault = await balance(vault), beforeRecipient = await balance(recipient);
    const result = await recordSafe(`outflow:${vault}:${value}`, await safeExec(safes[0]!, vault, await encode("transferOut(address,uint256)", [recipient, value.toString()])));
    assert.equal(await balance(vault), beforeVault - (result.success ? value : 0n), "exact vault debit");
    assert.equal(await balance(recipient), beforeRecipient + (result.success ? value : 0n), "exact recipient credit");
    return result;
  };
  const first = vaults[0]!;
  const atOpening = await assertOpeningBoundary(local, first, BigInt(config.purposeVaults[0]!.opensAt), outflow);
  await rpc("evm_setNextBlockTimestamp", [1800000160]);
  await rpc("evm_mine");
  assert.notEqual(executor.owner, safes[0]!.safe);
  assert.ok(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp) >= BigInt(config.purposeVaults[0]!.opensAt));
  assert.ok(await balance(first) >= unit);
  assert.ok(BigInt(await call(first, "availableOutflow()")) >= unit);
  const unauthorizedState = async () => ({ vaultBalance: await balance(first), recipientBalance: await balance(recipient), gross: await call(first, "grossOutflow()"), rolling: await call(first, "rollingOutflow()"), available: await call(first, "availableOutflow()") });
  const beforeOneSignature = await unauthorizedState();
  assert.equal((await safeExec(safes[0]!, first, await encode("transferOut(address,uint256)", [recipient, "1"]), 1)).success, false);
  assert.deepEqual(await unauthorizedState(), beforeOneSignature, "one-signature denial leaves vault balances and accounting unchanged");
  const beforeUnauthorized = await unauthorizedState();
  await assert.rejects(call(first, "transferOut(address,uint256)", [recipient, unit.toString()], { from: executor.owner }), (error: unknown) => error instanceof Error && "data" in error && error.data === custodySelector("Unauthorized()"));
  const unauthorizedReceipt = await send(first, await encode("transferOut(address,uint256)", [recipient, unit.toString()]));
  assert.equal(unauthorizedReceipt.status, "0x0", "non-controller transaction must revert after opening");
  assert.equal(unauthorizedReceipt.logs.length, 0, "unauthorized transaction emits no outflow or token transfer");
  assert.deepEqual(await unauthorizedState(), beforeUnauthorized, "unauthorized call leaves balances and accounting unchanged");
  for (let i = 0; i < vaults.length; i++) {
    const amount = i === 0 ? 1n : unit;
    const result = i === 0 ? atOpening : await outflow(vaults[i]!, amount);
    assert.equal(result.success, true, purposes[i]);
    assert.equal(BigInt(await call(vaults[i]!, "grossOutflow()")), amount);
  }
  const saturated = await outflow(first, caps[0]! * unit - 1n);
  assert.equal(saturated.success, true);
  const saturationBlock = await rpc("eth_getBlockByHash", [saturated.receipt!.blockHash, false]);
  assert.equal((await outflow(first, 1n)).success, false, "cap saturated");
  const refund = await send(token, await encode("transfer(address,uint256)", [first, unit.toString()]));
  assert.equal(refund.status, "0x1");
  assert.equal((await outflow(first, 1n)).success, false, "refund does not erase gross history");
  const expiry = BigInt(saturationBlock.timestamp) + 100n;
  await rpc("evm_setNextBlockTimestamp", [Number(expiry - 1n)]);
  const beforeExpiry = await outflow(first, unit);
  assert.equal(beforeExpiry.success, false, "one second before expiry, spend exceeds the earlier one-base-unit headroom");
  assert.equal(BigInt((await rpc("eth_getBlockByHash", [beforeExpiry.receipt!.blockHash, false])).timestamp), expiry - 1n);
  assert.equal(BigInt(await call(first, "rollingOutflow()")), caps[0]! * unit - 1n);
  assert.equal(BigInt(await call(first, "availableOutflow()")), 1n);
  assert.equal(BigInt(await call(first, "grossOutflow()")), caps[0]! * unit);
  await rpc("evm_setNextBlockTimestamp", [Number(expiry)]);
  const expired = await outflow(first, unit);
  assert.equal(expired.success, true, "exact expiry permits returned inventory");
  assert.equal(BigInt((await rpc("eth_getBlockByHash", [expired.receipt!.blockHash, false])).timestamp), expiry);
  assert.equal(BigInt(await call(first, "rollingOutflow()")), unit, "saturation checkpoint expires at the exact cutoff");
  assert.equal(BigInt(await call(first, "grossOutflow()")), (caps[0]! + 1n) * unit);
  const grantSchedule = calendarSchedule("1800003000");
  const grantCall = await encode("commit(address,(uint256,uint64,uint64,uint64,uint8,bytes32))", [safes[1]!.safe, `(${unit},${grantSchedule.start},${grantSchedule.cliff},${grantSchedule.end},1,${reserve.contributors.purpose})`]);
  const grantResult = await recordSafe("contributor-grant", await safeExec(safes[0]!, controller, grantCall));
  assert.equal(grantResult.success, true, "existing contributor grant through new controller binding");
  const grantLogs = grantResult.receipt!.logs.filter((log: { address: Hex; topics: Hex[] }) => log.address.toLowerCase() === controller && log.topics[0] === custodyTopic("GrantCommitted(address,address,uint256)"));
  assert.equal(grantLogs.length, 1);
  const grantVault = asAddress(grantLogs[0]!.topics[1]);
  assert.equal(asAddress(await call(grantVault, "ORIGINAL_RESERVE()")), controller);
  assert.equal(asAddress(await call(grantVault, "BENEFICIARY()")), safes[1]!.safe);
  assert.equal(await balance(grantVault), unit);
  assert.equal(BigInt(await call(grantVault, "funded()")), 1n);
  assert.equal(BigInt(await call(controller, "rollingCommitted()")), unit);
  const beforeGrantRefund = await balance(controller);
  await rpc("evm_setNextBlockTimestamp", [Number(BigInt(grantSchedule.cliff) + 1n)]);
  const cancelled = await recordSafe("contributor-cancel", await safeExec(safes[0]!, grantVault, await encode("cancel()", [])));
  assert.equal(cancelled.success, true, "contributor cancellation through actual Safe signatures");
  const refundLog = cancelled.receipt!.logs.find((log: { address: Hex; topics: Hex[] }) => log.address.toLowerCase() === grantVault && log.topics[0] === custodyTopic("TeamGrantCancelled(bytes32,uint256,uint256,uint64)"));
  assert.ok(refundLog);
  const cancelledAt = BigInt((await rpc("eth_getBlockByHash", [cancelled.receipt!.blockHash, false])).timestamp);
  const vested = unit * (cancelledAt - BigInt(grantSchedule.cliff)) / (BigInt(grantSchedule.end) - BigInt(grantSchedule.cliff));
  const refundAmount = unit - vested;
  assert.equal(BigInt(`0x${refundLog.data.slice(2, 66)}`), vested, "independent curve freezes vested unclaimed debt");
  assert.equal(BigInt(`0x${refundLog.data.slice(66, 130)}`), refundAmount);
  assert.ok(vested > 0n && refundAmount > 0n);
  assert.equal(await balance(controller) - beforeGrantRefund, refundAmount);
  assert.equal(await balance(grantVault), vested);
  assert.equal(BigInt(await call(grantVault, "available()")), vested);
  assert.equal(BigInt(await call(controller, "grossCommitted()")), unit);
  // Actual founder beneficiary Safe signs release; compute entitlement from its receipt timestamp.
  const founderBalanceBefore = await balance(nested), beneficiaryBefore = await balance(safes[1]!.safe);
  const released = await recordSafe("founder-beneficiary-release", await safeExec(safes[1]!, nested, await encode("release()", [])));
  assert.equal(released.success, true);
  const releaseAt = BigInt((await rpc("eth_getBlockByHash", [released.receipt!.blockHash, false])).timestamp);
  const founderTerms = reserve.founder.schedule;
  const founderEntitlement = 3_000_000n * unit * (releaseAt - BigInt(founderTerms.cliff)) / (BigInt(founderTerms.end) - BigInt(founderTerms.cliff));
  assert.ok(founderEntitlement > 0n && founderEntitlement < founderBalanceBefore);
  assert.equal(await balance(nested), founderBalanceBefore - founderEntitlement);
  assert.equal(await balance(safes[1]!.safe), beneficiaryBefore + founderEntitlement);
  assert.equal(BigInt(await call(grantVault, "available()")), vested, "cancelled vested debt remains frozen and owed after later founder release");
  assert.equal(receipts.length, 10);
  const conservation = (await Promise.all([controller, nested, grantVault, ...vaults, recipient, safes[1]!.safe].map(address => balance(address)))).reduce((a, b) => a + b);
  assert.equal(conservation, 100_000_000n * unit);
  const finalBlock = await rpc("eth_getBlockByNumber", ["latest", false]);
  const finalVaultStates = await vaultStatesAt(finalBlock.number);
  for (const snapshot of [{ ...blockIdentity(genesisBlock), vaultStates: genesisVaultStates }, { ...blockIdentity(finalBlock), vaultStates: finalVaultStates }]) {
    const block = await rpc("eth_getBlockByHash", [snapshot.blockHash, false]);
    assert.equal(BigInt(block.number).toString(), snapshot.blockNumber);
    assert.equal(BigInt(block.timestamp).toString(), snapshot.timestamp);
    assert.deepEqual(snapshot.vaultStates, await vaultStatesAt(block.number), "reported state belongs to labelled block");
  }
  return { genesisVaultStates, finalState: { ...blockIdentity(finalBlock), vaultStates: finalVaultStates }, scenarioReceipts,
    sixSafeOutflows: true, preOpeningDenied: true, exactOpeningSpend: true, capSaturated: true, refundDidNotReplenishCap: true,
    exactExpirySpend: true, unauthorizedDenied: true, oneSignatureDenied: true, founderCancellationDenied: true,
    founderBeneficiaryReleased: founderEntitlement.toString(), contributorRefund: refundAmount.toString(), contributorOwed: vested.toString(), conservation: conservation.toString() };
}

for (const cleanupUncertain of [false, true]) {
test(cleanupUncertain ? "completed full assembly with unresolved custody cleanup cannot publish READY" : "same-path synthetic chain-1 full assembly, official 2-of-3 Safes and observed reports", { timeout: 300_000 }, async t => {
  await mkdir(resolve(".local"), { recursive: true, mode: 0o700 });
  const outputRoot = await mkdtemp(resolve(".local/full-assembly-"));
  const output = join(outputRoot, "observed");
  const caps = [3_000_000n, 2_000_000n, 1_000_000n, 4_000_000n, 5_000_000n, 500_000n];
  let privateDirectory = "";
  const proof = runLocalAssemblyProof({ repositoryRoot: ".", outputDirectory: output, ...syntheticExecution,
    prepareAssembly: async ({ root, temporary, signerAddress, startingNonce, safes }) => {
      privateDirectory = temporary;
      await buildCandidateArtifacts(root, temporary);
      const predicted = Array.from({ length: 9 }, (_, i) => localPurposeCompilerPorts.createAddress(signerAddress, (BigInt(startingNonce) + BigInt(i)).toString()));
  const recipients = new Map<string, Hex>([["founder", predicted[1]!], ["contributors", predicted[2]!], ...purposes.map((id, i): [string, Hex] => [id, predicted[i + 3]!])]);
  const allocationShares = [["long-term", 3000], ["users", 3000], ["founder", 300], ["contributors", 1700], ["operations", 900], ["ecosystem", 500], ["financing", 500], ["liquidity", 100]] as const;
  const reserve = { initialSupplyBaseUnits: String(100_000_000n * unit), allocations: allocationShares.map(([id, bps]) => ({ id, recipient: recipients.get(id)!, amountBaseUnits: String(BigInt(bps) * 10_000n * unit), bps })), founder: { beneficiary: safes[1]!.safe, controller: safes[0]!.safe, purpose: encodeAllocationId("founder")!, schedule: calendarSchedule("1800000000") }, contributors: { controller: safes[0]!.safe, purpose: encodeAllocationId("contributors")!, rollingCapBaseUnits: String(16_000_000n * unit), perGrantCapBaseUnits: String(5_000_000n * unit) } };
  const custodySafes = safes.map((safe, i) => ({ id: i === 0 ? "project-controller" : "founder-beneficiary", address: safe.safe, owners: safe.owners, threshold: 2, beneficialControl: "solo-founder", disclosure: "Disposable synthetic test owners." }));
  const aliases = [
    { address: safes[0]!.safe, roles: ["safe.project-controller.address", "token.initialCCIPAdmin", "founder.controller", "contributors.controller"] },
    { address: safes[1]!.safe, roles: ["safe.founder-beneficiary.address", "founder.beneficiary"] },
  ];
  return { schema: "agtmai-local-purpose-genesis-v2", status: "test-only", chainId: "1", tokenContract: "AGTMAICCIPToken", reserve, custodySafes, roleAliases: aliases, projectControllerSafeId: "project-controller", founderBeneficiarySafeId: "founder-beneficiary", purposeVaults: purposes.map((allocationId, i) => ({ allocationId, opensAt: String(1800000100 + i * 10), windowSeconds: String(100 + i * 10), rollingCapBaseUnits: String(caps[i]! * unit) })), execution: { sender: signerAddress, startingNonce: startingNonce, fundingDeadline: "1799999950", fundingLeadSeconds: "20", executionDeadline: "1799999990", maxFeePerGasWei: "10000000000", maxPriorityFeePerGasWei: "1000000000", maxGasPerTransaction: "6000000", maxTotalFeeWei: "1000000000000000000" } };
    },
    scenarios: async local => {
      await verifyDeploymentFiles(join(privateDirectory, "reconstructed"));
      await assert.rejects(verifyDeploymentFiles(join(privateDirectory, "reconstructed"), true), /READY_MISSING/);
      await assert.rejects(readFile(join(privateDirectory, "reconstructed/READY")), { code: "ENOENT" });
      const result = await exerciseAssemblyScenarios(local, caps);
      // Real filesystem custody rejection after successful execution; no replacement cleanup adapter.
      if (cleanupUncertain) { await chmod(dirname(privateDirectory), 0o710); }
      return result;
    },
  });
  if (cleanupUncertain) {
    try {
      await assert.rejects(proof, /ASSEMBLY_PROOF_FAILED/);
      const diagnostic = JSON.parse(await readFile(join(output, "diagnostics.json"), "utf8"));
      assert.equal(diagnostic.status, "failed"); assert.equal(diagnostic.temporaryRootRemoved, false); assert.equal(diagnostic.cleanupUncertain, true);
      assert.equal(diagnostic.operations.length, 10);
      await assert.rejects(readFile(join(output, "READY")), { code: "ENOENT" });
      await readdir(privateDirectory);
    } finally { if (privateDirectory) { await chmod(dirname(privateDirectory), 0o700); await removeOwnedRunDirectory(dirname(privateDirectory)); } }
    return;
  }
  const proofResult = await proof;
  assert.equal(proofResult.operationCount, 10);
  const inventory = await verifyDeploymentFiles(output, true);
  assert.equal(await readFile(join(output, "READY"), "utf8"), `${sha256(await readFile(join(output, "inventory.json")))}\n`);
  assert.deepEqual((await readdir(output)).toSorted(), [...inventory.files.map(f => f.name), "inventory.json", "READY"].toSorted());
  assert.ok(privateDirectory);
  await assert.rejects(readdir(privateDirectory), { code: "ENOENT" });
  await assert.rejects(readdir(dirname(privateDirectory)), { code: "ENOENT" });
  const report = JSON.parse(await readFile(join(output, "local-purpose-proof-v2.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(output, "deployment-manifest-v2.json"), "utf8"));
  const passport = JSON.parse(await readFile(join(output, "token-passport.json"), "utf8"));
  assert.equal(report.cleanup.temporaryRootRemoved, true);
  assert.equal(report.authority.length, 2);
  assert.equal(manifest.contracts.length, 10);
  const deployer = report.roles.assemblyDeployer, firstNonce = BigInt(report.preflight.nextNonce);
  assert.deepEqual(report.senderNonces, { confirmed: firstNonce.toString(), pending: firstNonce.toString() });
  assert.notEqual(deployer, report.roles.bootstrapFunderRelayer);
  for (let i = 0; i < 9; i++) { assert.equal(manifest.contracts[i].observed.address, deriveCreateAddress(deployer, firstNonce + BigInt(i))); }
  assert.equal(manifest.contracts[9].observed.address, deriveCreateAddress(manifest.contracts[1].observed.address, 1n));
  assert.ok(report.bootstrap.every((tx: { sender: string }) => tx.sender !== deployer));
  assert.ok(report.genesis.operations.every((op: { nonce: string }, i: number) => BigInt(op.nonce) === firstNonce + BigInt(i)));
  assert.equal(manifest.observedWei, manifest.gas.reduce((n: bigint, g: { gasUsed: string; effectiveGasPrice: string }) => n + BigInt(g.gasUsed) * BigInt(g.effectiveGasPrice), 0n).toString());
  assert.equal(manifest.contracts[9].observed.childCreateNonce, "1");
  assert.equal(manifest.contracts[9].observed.parentTransactionHash, report.genesis.operations[1].transactionHash);
  assert.equal(Object.hasOwn(manifest.contracts[9].observed, "transactionHash"), false);
  assert.equal(manifest.approval, null);
  assert.match(passport.markdown, /synthetic owned loopback/);
  const publishedPassport = await readFile(join(output, "token-passport.md"), "utf8");
  assert.equal(publishedPassport, passport.markdown);
  assert.ok(publishedPassport.includes(`## Readiness\n\n- Observation interval: ${manifest.genesis.timestamp}–${manifest.genesis.timestamp}`));
  assert.match(publishedPassport, /## Authority registry/);
  assert.match(publishedPassport, /actual production deployment unavailable/);
  assert.deepEqual(passport.authorityRegistry.entries.map((e: { capability: string }) => e.capability).toSorted(), [
    "token-create.initial_ccip_admin", "controller-create.controller", "founder-vault.beneficiary", "founder-vault.controller",
    ...purposes.map(id => `purpose-${id}-create.controller`), "custody.safe.project-controller", "custody.safe.founder-beneficiary",
  ].toSorted());
  const project = report.authority[0].address, beneficiary = report.authority[1].address;
  assert.ok(publishedPassport.includes(`token-create.initial\\_ccip\\_admin on 1 (synthetic loopback): power initial CCIP administration; expected ${project}; observed ${project};`));
  assert.ok(publishedPassport.includes(`founder-vault.beneficiary on 1 (synthetic loopback): power claim vested entitlement; expected ${beneficiary}; observed ${beneficiary};`));
  for (const id of ["controller-create", "founder-vault", ...purposes.map(p => `purpose-${p}-create`)]) {
    assert.ok(publishedPassport.includes(`${id}.controller on 1 (synthetic loopback): power configured immutable control; expected ${project}; observed ${project};`), id);
  }
  for (const [index, id] of ["project-controller", "founder-beneficiary"].entries()) {
    const safe = report.authority[index];
    assert.ok(publishedPassport.includes(`custody.safe.${id} on 1 (synthetic loopback): power Safe CALL control; expected ${safe.address}; observed ${safe.address}; Actual local threshold 2 of 3; nonce ${safe.nonce}; empty modules, guard and fallback; production authority unavailable.`), id);
  }
  const prepared = JSON.parse(await readFile(join(output, "prepared-local-purpose-genesis.json"), "utf8"));
  assert.equal(prepared.genesisAllocationHash.length, 66);
  assert.equal(manifest.contracts[0].immutableValues.GENESIS_ALLOCATION_HASH, prepared.genesisAllocationHash);
  assert.equal(manifest.contracts[0].observed.getters.GENESIS_ALLOCATION_HASH, prepared.genesisAllocationHash);
  assert.throws(() => parseProductionObservation(report), /PREFLIGHT_/);
  // Admit official bytes separately; derive deployment/setup provenance from actual bootstrap captures, never from authority observations.
  const safeDirectory = process.env.AGTMAI_SAFE_ARTIFACT_DIRECTORY!, selectedSafe = process.env.AGTMAI_SAFE_PINS_SHA256 as Hex;
  assert.equal(sha256(await readFile("tooling/testnet-ccip/artifacts/safe-1.4.1-pins.json")), selectedSafe);
  const safePins = JSON.parse(await readFile(join(safeDirectory, "pins.json"), "utf8")) as SafeArtifactPins;
  const safeBytes = { proxy: await readFile(join(safeDirectory, "SafeProxy.json")), singleton: await readFile(join(safeDirectory, "Safe.json")), buildInfo: await readFile(join(safeDirectory, "build-info.json")) };
  const singletonInitcode = JSON.parse(safeBytes.singleton.toString()).bytecode as Hex;
  const singletonCreates = report.bootstrap.filter((tx: { to: Hex | null; input: Hex }) => tx.to === null && tx.input === singletonInitcode);
  assert.equal(singletonCreates.length, 1);
  const singletonCreate = singletonCreates[0];
  assert.equal(singletonCreate.status, "0x1"); assert.equal(singletonCreate.sender, report.roles.bootstrapFunderRelayer); assert.equal(singletonCreate.chainId, "1");
  const singletonAddress = deriveCreateAddress(singletonCreate.sender, BigInt(singletonCreate.nonce));
  const safeProfile = qualifySafeArtifacts(safePins, selectedSafe, safeBytes, singletonAddress);
  const proxyInitcode = `${JSON.parse(safeBytes.proxy.toString()).bytecode}${word(BigInt(singletonAddress))}`;
  const safeDeployments = prepared.configuration.custodySafes.map((configured: { address: Hex; owners: Hex[] }) => {
    const creates = report.bootstrap.filter((tx: { to: Hex | null; input: Hex; sender: Hex; nonce: string }) => tx.to === null && tx.input === proxyInitcode && deriveCreateAddress(tx.sender, BigInt(tx.nonce)) === configured.address);
    assert.equal(creates.length, 1); assert.equal(creates[0].status, "0x1"); assert.equal(creates[0].sender, report.roles.bootstrapFunderRelayer); assert.equal(creates[0].chainId, "1");
    const setups = report.bootstrap.filter((tx: { to: Hex | null; input: Hex }) => tx.to === configured.address && tx.input.startsWith(custodySelector("setup(address[],uint256,address,bytes,address,address,uint256,address)")));
    assert.equal(setups.length, 1); const setup = setups[0];
    assert.equal(setup.status, "0x1"); assert.equal(setup.sender, report.roles.bootstrapFunderRelayer); assert.equal(setup.chainId, "1");
    assert.deepEqual(custodySafeSetupOwners(configured.address, setup.input).toSorted(), configured.owners.toSorted());
    verifyCustodySafeSetupEvent(configured.address, setup.sender, configured.owners, setup.logs);
    return { address: configured.address, setupTransactionHash: setup.transactionHash as Hex };
  });
  const authenticatedSafe = { singletonAddress, proxyCodeHash: safeProfile.proxyRuntimeKeccak256, singletonCodeHash: safeProfile.singletonRuntimeKeccak256, deployments: safeDeployments };
  for (const change of [
    (o: typeof report.genesis) => { o.operations[0].observedCostWei = (BigInt(o.operations[0].observedCostWei) + 1n).toString(); },
    (o: typeof report.genesis) => { o.contracts[9].runtime = o.contracts[9].runtime.slice(0, -2) + (o.contracts[9].runtime.endsWith("00") ? "11" : "00"); },
    (o: typeof report.genesis) => { o.contracts[3].getters.CONTROLLER = `0x${"0".repeat(64)}`; },
    (o: typeof report.genesis) => { o.contracts[9].transactionHash = o.operations[1].transactionHash; },
  ]) {
    const observation = structuredClone(report.genesis); change(observation);
    assert.throws(() => materializeObservedAssemblyManifest(prepared, observation, { ...localPurposeCompilerPorts, authenticatedSafe }), /DEPLOYMENT_EVIDENCE_ASSEMBLY_/);
  }
  const candidate = { repositoryRoot: resolve("."), revision: report.candidateRevision };
  const ready = await readFile(join(output, "READY")); await rm(join(output, "READY"));
  try { await assert.rejects(reconstructLocalAssemblyPackage(output, candidate, prepared, manifest, { authenticatedSafe }), /READY_MISSING/); }
  finally { await writeFile(join(output, "READY"), ready, { flag: "wx", mode: 0o600 }); }
  await reconstructLocalAssemblyPackage(output, candidate, prepared, manifest, { authenticatedSafe });
  const observations = { schema: "agtmai-deployment-observations-v1" as const, observedAt: manifest.genesis.timestamp, validUntil: manifest.genesis.timestamp };
  checkPassport(manifest, observations, passport, { sha256 });
  const tampered = structuredClone(passport); tampered.markdown = tampered.markdown.replace(manifest.observedWei, "0");
  assert.throws(() => checkPassport(manifest, observations, tampered, { sha256 }), /PASSPORT_MISMATCH/);
  assert.deepEqual(generatePassport(manifest, observations, { sha256 }), passport);
  t.diagnostic(`LOCAL_ASSEMBLY_E2E_SUCCESS output=${output}`);

});
}

test("mint before a mined CREATE failure leaves the predicted recipient funded without code", { timeout: 240_000 }, async t => {
  const local = await setupLocalSafes(t);
  const { root, temporary, executor, rpc, call, send, safes } = local;
  const { loaded } = await buildCandidateArtifacts(root, temporary);
  const nonce = BigInt(await rpc("eth_getTransactionCount", [executor.owner, "latest"]));
  const token = localPurposeCompilerPorts.createAddress(executor.owner, nonce.toString());
  const failedTarget = localPurposeCompilerPorts.createAddress(executor.owner, (nonce + 1n).toString());
  const shares = [["long-term", 3000], ["users", 3000], ["founder", 300], ["contributors", 1700], ["operations", 900], ["ecosystem", 500], ["financing", 500], ["liquidity", 100]] as const;
  const allocations = shares.map(([id, bps], i) => ({ id, idBytes32: encodeAllocationId(id)!, recipient: id === "founder" ? failedTarget : `0x${String(i + 1).padStart(40, "0")}` as Hex, amountBaseUnits: String(BigInt(bps) * 10_000n * unit), bps })).toSorted((a, b) => a.idBytes32 < b.idBytes32 ? -1 : 1);
  const tokenArgs = localPurposeCompilerPorts.encodeToken("31337", String(100_000_000n * unit), safes[0]!.safe, allocations);
  const tokenArtifact = loaded.artifacts.find(item => item.contract === "AGTMAICCIPToken")!;
  const tokenReceipt = await send(null, `${tokenArtifact.creationBytecode}${tokenArgs.constructorArgs.slice(2)}` as Hex);
  assert.equal(tokenReceipt.status, "0x1");
  assert.equal(tokenReceipt.contractAddress.toLowerCase(), token);
  assert.equal(BigInt(await call(token, "balanceOf(address)", [failedTarget])), 3_000_000n * unit);
  const founderArtifact = loaded.artifacts.find(item => item.contract === "FounderGrantReserve")!;
  const schedule = calendarSchedule("1800000000");
  const badArgs = localPurposeCompilerPorts.encodeFounderReserve({ token, beneficiary: safes[0]!.safe, controller: safes[0]!.safe, allocation: String(3_000_000n * unit), start: schedule.start, cliff: schedule.cliff, end: schedule.end, purpose: encodeAllocationId("founder")! });
  const failedReceipt = await send(null, `${founderArtifact.creationBytecode}${badArgs.slice(2)}` as Hex);
  assert.equal(failedReceipt.status, "0x0", "invalid founder binding must mine a failed CREATE");
  assert.equal(await rpc("eth_getCode", [failedTarget, "latest"]), "0x");
  assert.equal(BigInt(await rpc("eth_getTransactionCount", [failedTarget, "latest"])), 0n);
  assert.equal(BigInt(await call(token, "balanceOf(address)", [failedTarget])), 3_000_000n * unit);
  assert.equal(BigInt(await rpc("eth_getTransactionCount", [executor.owner, "latest"])), nonce + 2n);
  await local.cleanup();
});

test("owned full-proof preparation failure disposes custody and publishes diagnostics without READY", { timeout: 120_000 }, async () => {
  await mkdir(resolve(".local"), { recursive: true, mode: 0o700 });
  const output = join(await mkdtemp(resolve(".local/full-assembly-denied-")), "diagnostic");
  let privateDirectory = "";
  await assert.rejects(runLocalAssemblyProof({ repositoryRoot: ".", outputDirectory: output, ...syntheticExecution,
    prepareAssembly: async context => { privateDirectory = context.temporary; throw new Error("EXPLICIT_SYNTHETIC_PREPARATION_FAILURE"); },
    scenarios: async () => { throw new Error("SCENARIO_MUST_NOT_RUN"); },
  }), /ASSEMBLY_PROOF_FAILED/);
  const report = JSON.parse(await readFile(join(output, "diagnostics.json"), "utf8"));
  assert.ok(privateDirectory); assert.equal(report.reason, "EXPLICIT_SYNTHETIC_PREPARATION_FAILURE");
  assert.equal(report.status, "failed"); assert.equal(report.temporaryRootRemoved, true);
  assert.deepEqual(report.operations, []); assert.deepEqual(report.journal, []);
  await assert.rejects(readFile(join(output, "READY")), { code: "ENOENT" });
  await assert.rejects(readdir(privateDirectory), { code: "ENOENT" });
  await assert.rejects(readdir(dirname(privateDirectory)), { code: "ENOENT" });
});
