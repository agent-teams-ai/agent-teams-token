import assert from "node:assert/strict";
import test from "node:test";
import { runFixture, type FixtureDependencies } from "../src/application/runner.ts";
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
  let failure: FailureEvidenceReport | undefined;
  const deps = {
    environment: { PATH: "/ambient/path-that-must-not-be-used" },
    tools: { async resolve() { return { solana: "/tools/solana", keygen: "/tools/keygen", validator: "/tools/validator", splToken: "/tools/spl-token", tokenProgram: "/tools/token.so", associatedTokenProgram: "/tools/ata.so" }; } },
    command: { run: unsupported },
    validator: { async start() { return { pid: 123, async stop() { stopped = true; } }; } },
    rpc: {
      async waitReady() { return { version: "test", genesisHash: "11111111111111111111111111111111" }; },
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
      async createMint() { throw new LocalSolanaError("SOLANA_INJECTED_FAILURE", "sensitive /tmp/key path"); },
      revokeFreeze: unsupported, createTokenAccount: unsupported, associatedAddress: unsupported,
      mint: unsupported, burn: unsupported,
    },
    store: {
      async reclaimStale() { return 0; },
      async create() { return { directory: "/private/run", ledger: "/private/run/ledger", config: "/private/run/config", payerKey: "/private/run/payer", mintKey: "/private/run/mint", ownerKey: "/private/run/owner", leaseToken: "a".repeat(64) }; },
      async registerValidator() {},
      async cleanup() { cleaned = true; },
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
  assert.deepEqual(failure, {
    schemaVersion: 1, status: "FAILED", failedPhase: "createMint",
    diagnosticCode: "SOLANA_INJECTED_FAILURE", mutationsMayHaveOccurred: true,
    cleanupCompleted: true, validatorStopped: true, portLeaseReleased: true, privateDirectoryRemoved: true, publicNetwork: false, realAssetCostUsd: 0,
    secretsRetained: false, productionApproved: false,
  });
  assert.doesNotMatch(JSON.stringify(failure), /sensitive|\/tmp|key path/iu);
});

type CleanupTarget = "validator" | "port" | "directory";

function cleanupFailureFixture(target: CleanupTarget): { readonly deps: FixtureDependencies; readonly attempts: Record<CleanupTarget, number>; failure: FailureEvidenceReport | undefined } {
  const state: { attempts: Record<CleanupTarget, number>; failure: FailureEvidenceReport | undefined } = {
    attempts: { validator: 0, port: 0, directory: 0 }, failure: undefined,
  };
  const fail = (resource: CleanupTarget): void => { state.attempts[resource] += 1; if (resource === target) { throw new Error(`raw ${resource} cleanup /private/key.json http://127.0.0.1:8899/`); } };
  const deps = {
    environment: {},
    tools: { async resolve() { return { solana: "/tools/solana", keygen: "/tools/keygen", validator: "/tools/validator", splToken: "/tools/spl-token", tokenProgram: "/tools/token.so", associatedTokenProgram: "/tools/ata.so" }; } },
    command: { run: unsupported },
    validator: { async start() { return { pid: 123, async stop() { fail("validator"); } }; } },
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
        assert.equal(state.attempts[target], 2, "failure evidence must follow final bounded cleanup attempt");
        state.failure = value; return { jsonPath: "/evidence/failure.json", markdownPath: "/evidence/failure.md" };
      },
    },
    ports: { async allocate() { return { rpcPort: 20_000, faucetPort: 20_002, gossipPort: 19_900, dynamicPortRange: "19900-19999", async release() { fail("port"); } }; } },
    authorityTransactions: { restoreFreeze: unsupported, freezeAccount: unsupported },
  } as unknown as FixtureDependencies;
  return { deps, attempts: state.attempts, get failure() { return state.failure; } };
}

for (const target of ["validator", "port", "directory"] as const) {
  test(`${target} cleanup failure is independently retried and reported truthfully`, async () => {
    const fixture = cleanupFailureFixture(target);
    await assert.rejects(runFixture(fixture.deps), /SOLANA_INJECTED_FAILURE/u);
    assert.equal(fixture.attempts[target], 2);
    const failure = fixture.failure; assert.ok(failure);
    assert.equal(failure.validatorStopped, target !== "validator");
    assert.equal(failure.portLeaseReleased, target !== "port");
    assert.equal(failure.privateDirectoryRemoved, target !== "directory");
    assert.equal(failure.cleanupCompleted, false);
    assert.equal(failure.secretsRetained, target === "directory");
    assert.doesNotMatch(JSON.stringify(failure), /\/private\/|http:\/\/|raw mutation|raw validator|raw port|raw directory/iu);
    for (const resource of ["validator", "port", "directory"] as const) {
      assert.equal(fixture.attempts[resource], resource === target ? 2 : 1);
    }
  });
}
