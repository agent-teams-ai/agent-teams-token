import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GitRepositoryState } from "../src/adapters/repository.ts";
import { OwnedProcess } from "../src/adapters/process.ts";
import { validateEvidenceBundleContents, validateFinalizedEvidenceBundle } from "../src/adapters/evidence-bundle.ts";
import { writeEnvironmentFailure } from "../src/adapters/evidence.ts";
import { makeTestDirectory } from "./test-directory.ts";
import { testPublication } from "./test-publication.ts";

test("final validator binds clean HEAD and canonical bytes independently of matching SHA strings", async () => {
  const parent = await makeTestDirectory("exact-source-");
  const root = join(parent, "repo");
  const schema = join(root, "tooling/security/slither");
  const output = join(parent, "bundle");
  const git = (args: string[]): string => execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  try {
    await mkdir(schema, { recursive: true });
    for (const name of await readdir("tooling/security/slither")) {
      if (name.endsWith(".schema.v1.json")) { await copyFile(join("tooling/security/slither", name), join(schema, name)); }
    }
    const lockPath = join(root, "tooling/toolchain.lock.json");
    await copyFile("tooling/toolchain.lock.json", lockPath);
    git(["init", "--quiet"]);
    git(["add", "tooling"]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "test: canonical validator inputs"]);
    const candidateSha = git(["rev-parse", "HEAD"]).trim();
    const repository = new GitRepositoryState(root, new OwnedProcess());
    await writeEnvironmentFailure({ output, candidateSha, schemaDirectory: schema, stage: "image-preflight", errorCode: "IMAGE_UNAVAILABLE",
      assertReadyPrecondition: async () => { await repository.assertExactClean(candidateSha); }, publication: testPublication() });
    const request = { output, candidateSha, schemaDirectory: schema, finalizationMode: "local" as const };
    await validateFinalizedEvidenceBundle(request);
    const lock = await readFile(lockPath);
    await assert.rejects(repository.assertCanonicalBytes(candidateSha, "tooling/toolchain.lock.json", Buffer.from("altered")), { code: "INPUT_HASH_MISMATCH" });
    git(["update-index", "--assume-unchanged", "tooling/toolchain.lock.json"]);
    await writeFile(lockPath, Buffer.concat([lock, Buffer.from("\n")]));
    assert.equal(git(["status", "--porcelain=v1"]), "");
    // The former content-only validator accepts matching SHA strings and altered canonical bytes.
    await validateEvidenceBundleContents(request);
    await assert.rejects(validateFinalizedEvidenceBundle(request), { code: "INPUT_HASH_MISMATCH" });
    await writeFile(lockPath, lock);
    await assert.rejects(validateFinalizedEvidenceBundle({ ...request, candidateSha: "a".repeat(40) }), { code: "CANDIDATE_SHA_MISMATCH" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});
