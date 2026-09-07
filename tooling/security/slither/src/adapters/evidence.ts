import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, type BigIntStats } from "node:fs";
import { constants, link, lstat, open, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AnalysisInput, GateErrorCode, GateManifest, PolicyDecision } from "../domain/model.ts";
import { SlitherGateError } from "../domain/model.ts";
import { assertNotCancelled } from "../application/ports.ts";
import { classifyGateFailure } from "../application/failure.ts";
import { sha256 } from "./fingerprint.ts";
import { IMAGE, IMAGE_REVISION } from "./container-contract.ts";
import { assertAnalysisEvidenceSemantics, renderAnalysisSummary, validateEvidenceBundleContents } from "./evidence-bundle.ts";
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
  await publish(output, async (write) => {
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
    analysis: { compiler: { buildInfoSha256: `sha256:${input.compilerEvidence.buildInfoSha256}`, compilerInputSha256: `sha256:${input.compilerEvidence.compilerInputSha256}`, compilerSettingsSha256: `sha256:${input.compilerEvidence.compilerSettingsSha256}`, compilerInput: input.compilerEvidence.compilerInput, compilerSettings: input.compilerEvidence.compilerSettings, sourceHashes: input.compilerEvidence.sourceHashes.map(({path, sha256: sourceSha256}) => ({path, sha256: `sha256:${sourceSha256}`})), artifactSha256: `sha256:${input.compilerEvidence.artifactSha256}`, abiSha256: `sha256:${input.compilerEvidence.abiSha256}`, creationBytecode: input.compilerEvidence.creationBytecode, creationBytecodeSha256: `sha256:${input.compilerEvidence.creationBytecodeSha256}` }, fixture: { sourceSha256: `sha256:${input.fixtureProof.sourceSha256}`, buildInfoSha256: `sha256:${input.fixtureProof.buildInfoSha256}`, artifactSha256: `sha256:${input.fixtureProof.artifactSha256}`, abiSha256: `sha256:${input.fixtureProof.abiSha256}`, creationBytecodeSha256: `sha256:${input.fixtureProof.creationBytecodeSha256}` }, expectedTargets: manifest.expectedContracts, observedTargets: input.analyzedContracts, expectedSources: manifest.sources.map(({ path }) => path.replace(/^contracts\/evm\//u, "")), observedSources: input.analyzedSources, creationBytecodeSha256: `sha256:${input.creationBytecodeSha256}`, detectors: input.detectorInventory, findingCount: input.findings.length, perImpact, findings, suppressions: decision.suppressed.length, triaged: request.triageHash.length > 0 ? decision.visible.filter(({ impact }) => impact === "Low" || impact === "Informational" || impact === "Optimization").length : 0 },
    policy: { blocking: decision.blocking.length, visible: decision.visible.length, suppressed: decision.suppressed.length, errors: decision.errors },
    result: { category: decision.category, exitCode: decision.exitCode }, sanitised: true,
  };
    const serialized = stable(evidence);
    await assertSerializedAgainstSchema(serialized, join(request.schemaDirectory, "evidence-report.schema.v1.json"));
    assertAnalysisEvidenceSemantics(evidence);
    await write("evidence.json", serialized);
    await write("summary.md", renderAnalysisSummary(evidence));
    const rawFindings = input.findings.map((finding) => ({
      detectorId: finding.detectorId, impact: finding.impact, confidence: finding.confidence,
      identity: finding.identity, path: finding.location.path, start: finding.location.start,
      length: finding.location.length, sourceHash: finding.location.sourceHash,
      snippetHash: finding.location.snippetHash,
    }));
    await write("build-info.json", input.compilerEvidence.rawBuildInfo);
    await write("artifact.json", input.compilerEvidence.rawArtifact);
    await write("fixture-build-info.json", input.fixtureProof.rawBuildInfo);
    await write("fixture-artifact.json", input.fixtureProof.rawArtifact);
    await write("slither.json", stable({ schemaVersion: 1, success: input.success, errors: input.analysisErrors, findings: rawFindings }));
    await write("slither-inventory.json", stable({ schemaVersion: 1, success: input.success, contracts: input.analyzedContracts, sources: input.analyzedSources, errors: input.analysisErrors }));
    await write("detector-inventory.json", stable({ schemaVersion: 1, detectors: input.detectorInventory }));
    await write("slither-status.json", stable({ schemaVersion: 1, analysisExit: input.findings.length === 0 ? 0 : 255, inventoryExit: 0 }));
    await request.assertReadyPrecondition();
  }, async (staging) => await validateEvidenceBundleContents({ output: staging, candidateSha, schemaDirectory: request.schemaDirectory, canonicalDirectory: request.canonicalDirectory }), READY_EVIDENCE_FILES, request.publication);
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
  await publish(output, async (write) => {
    await write(name, serialized);
    await request.assertReadyPrecondition();
  }, async (staging) => await validateEvidenceBundleContents({ output: staging, candidateSha, schemaDirectory: request.schemaDirectory }), ["READY", name], request.publication);
}

function executionIdentity(): Record<string, string> {
  const names = ["GITHUB_EVENT_NAME", "GITHUB_REPOSITORY", "GITHUB_WORKFLOW", "GITHUB_JOB", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"] as const;
  if (process.env.GITHUB_ACTIONS === "true" && names.some((name) => !process.env[name])) {
    throw new SlitherGateError("EVIDENCE_BUNDLE_INVALID", "CI execution identity is incomplete");
  }
  return { platform: "linux/amd64", event: process.env.GITHUB_EVENT_NAME ?? "local", repository: process.env.GITHUB_REPOSITORY ?? "local", workflow: process.env.GITHUB_WORKFLOW ?? "local", job: process.env.GITHUB_JOB ?? "local", runId: process.env.GITHUB_RUN_ID ?? "local", runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1" };
}

export interface PublicationCapability {
  readonly signal?: AbortSignal;
  publishNoReplace(staging: string, output: string, expectedEntries: readonly string[]): Promise<void>;
  /** Independent of work cancellation; retains authority through caller finalization. */
  revoke?(): Promise<void>;
  finalize?(): Promise<void>;
}

interface OwnedReady {
  readonly path: string;
  readonly identity: BigIntStats;
  readonly directories: readonly AncestorIdentity[];
}

/** READY is provisional through staging cleanup and the invocation's final check. */
export class ExclusiveDirectoryPublication implements PublicationCapability {
  readonly signal?: AbortSignal;
  private ready?: OwnedReady;
  private copied: ReadonlyMap<string, BigIntStats> = new Map();

  constructor(signal?: AbortSignal) { this.signal = signal; }

  async publishNoReplace(staging: string, output: string, expectedEntries: readonly string[]): Promise<void> {
    const failures: unknown[] = [];
    try { await this.copyAndMark(staging, output, expectedEntries); }
    catch (error) { failures.push(error); }
    if (failures.length !== 0 || this.signal?.aborted) {
      try { await this.revoke(); } catch (error) { failures.push(error); }
      throwPublicationFailures(failures, this.signal);
    }
  }

  private async copyAndMark(staging: string, output: string, expectedEntries: readonly string[]): Promise<void> {
    assertNotCancelled(this.signal);
    const ancestors = await ancestorIdentities(dirname(output));
    const staged = await directoryIdentity(staging, "publication staging");
    if ((staged.mode & 0o777n) !== 0o700n || staged.uid !== BigInt(process.getuid?.() ?? -1)) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "staging ownership is unsafe");}
    const entries = (await readdir(staging)).toSorted(); const expected = [...expectedEntries].toSorted();
    if (new Set(expected).size !== expected.length || JSON.stringify(entries) !== JSON.stringify(expected) || !entries.includes("READY")) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "staging contains missing or foreign entries");}
    assertNotCancelled(this.signal);
    await assertAncestorIdentities(ancestors);
    assertNotCancelled(this.signal);
    const published = reserveOutput(output);
    const directories = [{path: output, identity: published}, ...ancestors];
    assertNotCancelled(this.signal);
    const copied = new Map<string, BigIntStats>();
    for (const entryName of entries.filter((entry) => entry !== "READY")) {
      await assertAncestorIdentities(directories);
      copied.set(entryName, await copyStableExclusive(join(staging, entryName), join(output, entryName), this.signal));
    }
    await assertSameDirectory(staging, staged, "publication staging");
    await assertPublishedEntries(output, copied, this.signal);
    await assertAncestorIdentities(directories);
    assertNotCancelled(this.signal);
    this.copied = copied;
    await this.markReady(staging, output, directories);
    await assertOwnedReady(this.ready!);
    await assertAncestorIdentities(directories);
    assertNotCancelled(this.signal);
  }

  private async markReady(staging: string, output: string, directories: readonly AncestorIdentity[]): Promise<void> {
    const source = join(staging, "READY"); const path = join(output, "READY");
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const failures: unknown[] = [];
    let identity: BigIntStats | undefined;
    let linked = false;
    try {
      identity = await handle.stat({bigint: true});
      assertSafePublicationEntry(identity, BigInt(process.getuid?.() ?? -1));
      if (identity.size !== 0n || !sameSourceIdentity(identity, await lstat(source, {bigint: true}))) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "staging READY changed");}
      await assertAncestorIdentities(directories);
      assertNotCancelled(this.signal);
      // Acquire identity BEFORE making READY visible. link is exclusive; the
      // held descriptor still proves custody if any subsequent stat/close fails.
      await link(source, path);
      linked = true;
      assertNotCancelled(this.signal);
      await assertHeldReady({path: source, identity, directories: []});
      await unlink(source);
      this.ready = {path, identity: await handle.stat({bigint: true}), directories};
      assertSafePublicationEntry(this.ready.identity, identity.uid);
      await assertOwnedReady(this.ready);
    } catch (error) { failures.push(error); }
    if (linked && (failures.length !== 0 || this.signal?.aborted)) {
      try { await revokeHeldReady({path, identity: identity!, directories}); } catch (error) { failures.push(error); }
      try { await revokeHeldReady({path: source, identity: identity!, directories: []}); } catch (error) { failures.push(error); }
      this.ready = undefined;
    }
    try { await handle.close(); } catch (error) { failures.push(error); }
    throwPublicationFailures(failures, this.signal);
  }

  /** Validate again after staging/caller cleanup, without surrendering revocation. */
  async finalize(): Promise<void> {
    assertNotCancelled(this.signal);
    const ready = this.ready;
    if (ready === undefined) { return; }
    await assertAncestorIdentities(ready.directories);
    await assertPublishedEntries(dirname(ready.path), new Map([...this.copied, ["READY", ready.identity]]), this.signal);
    await assertAncestorIdentities(ready.directories);
    assertNotCancelled(this.signal);
  }

  async revoke(): Promise<void> {
    const ready = this.ready;
    this.ready = undefined;
    if (ready === undefined) { return; }
    await assertAncestorIdentities(ready.directories);
    if (!await assertOwnedReady(ready, true)) { return; }
    // Portable pathname unlink has an accepted same-UID final-syscall race.
    // Never remove a directory or a marker whose identity was substituted.
    await assertAncestorIdentities(ready.directories);
    await unlink(ready.path);
  }
}

