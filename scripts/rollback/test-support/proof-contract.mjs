import * as proofSupport from "./proof-fixture.mjs";
const { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture } = proofSupport;
export { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture };

test("every operational package rollback strips proof recursion", () => {
  const source = readFileSync(join(repositoryRoot, "package.json"));
  for (const slice of ["local-solana", "deployment-plan", "slither"]) {
    const boundary = temporaryDirectory("agtmai-rollback-package-");
    const root = join(boundary, "checkout");
    const quarantineRoot = join(boundary, "gate-tmp");
    let workspaceHandle;
    try {
      mkdirSync(root);
      mkdirSync(quarantineRoot, { mode: 0o700 });
      writeFileSync(join(root, "package.json"), source);
      workspaceHandle = createRollbackWorkspaceHandle(root, quarantineRoot);
      editPackage(root, slice, { workspaceHandle });
      const transformedBytes = readFileSync(join(root, "package.json"));
      const transformed = JSON.parse(transformedBytes.toString("utf8"));
      assert.equal(transformed.scripts["rollback:preflight"], undefined);
      assert.equal(transformed.scripts["rollback:test"], undefined);
      assert.equal(transformed.scripts["rollback:prove"], undefined);
      assert.equal(transformed.scripts["check:linux"], undefined);
      assert.doesNotMatch(transformed.scripts.check, /rollback:(?:preflight|test|prove)/u);
      const manifest = manifests().find(({ sliceId }) => sliceId === slice);
      const expected = manifest.reverseEdits.find(({ path }) => path === "package.json").afterSha256;
      assert.equal(createHash("sha256").update(transformedBytes).digest("hex"), expected);
    } finally {
      closeRollbackWorkspaceHandle(workspaceHandle);
      rmSync(boundary, { recursive: true, force: true });
    }
  }
});

