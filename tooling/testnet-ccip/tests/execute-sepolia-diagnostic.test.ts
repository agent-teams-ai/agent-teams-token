import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { executeSepoliaIntent } from "../src/composition/execute-sepolia.ts";
import type { SepoliaExecutionIo } from "../src/composition/execute-sepolia.ts";
import type { deployTestToken } from "../src/composition/deploy-token.ts";
import { createJournalFile } from "../src/adapters/evm-journal-file.ts";
import type { EvmJournalRecord } from "../src/application/evm-journal.ts";
import type { EvmRpcDiagnostic } from "../src/application/evm-rpc-diagnostic.ts";
import type { CastSignerConfig } from "../src/adapters/evm-cast.ts";
import { validateSepoliaIntent } from "../src/domain/evm-intent.ts";

// Synthetic signer/inspection ports only; real transport adapter, journal and public composition.
const hash = "0x" + "ab".repeat(32), bytes = "0xdecafbadcafe0123456789abcdef";
const canary = "SECRET_CANARY_PROVIDER_EXCEPTION_DATA_HEADER_URL_CREDENTIAL";
const intent = { chainId: "11155111", kind: "call" as const, from: "0x" + "11".repeat(20),
  to: "0x" + "22".repeat(20), nonce: "7", value: "0", data: "0x12345678" };
const signer: CastSignerConfig = { testOnly: true, executable: "/unused", executableSha256: "00".repeat(32),
  keystore: "/unused", passwordFile: "/unused", gasLimit: "21000", maxFeePerGas: "100", maxPriorityFeePerGas: "1" };
