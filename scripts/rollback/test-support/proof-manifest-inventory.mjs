import {
  assert, assertExactCleanCandidate, assertInventoryEqual, basicRun, git, gitExecutable,
  gitFixture, join, rmSync, trackedCandidateInventory, writeFileSync,
} from "./proof-fixture.mjs";

export function assertCandidateDirtRejected() {
  for (const mode of ["tracked", "staged", "untracked"]) {
    const fixture = gitFixture();
    try {
      assert.equal(assertExactCleanCandidate(fixture.root, fixture.sha), fixture.sha);
      if (mode === "untracked") {
        writeFileSync(join(fixture.root, "sentinel.untracked"), "must refuse\n");
      } else {
        writeFileSync(join(fixture.root, "alpha.txt"), mode + "\n");
        if (mode === "staged") {
          git(fixture.root, ["add", "alpha.txt"]);
        }
      }
      assert.throws(
        () => assertExactCleanCandidate(fixture.root, fixture.sha),
        /ROLLBACK_CANDIDATE_DIRTY/u,
      );
    } finally {
      rmSync(fixture.boundary, { recursive: true, force: true });
    }
  }
}

export function assertCandidateInventory() {
  const fixture = gitFixture();
  try {
    const expected = trackedCandidateInventory(fixture.root, fixture.sha);
    assert.equal(expected.entryCount, 4);
    assert.deepEqual(
      expected.entries.map(({ path, mode }) => [path, mode]),
      [
        ["alpha-link", "120000"],
        ["alpha.txt", "100644"],
        ["binary.bin", "100644"],
        ["executable.sh", "100755"],
      ],
    );
    const clone = join(fixture.boundary, "clone");
    basicRun(gitExecutable(), ["clone", "--quiet", "--no-hardlinks", fixture.root, clone], {
      cwd: fixture.boundary,
    });
    const actual = trackedCandidateInventory(clone, fixture.sha);
    assertInventoryEqual(expected, actual);

    writeFileSync(join(clone, "binary.bin"), Buffer.from([9, 8, 7]));
    const tampered = trackedCandidateInventory(clone, fixture.sha);
    assert.throws(
      () => assertInventoryEqual(expected, tampered, "tampered"),
      /ROLLBACK_INVENTORY_MISMATCH/u,
    );
  } finally {
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
}
