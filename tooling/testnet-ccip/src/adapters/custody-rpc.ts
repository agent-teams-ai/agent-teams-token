import { deploymentBytes, isDigest, isEvmAddress, verifyDeploymentRuntime, type Hex, type DeploymentBlock,
  type PreparedDeployment, type DeploymentManifest, type ContractDeploymentEvidence } from "@agent-teams/supply/deployment";
import { deploymentCompilerPorts } from "@agent-teams/supply/deployment-files";
import { verifyCustodySnapshot, verifyCustodyTransition, type CustodyGrantState, type CustodySnapshot, type CustodyTransition, type CustodyMovement } from "../domain/custody.ts";
import { canonicalCustodyIntent, type CustodyIntent } from "../domain/custody-intent.ts";
import { custodySelector, custodyTopic, custodySafeResult, safeInspectionCalls, verifyCustodySafe, type SafeProfile, type SafeInspection } from "./safe-custody.ts";

const fail = (code: string): never => { throw new Error(`CUSTODY_RPC_${code}`); };
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail("SHAPE");
const hex = (v: unknown): Hex => typeof v === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(v) ? v.toLowerCase() as Hex : fail("HEX");
const digest = (v: unknown): Hex => { const h = hex(v); return isDigest(h) ? h : fail("HASH"); };
const address = (v: unknown): Hex => { const h = hex(v); return isEvmAddress(h) ? h : fail("ADDRESS"); };
const quantity = (v: unknown): string => typeof v === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(v) ? BigInt(v).toString() : fail("QUANTITY");
const rpcNumber = (value: string): string => `0x${BigInt(value).toString(16)}`;
const word = (v: bigint): string => v.toString(16).padStart(64, "0");
const addr = (v: string): string => v.slice(2).padStart(64, "0");
const same = (a: unknown, b: unknown): boolean => new TextDecoder().decode(deploymentBytes(a)) === new TextDecoder().decode(deploymentBytes(b));
const block = (v: unknown): DeploymentBlock => { const b = object(v); return { hash: digest(b.hash), number: quantity(b.number), timestamp: quantity(b.timestamp) }; };
type Read = (method: string, params: readonly unknown[]) => Promise<unknown>;
const readOnlyJsonRpc = (endpoint: string, mode: "offline" | "observe", fetcher: typeof fetch): Read => {
  const url = new URL(endpoint);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.hash) { return async () => fail("ENDPOINT"); }
  const methods = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getCode", "eth_call", "eth_getLogs", "eth_getBalance", "eth_getStorageAt", "eth_getTransactionCount", "eth_estimateGas", "eth_feeHistory", "eth_maxPriorityFeePerGas", "eth_gasPrice"]);
  let id = 0;
  return async (method, params) => {
    if (mode !== "observe" || !methods.has(method) || !Array.isArray(params)) { return fail("READ_ONLY"); }
    try {
      const response = await fetcher(url.href, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error", body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      if (!response.ok) { return fail("UNAVAILABLE"); }
      const envelope = await response.json() as Record<string, unknown>;
      if (envelope.jsonrpc !== "2.0" || envelope.id !== id || envelope.error !== undefined || !("result" in envelope)) { return fail("RESPONSE"); }
      return envelope.result;
    } catch { return fail("UNAVAILABLE"); }
  };
};
export interface CustodyNativeLog { readonly address: Hex; readonly topics: readonly Hex[]; readonly data: Hex; readonly logIndex: string; readonly removed: false }
interface NativeReceipt {
  readonly transactionHash: Hex; readonly blockHash: Hex; readonly blockNumber: string;
  readonly status: 0 | 1; readonly contractAddress: Hex | null; readonly gasUsed: string; readonly effectiveGasPrice: string;
  readonly logs: readonly CustodyNativeLog[];
}
function parseReceipt(value: unknown): NativeReceipt {
  const r = object(value), status = quantity(r.status);
  if (!["0", "1"].includes(status) || !Array.isArray(r.logs) || r.logs.length > 256) { return fail("RECEIPT"); }
  const transactionHash = digest(r.transactionHash), blockHash = digest(r.blockHash), blockNumber = quantity(r.blockNumber);
  const logs = r.logs.map((item: unknown): CustodyNativeLog => {
    const log = object(item);
    if (!Array.isArray(log.topics) || log.topics.length > 4 || log.removed !== false || digest(log.transactionHash) !== transactionHash
      || digest(log.blockHash) !== blockHash || quantity(log.blockNumber) !== blockNumber) { return fail("LOG_BINDING"); }
    return { address: address(log.address), topics: log.topics.map(digest), data: hex(log.data), logIndex: quantity(log.logIndex), removed: false };
  });
  if (new Set(logs.map(l => l.logIndex)).size !== logs.length) { fail("DUPLICATE_LOG"); }
  return { transactionHash, blockHash, blockNumber, status: status === "1" ? 1 : 0, contractAddress: r.contractAddress === null ? null : address(r.contractAddress),
    gasUsed: quantity(r.gasUsed), effectiveGasPrice: quantity(r.effectiveGasPrice), logs };
}
function decodeWords(value: Hex, count: number): string[] {
  if (value.length !== 2 + count * 64) { return fail("ABI_LENGTH"); }
  return value.slice(2).match(/.{64}/g)!;
}
const boolWord = (v: string): boolean => v === word(0n) ? false : v === word(1n) ? true : fail("BOOLEAN");

