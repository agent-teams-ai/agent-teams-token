import { prepareLocalPurposeGenesis, verifyPreparedLocalPurposeGenesis, verifyLocalPurposePreflight, materializeObservedAssemblyManifest, deploymentBytes, generatePassport, type Hex, type PreparedLocalPurposeGenesis, type AssemblyOperationObservation, type DeploymentBlock, type LocalAssemblyObservation, type ObservedAssemblyManifest } from "@agent-teams/supply/deployment";
import { loadPreparedProductionPackage, readDeploymentFile, readLocalPurposeArtifactPins, localPurposeCompilerPorts, publishDeploymentFiles, verifyDeploymentFiles } from "@agent-teams/supply/deployment-files";
import { sha256 } from "@agent-teams/supply/genesis-manifest";
import { provisionLocalSafes, settleOwnedSignerWork, type LocalSafe, type LocalSafePorts, type executeLocalSafe } from "../../tooling/testnet-ccip/src/adapters/local-safe.ts";
import { qualifySafeArtifacts, type SafeArtifactPins } from "../../tooling/testnet-ccip/src/adapters/safe-artifacts.ts";
import { checkedOperationGas, reserveAssemblyCost, type ApprovedProductionPolicy, type ProductionStateObservation } from "../../tooling/deployment-plan/src/domain/production-guards.ts";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, keccak256 } from "../../tooling/deployment-plan/src/domain/identity.ts";
import { cleanupFailures, finishWithCleanup } from "../../tooling/local-evm/cleanup.ts";
import { LocalEvmError } from "../../tooling/local-evm/model.ts";
import { checkedCommand, startOwnedAnvil, type OwnedAnvil } from "../../tooling/local-evm/process.ts";
import { createRunLease, reclaimStaleRuns, registerRunAnvil, confirmRunAnvilRegistration, removeOwnedRunDirectory } from "../../tooling/local-evm/run-lease.ts";
import { createInitializingRunDirectory, publishInitializedRun } from "../../tooling/local-evm/run-initialization.ts";
import { createLocalExecutionRpcClient } from "../../tooling/local-evm/rpc.ts";
import { ensurePrivateDirectoryPath, publishInitialFile, readOwnedBoundedFile, validatePrivateDirectory } from "../../tooling/local-evm/safe-fs.ts";
import { privateRunRoot } from "../../tooling/local-evm/runner.ts";
import { pinnedFoundryBinaries } from "../../tooling/local-evm/toolchain.ts";

type Prepared = Awaited<ReturnType<typeof loadPreparedProductionPackage>>;
type Rpc = ReturnType<typeof createLocalExecutionRpcClient>;
const FOUNDER = "3000000000000000";
const SUPPLY = "100000000000000000";
const SOURCE_REVISION = "dfe89da4c77a186aefbaead50981a327317f3bc4";

interface EphemeralSignerCapability {
  readonly address: string;
  readonly keystorePath: string;
  readonly passwordPath: string;
}

/** The sole signer factory: key material is born inside the owned private run. */
async function createEphemeralSignerCapability(
  cast: string,
  directory: string,
  name = "test-only-ephemeral-signer",
): Promise<EphemeralSignerCapability> {
  const password = randomBytes(32).toString("hex");
  const passwordPath = join(directory, `${name}.password`);
  const keystorePath = join(directory, name);
  await publishInitialFile(passwordPath, Buffer.from(`${password}\n`, "ascii"), 0o600);
  const result = await checkedCommand(cast, ["wallet", "new", directory, name, "--json"], {
    code: "PROOF_SIGNER_GENERATION_FAILED",
    env: { PATH: process.env.PATH, LANG: "C", HOME: directory, CAST_PASSWORD: password },
  });
  const parsed = JSON.parse(result.stdout) as { data?: Array<{ address?: unknown; path?: unknown }> };
  const wallet = parsed.data?.[0];
  if (!wallet || typeof wallet.address !== "string" || typeof wallet.path !== "string"
    || resolve(wallet.path) !== resolve(keystorePath)) {
    throw new Error("PROOF_SIGNER_GENERATION_INVALID");
  }
  await chmod(keystorePath, 0o600);
  const address = parseAddress(wallet.address);
  return Object.freeze({ address, keystorePath, passwordPath });
}

export interface LocalExecutionPreparationContext {
  /** Address-only capability used to bind a newly prepared authenticated package. */
  readonly signerAddress: string;
  /** Invocation-owned, unpublished target. The callback must publish the package here. */
  readonly packageDirectory: string;
}

export interface LocalExecutionProofOptions {
  readonly repositoryRoot: string;
  /** Prepare and authenticate the package after the internal signer address exists. */
  readonly preparePackage: (context: LocalExecutionPreparationContext) => Promise<void>;
  readonly outputDirectory: string;
  readonly now?: () => bigint;
}

