import type { AnalysisInput, Finding, FindingTriage, GateManifest, PolicyDecision, Suppression } from "../domain/model.ts";
import { validateFindingTriage } from "./triage.ts";

interface PolicyRequest {
  readonly input: AnalysisInput;
  readonly manifest: GateManifest;
  readonly expectedDetectors: readonly string[];
  readonly suppressions: readonly Suppression[];
  readonly triage?: readonly FindingTriage[];
  readonly now?: Date;
}

interface SuppressionResult {
  readonly errors: readonly string[];
  readonly suppressed: readonly Finding[];
  readonly unsuppressed: readonly Finding[];
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const sortedLeft = left.toSorted();
  const sortedRight = right.toSorted();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
};

export function evaluatePolicy(request: PolicyRequest): PolicyDecision {
  const { input, suppressions } = request;
  const toolFailed = !input.success || input.analysisErrors.length > 0;
  const structuralErrors = validateAnalysis(request, toolFailed);
  const suppressionResult = evaluateSuppressions(
    input.findings,
    suppressions,
    request.now ?? new Date(),
  );
  const errors = [...structuralErrors, ...suppressionResult.errors];
  if (request.triage !== undefined) {
    errors.push(...validateFindingTriage(suppressionResult.unsuppressed, request.triage));
  }
  if (errors.length > 0) {
    return failureDecision(input, suppressionResult.suppressed, errors, toolFailed);
  }

  const blocking = suppressionResult.unsuppressed.filter(
    ({ impact }) => impact === "High" || impact === "Medium",
  );
  return {
    category: blocking.length > 0 ? "policy-failure" : "clean",
    exitCode: blocking.length > 0 ? 20 : 0,
    blocking,
    visible: suppressionResult.unsuppressed,
    suppressed: suppressionResult.suppressed,
    errors: [],
  };
}

export function evaluateVulnerableFixture(findings: readonly Finding[], fixtureSourceSha256: string): PolicyDecision {
  const blocking = findings.filter(({ impact, detectorId, location }) => (impact === "High" || impact === "Medium") && detectorId === "suicidal" && location.path === "contracts/evm/src/Vulnerable.sol" && location.sourceHash === `sha256:${fixtureSourceSha256}`);
  if (blocking.length === 0) {
    return { category: "output-failure", exitCode: 40, blocking: [], visible: findings, suppressed: [], errors: ["vulnerable fixture produced no blocking detector finding"] };
  }
  return { category: "policy-failure", exitCode: 20, blocking, visible: findings, suppressed: [], errors: [] };
}

function validateAnalysis(request: PolicyRequest, toolFailed: boolean): readonly string[] {
  const { input, manifest, expectedDetectors } = request;
  const checks: readonly [boolean, string][] = [
    [toolFailed, "Slither reported an analysis error"],
    [!sameSet(input.analyzedContracts, manifest.expectedContracts), "analyzed contract closure differs from the expected manifest"],
    [!sameSet(input.analyzedSources, expectedSources(manifest)), "analyzed source closure differs from the expected manifest"],
    [!sameSet(observedClosure(input), expectedClosure(manifest)), "source closure hash differs from the expected manifest"],
    [!bytecodeMatches(input, manifest), "Slither, fresh Foundry and approved creation bytecode identities differ"],
    [!toolsMatch(input, manifest), "mounted tool binary identity differs from the expected manifest"],
    [JSON.stringify(input.compiler) !== JSON.stringify(manifest.compiler), "compiler settings differ from the approved profile"],
    [!sameSet(input.detectorInventory, expectedDetectors), "detector inventory differs from the exact pinned Slither inventory"],
  ];
  return checks.filter(([failed]) => failed).map(([, message]) => message);
}

