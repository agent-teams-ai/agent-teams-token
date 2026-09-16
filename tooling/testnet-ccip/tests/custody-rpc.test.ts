import { syntheticSafeArtifacts } from "./fixtures/safe-artifacts.ts";
import type { QualifiedSafeProfile } from "../src/adapters/safe-artifacts.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { DeploymentBlock, Hex, PreparedDeployment } from "@agent-teams/supply/deployment";
import { deploymentCompilerPorts as ports } from "@agent-teams/supply/deployment-files";
import { createCustodyReader } from "../src/adapters/custody-rpc.ts";
import { custodySafeHash, custodySelector, custodyTopic, safeInspectionCalls } from "../src/adapters/safe-custody.ts";
import { canonicalCustodyIntent, type CustodyIntent, type CustodySafeCall } from "../src/domain/custody-intent.ts";
import { blockHash, hash, manifestFixture, safeCalldataFixture, stateFixture } from "./fixtures/custody.ts";

const word = (v: string | bigint): string => BigInt(v).toString(16).padStart(64, "0");
const quantity = (v: string): string => `0x${BigInt(v).toString(16)}`;
const nativeBlock = (b: DeploymentBlock, parentHash = hash) => ({ ...b, number: quantity(b.number), timestamp: quantity(b.timestamp), parentHash });
const fetchWith = (respond: (method: string, params: unknown[]) => unknown): typeof fetch => (async (_url, init) => {
  const request = JSON.parse(String(init?.body));
  const result = request.method === "eth_chainId" ? "0x7a69" : respond(request.method, request.params);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}) as typeof fetch;
const readerWith = (respond: (method: string, params: unknown[]) => unknown, profile?: QualifiedSafeProfile, initializationHash?: Hex) => createCustodyReader("http://127.0.0.1:8545", "local-test", "observe", fetchWith(respond), profile ? { profile, initializationHash } : undefined);

test("finality rejects conflicting hashes at the receipt height and reorgs across finality reads", async () => {
  const at: DeploymentBlock = { number: "7", hash, timestamp: "100" };
  await readerWith(() => nativeBlock(at)).canonical(at);
  await assert.rejects(readerWith((_method, params) => nativeBlock(params[0] === "finalized" ? { ...at, hash: blockHash } : at)).canonical(at), /FINALITY_CONFLICT/);
  for (const finalized of [{ ...at, number: "6" }, { ...at, timestamp: "99" }]) {
    await assert.rejects(readerWith((_method, params) => nativeBlock(params[0] === "finalized" ? finalized : at)).canonical(at), /FINALITY_REQUIRED/);
  }
  const later = { ...at, number: "8", hash: blockHash, timestamp: "101" };
  await readerWith((_method, params) => nativeBlock(params[0] === "0x7" ? at : later)).canonical(at);
  let reads = 0;
  await assert.rejects(readerWith((_method, params) => {
    if (params[0] === "finalized" || params[0] === "0x8") { return nativeBlock(later); }
    return nativeBlock(++reads === 1 ? at : { ...at, hash: blockHash });
  }).canonical(at), /REORG/);
  await assert.rejects(readerWith((_method, params) => nativeBlock(params[0] === "finalized" ? later : params[0] === "0x8" ? { ...later, hash } : at)).canonical(at), /REORG/);
});

