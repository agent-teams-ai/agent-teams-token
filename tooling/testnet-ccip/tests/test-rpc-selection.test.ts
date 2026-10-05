import assert from "node:assert/strict";
import test from "node:test";
import { selectSepoliaRpc, selectSolanaRpc, DEFAULT_SEPOLIA_RPC, PUBLIC_SEPOLIA_RPC, DEFAULT_SOLANA_RPC,
  createTestRpcRequest, createSdkTestFetch, TEST_RPC_RESPONSE_LIMIT } from "../src/adapters/test-rpc.ts";
import { createSepoliaRpc } from "../src/adapters/evm-rpc.ts";
import { readRemoteConfigSnapshot } from "../src/adapters/evm-remote-config-rpc.ts";
import { executeSepoliaIntent } from "../src/composition/execute-sepolia.ts";
import type { SepoliaExecutionIo } from "../src/composition/execute-sepolia.ts";
import { transferEvmForward } from "../src/composition/transfer-evm-forward.mjs";
import { runStatus } from "../src/composition/transfer-status.mjs";
import { createNativeStatus } from "../src/adapters/transfer-status-native.mjs";
import { FORWARD, forwardIntent } from "../src/domain/evm-forward.mjs";
import { SOLANA_REMOTE } from "../src/domain/evm-remote-config.ts";
import type { EvmJournalRecord } from "../src/application/evm-journal.ts";
import type { CastSignerConfig } from "../src/adapters/evm-cast.ts";

type Request = { jsonrpc: string; id: number; method: string; params: unknown[] };
const hash = "0x" + "ab".repeat(32), blockHash = "0x" + "cd".repeat(32);
const word = (value: string) => value.replace(/^0x/, "").padStart(64, "0");
const nword = (value: string | bigint) => BigInt(value).toString(16).padStart(64, "0");
const zero = "0x" + "00".repeat(20);
const target = { testOnly: true as const, administrator: FORWARD.administrator, token: FORWARD.token, pool: FORWARD.pool };
function remoteAnswer(call: Request): unknown {
  if (call.method === "eth_chainId") { return "0xaa36a7"; }
  if (call.method === "eth_getBlockByNumber") { return { hash: blockHash, number: "0x64" }; }
  if (call.method === "eth_getCode") { return "0x01"; }
  if (call.method === "eth_call") {
    const data = (call.params[0] as { data: string }).data.slice(0, 10);
    const rate = "0x" + [SOLANA_REMOTE.capacity, "1", "1", SOLANA_REMOTE.capacity, SOLANA_REMOTE.rate].map(nword).join("");
    const answers: Record<string, string> = {
      "0xcb67e3b1": "0x" + [target.administrator, zero, target.pool].map(word).join(""),
      "0x8fd6a6ac": "0x" + word(target.administrator), "0x21df0da7": "0x" + word(target.token),
      "0x8da5cb5b": "0x" + word(target.administrator), "0x8926f54f": "0x" + nword(1n),
      "0xa42a7b8b": "0x" + [32n, 1n, 32n, 32n].map(nword).join("") + SOLANA_REMOTE.pool.slice(2),
      "0xb7946580": "0x" + [32n, 32n].map(nword).join("") + SOLANA_REMOTE.token.slice(2),
      "0xaf58d59f": rate, "0xc75eea9c": rate,
    };
    assert.ok(data in answers, data); return answers[data];
  }
  assert.fail("Unexpected readiness request " + call.method);
}
function transport(answer: (call: Request) => unknown = remoteAnswer) {
  const calls: { endpoint: string; call: Request; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const call = JSON.parse(init!.body as string) as Request;
    calls.push({ endpoint: String(input), call, init: init! });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: answer(call) }));
  };
  return { fetcher, calls };
}
test("TEST RPC selection keeps defaults and rejects credential, redirect and non-test URL forms before IO", async () => {
  assert.equal(selectSepoliaRpc({}), DEFAULT_SEPOLIA_RPC); assert.equal(selectSolanaRpc({}), DEFAULT_SOLANA_RPC);
  assert.equal(selectSepoliaRpc({ sepoliaRpc: PUBLIC_SEPOLIA_RPC }), PUBLIC_SEPOLIA_RPC);
  for (const endpoint of ["", "http://sepolia.gateway.tenderly.co", "https://user:pass@sepolia.gateway.tenderly.co",
    PUBLIC_SEPOLIA_RPC + "/token", PUBLIC_SEPOLIA_RPC + "?key=synthetic", PUBLIC_SEPOLIA_RPC + "#fragment",
    PUBLIC_SEPOLIA_RPC + ":443", "https://mainnet.gateway.tenderly.co", "https://127.0.0.1", null]) {
    assert.throws(() => selectSepoliaRpc({ sepoliaRpc: endpoint } as never));
    await assert.rejects(readRemoteConfigSnapshot({ ...target, sepoliaRpc: endpoint } as never,
      async () => assert.fail("Invalid selection must precede fetch")));
    await assert.rejects(transferEvmForward({ sepoliaRpc: endpoint }, { exclusive: () => assert.fail("Invalid selection must precede journal"),
      sdk: async () => assert.fail("Invalid selection must precede SDK"), snapshot: async () => assert.fail("Invalid selection must precede snapshot"),
      execute: async () => assert.fail("Invalid selection must precede execution"), read: async () => assert.fail("Invalid selection must precede read") }));
    await assert.rejects(runStatus({ sepoliaRpc: endpoint, testOnly: true, sdkDirectory: "/unavailable" }), /TEST RPC/);
  }
  for (const endpoint of ["http://api.devnet.solana.com", "https://api.mainnet-beta.solana.com", DEFAULT_SOLANA_RPC + "?key=synthetic"]) {
    assert.throws(() => selectSolanaRpc({ solanaRpc: endpoint }));
  }
});