/** Execute only the authenticated prepared inventory on a disposable loopback Anvil. */
/* oxlint-disable complexity -- one owner retains the bounded four-send lifecycle and cleanup debt. */
export async function runLocalExecutionProof(options: LocalExecutionProofOptions): Promise<Record<string, unknown>> {
  if ("signerKeystorePath" in options || "signerPasswordPath" in options || "signerCapability" in options || "preparedDirectory" in options) {
    throw new Error("PROOF_EXTERNAL_SIGNER_OR_PACKAGE_INJECTION_UNSUPPORTED");
  }
  const root = await realpath(resolve(options.repositoryRoot));
  const foundry = pinnedFoundryBinaries(root);
  const privateRoot = privateRunRoot(root);
  await ensurePrivateDirectoryPath(await realpath("/tmp"), privateRoot);
  await reclaimStaleRuns(privateRoot);
  const runId = `${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`;
  const initial = await createInitializingRunDirectory(privateRoot, runId);
  const runDirectory = await publishInitializedRun(initial, async () => await createRunLease(initial.directory));
  let anvil: OwnedAnvil | undefined;
  let primary: unknown;
  let signerAddress = "";
  try {
    const castEnvironment = {...process.env, HOME: runDirectory};
    await assertFoundryVersions(foundry, castEnvironment);
    const signerCapability = await createEphemeralSignerCapability(foundry.cast, runDirectory);
    const packageStagingDirectory = join(runDirectory, "package-staging");
    await mkdir(packageStagingDirectory, {mode: 0o700});
    await validatePrivateDirectory(packageStagingDirectory);
    const stagingIdentity = await directoryIdentity(packageStagingDirectory);
    const packageDirectory = join(packageStagingDirectory, "prepared");
    await options.preparePackage(Object.freeze({ signerAddress: signerCapability.address, packageDirectory }));
    await validatePrivateDirectory(packageStagingDirectory);
    if (await directoryIdentity(packageStagingDirectory) !== stagingIdentity) {throw new Error("PROOF_PACKAGE_STAGING_SUBSTITUTED");}
    await validatePrivateDirectory(packageDirectory);
    if (await realpath(packageDirectory) !== packageDirectory) {throw new Error("PROOF_PACKAGE_PATH_SUBSTITUTED");}
    const prepared = await loadPreparedProductionPackage(packageDirectory);
    const expectations = prepared.expectations;
    assertPrepared(prepared);
    if (signerCapability.address !== expectations.sender) {throw new Error("PROOF_SIGNER_SENDER_MISMATCH");}
    const passwordValid = await (async () => {
      const keystore = await readOwnedBoundedFile(signerCapability.keystorePath, "PROOF_SIGNER_KEYSTORE", { logicalBytes: 65_536, allocatedBytes: 131_072 }, 0o600);
      try {
        const password = await readOwnedBoundedFile(signerCapability.passwordPath, "PROOF_SIGNER_PASSWORD", { logicalBytes: 129, allocatedBytes: 8192 }, 0o600);
        try {return /^[0-9a-f]{64}\n$/.test(password.bytes.toString("ascii"));}
        finally {password.bytes.fill(0);}
      } finally {keystore.bytes.fill(0);}
    })();
    if (!passwordValid) {throw new Error("PROOF_SIGNER_PASSWORD");}
    const signer = ["--keystore", signerCapability.keystorePath, "--password-file", signerCapability.passwordPath] as const;
    signerAddress = parseAddress((await checkedCommand(foundry.cast, ["wallet", "address", ...signer], { code: "PROOF_SIGNER_ADDRESS_FAILED", env: castEnvironment })).stdout);
    if (signerAddress !== expectations.sender) {throw new Error("PROOF_SIGNER_SENDER_MISMATCH");}
    const start = BigInt(prepared.configuration.reserveGenesis.founder.schedule.start);
    const policy = prepared.configuration.deployment.policy;
    const lead = BigInt(policy.fundingLeadSeconds);
    const executionLimit = [BigInt(policy.executionDeadline), BigInt(policy.fundingDeadline), start - lead]
      .reduce((earliest, limit) => limit < earliest ? limit : earliest);
    const clock = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    const initialNow = clock();
    // Retain eight seconds of headroom within both approved limits and the
    // fixture clock, so the four real receipt blocks precede observation.
    const initialTimestamp = (initialNow < executionLimit ? initialNow : executionLimit) - 8n;
    if (lead > start || initialTimestamp < 0n || initialNow > executionLimit) {throw new Error("PROOF_EXECUTION_TIMING_IMPOSSIBLE");}
    anvil = await startOwnedAnvil(foundry.anvil, signerAddress, async identity => await registerRunAnvil(runDirectory, identity), {
      chainId: "1", timestamp: initialTimestamp.toString(),
    });
    const rpc = createLocalExecutionRpcClient(anvil.rpcUrl);
    const chainId = await rpc.request("eth_chainId"), netVersion = await rpc.request("net_version");
    if (typeof chainId !== "string" || quantityToDecimal(chainId) !== "1" || netVersion !== "1") {throw new Error("PROOF_CHAIN_ID");}
    await rpc.request("anvil_setNonce", [expectations.sender, quantity(BigInt(expectations.startingNonce))]);
    if (quantityToDecimal(await rpc.request("eth_getTransactionCount", [expectations.sender, "pending"]) as string) !== expectations.startingNonce) {throw new Error("PROOF_STARTING_NONCE");}
    const operations: Record<string, unknown>[] = [];
    let observedTotalCost = 0n;
    let finalBlock = await latestBlock(rpc), fundingBefore: FundingBefore | undefined;
    for (const operation of prepared.operations) {
      const expected = expectations.operations.find(item => item.id === operation.id);
      if (!expected || expected.nonce !== operation.nonce || expected.kind !== operation.kind) {throw new Error("PROOF_OPERATION_BINDING");}
      const input = operation.kind === "create" ? operation.initcode! : operation.calldata!;
      if (operation.id === "founder-fund") {fundingBefore = await captureFundingBefore(rpc, prepared, finalBlock);}
      const nextTimestamp = initialTimestamp + BigInt(operations.length) + 1n;
      await checkedCommand(foundry.cast, ["rpc", "evm_setNextBlockTimestamp", quantity(nextTimestamp), "--rpc-url", anvil.rpcUrl, "--no-proxy"], { code: "PROOF_BLOCK_TIMESTAMP_CONFIGURATION", env: castEnvironment });
      const transactionHash = await sendSignedOperation({ cast: foundry.cast, signer, environment: castEnvironment, rpcUrl: anvil.rpcUrl, operation, expected, input });
      const receipt = await waitForReceipt(rpc, transactionHash);
      if (receipt.status !== "0x1") {throw new Error(`PROOF_RECEIPT_${operation.id}`);}
      const transactionFacts = assertTransaction(await transactionByHash(rpc, transactionHash), receipt, operation.kind, expectations.sender, operation.nonce, input, expected, operation.to);
      observedTotalCost += BigInt(transactionFacts.observedCostWei);
      const block = await blockByNumber(rpc, receipt.blockNumber); finalBlock = block;
      if (BigInt(block.timestamp) !== nextTimestamp) {throw new Error("PROOF_BLOCK_TIMESTAMP_MISMATCH");}
      const expectedAddress = expected.expectedAddress;
      const actualAddress = operation.kind === "create" ? receipt.contractAddress : operation.to;
      if (actualAddress !== expectedAddress) {throw new Error(`PROOF_ADDRESS_${operation.id}`);}
      const runtime = operation.kind === "create" ? await rpc.request("eth_getCode", [actualAddress, receipt.blockNumber]) as string : undefined;
      const artifact = operation.kind === "create" ? prepared.artifacts.find(item => item.contract === contractFor(operation.id)) : undefined;
      if (operation.kind === "create" && (!runtime || runtime === "0x" || !artifact)) {throw new Error(`PROOF_RUNTIME_${operation.id}`);}
      const runtimeEvidence = runtime && artifact ? { runtime, runtimeHash: keccak256(hexBytes(runtime)), artifact: artifact.runtimeBytecode, artifactSha256: artifact.artifactSha256, immutableReferences: artifact.immutableReferences.map(reference => ({ name: reference.name, start: String(reference.start), length: String(reference.length), value: `0x${runtime.slice(2 + reference.start * 2, 2 + (reference.start + reference.length) * 2)}` })) } : {};
      operations.push({ id: operation.id, address: expectedAddress, ...(operation.nestedAddress ? { nestedAddress: operation.nestedAddress } : {}), ...(operation.kind === "create" ? { creation: input, ...runtimeEvidence } : { calldata: input }), value: "0", nonce: operation.nonce, transactionHash, receiptTransactionHash: receipt.transactionHash, transactionIndex: quantityToDecimal(receipt.transactionIndex), sender: expectations.sender, input, status: "1", blockNumber: quantityToDecimal(receipt.blockNumber), blockHash: block.hash, timestamp: quantityToDecimal(block.timestamp), expectedAddress, actualAddress, ...transactionFacts });
    }
    if (!fundingBefore) {throw new Error("PROOF_FUNDING_PRESTATE");}
    const pendingNonce = quantityToDecimal(await rpc.request("eth_getTransactionCount", [expectations.sender, "pending"]) as string);
    if (pendingNonce !== (BigInt(expectations.startingNonce) + 4n).toString()) {throw new Error("PROOF_PENDING_NONCE");}
    const state = await collectState(rpc, prepared, expectations.sender, finalBlock, fundingBefore);
    const now = clock();
    if (now < initialNow || now < BigInt(finalBlock.timestamp) || now > executionLimit) {throw new Error("PROOF_EXECUTION_TIMING_IMPOSSIBLE");}
    const observation = { schema: "agtmai-production-observation-v2", chainId: "1", sender: expectations.sender, pendingNonce, blockNumber: finalBlock.number, blockHash: finalBlock.hash, observedAt: now.toString(), expiresAt: (now + BigInt(expectations.maxObservationAgeSeconds)).toString(), observedTotalCostWei: observedTotalCost.toString(), rpcEndpoint: anvil.rpcUrl, netVersion: "1", binding: { sourceRevision: expectations.sourceRevision, configurationSha256: prepared.configurationSha256, reserveConfigurationSha256: prepared.reserveConfigurationSha256, artifactPinsSha256: expectations.artifactPinsSha256 }, operations, checkedAddresses: [...new Set([...prepared.operations.flatMap(operation => operation.expectedAddress ? [operation.expectedAddress] : []), ...prepared.operations.flatMap(operation => operation.nestedAddress ? [operation.nestedAddress] : []), ...state.allocations.map(allocation => allocation.recipient)])].toSorted(), occupiedAddresses: [], authority: expectations.authority, state, cleanup: { processExited: false, exitCode: "0", descriptorsClosed: false, temporaryRootRemoved: false, diagnostic: null } };
    await anvil.stop(); anvil = undefined;
    await removeOwnedRunDirectory(runDirectory);
    const complete = { ...observation, cleanup: { processExited: true, exitCode: "0", descriptorsClosed: true, temporaryRootRemoved: true, diagnostic: null } };
    await publishObservation(options.outputDirectory, complete);
    return { status: "observed", observationPath: join(resolve(options.outputDirectory), "production-observation-v2.json"), operationCount: 4, signerAddress };
  } catch (cause) {primary = cause; throw cause;}
  finally {
    let stopped = false;
    await finishWithCleanup(primary, [
      async () => {
        await anvil?.stop();
        stopped = anvil !== undefined || cleanupFailures(primary).length === 0;
      },
      async () => {if (stopped) {await removeOwnedRunDirectory(runDirectory);}},
    ]);
  }
}
/* oxlint-enable complexity */

