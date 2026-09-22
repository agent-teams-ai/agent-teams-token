import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCcipPreparation,
  type CcipPreparationInput,
  type PreparedCcipDeployment,
} from "../src/features/genesis-manifest/domain/ccip-preparation.js";
import type { Hex } from "../src/features/genesis-manifest/domain/deployment.js";
import { validateProductionDeployment, type ValidatedProductionDeployment } from "../src/features/genesis-manifest/domain/production-deployment.js";
import { syntheticProductionEnvelope } from "./production-fixture.js";

const TOKEN_A = `0x${"6".repeat(40)}` as Hex;
const TOKEN_B = `0x${"7".repeat(40)}` as Hex;
const POOL_A = `0x${"8".repeat(40)}` as Hex;
const POOL_B = `0x${"9".repeat(40)}` as Hex;
const SOLANA = "11111111111111111111111111111111";

function validated(token: Hex = TOKEN_A, pool: Hex = POOL_A): ValidatedProductionDeployment {
  const envelope = syntheticProductionEnvelope() as {
    deployment: {
      bridge: {
        ethereum: { token: Hex | null; pool: Hex | null };
        solana: { mint: string | null; pool: string | null; poolSigner: string | null; poolTokenAccount: string | null; lookupTable: string | null };
      };
    };
  };
  envelope.deployment.bridge.ethereum.token = token;
  envelope.deployment.bridge.ethereum.pool = pool;
  Object.assign(envelope.deployment.bridge.solana, {
    mint: SOLANA,
    pool: SOLANA,
    poolSigner: SOLANA,
    poolTokenAccount: SOLANA,
    lookupTable: SOLANA,
  });
  const result = validateProductionDeployment(envelope);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.value);
  return result.value;
}

function input(options: {
  deploymentToken?: Hex;
  expectedToken?: Hex;
  pr21Token?: Hex;
  observedToken?: Hex;
  deploymentPool?: Hex;
  observedPool?: Hex;
  operations?: PreparedCcipDeployment["operations"];
  preparedConfiguration?: ValidatedProductionDeployment;
} = {}): CcipPreparationInput {
  const deployment = validated(options.deploymentToken, options.deploymentPool);
  const expectedToken = options.expectedToken ?? options.deploymentToken ?? TOKEN_A;
  return {
    deployment,
    prepared: {
      configuration: options.preparedConfiguration ?? deployment,
      operations: options.operations ?? [{ id: "token-create", kind: "create", expectedAddress: expectedToken }],
    },
    pr21Token: { ethereumToken: options.pr21Token ?? expectedToken },
    lockReleasePool: {
      pool: options.observedPool ?? options.deploymentPool ?? POOL_A,
      localToken: options.observedToken ?? options.pr21Token ?? expectedToken,
    },
  };
}

test("exactly joins deployment, prepared, PR21 and LockRelease token identities", () => {
  const authority = input();
  const result = validateCcipPreparation(authority);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.context, {
    schema: "agtmai-ccip-preparation-v1",
    ethereumToken: TOKEN_A,
    ethereumPool: POOL_A,
    solanaMint: SOLANA,
    solanaPool: SOLANA,
    evmSelector: "5009297550715157269",
    solanaSelector: "124615329519749607",
  });
  assert.equal("prepared" in result.context!, false);
  (authority.lockReleasePool as { localToken: Hex }).localToken = TOKEN_B;
  assert.equal(result.context?.ethereumToken, TOKEN_A);
});

test("rejects missing, duplicate, wrong-kind and malformed token-create operations", () => {
  const cases: readonly [PreparedCcipDeployment["operations"], string][] = [
    [[], "CCIP_PREPARATION_TOKEN_CREATE_OPERATION_COUNT"],
    [[
      { id: "token-create", kind: "create", expectedAddress: TOKEN_A },
      { id: "token-create", kind: "create", expectedAddress: TOKEN_A },
    ], "CCIP_PREPARATION_TOKEN_CREATE_OPERATION_COUNT"],
    [[{ id: "token-create", kind: "call", expectedAddress: TOKEN_A }], "CCIP_PREPARATION_TOKEN_CREATE_OPERATION_KIND"],
    [[{ id: "token-create", kind: "create" }], "CCIP_PREPARATION_TOKEN_CREATE_EXPECTED_ADDRESS"],
    [[{ id: "token-create", kind: "create", expectedAddress: "0x1234" }], "CCIP_PREPARATION_TOKEN_CREATE_EXPECTED_ADDRESS"],
  ];
  for (const [operations, code] of cases) {
    const result = validateCcipPreparation(input({ operations }));
    assert.equal(result.context, undefined, code);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === code), code);
  }
});

