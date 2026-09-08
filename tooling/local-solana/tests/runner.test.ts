import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuthenticatedToolSnapshots, type ToolSources } from "../src/adapters/tool-snapshots.ts";
import { observationFixture } from "./helpers/observations.ts";
import { runFixture, waitForOwnedRpcReady, type FixtureDependencies, type ReadinessTiming } from "../src/application/runner.ts";
import type { ToolResolutionRequest } from "../src/application/ports.ts";
import { LocalSolanaError, type FailureEvidenceReport } from "../src/domain/model.ts";

const unsupported = async (): Promise<never> => { throw new Error("unexpected test call"); };

test("already-aborted fixture stops before reclaim or run creation", async () => {
  const controller = new AbortController(); controller.abort();
  let reclaimed = false; let created = false;
  const deps = {
    environment: {},
    store: { async reclaimStale() { reclaimed = true; return 0; }, async create() { created = true; throw new Error("must not create"); } },
  } as unknown as FixtureDependencies;
  await assert.rejects(runFixture(deps, controller.signal), /SOLANA_COMMAND_ABORTED/u);
  assert.equal(reclaimed, false); assert.equal(created, false);
});

test("a post-mutation exception publishes sanitized failure evidence after cleanup", async () => {
  let stopped = false;
  let released = false;
  let cleaned = false;
  let toolsClosed = false;
  let listenerChecks = 0;
  let waitReadyTimeout: number | undefined;
  let failure: FailureEvidenceReport | undefined;
  const deps = {
    environment: { PATH: "/ambient/path-that-must-not-be-used" },
    tools: { async resolve(request: ToolResolutionRequest) { request.own({ async close() { assert.equal(stopped, true); toolsClosed = true; } }); return { solana: "/tools/solana", keygen: "/tools/keygen", validator: "/tools/validator", splToken: "/tools/spl-token", tokenProgram: "/tools/token.so", associatedTokenProgram: "/tools/ata.so" }; } },
    command: { run: unsupported },
    validator: { async start() { return { pid: 123, async assertHealthy() {}, async assertRpcListener() { listenerChecks += 1; if (listenerChecks <= 2) { throw new LocalSolanaError("SOLANA_RPC_LISTENER_IDENTITY", "listener is not visible yet"); } return { scope: "ipv4-loopback" as const }; }, async stop() { stopped = true; } }; } },
    rpc: {
      async waitReady(_rpcUrl: string, timeoutMs: number) { assert.equal(listenerChecks, 3); waitReadyTimeout = timeoutMs; return { version: "test", genesisHash: "11111111111111111111111111111111" }; },
      async waitProgramsReady() {},
      genesisHash: unsupported, mintAccount: unsupported, tokenAccount: unsupported,
      tokenAccountAddress: unsupported, finalizedTransaction: unsupported,
      sendSignedTransaction: unsupported, latestBlockhash: unsupported,
    },
    cli: {
      async createKeys(context: { readonly env: NodeJS.ProcessEnv }) {
        assert.equal(context.env.PATH, "/usr/bin:/bin");
        return { payer: "11111111111111111111111111111111", mint: "11111111111111111111111111111111", owner: "11111111111111111111111111111111" };
      },
      async verifyFunded() {},
      async createMint() { assert.ok(listenerChecks >= 6, "no mutation may run before owned-listener readiness and program readiness checks"); throw new LocalSolanaError("SOLANA_INJECTED_FAILURE", "sensitive /tmp/key path"); },
      revokeFreeze: unsupported, createTokenAccount: unsupported, associatedAddress: unsupported,
      mint: unsupported, burn: unsupported,
    },
    store: {
      async reclaimStale() { return 0; },
      async create() { return { directory: "/private/run", ledger: "/private/run/ledger", config: "/private/run/config", payerKey: "/private/run/payer", mintKey: "/private/run/mint", ownerKey: "/private/run/owner", leaseToken: "a".repeat(64) }; },
      async registerValidator() {},
      async cleanup() { assert.equal(toolsClosed, true); cleaned = true; },
      publish: unsupported,
      async publishFailure(report: FailureEvidenceReport) { failure = report; return { jsonPath: "/evidence/failure.json", markdownPath: "/evidence/failure.md" }; },
    },
    ports: { async allocate() { return { rpcPort: 20000, faucetPort: 20002, gossipPort: 19900, dynamicPortRange: "19900-19999", async release() { released = true; } }; } },
    authorityTransactions: { restoreFreeze: unsupported, freezeAccount: unsupported },
  } as unknown as FixtureDependencies;

  await assert.rejects(runFixture(deps), /SOLANA_INJECTED_FAILURE/u);
  assert.equal(stopped, true);
  assert.equal(released, true);
  assert.equal(cleaned, true);
  assert.equal(toolsClosed, true);
  assert.ok(waitReadyTimeout !== undefined && waitReadyTimeout > 0 && waitReadyTimeout < 30_000, "listener observation must consume the shared readiness budget");
  assert.deepEqual(failure, {
    schemaVersion: 1, status: "FAILED", failedPhase: "createMint",
    diagnosticCode: "SOLANA_INJECTED_FAILURE", mutationsMayHaveOccurred: true,
    cleanupCompleted: true, validatorStopped: true, portLeaseReleased: true, privateDirectoryRemoved: true, publicNetwork: false, realAssetCostUsd: 0,
    secretsRetained: false, productionApproved: false,
  });
  assert.doesNotMatch(JSON.stringify(failure), /sensitive|\/tmp|key path/iu);
});