async function directoryIdentity(directory: string): Promise<string> {
  const entry = await lstat(directory, {bigint: true});
  if (!entry.isDirectory() || entry.isSymbolicLink()) {throw new Error("PROOF_PACKAGE_STAGING_SUBSTITUTED");}
  return `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`;
}

interface Block { readonly number: string; readonly hash: string; readonly timestamp: string }
interface FundingBefore { readonly block: Block; readonly reserve: string; readonly vault: string; readonly allowance: string; readonly funded: boolean }

async function captureFundingBefore(rpc: Rpc, prepared: Prepared, block: Block): Promise<FundingBefore> {
  const token = preparedOperation(prepared, "token-create").expectedAddress!, reserve = preparedOperation(prepared, "founder-reserve-create").expectedAddress!;
  const vault = decodeAddress(await call(rpc, reserve, "VAULT()", [], block.number));
  const funded = decodeBool(await call(rpc, vault, "funded()", [], block.number));
  if (funded) {throw new Error("PROOF_FUNDING_ALREADY_DONE");}
  return { block, reserve: wordUint(await call(rpc, token, "balanceOf(address)", [reserve], block.number)), vault: wordUint(await call(rpc, token, "balanceOf(address)", [vault], block.number)), allowance: wordUint(await call(rpc, token, "allowance(address,address)", [reserve, vault], block.number)), funded };
}

async function collectState(rpc: Rpc, prepared: Prepared, sender: string, block: Block, before: FundingBefore): Promise<ProductionStateObservation> {
  const token = preparedOperation(prepared, "token-create").expectedAddress!, founderReserve = preparedOperation(prepared, "founder-reserve-create").expectedAddress!, controller = preparedOperation(prepared, "controller-create").expectedAddress!;
  const expectedVault = preparedOperation(prepared, "founder-reserve-create").nestedAddress;
  const tokenState = { address: token, name: decodeString(await call(rpc, token, "name()", [], block.number)), symbol: decodeString(await call(rpc, token, "symbol()", [], block.number)), decimals: wordUint(await call(rpc, token, "decimals()", [], block.number)), initialSupply: wordUint(await call(rpc, token, "INITIAL_SUPPLY()", [], block.number)), totalSupply: wordUint(await call(rpc, token, "totalSupply()", [], block.number)), genesisAllocationHash: await call(rpc, token, "GENESIS_ALLOCATION_HASH()", [], block.number), ccipAdmin: decodeAddress(await call(rpc, token, "getCCIPAdmin()", [], block.number)) };
  const vault = decodeAddress(await call(rpc, founderReserve, "VAULT()", [], block.number));
  if (!expectedVault || vault !== expectedVault) {throw new Error("PROOF_VAULT_ADDRESS");}
  const grant = await call(rpc, vault, "grant()", [], block.number);
  const terms = { allocation: wordUintAt(grant, 0), start: wordUintAt(grant, 1), cliff: wordUintAt(grant, 2), end: wordUintAt(grant, 3), kind: wordUintAt(grant, 4), originalPurpose: wordAt(grant, 5) };
  const allocations = await Promise.all(prepared.configuration.deployment.allocations.map(async allocation => ({ identifier: allocation.id, bps: String(allocation.bps), amountBaseUnits: allocation.amountBaseUnits, recipient: allocation.recipient, balance: wordUint(await call(rpc, token, "balanceOf(address)", [allocation.recipient], block.number)), syntheticPreparedAddress: true as const })));
  const vaultAfter = wordUint(await call(rpc, token, "balanceOf(address)", [vault], block.number));
  const fundedAfter = decodeBool(await call(rpc, vault, "funded()", [], block.number));
  if (!fundedAfter) {throw new Error("PROOF_FUNDING_NOT_SET");}
  const secondCallRejected = await revertedCall(rpc, founderReserve, preparedOperation(prepared, "founder-fund").calldata!, sender, block.number);
  const allocationBalances = allocations.reduce((sum, allocation) => sum + BigInt(allocation.balance), 0n);
  return { blockNumber: block.number, blockHash: block.hash, token: tokenState, founderReserve: { address: founderReserve, token: decodeAddress(await call(rpc, founderReserve, "TOKEN()", [], block.number)), vault }, founderVault: { address: vault, token: decodeAddress(await call(rpc, vault, "TOKEN()", [], block.number)), beneficiary: decodeAddress(await call(rpc, vault, "BENEFICIARY()", [], block.number)), originalReserve: decodeAddress(await call(rpc, vault, "ORIGINAL_RESERVE()", [], block.number)), controller: decodeAddress(await call(rpc, vault, "CONTROLLER()", [], block.number)), funded: true, terms }, controller: { address: controller, token: decodeAddress(await call(rpc, controller, "TOKEN()", [], block.number)), controller: decodeAddress(await call(rpc, controller, "CONTROLLER()", [], block.number)), purpose: await call(rpc, controller, "PURPOSE()", [], block.number), rollingCap: wordUint(await call(rpc, controller, "ROLLING_CAP()", [], block.number)), perGrantCap: wordUint(await call(rpc, controller, "PER_GRANT_CAP()", [], block.number)), window: wordUint(await call(rpc, controller, "WINDOW()", [], block.number)), grossCommitted: wordUint(await call(rpc, controller, "grossCommitted()", [], block.number)), rollingCommitted: wordUint(await call(rpc, controller, "rollingCommitted()", [], block.number)) }, allocations, funding: { caller: sender, amountBaseUnits: FOUNDER, beforeBlockNumber: before.block.number, beforeBlockHash: before.block.hash, afterBlockNumber: block.number, afterBlockHash: block.hash, reserveBefore: before.reserve, reserveAfter: wordUint(await call(rpc, token, "balanceOf(address)", [founderReserve], block.number)), vaultBefore: before.vault, vaultAfter, allowanceBefore: before.allowance, allowanceAfter: wordUint(await call(rpc, token, "allowance(address,address)", [founderReserve, vault], block.number)), fundedBefore: false, fundedAfter: true, secondCallRejected }, conservation: { totalSupplyBaseUnits: tokenState.totalSupply, observedBalancesBaseUnits: (allocationBalances + BigInt(vaultAfter)).toString() } };
}

