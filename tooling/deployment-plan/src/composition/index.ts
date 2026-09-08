import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { approveForgeArtifact } from "../adapters/artifact.ts";
import { createLocalRpc, observeFees } from "../adapters/rpc.ts";
import {
  createNativeNoReplaceCapability,
  loadCommittedNativeNoReplacePolicy,
} from "../adapters/native-no-replace.ts";
import {
  claimOwnedOutputDirectory,
  type ClaimedOutputDirectory,
  type OutputFaultInjection,
  type PublishedOutputIdentity,
} from "../adapters/safe-output.ts";
import {
  parseFeeQuote,
  parseJsonWithoutDuplicates,
  parseNativeNoReplaceEvidence,
  parseRawArtifactJson,
  parseReadyMarker,
  parseStablePlan,
  parseTrustRoots,
} from "../adapters/strict-json.ts";
import { buildFeeQuote, buildStablePlan, type FeeQuote, type StablePlan } from "../application/builder.ts";
import type {
  ApprovedArtifact,
  ArtifactInputs,
  DeploymentRpc,
  RawArtifactInputs,
  TrustRoots,
} from "../application/ports.ts";
import {
  independentlyVerify,
  independentlyVerifyRpc,
  verifyReadyDigests,
  type ReadyMarker,
  type VerificationRequest,
} from "../application/verifier.ts";
import { canonicalJson, sha256Hex } from "../domain/identity.ts";
import { fail } from "../domain/model.ts";

const PLAN = "deployment-plan.v2.json";
const QUOTE = "fee-quote.v2.json";
const NATIVE_EVIDENCE = "native-no-replace-evidence.v1.json";
const READY = "READY";

export interface PublishRequest {
  readonly parent: string;
  readonly bundleName: string;
  readonly plan: StablePlan;
  readonly quote: FeeQuote;
  readonly roots: TrustRoots;
  readonly expected: ApprovedArtifact;
  readonly artifactInputs: RawArtifactInputs;
  readonly nativeNoReplaceEvidenceBytes: Uint8Array;
  readonly outputFaultInjection?: OutputFaultInjection;
}

export interface VerifyBundleRequest {
  readonly publication: PublishedBundle;
  readonly expectedQuoteSha256: `0x${string}`;
  readonly roots: TrustRoots;
  readonly expected: ApprovedArtifact;
  readonly artifactInputs: RawArtifactInputs;
  readonly nowSeconds: bigint;
  readonly rpc: DeploymentRpc;
  readonly creationInput: `0x${string}`;
}

export interface PlannerInput {
  readonly rpcUrl: string;
  readonly buildInfoPath: string;
  readonly artifactPath: string;
  readonly abiPath: string;
  readonly fixturePath: string;
  readonly trustRootsPath: string;
  readonly outputParent: string;
  readonly bundleName: string;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
}

export interface PublishedBundleIdentity extends PublishedOutputIdentity {
  readonly planSha256: `0x${string}`;
  readonly quoteSha256: `0x${string}`;
  readonly nativeNoReplaceEvidenceSha256: `0x${string}`;
  readonly readySha256: `0x${string}`;
}

export interface PublishedBundle {
  readonly directory: string;
  readonly identity: PublishedBundleIdentity;
  readonly quoteSha256: `0x${string}`;
  readCommitted(name: string): Promise<Uint8Array>;
  assertCurrent(): Promise<void>;
  close(): Promise<void>;
}

class LocalPublishedBundle implements PublishedBundle {
  readonly directory: string;
  readonly identity: PublishedBundleIdentity;
  readonly quoteSha256: `0x${string}`;
  private readonly output: ClaimedOutputDirectory;
  private closed = false;

  constructor(
    output: ClaimedOutputDirectory,
    directory: string,
    identity: PublishedBundleIdentity,
  ) {
    this.output = output;
    this.directory = directory;
    this.identity = identity;
    this.quoteSha256 = identity.quoteSha256;
  }

  async readCommitted(name: string): Promise<Uint8Array> {
    this.assertOpen();
    return this.output.readCommitted(name);
  }

  async assertCurrent(): Promise<void> {
    this.assertOpen();
    await this.output.assertCommitted();
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.output.close();
    }
  }

  private assertOpen(): void {
    if (this.closed) { fail("OUTPUT_CAPABILITY_CLOSED", "published bundle capability is closed"); }
  }
}

