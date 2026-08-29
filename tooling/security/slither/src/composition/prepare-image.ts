import { resolveDockerCli } from "../adapters/executable.ts";
import { writeEnvironmentFailure } from "../adapters/evidence.ts";
import { pullPinnedImage } from "../adapters/image-preflight.ts";
import { OwnedProcess } from "../adapters/process.ts";
import { GitRepositoryState } from "../adapters/repository.ts";
import { SlitherGateError } from "../domain/model.ts";
import { readAndAssertSlitherToolchain } from "../adapters/runner.ts";
import { classifyGateFailure } from "../application/failure.ts";
import type { GateErrorCode } from "../domain/model.ts";

async function main(): Promise<void> {
  const candidateSha = process.env.GITHUB_SHA ?? process.env.SLITHER_CANDIDATE_SHA ?? "";
  const output = process.env.SLITHER_EVIDENCE_DIRECTORY ?? `/tmp/agtmai-slither-evidence-${candidateSha}`;
  if (!output.startsWith("/")) {
    throw new Error("absolute evidence path is required");
  }
  if (!/^[0-9a-f]{40}$/u.test(candidateSha)) {
    throw new Error("exact candidate SHA is required");
  }
  const root = process.env.SLITHER_REPOSITORY_ROOT ?? process.cwd();
  const repository = new GitRepositoryState(root, new OwnedProcess());
  const failure = async (code: GateErrorCode): Promise<void> => {
    const classification = classifyGateFailure(code);
    if (classification.category !== "environment-failure") {throw new Error("image preparation emitted a non-environment failure");}
    await repository.assertExactClean(candidateSha);
    await writeEnvironmentFailure({
      output,
      candidateSha,
      stage: classification.stage,
      errorCode: code,
      schemaDirectory: `${root}/tooling/security/slither`,
      assertReadyPrecondition: async () => await repository.assertExactClean(candidateSha),
    });
  };

  try {
    await readAndAssertSlitherToolchain(root);
    const dockerPath = await resolveDockerCli(process.env.SLITHER_DOCKER_PATH ?? "");
    if (!await pullPinnedImage(new OwnedProcess(), dockerPath)) {
      await failure("IMAGE_PULL_FAILED");
      process.exitCode = 50;
    }
  } catch (error) {
    const code = error instanceof SlitherGateError ? error.code : "IMAGE_PREPARATION_FAILED";
    await failure(code);
    process.exitCode = 50;
  }
}

await main();
