import assert from "node:assert/strict";
import test from "node:test";
import { runFixture, type FixtureDependencies } from "../src/application/runner.ts";
import { LocalSolanaError, type FailureEvidenceReport } from "../src/domain/model.ts";

const unsupported = async (): Promise<never> => { throw new Error("unexpected test call"); };

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
    cleanupCompleted: true, publicNetwork: false, realAssetCostUsd: 0,
    secretsRetained: false, productionApproved: false,
  });
  assert.doesNotMatch(JSON.stringify(failure), /sensitive|\/tmp|key path/iu);
});