test("owned-listener readiness retries only listener visibility and preserves the remaining deadline", async () => {
  let now = 1_000; let listenerChecks = 0; let actionCalls = 0;
  const timing: ReadinessTiming = { now: () => now, async wait(milliseconds) { now += milliseconds; } };
  const validator = {
    pid: 7, async stop() {}, async assertHealthy() {},
    async assertRpcListener() {
      listenerChecks += 1;
      if (listenerChecks <= 2) { throw new LocalSolanaError("SOLANA_RPC_LISTENER_IDENTITY", "not visible"); }
      return { scope: "ipv4-loopback" as const };
    },
  };
  const result = await waitForOwnedRpcReady(validator, 20_000, new AbortController().signal, async (remainingMs) => {
    actionCalls += 1; assert.equal(listenerChecks, 3); assert.equal(remainingMs, 29_900); return "ready";
  }, timing);
  assert.equal(result, "ready"); assert.equal(actionCalls, 1); assert.equal(listenerChecks, 4);
});

test("owned-listener readiness fails closed on validator identity, deadline, and abort", async (t) => {
  await t.test("wrong validator identity is never retried", async () => {
    let waits = 0; let actionCalls = 0;
    const validator = { pid: 7, async stop() {}, async assertHealthy() { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "replacement"); }, async assertRpcListener() { throw new Error("unreachable"); } };
    await assert.rejects(waitForOwnedRpcReady(validator, 20_000, new AbortController().signal, async () => { actionCalls += 1; }, { now: () => 0, async wait() { waits += 1; } }), /SOLANA_VALIDATOR_IDENTITY/u);
    assert.equal(waits, 0); assert.equal(actionCalls, 0);
  });
  await t.test("listener deadline expires without an RPC action", async () => {
    let now = 0; let actionCalls = 0;
    const validator = { pid: 7, async stop() {}, async assertHealthy() {}, async assertRpcListener() { throw new LocalSolanaError("SOLANA_RPC_LISTENER_IDENTITY", "not visible"); } };
    await assert.rejects(waitForOwnedRpcReady(validator, 20_000, new AbortController().signal, async () => { actionCalls += 1; }, { now: () => now, async wait(milliseconds) { now += milliseconds; } }), /SOLANA_RPC_LISTENER_IDENTITY/u);
    assert.equal(now, 30_000); assert.equal(actionCalls, 0);
  });
  await t.test("abort interrupts the listener wait promptly", async () => {
    const controller = new AbortController(); let waits = 0; let actionCalls = 0;
    const validator = { pid: 7, async stop() {}, async assertHealthy() {}, async assertRpcListener() { throw new LocalSolanaError("SOLANA_RPC_LISTENER_IDENTITY", "not visible"); } };
    await assert.rejects(waitForOwnedRpcReady(validator, 20_000, controller.signal, async () => { actionCalls += 1; }, { now: () => 0, async wait() { waits += 1; controller.abort(); } }), /SOLANA_COMMAND_ABORTED/u);
    assert.equal(waits, 1); assert.equal(actionCalls, 0);
  });
});

