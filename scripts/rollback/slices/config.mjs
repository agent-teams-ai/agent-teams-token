import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(new URL("../prove-slices.mjs", import.meta.url)));

export const repositoryRoot = realpathSync(resolve(scriptDirectory, "../.."));
export const manifestDirectory = join(repositoryRoot, "architecture/rollback");
export const rollbackTemporaryRoot = realpathSync(process.env.AGTMAI_ROLLBACK_TMPDIR ?? tmpdir());

const rollbackTemporaryRelative = relative(repositoryRoot, rollbackTemporaryRoot);
if (rollbackTemporaryRelative === ""
  || (!rollbackTemporaryRelative.startsWith(".." + sep) && rollbackTemporaryRelative !== "..")) {
  throw new Error("ROLLBACK_TEMP_ROOT_INSIDE_REPOSITORY path=" + rollbackTemporaryRoot);
}

export const manifestNames = ["local-solana.json", "deployment-plan.json", "slither.json"];
export const expectedSlices = ["local-solana", "deployment-plan", "slither"];
export const ROLLBACK_MANIFEST_COUNT = 3;
export const ROLLBACK_MANIFEST_MAX_BYTES = 1024 * 1024;
export const ROLLBACK_MANIFEST_MAX_PATHS = 4_096;
export const ROLLBACK_PATH_MAX_BYTES = 1_024;
export const ROLLBACK_PATH_MAX_DEPTH = 128;
export const ROLLBACK_REMOVAL_MAX_SLOTS = 4_096;
export const ROLLBACK_SHARED_PATH_MAX_BYTES = 16 * 1024 * 1024;
export const rollbackBaselineSha = "b7a868f85d89c4bb7a9aeed1d854a5f949306a45";
export const rollbackHistoryAnchorSha = "3231e8a918c6079c8b384b5389fef2be9f25d33f";
export const pendingGlobalManifestEvidence = "candidate-bound-manifests-pending-proof-completion";
export const completedGlobalManifestEvidence = "candidate-bound-local-proof-complete-hosted-ci-pending";

export const sliceRoots = Object.freeze({
  "local-solana": "tooling/local-solana",
  "deployment-plan": "tooling/deployment-plan",
  slither: "tooling/security/slither",
});

export const deploymentPlanSharedEditBaseline = Object.freeze({
  sha: "dfe89da4c77a186aefbaead50981a327317f3bc4",
  paths: Object.freeze([
    "tooling/local-evm/rpc.ts",
    "tooling/local-evm/tests/rpc.test.ts",
  ]),
});

export const expectedSharedPaths = Object.freeze({
  "local-solana": [
    ".github/workflows/ci.yml",
    "architecture/foundation/source-dependencies.yaml",
    "package.json",
    "scripts/solana/local-fixture.ts",
    "scripts/tests/workflow.test.mjs",
    "tooling/local-solana/src/README.md",
    "tooling/toolchain.lock.json",
  ],
  "deployment-plan": [
    ".github/workflows/ci.yml",
    "architecture/foundation/source-dependencies.yaml",
    "package.json",
    "scripts/deployment/estimate-local.ts",
    "scripts/deployment/local-execution-proof.ts",
    "scripts/tests/workflow.test.mjs",
    "tooling/deployment-plan/src/README.md",
    "tooling/local-evm/rpc.ts",
    "tooling/local-evm/tests/rpc.test.ts",
  ],
  slither: [
    ".github/workflows/ci.yml",
    "architecture/foundation/source-dependencies.yaml",
    "package.json",
    "scripts/tests/workflow.test.mjs",
    "tooling/security/slither/src/README.md",
    "tooling/toolchain.lock.json",
  ],
});

const commonRetainedSharedPaths = Object.freeze([
  "architecture/foundation/repository-agent-workflow.yaml",
  "scripts/tests/tooling-boundaries.test.mjs",
]);

// Supply owns full unsigned assembly, authenticated artifact admission and its tests.
// Retain those exact bytes and public entrypoints when removing deployment-plan.
// Deployment-plan rollback removes the planner, but Local EVM still owns
// supervisor custody before acknowledgement and pinned Foundry archive admission.
// Neither survivor imports the removed planner. RPC execution additions remain
// slice-owned reversals; these two exact files are independent Local EVM behavior.
// Passive official-Safe reuse belongs to the existing testnet custody adapter:
// it owns no process, signer or deployment-plan import and survives slice removal.
export const expectedRetainedSharedPaths = Object.freeze({
  "local-solana": commonRetainedSharedPaths,
  "deployment-plan": Object.freeze([
    ...commonRetainedSharedPaths,
    "packages/contexts/supply/src/features/genesis-manifest/adapters/deployment-artifacts.ts",
    "packages/contexts/supply/src/features/genesis-manifest/application/prepare-production-deployment.ts",
    "packages/contexts/supply/src/features/genesis-manifest/application/deployment-manifest.ts",
    "packages/contexts/supply/src/features/genesis-manifest/application/passport.ts",
    "packages/contexts/supply/src/features/genesis-manifest/application/reserve-facts.ts",
    "packages/contexts/supply/src/features/genesis-manifest/deployment.ts",
    "packages/contexts/supply/src/features/genesis-manifest/composition/deployment-files.ts",
    "packages/contexts/supply/tests/deployment-cli.test.ts",
    "packages/contexts/supply/tests/production-deployment.test.ts",
    "tooling/local-evm/process.ts",
    "tooling/local-evm/toolchain.ts",
    "tooling/testnet-ccip/src/adapters/local-safe.ts",
    "tooling/testnet-ccip/src/adapters/safe-custody.ts",
  ].toSorted()),
  slither: commonRetainedSharedPaths,
});
