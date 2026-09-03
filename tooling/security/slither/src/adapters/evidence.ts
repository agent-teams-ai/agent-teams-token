import { chmod, constants, copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AnalysisInput, GateErrorCode, GateManifest, PolicyDecision } from "../domain/model.ts";
import { SlitherGateError } from "../domain/model.ts";
import { classifyGateFailure } from "../application/failure.ts";
import { sha256 } from "./fingerprint.ts";
import { IMAGE, IMAGE_REVISION } from "./container-contract.ts";
import { assertAnalysisEvidenceSemantics, renderAnalysisSummary, validateFinalizedEvidenceBundle } from "./evidence-bundle.ts";
import { assertSerializedAgainstSchema } from "./json-schema.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
const stable = (value: unknown): string => `${JSON.stringify(canonical(value), null, 2)}\n`;
const READY_EVIDENCE_FILES = ["READY", "artifact.json", "build-info.json", "detector-inventory.json", "evidence.json", "fixture-artifact.json", "fixture-build-info.json", "slither-inventory.json", "slither-status.json", "slither.json", "summary.md"] as const;

interface ReadyEvidenceRequest {
  readonly output: string;
  readonly candidateSha: string;
  readonly manifest: GateManifest;
  readonly input: AnalysisInput;
  readonly decision: PolicyDecision;
  readonly hashes: { readonly config: string; readonly policy: string };
  readonly triageHash: string;
  readonly schemaDirectory: string;
  readonly canonicalDirectory?: string;
  readonly assertReadyPrecondition: () => Promise<void>;
  readonly publication: PublicationCapability;
}

interface FailureEvidenceRequest {
  readonly output: string;
  readonly candidateSha: string;
  readonly category: "tool-failure" | "output-failure" | "environment-failure";
  readonly exitCode: 30 | 40 | 50;
  readonly stage: string;
  readonly errorCode: GateErrorCode;
  readonly schemaDirectory: string;
  readonly assertReadyPrecondition: () => Promise<void>;
  readonly publication: PublicationCapability;
}

type EnvironmentFailureRequest = Omit<FailureEvidenceRequest, "category" | "exitCode">;