/** The open source descriptor prevents inode reuse while link/unlink settles. */
async function assertHeldReady(ready: OwnedReady): Promise<void> {
  const current = await lstat(ready.path, {bigint: true});
  if (!sameFileIdentity(ready.identity, current)) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "READY identity changed; revocation is unconfirmed");}
}
async function revokeHeldReady(ready: OwnedReady): Promise<void> {
  await assertAncestorIdentities(ready.directories);
  try { await assertHeldReady(ready); } catch (error) { if (isMissing(error)) { return; } throw error; }
  await unlink(ready.path);
}

async function assertOwnedReady(ready: OwnedReady, allowMissing = false): Promise<boolean> {
  const current = await lstat(ready.path, {bigint: true}).catch((error: unknown) => {
    if (allowMissing && isMissing(error)) { return; }
    throw error;
  });
  if (current === undefined) { return false; }
  if (!sameSourceIdentity(ready.identity, current)) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "READY identity changed; revocation is unconfirmed");}
  return true;
}

async function assertPublishedEntries(output: string, copied: ReadonlyMap<string, BigIntStats>, signal?: AbortSignal): Promise<void> {
  const actual = (await readdir(output)).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify([...copied.keys()].toSorted())) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "publication output contains foreign entries");}
  for (const name of actual) {
    assertNotCancelled(signal);
    const current = await lstat(join(output, name), {bigint: true});
    if (!sameSourceIdentity(copied.get(name)!, current)) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "publication entry changed");}
  }
  assertNotCancelled(signal);
}

