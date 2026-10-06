import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface, AbiCoder } from "../../../.local/INPUT/provider/node_modules/ethers/lib.esm/abi/index.js";
import { transferEvmForward } from "../src/composition/transfer-evm-forward.mjs";
import { createForwardDecoder } from "../src/adapters/evm-forward-sdk.mjs";
import { createJournalFile } from "../src/adapters/evm-journal-file.ts";
import { TEST_SDK_PROFILE, selectTestSdk, type TestSdkSelection } from "../src/adapters/test-sdk-policy.ts";
import { forwardJournalBinding, type BoundForwardJournalRecord } from "../src/adapters/evm-forward-journal.ts";
import { replacementFixture, fixtureNamespace } from "../src/domain/replacement-fixture.ts";
import { solanaPublicKeyBytes } from "../src/domain/solana-mint.ts";
import { forwardRoute, forwardIntent, FORWARD_RECIPIENT_B } from "../src/domain/evm-forward.mjs";
import { solanaRemote, type RemoteSnapshot } from "../src/domain/evm-remote-config.ts";
import { validateSepoliaIntent } from "../src/domain/evm-intent.ts";
import type { EvmJournalRecord, ObservedTransaction } from "../src/application/evm-journal.ts";
import type { ForwardTransaction } from "../src/adapters/test-sdk-forward.ts";
import type { SepoliaExecutionIo } from "../src/composition/execute-sepolia.ts";

// Concrete consumer ports with independent native ABI checking. This is unit evidence, not SDK/native E2E.
type Settings = Parameters<typeof transferEvmForward>[0];
type Ports = NonNullable<Parameters<typeof transferEvmForward>[1]>;
const fixture = replacementFixture("0x" + "11".repeat(20), "0x" + "22".repeat(20));
const route = forwardRoute(fixture);
const offline: typeof fetch = async () => assert.fail("Unit composition must never reach network transport");
const selection: TestSdkSelection = { testOnly: true, providerProfile: TEST_SDK_PROFILE,
  fixture, fixtureIdentity: fixture.identity, providerArchives: "/unopened-archives", replayFetch: offline };
const signer = { testOnly: true as const, executable: "/unused/cast", executableSha256: "a".repeat(64),
  keystore: "/unused/keystore", passwordFile: "/unused/password", gasLimit: "200000", maxFeePerGas: "100", maxPriorityFeePerGas: "1" };
