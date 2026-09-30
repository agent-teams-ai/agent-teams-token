import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { calendarSchedule, deploymentBytes, prepareLocalPurposeGenesis, verifyLocalPurposePreflight, type Hex, type LocalPurposeArtifact, type LocalPurposeGenesis, type PreparedLocalPurposeGenesis } from "@agent-teams/supply/deployment";
import { localPurposeCompilerPorts, readLocalPurposeArtifactPins } from "@agent-teams/supply/deployment-files";
import { encodeAllocationId, sha256 } from "@agent-teams/supply/genesis-manifest";
import { custodySelector, custodyTopic } from "../../testnet-ccip/src/adapters/safe-custody.ts";
import { setupLocalSafes, ZERO, word } from "./helpers/local-safe.ts";

const contracts = ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController", "PurposeReserveVault", "GrantVault"] as const;
const paths = contracts.map(name => name === "AGTMAICCIPToken" ? `src/features/token-genesis/${name}.sol` : name === "PurposeReserveVault" ? `src/features/purpose-reserves/${name}.sol` : `src/features/contributor-grants/${name}.sol`);
const purposes = ["long-term", "users", "operations", "ecosystem", "financing", "liquidity"] as const;
const unit = 1_000_000_000n;
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
async function assertGenesis(local: Awaited<ReturnType<typeof setupLocalSafes>>, prepared: PreparedLocalPurposeGenesis, expectations: {
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

async function assertFounderIrrevocable(local: Awaited<ReturnType<typeof setupLocalSafes>>, token: Hex, vault: Hex, reserve: Hex) {
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

async function assertOpeningBoundary(local: Awaited<ReturnType<typeof setupLocalSafes>>, vault: Hex, opensAt: bigint, outflow: (vault: Hex, value: bigint) => ReturnType<typeof local.safeExec>) {
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

test("disposable 31337 six-vault genesis and 2-of-3 Safe outflows", { timeout: 300_000 }, async t => {
  const local = await setupLocalSafes(t, 2);
  const { root, temporary, executor, rpc, call, send, safes, safeExec, encode } = local;
  const nonce = BigInt(await rpc("eth_getTransactionCount", [executor.owner, "latest"]));
  const { candidateRevision, loaded } = await buildCandidateArtifacts(root, temporary);
  const predicted = Array.from({ length: 9 }, (_, i) => localPurposeCompilerPorts.createAddress(executor.owner, (nonce + BigInt(i)).toString()));
  const recipients = new Map<string, Hex>([["founder", predicted[1]!], ["contributors", predicted[2]!], ...purposes.map((id, i): [string, Hex] => [id, predicted[i + 3]!])]);
  const allocationShares = [["long-term", 3000], ["users", 3000], ["founder", 300], ["contributors", 1700], ["operations", 900], ["ecosystem", 500], ["financing", 500], ["liquidity", 100]] as const;
  const reserve = { initialSupplyBaseUnits: String(100_000_000n * unit), allocations: allocationShares.map(([id, bps]) => ({ id, recipient: recipients.get(id)!, amountBaseUnits: String(BigInt(bps) * 10_000n * unit), bps })), founder: { beneficiary: safes[1]!.safe, controller: safes[0]!.safe, purpose: encodeAllocationId("founder")!, schedule: calendarSchedule("1800000000") }, contributors: { controller: safes[0]!.safe, purpose: encodeAllocationId("contributors")!, rollingCapBaseUnits: String(16_000_000n * unit), perGrantCapBaseUnits: String(5_000_000n * unit) } };
  const custodySafes = safes.map((safe, i) => ({ id: i === 0 ? "project-controller" : "founder-beneficiary", address: safe.safe, owners: safe.owners, threshold: 2, beneficialControl: "solo-founder", disclosure: "Disposable synthetic test owners." }));
  const aliases = [
    { address: safes[0]!.safe, roles: ["safe.project-controller.address", "token.initialCCIPAdmin", "founder.controller", "contributors.controller"] },
    { address: safes[1]!.safe, roles: ["safe.founder-beneficiary.address", "founder.beneficiary"] },
  ];
  const caps = [3_000_000n, 2_000_000n, 1_000_000n, 4_000_000n, 5_000_000n, 500_000n];
  const config = { schema: "agtmai-local-purpose-genesis-v1", status: "test-only", chainId: "31337", tokenContract: "AGTMAICCIPToken", reserve, custodySafes, roleAliases: aliases, projectControllerSafeId: "project-controller", founderBeneficiarySafeId: "founder-beneficiary", purposeVaults: purposes.map((allocationId, i) => ({ allocationId, opensAt: String(1800000100 + i * 10), windowSeconds: String(100 + i * 10), rollingCapBaseUnits: String(caps[i]! * unit) })), execution: { sender: executor.owner, startingNonce: nonce.toString(), fundingDeadline: "1799999950", fundingLeadSeconds: "20", executionDeadline: "1799999990", maxFeePerGasWei: "10000000000", maxPriorityFeePerGasWei: "1000000000", maxGasPerTransaction: "6000000", maxTotalFeeWei: "1000000000000000000" } };
  const prepared = prepareLocalPurposeGenesis(config, candidateRevision, loaded, localPurposeCompilerPorts);
  const observe = async () => {
    const block = await rpc("eth_getBlockByNumber", ["latest", false]);
    const addresses = [...prepared.operations.filter(op => op.kind === "create").map(op => op.expectedAddress!), prepared.operations[1]!.nestedAddress!];
    return { chainId: "31337" as const, blockHash: block.hash as Hex, blockNumber: BigInt(block.number).toString(), timestamp: BigInt(block.timestamp).toString(), sender: executor.owner, nextNonce: BigInt(await rpc("eth_getTransactionCount", [executor.owner, "latest"])).toString(), accounts: await Promise.all(addresses.map(async address => ({ address, code: await rpc("eth_getCode", [address, "latest"]) as Hex, nonce: BigInt(await rpc("eth_getTransactionCount", [address, "latest"])).toString() }))) };
  };
  verifyLocalPurposePreflight(prepared, await observe());
  const receipts = [];
  let totalFees = 0n;
  for (const operation of prepared.operations) {
    const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
    assert.ok(BigInt(latest.timestamp) <= BigInt(operation.id === "founder-fund" ? config.execution.fundingDeadline : config.execution.executionDeadline));
    if (operation.id === "founder-fund") {
      assert.equal(BigInt(await call(operation.to!, "VAULT()")), BigInt(operation.nestedAddress ?? prepared.operations[1]!.nestedAddress!));
      assert.equal(BigInt(await call(prepared.operations[1]!.nestedAddress!, "funded()")), 0n, "founder vault must not be funded by another caller");
    }
    const receipt = await send(operation.kind === "create" ? null : operation.to!, operation.kind === "create" ? operation.initcode! : operation.calldata!);
    assert.equal(receipt.status, "0x1", operation.id);
    assert.equal(receipt.contractAddress?.toLowerCase() ?? null, operation.expectedAddress ?? null);
    assert.ok(BigInt(receipt.gasUsed) <= BigInt(config.execution.maxGasPerTransaction));
    assert.ok(BigInt(receipt.effectiveGasPrice) <= BigInt(config.execution.maxFeePerGasWei));
    totalFees += BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    assert.ok(totalFees <= BigInt(config.execution.maxTotalFeeWei));
    const block = await rpc("eth_getBlockByHash", [receipt.blockHash, false]);
    assert.ok(BigInt(block.timestamp) <= BigInt(operation.id === "founder-fund" ? config.execution.fundingDeadline : config.execution.executionDeadline));
    receipts.push({ id: operation.id, hash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, timestamp: block.timestamp, status: receipt.status, contractAddress: receipt.contractAddress });
  }
  const genesisBlock = await rpc("eth_getBlockByNumber", ["latest", false]);
  const { token, controller, nested, vaults, balance } = await assertGenesis(local, prepared, { tokenTransactionHash: receipts[0]!.hash, predicted, caps, config, artifacts: loaded.artifacts });
  assert.equal((await rpc("eth_getBlockByNumber", ["latest", false])).hash, genesisBlock.hash);
  const vaultStatesAt = (block: Hex) => Promise.all(vaults.map(async (vault, i) => ({ allocationId: purposes[i], address: vault, balance: (await balance(vault, block)).toString(), grossOutflow: BigInt(await call(vault, "grossOutflow()", [], { block })).toString(), rollingOutflow: BigInt(await call(vault, "rollingOutflow()", [], { block })).toString() })));
  const genesisVaultStates = await vaultStatesAt(genesisBlock.number);
  const recipient = executor.owner;
  const scenarioReceipts: { scenario: string; transactionHash: Hex; blockHash: Hex; blockNumber: string; timestamp: string; innerSuccess: boolean }[] = [];
  const recordSafe = async (scenario: string, result: Awaited<ReturnType<typeof safeExec>>) => {
    if (result.receipt) {
      const block = await rpc("eth_getBlockByHash", [result.receipt.blockHash, false]);
      scenarioReceipts.push({ scenario, transactionHash: result.receipt.transactionHash, blockHash: result.receipt.blockHash, blockNumber: BigInt(result.receipt.blockNumber).toString(), timestamp: BigInt(block.timestamp).toString(), innerSuccess: result.success });
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
  assert.equal(await balance(grantVault), unit);
  assert.equal(BigInt(await call(grantVault, "funded()")), 1n);
  assert.equal(BigInt(await call(controller, "rollingCommitted()")), unit);
  const beforeGrantRefund = await balance(controller);
  await rpc("evm_setNextBlockTimestamp", [Number(BigInt(grantSchedule.cliff) + 1n)]);
  const cancelled = await recordSafe("contributor-cancel", await safeExec(safes[0]!, grantVault, await encode("cancel()", [])));
  assert.equal(cancelled.success, true, "contributor cancellation through actual Safe signatures");
  const refundLog = cancelled.receipt!.logs.find((log: { address: Hex; topics: Hex[] }) => log.address.toLowerCase() === grantVault && log.topics[0] === custodyTopic("TeamGrantCancelled(bytes32,uint256,uint256,uint64)"));
  assert.ok(refundLog);
  const refundAmount = BigInt(`0x${refundLog.data.slice(66, 130)}`);
  assert.ok(refundAmount > 0n && refundAmount < unit);
  assert.equal(await balance(controller) - beforeGrantRefund, refundAmount);
  assert.equal(await balance(grantVault), unit - refundAmount);
  assert.equal(BigInt(await call(controller, "grossCommitted()")), unit);
  assert.equal(receipts.length, 10);
  assert.equal((await Promise.all([controller, nested, grantVault, ...vaults, recipient].map(address => balance(address)))).reduce((a, b) => a + b), 100_000_000n * unit);
  const finalBlock = await rpc("eth_getBlockByNumber", ["latest", false]);
  const finalVaultStates = await vaultStatesAt(finalBlock.number);
  const report = { schema: "agtmai-local-purpose-proof-v1", evidenceClass: "observed-disposable-local-execution", status: "success", qualification: "disposable-local-only", candidateRevision, configuration: prepared.configuration, configurationSha256: prepared.configurationSha256, planSha256: prepared.planSha256, artifacts: prepared.artifacts.map(artifact => ({ contract: artifact.contract, artifactSha256: artifact.artifactSha256, buildInfoSha256: artifact.buildInfoSha256, compilerInputSha256: artifact.compilerInputSha256 })), safes: safes.map(safe => ({ address: safe.safe, owners: safe.owners, threshold: 2, singleton: local.singleton, proxyCodeHash: local.pins.proxy.runtimeKeccak256, singletonCodeHash: local.pins.singleton.runtimeKeccak256, setupTransaction: safe.setup.transactionHash, guard: ZERO, fallbackHandler: ZERO, modules: [] })), genesis: { ...blockIdentity(genesisBlock), allocations: reserve.allocations, founderVault: nested, vaultStates: genesisVaultStates }, finalState: { ...blockIdentity(finalBlock), vaultStates: finalVaultStates }, receipts, scenarioReceipts, scenarios: { sixSafeOutflows: true, preOpeningDenied: true, exactOpeningSpend: true, capSaturated: true, refundDidNotReplenishCap: true, exactExpirySpend: true, unauthorizedDenied: true, oneSignatureDenied: true, founderFunded: true, founderCancellationDenied: true, contributorGrantRefunded: true }, conservation: "100000000000000000", cleanup: "complete" };
  // Validate the serialized snapshot labels against the chain before disposing it.
  for (const snapshot of [report.genesis, report.finalState]) {
    const block = await rpc("eth_getBlockByHash", [snapshot.blockHash, false]);
    assert.equal(BigInt(block.number).toString(), snapshot.blockNumber);
    assert.equal(BigInt(block.timestamp).toString(), snapshot.timestamp);
    assert.deepEqual(snapshot.vaultStates, await vaultStatesAt(block.number), "reported vault state belongs to its labeled block");
  }
  await local.cleanup();
  t.diagnostic(`LOCAL_PURPOSE_E2E_SUCCESS ${JSON.stringify(report)}`);
});

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