test("identity-bound cleanup refuses a parent swap and preserves a foreign sentinel", () => {
  const boundary = temporaryDirectory("agtmai-rollback-cleanup-");
  const target = mkdtempSync(join(boundary, "agtmai-rollback-local-solana-"));
  chmodSync(target, 0o700);
  const moved = target + ".moved";
  const foreign = join(boundary, "foreign");
  const checkout = join(target, "checkout");
  mkdirSync(checkout);
  mkdirSync(foreign);
  writeFileSync(join(checkout, "owned"), "owned\n");
  writeFileSync(join(foreign, "sentinel"), "foreign-must-survive\n");
  const handle = createCleanupHandle(target, {
    temporaryRoot: boundary,
    targetPrefix: "agtmai-rollback-local-solana-",
    allowedEntries: ["checkout"],
  });
  try {
    renameSync(target, moved);
    symlinkSync(foreign, target, "dir");
    assert.throws(
      () => cleanupIdentityBoundDirectory(handle),
      /ROLLBACK_CLEANUP_IDENTITY_MISMATCH/u,
    );
    assert.equal(readFileSync(join(foreign, "sentinel"), "utf8"), "foreign-must-survive\n");
    assert.equal(readFileSync(join(moved, "checkout/owned"), "utf8"), "owned\n");
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("identity-bound cleanup rejects a replacement directory and normal cleanup stays scoped", () => {
  const boundary = temporaryDirectory("agtmai-rollback-cleanup-directory-");
  const target = mkdtempSync(join(boundary, "agtmai-rollback-local-solana-"));
  chmodSync(target, 0o700);
  const moved = target + ".moved";
  const sibling = join(boundary, "sibling");
  const checkout = join(target, "checkout");
  mkdirSync(checkout);
  mkdirSync(sibling);
  writeFileSync(join(checkout, "owned"), "owned\n");
  writeFileSync(join(sibling, "sentinel"), "sibling-must-survive\n");
  const handle = createCleanupHandle(target, {
    temporaryRoot: boundary,
    targetPrefix: "agtmai-rollback-local-solana-",
    allowedEntries: ["checkout"],
  });
  try {
    renameSync(target, moved);
    mkdirSync(target);
    writeFileSync(join(target, "foreign-sentinel"), "foreign-must-survive\n");
    assert.throws(
      () => cleanupIdentityBoundDirectory(handle),
      /ROLLBACK_CLEANUP_IDENTITY_MISMATCH/u,
    );
    assert.equal(readFileSync(join(target, "foreign-sentinel"), "utf8"), "foreign-must-survive\n");
    assert.equal(readFileSync(join(moved, "checkout/owned"), "utf8"), "owned\n");
    assert.equal(readFileSync(join(sibling, "sentinel"), "utf8"), "sibling-must-survive\n");
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }

  const normalBoundary = temporaryDirectory("agtmai-rollback-cleanup-normal-");
  const normalTarget = mkdtempSync(join(normalBoundary, "agtmai-rollback-local-solana-"));
  chmodSync(normalTarget, 0o700);
  const normalSibling = join(normalBoundary, "sibling");
  const normalCheckout = join(normalTarget, "checkout");
  mkdirSync(normalCheckout);
  mkdirSync(normalSibling);
  writeFileSync(join(normalCheckout, "owned"), "owned\n");
  writeFileSync(join(normalSibling, "sentinel"), "survive\n");
  const normalHandle = createCleanupHandle(normalTarget, {
    temporaryRoot: normalBoundary,
    targetPrefix: "agtmai-rollback-local-solana-",
    allowedEntries: ["checkout"],
  });
  try {
    assert.equal(cleanupIdentityBoundDirectory(normalHandle).result, "contents-removed");
    assert.equal(existsSync(normalTarget), false);
    assert.equal(readFileSync(join(normalSibling, "sentinel"), "utf8"), "survive\n");
  } finally {
    rmSync(normalBoundary, { recursive: true, force: true });
  }
});

test("the append-only ledger prefix is frozen and provenance is explicit", () => {
  const path = join(
    repositoryRoot,
    "docs/research/NEXT-ZERO-COST-SLICES-IMPLEMENTATION-LEDGER-2026-08-29.md",
  );
  const bytes = readFileSync(path);
  assert.ok(bytes.length > historicalLedgerLength);
  assert.equal(
    createHash("sha256").update(bytes.subarray(0, historicalLedgerLength)).digest("hex"),
    historicalLedgerSha256,
  );
  const correction = bytes.subarray(historicalLedgerLength).toString("utf8");
  assert.match(correction, /^\n## Superseding correction/u);
  const lines = correction.split("\n");
  const expectedHeader = "| Job | Historical branch | Owned path | Recorded brief base | Original isolated worker identity | Published integrated identities |";
  const headerIndex = lines.indexOf(expectedHeader);
  assert.notEqual(headerIndex, -1);
  assert.equal(
    lines[headerIndex + 1],
    "| --- | --- | --- | --- | --- | --- |",
  );
  const expectedRows = new Map([
    ["W1 Solana", ["`feat/local-solana-fixture`", "`tooling/local-solana/**`", "`b7a868f`"]],
    ["W2 deploy plan", ["`feat/deployment-cost-plan`", "`tooling/deployment-plan/**`", "`b7a868f`"]],
    ["W3 Slither", ["`ci/slither-security-gate`", "`tooling/security/slither/**`", "`b7a868f`"]],
  ]);
  for (const [worker, fixedCells] of expectedRows) {
    const rows = lines.filter((line) => line.startsWith("| " + worker + " |"));
    assert.equal(rows.length, 1);
    const cells = rows[0].split("|").slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 6);
    assert.equal(cells[0], worker);
    assert.deepEqual(cells.slice(1, 4), fixedCells);
    assert.equal(cells[4], "`unavailable`");
    assert.notEqual(cells[5], "");
  }
  assert.equal(lines.filter((line) => /^\| W[123] /u.test(line)).length, 3);
  assert.match(correction, /Published commit ancestry is not original-worker provenance/u);
  assert.match(correction, /R7 delivery review verdict is `AMEND`, not acceptance/u);
  assert.match(
    correction,
    /proxy-disabled[\s\S]*Foundation dependency declarations[\s\S]*coordinated external lanes[\s\S]*does not close the direct-HTTP/u,
  );
});

test("current rollback documents record AMEND and leave transport changes to external lanes", () => {
  const plan = readFileSync(join(repositoryRoot, "docs", "PLAN.md"), "utf8");
  const status = readFileSync(join(repositoryRoot, "docs", "STATUS.md"), "utf8");
  const next = readFileSync(join(repositoryRoot, "docs", "NEXT_ZERO_COST_SLICES_PLAN.md"), "utf8");
  const readme = readFileSync(join(repositoryRoot, "architecture", "rollback", "README.md"), "utf8");
  const ledger = readFileSync(join(
    repositoryRoot,
    "docs/research/NEXT-ZERO-COST-SLICES-IMPLEMENTATION-LEDGER-2026-08-29.md",
  ));
  const planStart = plan.lastIndexOf("Superseding correction, 2026-08-29:");
  const statusStart = status.indexOf("## In progress");
  const nextEnd = next.indexOf("Этот документ описывает");
  const readmeEnd = readme.indexOf("## Candidate and disposable checkouts");
  assert.ok(planStart >= 0 && statusStart >= 0 && nextEnd > 0 && readmeEnd > 0);
  const documents = [
    plan.slice(planStart, plan.indexOf("\n\n", planStart)),
    status.slice(statusStart, status.indexOf("## Designed, not implemented", statusStart)),
    next.slice(0, nextEnd),
    readme.slice(0, readmeEnd),
    ledger.subarray(historicalLedgerLength).toString("utf8"),
  ];
  for (const source of documents) {
    assert.match(source, /R7|three local\/test-only\s+zero-cost slices/u);
    assert.match(source, /AMEND/u);
    assert.match(source, /not acceptance|not accepted|не принят|does not record[\s\S]*acceptance/iu);
    assert.match(source, /proxy-disabled/iu);
    assert.match(source, /Foundation\s+dependency\s+declarations/iu);
    assert.match(source, /coordinated[\s\S]*(?:lane|external)|отдельн[\s\S]*coordinated lane/iu);
    assert.match(source, /pending|remain|остаются/iu);
    assert.match(source, /direct-HTTP/u);
    assert.match(
      source,
      /do\s+not\s+(?:close|resolve)|does\s+not\s+close|stays\s+open|не\s+закрыт|не\s+закрыва(?:ет|ют)/iu,
    );
  }
  const readmeSection = documents[3];
  assert.match(readmeSection, /become operational only after[\s\S]*full proof passes/u);
  assert.doesNotMatch(readmeSection, /manifests are the operational removal authority/u);
  assert.match(readme, /continuously[\s\S]*same-UID[\s\S]*out of scope/u);
  assert.match(
    readme,
    /not an\s+audit, production readiness,[\s\S]*Devnet readiness,[\s\S]*Mainnet readiness/u,
  );
  assert.match(status, /same-UID peer[\s\S]*explicitly out of[\s\S]*scope/u);
  assert.match(status, /not an audit or production,[\s\S]*Devnet or\s+Mainnet readiness/u);
});