type CleanupTarget = "validator" | "port" | "directory" | "tools";

function cleanupFailureFixture(target: CleanupTarget): { readonly deps: FixtureDependencies; readonly attempts: Record<CleanupTarget, number>; failure: FailureEvidenceReport | undefined } {
  const state: { attempts: Record<CleanupTarget, number>; failure: FailureEvidenceReport | undefined } = {
    attempts: { validator: 0, port: 0, directory: 0, tools: 0 }, failure: undefined,
  };
  const fail = (resource: CleanupTarget): void => { state.attempts[resource] += 1; if (resource === target) { throw new Error(`raw ${resource} cleanup /private/key.json http://127.0.0.1:8899/`); } };
  const deps = {
    environment: {},
    tools: { async resolve(request: ToolResolutionRequest) { request.own({ async close() { fail("tools"); } }); return { solana: "/tools/solana", keygen: "/tools/keygen", validator: "/tools/validator", splToken: "/tools/spl-token", tokenProgram: "/tools/token.so", associatedTokenProgram: "/tools/ata.so" }; } },
    command: { run: unsupported },
    validator: { async start() { return { pid: 123, async assertHealthy() {}, async assertRpcListener() {}, async stop() { fail("validator"); } }; } },
    rpc: {
      async waitReady() { return { version: "test", genesisHash: "1".repeat(32) }; }, async waitProgramsReady() {},
      genesisHash: unsupported, mintAccount: unsupported, tokenAccount: unsupported, tokenAccountAddress: unsupported,
      finalizedTransaction: unsupported, sendSignedTransaction: unsupported, latestBlockhash: unsupported,
    },
    cli: {
      async createKeys() { return { payer: "1".repeat(32), mint: "2".repeat(32), owner: "3".repeat(32) }; }, async verifyFunded() {},
      async createMint() { throw new LocalSolanaError("SOLANA_INJECTED_FAILURE", "raw mutation failure /private/key.json"); },
      revokeFreeze: unsupported, createTokenAccount: unsupported, associatedAddress: unsupported, mint: unsupported, burn: unsupported,
    },
    store: {
      async reclaimStale() { return 0; },
      async create() { return { directory: "/private/run", ledger: "/private/run/ledger", config: "/private/run/config", payerKey: "/private/run/payer", mintKey: "/private/run/mint", ownerKey: "/private/run/owner", leaseToken: "a".repeat(64) }; },
      async registerValidator() {}, async cleanup() { fail("directory"); }, publish: unsupported,
      async publishFailure(value: FailureEvidenceReport) {
        assert.equal(state.attempts[target], target === "tools" ? 1 : 2, "failure evidence must follow final bounded cleanup attempt");
        state.failure = value; return { jsonPath: "/evidence/failure.json", markdownPath: "/evidence/failure.md" };
      },
    },
    ports: { async allocate() { return { rpcPort: 20_000, faucetPort: 20_002, gossipPort: 19_900, dynamicPortRange: "19900-19999", async release() { fail("port"); } }; } },
    authorityTransactions: { restoreFreeze: unsupported, freezeAccount: unsupported },
  } as unknown as FixtureDependencies;
  return { deps, attempts: state.attempts, get failure() { return state.failure; } };
}

for (const target of ["validator", "port", "directory", "tools"] as const) {
  test(`${target} cleanup failure respects independent retries and snapshot retention`, async () => {
    const fixture = cleanupFailureFixture(target);
    await assert.rejects(runFixture(fixture.deps), /SOLANA_INJECTED_FAILURE/u);
    assert.equal(fixture.attempts[target], target === "tools" ? 1 : 2);
    const failure = fixture.failure; assert.ok(failure);
    assert.equal(failure.validatorStopped, target !== "validator");
    assert.equal(failure.portLeaseReleased, target !== "port");
    assert.equal(failure.privateDirectoryRemoved, target === "port");
    assert.equal(failure.cleanupCompleted, false);
    assert.equal(failure.secretsRetained, target !== "port");
    assert.doesNotMatch(JSON.stringify(failure), /\/private\/|http:\/\/|raw mutation|raw validator|raw port|raw directory/iu);
    for (const resource of ["validator", "port", "directory", "tools"] as const) {
      const skipped = (target === "validator" && (resource === "tools" || resource === "directory")) || (target === "tools" && resource === "directory");
      assert.equal(fixture.attempts[resource], skipped ? 0 : resource === target && target !== "tools" ? 2 : 1);
    }
  });
}