export async function publishReadyLast(request: PublishRequest): Promise<PublishedBundle> {
  if (!/^[a-zA-Z0-9._-]+$/u.test(request.bundleName)) {
    fail("BUNDLE_NAME_INVALID", "bundle name is invalid");
  }
  if (/^\.staging-/iu.test(request.bundleName)) {
    fail("BUNDLE_STAGING_REJECTED", "staging names are reserved");
  }
  const planBytes = jsonBytes(request.plan);
  const quoteBytes = jsonBytes(request.quote);
  const nativeNoReplaceEvidenceBytes = request.nativeNoReplaceEvidenceBytes;
  const planSha256 = sha256Hex(planBytes);
  const quoteSha256 = sha256Hex(quoteBytes);
  const nativeNoReplaceEvidenceSha256 = sha256Hex(nativeNoReplaceEvidenceBytes);
  const ready: ReadyMarker = {
    schemaVersion: 3,
    planSha256,
    quoteSha256,
    nativeNoReplaceEvidenceSha256,
    planId: request.plan.planId,
    creationInputHash: request.quote.creationInputHash,
  };
  const readyBytes = jsonBytes(ready);
  const prepared = { planBytes, quoteBytes, nativeNoReplaceEvidenceBytes, ready };
  await verifyWithCommittedAuthority({
    ...request,
    ready,
    nativeNoReplaceEvidenceBytes,
    nowSeconds: trustedNowSeconds(),
  });
  const output = await claimOwnedOutputDirectory(
    request.parent,
    request.bundleName,
    request.outputFaultInjection,
  );
  try {
    await output.writeExclusive(PLAN, planBytes);
    await output.writeExclusive(QUOTE, quoteBytes);
    await output.writeExclusive(NATIVE_EVIDENCE, nativeNoReplaceEvidenceBytes);
    await assertExactBundle(output.path, false, false);
    await assertPreparedContent(
      output.path,
      prepared,
      { ...request, nowSeconds: trustedNowSeconds() },
    );
    const published = await output.publish();
    await assertExactBundle(published, true, false);
    await assertPreparedContent(
      published,
      prepared,
      { ...request, nowSeconds: trustedNowSeconds() },
    );
    await output.finalizeReady(READY, readyBytes);
    await output.assertCommitted();
    return new LocalPublishedBundle(output, published, {
      ...output.publicationIdentity(),
      planSha256,
      quoteSha256,
      nativeNoReplaceEvidenceSha256,
      readySha256: sha256Hex(readyBytes),
    });
  } catch (error) {
    try { await output.close(); }
    catch (closeError) {
      throw new AggregateError(
        [error, closeError], "publication failed and evidence preservation also failed", { cause: closeError },
      );
    }
    throw error;
  }
}

export async function verifyBundle(
  request: VerifyBundleRequest,
): Promise<{ plan: StablePlan; quote: FeeQuote }> {
  if (request.expectedQuoteSha256 !== request.publication.quoteSha256) {
    fail("EXPECTED_QUOTE_DIGEST_MISMATCH", "expected quote digest does not match publication capability");
  }
  const markerBytes = await request.publication.readCommitted(READY);
  const planBytes = await request.publication.readCommitted(PLAN);
  const quoteBytes = await request.publication.readCommitted(QUOTE);
  const nativeNoReplaceEvidenceBytes = await request.publication.readCommitted(NATIVE_EVIDENCE);
  if (sha256Hex(quoteBytes) !== request.expectedQuoteSha256) {
    fail("EXPECTED_QUOTE_DIGEST_MISMATCH", "authenticated quote bytes do not match expected digest");
  }
  const ready = parseReadyMarker(markerBytes);
  const plan = parseStablePlan(planBytes);
  const quote = parseFeeQuote(quoteBytes);
  verifyReadyDigests(planBytes, quoteBytes, nativeNoReplaceEvidenceBytes, ready);
  await verifyWithCommittedAuthority({
    ...request,
    plan,
    quote,
    ready,
    nativeNoReplaceEvidenceBytes,
    nowSeconds: trustedNowSeconds(),
  });
  await independentlyVerifyRpc({
    rpc: request.rpc,
    plan,
    quote,
    creationInput: request.creationInput,
  });
  await request.publication.assertCurrent();
  return { plan, quote };
}

async function assertExactBundle(
  directory: string,
  rejectStaging = true,
  readyRequired = true,
): Promise<void> {
  const metadata = await lstat(directory);
  const uid = process.getuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1 || (metadata.mode & 0o777) !== 0o700 || uid === undefined || metadata.uid !== uid) {
    fail("BUNDLE_DIRECTORY_UNSAFE", "bundle directory must be owned, private, and canonical");
  }
  if (rejectStaging && (directory.toLocaleLowerCase().includes(".bundle.staging-") || /\.staging-[0-9a-f]+$/iu.test(directory))) {
    fail("BUNDLE_STAGING_REJECTED", "staging directories cannot be verified");
  }
  if (await realpath(directory) !== directory) {fail("BUNDLE_DIRECTORY_UNSAFE", "bundle path must be canonical");}
  const names = (await readdir(directory)).toSorted();
  const expected = readyRequired ? [PLAN, QUOTE, NATIVE_EVIDENCE, READY].toSorted() : [PLAN, QUOTE, NATIVE_EVIDENCE].toSorted();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    fail(
      "BUNDLE_FILES_INVALID",
      readyRequired
        ? "bundle must contain exactly plan, quote, native evidence, and READY"
        : "prepared bundle must contain exactly plan, quote, and native evidence",
    );
  }
}

interface PreparedContent {
  readonly planBytes: Uint8Array;
  readonly quoteBytes: Uint8Array;
  readonly nativeNoReplaceEvidenceBytes: Uint8Array;
  readonly ready: ReadyMarker;
}