function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

function throwPublicationFailures(failures: readonly unknown[], signal?: AbortSignal): void {
  const errors = signal?.aborted ? [signal.reason, ...failures.filter((error) => error !== signal.reason)] : [...failures];
  if (errors.length === 1) { throw errors[0]; }
  if (errors.length > 1) { throw new AggregateError(errors, `${errors[0] instanceof Error ? errors[0].message : "publication failed"}; publication finalization failed`); }
}

interface AncestorIdentity {readonly path:string;readonly identity:DirectoryIdentity}
async function ancestorIdentities(path:string):Promise<AncestorIdentity[]>{const values:AncestorIdentity[]=[];let current=path;while(true){values.push({path:current,identity:await directoryIdentity(current,"publication ancestor")});const next=dirname(current);if(next===current) {return values;}current=next;}}
async function assertAncestorIdentities(values:readonly AncestorIdentity[]):Promise<void>{for(const value of values) {await assertSameDirectory(value.path,value.identity,"publication ancestor");}}
interface DirectoryIdentity {readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly mode: bigint}
async function directoryIdentity(path: string, label: string): Promise<DirectoryIdentity> {
  return checkedDirectoryIdentity(await lstat(path, {bigint: true}), label);
}
function checkedDirectoryIdentity(info: BigIntStats, label: string): DirectoryIdentity {
  if (!info.isDirectory() || info.isSymbolicLink()) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", `${label} identity is invalid`);}
  return {dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode};
}
function reserveOutput(output: string): DirectoryIdentity {
  // No asynchronous handoff may adopt a substituted directory after mkdir.
  // These adjacent syscalls retain the accepted same-UID final-syscall race.
  mkdirSync(output, {mode: 0o700});
  return checkedDirectoryIdentity(lstatSync(output, {bigint: true}), "publication output");
}
async function assertSameDirectory(path: string, expected: DirectoryIdentity, label: string): Promise<void> {const value=await directoryIdentity(path,label); if(value.dev!==expected.dev || value.ino!==expected.ino || value.uid!==expected.uid || value.mode!==expected.mode) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", `${label} changed`);}}
export async function copyStableExclusive(source: string, destination: string, signal?: AbortSignal): Promise<BigIntStats> {
  assertNotCancelled(signal);
  const before = await lstat(source, {bigint: true});
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "staging entry is unsafe");}
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  let retainedPath: BigIntStats | undefined;
  const failures: unknown[] = [];
  try {
    const opened = await handle.stat({bigint: true});
    if (!sameSourceIdentity(before, opened)) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "staging entry changed");}
    assertNotCancelled(signal);
    destinationHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await destinationHandle.chmod(0o600);
    const created = await destinationHandle.stat({bigint: true});
    assertSafePublicationEntry(created, BigInt(process.getuid?.() ?? -1));
    const copiedDigest = await transferAndDigest(handle, destinationHandle, signal);
    await destinationHandle.sync();
    const afterTransfer = await handle.stat({bigint: true});
    if (!sameSourceIdentity(opened, afterTransfer)) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "staging entry changed");}
    const stableDigest = await digestDescriptor(handle, signal);
    const afterDigest = await handle.stat({bigint: true});
    if (!sameSourceIdentity(opened, afterDigest) || copiedDigest !== stableDigest) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "staging entry changed");}
    const retained = await destinationHandle.stat({bigint: true});
    retainedPath = await lstat(destination, {bigint: true});
    assertRetainedPublicationEntry(created, retained, retainedPath, opened.size);
  } catch (error) { failures.push(error); }
  try { await destinationHandle?.close(); } catch (error) { failures.push(error); }
  try { await handle.close(); } catch (error) { failures.push(error); }
  throwPublicationFailures(failures, signal);
  return retainedPath!;
}

