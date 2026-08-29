import { constants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../domain/identity.ts";
import { fail } from "../domain/model.ts";
import type { FeeQuote, StablePlan } from "../application/builder.ts";
import { independentlyVerify, independentlyVerifyRpc, verifyReadyDigests, type ReadyMarker } from "../application/verifier.ts";
import type { ApprovedArtifact, TrustRoots } from "../adapters/artifact.ts";
import { approveForgeArtifact } from "../adapters/artifact.ts";
import { buildFeeQuote, buildStablePlan } from "../application/builder.ts";
import { createLocalRpc, observeFees } from "../adapters/rpc.ts";
const PLAN = "deployment-plan.v1.json"; const QUOTE = "fee-quote.v1.json"; const READY = "READY";
export async function publishReadyLast(parent: string, bundleName: string, plan: StablePlan, quote: FeeQuote, roots: TrustRoots, expected: ApprovedArtifact, nowSeconds: bigint): Promise<string> {
  if (!/^[a-zA-Z0-9._-]+$/u.test(bundleName)) fail("BUNDLE_NAME_INVALID", "bundle name is invalid"); await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${bundleName}.tmp-${process.pid}-${Date.now()}`); const target = join(parent, bundleName); await mkdir(temporary, { mode: 0o700 });
  const planBytes = Buffer.from(`${canonicalJson(plan)}\n`); const quoteBytes = Buffer.from(`${canonicalJson(quote)}\n`);
  const ready: ReadyMarker = { schemaVersion: 1, planSha256: sha256Hex(planBytes), quoteSha256: sha256Hex(quoteBytes), planId: plan.planId, creationInputHash: quote.creationInputHash };
  independentlyVerify(plan, quote, roots, expected, ready, nowSeconds); await writeExclusive(join(temporary, PLAN), planBytes); await writeExclusive(join(temporary, QUOTE), quoteBytes);
  await rename(temporary, target); await writeExclusive(join(target, READY), Buffer.from(`${canonicalJson(ready)}\n`)); return target;
}
export async function verifyBundle(directory: string, roots: TrustRoots, expected: ApprovedArtifact, nowSeconds: bigint): Promise<{ plan: StablePlan; quote: FeeQuote }> {
  const markerBytes = await safeRead(join(directory, READY)); const planBytes = await safeRead(join(directory, PLAN)); const quoteBytes = await safeRead(join(directory, QUOTE));
  const ready = strictJson(markerBytes) as ReadyMarker; const plan = strictJson(planBytes) as StablePlan; const quote = strictJson(quoteBytes) as FeeQuote;
  verifyReadyDigests(planBytes, quoteBytes, ready); independentlyVerify(plan, quote, roots, expected, ready, nowSeconds); return { plan, quote };
}
async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> { const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } }
async function safeRead(path: string): Promise<Uint8Array> { const before = await lstat(path); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("BUNDLE_FILE_UNSAFE", "bundle file is not an owned regular file"); const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const bytes = await file.readFile(); const after = await file.stat(); if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail("FILESYSTEM_SUBSTITUTION", "bundle file changed while read"); return bytes; } finally { await file.close(); } }
function strictJson(bytes: Uint8Array): unknown { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("BUNDLE_JSON_INVALID", "bundle JSON is malformed"); } }

export interface PlannerInput { readonly rpcUrl: string; readonly buildInfoPath: string; readonly artifactPath: string; readonly abiPath: string; readonly fixturePath: string; readonly trustRootsPath: string; readonly outputParent: string; readonly bundleName: string; readonly nowSeconds: bigint; readonly maxPriorityFeePerGas: bigint; readonly maxFeePerGas: bigint }
export async function runUnsignedPlanner(input: PlannerInput): Promise<{ directory: string; planId: string }> {
  const roots = strictJson(await safeRead(input.trustRootsPath)) as TrustRoots; const fixtureBytes = await safeRead(input.fixturePath);
  const approved = approveForgeArtifact({ buildInfoBytes: await safeRead(input.buildInfoPath), artifactBytes: await safeRead(input.artifactPath), abiBytes: await safeRead(input.abiPath), fixtureBytes, constructorValues: strictJson(fixtureBytes) }, roots);
  const plan = buildStablePlan(approved, roots); const rpc = createLocalRpc(input.rpcUrl);
  const observation = await observeFees(rpc, roots.from, approved.creationInput, input.nowSeconds, input.maxPriorityFeePerGas, input.maxFeePerGas);
  const quote = buildFeeQuote(plan, observation, roots); await independentlyVerifyRpc(rpc, plan, quote, approved.creationInput);
  const directory = await publishReadyLast(input.outputParent, input.bundleName, plan, quote, roots, approved, input.nowSeconds); return { directory, planId: plan.planId };
}
