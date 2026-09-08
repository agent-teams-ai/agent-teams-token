import type { Finding, FindingTriage } from "../domain/model.ts";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export function validateFindingTriage(
  visibleFindings: readonly Finding[],
  entries: readonly FindingTriage[],
): readonly string[] {
  const errors: string[] = [];
  const lower = visibleFindings.filter(({ impact }) =>
    impact === "Low" || impact === "Informational" || impact === "Optimization");
  const fingerprints = entries.map(({ fingerprint }) => fingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) {
    errors.push("triage fingerprints must be unique");
  }
  for (const finding of lower) {
    const matches = entries.filter(({ fingerprint }) => fingerprint === finding.fingerprint);
    if (matches.length !== 1) {
      errors.push(`finding ${finding.fingerprint} requires exactly one triage entry`);
    }
  }
  for (const entry of entries) {
    if (!lower.some(({ fingerprint }) => fingerprint === entry.fingerprint)) {
      errors.push(`triage ${entry.fingerprint} is stale or does not identify a visible lower-impact finding`);
    }
    if (!HASH_PATTERN.test(entry.fingerprint)
      || entry.owner.trim().length === 0
      || entry.rationale.trim().length < 20
      || !DATE_PATTERN.test(entry.reviewedAt)
      || !Number.isFinite(Date.parse(entry.reviewedAt))) {
      errors.push(`triage ${entry.fingerprint} is malformed`);
    }
  }
  return errors;
}