function completeFixture(replaceListener = false) {
  const observation = observationFixture(); let listenerOwned = true; let mintRead = 0; let tokenRead = 0;
  const state = { published: false, closed: 0, stopped: 0, cleaned: 0, failure: undefined as FailureEvidenceReport | undefined };
  const events: string[] = [];
  const signatures = observation.transactions.map((transaction) => transaction.signature);
  const deps = {
    environment: {}, tools: { async resolve(request: ToolResolutionRequest) { request.own({ async close() { state.closed += 1; events.push("close"); } }); return { solana: "/s", keygen: "/k", validator: "/v", splToken: "/t", tokenProgram: "/p", associatedTokenProgram: "/a" }; } }, command: { run: unsupported },
    validator: { async start() { return { pid: 7, async assertHealthy() {}, async assertRpcListener() { if (!listenerOwned) { throw new LocalSolanaError("SOLANA_RPC_LISTENER_IDENTITY", "replacement"); } return { scope: "ipv4-loopback" as const }; }, async stop() { state.stopped += 1; events.push("stop"); } }; } },
    rpc: {
      async waitReady() { return { version: observation.validatorVersion, genesisHash: observation.genesisHashBefore }; }, async waitProgramsReady() {},
      async genesisHash() { return observation.genesisHashAfter; }, async mintAccount() { return [observation.initialMint, observation.afterRevokeMint, observation.afterMint, observation.finalMint][mintRead++]!; },
      async tokenAccount() { return [observation.afterMintTokenAccount, observation.finalTokenAccount][tokenRead++]!; }, async tokenAccountAddress() { return observation.tokenAccountAddress; },
      async finalizedTransaction(_url: string, signature: string) { const result = observation.transactions.find((transaction) => transaction.signature === signature)!; if (replaceListener && signature === signatures.at(-1)) { listenerOwned = false; } return result; },
      async sendSignedTransaction(_url: string, bytes: Uint8Array) { return bytes[0] === 1 ? signatures[5]! : signatures[6]!; }, async latestBlockhash() { return observation.genesisHashBefore; },
    },
    cli: { async createKeys() { return { payer: observation.payerAddress, mint: observation.mintAddress, owner: observation.ownerAddress }; }, async verifyFunded() {}, async createMint() { return signatures[0]!; }, async revokeFreeze() { return signatures[1]!; }, async createTokenAccount() { return signatures[2]!; }, async associatedAddress() { return observation.tokenAccountAddress; }, async mint() { return signatures[3]!; }, async burn() { return signatures[4]!; } },
    store: { async reclaimStale() { return 0; }, async create() { return { directory: "/r", ledger: "/r/l", config: "/r/c", payerKey: "/r/p", mintKey: "/r/m", ownerKey: "/r/o", leaseToken: "a".repeat(64) }; }, async registerValidator() {}, async cleanup() { state.cleaned += 1; events.push("cleanup"); }, async publish() { state.published = true; events.push("publish"); return { jsonPath: "x", markdownPath: "y" }; }, async publishFailure(report: FailureEvidenceReport) { state.failure = report; return { jsonPath: "f", markdownPath: "f" }; } },
    ports: { async allocate() { return { rpcPort: 20_000, faucetPort: 20_002, gossipPort: 19_900, dynamicPortRange: "19900-19999", async release() {} }; } },
    authorityTransactions: { async restoreFreeze() { return Uint8Array.from([1]); }, async freezeAccount() { return Uint8Array.from([2]); } },
  } as unknown as FixtureDependencies;
  return { deps, state, events };
}

test("replacement listener during the final evidence batch can never publish READY", async () => {
  const { deps, state } = completeFixture(true);
  await assert.rejects(runFixture(deps), /SOLANA_RPC_LISTENER_IDENTITY/u); assert.equal(state.published, false);
  assert.equal(state.closed, 1);
});

test("success stops the validator then closes snapshots and removes private files before READY", async () => {
  const { deps, state, events } = completeFixture();
  assert.deepEqual(await runFixture(deps), { jsonPath: "x", markdownPath: "y" });
  assert.deepEqual(events, ["stop", "close", "cleanup", "publish"]);
  assert.equal(state.published, true);
});