function fixture() {
  // Selected synthetic RPC captures exercise authentication and policy, not live Safe/CCIP qualification.
  const manifest = manifestFixture(), safe = manifest.configuration.custodySafes[0]!;
  const states = manifest.grants.map(g => stateFixture(manifest, g.grantId, { funded: g.grantId === "founder-one" }));
  const founder = states[0]!, runtime = "0x6000" as Hex;
  const before = { number: "7", hash, timestamp: founder.start }, at = { number: "8", hash: blockHash, timestamp: (BigInt(founder.start) + 1n).toString() };
  const { profile } = syntheticSafeArtifacts();
  const prepared: PreparedDeployment = { schema: "agtmai-prepared-deployment-v1", broadcastAllowed: false, sourceRevision: manifest.sourceRevision, configuration: manifest.configuration,
    configurationSha256: manifest.configurationSha256, approval: null, artifacts: ["AGTMAICCIPToken", "GrantVault"].map(contract => ({ contract: contract as "AGTMAICCIPToken" | "GrantVault",
      compilerVersion: "0.8.36", artifactSha256: hash, buildInfoSha256: hash, compilerInputSha256: hash, creationBytecode: runtime, runtimeBytecode: runtime, immutableReferences: [] })),
    token: { constructorArgs: "0x", initcode: runtime, rawAllocationAbi: "0x", genesisAllocationHash: hash } };
  const call: CustodySafeCall = { address: safe.address, nonce: "0", transactionHash: hash, to: founder.address, value: "0", data: "0xea8a1af0", operation: "CALL", safeTxGas: "100000",
    baseGas: "0", gasPrice: "0", gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000" };
  const intent: CustodyIntent = { schema: "agtmai-custody-intent-v2", configurationSha256: manifest.configurationSha256, operationId: "founder-rejection", operation: "reject-founder-cancel", environment: "local-test", chainId: "31337",
    kind: "call", from: manifest.configuration.token.initialCCIPAdmin, to: safe.address, nonce: "9", value: "0", data: safeCalldataFixture(call), callerRole: "safe-executor", prerequisiteSha256: hash,
    gasLimit: "200000", maxFeePerGasWei: "2", maxPriorityFeePerGasWei: "0", deployment: null, safe: { ...call, transactionHash: custodySafeHash("31337", call) } };
  const receipt = { transactionHash: hash, blockHash, blockNumber: "0x8", status: "0x1", contractAddress: null, gasUsed: "0x10000", effectiveGasPrice: "0x1", logs: [
    { address: safe.address, topics: [custodyTopic("ExecutionFailure(bytes32,uint256)")], data: `${intent.safe!.transactionHash}${word(0n)}`, logIndex: "0x0", removed: false, transactionHash: hash, blockHash, blockNumber: "0x8" },
  ] };
  const transaction = { hash, chainId: "0x7a69", from: intent.from, to: intent.to, nonce: "0x9", value: "0x0", input: intent.data, blockHash, blockNumber: "0x8" };
  const initializationHash = `0x${"c".repeat(64)}` as Hex;
  const setup = `${custodySelector("setup(address[],uint256,address,bytes,address,address,uint256,address)")}${["256", "2", "0", "384", "0", "0", "0", "0", "3", ...safe.owners, "0"].map(word).join("")}` as Hex;
  const initializationTransaction = { ...transaction, hash: initializationHash, nonce: "0x8", input: setup, blockHash: before.hash, blockNumber: "0x7" };
  const initializationReceipt = { ...receipt, transactionHash: initializationHash, blockHash: before.hash, blockNumber: "0x7", logs: [{ address: safe.address,
    topics: [custodyTopic("SafeSetup(address,address[],uint256,address,address)"), `0x${word(intent.from)}`],
    data: `0x${["128", "2", "0", "0", "3", ...safe.owners].map(word).join("")}`, logIndex: "0x0", removed: false,
    transactionHash: initializationHash, blockHash: before.hash, blockNumber: "0x7" }] };
  const tokenCalls = ports.expectedTokenCalls(manifest.configuration, hash).calls;
  const balances = new Map([[founder.reserve, "300000"], [states[1]!.reserve, "600000"], [founder.address, "100000"]]);
  const respondCall = (params: unknown[]): unknown => {
    const { to, data } = params[0] as { to: Hex; data: Hex }, block = params[1] as { blockHash: Hex; requireCanonical: boolean };
    assert.equal(block.requireCanonical, true);
    if (to === safe.address) {
      const calls = { [safeInspectionCalls.version]: `0x${word(32n)}${word(5n)}${Buffer.from("1.4.1").toString("hex").padEnd(64, "0")}`,
        [safeInspectionCalls.owners]: `0x${word(32n)}${word(3n)}${safe.owners.map(word).join("")}`, [safeInspectionCalls.threshold]: `0x${word(2n)}`,
        [safeInspectionCalls.nonce]: `0x${word(block.blockHash === before.hash ? 0n : 1n)}`, [safeInspectionCalls.modules]: `0x${word(64n)}${word(1n)}${word(0n)}` };
      return calls[data];
    }
    if (to === manifest.token!.address) {
      if (data.startsWith("0x70a08231")) { return `0x${word(balances.get(`0x${data.slice(-40)}`) ?? "0")}`; }
      if (data.startsWith("0xdd62ed3e")) { return `0x${word(0n)}`; }
      return tokenCalls[data];
    }
    const grant = states.find(g => g.address === to)!;
    for (const [getter, value] of [["TOKEN", grant.token], ["BENEFICIARY", grant.beneficiary], ["ORIGINAL_RESERVE", grant.reserve], ["CONTROLLER", grant.controller]]) {
      if (data === custodySelector(`${getter}()`)) { return `0x${word(value!)}`; }
    }
    if (data === custodySelector("grant()")) { return `0x${[grant.allocation, grant.start, grant.cliff, grant.end, grant.kind === "founder" ? "0" : "1", grant.originalPurpose, "0", "0", "0", "1", "0"].map(word).join("")}`; }
    if (data === custodySelector("funded()")) { return `0x${word(grant.funded ? 1n : 0n)}`; }
    if (data === custodySelector("available()")) { return `0x${word(0n)}`; }
    throw new Error(`Unexpected call ${to} ${data}`);
  };
  const respond = (method: string, params: unknown[]): unknown => {
    if (method === "eth_getBlockByNumber") { return nativeBlock(params[0] === "0x7" ? before : at); }
    if (method === "eth_getBlockByHash") { return nativeBlock(before); }
    if (method === "eth_getTransactionByHash") { return params[0] === initializationHash ? initializationTransaction : transaction; }
    if (method === "eth_getTransactionReceipt") { return params[0] === initializationHash ? initializationReceipt : receipt; }
    if (method === "eth_getCode") { return safe.owners.includes(params[0] as `0x${string}`) ? "0x" : runtime; }
    if (method === "eth_getStorageAt") { return `0x${word(params[1] === `0x${word(0n)}` ? profile.singleton : "0")}`; }
    if (method !== "eth_call") { throw new Error(`Unexpected method ${method}`); }
    return respondCall(params);
  };
  const prove = (selected = intent, handler = respond, selectedProfile: QualifiedSafeProfile | undefined = profile) => readerWith(handler, selectedProfile, initializationHash).transition(manifest, prepared, selected, founder.grantId, hash);
  return { intent, receipt, transaction, respond, prove, profile, manifest, prepared, founder, before, at, initializationHash, initializationTransaction, initializationReceipt };
}

test("Safe outer calldata must decode to the exact intended vault CALL before accepting an intent", () => {
  const { intent } = fixture();
  canonicalCustodyIntent(intent);
  const replaceWord = (index: number, value: string): Hex => `${intent.data.slice(0, 10 + index * 64)}${word(value)}${intent.data.slice(10 + (index + 1) * 64)}` as Hex;
  for (const data of ["0x12345678", `0x00000000${intent.data.slice(10)}`, ...[
    [0, "1"], [1, "1"], [2, "384"], [3, "1"], [4, "100001"], [5, "1"], [6, "1"], [7, "1"], [8, "1"], [9, "320"], [10, "5"], [11, "0"], [12, "65"],
  ].map(([i, value]) => replaceWord(Number(i), String(value))), intent.data.slice(0, -2), `${intent.data}00`]) {
    assert.throws(() => canonicalCustodyIntent({ ...intent, data: data as Hex }), /CUSTODY_INTENT_INVALID/);
  }
});

test("reader authenticates Safe runtime, nonce, recomputed hash and actual calldata before founder rejection", async () => {
  const f = fixture();
  assert.equal((await f.prove()).safeResult, "failure");
  await assert.rejects(readerWith(f.respond).transition(f.manifest, f.prepared, f.intent, f.founder.grantId, hash), /SAFE_PROFILE_REQUIRED/);
  await assert.rejects(f.prove({ ...f.intent, safe: { ...f.intent.safe!, transactionHash: hash } }), /SAFE_HASH_MISMATCH/);
  await assert.rejects(f.prove({ ...f.intent, data: "0x12345678" }), /CUSTODY_INTENT_INVALID/);
  await assert.rejects(f.prove(f.intent, (m, p) => m === "eth_getTransactionByHash" ? { ...f.transaction, input: "0x12345678" } : f.respond(m, p)), /INTENT_MISMATCH/);
  await assert.rejects(f.prove(f.intent, (m, p) => m === "eth_getCode" && p[0] === f.intent.to ? "0x6001" : f.respond(m, p)), /CODE_IDENTITY/);
  await assert.rejects(f.prove(f.intent, (m, p) => m === "eth_getCode" && p[0] === f.profile.singleton
    && (p[1] as { blockHash: string }).blockHash === blockHash ? "0x6001" : f.respond(m, p)), /CODE_IDENTITY/);
  await assert.rejects(f.prove(f.intent, f.respond, { ...f.profile, sourceRevision: "unqualified" }), /PROFILE_UNQUALIFIED/);
  await assert.rejects(f.prove(f.intent, (m, p) => m === "eth_call" && (p[0] as { data: string }).data === safeInspectionCalls.nonce && (p[1] as { blockHash: Hex }).blockHash === blockHash ? `0x${word(9n)}` : f.respond(m, p)), /SAFE_NONCE/);
  await assert.rejects(f.prove(f.intent, (m, p) => m === "eth_getTransactionReceipt" && p[0] === hash ? { ...f.receipt, logs: [{ ...f.receipt.logs[0], data: `${hash}${word(0n)}` }] } : f.respond(m, p)), /INNER_RESULT_UNPROVEN/);
  const unrelated = { ...f.intent.safe!, to: f.manifest.grants[1]!.address };
  const unrelatedIntent = { ...f.intent, data: safeCalldataFixture(unrelated), safe: { ...unrelated, transactionHash: custodySafeHash("31337", unrelated) } };
  await assert.rejects(f.prove(unrelatedIntent, (m, p) => m === "eth_getTransactionByHash" ? { ...f.transaction, input: unrelatedIntent.data } : f.respond(m, p)), /SAFE_BINDING/);
});

test("effects are rejected when receipt ancestry or finality changes during capture", async () => {
  const f = fixture();
  await assert.rejects(f.prove(f.intent, (m, p) => m === "eth_getBlockByHash" ? nativeBlock({ ...f.before, hash: blockHash }) : f.respond(m, p)), /PARENT_BINDING/);
  let receipts = 0;
  await assert.rejects(f.prove(f.intent, (m, p) => {
    if (m === "eth_getTransactionReceipt" && p[0] === hash) { receipts++; }
    if (receipts > 1 && m === "eth_getBlockByNumber" && p[0] === "finalized") { return nativeBlock({ ...f.at, hash }); }
    return f.respond(m, p);
  }), /FINALITY_CONFLICT/);
  let transactions = 0;
  await assert.rejects(f.prove(f.intent, (m, p) => {
    if (m === "eth_getTransactionByHash" && p[0] === hash && ++transactions > 1) { return { ...f.transaction, input: "0x12345678" }; }
    return f.respond(m, p);
  }), /TRANSACTION_CHANGED/);
});


test("reader checks each configured owner code at both canonical blocks and rejects captured profile authority", async () => {
  const f = fixture(), owners = f.manifest.configuration.custodySafes[0]!.owners;
  const observed: string[] = [];
  await f.prove(f.intent, (method, params) => {
    if (method === "eth_getCode" && owners.includes(params[0] as Hex)) {
      const at = params[1] as { blockHash: Hex; requireCanonical: boolean };
      assert.equal(at.requireCanonical, true);
      assert.ok([f.before.hash, f.at.hash].includes(at.blockHash));
      observed.push(`${params[0]}:${at.blockHash}`);
    }
    return f.respond(method, params);
  });
  assert.equal(new Set(observed).size, 6);
  await assert.rejects(f.prove(f.intent, (method, params) => method === "eth_getCode" && params[0] === owners[0]
    ? "0xef01000000000000000000000000000000000000000002" : f.respond(method, params)), /CUSTODY_SAFE_UNSUPPORTED_OWNER/);
  await assert.rejects(f.prove(f.intent, f.respond, JSON.parse(JSON.stringify(f.profile))), /CUSTODY_SAFE_PROFILE_UNQUALIFIED/);
});


test("Safe initialization requires finalized direct setup with no delegatecall or reimbursement", async () => {
  const f = fixture();
  await assert.rejects(readerWith(f.respond, f.profile).transition(f.manifest, f.prepared, f.intent, f.founder.grantId, hash), /SAFE_INITIALIZATION_REQUIRED/);
  for (const index of [1, 2, 4, 5, 6, 7, 12]) {
    const data = f.initializationTransaction.input;
    const input = `${data.slice(0, 10 + index * 64)}${word(1n)}${data.slice(10 + (index + 1) * 64)}`;
    await assert.rejects(f.prove(f.intent, (method, params) => method === "eth_getTransactionByHash" && params[0] === f.initializationHash
      ? { ...f.initializationTransaction, input } : f.respond(method, params)), /CUSTODY_SAFE_INITIALIZATION/);
  }
  await assert.rejects(f.prove(f.intent, (method, params) => method === "eth_getTransactionReceipt" && params[0] === f.initializationHash
    ? { ...f.initializationReceipt, logs: [] } : f.respond(method, params)), /CUSTODY_SAFE_INITIALIZATION/);
});
