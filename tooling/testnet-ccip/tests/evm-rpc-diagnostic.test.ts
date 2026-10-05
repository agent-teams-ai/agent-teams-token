import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createSepoliaRpc } from "../src/adapters/evm-rpc.ts";
import type { EvmRpcDiagnostic } from "../src/application/evm-rpc-diagnostic.ts";

const canary = "SECRET_CANARY_PROVIDER_BODY_EXCEPTION_HEADERS";
const endpointCanary = "SECRET_CANARY_ENDPOINT";
const bytes = "0xdecafbadcafe0123456789abcdef";
const hash = "0x" + "11".repeat(32);
test.before(() => { mock.method(globalThis, "fetch", async () => assert.fail("Network fallback forbidden")); });
test.after(() => { mock.restoreAll(); });
type Call = { method: string; id: number; params: unknown[] };
type Reply = (call: Call) => Response | Promise<Response>;
function setup(reply: Reply, failChain = false) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const call = JSON.parse(init!.body as string) as Call;
    calls.push(call);
    return call.method === "eth_chainId" && !failChain
      ? new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: "0xaa36a7" })) : reply(call);
  };
  return { rpc: createSepoliaRpc("https://test.invalid/" + endpointCanary, fetcher), calls };
}
const errorReply = (id: number, error: unknown, extra = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, error, ...extra }));

test("correlated JSON-RPC fault retains safe code only and sanitized exception, with no retry", async () => {
  const { rpc, calls } = setup(c => errorReply(c.id, { code: -32000, message: canary,
    data: { endpoint: endpointCanary, rawTransaction: bytes, nested: canary } }));
  await assert.rejects(rpc.broadcast(bytes), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "RPC error response received");
    assert.equal(error.cause, undefined);
    for (const secret of [canary, endpointCanary, bytes]) { assert.ok(!error.stack?.includes(secret)); }
    return true;
  });
  assert.deepEqual(rpc.diagnostic(), { method: "eth_sendRawTransaction", kind: "jsonrpc",
    httpStatus: 200, rpcCode: -32000, message: "RPC error response received" });
  assert.deepEqual(calls.map(c => c.method), ["eth_chainId", "eth_sendRawTransaction"]);
});

test("HTTP, redirect, decode and transport faults expose bounded static metadata only", async () => {
  const cases: { reply: Reply; expected: Omit<EvmRpcDiagnostic, "method"> }[] = [
    { reply: () => Response.error(), expected: { kind: "http", message: "RPC HTTP response unavailable" } },
    { reply: () => new Response(canary + bytes, { status: 403, headers: { "x-canary": canary } }),
      expected: { kind: "http", httpStatus: 403, message: "RPC HTTP response unavailable" } },
    { reply: () => { const response = new Response(canary); Object.defineProperty(response, "redirected", { value: true }); return response; },
      expected: { kind: "http", httpStatus: 200, message: "RPC HTTP response unavailable" } },
    { reply: () => new Response(canary + bytes),
      expected: { kind: "json", httpStatus: 200, message: "RPC response decoding failed" } },
    { reply: () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(canary)); } })),
      expected: { kind: "json", httpStatus: 200, message: "RPC response decoding failed" } },
    { reply: () => { throw new DOMException(canary + bytes, "TimeoutError"); },
      expected: { kind: "transport", message: "RPC transport failed" } },
  ];
  for (const { reply, expected } of cases) {
    const { rpc, calls } = setup(reply);
    await assert.rejects(rpc.broadcast(bytes), { message: expected.message });
    assert.deepEqual(rpc.diagnostic(), { method: "eth_sendRawTransaction", ...expected });
    const output = JSON.stringify(rpc.diagnostic());
    for (const secret of [canary, endpointCanary, bytes]) { assert.ok(!output.includes(secret)); }
    assert.equal(calls.filter(c => c.method === "eth_sendRawTransaction").length, 1);
  }
});

test("foreign ids, mixed envelopes and malformed codes never acquire trusted rpcCode", async () => {
  const replies: Reply[] = [
    c => errorReply(c.id + 1, { code: -32000, message: canary }),
    c => errorReply(c.id, { code: -32000, message: canary }, { result: hash }),
    c => errorReply(c.id, { code: -32000, message: canary }, { jsonrpc: "1.0" }),
    ...["-32000", 1.5, Number.MAX_SAFE_INTEGER + 1, null].map(code =>
      (c: Call) => errorReply(c.id, { code, message: canary })),
    c => errorReply(c.id, { code: -32000 }),
    c => errorReply(c.id, { code: -32000, message: { canary } }),
    c => errorReply(c.id, [canary]),
    c => errorReply(c.id, null),
    () => new Response(JSON.stringify([canary])),
    () => new Response(JSON.stringify(null)),
    c => new Response(JSON.stringify({ jsonrpc: "2.0", id: c.id, canary })),
  ];
  for (const reply of replies) {
    const { rpc } = setup(reply);
    await assert.rejects(rpc.broadcast(bytes), { message: "RPC response envelope invalid" });
    assert.deepEqual(rpc.diagnostic(), { method: "eth_sendRawTransaction", kind: "envelope",
      httpStatus: 200, message: "RPC response envelope invalid" });
  }
});

test("pre-send chain failure and invalid returned hash identify the failing method without authorizing retry", async () => {
  const wrongChain = setup(c => new Response(JSON.stringify({ jsonrpc: "2.0", id: c.id, result: "0x1" })), true);
  await assert.rejects(wrongChain.rpc.broadcast(bytes), { message: "RPC evidence invalid" });
  assert.deepEqual(wrongChain.rpc.diagnostic(), { method: "eth_chainId", kind: "evidence", message: "RPC evidence invalid" });
  assert.equal(wrongChain.calls.length, 1);
  const badHash = setup(c => new Response(JSON.stringify({ jsonrpc: "2.0", id: c.id, result: canary })));
  await assert.rejects(badHash.rpc.broadcast(bytes), { message: "RPC evidence invalid" });
  assert.deepEqual(badHash.rpc.diagnostic(), { method: "eth_sendRawTransaction", kind: "evidence", message: "RPC evidence invalid" });
  assert.equal(badHash.calls.length, 2);
});

test("observation remains unknown and retains one immutable first fault, while success has no diagnostic", async () => {
  let responses = 0;
  const { rpc } = setup(() => new Response(canary, { status: ++responses === 1 ? 503 : 403 }), true);
  assert.deepEqual(await rpc.observe(hash), { kind: "unknown" });
  const first = rpc.diagnostic();
  assert.deepEqual(first, { method: "eth_chainId", kind: "http", httpStatus: 503, message: "RPC HTTP response unavailable" });
  assert.ok(Object.isFrozen(first));
  assert.throws(() => Object.assign(first!, { message: canary }), TypeError);
  await assert.rejects(rpc.broadcast(bytes));
  assert.strictEqual(rpc.diagnostic(), first);
  const good = setup(c => new Response(JSON.stringify({ jsonrpc: "2.0", id: c.id, result: hash })));
  assert.equal(await good.rpc.broadcast(bytes), hash);
  assert.equal(good.rpc.diagnostic(), undefined);
});