function settings(directory: string): Settings {
  return { ...selection, testOnly: true, providerDirectory: "/unopened-sdk", signer,
    approvalJournal: join(directory, fixtureNamespace(fixture), "approval.json"),
    sendJournal: join(directory, fixtureNamespace(fixture), "send.json"), approvalNonce: "5", sendNonce: "6" };
}
function send(recipient = fixture.recipient): ForwardTransaction {
  const extra = "0x1f3b3aba" + AbiCoder.defaultAbiCoder().encode(["tuple(uint32,uint64,bool,bytes32,bytes32[])"],
    [[0n, 0n, true, "0x" + solanaPublicKeyBytes(recipient).toString("hex"), []]]).slice(2);
  const data = new Interface(["function ccipSend(uint64,(bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs))"])
    .encodeFunctionData("ccipSend", ["16423721717087811551", ["0x" + "00".repeat(32), "0x", [[fixture.token, "1000000000"]], "0x" + "00".repeat(20), extra]]);
  return { from: fixture.administrator, to: route.router, data, value: 5n };
}
function approval(): ForwardTransaction {
  return { from: fixture.administrator, to: fixture.token, value: 0n,
    data: new Interface(["function approve(address,uint256)"]).encodeFunctionData("approve", [route.router, "1000000000"]) };
}
function snapshot(): RemoteSnapshot {
  const remote = solanaRemote(fixture), rate = { enabled: true, capacity: remote.capacity, rate: remote.rate };
  return { registration: { chainId: "11155111", finalizedBlockHash: "0x" + "bb".repeat(32),
    token: fixture.token, tokenAdmin: fixture.administrator, administrator: fixture.administrator,
    pendingAdministrator: "0x" + "00".repeat(20), tokenPool: fixture.pool, poolToken: fixture.token, poolOwner: fixture.administrator },
    supported: true, pools: [remote.pool], token: remote.token, inbound: rate, outbound: rate };
}
function harness(config: Settings, allowance = route.amount) {
  const events: string[] = [], records = new Map<string, EvmJournalRecord>(), inspected = new Map<string, ObservedTransaction>();
  const wiring: { selection: TestSdkSelection | undefined; snapshotFetch: typeof fetch | undefined; io: SepoliaExecutionIo | undefined } =
    { selection: undefined, snapshotFetch: undefined, io: undefined };
  const ports: Ports = {
    exclusive: async (_path, work) => { events.push("lock"); return work(); },
    sdk: async (directory, recipient, supplied, endpoint, selected) => {
      events.push("sdk");
      assert.equal(directory, config.providerDirectory); assert.equal(supplied?.identity, fixture.identity);
      assert.equal(endpoint, "https://ethereum-sepolia-rpc.publicnode.com");
      wiring.selection = selected;
      const verify = createForwardDecoder({ Interface, AbiCoder }, recipient, supplied);
      return { verify, allowance: async () => { events.push("allowance"); return allowance; },
        prepare: async () => { events.push("prepare"); return { fee: 5n, send: send(recipient), approval: allowance < route.amount ? approval() : null }; },
        destroy: async () => { events.push("destroy"); } };
    },
    snapshot: async (_target, fetcher) => { events.push("snapshot"); wiring.snapshotFetch = fetcher; return snapshot(); },
    read: async path => { events.push("read"); return records.get(path) ?? null; },
    io: { signer: () => ({ sign: async () => assert.fail("No real signing in unit composition"),
      inspectSigned: async bytes => { events.push("inspect"); const tx = inspected.get(bytes); assert.ok(tx); return tx; } }),
      journal: () => assert.fail("Intercepted execution must not acquire custody or a journal") },
    execute: async (intent, execution, io) => {
      events.push("execute:" + intent.nonce);
      wiring.io = io; assert.equal(execution.fixtureIdentity, fixture.identity);
      return { status: "succeeded", reason: "controlled-unit-result", transactionHash: "0x" + "aa".repeat(32) };
    },
  };
  function save(step: "approval" | "send", phase: EvmJournalRecord["phase"] = "submitting"): BoundForwardJournalRecord {
    const tx = step === "approval" ? approval() : send(config.recipient);
    const input = forwardIntent(tx, step === "approval" ? config.approvalNonce : config.sendNonce, route);
    const record: BoundForwardJournalRecord = { schema: "agtmai-evm-journal-v1", intent: validateSepoliaIntent(input, input), phase,
      signed: { bytes: step === "approval" ? "0x0201" : "0x0202", hash: "0x" + (step === "approval" ? "aa" : "cc").repeat(32) },
      forwardBinding: forwardJournalBinding(fixture, "BoiQxGHPgVaqxPn2TjqzmoHPd5toyfxxZ4wW2M7P3gK8", config), forwardStep: step };
    records.set(step === "approval" ? config.approvalJournal : config.sendJournal, record);
    inspected.set(record.signed.bytes, { hash: record.signed.hash, chainId: record.intent.chainId, from: record.intent.from,
      to: record.intent.to, data: record.intent.data, value: record.intent.value, nonce: record.intent.nonce });
    return record;
  }
  return { ports, events, records, inspected, save, wiring };
}

test("TEST directory and own aliases are purely canonical; absence alone keeps legacy selection", () => {
  assert.equal(selectTestSdk({}, "legacy-relative-directory"), undefined);
  assert.deepEqual(selectTestSdk(selection, "/unopened-sdk", fixture), { fixture, archives: "/unopened-archives" });
  for (const directory of ["", "relative", "/unopened-sdk/", "/unopened-sdk/../unopened-sdk", "/unopened-sdk/./x", "/unopened-sdk//x", "/unopened-sdk\0", " /unopened-sdk"]) {
    assert.throws(() => selectTestSdk(selection, directory, fixture), /Canonical/);
  }
  for (const key of ["providerDirectory", "ccipProviderDirectory", "sdkDirectory"]) {
    for (const value of [undefined, null, "", "unknown", false, "/different", "/unopened-sdk/"]) {
      const input = { ...selection }; Object.defineProperty(input, key, { value });
      assert.throws(() => selectTestSdk(input, "/unopened-sdk", fixture), /alias/);
    }
    const input = { ...selection }; Object.defineProperty(input, key, { value: "/unopened-sdk" });
    assert.equal(selectTestSdk(input, "/unopened-sdk", fixture)?.fixture.identity, fixture.identity);
  }
});

