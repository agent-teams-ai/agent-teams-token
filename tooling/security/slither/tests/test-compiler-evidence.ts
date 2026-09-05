import { sha256 } from "../src/adapters/fingerprint.ts";
import type { AnalysisInput, GateManifest } from "../src/domain/model.ts";

const fixtureSource = "contract Vulnerable {}\n";
export function makeCompilerEvidence(source: string, sourcePath = "src/A.sol", creationBytecode = "0x6000"): {readonly compilerEvidence: AnalysisInput["compilerEvidence"]; readonly fixtureProof: AnalysisInput["fixtureProof"]; readonly vulnerableFixture: GateManifest["vulnerableFixture"]; readonly fixtureSource: string} {
  const one = build(source, sourcePath, sourcePath === "src/A.sol" ? "A" : "AGTMAIToken", creationBytecode);
  const fixture = build(fixtureSource, "src/Vulnerable.sol", "Vulnerable", creationBytecode);
  const creationBytecodeSha256 = sha256(Buffer.from(creationBytecode.slice(2), "hex"));
  return {compilerEvidence: one.evidence, fixtureProof: {sourceSha256: sha256(fixtureSource), buildInfoSha256: fixture.evidence.buildInfoSha256, artifactSha256: fixture.evidence.artifactSha256, abiSha256: fixture.evidence.abiSha256, creationBytecodeSha256, rawBuildInfo: fixture.evidence.rawBuildInfo, rawArtifact: fixture.evidence.rawArtifact}, vulnerableFixture: {source: {path: "tooling/security/slither/tests/fixtures/Vulnerable.sol", sha256: sha256(fixtureSource)}, creationBytecodeSha256}, fixtureSource};
}
function build(source:string,path:string,contract:string,creationBytecode:string):{evidence:AnalysisInput["compilerEvidence"]}{
  const settings={evmVersion:"paris",optimizer:{enabled:true,runs:200},metadata:{bytecodeHash:"ipfs",appendCBOR:true,useLiteralContent:false},viaIR:false,experimental:false,remappings:["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/","openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/"],libraries:{}};
  const metadata={compiler:{version:"0.8.36+commit.8a079791"}}; const rawMetadata=JSON.stringify(metadata);
  const input={sources:{[path]:{content:source}},settings}; const artifact={abi:[],bytecode:{object:creationBytecode},metadata,rawMetadata}; const buildInfo={solcVersion:"0.8.36",solcLongVersion:"0.8.36",input,output:{contracts:{[path]:{[contract]:{metadata:rawMetadata,evm:{bytecode:{object:creationBytecode}}}}}}};
  const rawBuildInfo=`${JSON.stringify(buildInfo)}\n`; const rawArtifact=`${JSON.stringify(artifact)}\n`; const bytes=Buffer.from(creationBytecode.slice(2),"hex");
  return {evidence:{buildInfoSha256:sha256(rawBuildInfo),compilerInputSha256:sha256(JSON.stringify(input)),compilerSettingsSha256:sha256(JSON.stringify(settings)),compilerInput:input,compilerSettings:settings,sourceHashes:[{path,sha256:sha256(source)}],artifactSha256:sha256(rawArtifact),abiSha256:sha256(JSON.stringify(artifact.abi)),creationBytecode,creationBytecodeSha256:sha256(bytes),rawBuildInfo,rawArtifact}};
}
