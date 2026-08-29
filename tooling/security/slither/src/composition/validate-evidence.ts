import { validateFinalizedEvidenceBundle } from "../adapters/evidence-bundle.ts";

const root = process.env.SLITHER_REPOSITORY_ROOT ?? process.cwd();
const candidateValues = [process.env.GITHUB_SHA, process.env.SLITHER_CANDIDATE_SHA]
  .filter((value): value is string => value !== undefined && value.length > 0);
const candidates = [...new Set(candidateValues)];
if (candidates.length !== 1 || !/^[0-9a-f]{40}$/u.test(candidates[0]!)) {
  throw new Error("one unambiguous exact candidate SHA is required");
}
const candidateSha = candidates[0]!;
const output = process.env.SLITHER_EVIDENCE_DIRECTORY ?? `/tmp/agtmai-slither-evidence-${candidateSha}`;

await validateFinalizedEvidenceBundle({
  output,
  candidateSha,
  schemaDirectory: `${root}/tooling/security/slither`,
});
