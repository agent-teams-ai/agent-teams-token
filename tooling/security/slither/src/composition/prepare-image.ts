import { OwnedProcess } from "../adapters/process.ts";
import { writeEnvironmentFailure } from "../adapters/evidence.ts";
import { pullPinnedImage } from "../adapters/image-preflight.ts";

const output = process.env.SLITHER_EVIDENCE_DIRECTORY ?? `${process.cwd()}/slither-evidence`;
if (!output.startsWith("/")) throw new Error("absolute evidence path is required");
const candidateSha = process.env.GITHUB_SHA ?? process.env.SLITHER_CANDIDATE_SHA ?? "";
if (!/^[0-9a-f]{40}$/u.test(candidateSha)) throw new Error("exact candidate SHA is required");
if (!await pullPinnedImage(new OwnedProcess())) {
  await writeEnvironmentFailure(output, candidateSha, "image-pull", "IMAGE_PULL_FAILED");
  process.exitCode = 50;
}
