import { writeEnvironmentFailure } from "../adapters/evidence.ts";
import { OwnedProcess } from "../adapters/process.ts";
import { GitRepositoryState } from "../adapters/repository.ts";
import { classifyGateFailure, isGateErrorCode } from "../application/failure.ts";

const root = process.env.SLITHER_REPOSITORY_ROOT ?? process.cwd();
const candidateSha = process.env.GITHUB_SHA ?? process.env.SLITHER_CANDIDATE_SHA ?? "";
const output = process.env.SLITHER_EVIDENCE_DIRECTORY ?? `/tmp/agtmai-slither-evidence-${candidateSha}`;
if (!output.startsWith("/")) {throw new Error("absolute evidence path is required");}
const errorCode = process.env.SLITHER_FAILURE_CODE ?? "CI_PREREQUISITE_FAILED";
if (!/^[0-9a-f]{40}$/u.test(candidateSha)) {throw new Error("exact candidate SHA is required");}
if (!isGateErrorCode(errorCode)) {throw new Error("registered failure metadata is required");}
const classification = classifyGateFailure(errorCode);
if (classification.category !== "environment-failure") {throw new Error("CI prerequisite must be an environment failure");}
const repository = new GitRepositoryState(root, new OwnedProcess());
await repository.assertExactClean(candidateSha);
await writeEnvironmentFailure({
  output,
  candidateSha,
  stage: classification.stage,
  errorCode,
  schemaDirectory: `${root}/tooling/security/slither`,
  assertReadyPrecondition: async () => await repository.assertExactClean(candidateSha),
});
