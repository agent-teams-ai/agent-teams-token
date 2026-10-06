import { openTestSdk } from "./test-sdk-admission.ts";
import { selectTestSdk, type ExplicitTestSdkSelection } from "./test-sdk-policy.ts";
import { createSdkTestFetch, selectSepoliaRpc, TEST_RPC_RESPONSE_LIMIT } from "./test-rpc.ts";
import { forwardRoute, boundedAllowance, forwardRecipient } from "../domain/evm-forward.mjs";
import type { ReplacementFixture } from "../domain/replacement-fixture.ts";
import type { EVMChain } from "../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/index.js";

export interface ForwardTransaction { readonly from: string; readonly to: string; readonly data: string; readonly value: bigint }
export interface UnsignedForward {
  allowance(): Promise<bigint>;
  prepare(): Promise<Readonly<{ fee: bigint; send: ForwardTransaction; approval: ForwardTransaction | null }>>;
  verify(tx: ForwardTransaction, step: "send" | "approval", fee: bigint): ForwardTransaction;
  destroy(): Promise<void>;
}
/** Normalize only the actual pinned SDK FetchRequest bytes. Existing TEST bounds stay authoritative. */
export function sdkForwardFetch(endpoint: string, replayFetch: typeof fetch, abort: AbortSignal): typeof fetch {
  const checked = createSdkTestFetch(endpoint, replayFetch);
  return async (input, init) => {
    let body = init?.body;
    if (body instanceof Uint8Array) {
      if (body.byteLength > TEST_RPC_RESPONSE_LIMIT) { throw new Error("SDK request bytes exceed bound"); }
      body = new TextDecoder("utf-8", { fatal: true }).decode(body);
    }
    if (typeof body !== "string" || Buffer.byteLength(body) > TEST_RPC_RESPONSE_LIMIT || abort.aborted) {
      throw new Error("Unexpected/aborted SDK forward transport");
    }
    const requests: unknown = JSON.parse(body);
    const allowed = ["eth_chainId", "eth_call", "eth_getCode", "eth_blockNumber", "eth_getBlockByNumber"];
    for (const r of Array.isArray(requests) ? requests : [requests]) {
      if (!r || typeof r !== "object" || !("method" in r) || !allowed.includes(String(r.method))) { throw new Error("Non-read SDK forward RPC forbidden"); }
    }
    return checked(input, { ...init, body, signal: init?.signal ? AbortSignal.any([abort, init.signal]) : abort });
  };
}
function transaction(value: unknown): ForwardTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) { throw new Error("Invalid SDK transaction"); }
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(k => !["from", "to", "data", "value"].includes(k)) ||
    typeof r.from !== "string" || typeof r.to !== "string" || typeof r.data !== "string" ||
    (r.value !== undefined && typeof r.value !== "bigint")) { throw new Error("Unexpected SDK transaction fields"); }
  return Object.freeze({ from: r.from, to: r.to, data: r.data, value: r.value ?? 0n });
}
/** Single forward consumer; API fallback disabled, no signer/provider capability escapes. */
export interface TestForwardOptions {
  readonly directory: string; readonly recipientValue: string | undefined; readonly fixture: ReplacementFixture;
  readonly endpoint: string; readonly selection: ExplicitTestSdkSelection; readonly replayFetch: typeof fetch;
  readonly createDecoder: (abi: typeof import("../../../../.local/INPUT/provider/node_modules/ethers/lib.esm/abi/index.js"),
    recipient: string, fixture: ReplacementFixture) => (tx: unknown, step: "approval" | "send", fee: bigint) => unknown;
}
export async function createTestSdkForward(options: TestForwardOptions): Promise<Readonly<UnsignedForward>> {
  const { directory, recipientValue, fixture, endpoint, selection, replayFetch, createDecoder } = options;
  const selected = selectTestSdk(selection, directory, fixture);
  if (!selected || typeof replayFetch !== "function") { throw new Error("Explicit TEST selection and injected replay fetch required"); }
  const rpcUrl = selectSepoliaRpc({ sepoliaRpc: endpoint }), route = forwardRoute(selected.fixture);
  const recipient = forwardRecipient(recipientValue, selected.fixture), abort = new AbortController();
  const session = await openTestSdk({ root: directory, archives: selected.archives });
  let chain: EVMChain | undefined, closing = false, busy: Promise<unknown> | undefined, destroyPromise: Promise<void> | undefined;
  const transports = new Set<Promise<Response>>(), fetcher = sdkForwardFetch(rpcUrl, replayFetch, abort.signal);
  const ownedFetch: typeof fetch = (input, init) => {
    const result = fetcher(input, init); transports.add(result);
    void result.then(() => transports.delete(result), () => transports.delete(result));
    return result;
  };
  const release = (): Promise<void> => {
    if (destroyPromise) { return destroyPromise; }
    closing = true; abort.abort();
    const active = busy;
    destroyPromise = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            if (active) { await active.catch(() => {}); }
            await Promise.allSettled(transports);
            if (chain) { await chain.destroy(); }
            session.close();
          })(),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error("Unresolved TEST SDK forward drain")), 20_000);
          }),
        ]);
      } finally { clearTimeout(deadline); }
    })();
    return destroyPromise;
  };
  try {
    chain = await session.evm.EVMChain.fromUrl(rpcUrl, { apiClient: null, abort: abort.signal,
      fetch: ownedFetch });
    session.assertHealthy();
    if (chain.network.chainSelector !== BigInt(selected.fixture.reverseSelector)) { throw new Error("Wrong TEST SDK source chain"); }
    const client = chain, decoder = createDecoder(session.abi, recipient, selected.fixture);
    const verify: UnsignedForward["verify"] = (tx, step, fee) => { session.assertHealthy(); if (closing) { throw new Error("Forward client busy/destroyed"); } decoder(tx, step, fee); return tx; };
    async function run<T>(operation: () => Promise<T>): Promise<T> {
      session.assertHealthy(); if (busy || closing) { throw new Error("Forward client busy/destroyed"); }
      const result = operation(); busy = result;
      try { const value = await result; session.assertHealthy(); if (closing) { throw new Error("Forward client busy/destroyed"); } return value; }
      catch (error) { await release(); throw error; } finally { busy = undefined; }
    }
    const readAllowance = async (): Promise<bigint> => {
      if (BigInt(await client.provider.send("eth_chainId", [])) !== 11155111n) { throw new Error("Wrong forward source chain"); }
      const token = new session.contract.Contract(route.token, ["function allowance(address,address) view returns(uint256)"], client.provider);
      const value: unknown = await token.getFunction("allowance")(route.administrator, route.router);
      if (typeof value !== "bigint") { throw new Error("Invalid allowance result"); }
      return boundedAllowance(value, route);
    };
    return Object.freeze({ verify, allowance: () => run(readAllowance),
      prepare: () => run(async () => {
        const allowance = await readAllowance();
        const registry = await client.getTokenAdminRegistryFor(route.router, route.selector);
        const registered = await client.getRegistryTokenConfig(registry, route.token);
        const pool = await client.getTokenPoolConfig(route.pool);
        const remote = await client.getTokenPoolRemote(route.pool, route.selector);
        if (remote.remoteToken !== selected.fixture.mint || remote.remotePools.length !== 1 || remote.remotePools[0] !== selected.fixture.solanaPool) {
          throw new Error("Wrong selected forward remote discovery");
        }
        if (registered.tokenPool?.toLowerCase() !== route.pool || pool.token.toLowerCase() !== route.token ||
          pool.router.toLowerCase() !== route.router || pool.typeAndVersion !== "LockReleaseTokenPool 1.6.1") {
          throw new Error("Wrong selected forward pool discovery");
        }
        const opts: Parameters<EVMChain["generateUnsignedSendMessage"]>[0] = {
          sender: route.administrator, router: route.router, destChainSelector: route.selector, approveMax: false,
          message: { receiver: "11111111111111111111111111111111", data: "0x",
            tokenAmounts: [{ token: route.token, amount: route.amount }], feeToken: "0x" + "00".repeat(20),
            extraArgs: { computeUnits: 0n, accountIsWritableBitmap: 0n, allowOutOfOrderExecution: true, tokenReceiver: recipient, accounts: [] } },
        };
        const fee = await client.getFee(opts);
        if (typeof fee !== "bigint" || fee <= 0n || fee > 10000000000000000n) { throw new Error("Native fee outside testnet bound"); }
        const candidate = await client.generateUnsignedSendMessage({ ...opts, message: { ...opts.message, fee } });
        if (await readAllowance() !== allowance) { throw new Error("Allowance changed during SDK preparation"); }
        const needsApproval = allowance < route.amount;
        if (candidate.family !== "EVM" || candidate.transactions.length !== (needsApproval ? 2 : 1)) { throw new Error("Unexpected/redundant SDK operations"); }
        const send = verify(transaction(candidate.transactions.at(-1)), "send", fee);
        const approval = needsApproval ? verify(transaction(candidate.transactions[0]), "approval", 0n) : null;
        return Object.freeze({ fee, send, approval });
      }),
      destroy: release,
    });
  } catch (error) { await release(); throw error; }
}