test("snapshot close failure cannot publish success or invoke recursive private cleanup", async () => {
  const { deps, state } = completeFixture(); const closeError = new Error("synthetic snapshot close failure"); let closes = 0;
  const tools = { async resolve(request: ToolResolutionRequest) {
    const paths = await deps.tools.resolve({ ...request, own() {} });
    request.own({ async close() { closes += 1; throw closeError; } }); return paths;
  } };
  await assert.rejects(runFixture({ ...deps, tools }), (cause) => {
    assert.ok(cause instanceof AggregateError); assert.match(String(cause.errors[0]), /SOLANA_CLEANUP_INCOMPLETE/u);
    assert.equal(cause.errors[1], closeError); return true;
  });
  assert.equal(closes, 1); assert.equal(state.published, false); assert.equal(state.cleaned, 0); assert.equal(state.stopped, 1);
  assert.equal(state.failure?.cleanupCompleted, false); assert.equal(state.failure?.privateDirectoryRemoved, false);
});

test("cancellation after resolution and during a CLI call closes snapshots after the call settles", async () => {
  for (const phase of ["resolution", "cli", "cleanup"] as const) {
    const { deps, state } = completeFixture(); const controller = new AbortController();
    const tools = { async resolve(request: ToolResolutionRequest) {
      const paths = await deps.tools.resolve(request); if (phase === "resolution") { controller.abort(); } return paths;
    } };
    const cli = { ...deps.cli, async createMint() {
      controller.abort(); return "unused";
    } };
    const store = { ...deps.store, async cleanup(paths: Parameters<typeof deps.store.cleanup>[0]) { await deps.store.cleanup(paths); if (phase === "cleanup") { controller.abort(); } } };
    await assert.rejects(runFixture({ ...deps, tools, store, cli: phase === "cli" ? cli : deps.cli }, controller.signal), /SOLANA_COMMAND_ABORTED/u);
    assert.equal(state.closed, 1); assert.equal(state.cleaned, 1); assert.equal(state.published, false);
    assert.equal(state.stopped, phase === "resolution" ? 0 : 1);
  }
});

test("pre-validator downstream failure closes snapshots and retains the original failure", async () => {
  const { deps, state } = completeFixture(); const primary = new Error("synthetic createKeys failure");
  await assert.rejects(runFixture({ ...deps, cli: { ...deps.cli, async createKeys() { throw primary; } } }), (cause) => cause === primary);
  assert.equal(state.closed, 1); assert.equal(state.cleaned, 1); assert.equal(state.stopped, 0); assert.equal(state.published, false);
});

test("unconfirmed command and validator startup stops retain snapshots and private files", async () => {
  for (const phase of ["resolution", "cli", "start"] as const) {
    const { deps, state } = completeFixture();
    const primary = new LocalSolanaError("SOLANA_CHILD_STOP_TIMEOUT", "synthetic user still alive");
    const tools = { async resolve(request: ToolResolutionRequest) { await deps.tools.resolve(request); throw primary; } };
    const cli = { ...deps.cli, async createKeys() { throw primary; } };
    const validator = { async start() { throw primary; } };
    await assert.rejects(runFixture({ ...deps, tools: phase === "resolution" ? tools : deps.tools, cli: phase === "cli" ? cli : deps.cli, validator: phase === "start" ? validator : deps.validator }), (cause) => { assert.ok(cause instanceof AggregateError); assert.equal(cause.cause, primary); assert.match(String(cause.errors.at(-1)), /SOLANA_TOOL_CLEANUP_INCOMPLETE/u); return true; });
    assert.equal(state.closed, 0); assert.equal(state.cleaned, 0); assert.equal(state.published, false);
  }
});

test("cleanup and failure publication errors preserve the primary downstream failure", async () => {
  const { deps, state } = completeFixture();
  const primary = new LocalSolanaError("SOLANA_PRIMARY", "synthetic mutation failure");
  const secondary = new Error("synthetic failure publication failure");
  const tools = { async resolve(request: ToolResolutionRequest) {
    return await deps.tools.resolve({ ...request, own: () => { request.own({ async close() { throw new Error("synthetic close failure"); } }); } });
  } };
  await assert.rejects(runFixture({ ...deps, tools, cli: { ...deps.cli, async createMint() { throw primary; } }, store: { ...deps.store, async publishFailure() { throw secondary; } } }), (cause) => {
    assert.ok(cause instanceof AggregateError); assert.equal(cause.cause, primary); assert.equal(cause.errors[0], primary); assert.equal(cause.errors.at(-1), secondary); return true;
  });
  assert.equal(state.closed, 0); assert.equal(state.cleaned, 0); assert.equal(state.published, false);
});

