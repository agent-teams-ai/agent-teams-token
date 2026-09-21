import { evaluateReadiness, type ReadinessEvidence, type ReadinessProtocolContext, type ReadinessReport } from "../domain/readiness.ts";
export type { ReadinessEvidence, ReadinessProtocolContext, ReadinessReport } from "../domain/readiness.ts";
export function assessReadiness(evidence: ReadinessEvidence, protocol?: ReadinessProtocolContext): ReadinessReport { return evaluateReadiness(evidence, protocol); }
const invalid = (): never => { throw new Error("READINESS_BUNDLE_INVALID"); };
const fields = (value: unknown, keys: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).toSorted().join() !== keys.split(",").toSorted().join()) { return invalid(); }
  return value as Record<string, unknown>;
};
const integer = (value: unknown): value is string => typeof value === "string" && /^(0|-?[1-9][0-9]*)$/u.test(value);
const uint = (value: unknown): value is string => integer(value) && !value.startsWith("-");
const reasonNames = ["activity-coverage-incomplete", "authority-observation-incomplete", "backing-exceeds-fixed-supply", "deployment-not-present",
  "estimates-incomplete", "ethereum-chain-mismatch", "protocol-manifest-unbound", "protocol-profile-unverified", "protocol-unqualified", "reconciliation-unknown",
  "solana-mainnet-genesis-mismatch", "solana-manifest-genesis-mismatch", "surplus", "under-backed"];
export function assertReadinessBundle(value: unknown, expectedManifestSha256: string): asserts value is ReadinessReport {
  const report = fields(value, "schema,broadcastAllowed,status,reasons,manifestSha256,reconciliation,authorityComplete,estimatesComplete,observedAt,validUntil");
  if (report.schema !== "agtmai-readiness-report-v1" || report.broadcastAllowed !== false
    || typeof expectedManifestSha256 !== "string" || !/^0x[0-9a-f]{64}$/u.test(expectedManifestSha256) || report.manifestSha256 !== expectedManifestSha256
    || typeof report.authorityComplete !== "boolean" || typeof report.estimatesComplete !== "boolean"
    || !uint(report.observedAt) || !uint(report.validUntil) || BigInt(report.validUntil) < BigInt(report.observedAt)) { invalid(); }
  const reasons = report.reasons;
  assertReasons(reasons);
  const reconciliation = fields(report.reconciliation, "adjustedGlobalSupply,backingSurplus,status");
  assertReconciliation(reconciliation, reasons);
  if (reasons.includes("estimates-incomplete") !== !report.estimatesComplete
    || reasons.includes("authority-observation-incomplete") !== !report.authorityComplete) { invalid(); }
  const status = reasons.includes("backing-exceeds-fixed-supply") || reconciliation.status === "under-backed" ? "inconsistent"
    : reasons.includes("deployment-not-present") ? "not-deployed" : reasons.length ? "incomplete" : "qualified";
  // There is no authenticated protocol-profile validator in this release.
  // Consequently a standalone JSON bundle must never certify qualification.
  if (report.status !== status || report.status === "qualified" || !reasons.includes("protocol-profile-unverified")) { invalid(); }
}
function assertReasons(reasons: unknown): asserts reasons is readonly string[] {
  if (!Array.isArray(reasons) || reasons.some(r => typeof r !== "string" || !reasonNames.includes(r))
    || new Set(reasons).size !== reasons.length || reasons.join() !== reasons.toSorted().join()) { invalid(); }
}
function assertReconciliation(reconciliation: Record<string, unknown>, reasons: readonly string[]): void {
  const { adjustedGlobalSupply: adjusted, backingSurplus: surplus } = reconciliation;
  if (surplus === null) {
    if (adjusted !== null || reconciliation.status !== "unknown") { invalid(); }
  } else {
    if (!uint(adjusted) || !integer(surplus) || BigInt(adjusted) + BigInt(surplus) < 0n) { return invalid(); }
    const status = BigInt(surplus) < 0n ? "under-backed" : BigInt(surplus) > 0n ? "surplus" : "exact";
    if (reconciliation.status !== status) { invalid(); }
  }
  for (const [status, reason] of [["unknown", "reconciliation-unknown"], ["under-backed", "under-backed"], ["surplus", "surplus"]]) {
    if (reasons.includes(reason!) !== (reconciliation.status === status)) { invalid(); }
  }
}
export function assertReadinessFreshness(evidence: ReadinessEvidence, now: string): void {
  const report = evaluateReadiness(evidence);
  if (!/^(0|[1-9][0-9]*)$/u.test(now) || BigInt(now) < BigInt(report.observedAt) || BigInt(now) > BigInt(report.validUntil)) {
    throw new Error("READINESS_EVIDENCE_STALE");
  }
}