async function publishObservation(directory: string, value: unknown): Promise<void> { const target = resolve(directory); await mkdir(target, { recursive: false, mode: 0o700 }); await validatePrivateDirectory(target); const bytes = Buffer.from(canonicalJson(value), "utf8"); await publishInitialFile(join(target, "production-observation-v2.json"), bytes); await publishInitialFile(join(target, "READY"), Buffer.from(`${keccak256(bytes)}\n`, "ascii")); }
async function latestBlock(rpc: Rpc): Promise<Block> {return await blockByNumber(rpc, await rpc.request("eth_blockNumber") as string);}
async function blockByNumber(rpc: Rpc, number: string): Promise<Block> { const value = await rpc.request("eth_getBlockByNumber", [number, false]); if (!value || typeof value !== "object" || Array.isArray(value)) {throw new Error("PROOF_BLOCK");} const block = value as Record<string, unknown>; if (typeof block.number !== "string" || typeof block.hash !== "string" || typeof block.timestamp !== "string" || !/^0x[0-9a-f]{64}$/.test(block.hash)) {throw new Error("PROOF_BLOCK");} return { number: quantityToDecimal(block.number), hash: block.hash, timestamp: block.timestamp }; }
async function waitForReceipt(rpc: Rpc, hash: string): Promise<Record<string, string>> { for (let attempt = 0; attempt < 100; attempt += 1) { const value = await rpc.request("eth_getTransactionReceipt", [hash]); if (value && typeof value === "object" && !Array.isArray(value)) {return value as Record<string, string>;} await new Promise<void>(_resolve => {setTimeout(_resolve, 10);}); } throw new Error("PROOF_RECEIPT_TIMEOUT"); }
async function transactionByHash(rpc: Rpc, hash: string): Promise<Record<string, string | null>> { const value = await rpc.request("eth_getTransactionByHash", [hash]); if (!value || typeof value !== "object" || Array.isArray(value)) {throw new Error("PROOF_TRANSACTION");} return value as Record<string, string | null>; }
async function sendSignedOperation(request: { readonly cast: string; readonly signer: readonly string[]; readonly environment: NodeJS.ProcessEnv; readonly rpcUrl: string; readonly operation: Prepared["operations"][number]; readonly expected: Prepared["expectations"]["operations"][number]; readonly input: string }): Promise<string> {
  const {cast, signer, environment, rpcUrl, operation, expected, input} = request;
  if (!expected.gasLimit || !expected.maxFeePerGas || expected.maxPriorityFeePerGas === undefined) {throw new Error("PROOF_GAS_EXPECTATION");}
  const common = ["send", "--rpc-url", rpcUrl, "--no-proxy", "--chain", "1", ...signer, "--async", "--gas-limit", expected.gasLimit, "--gas-price", expected.maxFeePerGas, "--priority-gas-price", expected.maxPriorityFeePerGas, "--nonce", operation.nonce, "--value", "0"];
  const commandArguments = operation.kind === "create" ? [...common, "--create", input] : [...common, operation.to!, "--data", input];
  const result = await checkedCommand(cast, commandArguments, { code: `PROOF_SEND_${operation.id}`, env: environment });
  const hash = result.stdout.trim();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {throw new Error("PROOF_TRANSACTION_HASH");}
  return hash;
}

// oxlint-disable-next-line max-params, complexity -- compares one RPC transaction and receipt against one prepared operation.
function assertTransaction(transaction: Record<string, string | null>, receipt: Record<string, string>, kind: "create" | "call", sender: string, nonce: string, input: string, expected: Pick<Prepared["expectations"]["operations"][number], "gasLimit" | "maxFeePerGas" | "maxPriorityFeePerGas">, to?: string): { readonly gasLimit: string; readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string; readonly gasUsed: string; readonly effectiveGasPrice: string; readonly observedCostWei: string } {
  if (transaction.hash !== receipt.transactionHash || transaction.blockHash !== receipt.blockHash || transaction.blockNumber !== receipt.blockNumber || transaction.transactionIndex !== receipt.transactionIndex || transaction.from !== sender || transaction.nonce === null || quantityToDecimal(transaction.nonce) !== nonce || transaction.input !== input || transaction.value !== "0x0" || (kind === "create" ? transaction.to !== null : transaction.to !== to) || receipt.from !== sender || (kind === "call" && receipt.to !== to)) {throw new Error("PROOF_TRANSACTION_BINDING");}
  if (transaction.gas === null || transaction.maxFeePerGas === null || transaction.maxPriorityFeePerGas === null || !receipt.gasUsed || !receipt.effectiveGasPrice) {throw new Error("PROOF_TRANSACTION_FEE_FIELDS");}
  const gasLimit = quantityToDecimal(transaction.gas), maxFeePerGas = quantityToDecimal(transaction.maxFeePerGas), maxPriorityFeePerGas = quantityToDecimal(transaction.maxPriorityFeePerGas), gasUsed = quantityToDecimal(receipt.gasUsed), effectiveGasPrice = quantityToDecimal(receipt.effectiveGasPrice);
  if (gasLimit !== expected.gasLimit || maxFeePerGas !== expected.maxFeePerGas || maxPriorityFeePerGas !== expected.maxPriorityFeePerGas || BigInt(gasUsed) === 0n || BigInt(gasUsed) > BigInt(gasLimit) || BigInt(effectiveGasPrice) === 0n || BigInt(effectiveGasPrice) > BigInt(maxFeePerGas)) {throw new Error("PROOF_TRANSACTION_FEE_BINDING");}
  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasUsed, effectiveGasPrice, observedCostWei: (BigInt(gasUsed) * BigInt(effectiveGasPrice)).toString() };
}
async function call(rpc: Rpc, to: string, signature: string, args: readonly string[], block: string): Promise<string> { const data = `${selector(signature)}${args.map(addressWord).join("")}`; const value = await rpc.request("eth_call", [{ to, data }, quantity(BigInt(block))]); if (typeof value !== "string" || !/^0x[0-9a-f]*$/.test(value)) {throw new Error("PROOF_CALL");} return value; }
async function revertedCall(rpc: Rpc, to: string, data: string, from: string, block: string): Promise<true> { try {await rpc.request("eth_call", [{ to, from, data, value: "0x0" }, quantity(BigInt(block))]);} catch (cause) {if (cause instanceof LocalEvmError && cause.code === "LOCAL_EVM_RPC_EXECUTION_ERROR") {return true;} throw cause;} throw new Error("PROOF_FUNDING_NOT_ONE_SHOT"); }

function assertPrepared(prepared: Prepared): void {
  const expected = [["long-term", 3000, "30000000000000000"], ["users", 3000, "30000000000000000"], ["founder", 300, FOUNDER], ["contributors", 1700, "17000000000000000"], ["operations", 900, "9000000000000000"], ["ecosystem", 500, "5000000000000000"], ["financing", 500, "5000000000000000"], ["liquidity", 100, "1000000000000000"]] as const;
  const expectations = prepared.expectations, allocations = prepared.configuration.deployment.allocations;
  if (expectations.sourceRevision !== SOURCE_REVISION) {throw new Error("PROOF_SOURCE_REVISION_BINDING");}
  if (prepared.configurationSha256 !== expectations.configurationSha256 || prepared.reserveConfigurationSha256 !== expectations.reserveConfigurationSha256) {throw new Error("PROOF_CONFIGURATION_BINDING");}
  if (prepared.runtimeVerification.status !== "unresolved-immutables" || prepared.runtimeVerification.reason !== "PRODUCTION_RUNTIME_IMMUTABLES_REQUIRE_DETERMINISTIC_LOCAL_EXECUTION") {throw new Error("PROOF_RUNTIME_STATUS");}
  if (prepared.configuration.deployment.status !== "accepted" || prepared.configuration.reserveGenesis.status !== "accepted") {throw new Error("PROOF_ACCEPTED_STATUS");}
  if (prepared.configuration.deployment.token.initialSupplyBaseUnits !== SUPPLY || allocations.length !== expected.length || new Set(allocations.map(allocation => allocation.id)).size !== expected.length) {throw new Error("PROOF_SUPPLY_BINDING");}
  for (const [id, bps, amount] of expected) {const allocation = allocations.find(item => item.id === id); if (allocation?.bps !== bps || allocation.amountBaseUnits !== amount) {throw new Error(`PROOF_ALLOCATION_BINDING_${id}`);}}
  if (prepared.operations.length !== 4 || prepared.operations.map(item => item.id).join(",") !== "token-create,founder-reserve-create,controller-create,founder-fund" || expectations.operations.length !== 4 || expectations.operations.some((item, index) => item.id !== prepared.operations[index]?.id || item.nonce !== (BigInt(expectations.startingNonce) + BigInt(index)).toString() || item.value !== "0")) {throw new Error("PROOF_OPERATION_INVENTORY");}
}
async function assertFoundryVersions(foundry: { readonly forge: string; readonly cast: string; readonly anvil: string }, environment: NodeJS.ProcessEnv): Promise<void> { for (const [name, executable] of Object.entries(foundry)) { const result = await checkedCommand(executable, ["--version"], { code: "PROOF_FOUNDRY_VERSION", env: environment }); if (!new RegExp(`^${name} Version: 1\\.8\\.0(?:$|\\n)`).test(result.stdout)) {throw new Error("PROOF_FOUNDRY_VERSION");} } }
function preparedOperation(prepared: Prepared, id: string): Prepared["operations"][number] {const selected = prepared.operations.find(item => item.id === id); if (!selected) {throw new Error("PROOF_OPERATION_INVENTORY");} return selected;}
function selector(signature: string): string {return keccak256(new TextEncoder().encode(signature)).slice(0, 10);}
function addressWord(value: string): string {return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");}
function quantity(value: bigint): string {return `0x${value.toString(16)}`;}
function quantityToDecimal(value: string): string {if (!/^0x[0-9a-f]+$/.test(value)) {throw new Error("PROOF_QUANTITY");} return BigInt(value).toString();}
function hexBytes(value: string): Uint8Array {return Uint8Array.from(value.slice(2).match(/../g) ?? [], byte => Number.parseInt(byte, 16));}
function wordAt(value: string, index: number): string {const start = 2 + index * 64; return `0x${value.slice(start, start + 64)}`;}
function wordUintAt(value: string, index: number): string {return BigInt(wordAt(value, index)).toString();}
function wordUint(value: string): string {return wordUintAt(value, 0);}
function decodeAddress(value: string): string {return `0x${wordAt(value, 0).slice(-40)}`;}
function decodeBool(value: string): boolean {return wordUint(value) === "1";}
function decodeString(value: string): string {try {const offset = Number(BigInt(wordAt(value, 0))), length = Number(BigInt(`0x${value.slice(2 + offset * 2, 2 + offset * 2 + 64)}`)); return Buffer.from(value.slice(2 + offset * 2 + 64, 2 + offset * 2 + 64 + length * 2), "hex").toString("utf8");} catch {throw new Error("PROOF_STRING");}}
function contractFor(id: string): "AGTMAICCIPToken" | "FounderGrantReserve" | "ReserveController" {return id === "token-create" ? "AGTMAICCIPToken" : id === "founder-reserve-create" ? "FounderGrantReserve" : "ReserveController";}
function parseAddress(output: string): string { const address = output.trim().toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(address)) {throw new Error("PROOF_SIGNER_ADDRESS");} return address; }