for (const outcome of ["success", "validator", "substitution", "downstream", "cancellation"] as const) {
  test(`real synthetic snapshot files follow the runner's ${outcome} lifetime`, async () => {
    const { deps, state } = completeFixture(); const controller = new AbortController();
    const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-runner-snapshots-")));
    const directory = join(root, "run"); await mkdir(directory, { mode: 0o700 });
    const identity = await lstat(directory, { bigint: true });
    const rootIdentity = await lstat(root, { bigint: true });
    const source = join(root, "synthetic-tool"); await writeFile(source, "tiny authenticated fixture");
    const hash = createHash("sha256").update("tiny authenticated fixture").digest("hex");
    const sources = Object.fromEntries(["solana", "keygen", "validator", "splToken", "tokenProgram", "associatedTokenProgram"].map((name) => [name, { path: source, hash }])) as ToolSources;
    let snapshot = ""; let stops = 0; let ownedLease: AuthenticatedToolSnapshots | undefined;
    const tools = { async resolve(request: ToolResolutionRequest) {
      const lease = new AuthenticatedToolSnapshots(request.run); ownedLease = lease; request.own(lease);
      const paths = await lease.create(sources, request.signal); snapshot = paths.validator; return paths;
    } };
    const store = { ...deps.store,
      async create() { return { ...await deps.store.create(), directory, directoryIdentity: { dev: String(identity.dev), ino: String(identity.ino) }, rootIdentity: { dev: String(rootIdentity.dev), ino: String(rootIdentity.ino) } }; },
      async cleanup(paths: Parameters<typeof deps.store.cleanup>[0]) { await deps.store.cleanup(paths); await rm(directory, { recursive: true }); },
    };
    const validator = { async start(request: Parameters<typeof deps.validator.start>[0]) {
      const handle = await deps.validator.start(request);
      return { ...handle, async stop() {
        stops += 1; assert.equal(await readFile(snapshot, "utf8"), "tiny authenticated fixture");
        if (outcome === "validator") { throw new LocalSolanaError("SOLANA_CHILD_STOP_TIMEOUT", "synthetic validator termination is unconfirmed"); }
        if (outcome === "substitution") { await writeFile(join(dirname(snapshot), "foreign"), "retain"); }
        await handle.stop();
      } };
    } };
    const cli = { ...deps.cli, async createMint(context: Parameters<typeof deps.cli.createMint>[0], request: Parameters<typeof deps.cli.createMint>[1]) {
      if (outcome === "downstream") { throw new LocalSolanaError("SOLANA_SYNTHETIC_FAILURE", "synthetic downstream failure"); }
      if (outcome === "cancellation") { controller.abort(); }
      return await deps.cli.createMint(context, request);
    } };
    try {
      const execution = runFixture({ ...deps, tools, store, validator, cli }, controller.signal);
      if (outcome === "success") { await execution; }
      else { await assert.rejects(execution, /SOLANA_(?:CLEANUP_INCOMPLETE|SYNTHETIC_FAILURE|COMMAND_ABORTED)/u); }
      const retained = outcome === "validator" || outcome === "substitution";
      assert.equal(state.published, outcome === "success"); assert.equal(state.cleaned, retained ? 0 : 1);
      assert.equal(stops, outcome === "validator" ? 2 : 1);
      if (retained) {
        assert.equal(await readFile(snapshot, "utf8"), "tiny authenticated fixture");
        assert.equal(state.failure?.cleanupCompleted, false);
        if (outcome === "substitution") { assert.equal(await readFile(join(dirname(snapshot), "foreign"), "utf8"), "retain"); }
      } else {
        await assert.rejects(lstat(directory), { code: "ENOENT" });
        await assert.rejects(lstat(snapshot), { code: "ENOENT" });
      }
    } finally { await ownedLease?.close().catch(() => {}); await rm(root, { recursive: true, force: true }); }
  });
}