/** Separate read-only custody client; chain verification runs before every RPC request and after each capture. */
export function createCustodyReader(endpoint: string, environment: "local-test" | "owned-testnet", mode: "offline" | "observe" = "observe", fetcher: typeof fetch = globalThis.fetch) {
  if (!["local-test", "owned-testnet"].includes(environment)) { return fail("MAINNET_FORBIDDEN"); }
  const url = new URL(endpoint);
  if (environment === "local-test" && (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname))) { return fail("LOCAL_ENDPOINT"); }
  const chainId = environment === "local-test" ? "31337" : "11155111";
  const transport = readOnlyJsonRpc(endpoint, mode, fetcher);
  const check = async (): Promise<void> => { if (quantity(await transport("eth_chainId", [])) !== chainId) { fail("WRONG_CHAIN"); } };
  const read: Read = async (method, params) => { await check(); return transport(method, params); };
  const call = async (to: Hex, data: Hex, at: DeploymentBlock): Promise<Hex> => hex(await read("eth_call", [{ to, data }, { blockHash: at.hash, requireCanonical: true }]));
  const code = async (to: Hex, at: DeploymentBlock): Promise<Hex> => hex(await read("eth_getCode", [to, { blockHash: at.hash, requireCanonical: true }]));
  async function canonical(at: DeploymentBlock): Promise<void> {
    if (!same(block(await read("eth_getBlockByNumber", [rpcNumber(at.number), false])), at)) { fail("REORG"); }
    const finalized = block(await read("eth_getBlockByNumber", ["finalized", false]));
    if (BigInt(finalized.number) < BigInt(at.number) || BigInt(finalized.timestamp) < BigInt(at.timestamp)) { fail("FINALITY_REQUIRED"); }
    await check();
  }
  async function snapshot(manifest: DeploymentManifest, prepared: PreparedDeployment, selected?: DeploymentBlock): Promise<CustodySnapshot> {
    if (!manifest.token || manifest.configurationSha256 !== prepared.configurationSha256 || manifest.configuration.environment.evmChainId !== chainId) { return fail("MANIFEST_BINDING"); }
    const at = selected ?? block(await read("eth_getBlockByNumber", ["finalized", false])), token = manifest.token.address;
    await canonical(at);
    verifyDeploymentRuntime(await code(token, at), prepared.artifacts.find(a => a.contract === "AGTMAICCIPToken")!);
    for (const [data, expected] of Object.entries(deploymentCompilerPorts.expectedTokenCalls(manifest.configuration, manifest.token.genesisAllocationHash).calls)) {
      if (await call(token, data as Hex, at) !== expected) { fail("TOKEN_IDENTITY"); }
    }
    const addresses = [...new Set([...manifest.configuration.allocations.map(a => a.recipient as Hex), ...manifest.configuration.grants.map(g => g.beneficiary), ...manifest.grants.map(g => g.address)])].toSorted();
    const balances = [];
    for (const account of addresses) { balances.push({ address: account, amount: BigInt(`0x${decodeWords(await call(token, `0x70a08231${addr(account)}`, at), 1)[0]}`).toString() }); }
    const grants: CustodyGrantState[] = [];
    for (const deployed of manifest.grants) {
      verifyDeploymentRuntime(await code(deployed.address, at), prepared.artifacts.find(a => a.contract === "GrantVault")!);
      grants.push(await captureGrant(manifest, deployed, at, call));
    }
    const result: CustodySnapshot = { schema: "agtmai-custody-snapshot-v1", chainId, block: at, token,
      totalSupply: BigInt(await call(token, "0x18160ddd", at)).toString(), initialSupply: manifest.configuration.token.initialSupplyBaseUnits, balances, grants };
    await canonical(at); verifyCustodySnapshot(manifest, result); return result;
  }
  async function receipt(hash: Hex): Promise<NativeReceipt> {
    const r = parseReceipt(await read("eth_getTransactionReceipt", [hash]));
    if (r.transactionHash !== hash) { fail("RECEIPT_IDENTITY"); }
    return r;
  }
  async function finalizedTransaction(hash: Hex) {
    const r = await receipt(hash), tx = object(await read("eth_getTransactionByHash", [hash]));
    const at = block(await read("eth_getBlockByNumber", [rpcNumber(r.blockNumber), false]));
    if (digest(tx.hash) !== hash || quantity(tx.chainId) !== chainId || digest(tx.blockHash) !== r.blockHash || quantity(tx.blockNumber) !== r.blockNumber || at.hash !== r.blockHash) { fail("TRANSACTION_BINDING"); }
    await canonical(at);
    return { receipt: r, at, transaction: { hash, chainId, from: address(tx.from), to: tx.to === null ? null : address(tx.to), nonce: quantity(tx.nonce), value: quantity(tx.value), input: hex(tx.input) } };
  }
  async function creation(prepared: PreparedDeployment, hash: Hex, grantId: string | null, token: Hex | null): Promise<ContractDeploymentEvidence> {
    const tx = await finalizedTransaction(hash), r = tx.receipt, at = tx.at;
    if (r.status !== 1 || !r.contractAddress || tx.transaction.to !== null || tx.transaction.value !== "0") { return fail("CREATION"); }
    const state = grantId === null ? deploymentCompilerPorts.expectedTokenCalls(prepared.configuration, prepared.token.genesisAllocationHash)
      : deploymentCompilerPorts.expectedGrantCalls(prepared.configuration, prepared.configuration.grants.find(g => g.id === grantId) ?? fail("GRANT_REFERENCE"), token ?? fail("TOKEN_REQUIRED"));
    const calls = [];
    for (const data of Object.keys(state.calls)) { calls.push({ to: r.contractAddress, data: data as Hex, result: await call(r.contractAddress, data as Hex, at), blockHash: at.hash, blockNumber: at.number }); }
    const runtime = { code: await code(r.contractAddress, at), blockHash: at.hash, blockNumber: at.number };
    await canonical(at);
    if (!same(r, await receipt(hash))) { fail("RECEIPT_CHANGED"); }
    return { address: r.contractAddress, transaction: { ...tx.transaction, to: null, value: "0" }, receipt: { ...r, status: 1, contractAddress: r.contractAddress },
      blockBefore: at, blockAfter: block(await read("eth_getBlockByNumber", [rpcNumber(at.number), false])), finalizedBlock: block(await read("eth_getBlockByNumber", ["finalized", false])), runtime, calls };
  }
  async function safe(expected: PreparedDeployment["configuration"]["custodySafes"][number], profile: SafeProfile, at: DeploymentBlock): Promise<SafeInspection> {
    const storage = async (slot: Hex) => hex(await read("eth_getStorageAt", [expected.address, slot, { blockHash: at.hash, requireCanonical: true }]));
    const observed: SafeInspection = { address: expected.address, blockHash: at.hash, proxyCode: await code(expected.address, at), singletonCode: await code(profile.singleton, at),
      singletonStorage: await storage(`0x${word(0n)}`), versionResult: await call(expected.address, safeInspectionCalls.version, at), ownersResult: await call(expected.address, safeInspectionCalls.owners, at),
      thresholdResult: await call(expected.address, safeInspectionCalls.threshold, at), nonceResult: await call(expected.address, safeInspectionCalls.nonce, at), modulesResult: await call(expected.address, safeInspectionCalls.modules, at),
      guardStorage: await storage(safeInspectionCalls.guardSlot), fallbackStorage: await storage(safeInspectionCalls.fallbackSlot) };
    await canonical(at); verifyCustodySafe(expected, profile, observed); return observed;
  }
  async function transition(manifest: DeploymentManifest, prepared: PreparedDeployment, intent: CustodyIntent, grantId: string, hash: Hex): Promise<CustodyTransition> {
    canonicalCustodyIntent(intent);
    const tx = await finalizedTransaction(hash), r = tx.receipt;
    if (intent.kind !== "call" || ["deploy-token", "deploy-grant"].includes(intent.operation) || !same(tx.transaction, { hash, chainId: intent.chainId, from: intent.from, to: intent.to, nonce: intent.nonce, value: intent.value, input: intent.data })) { return fail("INTENT_MISMATCH"); }
    const parent = block(await read("eth_getBlockByNumber", [rpcNumber((BigInt(tx.at.number) - 1n).toString()), false]));
    const before = await snapshot(manifest, prepared, parent), after = await snapshot(manifest, prepared, tx.at);
    const movements = receiptMovements(manifest.token!.address, r.logs);
    const result: CustodyTransition = { operationId: intent.operationId, operation: intent.operation as CustodyTransition["operation"], intent, transactionHash: hash, grantId, block: tx.at,
      before, after, movements, receiptStatus: r.status, safeResult: intent.safe ? custodySafeResult(intent.safe, r.logs) : null, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice };
    verifyCustodyTransition(manifest, result); verifyVaultEvent(result, r.logs);
    await canonical(tx.at); if (!same(r, await receipt(hash))) { fail("RECEIPT_CHANGED"); }
    return result;
  }
  return { read, call, canonical, snapshot, receipt, finalizedTransaction, creation, safe, transition,
    finalizedBlock: async () => block(await read("eth_getBlockByNumber", ["finalized", false])) };
}

