import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { approveForgeArtifact } from "../adapters/artifact.ts";
import { createLocalRpc, observeFees } from "../adapters/rpc.ts";
import {
  claimOwnedOutputDirectory,
  type OutputFaultInjection,
} from "../adapters/safe-output.ts";
import {
  parseFeeQuote,
  parseJsonWithoutDuplicates,
  parseReadyMarker,
  parseStablePlan,
  parseTrustRoots,
} from "../adapters/strict-json.ts";
import { buildFeeQuote, buildStablePlan, type FeeQuote, type StablePlan } from "../application/builder.ts";
import type { ApprovedArtifact, DeploymentRpc, TrustRoots } from "../application/ports.ts";
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
const READY = "READY";

export interface PublishRequest {
  readonly parent: string;
  readonly bundleName: string;
  readonly plan: StablePlan;
  readonly quote: FeeQuote;
  readonly roots: TrustRoots;
  readonly expected: ApprovedArtifact;
  readonly outputFaultInjection?: OutputFaultInjection;
}

export interface VerifyBundleRequest {
  readonly directory: string;
  readonly roots: TrustRoots;
  readonly expected: ApprovedArtifact;
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

export async function publishReadyLast(request: PublishRequest): Promise<string> {
  if (!/^[a-zA-Z0-9._-]+$/u.test(request.bundleName)) {
    fail("BUNDLE_NAME_INVALID", "bundle name is invalid");
  }
  const planBytes = jsonBytes(request.plan);
  const quoteBytes = jsonBytes(request.quote);
  const ready: ReadyMarker = {
    schemaVersion: 2,
    planSha256: sha256Hex(planBytes),
    quoteSha256: sha256Hex(quoteBytes),
    planId: request.plan.planId,
    creationInputHash: request.quote.creationInputHash,
  };
  independentlyVerify({ ...request, ready, nowSeconds: trustedNowSeconds() });
  const output = await claimOwnedOutputDirectory(
    request.parent,
    request.bundleName,
    request.outputFaultInjection,
  );
  try {
    await output.writeExclusive(PLAN, planBytes);
    await output.writeExclusive(QUOTE, quoteBytes);
    await output.writeExclusive(READY, jsonBytes(ready));
    await assertExactBundle(output.path);
    await assertPublishedContent(
      output.path, planBytes, quoteBytes, ready,
      { ...request, nowSeconds: trustedNowSeconds() },
    );
    const published = await output.publish();
    await assertExactBundle(published);
    await assertPublishedContent(
      published, planBytes, quoteBytes, ready,
      { ...request, nowSeconds: trustedNowSeconds() },
    );
    return published;
  } finally {
    await output.close();
  }
}

export async function verifyBundle(
  request: VerifyBundleRequest,
): Promise<{ plan: StablePlan; quote: FeeQuote }> {
  await assertExactBundle(request.directory);
  const markerBytes = await safeRead(join(request.directory, READY));
  const planBytes = await safeRead(join(request.directory, PLAN));
  const quoteBytes = await safeRead(join(request.directory, QUOTE));
  const ready = parseReadyMarker(markerBytes);
  const plan = parseStablePlan(planBytes);
  const quote = parseFeeQuote(quoteBytes);
  verifyReadyDigests(planBytes, quoteBytes, ready);
  independentlyVerify({ ...request, plan, quote, ready });
  await independentlyVerifyRpc({
    rpc: request.rpc,
    plan,
    quote,
    creationInput: request.creationInput,
  });
  return { plan, quote };
}

async function assertExactBundle(directory: string): Promise<void> {
  const names = (await readdir(directory)).toSorted();
  const expected = [PLAN, QUOTE, READY].toSorted();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    fail("BUNDLE_FILES_INVALID", "bundle must contain exactly plan, quote, and READY");
  }
}

async function assertPublishedContent(
  directory: string,
  expectedPlanBytes: Uint8Array,
  expectedQuoteBytes: Uint8Array,
  expectedReady: ReadyMarker,
  request: PublishRequest & Pick<VerificationRequest, "nowSeconds">,
): Promise<void> {
  const planBytes = await safeRead(join(directory, PLAN));
  const quoteBytes = await safeRead(join(directory, QUOTE));
  const readyBytes = await safeRead(join(directory, READY));
  if (
    !Buffer.from(planBytes).equals(expectedPlanBytes)
    || !Buffer.from(quoteBytes).equals(expectedQuoteBytes)
  ) {
    fail("OUTPUT_CONTENT_SUBSTITUTED", "published bundle differs from verified staging bytes");
  }
  const ready = parseReadyMarker(readyBytes);
  if (canonicalJson(ready) !== canonicalJson(expectedReady)) {
    fail("OUTPUT_CONTENT_SUBSTITUTED", "published READY marker was substituted");
  }
  const plan = parseStablePlan(planBytes);
  const quote = parseFeeQuote(quoteBytes);
  verifyReadyDigests(planBytes, quoteBytes, ready);
  independentlyVerify({ ...request, plan, quote, ready });
}

export async function runUnsignedPlanner(
  input: PlannerInput,
): Promise<{ directory: string; planId: string }> {
  const roots = parseTrustRoots(await safeRead(input.trustRootsPath));
  const fixtureBytes = await safeRead(input.fixturePath);
  const approved = approveForgeArtifact({
    buildInfoBytes: await safeRead(input.buildInfoPath),
    artifactBytes: await safeRead(input.artifactPath),
    abiBytes: await safeRead(input.abiPath),
    fixtureBytes,
    constructorValues: parseJsonWithoutDuplicates(fixtureBytes),
  }, roots);
  const rpc = createLocalRpc(input.rpcUrl);
  const observation = await observeFees(rpc, {
    from: roots.from,
    creationInput: approved.creationInput,
    nowSeconds: trustedNowSeconds(),
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    maxFeePerGas: input.maxFeePerGas,
  });
  const plan = buildStablePlan(approved, roots, observation);
  const quote = buildFeeQuote(plan, observation, roots);
  await independentlyVerifyRpc({
    rpc,
    plan,
    quote,
    creationInput: approved.creationInput,
  });
  const publishRequest = {
    parent: input.outputParent,
    bundleName: input.bundleName,
    plan,
    quote,
    roots,
    expected: approved,
  };
  const directory = await publishReadyLast(publishRequest);
  await verifyBundle({
    directory,
    roots,
    expected: approved,
    nowSeconds: trustedNowSeconds(),
    rpc,
    creationInput: approved.creationInput,
  });
  return { directory, planId: plan.planId };
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
