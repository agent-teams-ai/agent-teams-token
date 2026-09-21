import { basicRun, gitExecutable } from "../runtime/candidate.mjs";
import {
  deploymentPlanSharedEditBaseline,
  repositoryRoot,
} from "./config.mjs";
import {
  snapshotRollbackSharedPaths,
} from "./shared-paths.mjs";
import {
  editRollbackSharedText,
  restoreRollbackSharedFile,
} from "./shared-file-operations.mjs";

function run(command, commandArguments, options = {}) {
  return basicRun(command === "git" ? gitExecutable() : command, commandArguments, {
    ...options,
    cwd: options.cwd ?? repositoryRoot,
  });
}

function replaceExactly(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`ROLLBACK_EXACT_EDIT_MISMATCH edit=${label}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function boundaryBlock(source, id) {
  const startToken = `  - id: ${id}\n`;
  const start = source.indexOf(startToken);
  if (start < 0) {throw new Error(`ROLLBACK_BOUNDARY_MISSING id=${id}`);}
  const next = source.indexOf("\n  - id: ", start + startToken.length);
  return source.slice(start, next < 0 ? source.length : next + 1);
}

export function restoreArchitectureBoundaries(root, manifest, sharedPlan, workspaceHandle) {
  const path = "architecture/foundation/source-dependencies.yaml";
  const baseline = run("git", ["show", `${manifest.baselineSha}:architecture/foundation/source-dependencies.yaml`], { cwd: root });
  editRollbackSharedText(root, path, sharedPlan, workspaceHandle, (source) =>
    restoreArchitectureBoundarySource(source, baseline, manifest.sliceId));
}

export function restoreArchitectureBoundarySource(source, baseline, sliceId) {
  const prefix = sliceId === "slither" ? "tooling.slither" : `tooling.${sliceId}`;
  let current = source;
  for (const layer of ["domain", "application", "adapters", "composition"]) {
    const id = `${prefix}.${layer}`;
    current = replaceExactly(
      current,
      boundaryBlock(current, id),
      boundaryBlock(baseline, id),
      `boundary:${id}`,
    );
  }
  // Slice apply deletes the slice's source files. Schema v3 treats missing
  // boundary roots as invalid input, so the applied policy must be schema v1.
  // Linux-parity rereads the applied file, so header demotion is idempotent.
  if (current.startsWith("schemaVersion: 3\n")) {
    current = replaceExactly(current, "schemaVersion: 3\n", "schemaVersion: 1\n", "schemaVersion");
    current = replaceExactly(
      current,
      "packageRoots:\n  - packages/contexts/supply\n  - packages/domain\nrootPackage: true\n",
      "",
      "v3-package-roots",
    );
  } else if (!current.startsWith("schemaVersion: 1\n")) {
    throw new Error("ROLLBACK_SOURCE_SCHEMA_UNSUPPORTED");
  }
  return current;
}

export function restoreDeploymentPlanSharedEdits(root, sharedPlan, workspaceHandle) {
  for (const path of deploymentPlanSharedEditBaseline.paths) {
    const content = run("git", [
      "show", `${deploymentPlanSharedEditBaseline.sha}:${path}`,
    ], { cwd: root });
    restoreRollbackSharedFile(root, path, sharedPlan, workspaceHandle, content);
  }
}

export function editPackage(root, sliceId, options = {}) {
  const path = "package.json";
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => !["sharedPlan", "workspaceHandle"].includes(key))) {
    throw new Error("ROLLBACK_PACKAGE_EDIT_OPTIONS_INVALID");
  }
  const workspaceHandle = options.workspaceHandle;
  const sharedPlan = options.sharedPlan
    ?? snapshotRollbackSharedPaths(root, [path], workspaceHandle);
  const configuration = {
    "local-solana": {
      remove: ["solana:fixture:local", "test:local-solana"],
      typecheck: " && tsc -p tooling/local-solana/tsconfig.json --pretty false",
      check: " && pnpm test:local-solana",
    },
    "deployment-plan": {
      remove: ["deployment:estimate:local", "deployment:readiness", "test:deployment-plan"],
      typecheck: " && tsc -p tooling/deployment-plan/tsconfig.json --pretty false",
      check: " && pnpm test:deployment-plan",
    },
    slither: {
      remove: ["security:slither:test", "security:solidity", "security:solidity:prepare-image", "check:release"],
      typecheck: " && tsc -p tooling/security/slither/tsconfig.json --pretty false",
      check: " && pnpm security:slither:test",
    },
  }[sliceId];
  editRollbackSharedText(root, path, sharedPlan, workspaceHandle, (source) => {
    const document = JSON.parse(source);
    for (const key of configuration.remove) {
      if (!(key in document.scripts)) {
        throw new Error(`ROLLBACK_PACKAGE_SCRIPT_MISSING key=${key}`);
      }
      delete document.scripts[key];
    }
    document.scripts.typecheck = replaceExactly(
      document.scripts.typecheck,
      configuration.typecheck,
      "",
      `${sliceId}:typecheck`,
    );
    document.scripts.check = replaceExactly(
      document.scripts.check,
      configuration.check,
      "",
      `${sliceId}:check`,
    );
    document.scripts.check = replaceExactly(
      document.scripts.check,
      " && pnpm rollback:test",
      "",
      `${sliceId}:rollback-test-suffix`,
    );
    for (const key of [
      "check:linux",
      "rollback:evidence:validate",
      "rollback:preflight",
      "rollback:prove",
      "rollback:test",
    ]) {
      if (!(key in document.scripts)) {
        throw new Error(`ROLLBACK_PACKAGE_SCRIPT_MISSING key=${key}`);
      }
      delete document.scripts[key];
    }
    return `${JSON.stringify(document, null, 2)}\n`;
  });
}

function workflowJobBlock(source, job) {
  const start = source.indexOf(`\n  ${job}:\n`);
  if (start < 0) {throw new Error(`ROLLBACK_WORKFLOW_JOB_MISSING job=${job}`);}
  const nextMatch = [...source.matchAll(/^  [a-z0-9-]+:\n/gmu)]
    .find(({ index }) => index > start + 1);
  const next = nextMatch?.index ?? source.length;
  return source.slice(start, next);
}

export function removeWorkflowJob(root, manifest, sharedPlan, workspaceHandle) {
  const sliceId = manifest.sliceId;
  const job = {
    "local-solana": "local-solana-e2e",
    "deployment-plan": "deployment-plan-e2e",
    slither: "solidity-security",
  }[sliceId];
  const path = ".github/workflows/ci.yml";
  const baseline = run("git", ["show", `${manifest.baselineSha}:${path}`], { cwd: root });
  editRollbackSharedText(root, path, sharedPlan, workspaceHandle, (source) => {
    let result = replaceExactly(
      source,
      workflowJobBlock(source, "foundation-and-typescript"),
      workflowJobBlock(baseline, "foundation-and-typescript"),
      `${sliceId}:foundation-rollback-proof-wiring`,
    );
    const start = result.indexOf(`\n  ${job}:\n`);
    if (start < 0) {throw new Error(`ROLLBACK_WORKFLOW_JOB_MISSING job=${job}`);}
    const nextMatch = [...result.matchAll(/^  [a-z0-9-]+:\n/gmu)]
      .find(({ index }) => index > start + 1);
    const next = nextMatch?.index ?? -1;
    result = `${result.slice(0, start)}${next < 0 ? "\n" : result.slice(next)}`;
    return result;
  });
}

function removeTestBlock(source, titlePrefix) {
  const start = source.indexOf(`test("${titlePrefix}`);
  if (start < 0) {throw new Error(`ROLLBACK_WORKFLOW_TEST_MISSING title=${titlePrefix}`);}
  const next = source.indexOf("\ntest(\"", start + 6);
  if (next < 0) {throw new Error(`ROLLBACK_WORKFLOW_TEST_BOUNDARY_MISSING title=${titlePrefix}`);}
  return `${source.slice(0, start)}${source.slice(next + 1)}`;
}

function testBlock(source, titlePrefix) {
  const start = source.indexOf(`test("${titlePrefix}`);
  if (start < 0) {throw new Error(`ROLLBACK_WORKFLOW_TEST_MISSING title=${titlePrefix}`);}
  if (source.indexOf(`test("${titlePrefix}`, start + 6) >= 0) {
    throw new Error(`ROLLBACK_WORKFLOW_TEST_AMBIGUOUS title=${titlePrefix}`);
  }
  const next = source.indexOf("\ntest(\"", start + 6);
  if (next < 0) {throw new Error(`ROLLBACK_WORKFLOW_TEST_BOUNDARY_MISSING title=${titlePrefix}`);}
  return source.slice(start, next + 1);
}

export function editWorkflowTest(root, manifest, sharedPlan, workspaceHandle) {
  const sliceId = manifest.sliceId;
  const path = "scripts/tests/workflow.test.mjs";
  const baseline = run("git", ["show", `${manifest.baselineSha}:${path}`], { cwd: root });
  const configuration = {
    "local-solana": ["    \"local-solana-e2e\",\n", "local Solana job", "\"test:local-solana\", "],
    "deployment-plan": ["    \"deployment-plan-e2e\",\n", "deployment-plan job", "\"test:deployment-plan\", "],
    slither: ["    \"solidity-security\",\n", "Slither job", "\"security:slither:test\"",],
  }[sliceId];
  editRollbackSharedText(root, path, sharedPlan, workspaceHandle, (input) => {
    let source = replaceExactly(
      input,
      `  for (const [name, job] of Object.entries(workflow.jobs)) {\n`
        + `    assert.equal(job["runs-on"], "ubuntu-24.04");\n`
        + `    assert.ok(Number.isInteger(job["timeout-minutes"]));\n`
        + `    if (name === "foundation-and-typescript") {\n`
        + `      assert.equal(job["timeout-minutes"], 120);\n`
        + `      assert.equal(job.needs, undefined);\n`
        + `    } else {\n`
        + `      assert.ok(job["timeout-minutes"] <= 20, name);\n`
        + `    }\n`
        + `  }`,
      `  for (const job of Object.values(workflow.jobs)) {\n`
        + `    assert.equal(job["runs-on"], "ubuntu-24.04");\n`
        + `    assert.ok(Number.isInteger(job["timeout-minutes"]));\n`
        + `    assert.ok(job["timeout-minutes"] <= 20);\n`
        + `  }`,
      `${sliceId}:workflow-foundation-timeout-test`,
    );
    source = replaceExactly(
      source,
      "uses.filter((value) => value.startsWith(\"actions/upload-artifact@\")).length,\n    3,",
      "uses.filter((value) => value.startsWith(\"actions/upload-artifact@\")).length,\n    1,",
      `${sliceId}:workflow-proof-upload-count`,
    );
    source = replaceExactly(
      source,
      testBlock(source, "every job asserts exact clean GITHUB_SHA"),
      testBlock(baseline, "every job asserts exact clean GITHUB_SHA"),
      `${sliceId}:workflow-history-test`,
    );
    source = replaceExactly(
      source,
      testBlock(source, "foundation job proves complete exact history"),
      testBlock(baseline, "foundation and TypeScript job bootstraps verified pnpm"),
      `${sliceId}:workflow-foundation-proof-test`,
    );
    source = replaceExactly(
      source,
      `  assert.equal(\n`
        + `    packageJson.scripts["check:linux"],\n`
        + `    "pnpm rollback:preflight && pnpm check && pnpm rollback:prove",\n`
        + `  );`,
      `  assert.equal(packageJson.scripts["check:linux"], undefined);`,
      `${sliceId}:workflow-linux-check-policy`,
    );
    source = replaceExactly(
      source,
      `  assert.match(\n`
        + `    workflow.jobs["foundation-and-typescript"].steps\n`
        + `      .find((step) => step.id === "run-root-check-with-exact-rollback-proof").run,\n`
        + `    /pnpm check:linux$/u,\n`
        + `  );`,
      `  assert.equal(\n`
        + `    workflow.jobs["foundation-and-typescript"].steps\n`
        + `      .find((step) => step.id === "run-root-check-with-exact-rollback-proof"),\n`
        + `    undefined,\n`
        + `  );\n`
        + `  assert.equal(\n`
        + `    workflow.jobs["foundation-and-typescript"].steps\n`
        + `      .find((step) => step.name === "Final repository check").run,\n`
        + `    "source scripts/env.sh && pnpm check",\n`
        + `  );`,
      `${sliceId}:workflow-root-check-policy`,
    );
    source = replaceExactly(source, configuration[0], "", `${sliceId}:workflow-job-list`);
    source = removeTestBlock(source, configuration[1]);
    source = replaceExactly(source, configuration[2], "", `${sliceId}:workflow-check-list`);
    if (sliceId === "slither") {
      source = replaceExactly(
        source,
        testBlock(source, "actual workflow Node validation ignores inherited preload and proxy authority"),
        "",
        "slither:workflow-node-validation-test",
      );
      source = replaceExactly(
        source,
        'import { spawnSync } from "node:child_process";\n',
        "",
        "slither:workflow-node-child-process-import",
      );
      source = replaceExactly(
        source,
        'import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";\n',
        'import { readFileSync } from "node:fs";\n',
        "slither:workflow-node-fs-import",
      );
      source = replaceExactly(
        source,
        'import { tmpdir } from "node:os";\n',
        "",
        "slither:workflow-node-os-import",
      );
      source = replaceExactly(
        source,
        "uses.filter((value) => value.startsWith(\"actions/upload-artifact@\")).length,\n    1,",
        "uses.filter((value) => value.startsWith(\"actions/upload-artifact@\")).length,\n    0,",
        "slither:upload-action-count",
      );
    }
    return source;
  });
}

export function editToolchain(root, sliceId, sharedPlan, workspaceHandle) {
  const path = "tooling/toolchain.lock.json";
  const [startToken, nextToken, label] = sliceId === "local-solana"
    ? ["    \"splPrograms\": {\n", "    \"ccipSdk\": {\n", "ROLLBACK_TOOLCHAIN_SPL_MISSING"]
    : ["      \"runtime\": {\n", "      \"embeddedForgeVersion\":", "ROLLBACK_TOOLCHAIN_SLITHER_RUNTIME_MISSING"];
  editRollbackSharedText(root, path, sharedPlan, workspaceHandle, (source) => {
    const start = source.indexOf(startToken);
    const next = source.indexOf(nextToken, start + startToken.length);
    if (start < 0 || next < 0) {throw new Error(label);}
    const result = `${source.slice(0, start)}${source.slice(next)}`;
    JSON.parse(result);
    return result;
  });
}