function assertSafePublicationEntry(entry: BigIntStats, expectedUid: bigint): void {
  if(!entry.isFile()||entry.isSymbolicLink()||entry.nlink!==1n||entry.uid!==expectedUid||(entry.mode&0o777n)!==0o600n) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE","publication entry identity is unsafe");}
}

function assertRetainedPublicationEntry(created: BigIntStats, retained: BigIntStats, retainedPath: BigIntStats, expectedSize: bigint): void {
  if(!sameFileIdentity(created,retained)||!sameFileIdentity(created,retainedPath)||retainedPath.size!==expectedSize) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE","publication entry changed");}
  assertSafePublicationEntry(retainedPath, created.uid);
}

function sameFileIdentity(left:{dev:bigint;ino:bigint},right:{dev:bigint;ino:bigint}):boolean{return left.dev===right.dev&&left.ino===right.ino;}
function sameSourceIdentity(left:{dev:bigint;ino:bigint;mode:bigint;nlink:bigint;uid:bigint;gid:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint},right:{dev:bigint;ino:bigint;mode:bigint;nlink:bigint;uid:bigint;gid:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}):boolean{return sameFileIdentity(left,right)&&left.mode===right.mode&&left.nlink===right.nlink&&left.uid===right.uid&&left.gid===right.gid&&left.size===right.size&&left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs;}
async function transferAndDigest(source: Awaited<ReturnType<typeof open>>, destination: Awaited<ReturnType<typeof open>>, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0;
  while (true) {
    assertNotCancelled(signal);
    const {bytesRead} = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) { break; }
    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      assertNotCancelled(signal);
      const result = await destination.write(buffer, written, bytesRead - written);
      if (result.bytesWritten === 0) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "publication write made no progress");}
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  return hash.digest("hex");
}
async function digestDescriptor(source: Awaited<ReturnType<typeof open>>, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0;
  while (true) {
    assertNotCancelled(signal);
    const {bytesRead} = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) { break; }
    hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
  }
  return hash.digest("hex");
}
async function writeStaged(staging: string, name: string, value: string, files: Map<string, BigIntStats>): Promise<void> {
  const handle = await open(join(staging, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const failures: unknown[] = [];
  try {
    files.set(name, await handle.stat({bigint: true}));
    await handle.writeFile(value);
  } catch (error) { failures.push(error); }
  try { files.set(name, await handle.stat({bigint: true})); } catch (error) { failures.push(error); }
  try { await handle.close(); } catch (error) { failures.push(error); }
  throwPublicationFailures(failures);
}

async function cleanupStaging(staging: string, identity: DirectoryIdentity, files: ReadonlyMap<string, BigIntStats>): Promise<void> {
  await assertSameDirectory(staging, identity, "publication staging");
  const failures: unknown[] = [];
  for (const name of await readdir(staging)) {
    try {
      const owned = files.get(name);
      const current = await lstat(join(staging, name), {bigint: true});
      if (!owned || !sameSourceIdentity(owned, current)) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "staging entry changed; cleanup is unconfirmed");}
      await assertSameDirectory(staging, identity, "publication staging");
      await unlink(join(staging, name));
    } catch (error) { failures.push(error); }
  }
  throwPublicationFailures(failures);
  await assertSameDirectory(staging, identity, "publication staging");
  // Nonrecursive removal cannot consume a foreign entry arriving after checks.
  await rmdir(staging);
}