test("forward rejects every invalid TEST selection and transport before fixture filesystem IO or lock/provider/effects", async t => {
  const config = settings("/unopened-operation"), mutants: Settings[] = [];
  for (const providerProfile of [undefined, null, "", "unknown", false, {}]) { mutants.push({ ...config, providerProfile }); }
  for (const key of ["providerDirectory", "ccipProviderDirectory", "sdkDirectory", "replayFetch"]) {
    for (const value of [undefined, null, "", "unknown"]) {
      const mutant = { ...config }; Object.defineProperty(mutant, key, { value }); mutants.push(mutant);
    }
  }
  mutants.push({ ...config, fixtureIdentity: "wrong" }, { ...config, providerDirectory: "/unopened-sdk/" });
  let filesystem = 0;
  t.mock.method(fs, "lstatSync", () => { filesystem++; throw new Error("Unexpected operation filesystem IO"); });
  syncBuiltinESMExports();
  try {
    for (const mutant of mutants) {
      const state = harness(mutant);
      await assert.rejects(transferEvmForward(mutant, state.ports), /profile|directory|alias|transport|fixture identity/);
      assert.deepEqual(state.events, []); assert.equal(filesystem, 0);
    }
    const first = { ...config, fixture: { ...fixture, amount: "1" }, providerProfile: "unknown" };
    await assert.rejects(transferEvmForward(first, harness(first).ports), /replacement fixture/);
    assert.equal(filesystem, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("explicit TEST reaches the existing fifth selection argument, snapshot fetch and third executor IO", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-selection-"));
  try {
    for (const allowance of [0n, route.amount]) {
      const config = settings(directory), state = harness(config, allowance);
      const result = await transferEvmForward(config, state.ports);
      assert.equal(result.step, allowance === 0n ? "approval" : "send");
      assert.equal(state.wiring.selection?.providerProfile, TEST_SDK_PROFILE);
      assert.equal(state.wiring.selection.replayFetch, offline);
      assert.equal(state.wiring.snapshotFetch, offline); assert.equal(state.wiring.io?.fetcher, offline);
      assert.equal(state.events.filter(e => e.startsWith("execute:")).join(), allowance === 0n ? "execute:5" : "execute:6");
      assert.equal(state.events.at(-1), "destroy");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("nonenumerable own TEST and recipient fields survive the selected attempt handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-own-fields-"));
  try {
    const config = settings(directory);
    for (const key of ["providerProfile", "providerDirectory", "fixture", "fixtureIdentity", "replayFetch", "testOnly", "approvalJournal", "sendJournal"] as const) {
      Object.defineProperty(config, key, { value: config[key], enumerable: false });
    }
    Object.defineProperty(config, "recipient", { value: fixture.recipient, enumerable: false });
    const state = harness(config);
    assert.equal((await transferEvmForward(config, state.ports)).step, "send");
    assert.equal(state.wiring.selection?.providerProfile, TEST_SDK_PROFILE); assert.equal(state.wiring.io?.fetcher, offline);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the existing executor IO receives the bound durable store for each new replacement step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-store-wiring-"));
  try {
    for (const allowance of [0n, route.amount]) {
      const config = settings(join(directory, allowance.toString())), state = harness(config, allowance);
      assert.ok(state.ports.io);
      state.ports.io.journal = createJournalFile;
      state.ports.execute = async (intent, execution, io) => {
        assert.ok(io); assert.equal(io.fetcher, offline);
        const store = io.journal(execution.journalFile);
        const saved: EvmJournalRecord = { schema: "agtmai-evm-journal-v1", intent: validateSepoliaIntent(intent, intent),
          signed: { bytes: "0x0201", hash: "0x" + "aa".repeat(32) }, phase: "submitting" };
        await store.exclusive(() => store.write(saved));
        return { status: "unresolved", reason: "intercepted-unit-checkpoint", transactionHash: saved.signed.hash };
      };
      const result = await transferEvmForward(config, state.ports);
      const path = result.step === "approval" ? config.approvalJournal : config.sendJournal;
      const raw = createJournalFile<BoundForwardJournalRecord>(path), saved = await raw.exclusive(() => raw.read());
      assert.ok(saved); assert.equal(saved.forwardStep, result.step);
      assert.deepEqual(saved.forwardBinding, forwardJournalBinding(fixture, "BoiQxGHPgVaqxPn2TjqzmoHPd5toyfxxZ4wW2M7P3gK8", config));
      assert.equal(await readFile(path, "utf8"), JSON.stringify(saved) + "\n");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid replacement recipients, alias pair paths and setup nonces reject before operation filesystem IO", async t => {
  const config = settings("/unopened-forward-path"), mutants: Settings[] = [];
  for (const value of [null, "", "A", "B", route.router, "8T13W72sSEKmBpEv1FpUM7nJRatnChEfPSjkbSpdUn9t"]) {
    const mutant = { ...config }; Object.defineProperty(mutant, "recipient", { value }); mutants.push(mutant);
  }
  mutants.push({ ...config, sendJournal: config.approvalJournal + "/../approval.json" },
    { ...config, approvalNonce: "4", sendNonce: "5" });
  let filesystem = 0;
  t.mock.method(fs, "lstatSync", () => { filesystem++; throw new Error("Unexpected operation filesystem IO"); }); syncBuiltinESMExports();
  try {
    for (const mutant of mutants) {
      const state = harness(mutant);
      await assert.rejects(transferEvmForward(mutant, state.ports), /recipient|alias|setup nonce0\.\.4/);
      assert.deepEqual(state.events, []); assert.equal(filesystem, 0);
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("persisted pair conflicts are checked before approval execution, including identical approval calldata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-pair-ingress-"));
  try {
    const config = settings(directory);
    for (const field of ["selectedRecipient", "fixtureIdentity", "approvalJournal", "sendJournal", "approvalNonce", "sendNonce", "sourceToken", "destinationMint", "pool", "router", "amount", "direction"]) {
      const state = harness(config), saved = state.save("approval"); state.save("send");
      const binding = { ...saved.forwardBinding }; Object.defineProperty(binding, field, { value: field === "selectedRecipient" ? FORWARD_RECIPIENT_B : "conflict" });
      const changed: BoundForwardJournalRecord = { ...saved, forwardBinding: binding };
      state.records.set(config.approvalJournal, changed);
      await assert.rejects(transferEvmForward(config, state.ports), /binding/);
      assert.deepEqual(state.events, ["lock", "sdk", "read", "read", "destroy"]);
    }
    const state = harness(config); state.save("approval"); state.save("send");
    const result = await transferEvmForward(config, state.ports);
    assert.equal(result.step, "send");
    assert.deepEqual(state.events, ["lock", "sdk", "read", "read", "inspect", "inspect", "execute:6", "destroy"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("both stored intents and both saved signature projections are inspected before either executor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-signature-ingress-"));
  try {
    const config = settings(directory);
    for (const step of ["approval", "send"] as const) {
      for (const field of ["hash", "chainId", "from", "to", "data", "value", "nonce"] as const) {
        const state = harness(config); state.save("approval"); const saved = step === "approval" ? state.records.get(config.approvalJournal) : state.save("send");
        assert.ok(saved); if (step === "approval") { state.save("send"); }
        const observed = state.inspected.get(saved.signed.bytes); assert.ok(observed);
        state.inspected.set(saved.signed.bytes, { ...observed, [field]: "conflict" });
        await assert.rejects(transferEvmForward(config, state.ports), /signed forward transaction conflict/);
        assert.equal(state.events.some(e => e.startsWith("execute:")), false); assert.equal(state.events.at(-1), "destroy");
      }
      const state = harness(config); const a = state.save("approval"); const s = state.save("send");
      const saved = step === "approval" ? a : s;
      state.records.set(step === "approval" ? config.approvalJournal : config.sendJournal,
        { ...saved, intent: { ...saved.intent, data: "0x12345678" } });
      await assert.rejects(transferEvmForward(config, state.ports), /decoded forward operation/);
      assert.equal(state.events.includes("inspect"), false); assert.equal(state.events.some(e => e.startsWith("execute:")), false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("A binding cannot authorize B wire bytes even when approval calldata remains identical", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-wire-conflict-"));
  try {
    const config = settings(directory), state = harness(config); state.save("approval"); const saved = state.save("send");
    state.records.set(config.sendJournal, { ...saved, intent: { ...saved.intent, data: send(FORWARD_RECIPIENT_B).data } });
    await assert.rejects(transferEvmForward(config, state.ports), /decoded forward operation/);
    assert.deepEqual(state.events, ["lock", "sdk", "read", "read", "destroy"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("uncertain send reconciles only itself and never requotes or submits a still-signed approval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-uncertain-"));
  try {
    const config = settings(directory);
    for (const phase of ["submitting", "submitted"] as const) {
      const state = harness(config); state.save("approval", "signed"); state.save("send", phase);
      state.ports.execute = async (intent, _execution, io) => {
        state.events.push("execute:" + intent.nonce); assert.equal(io?.fetcher, offline);
        return { status: "unresolved", reason: "observation-unknown", transactionHash: "0x" + "cc".repeat(32) };
      };
      assert.equal((await transferEvmForward(config, state.ports)).status, "unresolved");
      assert.deepEqual(state.events, ["lock", "sdk", "read", "read", "inspect", "inspect", "execute:6", "destroy"]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("SDK owner closes after every acquired-client read/check/preparation/execution failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-cleanup-"));
  try {
    const config = settings(directory);
    for (const failure of ["read", "snapshot", "prepare", "execute"] as const) {
      const state = harness(config);
      if (failure === "read") { state.ports.read = async () => { throw new Error("read failure"); }; }
      if (failure === "snapshot") { state.ports.snapshot = async () => { throw new Error("snapshot failure"); }; }
      if (failure === "prepare") {
        const factory = state.ports.sdk;
        state.ports.sdk = async (...args) => ({ ...await factory(...args), prepare: async () => { throw new Error("prepare failure"); } });
      }
      if (failure === "execute") { state.ports.execute = async () => { throw new Error("execute failure"); }; }
      await assert.rejects(transferEvmForward(config, state.ports), new RegExp(failure + " failure"));
      assert.equal(state.events.at(-1), "destroy"); assert.equal(state.events.filter(e => e === "destroy").length, 1);
    }
    const cleanup = harness(config), factory = cleanup.ports.sdk;
    cleanup.ports.sdk = async (...args) => ({ ...await factory(...args), destroy: async () => { throw new Error("Unresolved cleanup"); } });
    await assert.rejects(transferEvmForward(config, cleanup.ports), /Unresolved cleanup/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unbound replacement forward records refuse rewriting and both steps remain inert", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-old-replacement-"));
  try {
    const config = settings(directory), state = harness(config); state.save("send");
    const { forwardBinding: _binding, forwardStep: _step, ...old } = state.save("approval");
    state.records.set(config.approvalJournal, old);
    await assert.rejects(transferEvmForward(config, state.ports), /Unresolved.*missing binding/);
    assert.deepEqual(state.records.get(config.approvalJournal), old);
    assert.deepEqual(state.events, ["lock", "sdk", "read", "read", "destroy"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// This positive control intentionally needs the independently owned pure B/bindFixture patch.
test("replacement B reaches the same selected fixture and encodes B without rehashing its A identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-b-dependent-"));
  try {
    const before = JSON.stringify(fixture), config = { ...settings(directory), recipient: FORWARD_RECIPIENT_B }, state = harness(config);
    assert.notEqual(send(fixture.recipient).data, send(FORWARD_RECIPIENT_B).data);
    assert.equal((await transferEvmForward(config, state.ports)).step, "send");
    assert.equal(JSON.stringify(fixture), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function contracts(config: Settings): void {
  // @ts-expect-error execution transport must implement actual fetch
  const badFetch: TestSdkSelection = { ...selection, replayFetch: () => 5 };
  // @ts-expect-error execution nonce is a canonical decimal string, never a number
  transferEvmForward({ ...config, sendNonce: 6 });
  // @ts-expect-error common selection carries a string fixture identity
  selectTestSdk({ ...selection, fixtureIdentity: 5 }, config.providerDirectory, fixture);
  void badFetch;
}
void contracts;
