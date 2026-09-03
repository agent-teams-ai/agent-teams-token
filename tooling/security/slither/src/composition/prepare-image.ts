import { resolveDockerCli } from "../adapters/executable.ts";
import { ExclusiveDirectoryPublication, writeEnvironmentFailure } from "../adapters/evidence.ts";
import { pullPinnedImage } from "../adapters/image-preflight.ts";
import { OwnedProcess } from "../adapters/process.ts";
import { GitRepositoryState } from "../adapters/repository.ts";
import { readAndAssertSlitherToolchain } from "../adapters/runner.ts";
import { validateEnvironment } from "../adapters/validated-environment.ts";
import { classifyGateFailure } from "../application/failure.ts";
import type { GateErrorCode } from "../domain/model.ts";
import { SlitherGateError } from "../domain/model.ts";

async function main():Promise<void>{
  try {
    const {repositoryRoot:root,candidateSha,output}=await validateEnvironment(process.env.SLITHER_REPOSITORY_ROOT??process.cwd(),[process.env.GITHUB_SHA,process.env.SLITHER_CANDIDATE_SHA],process.env.SLITHER_EVIDENCE_DIRECTORY);
    const repository=new GitRepositoryState(root,new OwnedProcess());
    const failure=async(code:GateErrorCode):Promise<void>=>{const value=classifyGateFailure(code); if(value.category!=="environment-failure") throw new SlitherGateError("IMAGE_PREPARATION_FAILED","image failure classification is invalid"); await repository.assertExactClean(candidateSha); await writeEnvironmentFailure({output,candidateSha,stage:value.stage,errorCode:code,schemaDirectory:`${root}/tooling/security/slither`,assertReadyPrecondition:async()=>await repository.assertExactClean(candidateSha),publication:new ExclusiveDirectoryPublication()});};
    try {await readAndAssertSlitherToolchain(root); const dockerPath=await resolveDockerCli(process.env.SLITHER_DOCKER_PATH??""); if(!await pullPinnedImage(new OwnedProcess(),dockerPath)){await failure("IMAGE_PULL_FAILED");process.exitCode=50;}}
    catch(error){const code=error instanceof SlitherGateError?error.code:"IMAGE_PREPARATION_FAILED";await failure(code);process.exitCode=50;}
  } catch(error){const code=error instanceof SlitherGateError?error.code:"IMAGE_PREPARATION_FAILED";process.stderr.write(`SLITHER_IMAGE_PREPARATION_FAILED ${code}\n`);process.exitCode=50;}
}
await main();
