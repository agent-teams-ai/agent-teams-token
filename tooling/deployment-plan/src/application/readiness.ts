import { evaluateReadiness, type ReadinessEvidence, type ReadinessReport } from "../domain/readiness.ts";
export type { ReadinessEvidence, ReadinessReport } from "../domain/readiness.ts";
export function assessReadiness(evidence: ReadinessEvidence): ReadinessReport { return evaluateReadiness(evidence); }
export function assertReadinessBundle(report: ReadinessReport, expectedManifestSha256: string): void { if (report.broadcastAllowed !== false || report.manifestSha256 !== expectedManifestSha256 || report.schema !== "agtmai-readiness-report-v1") {throw new Error("READINESS_BUNDLE_INVALID");} }
export function assertReadinessFreshness(evidence: ReadinessEvidence, now: string): void {
  if (!/^(0|[1-9][0-9]*)$/u.test(now) || BigInt(now) < BigInt(evidence.observedAt) || BigInt(now) > BigInt(evidence.validUntil)) {
    throw new Error("READINESS_EVIDENCE_STALE");
  }
}