type Call = { id: number; method: string; params: unknown[] };
const json = (call: Call, result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
type Scenario = { name: string; fail: (call: Call) => Response; expected?: EvmRpcDiagnostic; preSend?: boolean };
const scenarios: Scenario[] = [
  { name: "correlated -32000", fail: call => new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id,
    error: { code: -32000, message: "nonce too low " + canary, data: { canary, bytes } } })),
    expected: { method: "eth_sendRawTransaction", kind: "jsonrpc", httpStatus: 200, rpcCode: -32000, message: "RPC error response received" } },
  { name: "HTTP 403", fail: () => new Response(canary + bytes, { status: 403, headers: { "x-canary": canary } }),
    expected: { method: "eth_sendRawTransaction", kind: "http", httpStatus: 403, message: "RPC HTTP response unavailable" } },
  { name: "transport timeout", fail: () => { throw new DOMException(canary + bytes, "TimeoutError"); },
    expected: { method: "eth_sendRawTransaction", kind: "transport", message: "RPC transport failed" } },
  { name: "pre-send chain HTTP failure", preSend: true, fail: () => new Response(canary, { status: 503 }),
    expected: { method: "eth_chainId", kind: "http", httpStatus: 503, message: "RPC HTTP response unavailable" } },
  { name: "successful response keeps prior public shape", fail: call => json(call, hash) },
];
for (const scenario of scenarios) {
  test(`public result retains ${scenario.name}; durable reopen never signs or sends again`, async t => {
    t.mock.method(globalThis, "fetch", async () => assert.fail("Network fallback forbidden"));
    const logs: string[] = [];
    for (const method of ["log", "error", "warn"] as const) {
      t.mock.method(console, method, (...args: unknown[]) => { logs.push(JSON.stringify(args)); });
    }
    const directory = await mkdtemp(resolve(".local/rpc-diagnostic-journal-"));
    const journalFile = join(directory, "operation.json");
    const settings = { signer, journalFile };
    let signatures = 0, attempts = 0, chainReads = 0;
    const calls: Call[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const call = JSON.parse(init!.body as string) as Call;
      calls.push(call);
      switch (call.method) {
        case "eth_chainId":
          if (++chainReads === 4 && scenario.preSend) { return scenario.fail(call); }
          return json(call, "0xaa36a7");
        case "eth_getTransactionCount": return json(call, "0x7");
        case "eth_getBalance": return json(call, "0xffffff");
        case "eth_getTransactionByHash": case "eth_getTransactionReceipt": return json(call, null);
        case "eth_sendRawTransaction": {
          attempts++;
          assert.deepEqual(call.params, [bytes]);
          const persisted = JSON.parse(await readFile(journalFile, "utf8")) as EvmJournalRecord;
          assert.equal(persisted.phase, "submitting");
          return scenario.fail(call);
        }
        default: assert.fail("Unexpected offline request " + call.method);
      }
    };
    const io: SepoliaExecutionIo = { fetcher, journal: createJournalFile, signer: () => ({
      sign: async () => { signatures++; return { bytes, hash }; },
      inspectSigned: async raw => { assert.equal(raw, bytes); return { ...intent, hash }; },
    }) };
    try {
      const first = await executeSepoliaIntent(intent, settings, io);
      assert.deepEqual(first, { status: "unresolved",
        reason: scenario.expected ? "broadcast-outcome-unknown" : "submitted-awaiting-observation",
        transactionHash: hash, ...(scenario.expected ? { diagnostic: scenario.expected } : {}) });
      // The deploy-token return contract must retain the optional metadata for its JSON stdout receipt.
      const operatorResult: Awaited<ReturnType<typeof deployTestToken>> = first;
      const output = JSON.stringify(operatorResult);
      for (const secret of [canary, bytes, "/unused"]) { assert.ok(!output.includes(secret)); }
      assert.deepEqual(logs, []);
      const persistedBytes = await readFile(journalFile, "utf8");
      const persisted = JSON.parse(persistedBytes) as EvmJournalRecord;
      assert.equal(persisted.phase, scenario.expected ? "submitting" : "submitted");
      assert.deepEqual(persisted.signed, { bytes, hash });
      assert.equal(Object.hasOwn(persisted, "diagnostic"), false);
      const beforeReopen = calls.length;
      assert.deepEqual(await executeSepoliaIntent(intent, settings, io), {
        status: "unresolved", reason: "prior-submission-not-observed", transactionHash: hash,
      });
      assert.equal(await readFile(journalFile, "utf8"), persistedBytes);
      assert.equal(signatures, 1);
      assert.equal(attempts, scenario.preSend ? 0 : 1);
      assert.deepEqual(calls.slice(beforeReopen).map(c => c.method), ["eth_chainId", "eth_getTransactionByHash",
        "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_chainId"]);
      assert.deepEqual(logs, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await assert.rejects(lstat(directory), { code: "ENOENT" });
    }
  });
}

test("submitting reopen attributes malformed transaction evidence after a valid null receipt to its source RPC", async () => {
  const directory = await mkdtemp(resolve(".local/rpc-diagnostic-journal-"));
  const journalFile = join(directory, "operation.json");
  const journal = createJournalFile(journalFile);
  const record: EvmJournalRecord = { schema: "agtmai-evm-journal-v1", intent: validateSepoliaIntent(intent, intent),
    signed: { bytes, hash }, phase: "submitting" };
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const call = JSON.parse(init!.body as string) as Call;
    calls.push(call);
    switch (call.method) {
      case "eth_chainId": return json(call, "0xaa36a7");
      case "eth_getTransactionByHash": return json(call, { ...intent, hash, chainId: "0xaa36a7",
        nonce: "0x07", value: "0x0", input: intent.data, providerData: { canary, bytes } });
      case "eth_getTransactionReceipt": return json(call, null);
      default: assert.fail("Reopen may only observe: " + call.method);
    }
  };
  const io: SepoliaExecutionIo = { fetcher, journal: createJournalFile, signer: () => ({
    sign: async () => assert.fail("Submitting reopen must not sign"),
    inspectSigned: async raw => { assert.equal(raw, bytes); return { ...intent, hash }; },
  }) };
  try {
    await journal.exclusive(() => journal.write(record));
    const before = await readFile(journalFile, "utf8");
    const result = await executeSepoliaIntent(intent, { signer, journalFile }, io);
    assert.equal(await readFile(journalFile, "utf8"), before);
    assert.deepEqual(calls.map(c => [c.method, c.params]), [
      ["eth_chainId", []], ["eth_getTransactionByHash", [hash]], ["eth_getTransactionReceipt", [hash]],
    ]);
    assert.deepEqual(result, { status: "unresolved", reason: "observation-unknown", transactionHash: hash,
      diagnostic: { method: "eth_getTransactionByHash", kind: "evidence", message: "RPC evidence invalid" } });
    assert.ok(Object.isFrozen(result.diagnostic));
    for (const secret of [canary, bytes, "/unused"]) { assert.ok(!JSON.stringify(result).includes(secret)); }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await assert.rejects(lstat(directory), { code: "ENOENT" });
  }
});
