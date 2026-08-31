import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const historyScript = join(repositoryRoot, "scripts/assert-complete-history.sh");
const git = "/usr/bin/git";
const bash = "/usr/bin/bash";
const baselineSha = "b7a868f85d89c4bb7a9aeed1d854a5f949306a45";

function run(command, arguments_, options = {}) {
  return spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin", ...options.env },
  });
}

const candidateResult = run(git, ["rev-parse", "--verify", "HEAD^{commit}"], {
  cwd: repositoryRoot,
});
assert.equal(candidateResult.status, 0, candidateResult.stderr);
const candidateSha = candidateResult.stdout.trim();
assert.match(candidateSha, /^[a-f0-9]{40}$/u);

function makeClone({ depth } = {}) {
  const boundary = mkdtempSync(join(tmpdir(), "agtmai-rollback-history-test-"));
  const checkout = join(boundary, "checkout");
  const cloneArguments = ["clone", "--quiet"];
  if (depth !== undefined) {
    cloneArguments.push("--depth", String(depth));
  }
  cloneArguments.push(`file://${repositoryRoot}`, checkout);
  const result = run(git, cloneArguments);
  assert.equal(result.status, 0, result.stderr);
  return { boundary, checkout };
}

test("integrated CI requires complete exact-head history before cache and quality gates", () => {
  const request = JSON.parse(readFileSync(
    join(repositoryRoot, "architecture/rollback/ci-wiring-request.v1.json"),
    "utf8",
  ));
  assert.equal(request.status, "integrated-pending-execution");
  const workflowText = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const foundationStart = workflowText.indexOf("  foundation-and-typescript:\n");
  const foundationEnd = workflowText.indexOf("\n  solidity:\n", foundationStart);
  assert.ok(foundationStart >= 0 && foundationEnd > foundationStart);
  const foundation = workflowText.slice(foundationStart, foundationEnd);
  assert.match(foundation, /^    timeout-minutes: 120$/mu);
  assert.doesNotMatch(foundation, /^    needs:/mu);
  for (const expected of [
    "AGTMAI_ROLLBACK_TMPDIR: ${{ runner.temp }}",
    "AGTMAI_ROLLBACK_EVIDENCE_DIRECTORY: ${{ runner.temp }}/rollback-proof-${{ github.sha }}",
    "SLITHER_DOCKER_PATH: /usr/bin/docker",
    "SLITHER_FORGE_PATH: ${{ github.workspace }}/.tools/foundry-v1.8.0-linux-x64/forge",
    "SLITHER_SOLC_PATH: ${{ github.workspace }}/.tools/solc-v0.8.36-linux-x64/solc",
  ]) {
    assert.ok(foundation.includes(expected), expected);
  }

  const steps = request.existingJobPatch.steps;
  const checkout = steps.find(({ id }) => id === "checkout-complete-history-at-exact-head");
  assert.equal(checkout.uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.deepEqual(checkout.with, {
    ref: "${{ github.sha }}",
    "fetch-depth": 0,
    "persist-credentials": false,
  });
  assert.match(
    foundation,
    /id: checkout-complete-history-at-exact-head[\s\S]*?uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1[\s\S]*?ref: \$\{\{ github\.sha \}\}\n\s+fetch-depth: 0\n\s+persist-credentials: false/u,
  );
  const history = steps.find(({ id }) => id === "assert-complete-history-and-exact-clean-head-before");
  assert.match(history.run, /assert-complete-history\.sh "\$GITHUB_SHA" b7a868f85d89c4bb7a9aeed1d854a5f949306a45/u);
  const offline = steps.find(
    ({ id }) => id === "offline-install-and-verify-pinned-prerequisites",
  );
  assert.match(offline.run, /bootstrap verify --offline --scope=solana/u);
  const workspace = steps.find(
    ({ id }) => id === "install-frozen-source-workspace-and-populate-store",
  );
  assert.match(workspace.run, /pnpm install --frozen-lockfile/u);
  const image = steps.find(
    ({ id }) => id === "preload-pinned-slither-image",
  );
  const preflight = steps.find(
    ({ id }) => id === "non-pulling-rollback-environment-cache-preflight",
  );
  const rootCheck = steps.find(({ id }) => id === "run-root-check-with-exact-rollback-proof");
  assert.ok(steps.indexOf(checkout) < steps.indexOf(history));
  assert.ok(steps.indexOf(history) < steps.indexOf(offline));
  assert.ok(steps.indexOf(offline) < steps.indexOf(workspace));
  assert.ok(steps.indexOf(workspace) < steps.indexOf(image));
  assert.ok(steps.indexOf(image) < steps.indexOf(preflight));
  assert.ok(steps.indexOf(preflight) < steps.indexOf(rootCheck));
  assert.equal(
    preflight.run,
    "source scripts/env.sh && node scripts/rollback/prove-slices.mjs --preflight-only --expected-sha=\"$GITHUB_SHA\"",
  );
  assert.ok(foundation.includes("run: " + preflight.run));
  assert.ok(foundation.includes("run: source scripts/env.sh && pnpm check"));
  const historyAfter = steps.find(
    ({ id }) => id === "assert-complete-history-and-exact-clean-head-after",
  );
  assert.equal(historyAfter.if, "${{ always() }}");
  assert.match(historyAfter.run, /assert-complete-history\.sh "\$GITHUB_SHA"/u);
  assert.match(historyAfter.run, /assert-clean-head\.sh "\$GITHUB_SHA"/u);
  assert.equal(
    [...foundation.matchAll(/scripts\/assert-complete-history\.sh "\$GITHUB_SHA"/gu)].length,
    3,
  );
  assert.equal([...foundation.matchAll(/scripts\/assert-clean-head\.sh "\$GITHUB_SHA"/gu)].length, 3);
  assert.match(
    foundation,
    /id: assert-complete-history-and-exact-clean-head-after\n\s+if: \$\{\{ always\(\) \}\}/u,
  );
  assert.match(
    foundation,
    /id: validate-rollback-proof[\s\S]*?if: \$\{\{ success\(\) \}\}[\s\S]*?validate-evidence\.mjs[\s\S]*?id: upload-rollback-proof-evidence[\s\S]*?if: \$\{\{ success\(\) && steps\.validate-rollback-proof\.outcome == 'success' \}\}[\s\S]*?path: \$\{\{ runner\.temp \}\}\/rollback-proof-\$\{\{ github\.sha \}\}[\s\S]*?if-no-files-found: error/u,
  );
  assert.match(
    foundation,
    /id: upload-rollback-failure-diagnostics[\s\S]*?if: \$\{\{ failure\(\) \}\}[\s\S]*?name: rollback-diagnostics-[\s\S]*?diagnostics\.json[\s\S]*?if-no-files-found: warn/u,
  );
  const orderedIds = [
    "checkout-complete-history-at-exact-head",
    "assert-complete-history-and-exact-clean-head-before",
    "fetch-pinned-core-and-solana-prerequisites",
    "offline-install-and-verify-pinned-prerequisites",
    "install-frozen-source-workspace-and-populate-store",
    "preload-pinned-slither-image",
    "non-pulling-rollback-environment-cache-preflight",
    "run-root-check-with-exact-rollback-proof",
    "assert-complete-history-and-exact-clean-head-after",
    "validate-rollback-proof",
    "upload-rollback-proof-evidence",
    "upload-rollback-failure-diagnostics",
  ];
  const positions = orderedIds.map((id) => foundation.indexOf("id: " + id));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, positions.toSorted((left, right) => left - right));
  assert.match(request.proofContract.history, /non-shallow and non-partial/u);
  assert.match(request.proofContract.history, /replacement refs or legacy grafts/u);
  assert.match(request.proofContract.history, /replacement processing disabled/u);
  assert.match(request.proofContract.preflightOrdering, /before any dependent quality gate/u);
  assert.match(request.proofContract.slither, /non-pullingly inspect[\s\S]*exact linux\/amd64 image digest/u);
  const regeneration = request.coordinatedExternalChanges.finalIntegrationManifestRegeneration;
  assert.equal(regeneration.required, false);
  assert.equal(regeneration.status, "rehashed-worktree-validated-pending-exact-head-full-proof");
  assert.equal(regeneration.blocksValidationPreparationAndProof, false);
  assert.deepEqual(regeneration.manifests, [
    "architecture/rollback/local-solana.json",
    "architecture/rollback/deployment-plan.json",
    "architecture/rollback/slither.json",
  ]);
  assert.deepEqual(regeneration.knownStaleTransitions, []);
  assert.match(regeneration.acceptance, /full exact-head per-slice gate proof/u);
  assert.match(
    request.coordinatedExternalChanges.rollbackTransforms.join("\n"),
    /restore the foundation checkout[\s\S]*remove the complete-history assertion/u,
  );

  const proof = readFileSync(join(repositoryRoot, "scripts/rollback/slices/cli.mjs"), "utf8");
  const cliStart = proof.indexOf("export function runCli()");
  const cli = proof.slice(cliStart);
  const exactCandidate = cli.indexOf('"exact-clean-candidate"');
  const historyPreflight = cli.indexOf('"complete-history-preflight"');
  const candidateInventory = cli.indexOf('"candidate-complete-inventory"');
  const environmentPreflight = cli.indexOf('"global-offline-environment-preflight"');
  const materialization = cli.indexOf("proveSlice({");
  assert.ok(cliStart >= 0 && exactCandidate >= 0);
  assert.ok(historyPreflight > exactCandidate);
  assert.ok(candidateInventory > historyPreflight);
  assert.ok(environmentPreflight > candidateInventory);
  assert.ok(materialization > environmentPreflight);
  assert.match(
    cli.slice(historyPreflight, materialization),
    /assert-complete-history\.sh[\s\S]*phase: "preflight"/u,
  );
});