async function assertPreparedContent(
  directory: string,
  expected: PreparedContent,
  request: PublishRequest & Pick<VerificationRequest, "nowSeconds">,
): Promise<void> {
  const planBytes = await safeRead(join(directory, PLAN));
  const quoteBytes = await safeRead(join(directory, QUOTE));
  const nativeNoReplaceEvidenceBytes = await safeRead(join(directory, NATIVE_EVIDENCE));
  if (
    !Buffer.from(planBytes).equals(expected.planBytes)
    || !Buffer.from(quoteBytes).equals(expected.quoteBytes)
    || !Buffer.from(nativeNoReplaceEvidenceBytes).equals(expected.nativeNoReplaceEvidenceBytes)
  ) {
    fail("OUTPUT_CONTENT_SUBSTITUTED", "published bundle differs from verified staging bytes");
  }
  const plan = parseStablePlan(planBytes);
  const quote = parseFeeQuote(quoteBytes);
  verifyReadyDigests(planBytes, quoteBytes, nativeNoReplaceEvidenceBytes, expected.ready);
  await verifyWithCommittedAuthority({
    ...request,
    plan,
    quote,
    ready: expected.ready,
    nativeNoReplaceEvidenceBytes,
  });
}

async function verifyWithCommittedAuthority(
  request: Omit<VerificationRequest, "nativeNoReplacePolicy" | "nativeNoReplaceEvidence" | "jsonParser">,
): Promise<void> {
  const nativeNoReplacePolicy = await loadCommittedNativeNoReplacePolicy();
  const nativeNoReplaceEvidence = parseNativeNoReplaceEvidence(
    request.nativeNoReplaceEvidenceBytes,
  );
  if (!Buffer.from(request.nativeNoReplaceEvidenceBytes)
    .equals(jsonBytes(nativeNoReplaceEvidence))) {
    fail("NATIVE_EVIDENCE_NONCANONICAL", "native evidence must use canonical JSON bytes");
  }
  independentlyVerify({
    ...request,
    nativeNoReplacePolicy,
    nativeNoReplaceEvidence,
    jsonParser: { parse: parseRawArtifactJson },
  });
}

export async function runUnsignedPlanner(
  input: PlannerInput,
): Promise<{
  directory: string;
  planId: string;
  quoteSha256: `0x${string}`;
  nativeNoReplaceEvidenceSha256: `0x${string}`;
  bundleIdentity: PublishedBundleIdentity;
}> {
  const roots = parseTrustRoots(await safeRead(input.trustRootsPath));
  const fixtureBytes = await safeRead(input.fixturePath);
  const artifactInputs: ArtifactInputs = {
    buildInfoBytes: await safeRead(input.buildInfoPath),
    artifactBytes: await safeRead(input.artifactPath),
    abiBytes: await safeRead(input.abiPath),
    fixtureBytes,
    constructorValues: parseJsonWithoutDuplicates(fixtureBytes),
  };
  const approved = approveForgeArtifact(artifactInputs, roots);
  const rpc = createLocalRpc(input.rpcUrl);
  const observation = await observeFees(rpc, {
    from: roots.from,
    creationInput: approved.creationInput,
    nowSeconds: trustedNowSeconds(),
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    maxFeePerGas: input.maxFeePerGas,
  });
  const plan = buildStablePlan(approved, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  await independentlyVerifyRpc({
    rpc,
    plan,
    quote,
    creationInput: approved.creationInput,
  });
  const nativeNoReplace = await createNativeNoReplaceCapability();
  try {
    const publishRequest = {
      parent: input.outputParent,
      bundleName: input.bundleName,
      plan,
      quote,
      roots,
      expected: approved,
      artifactInputs,
      nativeNoReplaceEvidenceBytes: jsonBytes(nativeNoReplace.evidence),
      outputFaultInjection: { noReplaceDirectoryRename: nativeNoReplace.rename },
    };
    const publication = await publishReadyLast(publishRequest);
    try {
      await verifyBundle({
        publication,
        expectedQuoteSha256: publication.quoteSha256,
        roots,
        expected: approved,
        artifactInputs,
        nowSeconds: trustedNowSeconds(),
        rpc,
        creationInput: approved.creationInput,
      });
      return {
        directory: publication.directory,
        planId: plan.planId,
        quoteSha256: publication.quoteSha256,
        nativeNoReplaceEvidenceSha256: publication.identity.nativeNoReplaceEvidenceSha256,
        bundleIdentity: publication.identity,
      };
    } finally {
      await publication.close();
    }
  } finally {
    await nativeNoReplace.close();
  }
}

function trustedNowSeconds(): bigint {
  const milliseconds = Date.now();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    fail("TRUSTED_CLOCK_INVALID", "system clock is outside the supported range");
  }
  return BigInt(Math.floor(milliseconds / 1000));
}

async function safeRead(path: string): Promise<Uint8Array> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail("BUNDLE_FILE_UNSAFE", "bundle file is not an owned regular file");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await file.readFile();
    const after = await file.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      fail("FILESYSTEM_SUBSTITUTION", "bundle file changed while read");
    }
    return bytes;
  } finally {
    await file.close();
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${canonicalJson(value)}\n`);
}
