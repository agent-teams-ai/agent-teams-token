import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createTestMint } from "../src/composition/create-solana-mint.mjs";
import { initializeTestPool } from "../src/composition/initialize-solana-pool.mjs";
import { registerTestSolanaPool } from "../src/composition/register-solana-pool.mjs";
import { configureTestSolanaPool } from "../src/composition/configure-solana-pool.mjs";
import { createMintSdk, type UnsignedMintSdk } from "../src/adapters/solana-sdk.mjs";
import { createPoolInitSdk, type UnsignedPoolInitSdk } from "../src/adapters/solana-pool-init-sdk.mjs";
import { createRegistrationSdk, type UnsignedRegistrationSdk } from "../src/adapters/solana-registration-sdk.mjs";
import { createPoolConfigSdk, createRegistrationInspector, type UnsignedPoolConfigSdk } from "../src/adapters/solana-pool-config-sdk.mjs";
import { TEST_SDK_PROFILE } from "../src/adapters/test-sdk-policy.ts";
import { createSdkTestFetch, DEFAULT_SOLANA_RPC, UndrainedTestRpcBody } from "../src/adapters/test-rpc.ts";
import { replacementFixture, fixtureNamespace } from "../src/domain/replacement-fixture.ts";
import { setupObject } from "../src/composition/solana-setup-operator.ts";
import type { MintSettings, InitSettings, RegistrationSettings, ConfigSettings } from "../src/composition/solana-setup-operator.ts";
import type { InspectedSetup } from "../src/adapters/solana-setup-operator.ts";
import type { PreparedTransaction } from "../src/adapters/solana-transaction-sdk.mjs";
import type { SignedSolanaTransaction } from "../src/application/solana-transaction-journal.ts";
import type { SolanaMintEnvelope } from "../src/domain/solana-mint.ts";
import type { SolanaPoolInitEnvelope } from "../src/domain/solana-pool-init.ts";
import type { SolanaRegistrationEnvelope } from "../src/domain/solana-registration.ts";
import type { SolanaPoolConfigEnvelope } from "../src/domain/solana-pool-config.ts";
import type { NativeSolanaProvider } from "../src/adapters/test-sdk-admission.ts";

// Required offline native qualification; run directly with absolute supplier and archive paths.
// Uses the existing TEST profile's complete-byte admission. Controlled units are not public settlement evidence.
import { admitTestSdk } from "../src/adapters/test-sdk-admission.ts";
const [supplier, archives, ...trailingArguments] = process.argv.slice(2);
if (!supplier || !archives || trailingArguments.length) { throw new Error("Require explicit complete public supplier and archive paths"); }
admitTestSdk({ root: supplier, archives });
await import("./solana-setup-wiring.test.ts");
globalThis.fetch = () => { throw new Error("Network forbidden in controlled setup native units"); };
const require = createRequire(resolve(supplier, "package.json"));
const web3: typeof import("../../../.local/INPUT/provider/node_modules/@solana/web3.js/lib/index.js") = require("@solana/web3.js");
const spl: typeof import("../../../.local/INPUT/provider/node_modules/@solana/spl-token/lib/types/index.js") = require("@solana/spl-token");
const bs58: typeof import("../../../.local/INPUT/provider/node_modules/bs58/src/cjs/index.js").default = require("bs58").default;
const native: NativeSolanaProvider = { web3, spl, bs58 };
const fixture = replacementFixture("0x812c4dcbc459a55f8517e87e825b8c728cee7316", "0x8472aa06661671e7e4af43048f0d0446eff2e97d");
const selection = { testOnly: true, providerProfile: TEST_SDK_PROFILE, fixture, fixtureIdentity: fixture.identity,
  providerDirectory: resolve(".local/INPUT/provider"), providerArchives: resolve(".local/INPUT/archives") } as const;
const expected = { testOnly: true, cluster: "solana-devnet", payer: fixture.payer, mint: fixture.mint } as const;
const poolExpected = { ...expected, pool: fixture.solanaPool, fixture };
const latest = { blockhash: fixture.payer, lastValidBlockHeight: "150" };
const signature = "3".repeat(88), previousSignature = "2".repeat(88);
const packet = Buffer.from("controlled-public-journal-port").toString("base64"), priorPacket = Buffer.from("controlled-public-predecessor-port").toString("base64");
type Mode = "expired" | "unknown" | "nonfinal" | "not-found" | "success" | "failure";
async function disposable() {
  const root = resolve(".local/setup-operator/units", fixtureNamespace(fixture)); await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, "caller-"));
}