if (process.argv[1]?.endsWith("local-execution-proof.ts")) {
  process.stderr.write("PROOF_IN_PROCESS_ORCHESTRATOR_REQUIRED\n");
  process.exitCode = 2;
}

export interface LocalAssemblyContext {
  readonly root: string; readonly temporary: string; readonly signerAddress: Hex; readonly startingNonce: string;
  readonly safes: readonly LocalSafe[];
}
export interface LocalAssemblyScenarioContext extends LocalAssemblyContext {
  readonly prepared: PreparedLocalPurposeGenesis; readonly receipts: readonly AssemblyOperationObservation[];
  readonly executor: { readonly owner: Hex }; readonly singleton: Hex; readonly pins: SafeArtifactPins;
  readonly rpc: LocalSafePorts["rpc"]; readonly call: LocalSafePorts["call"]; readonly send: LocalSafePorts["send"]; readonly encode: LocalSafePorts["encode"];
  readonly safeExec: (safe: LocalSafe, to: Hex, data: Hex, count?: number) => ReturnType<typeof executeLocalSafe>;
}
export interface LocalAssemblyProofOptions {
  readonly repositoryRoot: string; readonly outputDirectory: string;
  readonly initialTimestamp: string; readonly gasBufferBps: number; readonly gasFundingWei: string;
  readonly bootstrapGas: { readonly gasLimit: string; readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string };
  /** Writes artifacts/pins.json under this invocation; only synthetic local-purpose-v2 policy is admitted. */
  readonly prepareAssembly: (context: LocalAssemblyContext) => Promise<unknown>;
  readonly scenarios: (context: LocalAssemblyScenarioContext) => Promise<Record<string, unknown>>;
}