test("readiness snapshot uses one selected endpoint for registry, EIP-1898 peers, rates and chain rechecks", async () => {
  for (const endpoint of [DEFAULT_SEPOLIA_RPC, PUBLIC_SEPOLIA_RPC]) {
    const f = transport();
    const snapshot = await readRemoteConfigSnapshot({ ...target, sepoliaRpc: endpoint }, f.fetcher);
    assert.equal(snapshot.registration.chainId, "11155111"); assert.deepEqual(snapshot.pools, [SOLANA_REMOTE.pool]);
    assert.ok(f.calls.length > 12); assert.ok(f.calls.every(c => c.endpoint === new URL(endpoint).href));
    assert.ok(f.calls.filter(c => c.call.method === "eth_call").every(c =>
      JSON.stringify(c.call.params[1]) === JSON.stringify({ blockHash, requireCanonical: true })));
    const wrong = transport(c => c.method === "eth_chainId" ? "0x1" : remoteAnswer(c));
    await assert.rejects(readRemoteConfigSnapshot({ ...target, sepoliaRpc: endpoint }, wrong.fetcher), /Wrong registry chain/);
    assert.equal(wrong.calls.length, 1);
  }
});

// The real execution composition and journal use fake signer/persistence ports; no key files or signatures are created.
const intent = { chainId: "11155111", kind: "call" as const, from: FORWARD.administrator, to: FORWARD.token,
  data: "0x12345678", value: "0", nonce: "7" };
const signerConfig: CastSignerConfig = { testOnly: true, executable: "/unused", executableSha256: "00".repeat(32),
  keystore: "/unused", passwordFile: "/unused", gasLimit: "21000", maxFeePerGas: "100", maxPriorityFeePerGas: "1" };