function isPriorRead(params: unknown): boolean {
  return Array.isArray(params) && (params[0] === previousSignature || Array.isArray(params[0]) && params[0][0] === previousSignature);
}
function controlledAccount(params: unknown, mode: Mode): unknown {
  const address = Array.isArray(params) ? params[0] : null;
  if (address === fixture.solanaPool && mode !== "success") { return { context: { slot: 11 }, value: null }; }
  if (address === fixture.mint) {
    const jsonParsed = Array.isArray(params) && setupObject(params[1]).encoding === "jsonParsed";
    return { context: { slot: 11 }, value: jsonParsed ? { owner: spl.TOKEN_PROGRAM_ID.toBase58(), executable: false,
      data: { program: "spl-token", space: 82, parsed: { type: "mint", info: { isInitialized: true, decimals: 9, supply: "0", mintAuthority: fixture.payer, freezeAuthority: null } } } } : null };
  }
  return { context: { slot: 11 }, value: { owner: BURNMINT_PROGRAM, executable: false, data: ["cHVibGlj", "base64"] } };
}
function publicOutcome(prior: boolean, mode: Mode) { return mode === "failure" && !prior ? { InstructionError: [0, "Synthetic"] } : null; }
function hasPacket(prior: boolean, mode: Mode) { return prior || ["success", "failure", "nonfinal"].includes(mode); }
function controlledTransaction(prior: boolean, mode: Mode) {
  return hasPacket(prior, mode) ? { slot: 10, transaction: [prior ? priorPacket : packet, "base64"], meta: { err: publicOutcome(prior, mode) } } : null;
}
function controlledStatus(prior: boolean, mode: Mode) {
  return hasPacket(prior, mode) ? { slot: 10, confirmationStatus: mode === "nonfinal" && !prior ? "confirmed" : "finalized", err: publicOutcome(prior, mode) } : null;
}