function expectedSources(manifest: GateManifest): readonly string[] {
  return manifest.sources.map(({ path }) => path.replace(/^contracts\/evm\//u, ""));
}

function expectedClosure(manifest: GateManifest): readonly string[] {
  return [...manifest.sources, ...manifest.config, manifest.detectorInventory]
    .map(({ path, sha256 }) => `${path}:${sha256}`);
}

function observedClosure(input: AnalysisInput): readonly string[] {
  return input.closure.map(({ path, sha256 }) => `${path}:${sha256}`);
}

function bytecodeMatches(input: AnalysisInput, manifest: GateManifest): boolean {
  return input.creationBytecodeSha256 === input.freshFoundryCreationBytecodeSha256
    && input.creationBytecodeSha256 === manifest.creationBytecodeSha256;
}

function toolsMatch(input: AnalysisInput, manifest: GateManifest): boolean {
  return input.forgeBinarySha256 === manifest.tools.forgeBinarySha256
    && input.solcBinarySha256 === manifest.tools.solcBinarySha256;
}

function evaluateSuppressions(
  findings: readonly Finding[],
  suppressions: readonly Suppression[],
  now: Date,
): SuppressionResult {
  const errors: string[] = [];
  const used = new Set<number>();
  const suppressed: Finding[] = [];
  const unsuppressed: Finding[] = [];
  if (new Set(suppressions.map(({ fingerprint }) => fingerprint)).size !== suppressions.length) {
    errors.push("suppression fingerprints must be unique");
  }

  for (const finding of findings) {
    const matches = matchingSuppressions(finding, suppressions);
    if (matches.length > 1) {
      errors.push(`finding ${finding.fingerprint} matched multiple suppressions`);
    }
    const match = matches[0];
    if (matches.length === 1 && match !== undefined) {
      used.add(match);
      suppressed.push(finding);
    } else {
      unsuppressed.push(finding);
    }
  }

  suppressions.forEach((suppression, index) => {
    errors.push(...validateSuppression(suppression, index, used, now));
  });
  return { errors, suppressed, unsuppressed };
}

function matchingSuppressions(
  finding: Finding,
  suppressions: readonly Suppression[],
): readonly number[] {
  return suppressions
    .map((suppression, index) => ({ suppression, index }))
    .filter(({ suppression }) => exactSuppressionMatch(finding, suppression))
    .map(({ index }) => index);
}

function exactSuppressionMatch(finding: Finding, suppression: Suppression): boolean {
  return suppression.fingerprint === finding.fingerprint
    && suppression.detectorId === finding.detectorId
    && suppression.path === finding.location.path
    && suppression.start === finding.location.start
    && suppression.length === finding.location.length
    && suppression.sourceHash === finding.location.sourceHash
    && suppression.snippetHash === finding.location.snippetHash
    && suppression.findingIdentityHash === finding.findingIdentityHash;
}

function validateSuppression(
  suppression: Suppression,
  index: number,
  used: ReadonlySet<number>,
  now: Date,
): readonly string[] {
  const errors: string[] = [];
  if (!hasOwnershipEvidence(suppression)) {
    errors.push(`suppression ${suppression.fingerprint} lacks ownership evidence`);
  }
  if (!hasExactTuple(suppression)) {
    errors.push(`suppression ${suppression.fingerprint} has a malformed exact tuple`);
  }
  if (!hasValidDates(suppression, now)) {
    errors.push(`suppression ${suppression.fingerprint} is expired, review-overdue or malformed`);
  }
  if (!used.has(index)) {
    errors.push(`suppression ${suppression.fingerprint} is unused`);
  }
  return errors;
}

function hasOwnershipEvidence(suppression: Suppression): boolean {
  return suppression.reason.trim().length >= 10
    && suppression.owner.trim().length > 0
    && suppression.regressionEvidence.trim().length > 0;
}

function hasExactTuple(suppression: Suppression): boolean {
  const hashes = [
    suppression.fingerprint,
    suppression.sourceHash,
    suppression.snippetHash,
    suppression.findingIdentityHash,
  ];
  return /^[a-z0-9-]+$/u.test(suppression.detectorId)
    && suppression.path.startsWith("contracts/evm/")
    && !suppression.path.split("/").includes("..")
    && Number.isSafeInteger(suppression.start)
    && suppression.start >= 0
    && Number.isSafeInteger(suppression.length)
    && suppression.length >= 1
    && hashes.every((hash) => HASH_PATTERN.test(hash));
}

function hasValidDates(suppression: Suppression, now: Date): boolean {
  const expiry = Date.parse(suppression.expiresAt);
  const review = Date.parse(suppression.reviewAt);
  return UTC_DATE_PATTERN.test(suppression.expiresAt)
    && UTC_DATE_PATTERN.test(suppression.reviewAt)
    && Number.isFinite(expiry)
    && Number.isFinite(review)
    && expiry > now.getTime()
    && review > now.getTime()
    && review <= expiry;
}

function failureDecision(
  input: AnalysisInput,
  suppressed: readonly Finding[],
  errors: readonly string[],
  toolFailed: boolean,
): PolicyDecision {
  return {
    category: toolFailed ? "tool-failure" : "output-failure",
    exitCode: toolFailed ? 30 : 40,
    blocking: [],
    visible: input.findings,
    suppressed,
    errors,
  };
}
