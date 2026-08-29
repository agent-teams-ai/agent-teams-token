import type { AnalysisInput, Finding, GateManifest, PolicyDecision, Suppression } from "../domain/model.ts";

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);

export function evaluatePolicy(input: AnalysisInput, manifest: GateManifest, suppressions: readonly Suppression[], now = new Date()): PolicyDecision {
  const errors: string[] = [];
  const toolFailed = !input.success || input.analysisErrors.length > 0;
  if (toolFailed) errors.push("Slither reported an analysis error");
  if (!sameSet(input.contracts, manifest.expectedContracts)) errors.push("analyzed contract closure differs from the expected manifest");
  const expectedSources = manifest.sources.map(({ path }) => path.replace(/^contracts\/evm\//u, ""));
  if (!sameSet(input.compiledSources, expectedSources)) errors.push("compiled source closure differs from the expected manifest");
  const expectedClosure = [...manifest.sources, ...manifest.config].map(({ path, sha256 }) => `${path}:${sha256}`);
  const observedClosure = input.closure.map(({ path, sha256 }) => `${path}:${sha256}`);
  if (!sameSet(expectedClosure, observedClosure)) errors.push("source closure hash differs from the expected manifest");
  if (input.creationBytecodeSha256 !== input.freshFoundryCreationBytecodeSha256 || input.creationBytecodeSha256 !== manifest.creationBytecodeSha256) errors.push("Slither, fresh Foundry and approved creation bytecode identities differ");
  if (input.forgeBinarySha256 !== manifest.tools.forgeBinarySha256 || input.solcBinarySha256 !== manifest.tools.solcBinarySha256) errors.push("mounted tool binary identity differs from the expected manifest");
  if (JSON.stringify(input.compiler) !== JSON.stringify(manifest.compiler)) errors.push("compiler settings differ from the approved profile");
  if (input.detectorInventory.length !== manifest.detectorCount || new Set(input.detectorInventory).size !== input.detectorInventory.length) errors.push("detector inventory is incomplete or duplicated");
  for (const detector of manifest.requiredDetectors) if (!input.detectorInventory.includes(detector)) errors.push(`required detector is missing: ${detector}`);

  const duplicateFingerprints = suppressions.filter((item, index) => suppressions.findIndex((other) => other.fingerprint === item.fingerprint) !== index);
  if (duplicateFingerprints.length > 0) errors.push("suppression fingerprints must be unique");
  const used = new Set<number>();
  const suppressed: Finding[] = [];
  const unsuppressed: Finding[] = [];
  for (const finding of input.findings) {
    const matches = suppressions.map((suppression, index) => ({ suppression, index })).filter(({ suppression }) =>
      suppression.fingerprint === finding.fingerprint && suppression.detectorId === finding.detectorId &&
      suppression.path === finding.location.path && suppression.start === finding.location.start &&
      suppression.length === finding.location.length && suppression.sourceHash === finding.location.sourceHash &&
      suppression.snippetHash === finding.location.snippetHash && suppression.findingIdentityHash === finding.findingIdentityHash);
    if (matches.length > 1) errors.push(`finding ${finding.fingerprint} matched multiple suppressions`);
    if (matches.length === 1) { used.add(matches[0]!.index); suppressed.push(finding); } else unsuppressed.push(finding);
  }
  suppressions.forEach((suppression, index) => {
    const hashes = [suppression.fingerprint, suppression.sourceHash, suppression.snippetHash, suppression.findingIdentityHash];
    if (suppression.reason.trim().length < 10 || !suppression.owner.trim() || !suppression.regressionEvidence.trim()) errors.push(`suppression ${suppression.fingerprint} lacks ownership evidence`);
    if (!/^[a-z0-9-]+$/u.test(suppression.detectorId) || !suppression.path.startsWith("contracts/evm/") || suppression.path.split("/").includes("..") || !Number.isSafeInteger(suppression.start) || suppression.start < 0 || !Number.isSafeInteger(suppression.length) || suppression.length < 1 || hashes.some((hash) => !/^sha256:[0-9a-f]{64}$/u.test(hash))) errors.push(`suppression ${suppression.fingerprint} has a malformed exact tuple`);
    const expiry = Date.parse(suppression.expiresAt); const review = Date.parse(suppression.reviewAt);
    const utcDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
    if (!utcDate.test(suppression.expiresAt) || !utcDate.test(suppression.reviewAt) || !Number.isFinite(expiry) || !Number.isFinite(review) || expiry <= now.getTime() || review <= now.getTime() || review > expiry) errors.push(`suppression ${suppression.fingerprint} is expired, review-overdue or malformed`);
    if (!used.has(index)) errors.push(`suppression ${suppression.fingerprint} is unused`);
  });
  if (errors.length > 0) return { category: toolFailed ? "tool-failure" : "output-failure", exitCode: toolFailed ? 30 : 40, blocking: [], visible: input.findings, suppressed, errors };
  const blocking = unsuppressed.filter(({ impact }) => impact === "High" || impact === "Medium");
  return { category: blocking.length > 0 ? "policy-failure" : "clean", exitCode: blocking.length > 0 ? 20 : 0, blocking, visible: unsuppressed, suppressed, errors: [] };
}