/** Honest narrow journal port doubles around actual native builds. Synthetic inspection is unit evidence only. */
function controlled() {
  const mintCore = createMintSdk(native), poolCore = createPoolInitSdk(native), registrationCore = createRegistrationSdk(native, poolCore), configCore = createPoolConfigSdk(native, registrationCore, poolCore);
  const counts = { open: 0, build: 0, sign: 0, inspect: 0, predecessor: 0, destroy: 0, methods: [] as string[], before: 0 };
  let closed = false, mode: Mode = "expired";
  let mintDecoded: InspectedSetup<SolanaMintEnvelope> | undefined, poolDecoded: InspectedSetup<SolanaPoolInitEnvelope> | undefined;
  let registrationDecoded: InspectedSetup<SolanaRegistrationEnvelope> | undefined, configDecoded: InspectedSetup<SolanaPoolConfigEnvelope> | undefined;
  const prior = registrationCore.build(registrationCore.derive({ ...poolExpected, operation: "transfer-mint-authority" }), latest);
  function guard() { assert.equal(closed, false); }
  function inspect<R>(bytes: string, decoded: InspectedSetup<R> | undefined): InspectedSetup<R> {
    guard(); counts.inspect++; assert.equal(bytes, packet); assert.ok(decoded); return decoded;
  }
  const destroy = async () => { counts.destroy++; closed = true; };
  const mintSdk: UnsignedMintSdk = { build(e, block) { guard(); counts.build++; const p = mintCore.build(e, block); mintDecoded = { ...p, signature }; return p; }, inspectSigned: bytes => inspect(bytes, mintDecoded), destroy };
  const poolSdk: UnsignedPoolInitSdk = { build(e, block) { guard(); counts.build++; const p = poolCore.build(e, block); poolDecoded = { ...p, signature }; return p; }, inspectSigned: bytes => inspect(bytes, poolDecoded),
    verifyState: (_bytes, e) => ({ address: e.pool, mint: e.mint, owner: e.payer, verified: true }), verifyGlobal: () => {}, destroy };
  const borrowed = createRegistrationInspector({ ...registrationCore,
    inspectSigned(bytes, e) { guard(); counts.predecessor++; assert.equal(bytes, priorPacket); assert.equal(e.operation, "transfer-mint-authority"); return { ...prior, signature: previousSignature }; },
    verifySnapshot: (_values, e) => ({ operation: e.operation, mint: e.mint, verified: true }),
  }, guard);
  const registrationSdk: UnsignedRegistrationSdk = { ...borrowed, derive: registrationCore.derive,
    build(e, block) { guard(); counts.build++; const p = registrationCore.build(e, block); registrationDecoded = { ...p, signature }; return p; },
    inspectSigned: bytes => inspect(bytes, registrationDecoded), destroy };
  const configSdk: UnsignedPoolConfigSdk = { derive: configCore.derive, snapshotAddresses: configCore.snapshotAddresses,
    verifySnapshot(_values, e, phase) { guard(); if (phase === "before") { counts.before++; } return { operation: e.operation, mint: e.mint, verified: true }; },
    build(e, block) { guard(); counts.build++; const p = configCore.build(e, block); configDecoded = { ...p, signature }; return p; },
    inspectSigned: bytes => inspect(bytes, configDecoded), registrationVerifier: borrowed, destroy };
  const signedFor = (p: PreparedTransaction): SignedSolanaTransaction => ({ bytesBase64: packet, signature, blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight });
  const signPrepared = async (p: PreparedTransaction) => { guard(); counts.sign++; assert.ok(Object.isFrozen(p)); return signedFor(p); };
  const fetcher: typeof fetch = async (_input, init) => {
    guard(); const request = setupObject(JSON.parse(String(init?.body)) as unknown), method = String(request.method), params = request.params;
    counts.methods.push(method); assert.ok(init?.signal); assert.equal(init.redirect, "error");
    if (method === "sendTransaction") { throw new Error("UNIT SEND SENTINEL: no broadcast permitted"); }
    let result: unknown;
    const priorRead = isPriorRead(params);
    switch (method) {
      case "getGenesisHash": result = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"; break;
      case "getLatestBlockhash": result = { context: { slot: 11 }, value: { blockhash: latest.blockhash, lastValidBlockHeight: 150 } }; break;
      case "getMinimumBalanceForRentExemption": result = 1461600; break;
      case "getBalance": result = { context: { slot: 11 }, value: 10000000 }; break;
      case "getAccountInfo": result = controlledAccount(params, mode); break;
      case "getMultipleAccounts": result = { context: { slot: 11 }, value: Array.isArray(params) && Array.isArray(params[0]) ? params[0].map(() => null) : [] }; break;
      case "getTransaction": result = controlledTransaction(priorRead, mode); break;
      case "getSignatureStatuses": result = { value: [controlledStatus(priorRead, mode)] }; break;
      case "getBlockHeight": result = mode === "expired" ? 151 : 100; break;
      case "isBlockhashValid": result = { context: { slot: 11 }, value: mode !== "expired" }; break;
      default: throw new Error("Unexpected controlled RPC");
    }
    if (mode === "unknown" && !priorRead && method === "getTransaction") { throw new Error("private path/settings must be redacted"); }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  };
  return { mintSdk, poolSdk, registrationSdk, configSdk, counts, fetcher, signPrepared, signedFor, prior,
    setMode(value: Mode) { mode = value; }, reset() { counts.build = counts.sign = counts.inspect = counts.predecessor = 0; counts.methods.length = 0; } };
}
import { BURNMINT_PROGRAM } from "../src/domain/solana-pool-init.ts";
const cases = [
  { name: "mint", file: "mint.json", schema: "agtmai-solana-mint-journal-v1",
    settings: (directory: string): MintSettings => ({ ...selection, expected: { ...expected, rentLamports: "1461600" }, journalFile: join(directory, "mint.json") }),
    run: (directory: string, h: ReturnType<typeof controlled>, recovery = false) => createTestMint({ ...selection, expected: { ...expected, rentLamports: "1461600" }, journalFile: join(directory, "mint.json") }, {
      fetcher: h.fetcher, openSdk: async () => { h.counts.open++; return h.mintSdk; }, ...(recovery ? {} : { signPrepared: h.signPrepared }) }),
    prepare: (h: ReturnType<typeof controlled>) => h.mintSdk.build({ ...expected, rentLamports: "1461600" }, latest),
  },
  { name: "init", file: "init.json", schema: "agtmai-solana-pool-init-journal-v1",
    settings: (directory: string): InitSettings => ({ ...selection, expected: poolExpected, journalFile: join(directory, "init.json") }),
    run: (directory: string, h: ReturnType<typeof controlled>, recovery = false) => initializeTestPool({ ...selection, expected: poolExpected, journalFile: join(directory, "init.json") }, {
      fetcher: h.fetcher, openSdk: async () => { h.counts.open++; return h.poolSdk; }, ...(recovery ? {} : { signPrepared: h.signPrepared }) }),
    prepare: (h: ReturnType<typeof controlled>) => h.poolSdk.build(poolExpected, latest),
  },
  { name: "registration", file: "create-token-account.json", schema: "agtmai-solana-registration-journal-v1",
    settings: (directory: string): RegistrationSettings => ({ ...selection, expected: { ...poolExpected, operation: "create-token-account" }, journalDirectory: directory }),
    run: (directory: string, h: ReturnType<typeof controlled>, recovery = false) => registerTestSolanaPool({ ...selection, expected: { ...poolExpected, operation: "create-token-account" }, journalDirectory: directory }, {
      fetcher: h.fetcher, openSdk: async () => { h.counts.open++; return h.registrationSdk; }, ...(recovery ? {} : { signPrepared: h.signPrepared }) }),
    prepare: (h: ReturnType<typeof controlled>) => h.registrationSdk.build(h.registrationSdk.derive({ ...poolExpected, operation: "create-token-account" }), latest),
  },
  { name: "config", file: "init-chain-remote-config.json", schema: "agtmai-solana-pool-config-journal-v1",
    settings: (directory: string): ConfigSettings => ({ ...selection, expected: { ...poolExpected, operation: "init-chain-remote-config" }, journalDirectory: directory, registrationJournalFile: join(directory, "transfer-mint-authority.json") }),
    run: (directory: string, h: ReturnType<typeof controlled>, recovery = false) => configureTestSolanaPool({ ...selection, expected: { ...poolExpected, operation: "init-chain-remote-config" }, journalDirectory: directory, registrationJournalFile: join(directory, "transfer-mint-authority.json") }, {
      fetcher: h.fetcher, openSdk: async () => { h.counts.open++; return h.configSdk; }, ...(recovery ? {} : { signPrepared: h.signPrepared }) }),
    prepare: (h: ReturnType<typeof controlled>) => h.configSdk.build(h.configSdk.derive({ ...poolExpected, operation: "init-chain-remote-config" }), latest),
  },
] as const;
for (const entry of cases) {
  test(`${entry.name} actual caller: one unsigned owner, explicit transport, separate callback and independent durable reinspection`, async () => {
    const directory = await disposable(), h = controlled();
    try {
      if (entry.name === "config") { await writeFile(join(directory, "transfer-mint-authority.json"), JSON.stringify({ schema: "agtmai-solana-registration-journal-v1", phase: "succeeded", intent: h.prior.envelope, messageBase64: h.prior.messageBase64, signed: { bytesBase64: priorPacket, signature: previousSignature, ...latest } }), { mode: 0o600 }); }
      const result = await entry.run(directory, h), saved = setupObject(JSON.parse(await readFile(join(directory, entry.file), "utf8")) as unknown);
      assert.equal(result.status, "unresolved"); assert.equal(saved.phase, "signed"); assert.equal(h.counts.open, 1); assert.equal(h.counts.build, 1); assert.equal(h.counts.sign, 1); assert.ok(h.counts.inspect >= 2);
      assert.equal(h.counts.destroy, 1); assert.ok(h.counts.methods.includes("getLatestBlockhash")); assert.ok(!h.counts.methods.includes("sendTransaction"));
      if (entry.name === "config") { assert.ok(h.counts.predecessor >= 2); assert.ok(h.counts.before >= 1); }
      assert.ok(!JSON.stringify(result).includes("File"));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test(`${entry.name} every saved phase observes exact bytes with zero build/sign/fresh quote or resend`, async () => {
    for (const phase of ["signed", "submitting", "submitted", "succeeded", "failed"] as const) {
      for (const mode of ["unknown", "nonfinal", "expired", "success", "failure", ...(phase === "signed" ? [] : ["not-found" as const])] as const) {
        const directory = await disposable(), h = controlled();
        try {
          const p = entry.prepare(h); await writeFile(join(directory, entry.file), JSON.stringify({ schema: entry.schema, phase, intent: p.envelope, messageBase64: p.messageBase64, signed: h.signedFor(p) }), { mode: 0o600 });
          h.reset(); h.setMode(mode); const result = await entry.run(directory, h, true);
          const wanted = mode === "success" && phase !== "failed" ? "succeeded" : mode === "failure" && phase !== "succeeded" ? "failed" : "unresolved";
          assert.equal(result.status, wanted, `${entry.name}/${phase}/${mode}`);
          assert.equal(h.counts.open, 1); assert.equal(h.counts.build, 0); assert.equal(h.counts.sign, 0); assert.equal(h.counts.predecessor, 0); assert.equal(h.counts.destroy, 1);
          for (const forbidden of ["getLatestBlockhash", "getMinimumBalanceForRentExemption", "getBalance", "sendTransaction"]) { assert.ok(!h.counts.methods.includes(forbidden), `${entry.name}/${phase}/${mode}/${forbidden}`); }
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  });
}

test("a saved signed first-submission is separately intercepted only after durable submitting, with no signer/build/quote", async () => {
  for (const entry of cases) {
    const directory = await disposable(), h = controlled();
    try {
      const p = entry.prepare(h), path = join(directory, entry.file);
      await writeFile(path, JSON.stringify({ schema: entry.schema, phase: "signed", intent: p.envelope, messageBase64: p.messageBase64, signed: h.signedFor(p) }), { mode: 0o600 });
      h.reset(); h.setMode("not-found"); const readOnly = h.fetcher; let attempted = 0;
      h.fetcher = async (input, init) => {
        const request = setupObject(JSON.parse(String(init?.body)) as unknown);
        if (request.method === "sendTransaction") {
          const saved = setupObject(JSON.parse(await readFile(path, "utf8")) as unknown); assert.equal(saved.phase, "submitting");
          assert.deepEqual(saved.signed, h.signedFor(p)); attempted++; throw new Error("Intercepted UNIT first-submission; no network operation");
        }
        return readOnly(input, init);
      };
      const result = await entry.run(directory, h, true); assert.equal(result.status, "unresolved"); assert.equal(attempted, 1);
      assert.equal(h.counts.build, 0); assert.equal(h.counts.sign, 0); assert.equal(h.counts.destroy, 1);
      assert.ok(!h.counts.methods.includes("getLatestBlockhash"));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("actual caller failures at preflight/build/callback/inspection/store/cleanup redact private diagnostics and release exactly one owner", async () => {
  for (const stage of ["preflight", "build", "missing-signer", "sign", "inspect", "write", "cleanup", "primary-and-cleanup", "returned-height", "returned-blockhash"] as const) {
    const directory = await disposable(), h = controlled(), path = join(directory, "mint.json");
    try {
      const privateDiagnostic = "/private/key-material settings sentinel";
      if (stage === "preflight" || stage === "primary-and-cleanup") { h.fetcher = async () => { throw new Error(privateDiagnostic); }; }
      if (stage === "build") { h.mintSdk.build = () => { throw new Error(privateDiagnostic); }; }
      if (stage === "sign") { h.signPrepared = async () => { throw new Error(privateDiagnostic); }; }
      if (stage === "inspect") { h.mintSdk.inspectSigned = () => { throw new Error(privateDiagnostic); }; }
      if (stage === "write") { const sign = h.signPrepared; h.signPrepared = async p => { await mkdir(path, { mode: 0o700 }); return sign(p); }; }
      if (stage === "cleanup" || stage === "primary-and-cleanup") { h.mintSdk.destroy = async () => { h.counts.destroy++; throw new Error(privateDiagnostic); }; }
      if (stage === "returned-height" || stage === "returned-blockhash") { const sign = h.signPrepared; h.signPrepared = async p => ({ ...await sign(p), ...(stage === "returned-height" ? { lastValidBlockHeight: "151" } : { blockhash: fixture.mint }) }); }
      await assert.rejects(cases[0].run(directory, h, stage === "missing-signer"), error => {
        assert.ok(error instanceof Error); assert.ok(!error.message.includes("private")); assert.ok(!error.message.includes("sentinel"));
        if (stage === "missing-signer") { assert.match(error.message, /operator signer required/); }
        if (stage.includes("cleanup")) { assert.match(error.message, /cleanup debt/); }
        return true;
      });
      assert.equal(h.counts.destroy, 1); assert.ok(!h.counts.methods.includes("sendTransaction"));
      if (!["write", "cleanup"].includes(stage)) { await assert.rejects(access(path)); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("a timed-out actual caller retains late SDK acquisition and destroys it before failure handoff", async context => {
  const directory = await disposable(), h = controlled();
  try {
    let complete!: (sdk: UnsignedMintSdk) => void;
    const opening = new Promise<UnsignedMintSdk>(_resolve => { complete = _resolve; });
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const operation = createTestMint(cases[0].settings(directory), { fetcher: h.fetcher,
      openSdk: async () => { h.counts.open++; return opening; } });
    const rejected = assert.rejects(operation, /provider unavailable/);
    await new Promise<void>(_resolve => { setImmediate(_resolve); });
    context.mock.timers.tick(20_000); await new Promise<void>(_resolve => { setImmediate(_resolve); });
    assert.equal(h.counts.destroy, 0); complete(h.mintSdk); await rejected;
    assert.equal(h.counts.open, 1); assert.equal(h.counts.destroy, 1); assert.equal(h.counts.build, 0); assert.equal(h.counts.sign, 0);
    assert.equal(h.counts.methods.length, 0);
  } finally { context.mock.timers.reset(); await rm(directory, { recursive: true, force: true }); }
});

test("the actual caller freezes its public identity and owned journal path across the Host await", async () => {
  const directory = await disposable(), h = controlled();
  try {
    const settings = { ...selection, expected: { ...expected, rentLamports: "1461600" }, journalFile: join(directory, "mint.json") };
    const result = createTestMint(settings, { fetcher: h.fetcher, openSdk: async () => h.mintSdk, signPrepared: h.signPrepared });
    settings.expected.payer = fixture.mint; settings.journalFile = join(directory, "different.json");
    assert.equal((await result).status, "unresolved"); assert.equal(h.counts.sign, 1); assert.equal(h.counts.destroy, 1);
    const record = setupObject(JSON.parse(await readFile(join(directory, "mint.json"), "utf8")) as unknown);
    assert.equal(setupObject(record.intent).payer, fixture.payer); await assert.rejects(access(settings.journalFile));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("derive and borrowed predecessor failures stop the successor before preparation/sign and still close the configuration owner", async () => {
  for (const stage of ["derive", "missing", "message", "signature", "nonfinal", "unknown"] as const) {
    const directory = await disposable(), h = controlled();
    try {
      if (stage === "derive") { h.configSdk.derive = () => { throw new Error("/private/settings diagnostic"); }; }
      if (!["missing", "derive"].includes(stage)) {
        await writeFile(join(directory, "transfer-mint-authority.json"), JSON.stringify({ schema: "agtmai-solana-registration-journal-v1", phase: "succeeded", intent: h.prior.envelope,
          messageBase64: stage === "message" ? "dGFtcGVy" : h.prior.messageBase64,
          signed: { bytesBase64: priorPacket, signature: stage === "signature" ? "4".repeat(88) : previousSignature, ...latest } }), { mode: 0o600 });
      }
      if (stage === "nonfinal" || stage === "unknown") {
        const original = h.fetcher;
        h.fetcher = async (input, init) => {
          const request = setupObject(JSON.parse(String(init?.body)) as unknown);
          if (stage === "unknown" && request.method === "getTransaction") { throw new Error("unavailable"); }
          if (stage === "nonfinal" && request.method === "getSignatureStatuses") { return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { value: [{ slot: 10, confirmationStatus: "confirmed", err: null }] } })); }
          return original(input, init);
        };
      }
      await assert.rejects(cases[3].run(directory, h), /TEST setup failed/);
      assert.equal(h.counts.build, 0); assert.equal(h.counts.sign, 0); assert.equal(h.counts.destroy, 1);
      assert.ok(!h.counts.methods.includes("getLatestBlockhash")); assert.ok(!h.counts.methods.includes("sendTransaction"));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

// Actual compositions and parser, with controlled signing/acquisition ports. No wallet signing.
for (const stage of ["mint-sign", "config-sign", "mint-acquire"] as const) {
  for (const mode of ["eof", "cancel", "read-error", "cancel-error"] as const) {
    test(`${stage} owned port retains explicit physical debt: ${mode}`, async () => {
      const directory = await disposable(), h = controlled();
      const entered = Promise.withResolvers<void>(), failure = Promise.withResolvers<void>(),
        physical = Promise.withResolvers<void>(), settled = Promise.withResolvers<void>();
      const uncertain = mode === "read-error" || mode === "cancel-error";
      let active = false, cancels = 0, portCalls = 0, markerObserved = false;
      const transport = createSdkTestFetch(DEFAULT_SOLANA_RPC, async () => new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          active = true; entered.resolve();
          if (mode === "eof" || mode === "read-error") {
            await failure.promise;
            if (mode === "read-error") { controller.error(new Error("/private/sign-port read failed")); }
          }
          await physical.promise; active = false;
          if (mode === "eof") { controller.enqueue(Buffer.from("{")); controller.close(); }
          settled.resolve();
        },
        async cancel() {
          cancels++; await failure.promise;
          if (mode === "cancel-error") { throw new Error("/private/sign-port cancel failed"); }
          await physical.promise; active = false;
        },
      }), { status: mode === "cancel" || mode === "cancel-error" ? 500 : 200 }));
      const rejectPort = async (): Promise<never> => {
        portCalls++;
        try {
          await transport(DEFAULT_SOLANA_RPC, { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' });
        } catch (error) {
          markerObserved = error instanceof UndrainedTestRpcBody;
          // A failed materializer owns resources before it can return its SDK.
          if (stage === "mint-acquire" && !markerObserved) { await h.mintSdk.destroy(); }
          throw error;
        }
        return assert.fail("No signature, acquired SDK or success handoff permitted");
      };
      const predecessorFile = join(directory, "transfer-mint-authority.json"), predecessor = JSON.stringify({ schema: "agtmai-solana-registration-journal-v1", phase: "succeeded",
        intent: h.prior.envelope, messageBase64: h.prior.messageBase64,
        signed: { bytesBase64: priorPacket, signature: previousSignature, ...latest } });
      if (stage === "config-sign") { await writeFile(predecessorFile, predecessor, { mode: 0o600 }); }
      h.signPrepared = rejectPort;
      const operation = stage === "config-sign" ? cases[3].run(directory, h) : stage === "mint-acquire" ?
        createTestMint(cases[0].settings(directory), { fetcher: h.fetcher, openSdk: rejectPort,
          signPrepared: async () => assert.fail("Acquisition failed before signing") }) : cases[0].run(directory, h);
      const outcome = operation.then(() => assert.fail("No success handoff permitted"), error => { assert.ok(error instanceof Error); return error.message; });
      const borrowed = h.configSdk.registrationVerifier;
      const priorExpected = borrowed.derive({ ...poolExpected, operation: "transfer-mint-authority" });
      try {
        await Promise.race([entered.promise, outcome.then(label => assert.fail(`Stopped before owned port: ${label}`))]);
        assert.equal(active, true); assert.equal(h.counts.destroy, 0); assert.equal(portCalls, 1);
        if (stage === "config-sign") { assert.ok(h.counts.predecessor >= 2); }
        failure.resolve();
        if (!uncertain) {
          // Logical rejection must await the producer's EOF or successful cancellation.
          await new Promise<void>(_resolve => { setImmediate(_resolve); });
          assert.equal(active, true); assert.equal(h.counts.destroy, 0); physical.resolve();
        }
        const label = await outcome, primary = stage === "mint-acquire" ? "TEST setup provider unavailable" : "TEST setup failed";
        assert.equal(label, primary + (uncertain ? "; unresolved cleanup debt" : ""));
        assert.equal(markerObserved, uncertain); assert.equal(active, uncertain);
        assert.equal(cancels, mode === "cancel" || mode === "cancel-error" ? 1 : 0);
        assert.equal(h.counts.destroy, uncertain ? 0 : 1);
        assert.equal(h.counts.build, stage === "mint-acquire" ? 0 : 1); assert.equal(h.counts.sign, 0);
        assert.ok(!h.counts.methods.includes("sendTransaction"));
        await assert.rejects(access(join(directory, stage === "config-sign" ? "init-chain-remote-config.json" : "mint.json")));
        if (stage === "config-sign") {
          assert.equal(await readFile(predecessorFile, "utf8"), predecessor);
          if (uncertain) {
            assert.equal(borrowed.derive(priorExpected).operation, "transfer-mint-authority");
            assert.equal(borrowed.snapshotAddresses(priorExpected).length, 6);
            assert.equal(borrowed.inspectSigned(priorPacket, priorExpected).signature, previousSignature);
            assert.equal(borrowed.verifySnapshot([], priorExpected, "after").verified, true);
          } else {
            for (const use of [() => borrowed.derive(priorExpected), () => borrowed.snapshotAddresses(priorExpected),
              () => borrowed.inspectSigned(priorPacket, priorExpected), () => borrowed.decodeRegistry(null),
              () => borrowed.verifySnapshot([], priorExpected, "after")]) { assert.throws(use); }
          }
        }
        physical.resolve(); await settled.promise;
        await new Promise<void>(_resolve => { setImmediate(_resolve); });
        assert.equal(active, false); assert.equal(h.counts.destroy, uncertain ? 0 : 1,
          "Unacknowledged producer settlement cannot clear latched debt or repeat destruction");
      } finally {
        failure.resolve(); physical.resolve(); if (active) { await settled.promise; } await outcome;
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

// Actual caller, bounded parser and close path. A rejected read/cancel is not physical completion.
for (const mutation of ["settled-body", "abort-read", "read-error", "cancel-error", "wrapped-abort-read", "wrapped-cancel-error"] as const) {
  test(`actual mint caller retains physical ownership: ${mutation}`, async context => {
    const directory = await disposable();
    let release!: () => void, enter!: () => void, failRead!: () => void;
    const physical = new Promise<void>(_resolve => { release = _resolve; });
    const entered = new Promise<void>(_resolve => { enter = _resolve; });
    const readFailure = new Promise<void>(_resolve => { failRead = _resolve; });
    let active = false, destroyed = 0, reads = 0, cancels = 0, closedWhileActive = false, opened = 0;
    const core = createMintSdk(native);
    const sdk: UnsignedMintSdk = { build: () => assert.fail("No build allowed"), inspectSigned: core.inspectSigned,
      destroy: async () => { destroyed++; closedWhileActive = active; } };
    const rawFetch: typeof fetch = async (_input, init) => {
      if (++reads > 1) { throw new Error("Stop settled control before effects"); }
      const request = setupObject(JSON.parse(String(init?.body)) as unknown);
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          active = true; enter();
          init?.signal?.addEventListener("abort", () => controller.error(new Error("Logical read abort")), { once: true });
          if (mutation === "read-error") { await readFailure; controller.error(new Error("Logical read failure")); }
          await physical; active = false;
          if (mutation === "settled-body") {
            controller.enqueue(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id,
              result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" })));
            controller.close();
          }
        },
        async cancel() { cancels++; throw new Error("Logical cancellation failure"); },
      }), { status: mutation.endsWith("cancel-error") ? 500 : 200 });
    };
    const fetcher = mutation.startsWith("wrapped-") ? createSdkTestFetch(DEFAULT_SOLANA_RPC, rawFetch) : rawFetch;
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const operation = createTestMint(cases[0].settings(directory), { fetcher, openSdk: async () => { opened++; return sdk; },
      signPrepared: async () => assert.fail("No signer acquisition allowed") });
    const outcome = operation.then(() => assert.fail("No success handoff allowed"), error => {
      assert.ok(error instanceof Error); return error.message;
    });
    try {
      await Promise.race([entered, outcome.then(label => assert.fail(`Stopped before body: ${label}`))]);
      assert.equal(active, true); assert.equal(destroyed, 0); assert.equal(opened, 1);
      if (mutation === "settled-body") {
        release(); await outcome;
        assert.equal(active, false); assert.equal(destroyed, 1); assert.equal(closedWhileActive, false);
      } else {
        if (mutation.endsWith("abort-read")) { context.mock.timers.tick(20_000); }
        if (mutation === "read-error") { failRead(); }
        for (let i = 0; i < 5; i++) { await new Promise<void>(_resolve => { setImmediate(_resolve); }); }
        assert.equal(active, true); assert.equal(destroyed, 0, "Physical producer still held despite rejected read/cancel");
        assert.match(await outcome, /cleanup debt/); assert.equal(cancels, mutation.endsWith("cancel-error") ? 1 : 0);
        release(); await new Promise<void>(_resolve => { setImmediate(_resolve); });
        assert.equal(active, false); assert.equal(destroyed, 0, "Unacknowledged producer release cannot clear latched debt");
      }
    } finally { failRead(); release(); await outcome; context.mock.timers.reset(); await rm(directory, { recursive: true, force: true }); }
  });
}