function executionFixture(override?: (call: Request) => unknown, sendError = false) {
  let record: EvmJournalRecord | null = null, signatures = 0, sends = 0;
  const f = transport(c => {
    const changed = override?.(c); if (changed !== undefined) { return changed; }
    switch (c.method) {
      case "eth_chainId": return "0xaa36a7";
      case "eth_getTransactionCount": return "0x7";
      case "eth_getBalance": return "0xffffff";
      case "eth_getTransactionByHash": case "eth_getTransactionReceipt": return null;
      case "eth_sendRawTransaction": sends++; if (sendError) { throw new Error("ambiguous send"); } return hash;
      default: assert.fail(c.method);
    }
  });
  const io: SepoliaExecutionIo = { fetcher: f.fetcher, journal: () => ({ exclusive: work => work(), read: async () => record,
    write: async next => { record = next; } }), signer: () => ({
    sign: async () => { signatures++; return { bytes: "0x0102", hash }; },
    inspectSigned: async () => ({ ...intent, hash }),
  }) };
  return { io, calls: f.calls, counters: () => ({ signatures, sends }), record: () => record };
}
test("selected TEST RPC carries funding/nonce, first send and observation; ambiguous resume never resends", async () => {
  const f = executionFixture(undefined, true), settings = { sepoliaRpc: PUBLIC_SEPOLIA_RPC, signer: signerConfig, journalFile: "/unused/journal" };
  assert.equal((await executeSepoliaIntent(intent, settings, f.io)).status, "unresolved");
  assert.equal(f.record()?.phase, "submitting");
  assert.deepEqual(f.counters(), { signatures: 1, sends: 1 });
  await executeSepoliaIntent(intent, settings, f.io);
  assert.deepEqual(f.counters(), { signatures: 1, sends: 1 });
  assert.ok(f.calls.every(c => c.endpoint === new URL(PUBLIC_SEPOLIA_RPC).href));
  assert.equal(f.calls.filter(c => c.call.method === "eth_getTransactionCount").length, 1);
  assert.equal(f.calls.filter(c => c.call.method === "eth_getBalance").length, 1);
  assert.ok(f.calls.some(c => c.call.method === "eth_getTransactionByHash"));
  for (const c of f.calls) { assert.equal(c.init.redirect, "error"); assert.ok(c.init.signal instanceof AbortSignal); }
  const priorCalls = f.calls.length;
  // An operator's explicit endpoint change reconciles the same uncertain signature; it cannot resend.
  await executeSepoliaIntent(intent, { ...settings, sepoliaRpc: DEFAULT_SEPOLIA_RPC }, f.io);
  assert.deepEqual(f.counters(), { signatures: 1, sends: 1 });
  assert.ok(f.calls.slice(priorCalls).every(c => c.endpoint === new URL(DEFAULT_SEPOLIA_RPC).href));
});
test("wrong chain, changed nonce and insufficient funding reject before fake signer or send", async () => {
  for (const [method, result] of [["eth_chainId", "0x1"], ["eth_getTransactionCount", "0x8"], ["eth_getBalance", "0x1"]]) {
    const f = executionFixture(c => c.method === method ? result : undefined);
    await assert.rejects(executeSepoliaIntent(intent, { sepoliaRpc: PUBLIC_SEPOLIA_RPC, signer: signerConfig,
      journalFile: "/unused/journal" }, f.io));
    assert.deepEqual(f.counters(), { signatures: 0, sends: 0 }); assert.equal(f.record(), null);
  }
});

test("forward composition forwards the selected RPC to SDK, readiness, approval/send and submitted resume", async () => {
  for (const allowance of [0n, FORWARD.amount]) {
    const settings = { testOnly: true, sepoliaRpc: PUBLIC_SEPOLIA_RPC, signer: signerConfig, approvalNonce: "7", sendNonce: "8",
      approvalJournal: "/unused/approval", sendJournal: "/unused/send" };
    const snapshot = await readRemoteConfigSnapshot(target, transport().fetcher);
    const send = { from: FORWARD.administrator, to: FORWARD.router, value: 5n, data: "0x12345678" };
    const approval = { ...send, to: FORWARD.token, value: 0n };
    let stored: EvmJournalRecord | null = null;
    const selected: string[] = [];
    const ports = { exclusive: async (_: string, work: () => Promise<unknown>) => work(),
      sdk: async (_directory: unknown, _recipient: unknown, _fixture: unknown, endpoint = DEFAULT_SEPOLIA_RPC) => {
        selected.push(endpoint);
        return { allowance: async () => allowance, verify: () => {}, destroy: async () => {},
          prepare: async () => ({ fee: 5n, send, approval: allowance === 0n ? approval : null }) };
      }, snapshot: async (config: Parameters<typeof readRemoteConfigSnapshot>[0]) => { assert.ok(config.sepoliaRpc); selected.push(config.sepoliaRpc); return snapshot; },
      read: async (path: string) => path === settings.sendJournal ? stored : null,
      execute: async (_intent: unknown, config: Parameters<typeof executeSepoliaIntent>[1]) => {
        assert.ok(config.sepoliaRpc); selected.push(config.sepoliaRpc);
        return { status: "unresolved", reason: "mock-awaiting-finality", transactionHash: hash };
      } } satisfies NonNullable<Parameters<typeof transferEvmForward>[1]>;
    assert.equal((await transferEvmForward(settings, ports)).step, allowance === 0n ? "approval" : "send");
    assert.ok(selected.length >= 3); assert.ok(selected.every(endpoint => endpoint === PUBLIC_SEPOLIA_RPC));
    selected.length = 0;
    // Use the domain validator for a canonical saved envelope rather than fabricating its schema.
    const { validateSepoliaIntent } = await import("../src/domain/evm-intent.ts");
    const input = forwardIntent(send, settings.sendNonce);
    stored = { schema: "agtmai-evm-journal-v1", phase: "submitted", intent: validateSepoliaIntent(input, input), signed: { bytes: "0x0102", hash } };
    await transferEvmForward(settings, ports);
    assert.deepEqual(selected, [PUBLIC_SEPOLIA_RPC, PUBLIC_SEPOLIA_RPC]);
  }
});

