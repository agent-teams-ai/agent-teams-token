import { resolveDockerCli } from "../adapters/executable.ts";
import { writeEnvironmentFailure } from "../adapters/evidence.ts";
import { pullPinnedImage } from "../adapters/image-preflight.ts";
import { OwnedProcess } from "../adapters/process.ts";
import { GitRepositoryState } from "../adapters/repository.ts";
import { SlitherGateError } from "../domain/model.ts";

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
  const failure = async (stage: string, code: string): Promise<void> => {
    await repository.assertExactClean(candidateSha);
    await writeEnvironmentFailure(output, candidateSha, stage, code, `${root}/tooling/security/slither`, async () => await repository.assertExactClean(candidateSha));
  };

  try {
    const dockerPath = await resolveDockerCli(process.env.SLITHER_DOCKER_PATH ?? "");
    if (!await pullPinnedImage(new OwnedProcess(), dockerPath)) {
      await failure("image-pull", "IMAGE_PULL_FAILED");
      process.exitCode = 50;
    }
  } catch (error) {
    const code = error instanceof SlitherGateError ? error.code : "IMAGE_PREPARATION_FAILED";
    await failure("image-preflight", code);
    process.exitCode = 50;
  }
}

await main();