test("address equality is authoritative even when token metadata and supply are identical", () => {
  const result = validateCcipPreparation(input({ deploymentToken: TOKEN_A, expectedToken: TOKEN_B, pr21Token: TOKEN_B, observedToken: TOKEN_B }));
  assert.equal(result.context, undefined);
  assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.code), ["CCIP_PREPARATION_DEPLOYMENT_PREPARED_TOKEN_MISMATCH"]);
});

test("rejects each prepared, PR21, observed-token and observed-pool equality mismatch", () => {
  const cases: readonly [CcipPreparationInput, string][] = [
    [input({ expectedToken: TOKEN_B, pr21Token: TOKEN_B, observedToken: TOKEN_B }), "CCIP_PREPARATION_DEPLOYMENT_PREPARED_TOKEN_MISMATCH"],
    [input({ pr21Token: TOKEN_B, observedToken: TOKEN_B }), "CCIP_PREPARATION_PREPARED_PR21_TOKEN_MISMATCH"],
    [input({ observedToken: TOKEN_B }), "CCIP_PREPARATION_PR21_POOL_TOKEN_MISMATCH"],
    [input({ observedPool: POOL_B }), "CCIP_PREPARATION_LOCK_RELEASE_POOL_MISMATCH"],
  ];
  for (const [authority, code] of cases) {
    const result = validateCcipPreparation(authority);
    assert.equal(result.context, undefined, code);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === code), code);
  }
});

test("rejects prepared/deployment mismatch and incomplete bridge identities", () => {
  const mismatched = input({ preparedConfiguration: validated(TOKEN_B) });
  assert.ok(validateCcipPreparation(mismatched).diagnostics.some(diagnostic => diagnostic.code === "CCIP_PREPARATION_PREPARED_DEPLOYMENT_MISMATCH"));

  const complete = input();
  const unconfiguredDeployment = structuredClone(complete.deployment) as ValidatedProductionDeployment;
  (unconfiguredDeployment.deployment.bridge!.solana as { mint: string | null }).mint = null;
  const missing = validateCcipPreparation({ ...complete, deployment: unconfiguredDeployment, prepared: { ...complete.prepared, configuration: unconfiguredDeployment } });
  assert.equal(missing.context, undefined);
  assert.ok(missing.diagnostics.some(diagnostic => diagnostic.code === "CCIP_PREPARATION_BRIDGE_IDENTITY_REQUIRED"));

  const nullBridgeDeployment = structuredClone(complete.deployment) as ValidatedProductionDeployment;
  (nullBridgeDeployment.deployment as { bridge: null }).bridge = null;
  const absent = validateCcipPreparation({ ...complete, deployment: nullBridgeDeployment, prepared: { ...complete.prepared, configuration: nullBridgeDeployment } });
  assert.equal(absent.context, undefined);
  assert.ok(absent.diagnostics.some(diagnostic => diagnostic.code === "CCIP_PREPARATION_BRIDGE_REQUIRED"));
});

test("requires an accepted mainnet dry-run deployment", () => {
  const authority = input();
  const deployment = structuredClone(authority.deployment) as ValidatedProductionDeployment;
  (deployment.deployment as { status: string; environment: { mode: string } }).status = "draft";
  (deployment.deployment as { status: string; environment: { mode: string } }).environment.mode = "owned-testnet";
  const diagnostics = validateCcipPreparation({ ...authority, deployment, prepared: { ...authority.prepared, configuration: deployment } }).diagnostics;
  assert.ok(diagnostics.some(diagnostic => diagnostic.code === "CCIP_PREPARATION_ACCEPTED_DEPLOYMENT_REQUIRED"));
  assert.ok(diagnostics.some(diagnostic => diagnostic.code === "CCIP_PREPARATION_MAINNET_DRY_RUN_REQUIRED"));
});

test("diagnostics are deterministic and sorted", () => {
  const authority = input({ operations: [], pr21Token: TOKEN_B, observedToken: TOKEN_A, observedPool: POOL_B });
  const first = validateCcipPreparation(authority).diagnostics;
  assert.deepEqual(first, validateCcipPreparation(authority).diagnostics);
  assert.deepEqual(first, [...first].sort((left, right) => left.pointer.localeCompare(right.pointer) || left.code.localeCompare(right.code)));
});
