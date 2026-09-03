import { ExclusiveDirectoryPublication, writeEnvironmentFailure } from "../adapters/evidence.ts";
import { OwnedProcess } from "../adapters/process.ts";
import { GitRepositoryState } from "../adapters/repository.ts";
import { validateEnvironment } from "../adapters/validated-environment.ts";
import { classifyGateFailure, isGateErrorCode } from "../application/failure.ts";
import { SlitherGateError } from "../domain/model.ts";
try {
  const {repositoryRoot:root,candidateSha,output}=await validateEnvironment(process.env.SLITHER_REPOSITORY_ROOT??process.cwd(),[process.env.GITHUB_SHA,process.env.SLITHER_CANDIDATE_SHA],process.env.SLITHER_EVIDENCE_DIRECTORY);
  const errorCode=process.env.SLITHER_FAILURE_CODE??"CI_PREREQUISITE_FAILED";
  if(!isGateErrorCode(errorCode)) throw new SlitherGateError("UNEXPECTED_ENVIRONMENT_FAILURE","failure metadata is invalid");
  const classification=classifyGateFailure(errorCode); if(classification.category!=="environment-failure") throw new SlitherGateError("UNEXPECTED_ENVIRONMENT_FAILURE","failure category is invalid");
  const repository=new GitRepositoryState(root,new OwnedProcess()); await repository.assertExactClean(candidateSha);
  await writeEnvironmentFailure({output,candidateSha,stage:classification.stage,errorCode,schemaDirectory:`${root}/tooling/security/slither`,assertReadyPrecondition:async()=>await repository.assertExactClean(candidateSha),publication:new ExclusiveDirectoryPublication()});
} catch(error) {const code=error instanceof SlitherGateError?error.code:"UNEXPECTED_ENVIRONMENT_FAILURE";process.stderr.write(`SLITHER_ENVIRONMENT_FAILURE ${code}\n`);process.exitCode=50;}