async function publicationOutput(output: string, publication: PublicationCapability): Promise<string> {
  if (!publication || !output.startsWith("/") || output.includes("\0") || output.endsWith("/") || output.split("/").includes("..")) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE", "fresh absolute output and publication capability are required");}
  const leaf=basename(output);
  if(leaf.length===0||leaf==="."||leaf===".."||leaf.includes("/")||leaf.includes("\\")) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE","output basename is unsafe");}
  const parent=await realpath(dirname(output)).catch(() => {throw new SlitherGateError("PUBLICATION_UNAVAILABLE","output parent is unavailable");});
  const canonicalOutput=join(parent,leaf);
  if((await lstat(canonicalOutput).catch(()=>null))!==null) {throw new SlitherGateError("PUBLICATION_UNAVAILABLE","fresh absolute output and publication capability are required");}
  return canonicalOutput;
}

async function publish(output: string, build: (write: (name: string, value: string) => Promise<void>) => Promise<void>, finalize: (staging: string) => Promise<void>, expectedEntries: readonly string[], publication: PublicationCapability): Promise<void> {
  const canonicalOutput = await publicationOutput(output, publication);
  const parent = dirname(canonicalOutput); const leaf = basename(canonicalOutput);
  assertNotCancelled(publication.signal);
  const staging = mkdtempSync(join(parent, `.${leaf}.staging-`));
  const failures: unknown[] = [];
  let staged: DirectoryIdentity | undefined;
  const files = new Map<string, BigIntStats>();
  try {
    chmodSync(staging, 0o700);
    staged = checkedDirectoryIdentity(lstatSync(staging, {bigint: true}), "publication staging");
    assertNotCancelled(publication.signal);
    const write = async (name: string, value: string): Promise<void> => {
      assertNotCancelled(publication.signal);
      await assertSameDirectory(staging, staged!, "publication staging");
      await writeStaged(staging, name, value, files);
    };
    await build(write);
    await write("READY", "");
    await finalize(staging);
    assertNotCancelled(publication.signal);
    await publication.publishNoReplace(staging, canonicalOutput, expectedEntries);
  } catch (error) { failures.push(error); }
  try {
    if (staged !== undefined) {
      await cleanupStaging(staging, staged, files);
    }
  } catch (error) { failures.push(error); }
  try { if (failures.length === 0) { await publication.finalize?.(); } } catch (error) { failures.push(error); }
  if (failures.length !== 0 || publication.signal?.aborted) {
    try { await publication.revoke?.(); } catch (error) { failures.push(error); }
  }
  throwPublicationFailures(failures, publication.signal);
}
