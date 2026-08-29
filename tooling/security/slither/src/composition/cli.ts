import { OwnedProcess } from "../adapters/process.ts";
import { writeFailureEvidence, writeReadyEvidence } from "../adapters/evidence.ts";
import { runGate } from "../adapters/runner.ts";
import { SlitherGateError } from "../domain/model.ts";

async function main(): Promise<void> {
  const root = process.env.SLITHER_REPOSITORY_ROOT ?? process.cwd();
  const output = process.env.SLITHER_EVIDENCE_DIRECTORY ?? `${process.cwd()}/slither-evidence`;
  if (!root.startsWith("/") || !output.startsWith("/")) throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "repository and evidence paths must be absolute");
  const sha = process.env.GITHUB_SHA ?? process.env.SLITHER_CANDIDATE_SHA ?? "";
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new SlitherGateError("CANDIDATE_SHA_INVALID", "exact candidate SHA is required");
  try {
    const result = await runGate(root, sha, new OwnedProcess(), process.env.SLITHER_FORGE_PATH ?? "", process.env.SLITHER_SOLC_PATH ?? "");
    await writeReadyEvidence(output, sha, result.manifest, result.input, result.decision, { config: result.configHash, policy: result.policyHash });
    process.exitCode = result.decision.exitCode;
  } catch (error) {
    const code = error instanceof SlitherGateError ? error.code : "UNEXPECTED_ENVIRONMENT_FAILURE";
    const outputFailureCodes = new Set(["MALFORMED_JSON", "DETECTOR_INVENTORY_INVALID", "SLITHER_EXIT_INVALID", "BUILD_INFO_INVALID", "COMPILER_SETTINGS_MISMATCH", "BYTECODE_MISSING"]);
    const outputFailure = outputFailureCodes.has(code);
    await writeFailureEvidence(output, sha, outputFailure ? "output-failure" : "environment-failure", outputFailure ? 40 : 50, "analysis", code);
    process.exitCode = outputFailure ? 40 : 50;
  }
}

await main();
