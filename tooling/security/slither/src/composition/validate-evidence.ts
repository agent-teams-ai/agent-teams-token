import { validateFinalizedEvidenceBundle } from "../adapters/evidence-bundle.ts";
import { validateEnvironment } from "../adapters/validated-environment.ts";
import { SlitherGateError } from "../domain/model.ts";
try {
  const {repositoryRoot,candidateSha,output}=await validateEnvironment(process.env.SLITHER_REPOSITORY_ROOT??process.cwd(),[process.env.GITHUB_SHA,process.env.SLITHER_CANDIDATE_SHA],process.env.SLITHER_EVIDENCE_DIRECTORY);
  await validateFinalizedEvidenceBundle({output,candidateSha,schemaDirectory:`${repositoryRoot}/tooling/security/slither`});
} catch(error) {const code=error instanceof SlitherGateError?error.code:"EVIDENCE_BUNDLE_INVALID";process.stderr.write(`SLITHER_EVIDENCE_INVALID ${code}\n`);process.exitCode=40;}