/** One same-path assembly attempt. This owns signing/processes; Supply owns construction/runtime expectations. */
// oxlint-disable-next-line complexity, max-lines-per-function -- one bounded ten-send owner retains the single chain, signer custody and cleanup debt; operation execution and reconstruction are separate phases.
export async function runLocalAssemblyProof(options: LocalAssemblyProofOptions): Promise<Record<string, unknown>> {
  if (["signerKeystorePath", "signerPasswordPath", "signerCapability", "preparedDirectory"].some(k => k in options)) { throw new Error("PROOF_EXTERNAL_SIGNER_OR_PACKAGE_INJECTION_UNSUPPORTED"); }
  const root = await realpath(resolve(options.repositoryRoot)), foundry = pinnedFoundryBinaries(root);
  const privateRoot = privateRunRoot(root);
  await ensurePrivateDirectoryPath(await realpath("/tmp"), privateRoot); await reclaimStaleRuns(privateRoot);
  const initial = await createInitializingRunDirectory(privateRoot, `${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`);
  const runDirectory = await publishInitializedRun(initial, async () => await createRunLease(initial.directory));
  let anvil: OwnedAnvil | undefined, primary: unknown, removed = false;
  const journal: { operationId: string; state: string; intent: string; transactionHash?: string }[] = [];
  const assembly: AssemblyOperationObservation[] = [], bootstrap: Record<string, unknown>[] = [], scenarioCosts: Record<string, unknown>[] = [];
  let files: Record<string, Uint8Array> | undefined, frozenConstruction: Record<string, unknown> | undefined;
  try {
    const environment = { PATH: process.env.PATH, LANG: "C", HOME: runDirectory, TMPDIR: runDirectory };
    await assertFoundryVersions(foundry, environment);
    const run = async (args: string[]) => (await checkedCommand(foundry.cast, args, { code: "ASSEMBLY_CAST_FAILED", env: environment })).stdout.trim();
    const sender = await createEphemeralSignerCapability(foundry.cast, runDirectory, "assembly");
    const funder = await createEphemeralSignerCapability(foundry.cast, runDirectory, "bootstrap");
    const owners = await settleOwnedSignerWork(Array.from({ length: 6 }, (_, i) => createEphemeralSignerCapability(foundry.cast, runDirectory, `owner-${i}`)));
    if (new Set([sender.address, funder.address, ...owners.map(o => o.address)]).size !== 8) { throw new Error("ASSEMBLY_ROLE_COLLISION"); }
    anvil = await startOwnedAnvil(foundry.anvil, funder.address, async id => await confirmRunAnvilRegistration(runDirectory, id), { chainId: "1", timestamp: options.initialTimestamp }, runDirectory);
    const endpoint = anvil.rpcUrl, client = createLocalExecutionRpcClient(endpoint);
    const rpc: LocalSafePorts["rpc"] = (method, params = []) => client.request(method, params);
    if (await rpc("eth_chainId") !== "0x1" || await rpc("net_version") !== "1") { throw new Error("ASSEMBLY_CHAIN"); }
    await rpc("anvil_setBlockTimestampInterval", [1]);
    const encode: LocalSafePorts["encode"] = async (sig, args) => await run(["calldata", sig, ...args]) as Hex;
    const localCall: LocalSafePorts["call"] = async (to, sig, args = [], o = {}) => await rpc("eth_call", [{ to, data: await encode(sig, args), ...(o.from ? { from: o.from } : {}) }, o.block ?? "latest"]) as Hex;
    const getBlock = async () => await rpc("eth_getBlockByNumber", ["latest", false]);
    const transportSend = async (s: EphemeralSignerCapability, to: Hex | null, input: Hex, gas: { gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string }, submission: { value?: string; expectedNonce?: string; submitted?: (hash: string) => Promise<void> } = {}) => {
      const value = submission.value ?? "0";
      const nonce = BigInt(await rpc("eth_getTransactionCount", [s.address, "latest"])).toString();
      if (BigInt(await rpc("eth_getTransactionCount", [s.address, "pending"])).toString() !== nonce || (submission.expectedNonce !== undefined && nonce !== submission.expectedNonce)) { throw new Error("ASSEMBLY_PENDING_NONCE"); }
      const hash = await run(["send", "--rpc-url", endpoint, "--no-proxy", "--chain", "1", ...signerFlags(s), "--async", "--nonce", nonce,
        "--gas-limit", gas.gasLimit, "--gas-price", gas.maxFeePerGas, "--priority-gas-price", gas.maxPriorityFeePerGas, "--value", value,
        ...(to ? [to, "--data", input] : ["--create", input])]);
      if (!/^0x[0-9a-f]{64}$/.test(hash)) { throw new Error("ASSEMBLY_TRANSACTION_HASH"); }
      await submission.submitted?.(hash);
      const receipt = await waitForReceipt(client, hash) as any;
      const transaction = await transactionByHash(client, hash);
      if (transaction.chainId !== "0x1" || transaction.from !== s.address || transaction.input !== input || transaction.to !== to
        || BigInt(transaction.nonce!) !== BigInt(nonce) || BigInt(transaction.value!) !== BigInt(value)) { throw new Error("ASSEMBLY_TRANSACTION_BINDING"); }
      return { receipt, transaction };
    };
    const auxiliaryGas = options.bootstrapGas;
    let auxiliary = bootstrap;
    const send: LocalSafePorts["send"] = async (to, input) => {
      const { receipt, transaction } = await transportSend(funder, to, input, auxiliaryGas);
      const cost = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
      auxiliary.push({ sender: funder.address, chainId: "1", nonce: BigInt(transaction.nonce!).toString(), to, input, logs: receipt.logs, transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, gasUsed: BigInt(receipt.gasUsed).toString(), effectiveGasPrice: BigInt(receipt.effectiveGasPrice).toString(), observedCostWei: cost.toString(), status: receipt.status });
      assertTransaction(transaction, receipt, to ? "call" : "create", funder.address, BigInt(transaction.nonce!).toString(), input, auxiliaryGas, to ?? undefined);
      return receipt;
    };
    const safeDirectory = process.env.AGTMAI_SAFE_ARTIFACT_DIRECTORY, selected = process.env.AGTMAI_SAFE_PINS_SHA256 as Hex | undefined;
    if (!safeDirectory || !selected) { throw new Error("SAFE_OFFICIAL_ARTIFACTS_REQUIRED"); }
    const authorityBytes = await readDeploymentFile(join(root, "tooling/testnet-ccip/artifacts/safe-1.4.1-pins.json"));
    if (sha256(authorityBytes) !== selected) { throw new Error("SAFE_PROVISIONING_AUTHORITY_MISMATCH"); }
    const pins = JSON.parse(Buffer.from(await readDeploymentFile(join(safeDirectory, "pins.json"))).toString()) as SafeArtifactPins;
    const bytes = { proxy: await readDeploymentFile(join(safeDirectory, "SafeProxy.json")), singleton: await readDeploymentFile(join(safeDirectory, "Safe.json")), buildInfo: await readDeploymentFile(join(safeDirectory, "build-info.json"), 32 * 1024 * 1024) };
    const passive = await provisionLocalSafes({ chainId: "1", relayer: funder.address as Hex, rpc, encode, call: localCall, send,
      sign: async (owner, hash) => await run(["wallet", "sign", "--no-hash", hash, ...signerFlags(owners.find(o => o.address === owner)!)]) as Hex,
      verifySignature: async (owner, hash, signature) => { await run(["wallet", "verify", "--address", owner, "--no-hash", hash, signature]); return true; },
    }, { pins, selected, bytes }, [owners.slice(0, 3).map(o => o.address as Hex), owners.slice(3).map(o => o.address as Hex)]);
    const safeProfile = qualifySafeArtifacts(pins, selected, bytes, passive.singleton);
    const authenticatedSafe = Object.freeze({ singletonAddress: safeProfile.singleton,
      proxyCodeHash: safeProfile.proxyRuntimeKeccak256, singletonCodeHash: safeProfile.singletonRuntimeKeccak256,
      deployments: Object.freeze(passive.safes.map(s => Object.freeze({ address: s.safe, setupTransactionHash: s.setup.transactionHash }))) });
    const observedPorts = { ...localPurposeCompilerPorts, authenticatedSafe };
    const gasFundingWei = options.gasFundingWei;
    const gasFunding = await transportSend(funder, sender.address as Hex, "0x", { ...auxiliaryGas, gasLimit: "21000" }, { value: gasFundingWei });
    if (gasFunding.receipt.status !== "0x1") { throw new Error("ASSEMBLY_GAS_FUNDING"); }
    bootstrap.push({ sender: funder.address, chainId: "1", nonce: BigInt(gasFunding.transaction.nonce!).toString(), transactionHash: gasFunding.receipt.transactionHash, valueWei: gasFundingWei, observedCostWei: (BigInt(gasFunding.receipt.gasUsed) * BigInt(gasFunding.receipt.effectiveGasPrice)).toString() });
    const startingNonce = BigInt(await rpc("eth_getTransactionCount", [sender.address, "latest"])).toString();
    if (BigInt(await rpc("eth_getTransactionCount", [sender.address, "pending"])).toString() !== startingNonce) { throw new Error("ASSEMBLY_PENDING_NONCE"); }
    const staging = join(runDirectory, "assembly-staging");
    await mkdir(staging, { mode: 0o700 }); await validatePrivateDirectory(staging);
    const stagingIdentity = await directoryIdentity(staging);
    const context = { root, temporary: staging, signerAddress: sender.address as Hex, startingNonce, safes: passive.safes };
    const selectedConfig = await options.prepareAssembly(Object.freeze(context));
    await validatePrivateDirectory(staging);
    if (await directoryIdentity(staging) !== stagingIdentity) { throw new Error("PROOF_PACKAGE_STAGING_SUBSTITUTED"); }
    const revision = (await checkedCommand("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const candidate = { repositoryRoot: root, revision };
    const loaded = await readLocalPurposeArtifactPins(join(staging, "artifacts/pins.json"), candidate);
    const prepared = prepareLocalPurposeGenesis(selectedConfig, revision, loaded, localPurposeCompilerPorts);
    if (prepared.schema !== "agtmai-prepared-local-purpose-genesis-v2" || prepared.configuration.execution.sender !== sender.address || prepared.configuration.execution.startingNonce !== startingNonce) { throw new Error("ASSEMBLY_SYNTHETIC_V2_REQUIRED"); }
    const configured = prepared.configuration;
    const policy: ApprovedProductionPolicy = { evmMaxFeePerGasWei: configured.execution.maxFeePerGasWei, evmMaxPriorityFeePerGasWei: configured.execution.maxPriorityFeePerGasWei,
      evmMaxGasPerTransaction: configured.execution.maxGasPerTransaction, evmMaxTotalFeeWei: configured.execution.maxTotalFeeWei,
      gasBufferBps: options.gasBufferBps, executionDeadline: configured.execution.executionDeadline, fundingDeadline: configured.execution.fundingDeadline, fundingLeadSeconds: configured.execution.fundingLeadSeconds,
      founderStart: configured.reserve.founder.schedule.start, observationMaxAgeSeconds: "300", estimateValiditySeconds: "300", tokenExpenditureCeilingBaseUnits: FOUNDER, tokenExpenditureBaseUnits: FOUNDER };
    const at = await getBlock();
    const senderNonces = { confirmed: BigInt(await rpc("eth_getTransactionCount", [sender.address, at.number])).toString(), pending: BigInt(await rpc("eth_getTransactionCount", [sender.address, "pending"])).toString() };
    if (senderNonces.confirmed !== startingNonce || senderNonces.pending !== startingNonce) { throw new Error("ASSEMBLY_NONCE_DRIFT"); }
    const accounts = await Promise.all(prepared.constructors!.map(async c => ({ address: c.predictedAddress, code: await rpc("eth_getCode", [c.predictedAddress, at.number]), nonce: BigInt(await rpc("eth_getTransactionCount", [c.predictedAddress, at.number])).toString() })));
    const preflight = { chainId: "1" as const, blockHash: at.hash, blockNumber: BigInt(at.number).toString(), timestamp: BigInt(at.timestamp).toString(), sender: sender.address as Hex, nextNonce: startingNonce, accounts };
    verifyLocalPurposePreflight(prepared, preflight);
    const authority = await Promise.all(passive.safes.map(s => passive.inspect(s, at.number)));
    for (const safe of configured.custodySafes) {
      const actual = authority.find(s => s.address === safe.address);
      if (!actual || actual.owners.toSorted().join() !== safe.owners.toSorted().join() || actual.threshold !== safe.threshold || actual.nonce !== "0") { throw new Error("ASSEMBLY_SAFE_BINDING"); }
    }
    frozenConstruction = { prepared, preflight, senderNonces, authority };
    await publishInitialFile(join(runDirectory, "frozen-construction.json"), deploymentBytes(frozenConstruction));
    let committed = 0n, fundingBefore: LocalAssemblyObservation["fundingBefore"] | undefined;
    const execute = async (op: PreparedLocalPurposeGenesis["operations"][number], i: number) => {
      const predecessor = await getBlock(), nonce = BigInt(await rpc("eth_getTransactionCount", [sender.address, "latest"])).toString();
      if (nonce !== op.nonce || BigInt(await rpc("eth_getTransactionCount", [sender.address, "pending"])).toString() !== nonce) { throw new Error("ASSEMBLY_NONCE_DRIFT"); }
      if (BigInt(predecessor.timestamp) + 1n > BigInt(i === 9 ? policy.fundingDeadline : policy.executionDeadline)) { throw new Error("ASSEMBLY_DEADLINE"); }
      const available = BigInt(await rpc("eth_getBalance", [sender.address, predecessor.number]));
      reserveAssemblyCost(policy, committed, 10 - i, available);
      if (op.id === "founder-fund") {
        const token = prepared.constructors![0]!.predictedAddress, reserve = prepared.constructors![1]!.predictedAddress, vault = prepared.constructors![9]!.predictedAddress;
        fundingBefore = { block: blockIdentity(predecessor), reserveBalance: BigInt(await localCall(token, "balanceOf(address)", [reserve], { block: predecessor.number })).toString(),
          vaultBalance: BigInt(await localCall(token, "balanceOf(address)", [vault], { block: predecessor.number })).toString(), allowance: BigInt(await localCall(token, "allowance(address,address)", [reserve, vault], { block: predecessor.number })).toString(), funded: await localCall(vault, "funded()", [], { block: predecessor.number }) };
      }
      const input = (op.initcode ?? op.calldata)!;
      const maxFeePerGas = policy.evmMaxFeePerGasWei, maxPriorityFeePerGas = policy.evmMaxPriorityFeePerGasWei;
      const estimateRequest = { from: sender.address, ...(op.to ? { to: op.to } : {}), data: input, value: "0x0", nonce: quantity(BigInt(nonce)), maxFeePerGas: quantity(BigInt(maxFeePerGas)), maxPriorityFeePerGas: quantity(BigInt(maxPriorityFeePerGas)) };
      const gasEstimate = BigInt(await rpc("eth_estimateGas", [estimateRequest, predecessor.number])).toString();
      const gas = { gasEstimate, gasLimit: ((BigInt(gasEstimate) * BigInt(10000 + policy.gasBufferBps) + 9999n) / 10000n).toString(), baseFeePerGas: BigInt(predecessor.baseFeePerGas).toString(), blockGasLimit: BigInt(predecessor.gasLimit).toString(), maxFeePerGas, maxPriorityFeePerGas };
      const cost = checkedOperationGas({ ...op, ...gas, intentHash: prepared.planSha256 }, policy);
      reserveAssemblyCost(policy, committed + cost, 9 - i, available - cost);
      if ((await getBlock()).hash !== predecessor.hash) { throw new Error("ASSEMBLY_ESTIMATE_STATE_CHANGED"); }
      const state: typeof journal[number] = { operationId: op.id, state: "pending", intent: keccak256(deploymentBytes(op)) };
      journal.push(state); await publishInitialFile(join(runDirectory, `pending-${i}.json`), deploymentBytes({ attemptIdentity: prepared.planSha256, ...state, predecessor: blockIdentity(predecessor), ...gas }));
      try {
        const { receipt, transaction } = await transportSend(sender, op.to ?? null, input, gas, { expectedNonce: op.nonce, submitted: async hash => { state.transactionHash = hash; await publishInitialFile(join(runDirectory, `submitted-${i}.json`), deploymentBytes(state)); } });
        state.transactionHash = receipt.transactionHash;
        if (receipt.status !== "0x1") { state.state = "finalized-revert"; throw new Error("ASSEMBLY_MINED_REVERT"); }
        const fees = assertTransaction(transaction, receipt, op.kind, sender.address, op.nonce, input, gas, op.to);
        const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
        if (block.hash !== receipt.blockHash || block.parentHash !== predecessor.hash || BigInt(block.number) !== BigInt(predecessor.number) + 1n || BigInt(block.timestamp) !== BigInt(predecessor.timestamp) + 1n || (op.kind === "create" && receipt.contractAddress !== op.expectedAddress)) { throw new Error("ASSEMBLY_RECEIPT_BLOCK"); }
        await Promise.all(prepared.constructors!.filter(record => record.id === op.id || (record.creation.kind === "nested" && record.creation.parentOperationId === op.id)).map(async c => {
          if (await rpc("eth_getCode", [c.predictedAddress, receipt.blockNumber]) !== c.materializedRuntime) { throw new Error("ASSEMBLY_RUNTIME"); }
        }));
        assembly.push({ id: op.id, sender: sender.address as Hex, chainId: "1", nonce: op.nonce, input, value: "0", status: "1", actualAddress: (op.expectedAddress ?? op.to)!, transactionHash: receipt.transactionHash,
          ...gas, ...fees, receiptBaseFeePerGas: BigInt(block.baseFeePerGas).toString(), parentHash: block.parentHash, predecessor: blockIdentity(predecessor), block: blockIdentity(block), logs: receipt.logs.map((l: any) => ({ address: l.address, topics: l.topics, data: l.data, removed: l.removed, logIndex: BigInt(l.logIndex).toString() })) });
        committed += cost; state.state = "finalized-success";
      } catch (cause) { if (state.state === "pending") { state.state = "uncertain"; } throw cause; }
    };
    for (const [i, op] of prepared.operations.entries()) { await execute(op, i); }
    const genesisBlock = await getBlock();
    if (BigInt(await rpc("eth_getTransactionCount", [sender.address, "latest"])) !== BigInt(startingNonce) + 10n || BigInt(await rpc("eth_getTransactionCount", [sender.address, "pending"])) !== BigInt(startingNonce) + 10n) { throw new Error("ASSEMBLY_FINAL_NONCE"); }
    const token = prepared.constructors![0]!.predictedAddress;
    const contracts = await Promise.all(prepared.constructors!.map(async c => {
      const names = [...Object.keys(c.immutableValues).map(n => n === "INITIAL_CCIP_ADMIN" ? "getCCIPAdmin" : n),
        ...(c.contract === "AGTMAICCIPToken" ? ["totalSupply", "decimals"] : c.contract === "ReserveController" ? ["WINDOW", "grossCommitted", "rollingCommitted"] : c.contract === "PurposeReserveVault" ? ["grossOutflow", "rollingOutflow"] : c.contract === "GrantVault" ? ["funded", "grant"] : [])];
      return { id: c.id, address: c.predictedAddress, runtime: await rpc("eth_getCode", [c.predictedAddress, genesisBlock.number]) as Hex, nonce: BigInt(await rpc("eth_getTransactionCount", [c.predictedAddress, genesisBlock.number])).toString(),
        getters: Object.fromEntries(await Promise.all(names.map(async n => [n, await localCall(c.predictedAddress, `${n}()`, [], { block: genesisBlock.number })]))),
        balance: BigInt(await localCall(token, "balanceOf(address)", [c.predictedAddress], { block: genesisBlock.number })).toString() };
    }));
    if (!fundingBefore) { throw new Error("ASSEMBLY_FUNDING_PRESTATE"); }
    let repeatCallRevert: Hex | undefined;
    try { await rpc("eth_call", [{ from: sender.address, to: prepared.operations[9]!.to, data: prepared.operations[9]!.calldata }, genesisBlock.number]); }
    catch (cause) { if (cause instanceof LocalEvmError && (cause as { data?: unknown }).data === selector("AlreadyFunded()")) { repeatCallRevert = selector("AlreadyFunded()") as Hex; } else { throw cause; } }
    if (!repeatCallRevert) { throw new Error("ASSEMBLY_FUNDING_NOT_ONE_SHOT"); }
    const fundingAfter = { repeatCallRevert, allowance: BigInt(await localCall(token, "allowance(address,address)", [prepared.constructors![1]!.predictedAddress, prepared.constructors![9]!.predictedAddress], { block: genesisBlock.number })).toString() };
    const evidence = { fundingAfter, gasBufferBps: policy.gasBufferBps, authority, fundingBefore, operations: assembly, contracts, genesis: blockIdentity(genesisBlock), observedWei: assembly.reduce((n, o) => n + BigInt(o.observedCostWei), 0n).toString() };
    const manifest = materializeObservedAssemblyManifest(prepared, evidence, observedPorts);
    const packageDirectory = join(staging, "reconstructed");
    const packageFiles = { ...loaded.files, "artifact-pins.json": await readDeploymentFile(join(staging, "artifacts/pins.json")), "canonical-local-configuration.json": deploymentBytes(configured), "prepared-local-purpose-genesis.json": deploymentBytes(prepared), "deployment-manifest-v2.json": deploymentBytes(manifest) };
    await publishDeploymentFiles(packageDirectory, packageFiles); await verifyDeploymentFiles(packageDirectory);
    await reconstructLocalAssemblyPackage(packageDirectory, candidate, prepared, manifest, { authenticatedSafe, requireReady: false });
    // Frozen historical genesis evidence: later freshness checks deliberately expire it; no live-readiness window is asserted.
    const passport = generatePassport(manifest, { schema: "agtmai-deployment-observations-v1", observedAt: manifest.genesis.timestamp, validUntil: manifest.genesis.timestamp }, { sha256 });
    auxiliary = scenarioCosts;
    const scenarios = await options.scenarios({ ...context, prepared, receipts: assembly, executor: { owner: funder.address as Hex }, singleton: passive.singleton, pins, rpc, call: localCall, send, encode, safeExec: passive.safeExec });
    const report = { schema: "agtmai-local-purpose-proof-v2", broadcastAllowed: false, approval: null, authorityClass: "test-only", chainId: "1", qualification: "synthetic-owned-loopback-only", status: "success",
      roles: { assemblyDeployer: sender.address, bootstrapFunderRelayer: funder.address }, candidateRevision: revision, configurationSha256: prepared.configurationSha256, attemptIdentity: prepared.planSha256, packageTiming: manifest.packageTiming,
      preflight, senderNonces, authority, journal, genesis: evidence, bootstrap, scenarioCosts, scenarios, cleanup: { processExited: true, descriptorsClosed: true, temporaryRootRemoved: true } };
    files = { ...packageFiles, "local-purpose-proof-v2.json": deploymentBytes(report), "deployment-manifest-v2.json": deploymentBytes(manifest), "reserve-facts.json": deploymentBytes(manifest.facts), "token-passport.json": deploymentBytes(passport), "token-passport.md": Buffer.from(passport.markdown), "authority-registry.json": deploymentBytes(passport.authorityRegistry) };
  } catch (cause) { primary = cause; }
  try {
    let stopped = false;
    await finishWithCleanup(primary, [async () => { await anvil?.stop(); stopped = anvil !== undefined || cleanupFailures(primary).length === 0; }, async () => { if (stopped) { await removeOwnedRunDirectory(runDirectory); removed = true; } }]);
  } catch (cause) { primary = cause; }
  if (primary !== undefined || !removed || !files) {
    const target = resolve(options.outputDirectory); await mkdir(target, { mode: 0o700 }); await validatePrivateDirectory(target);
    await publishInitialFile(join(target, "diagnostics.json"), deploymentBytes({ broadcastAllowed: false, status: "failed", reason: publicAssemblyFailure(primary), ...(frozenConstruction ? { frozenConstruction } : {}), journal, operations: assembly, bootstrap, scenarioCosts, temporaryRootRemoved: removed, cleanupUncertain: !removed }));
    throw new Error("ASSEMBLY_PROOF_FAILED", { cause: primary });
  }
  // Cleanup has succeeded; READY acknowledges complete local delivery, never broadcast authority.
  await publishDeploymentFiles(options.outputDirectory, files, false, true);
  return { status: "observed", broadcastAllowed: false, operationCount: 10, outputDirectory: resolve(options.outputDirectory) };
}

function signerFlags(s: EphemeralSignerCapability): string[] { return ["--keystore", s.keystorePath, "--password-file", s.passwordPath]; }
function blockIdentity(b: { number: string; hash: Hex; timestamp: string }): DeploymentBlock { return { number: BigInt(b.number).toString(), hash: b.hash, timestamp: BigInt(b.timestamp).toString() }; }

/** Final output requires READY; the runner explicitly admits its unready intermediate reconstruction. */
export async function reconstructLocalAssemblyPackage(directory: string, candidate: { repositoryRoot: string; revision: string }, prepared: PreparedLocalPurposeGenesis, manifest: ObservedAssemblyManifest, admission: { readonly authenticatedSafe: Parameters<typeof materializeObservedAssemblyManifest>[2]["authenticatedSafe"]; readonly requireReady?: boolean }): Promise<void> {
  await verifyDeploymentFiles(directory, admission.requireReady ?? true);
  const pins = await readLocalPurposeArtifactPins(join(directory, "artifact-pins.json"), candidate);
  const read = async (name: string) => JSON.parse(Buffer.from(await readDeploymentFile(join(directory, name))).toString());
  const reopened = await read("prepared-local-purpose-genesis.json");
  verifyPreparedLocalPurposeGenesis(prepared.configuration, candidate.revision, pins, reopened, localPurposeCompilerPorts);
  if (canonicalJson(await read("canonical-local-configuration.json")) !== canonicalJson(prepared.configuration)) { throw new Error("ASSEMBLY_RECONSTRUCTION_CONFIGURATION"); }
  const published = await read("deployment-manifest-v2.json") as ObservedAssemblyManifest;
  const evidence: LocalAssemblyObservation = { gasBufferBps: published.gasBufferBps, authority: published.authority, fundingBefore: published.funding.before, fundingAfter: published.funding.after,
    operations: published.gas, genesis: published.genesis, observedWei: published.observedWei,
    contracts: published.contracts.map(c => ({ id: c.observed.id, address: c.observed.address, runtime: c.observed.runtime, nonce: c.observed.nonce, getters: c.observed.getters, balance: c.observed.balance })) };
  const rebuilt = materializeObservedAssemblyManifest(reopened, evidence, { ...localPurposeCompilerPorts, authenticatedSafe: admission.authenticatedSafe });
  if (canonicalJson(rebuilt) !== canonicalJson(published) || canonicalJson(rebuilt) !== canonicalJson(manifest)) { throw new Error("ASSEMBLY_RECONSTRUCTION_MANIFEST"); }
}

function publicAssemblyFailure(cause: unknown): string {
  const code = cause instanceof LocalEvmError ? cause.code : cause instanceof Error ? cause.message : "";
  return /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : "ASSEMBLY_EXECUTION_OR_CLEANUP_FAILURE";
}
