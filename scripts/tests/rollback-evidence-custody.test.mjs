import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  closeEvidenceDirectory,
  createEvidenceDirectory,
  evidenceDirectoryPath,
  EvidenceRecorder,
  runEvidenceLifecycle,
  verifyEvidenceDirectory,
} from "../rollback/proof-runtime.mjs";

import { runSurvivorGate } from "../rollback/slices/gate-execution.mjs";

const repositoryRoot = resolve(new URL("../..", import.meta.url).pathname);

test("successful evidence lifecycle closes custody after publication work", () => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-evidence-lifecycle-"));
  const evidence = createEvidenceDirectory(undefined, root, repositoryRoot);
  const path = evidenceDirectoryPath(evidence);
  try {
    const result = runEvidenceLifecycle(
      evidence,
      () => new EvidenceRecorder(evidence, { mode: "custody-success" }),
      (recorder) => {
        recorder.finalize("prepared");
        return "complete";
      },
    );
    assert.equal(result, "complete");
    assert.equal(JSON.parse(readFileSync(join(path, "diagnostics.json"), "utf8")).status, "prepared");
    assert.throws(() => verifyEvidenceDirectory(evidence), /ROLLBACK_CUSTODY_HANDLE_CLOSED/u);
  } finally {
    closeEvidenceDirectory(evidence);
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained evidence custody refuses a foreign root successor", () => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-evidence-custody-"));
  const evidence = createEvidenceDirectory(undefined, root, repositoryRoot);
  const path = evidenceDirectoryPath(evidence);
  const heldPath = path + ".held";
  try {
    assert.throws(
      () => runEvidenceLifecycle(
        evidence,
        () => new EvidenceRecorder(evidence, { mode: "custody-regression" }),
        (recorder) => {
          renameSync(path, heldPath);
          mkdirSync(path, { mode: 0o700 });
          writeFileSync(
            join(path, "diagnostics.json"),
            '{"status":"successor-sentinel"}\n',
            { mode: 0o600 },
          );
          recorder.finalize("passed");
        },
      ),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_EVIDENCE_FAILURE_FINALIZATION_FAILED"
        && error.errors.every((entry) =>
          /ROLLBACK_EVIDENCE_CUSTODY_SUBSTITUTED/u.test(entry.message)),
    );
    assert.throws(() => verifyEvidenceDirectory(evidence), /ROLLBACK_CUSTODY_HANDLE_CLOSED/u);
    assert.equal(
      JSON.parse(readFileSync(join(heldPath, "diagnostics.json"), "utf8")).status,
      "running",
    );
    assert.equal(
      JSON.parse(readFileSync(join(path, "diagnostics.json"), "utf8")).status,
      "successor-sentinel",
    );
  } finally {
    closeEvidenceDirectory(evidence);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const survivor of ["slither", "local-solana"]) {
  test(`${survivor} gate prepares child evidence through real recorder custody`, () => {
    const root = mkdtempSync(join(tmpdir(), "agtmai-survivor-custody-"));
    const evidence = createEvidenceDirectory(undefined, root, repositoryRoot);
    const path = evidenceDirectoryPath(evidence);
    const invocations = [];
    try {
      runEvidenceLifecycle(evidence, () => new EvidenceRecorder(evidence, {}), (recorder) => {
        const run = recorder.run.bind(recorder);
        // Exercise production gate preparation and the real command recorder,
        // substituting only expensive external tools with a builtin child.
        recorder.run = (group, id, command, commandArguments, options) => {
          invocations.push({ group, id, command, commandArguments, options });
          const output = id === "slither-real-analyzer"
            ? options.env.SLITHER_EVIDENCE_DIRECTORY
            : id === "solana-real-fixture" ? commandArguments.at(-1) : undefined;
          const script = output === undefined
            ? "process.stdout.write('focused command\\n')"
            : "const fs = require('node:fs'); const p = process.argv[1]; "
              + "fs.mkdirSync(p, {mode: 0o700}); fs.writeFileSync(p + '/result.json', '{}');";
          return run(group, id, process.execPath, ["-e", script, ...(output === undefined ? [] : [output])], {
            ...options,
            cwd: repositoryRoot,
          });
        };
        for (const group of ["first-slice", "second-slice"]) {
          recorder.update(() => {});
          runSurvivorGate({
            survivor, root: repositoryRoot, rollbackSha: "d".repeat(40), recorder, group,
            tools: { pnpm: "/test/pnpm", node: process.execPath, docker: "/test/docker",
              forge: "/test/forge", solc: "/test/solc" },
            environment: {}, evidenceDirectory: path,
          });
          verifyEvidenceDirectory(evidence);
          assert.equal(readFileSync(join(path, "survivors", survivor, group, "result.json"), "utf8"), "{}");
        }
        recorder.prepareSurvivorDirectory(survivor === "slither" ? "local-solana" : "slither");
        recorder.finalize("prepared");
      });
      const expected = survivor === "slither"
        ? ["slither-unit", "slither-real-analyzer", "slither-evidence-validate"]
        : ["solana-offline-toolchain-verify", "solana-unit-and-strict-real", "solana-real-fixture"];
      assert.deepEqual(invocations.map(({ id }) => id), [...expected, ...expected]);
      const real = invocations[expected.length - (survivor === "slither" ? 2 : 1)];
      assert.deepEqual(real.commandArguments, survivor === "slither" ? ["security:solidity"]
        : ["solana:fixture:local", "--", "--output", join(path, "survivors", survivor, "first-slice")]);
      assert.equal(real.options.timeout, 900_000);
      if (survivor === "local-solana") {
        assert.equal(real.options.env.AGTMAI_SOLANA_REAL_TESTS_REQUIRED, "1");
      } else {
        assert.equal(real.options.env.SLITHER_CANDIDATE_SHA, "d".repeat(40));
        assert.deepEqual(invocations[2].commandArguments, ["tooling/security/slither/src/composition/validate-evidence.ts"]);
      }
      const diagnostics = JSON.parse(readFileSync(join(path, "diagnostics.json"), "utf8"));
      assert.equal(diagnostics.status, "prepared");
      assert.equal(diagnostics.commands.length, 6);
      assert.ok(diagnostics.commands.every(({ status }) => status === "passed"));
      assert.equal(existsSync(join(path, "READY")), false);
    } finally {
      closeEvidenceDirectory(evidence);
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const substitution of ["root", "ancestor", "survivors", "leaf", "symlink", "preexisting"]) {
    test(`${survivor} preparation rejects foreign ${substitution} and preserves files without READY`, () => {
      const root = mkdtempSync(join(tmpdir(), "agtmai-survivor-foreign-"));
      const parent = join(root, "parent");
      mkdirSync(parent);
      const evidence = createEvidenceDirectory(undefined, parent, repositoryRoot);
      const path = evidenceDirectoryPath(evidence);
      let foreign;
      try {
        assert.throws(() => runEvidenceLifecycle(evidence, () => new EvidenceRecorder(evidence, {}), (recorder) => {
          recorder.update(() => {});
          if (substitution !== "preexisting") {
            recorder.prepareSurvivorDirectory(survivor);
          }
          const target = substitution === "root" ? path
            : substitution === "ancestor" ? parent
              : substitution === "leaf" ? join(path, "survivors", survivor)
                : join(path, "survivors");
          if (substitution !== "preexisting") {
            renameSync(target, target + ".held");
          }
          foreign = substitution === "symlink" ? join(root, "foreign") : target;
          mkdirSync(foreign, { mode: 0o700 });
          writeFileSync(join(foreign, "sentinel"), "preserve foreign bytes");
          if (substitution === "symlink") {
            symlinkSync(foreign, target);
          }
          recorder.prepareSurvivorDirectory(survivor);
          assert.fail("foreign directory was accepted");
        }), (error) => {
          if (error instanceof AggregateError) {
            assert.equal(error.message, "ROLLBACK_EVIDENCE_FAILURE_FINALIZATION_FAILED");
            assert.ok(error.errors.every((entry) => /ROLLBACK_EVIDENCE_CUSTODY_SUBSTITUTED/u.test(entry.message)));
          } else {
            assert.match(error.message, /ROLLBACK_EVIDENCE_SURVIVOR_DIRECTORY_SUBSTITUTED|EEXIST/u);
          }
          return true;
        });
        assert.equal(readFileSync(join(foreign, "sentinel"), "utf8"), "preserve foreign bytes");
        assert.equal(existsSync(join(foreign, survivor)), false);
        assert.equal(existsSync(join(path, "READY")), false);
        assert.equal(existsSync(join(foreign, "READY")), false);
      } finally {
        closeEvidenceDirectory(evidence);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("prepared survivor command failure finalizes diagnostics without a custody aggregate", () => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-survivor-failure-"));
  const evidence = createEvidenceDirectory(undefined, root, repositoryRoot);
  const path = evidenceDirectoryPath(evidence);
  try {
    assert.throws(() => runEvidenceLifecycle(evidence, () => new EvidenceRecorder(evidence, {}), (recorder) => {
      recorder.prepareSurvivorDirectory("slither");
      recorder.prepareSurvivorDirectory("local-solana");
      recorder.run("focused", "failed-child", process.execPath, ["-e", "process.exit(23)"], {
        cwd: repositoryRoot, env: {},
      });
    }), /ROLLBACK_COMMAND_FAILED group=focused id=failed-child status=23/u);
    const diagnostics = JSON.parse(readFileSync(join(path, "diagnostics.json"), "utf8"));
    assert.equal(diagnostics.status, "failed");
    assert.equal(diagnostics.commands[0].exitCode, 23);
    assert.equal(existsSync(join(path, "READY")), false);
  } finally {
    closeEvidenceDirectory(evidence);
    rmSync(root, { recursive: true, force: true });
  }
});
