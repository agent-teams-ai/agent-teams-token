import { resolveDockerCli } from "../adapters/executable.ts";
import { writeEnvironmentFailure } from "../adapters/evidence.ts";
import { pullPinnedImage } from "../adapters/image-preflight.ts";
import { OwnedProcess } from "../adapters/process.ts";
import { SlitherGateError } from "../domain/model.ts";

async function main(): Promise<void> {
  const output = process.env.SLITHER_EVIDENCE_DIRECTORY ?? `${process.cwd()}/slither-evidence`;
  if (!output.startsWith("/")) {
    throw new Error("absolute evidence path is required");
  }
  const candidateSha = process.env.GITHUB_SHA ?? process.env.SLITHER_CANDIDATE_SHA ?? "";
  if (!/^[0-9a-f]{40}$/u.test(candidateSha)) {
    throw new Error("exact candidate SHA is required");
  }

  try {
    const dockerPath = await resolveDockerCli(process.env.SLITHER_DOCKER_PATH ?? "");
    if (!await pullPinnedImage(new OwnedProcess(), dockerPath)) {
      await writeEnvironmentFailure(output, candidateSha, "image-pull", "IMAGE_PULL_FAILED");
      process.exitCode = 50;
    }
  } catch (error) {
    const code = error instanceof SlitherGateError ? error.code : "IMAGE_PREPARATION_FAILED";
    await writeEnvironmentFailure(output, candidateSha, "image-preflight", code);
    process.exitCode = 50;
  }
}

await main();