test("native status observation uses the selected endpoint and retains finality/chain refusal", async () => {
  const f = transport(c => c.method === "eth_chainId" ? "0x1" : assert.fail("Wrong chain must stop status reads"));
  const native = createNativeStatus(PUBLIC_SEPOLIA_RPC, DEFAULT_SOLANA_RPC, {}, f.fetcher);
  await assert.rejects(native.ethereum(hash, "lock"), /not successful finalized/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].endpoint, new URL(PUBLIC_SEPOLIA_RPC).href);
});

test("transport and SDK hook reject malformed, redirected, oversized and uncertain responses without retry", async () => {
  for (const payload of [null, [], { jsonrpc: "1.0", id: 1, result: 1 }, { jsonrpc: "2.0", id: 99, result: 1 },
    { jsonrpc: "2.0", id: 1, result: 1, error: null }, { jsonrpc: "2.0", id: 1 }]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return new Response(JSON.stringify(payload)); };
    await assert.rejects(createTestRpcRequest(PUBLIC_SEPOLIA_RPC, fetcher)("eth_sendRawTransaction", ["0x01"]));
    assert.equal(calls, 1);
  }
  for (const response of [() => new Response("not JSON"), () => new Response("{}", { status: 302 }),
    () => new Response("{}", { headers: { "content-length": String(TEST_RPC_RESPONSE_LIMIT + 1) } }),
    () => { const r = new Response("{}"); Object.defineProperty(r, "redirected", { value: true }); return r; }]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return response(); };
    await assert.rejects(createTestRpcRequest(PUBLIC_SEPOLIA_RPC, fetcher)("eth_chainId", []));
    assert.equal(calls, 1);
    await assert.rejects(createSdkTestFetch(PUBLIC_SEPOLIA_RPC, fetcher)(PUBLIC_SEPOLIA_RPC,
      { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }));
    assert.equal(calls, 2);
  }
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(TEST_RPC_RESPONSE_LIMIT)); },
    cancel() { cancelled++; } });
  await assert.rejects(createTestRpcRequest(PUBLIC_SEPOLIA_RPC, async () => new Response(stream))("eth_chainId", []), /exceeds bound/);
  assert.equal(cancelled, 1);
  const malformed = createSepoliaRpc(PUBLIC_SEPOLIA_RPC, async () => new Response("not JSON"));
  assert.deepEqual(await malformed.observe(hash), { kind: "unknown" });
});
test("SDK RPC hook binds batch identities, bounded fetch options and public endpoint with no credential headers", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++; assert.equal(String(url), new URL(PUBLIC_SEPOLIA_RPC).href); assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit"); assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(init?.headers, { "content-type": "application/json" });
    return new Response(JSON.stringify([{ jsonrpc: "2.0", id: 2, result: "0x7" }, { jsonrpc: "2.0", id: 1, result: "0xaa36a7" }]));
  };
  const requests = [{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 2, method: "eth_getTransactionCount", params: [FORWARD.administrator, "pending"] }];
  const guarded = createSdkTestFetch(PUBLIC_SEPOLIA_RPC, fetcher);
  assert.equal((await guarded(PUBLIC_SEPOLIA_RPC, { method: "POST", body: JSON.stringify(requests),
    headers: { authorization: "synthetic-do-not-forward" } })).status, 200);
  await assert.rejects(guarded(DEFAULT_SEPOLIA_RPC, { method: "POST", body: JSON.stringify(requests) }));
  assert.equal(calls, 1);
  const wrong = createSdkTestFetch(PUBLIC_SEPOLIA_RPC, async () => new Response(JSON.stringify([
    { jsonrpc: "2.0", id: 1, result: "ok" }, { jsonrpc: "2.0", id: 1, result: "wrong" }])));
  await assert.rejects(wrong(PUBLIC_SEPOLIA_RPC, { method: "POST", body: JSON.stringify(requests) }), /Invalid SDK TEST RPC envelope/);
});