export async function writeReadyEvidence(request: ReadyEvidenceRequest): Promise<void> {
  const { output, candidateSha, manifest, input, decision, hashes } = request;
  await publish(output, async (staging) => {
    const suppressed = new Set(decision.suppressed.map(({ fingerprint }) => fingerprint));
    const blocking = new Set(decision.blocking.map(({ fingerprint }) => fingerprint));
    const findings = input.findings.map((finding) => ({
      detectorId: finding.detectorId, impact: finding.impact, confidence: finding.confidence,
      identity: finding.identity, findingIdentityHash: finding.findingIdentityHash,
      fingerprint: finding.fingerprint, path: finding.location.path, start: finding.location.start,
      length: finding.location.length, sourceHash: finding.location.sourceHash,
      snippetHash: finding.location.snippetHash, blocking: blocking.has(finding.fingerprint),
      suppressed: suppressed.has(finding.fingerprint),
    }));
    const perImpact = Object.fromEntries(["High", "Medium", "Low", "Informational", "Optimization"]
      .map((impact) => [impact, findings.filter((finding) => finding.impact === impact).length]));
    const evidence = {
    schemaVersion: 1, ready: true, candidateSha,
    execution: executionIdentity(),
    tools: { image: IMAGE, indexDigest: "sha256:10c058d04f18a572f003e786ecf4e7f396a64137b2d6a9484fff2996621535a8", imageRevision: IMAGE_REVISION, slither: "0.11.6", cryticCompile: "0.4.2", forge: "1.8.0", forgeBinarySha256: `sha256:${input.forgeBinarySha256}`, solc: "0.8.36+commit.8a079791", solcBinarySha256: `sha256:${input.solcBinarySha256}` },
    inputs: { closureHash: `sha256:${sha256(JSON.stringify([...manifest.sources, ...manifest.config, manifest.detectorInventory]))}`, configHash: `sha256:${hashes.config}`, policyHash: `sha256:${hashes.policy}`, triageHash: `sha256:${request.triageHash}` },
    analysis: { compiler: { buildInfoSha256: `sha256:${input.compilerEvidence.buildInfoSha256}`, compilerInputSha256: `sha256:${input.compilerEvidence.compilerInputSha256}`, compilerSettingsSha256: `sha256:${input.compilerEvidence.compilerSettingsSha256}`, compilerInput: input.compilerEvidence.compilerInput, compilerSettings: input.compilerEvidence.compilerSettings, sourceHashes: input.compilerEvidence.sourceHashes.map(({path, sha256}) => ({path, sha256: `sha256:${sha256}`})), artifactSha256: `sha256:${input.compilerEvidence.artifactSha256}`, abiSha256: `sha256:${input.compilerEvidence.abiSha256}`, creationBytecode: input.compilerEvidence.creationBytecode, creationBytecodeSha256: `sha256:${input.compilerEvidence.creationBytecodeSha256}` }, fixture: { sourceSha256: `sha256:${input.fixtureProof.sourceSha256}`, buildInfoSha256: `sha256:${input.fixtureProof.buildInfoSha256}`, artifactSha256: `sha256:${input.fixtureProof.artifactSha256}`, abiSha256: `sha256:${input.fixtureProof.abiSha256}`, creationBytecodeSha256: `sha256:${input.fixtureProof.creationBytecodeSha256}` }, expectedTargets: manifest.expectedContracts, observedTargets: input.analyzedContracts, expectedSources: manifest.sources.map(({ path }) => path.replace(/^contracts\/evm\//u, "")), observedSources: input.analyzedSources, creationBytecodeSha256: `sha256:${input.creationBytecodeSha256}`, detectors: input.detectorInventory, findingCount: input.findings.length, perImpact, findings, suppressions: decision.suppressed.length, triaged: request.triageHash.length > 0 ? decision.visible.filter(({ impact }) => impact === "Low" || impact === "Informational" || impact === "Optimization").length : 0 },
    policy: { blocking: decision.blocking.length, visible: decision.visible.length, suppressed: decision.suppressed.length, errors: decision.errors },
    result: { category: decision.category, exitCode: decision.exitCode }, sanitised: true,
  };
    const serialized = stable(evidence);
    await assertSerializedAgainstSchema(serialized, join(request.schemaDirectory, "evidence-report.schema.v1.json"));
    assertAnalysisEvidenceSemantics(evidence);
    await writeFile(join(staging, "evidence.json"), serialized, { mode: 0o600, flag: "wx" });
    await writeFile(join(staging, "summary.md"), renderAnalysisSummary(evidence), { mode: 0o600, flag: "wx" });
    const rawFindings = input.findings.map((finding) => ({
      detectorId: finding.detectorId, impact: finding.impact, confidence: finding.confidence,
      identity: finding.identity, path: finding.location.path, start: finding.location.start,
      length: finding.location.length, sourceHash: finding.location.sourceHash,
      snippetHash: finding.location.snippetHash,
    }));
    await writeFile(join(staging, "build-info.json"), input.compilerEvidence.rawBuildInfo, { mode: 0o600, flag: "wx" });
    await writeFile(join(staging, "artifact.json"), input.compilerEvidence.rawArtifact, { mode: 0o600, flag: "wx" });
    await writeFile(join(staging, "fixture-build-info.json"), input.fixtureProof.rawBuildInfo, { mode: 0o600, flag: "wx" });
    await writeFile(join(staging, "fixture-artifact.json"), input.fixtureProof.rawArtifact, { mode: 0o600, flag: "wx" });
    await writeFile(join(staging, "slither.json"), stable({ schemaVersion: 1, success: input.success, errors: input.analysisErrors, findings: rawFindings }), { mode: 0o600, flag: "wx" });
    await writeFile(join(staging, "slither-inventory.json"), stable({ schemaVersion: 1, success: input.success, contracts: input.analyzedContracts, sources: input.analyzedSources, errors: input.analysisErrors }), { mode: 0o600, flag: "wx" });
    await writeFile(join(staging, "detector-inventory.json"), stable({ schemaVersion: 1, detectors: input.detectorInventory }), { mode: 0o600, flag: "wx" });
    await writeFile(join(staging, "slither-status.json"), stable({ schemaVersion: 1, analysisExit: input.findings.length === 0 ? 0 : 255, inventoryExit: 0 }), { mode: 0o600, flag: "wx" });
    await request.assertReadyPrecondition();
  }, async (staging) => await validateFinalizedEvidenceBundle({ output: staging, candidateSha, schemaDirectory: request.schemaDirectory, canonicalDirectory: request.canonicalDirectory }), READY_EVIDENCE_FILES, request.publication);
}

export async function writeEnvironmentFailure(request: EnvironmentFailureRequest): Promise<void> {
  await writeFailureEvidence({
    ...request,
    category: "environment-failure",
    exitCode: 50,
  });
}

export async function writeFailureEvidence(request: FailureEvidenceRequest): Promise<void> {
  const { output, candidateSha, category, exitCode, stage, errorCode } = request;
  const expectedExit = { "tool-failure": 30, "output-failure": 40, "environment-failure": 50 } as const;
  if (expectedExit[category] !== exitCode) {throw new SlitherGateError("EVIDENCE_BUNDLE_INVALID", "failure category is invalid");}
  const registered = classifyGateFailure(errorCode);
  if (registered.category !== category || registered.exitCode !== exitCode || registered.stage !== stage) {
    throw new SlitherGateError("EVIDENCE_BUNDLE_INVALID", "failure differs from the exhaustive registry");
  }
  const value = { schemaVersion: 1, ready: true, candidateSha, execution: executionIdentity(), image: IMAGE, category, exitCode, stage, errorCode, sanitised: true };
  const name = `${category}.json`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await assertSerializedAgainstSchema(serialized, join(request.schemaDirectory, `${category}.schema.v1.json`));
  await publish(output, async (staging) => {
    await writeFile(join(staging, name), serialized, { mode: 0o600, flag: "wx" });
    await request.assertReadyPrecondition();
  }, async (staging) => await validateFinalizedEvidenceBundle({ output: staging, candidateSha, schemaDirectory: request.schemaDirectory }), ["READY", name], request.publication);
}

function executionIdentity(): Record<string, string> {
  const names = ["GITHUB_EVENT_NAME", "GITHUB_REPOSITORY", "GITHUB_WORKFLOW", "GITHUB_JOB", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"] as const;
  if (process.env.GITHUB_ACTIONS === "true" && names.some((name) => !process.env[name])) {
    throw new SlitherGateError("EVIDENCE_BUNDLE_INVALID", "CI execution identity is incomplete");
  }
  return { platform: "linux/amd64", event: process.env.GITHUB_EVENT_NAME ?? "local", repository: process.env.GITHUB_REPOSITORY ?? "local", workflow: process.env.GITHUB_WORKFLOW ?? "local", job: process.env.GITHUB_JOB ?? "local", runId: process.env.GITHUB_RUN_ID ?? "local", runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1" };
}

export interface PublicationCapability { publishNoReplace(staging: string, output: string, expectedEntries: readonly string[]): Promise<void> }

/** Production publication reserves the destination atomically and copies READY last. */
export class ExclusiveDirectoryPublication implements PublicationCapability {
  async publishNoReplace(staging: string, output: string, expectedEntries: readonly string[]): Promise<void> {
    const parent = dirname(output); const ancestors = await ancestorIdentities(parent); const before = await directoryIdentity(parent, "publication parent");
    const staged = await directoryIdentity(staging, "publication staging");
    if ((staged.mode & 0o777n) !== 0o700n || staged.uid !== BigInt(process.getuid?.() ?? -1)) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "staging ownership is unsafe");}
    const entries = (await readdir(staging)).toSorted(); const expected = [...expectedEntries].toSorted();
    if (new Set(expected).size !== expected.length || JSON.stringify(entries) !== JSON.stringify(expected) || !entries.includes("READY")) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "staging contains missing or foreign entries");}
    await mkdir(output, {mode: 0o700});
    const published = await directoryIdentity(output, "publication output");
    try {
      await assertSameDirectory(parent, before, "publication parent");
      for (const name of entries.filter((name) => name !== "READY")) {await copyStableExclusive(join(staging, name), join(output, name));}
      await assertSameDirectory(staging, staged, "publication staging");
      const publishedEntries=(await readdir(output)).toSorted(); const expectedPublished=entries.filter((name)=>name!=="READY").toSorted();
      if(JSON.stringify(publishedEntries)!==JSON.stringify(expectedPublished)) throw new SlitherGateError("PUBLICATION_UNAVAILABLE","publication output contains foreign entries");
      for(const name of publishedEntries){const info=await lstat(join(output,name),{bigint:true});if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n||info.uid!==published.uid||(info.mode&0o777n)!==0o600n) throw new SlitherGateError("PUBLICATION_UNAVAILABLE","publication entry identity is unsafe");}
      await assertSameDirectory(parent, before, "publication parent");
      await assertAncestorIdentities(ancestors);
      await writeFile(join(output, "READY"), "", {mode: 0o600, flag: "wx"});
      await assertSameDirectory(output, published, "publication output");
    } catch (error) {throw error;}
  }
}

