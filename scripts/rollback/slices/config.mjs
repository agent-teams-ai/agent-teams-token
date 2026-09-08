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
export const pendingGlobalManifestEvidence = "candidate-bound-manifests-pending-proof-completion";
export const completedGlobalManifestEvidence = "candidate-bound-local-proof-complete-hosted-ci-pending";

export const sliceRoots = Object.freeze({
  "local-solana": "tooling/local-solana",
  "deployment-plan": "tooling/deployment-plan",
  slither: "tooling/security/slither",
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
    "scripts/tests/workflow.test.mjs",
    "tooling/deployment-plan/src/README.md",
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

export const expectedRetainedSharedPaths = Object.freeze([
  "architecture/foundation/repository-agent-workflow.yaml",
  "scripts/tests/tooling-boundaries.test.mjs",
]);
