import assert from "node:assert/strict";
import test from "node:test";
import { createSolanaMintSdk, createSolanaMintOperatorAttempt, type UnsignedMintSdk } from "../src/adapters/solana-sdk.mjs";
import type { RegistrationPredecessorVerifier } from "../src/adapters/solana-registration-sdk.mjs";
import { createMintOperatorIO, createPoolInitOperatorIO, setupLifetime } from "../src/composition/solana-setup-operator.ts";
import type { MintResult } from "../src/composition/solana-setup-operator.ts";
import type { ExplicitTestSdkSelection, TestSdkSelection } from "../src/adapters/test-sdk-policy.ts";
import { parseSolanaRpcAccount } from "../src/adapters/solana-transaction-rpc.ts";
import { readTestRpcJson, TEST_RPC_RESPONSE_LIMIT, UndrainedTestRpcBody } from "../src/adapters/test-rpc.ts";
import type { SolanaMintExpectation } from "../src/domain/solana-mint.ts";
import type { PreparedTransaction } from "../src/adapters/solana-transaction-sdk.mjs";
import type { SignedSolanaTransaction } from "../src/application/solana-transaction-journal.ts";
import { createSolanaRegistrationRpc } from "../src/adapters/solana-registration-rpc.ts";
import { verifyPoolConfigPredecessor } from "../src/composition/configure-solana-pool.mjs";

// Declaration-input controls never evaluate provider runtime bytes. Crypto/owner units are required in .native.mts.
const expected: SolanaMintExpectation = { testOnly: true, cluster: "solana-devnet",
  payer: "FR5pWwinRBn35GNhg7bsvw8Q13kRept2pm561DwZCQzT", mint: "4Yk9HoDSfJv9QcmJbLcXdWVgS7nfvdUqiVcvbSu8VBru", rentLamports: "1461600" };

test("finite RPC account guard preserves empty bytes/null/large rent sentinel and rejects malformed JSON rather than asserting its type", () => {
  const raw = { owner: expected.payer, executable: false, lamports: 1, rentEpoch: 18446744073709551616, data: ["", "base64"] };
  assert.deepEqual(parseSolanaRpcAccount(raw), raw); assert.equal(parseSolanaRpcAccount(null), null);
  for (const value of [undefined, [], {}, { ...raw, lamports: 1.5 }, { ...raw, lamports: -1 }, { ...raw, owner: 1 },
    { ...raw, executable: "false" }, { ...raw, data: ["YQ", "base64"] }, { ...raw, data: ["", "base64", "extra"] }, { ...raw, rentEpoch: Infinity }]) { assert.throws(() => parseSolanaRpcAccount(value)); }
});

test("bounded RPC parser reports reader acquisition, read and cancellation failures as uncertain physical ownership", async () => {
  for (const failure of ["locked", "read", "header-cancel", "size-cancel"] as const) {
    let canceled = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (failure === "read") { controller.error(new Error("Producer read failed")); }
        else if (failure === "size-cancel") { controller.enqueue(new Uint8Array(TEST_RPC_RESPONSE_LIMIT + 1)); }
      },
      cancel() { canceled++; throw new Error("Producer cancellation failed"); },
    }), { headers: failure === "header-cancel" ? { "content-length": String(TEST_RPC_RESPONSE_LIMIT + 1) } : {} });
    const borrowedReader = failure === "locked" ? response.body?.getReader() : undefined;
    await assert.rejects(readTestRpcJson(response), UndrainedTestRpcBody);
    assert.equal(canceled, ["locked", "read"].includes(failure) ? 0 : 1);
    borrowedReader?.releaseLock();
    assert.equal(response.body?.locked, false);
  }
});

test("RPC EOF and acknowledged bounded-body cancellation permit cleanup even when JSON or envelopes reject", async () => {
  for (const failure of ["json", "envelope", "length", "size", "http", "redirect"] as const) {
    let destroyed = 0, canceled = 0;
    const lifetime = setupLifetime(async () => {
      const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (failure === "size") { controller.enqueue(new Uint8Array(TEST_RPC_RESPONSE_LIMIT + 1)); }
        else if (!["length", "http", "redirect"].includes(failure)) { controller.enqueue(Buffer.from(failure === "json" ? "{" : '{"jsonrpc":"2.0","id":99,"result":null}')); controller.close(); }
      },
      cancel() { canceled++; },
      }), { status: failure === "http" ? 500 : 200, headers: failure === "length" ? { "content-length": "invalid" } : {} });
      if (failure === "redirect") { Object.defineProperty(response, "redirected", { value: true }); }
      return response;
    });
    await assert.rejects(lifetime.fetcher("https://api.devnet.solana.com", { method: "POST",
      body: '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' }));
    const close = lifetime.close(async () => { destroyed++; });
    assert.equal(lifetime.close(async () => { destroyed++; }), close); await close;
    assert.equal(destroyed, 1, failure); assert.equal(canceled, ["length", "size", "http", "redirect"].includes(failure) ? 1 : 0);
  }
});