test("complete local history at the exact head passes", () => {
  const { boundary, checkout } = makeClone();
  try {
    const result = run(bash, [historyScript, candidateSha, baselineSha], { cwd: checkout });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`ROLLBACK_HISTORY_OK head=${candidateSha}`));
    assert.match(result.stdout, /inventoryEntries=[1-9][0-9]* inventorySha256=[a-f0-9]{64}/u);
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("byte-complete inventory rejects a stat-cache-preserving tracked-file substitution", () => {
  const { boundary, checkout } = makeClone();
  try {
    const target = join(checkout, "README.md");
    const before = statSync(target);
    const bytes = readFileSync(target);
    const forged = Buffer.from(bytes);
    forged[0] = forged[0] === 0x23 ? 0x20 : 0x23;
    writeFileSync(target, forged);
    utimesSync(target, before.atime, before.mtime);
    assert.equal(statSync(target).size, before.size);
    const result = run(bash, [historyScript, candidateSha, baselineSha], { cwd: checkout });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_INVENTORY_BYTES_MISMATCH/u);
    assert.doesNotMatch(result.stdout, /ROLLBACK_HISTORY_OK/u);
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("depth-one history fails before it can become rollback evidence", () => {
  const { boundary, checkout } = makeClone({ depth: 1 });
  try {
    const result = run(bash, [historyScript, candidateSha, baselineSha], { cwd: checkout });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_HISTORY_SHALLOW/u);
    assert.doesNotMatch(result.stdout, /ROLLBACK_HISTORY_OK/u);
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("an ambiguous or mismatched requested head fails closed", () => {
  const { boundary, checkout } = makeClone();
  try {
    const ambiguous = run(bash, [historyScript, "HEAD", baselineSha], { cwd: checkout });
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stderr, /ROLLBACK_HISTORY_SHA_INVALID/u);
    assert.doesNotMatch(ambiguous.stdout, /ROLLBACK_HISTORY_OK/u);

    const result = run(bash, [historyScript, baselineSha, baselineSha], { cwd: checkout });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_HISTORY_HEAD_MISMATCH/u);
    assert.doesNotMatch(result.stdout, /ROLLBACK_HISTORY_OK/u);
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("a missing pinned baseline and a promisor checkout both fail closed", () => {
  const { boundary, checkout } = makeClone();
  try {
    const missing = run(bash, [historyScript, candidateSha, "0000000000000000000000000000000000000000"], {
      cwd: checkout,
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /ROLLBACK_HISTORY_BASELINE_UNAVAILABLE/u);

    const config = run(git, ["config", "remote.origin.promisor", "true"], { cwd: checkout });
    assert.equal(config.status, 0, config.stderr);
    const partial = run(bash, [historyScript, candidateSha, baselineSha], { cwd: checkout });
    assert.notEqual(partial.status, 0);
    assert.match(partial.stderr, /ROLLBACK_HISTORY_PARTIAL_CLONE_FORBIDDEN/u);
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("a present baseline outside exact-head ancestry fails closed", () => {
  const { boundary, checkout } = makeClone();
  try {
    const identity = {
      GIT_AUTHOR_NAME: "Rollback History Test",
      GIT_AUTHOR_EMAIL: "rollback-history-test@invalid.local",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Rollback History Test",
      GIT_COMMITTER_EMAIL: "rollback-history-test@invalid.local",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
    const unrelated = run(git, [
      "commit-tree",
      `${candidateSha}^{tree}`,
      "-m",
      "test: unrelated rollback baseline",
    ], { cwd: checkout, env: identity });
    assert.equal(unrelated.status, 0, unrelated.stderr);
    const unrelatedSha = unrelated.stdout.trim();
    assert.match(unrelatedSha, /^[a-f0-9]{40}$/u);

    const result = run(bash, [historyScript, candidateSha, unrelatedSha], { cwd: checkout });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_HISTORY_BASELINE_NOT_ANCESTOR/u);
    assert.doesNotMatch(result.stdout, /ROLLBACK_HISTORY_OK/u);
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("replacement refs and legacy grafts cannot make history ambiguous", () => {
  const { boundary, checkout } = makeClone();
  try {
    const identity = {
      GIT_AUTHOR_NAME: "Rollback History Test",
      GIT_AUTHOR_EMAIL: "rollback-history-test@invalid.local",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Rollback History Test",
      GIT_COMMITTER_EMAIL: "rollback-history-test@invalid.local",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
    const tree = run(git, ["rev-parse", `${candidateSha}^{tree}`], { cwd: checkout });
    assert.equal(tree.status, 0, tree.stderr);
    const parent = run(git, ["rev-parse", `${candidateSha}^`], { cwd: checkout });
    assert.equal(parent.status, 0, parent.stderr);
    const replacement = run(git, [
      "commit-tree",
      tree.stdout.trim(),
      "-p",
      parent.stdout.trim(),
      "-m",
      "test: replacement history",
    ], { cwd: checkout, env: identity });
    assert.equal(replacement.status, 0, replacement.stderr);
    const replace = run(git, ["replace", candidateSha, replacement.stdout.trim()], { cwd: checkout });
    assert.equal(replace.status, 0, replace.stderr);

    const replaced = run(bash, [historyScript, candidateSha, baselineSha], { cwd: checkout });
    assert.notEqual(replaced.status, 0);
    assert.match(replaced.stderr, /ROLLBACK_HISTORY_REPLACEMENT_FORBIDDEN/u);
    assert.doesNotMatch(replaced.stdout, /ROLLBACK_HISTORY_OK/u);

    const hidden = run(bash, [historyScript, candidateSha, baselineSha], {
      cwd: checkout,
      env: {
        GIT_NAMESPACE: "hidden-namespace",
        GIT_REPLACE_REF_BASE: "refs/hidden-replacements",
      },
    });
    assert.notEqual(hidden.status, 0);
    assert.match(hidden.stderr, /ROLLBACK_HISTORY_REPLACEMENT_FORBIDDEN/u);
    assert.doesNotMatch(hidden.stdout, /ROLLBACK_HISTORY_OK/u);

    const deleteReplacement = run(git, ["replace", "-d", candidateSha], { cwd: checkout });
    assert.equal(deleteReplacement.status, 0, deleteReplacement.stderr);
    writeFileSync(join(checkout, ".git/info/grafts"), candidateSha + "\n");
    const grafted = run(bash, [historyScript, candidateSha, baselineSha], { cwd: checkout });
    assert.notEqual(grafted.status, 0);
    assert.match(grafted.stderr, /ROLLBACK_HISTORY_GRAFTS_FORBIDDEN/u);
    assert.doesNotMatch(grafted.stdout, /ROLLBACK_HISTORY_OK/u);
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("reachable objects supplied only by an alternate database fail closed", () => {
  const { boundary, checkout } = makeClone();
  try {
    const identity = {
      GIT_AUTHOR_NAME: "Rollback History Test",
      GIT_AUTHOR_EMAIL: "rollback-history-test@invalid.local",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Rollback History Test",
      GIT_COMMITTER_EMAIL: "rollback-history-test@invalid.local",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
    const tracked = join(checkout, "alternate-only.txt");
    writeFileSync(tracked, "reachable only through an alternate object database\n");
    assert.equal(run(git, ["add", "alternate-only.txt"], { cwd: checkout }).status, 0);
    const commit = run(git, ["commit", "--quiet", "-m", "test: alternate object"], {
      cwd: checkout,
      env: identity,
    });
    assert.equal(commit.status, 0, commit.stderr);
    const headResult = run(git, ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: checkout });
    assert.equal(headResult.status, 0, headResult.stderr);
    const head = headResult.stdout.trim();
    assert.match(head, /^[a-f0-9]{40}$/u);

    const localObject = join(checkout, ".git", "objects", head.slice(0, 2), head.slice(2));
    const alternateRoot = join(boundary, "alternate-objects");
    const alternateObject = join(alternateRoot, head.slice(0, 2), head.slice(2));
    mkdirSync(dirname(alternateObject), { recursive: true });
    renameSync(localObject, alternateObject);
    const alternatesFile = join(checkout, ".git", "objects", "info", "alternates");
    mkdirSync(dirname(alternatesFile), { recursive: true });
    writeFileSync(alternatesFile, alternateRoot + "\n");

    const fileAlternate = run(bash, [historyScript, head, baselineSha], { cwd: checkout });
    assert.notEqual(fileAlternate.status, 0);
    assert.match(
      fileAlternate.stderr,
      /ROLLBACK_HISTORY_ALTERNATES_FORBIDDEN source=file/u,
    );
    assert.doesNotMatch(fileAlternate.stdout, /ROLLBACK_HISTORY_OK/u);

    rmSync(alternatesFile);
    const environmentAlternate = run(bash, [historyScript, head, baselineSha], {
      cwd: checkout,
      env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateRoot },
    });
    assert.notEqual(environmentAlternate.status, 0);
    assert.match(
      environmentAlternate.stderr,
      /ROLLBACK_HISTORY_ALTERNATES_FORBIDDEN source=environment/u,
    );
    assert.doesNotMatch(environmentAlternate.stdout, /ROLLBACK_HISTORY_OK/u);
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});
