import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisInput, GateManifest, PolicyDecision } from "../domain/model.ts";
import { sha256 } from "./fingerprint.ts";
import { IMAGE, IMAGE_REVISION } from "./container-contract.ts";
import { assertAnalysisEvidenceSemantics } from "./evidence-bundle.ts";
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

interface ReadyEvidenceRequest {
  readonly output: string;
  readonly candidateSha: string;
  readonly manifest: GateManifest;
  readonly input: AnalysisInput;
  readonly decision: PolicyDecision;
  readonly hashes: { readonly config: string; readonly policy: string };
  readonly triageHash: string;
  readonly schemaDirectory: string;
  readonly assertReadyPrecondition: () => Promise<void>;
}

interface FailureEvidenceRequest {
  readonly output: string;
  readonly candidateSha: string;
  readonly category: "output-failure" | "environment-failure";
  readonly exitCode: 40 | 50;
  readonly stage: string;
  readonly errorCode: string;
  readonly schemaDirectory: string;
  readonly assertReadyPrecondition: () => Promise<void>;
}

export async function writeReadyEvidence(request: ReadyEvidenceRequest): Promise<void> {
  const { output, candidateSha, manifest, input, decision, hashes } = request;
  await mkdir(output, { recursive: false, mode: 0o700 });
  const info = await lstat(output); if (!info.isDirectory() || info.isSymbolicLink()) {throw new Error("evidence output is not an owned directory");}
  const suppressed = new Set(decision.suppressed.map(({ fingerprint }) => fingerprint));
  const blocking = new Set(decision.blocking.map(({ fingerprint }) => fingerprint));
  const findings = input.findings.map((finding) => ({ detectorId: finding.detectorId, impact: finding.impact, confidence: finding.confidence, fingerprint: finding.fingerprint, path: finding.location.path, start: finding.location.start, length: finding.location.length, blocking: blocking.has(finding.fingerprint), suppressed: suppressed.has(finding.fingerprint) }));
  const evidence = {
    schemaVersion: 1, ready: true, candidateSha,
    execution: { platform: "linux/amd64", event: process.env.GITHUB_EVENT_NAME ?? "local", repository: process.env.GITHUB_REPOSITORY ?? "local", workflow: process.env.GITHUB_WORKFLOW ?? "local", job: process.env.GITHUB_JOB ?? "local", runId: process.env.GITHUB_RUN_ID ?? "local", runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1" },
    tools: { image: IMAGE, imageRevision: IMAGE_REVISION, slither: "0.11.6", cryticCompile: "0.4.2", forge: "1.8.0", forgeBinarySha256: `sha256:${input.forgeBinarySha256}`, solc: "0.8.36+commit.8a079791", solcBinarySha256: `sha256:${input.solcBinarySha256}` },
    inputs: { closureHash: `sha256:${sha256(JSON.stringify([...manifest.sources, ...manifest.config, manifest.detectorInventory]))}`, configHash: `sha256:${hashes.config}`, policyHash: `sha256:${hashes.policy}`, triageHash: `sha256:${request.triageHash}` },
    analysis: { expectedTargets: manifest.expectedContracts, observedTargets: input.analyzedContracts, expectedSources: manifest.sources.map(({ path }) => path.replace(/^contracts\/evm\//u, "")), observedSources: input.analyzedSources, creationBytecodeSha256: `sha256:${input.creationBytecodeSha256}`, detectors: input.detectorInventory, findingCount: input.findings.length, findings, suppressions: decision.suppressed.length, triaged: request.triageHash.length > 0 ? decision.visible.filter(({ impact }) => impact === "Low" || impact === "Informational" || impact === "Optimization").length : 0 },
    policy: { blocking: decision.blocking.length, visible: decision.visible.length, suppressed: decision.suppressed.length, errors: decision.errors },
    result: { category: decision.category, exitCode: decision.exitCode }, sanitised: true,
  };
  const serialized = stable(evidence);
  await assertSerializedAgainstSchema(serialized, join(request.schemaDirectory, "evidence-report.schema.v1.json"));
  assertAnalysisEvidenceSemantics(evidence);
  const partial = join(output, "evidence.json.partial");
  await writeFile(partial, serialized, { mode: 0o600, flag: "wx" });
  await rename(partial, join(output, "evidence.json"));
  const findingLines = findings.map((finding) => `- ${finding.impact} ${finding.detectorId} at ${finding.path}:${finding.start} (${finding.suppressed ? "suppressed" : finding.blocking ? "blocking" : "visible"})`);
  const summary = [`# Slither security gate`, ``, `Result: ${decision.category} (exit ${decision.exitCode})`, `Findings: ${input.findings.length}; blocking: ${decision.blocking.length}; suppressed: ${decision.suppressed.length}`, `Targets: ${input.analyzedContracts.join(", ")}`, ...findingLines, ``].join("\n");
  await writeFile(join(output, "summary.md.partial"), summary, { mode: 0o600, flag: "wx" });
  await rename(join(output, "summary.md.partial"), join(output, "summary.md"));
  await request.assertReadyPrecondition();
  await writeFile(join(output, "READY"), "", { mode: 0o600, flag: "wx" });
}

export async function writeEnvironmentFailure(output: string, candidateSha: string, stage: string, errorCode: string, schemaDirectory: string, assertReadyPrecondition: () => Promise<void>): Promise<void> {
  await writeFailureEvidence({
    output,
    candidateSha,
    category: "environment-failure",
    exitCode: 50,
    stage,
    errorCode,
    schemaDirectory,
    assertReadyPrecondition,
  });
}

export async function writeFailureEvidence(request: FailureEvidenceRequest): Promise<void> {
  const { output, candidateSha, category, exitCode, stage, errorCode } = request;
  if ((category === "output-failure") !== (exitCode === 40)) {throw new Error("failure category and exit code differ");}
  await mkdir(output, { recursive: false, mode: 0o700 });
  const info = await lstat(output); if (!info.isDirectory() || info.isSymbolicLink()) {throw new Error("evidence output is not an owned directory");}
  const value = { schemaVersion: 1, ready: true, candidateSha, execution: { platform: "linux/amd64", event: process.env.GITHUB_EVENT_NAME ?? "local", repository: process.env.GITHUB_REPOSITORY ?? "local", workflow: process.env.GITHUB_WORKFLOW ?? "local", job: process.env.GITHUB_JOB ?? "local", runId: process.env.GITHUB_RUN_ID ?? "local", runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1" }, image: IMAGE, category, exitCode, stage, errorCode, sanitised: true };
  const name = `${category}.json`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await assertSerializedAgainstSchema(serialized, join(request.schemaDirectory, `${category}.schema.v1.json`));
  await writeFile(join(output, `${name}.partial`), serialized, { mode: 0o600, flag: "wx" });
  await rename(join(output, `${name}.partial`), join(output, name));
  await request.assertReadyPrecondition();
  await writeFile(join(output, "READY"), "", { mode: 0o600, flag: "wx" });
}