async function captureGrant(manifest: DeploymentManifest, deployed: DeploymentManifest["grants"][number], at: DeploymentBlock,
  call: (to: Hex, data: Hex, at: DeploymentBlock) => Promise<Hex>): Promise<CustodyGrantState> {
  const g = manifest.configuration.grants.find(candidate => candidate.id === deployed.grantId)!;
  const getters: Hex[] = [];
  for (const name of ["TOKEN", "BENEFICIARY", "ORIGINAL_RESERVE", "CONTROLLER"]) { const raw = decodeWords(await call(deployed.address, custodySelector(`${name}()`), at), 1)[0]!;
    if (!/^0{24}[0-9a-f]{40}$/.test(raw)) { fail("ADDRESS_ABI"); }
    getters.push(address(`0x${raw.slice(24)}`)); }
  const [token, beneficiary, reserve, controller] = getters;
  const words = decodeWords(await call(deployed.address, custodySelector("grant()"), at), 11);
  const u = (i: number): string => BigInt(`0x${words[i]}`).toString();
  if (!["0", "1"].includes(u(4))) { return fail("GRANT_KIND"); }
  return { grantId: g.id, address: deployed.address, token: token!, beneficiary: beneficiary!, reserve: reserve!, controller: controller!,
    allocation: u(0), start: u(1), cliff: u(2), end: u(3), kind: u(4) === "0" ? "founder" : "team", originalPurpose: `0x${words[5]}`,
    released: u(6), frozenEntitlement: u(7), lastTransition: u(8), initialized: boolWord(words[9]!), cancelled: boolWord(words[10]!),
    funded: boolWord(decodeWords(await call(deployed.address, custodySelector("funded()"), at), 1)[0]!),
    available: BigInt(await call(deployed.address, custodySelector("available()"), at)).toString(),
    allowance: BigInt(await call(token!, `0xdd62ed3e${addr(reserve!)}${addr(deployed.address)}`, at)).toString(), donations: "0" };
}
function receiptMovements(token: Hex, logs: readonly CustodyNativeLog[]): CustodyMovement[] {
  return logs.filter(l => l.address === token && l.topics[0] === custodyTopic("Transfer(address,address,uint256)")).map(l => {
    if (l.topics.length !== 3 || l.topics.slice(1).some(t => !/^0x0{24}[0-9a-f]{40}$/.test(t))) { return fail("TRANSFER_EVENT"); }
    return { from: address(`0x${l.topics[1]!.slice(26)}`), to: address(`0x${l.topics[2]!.slice(26)}`), amount: BigInt(`0x${decodeWords(l.data, 1)[0]}`).toString() };
  });
}
function verifyVaultEvent(t: CustodyTransition, logs: readonly CustodyNativeLog[]): void {
  const before = t.before.grants.find(g => g.grantId === t.grantId)!, after = t.after.grants.find(g => g.grantId === t.grantId)!;
  const n = (s: string): string => word(BigInt(s)), at = n(t.block.timestamp);
  if (t.operation === "approve") {
    const expected = { address: before.token, topics: [custodyTopic("Approval(address,address,uint256)"), `0x${addr(before.reserve)}`, `0x${addr(before.address)}`], data: `0x${n(before.allocation)}` };
    const approvals = logs.filter(l => l.address === before.token && l.topics[0] === expected.topics[0]);
    if (approvals.length !== 1 || !same({ address: approvals[0]!.address, topics: approvals[0]!.topics, data: approvals[0]!.data }, expected)) { fail("APPROVAL_EVENT"); }
    return;
  }
  const events = logs.filter(l => l.address === before.address);
  if (t.operation === "reject-founder-cancel") { if (events.length) { fail("FOUNDER_EVENT"); } return; }
  const expected = t.operation === "fund" ? { topics: [custodyTopic("GrantFunded(uint256,uint64)")], data: `0x${n(before.allocation)}${at}` }
    : t.operation === "cancel-team" ? { topics: [custodyTopic("TeamGrantCancelled(bytes32,uint256,uint256,uint64)"), before.originalPurpose], data: `0x${n(after.frozenEntitlement)}${word(BigInt(before.allocation) - BigInt(after.frozenEntitlement))}${at}` }
    : { topics: [custodyTopic("TokensReleased(uint256,uint256,uint64)")], data: `0x${word(BigInt(after.released) - BigInt(before.released))}${n(after.released)}${at}` };
  if (events.length !== 1 || !same({ topics: events[0]!.topics, data: events[0]!.data }, expected)) { fail("VAULT_EVENT"); }
}
