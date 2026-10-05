import assert from "node:assert/strict";
import test from "node:test";
import { createEvmForwardSdk } from "../src/adapters/evm-forward-sdk.mjs";
import { TEST_SDK_PROFILE, selectTestSdk, type TestSdkSelection } from "../src/adapters/test-sdk-policy.ts";
import { sdkForwardFetch, type UnsignedForward } from "../src/adapters/test-sdk-forward.ts";
import { replacementFixture } from "../src/domain/replacement-fixture.ts";
import { DEFAULT_SEPOLIA_RPC, TEST_RPC_RESPONSE_LIMIT } from "../src/adapters/test-rpc.ts";
import type { EVMChain } from "../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/index.js";

// Controlled responses are unit tests. They never claim public capture or route qualification.
const fixture = replacementFixture("0x812c4dcbc459a55f8517e87e825b8c728cee7316", "0x8472aa06661671e7e4af43048f0d0446eff2e97d");
const root = "/absent-provider-sentinel";
const selection: TestSdkSelection = { providerProfile: TEST_SDK_PROFILE, testOnly: true,
  fixture, fixtureIdentity: fixture.identity, providerArchives: "/absent-archives-sentinel" };
test("absence alone selects legacy; present invalid profiles reject synchronously before IO", async () => {
  assert.equal(selectTestSdk({}, root), undefined);
  for (const providerProfile of [undefined, null, "", "unknown", false, {}]) {
    assert.throws(() => createEvmForwardSdk(root, undefined, fixture, DEFAULT_SEPOLIA_RPC,
      { ...selection, providerProfile }), /Unknown or non-TEST SDK profile/);
  }
  assert.throws(() => createEvmForwardSdk(root, undefined, fixture, DEFAULT_SEPOLIA_RPC,
    { ...selection, fixtureIdentity: "wrong" }), /fixture identity/);
  assert.throws(() => selectTestSdk({ ...selection, ccipProviderDirectory: "/other" }, root, fixture), /Divergent/);
  assert.throws(() => selectTestSdk({ ...selection, fixture: { ...fixture, amount: "1000000001" } }, root, fixture), /mutated replacement fixture/);
  assert.throws(() => selectTestSdk(selection, root, { ...fixture, amount: "1" }), /mutated replacement fixture/);
  assert.throws(() => createEvmForwardSdk(root, undefined, fixture, DEFAULT_SEPOLIA_RPC, selection), /replay transport/);
  await assert.rejects(createEvmForwardSdk(root, undefined, fixture, DEFAULT_SEPOLIA_RPC), /ENOENT/);
});
test("pinned Uint8Array SDK body reaches injected bounded TEST hook", async () => {
  let calls = 0;
  const replay: typeof fetch = async (_input, init) => {
    calls++; assert.equal(init?.redirect, "error"); assert.equal(init.credentials, "omit"); assert.ok(init.signal);
    const r = JSON.parse(String(init.body)) as { id: number };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: "0xaa36a7" }));
  };
  const fetcher = sdkForwardFetch(DEFAULT_SEPOLIA_RPC, replay, new AbortController().signal);
  const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
  const response = await fetcher(DEFAULT_SEPOLIA_RPC, { method: "POST", body });
  assert.equal((await response.json() as { result: string }).result, "0xaa36a7"); assert.equal(calls, 1);
  for (const [bad, reason] of [[new Uint8Array([0xff]), /encoded data/], [new Uint8Array(TEST_RPC_RESPONSE_LIMIT + 1), /request bytes exceed bound/],
    [new URLSearchParams(), /Unexpected\/aborted/], ["{}", /Non-read SDK forward RPC/]] as const) {
    await assert.rejects(fetcher(DEFAULT_SEPOLIA_RPC, { method: "POST", body: bad }), reason);
  }
  await assert.rejects(fetcher(DEFAULT_SEPOLIA_RPC, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [] }) }), /Non-read/);
  assert.equal(calls, 1);
});
test("batch/envelope, URL, deadline, redirect and response bounds fail at the intended transport", async () => {
  const request = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
  for (const body of [[], [{ jsonrpc: "2.0", id: 2, result: "0xaa36a7" }], [{ jsonrpc: "2.0", id: 1, result: "0xaa36a7" }, { jsonrpc: "2.0", id: 1, result: "0xaa36a7" }]]) {
    let calls = 0;
    const fetcher = sdkForwardFetch(DEFAULT_SEPOLIA_RPC, async () => { calls++; return new Response(JSON.stringify(body)); }, new AbortController().signal);
    await assert.rejects(fetcher(DEFAULT_SEPOLIA_RPC, { method: "POST", body: JSON.stringify([request]) }), /envelope/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const fetcher = sdkForwardFetch(DEFAULT_SEPOLIA_RPC, async () => { calls++; return new Response("{}", { headers: { "content-length": String(TEST_RPC_RESPONSE_LIMIT + 1) } }); }, new AbortController().signal);
  await assert.rejects(fetcher("https://example.invalid", { method: "POST", body: JSON.stringify(request) }), /request/);
  assert.equal(calls, 0);
  await assert.rejects(fetcher(DEFAULT_SEPOLIA_RPC, { method: "POST", body: JSON.stringify(request) }), /exceeds bound/); assert.equal(calls, 1);
  const redirected = new Response("{}"); Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(sdkForwardFetch(DEFAULT_SEPOLIA_RPC, async () => { calls++; return redirected; }, new AbortController().signal)(DEFAULT_SEPOLIA_RPC,
    { method: "POST", body: JSON.stringify(request) }), /SDK TEST RPC unavailable/); assert.equal(calls, 2);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(sdkForwardFetch(DEFAULT_SEPOLIA_RPC, async () => { calls++; throw new Error("must not fetch"); }, abort.signal)(DEFAULT_SEPOLIA_RPC,
    { method: "POST", body: JSON.stringify(request) }), /aborted/); assert.equal(calls, 2);
});
// Negative declaration contracts: widening to any makes @ts-expect-error fail compilation.
function typeContracts(ctor: typeof import("../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/index.js").EVMChain, chain: EVMChain, view: UnsignedForward, fetcher: typeof fetch): void {
  // @ts-expect-error unsigned view has no signing capability
  view.signTransaction("0x");
  // @ts-expect-error declaration requires bigint selector
  chain.getFee({ router: "0x", destChainSelector: 1, message: { receiver: "0x" } });
  // @ts-expect-error declaration requires bigint token amount
  chain.generateUnsignedSendMessage({ sender: "0x", router: "0x", destChainSelector: 1n, message: { receiver: "0x", tokenAmounts: [{ token: "0x", amount: 1000 }] } });
  // @ts-expect-error real fromUrl context requires fetch-compatible response
  ctor.fromUrl(DEFAULT_SEPOLIA_RPC, { fetch: () => 5 });
  // @ts-expect-error actual fetch requires URL-compatible input
  fetcher(5);
  // @ts-expect-error changed adapter selection requires string identity
  createEvmForwardSdk(root, undefined, fixture, DEFAULT_SEPOLIA_RPC, { ...selection, fixtureIdentity: 5 });
}
void typeContracts;