// Never invoked. Removing an enforced restriction makes an expect-error unused and the strict compiler fail.
function declarationContracts(sdk: UnsignedMintSdk, borrowed: RegistrationPredecessorVerifier,
  predecessor: Parameters<typeof verifyPoolConfigPredecessor>, prepared: PreparedTransaction,
  selections: { explicit: ExplicitTestSdkSelection; unrefined: TestSdkSelection }) {
  const { explicit, unrefined } = selections;
  createSolanaRegistrationRpc(() => "", borrowed);
  verifyPoolConfigPredecessor(predecessor[0], predecessor[1], { ...predecessor[2], registrationSdk: borrowed });
  // @ts-expect-error unsigned SDK has no signing authority
  sdk.sign(prepared, expected, { testOnly: true, payerFile: "never" });
  // @ts-expect-error borrowed inspector has no disposer
  borrowed.destroy();
  // @ts-expect-error borrowed inspector has no signer acquisition
  borrowed.acquireSigner({ testOnly: true, payerFile: "never" });
  // @ts-expect-error mint Host requires both key references
  createMintOperatorIO({ testOnly: true, payerFile: "never" }, fetch);
  // @ts-expect-error a JSON value cannot be a transport function
  createPoolInitOperatorIO({ testOnly: true, payerFile: "never" }, "fetch");
  // @ts-expect-error base-unit amounts never use JS number
  const wrongAmount: SolanaMintExpectation = { ...expected, rentLamports: 1461600 };
  // @ts-expect-error selectors remain decimal strings
  const wrongSelector: ExplicitTestSdkSelection = { ...explicit, fixture: { ...explicit.fixture, forwardSelector: 16000000000000000 } };
  // @ts-expect-error saved authenticated validity remains a string
  const wrongValidity: SignedSolanaTransaction = { bytesBase64: "", signature: "", blockhash: "", lastValidBlockHeight: 150 };
  // @ts-expect-error result status is the checked application outcome, never a journal phase
  const wrongResult: MintResult = { status: "signed", reason: "", signature: "" };
  createSolanaMintSdk("never", explicit).then(view => {
    // @ts-expect-error actual TEST overload is unsigned
    view.sign(prepared, expected, { testOnly: true, payerFile: "never" });
    // @ts-expect-error provider constructors do not escape
    view.Keypair.fromSecretKey(new Uint8Array(64));
    // @ts-expect-error no raw provider on worker view
    const hiddenProvider = view.native;
    return hiddenProvider;
  });
  createSolanaMintSdk("never", unrefined).then(view => {
    // @ts-expect-error an unrefined profile cannot be cast to a legacy signer
    view.sign(prepared, expected, { testOnly: true, payerFile: "never", mintFile: "never" });
    return null;
  });
  createSolanaMintOperatorAttempt("never", explicit).then(attempt => {
    // @ts-expect-error trusted attempt is not a second owning disposer
    attempt.destroy();
    // @ts-expect-error both mint keys are mandatory at private acquisition
    attempt.acquireSigner({ testOnly: true, payerFile: "never" });
    return null;
  });
  const { derive, inspectSigned, snapshotAddresses, decodeRegistry, verifySnapshot } = borrowed;
  // @ts-expect-error derive is mandatory
  const a: RegistrationPredecessorVerifier = { inspectSigned, snapshotAddresses, decodeRegistry, verifySnapshot };
  // @ts-expect-error inspectSigned is mandatory
  const b: RegistrationPredecessorVerifier = { derive, snapshotAddresses, decodeRegistry, verifySnapshot };
  // @ts-expect-error snapshotAddresses is mandatory
  const c: RegistrationPredecessorVerifier = { derive, inspectSigned, decodeRegistry, verifySnapshot };
  // @ts-expect-error decodeRegistry is mandatory
  const d: RegistrationPredecessorVerifier = { derive, inspectSigned, snapshotAddresses, verifySnapshot };
  // @ts-expect-error verifySnapshot is mandatory
  const e: RegistrationPredecessorVerifier = { derive, inspectSigned, snapshotAddresses, decodeRegistry };
  // @ts-expect-error excess signing authority is rejected on the public borrowed contract
  const f: RegistrationPredecessorVerifier = { ...borrowed, sign: async () => null };
  return [a, b, c, d, e, f, wrongAmount, wrongSelector, wrongValidity, wrongResult];
}
void declarationContracts;
