import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadPreparedProductionPackage } from "@agent-teams/supply/deployment-files";
import { canonicalJson, keccak256 } from "../../tooling/deployment-plan/src/domain/identity.ts";
import type { ProductionStateObservation } from "../../tooling/deployment-plan/src/domain/production-guards.ts";
import { finishWithCleanup } from "../../tooling/local-evm/cleanup.ts";
import { LocalEvmError } from "../../tooling/local-evm/model.ts";
import { checkedCommand, startOwnedAnvil, type OwnedAnvil } from "../../tooling/local-evm/process.ts";
import { createRunLease, reclaimStaleRuns, registerRunAnvil, removeOwnedRunDirectory } from "../../tooling/local-evm/run-lease.ts";
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
    env: { ...process.env, HOME: directory, CAST_PASSWORD: password },
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
    anvil = await startOwnedAnvil(foundry.anvil, signerAddress, async identity => await registerRunAnvil(runDirectory, identity), {
      chainId: "1", timestamp: (start > 8n ? start - 8n : 0n).toString(),
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
      const transactionHash = await sendSignedOperation({ cast: foundry.cast, signer, environment: castEnvironment, rpcUrl: anvil.rpcUrl, operation, expected, input });
      const receipt = await waitForReceipt(rpc, transactionHash);
      if (receipt.status !== "0x1") {throw new Error(`PROOF_RECEIPT_${operation.id}`);}
      const transactionFacts = assertTransaction(await transactionByHash(rpc, transactionHash), receipt, operation.kind, expectations.sender, operation.nonce, input, expected, operation.to);
      observedTotalCost += BigInt(transactionFacts.observedCostWei);
      const block = await blockByNumber(rpc, receipt.blockNumber); finalBlock = block;
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
    const now = options.now?.() ?? BigInt(Math.floor(Date.now() / 1000));
    const observation = { schema: "agtmai-production-observation-v2", chainId: "1", sender: expectations.sender, pendingNonce, blockNumber: finalBlock.number, blockHash: finalBlock.hash, observedAt: now.toString(), expiresAt: (now + BigInt(expectations.maxObservationAgeSeconds)).toString(), observedTotalCostWei: observedTotalCost.toString(), rpcEndpoint: anvil.rpcUrl, netVersion: "1", binding: { sourceRevision: expectations.sourceRevision, configurationSha256: prepared.configurationSha256, reserveConfigurationSha256: prepared.reserveConfigurationSha256, artifactPinsSha256: expectations.artifactPinsSha256 }, operations, checkedAddresses: [...new Set([...prepared.operations.flatMap(operation => operation.expectedAddress ? [operation.expectedAddress] : []), ...prepared.operations.flatMap(operation => operation.nestedAddress ? [operation.nestedAddress] : []), ...state.allocations.map(allocation => allocation.recipient)])].toSorted(), occupiedAddresses: [], authority: expectations.authority, state, cleanup: { processExited: false, exitCode: "0", descriptorsClosed: false, temporaryRootRemoved: false, diagnostic: null } };
    await anvil.stop(); anvil = undefined;
    await removeOwnedRunDirectory(runDirectory);
    const complete = { ...observation, cleanup: { processExited: true, exitCode: "0", descriptorsClosed: true, temporaryRootRemoved: true, diagnostic: null } };
    await publishObservation(options.outputDirectory, complete);
    return { status: "observed", observationPath: join(resolve(options.outputDirectory), "production-observation-v2.json"), operationCount: 4, signerAddress };
  } catch (cause) {primary = cause; throw cause;}
  finally {await finishWithCleanup(primary, [async () => await anvil?.stop(), async () => await removeOwnedRunDirectory(runDirectory)]);}
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
function assertTransaction(transaction: Record<string, string | null>, receipt: Record<string, string>, kind: "create" | "call", sender: string, nonce: string, input: string, expected: Prepared["expectations"]["operations"][number], to?: string): { readonly gasLimit: string; readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string; readonly gasUsed: string; readonly effectiveGasPrice: string; readonly observedCostWei: string } {
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