interface AncestorIdentity {readonly path:string;readonly identity:DirectoryIdentity}
async function ancestorIdentities(path:string):Promise<AncestorIdentity[]>{const values:AncestorIdentity[]=[];let current=path;while(true){values.push({path:current,identity:await directoryIdentity(current,"publication ancestor")});const next=dirname(current);if(next===current) return values;current=next;}}
async function assertAncestorIdentities(values:readonly AncestorIdentity[]):Promise<void>{for(const value of values) await assertSameDirectory(value.path,value.identity,"publication ancestor");}
interface DirectoryIdentity {readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly mode: bigint}
async function directoryIdentity(path: string, label: string): Promise<DirectoryIdentity> {
  const info = await lstat(path, {bigint: true});
  if (!info.isDirectory() || info.isSymbolicLink()) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", `${label} identity is invalid`);}
  return {dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode};
}
async function assertSameDirectory(path: string, expected: DirectoryIdentity, label: string): Promise<void> {const value=await directoryIdentity(path,label); if(value.dev!==expected.dev || value.ino!==expected.ino || value.uid!==expected.uid || value.mode!==expected.mode) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", `${label} changed`);}}
async function copyStableExclusive(source: string, destination: string): Promise<void> {
  const before=await lstat(source,{bigint:true}); if(!before.isFile() || before.isSymbolicLink() || before.nlink!==1n) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE","staging entry is unsafe");}
  const handle=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const opened=await handle.stat({bigint:true}); if(opened.dev!==before.dev||opened.ino!==before.ino) throw new SlitherGateError("PUBLICATION_UNAVAILABLE","staging entry changed"); await copyFile(`/proc/self/fd/${handle.fd}`,destination,constants.COPYFILE_EXCL); await chmod(destination,0o600); const after=await handle.stat({bigint:true}); if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||after.mtimeNs!==opened.mtimeNs) throw new SlitherGateError("PUBLICATION_UNAVAILABLE","staging entry changed");} finally {await handle.close();}
}

async function publish(output: string, build: (staging: string) => Promise<void>, finalize: (staging: string) => Promise<void>, expectedEntries: readonly string[], publication: PublicationCapability): Promise<void> {
  if (!publication || !output.startsWith("/") || (await lstat(output).catch(() => null)) !== null) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "fresh absolute output and publication capability are required");}
  const parent=dirname(output); const parentReal=await realpath(parent).catch(() => {throw new SlitherGateError("PUBLICATION_UNAVAILABLE","output parent is unavailable");});
  if(parentReal!==parent || output.includes("/../") || output.includes("//")) throw new SlitherGateError("PUBLICATION_UNAVAILABLE","output parent is unsafe");
  const staging=await mkdtemp(join(parent, `.${basename(output)}.staging-`)); await chmod(staging,0o700);
  try {await build(staging); await writeFile(join(staging,"READY"),"",{mode:0o600,flag:"wx"}); await finalize(staging); await publication.publishNoReplace(staging,output,expectedEntries);} finally {const info=await lstat(staging).catch(()=>null); if(info?.isDirectory()&&!info.isSymbolicLink()) await rm(staging,{recursive:true,force:true});}
}
