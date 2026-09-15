/* eslint-disable complexity -- one evaluator keeps the readiness decision atomic. */
import { parseUint } from "./model.ts";

export interface ReadinessEvidence {
  readonly schema: "agtmai-readiness-evidence-v1"; readonly broadcastAllowed: false;
  readonly manifestSha256: string; readonly observedAt: string; readonly validUntil: string;
  readonly ethereum: { readonly chainId: "1"; readonly deployed: boolean; readonly fixedSupply: string; readonly backing: string; readonly pendingEthereumToSolana: string | null; readonly pendingSolanaToEthereum: string | null; readonly block: { readonly number: string; readonly hash: string; readonly timestamp: string }; readonly authorityComplete: boolean };
  readonly solana: { readonly genesisHash: string; readonly deployed: boolean; readonly supply: string; readonly authorityComplete: boolean; readonly slot: string; readonly blockTime: string };
  readonly protocolQualified: boolean; readonly coverageComplete: boolean;
  readonly estimates?: { readonly complete: boolean; readonly operations?: readonly { readonly id: string; readonly estimatedNative: string; readonly worstCaseNative: string; readonly expiresAt: string }[] };
}
export interface ReadinessReport { readonly schema: "agtmai-readiness-report-v1"; readonly broadcastAllowed: false; readonly status: "qualified" | "incomplete" | "inconsistent" | "not-deployed"; readonly reasons: readonly string[]; readonly manifestSha256: string; readonly reconciliation: { readonly adjustedGlobalSupply: string | null; readonly backingSurplus: string | null; readonly status: "exact" | "under-backed" | "surplus" | "unknown" }; readonly estimatesComplete: boolean; readonly observedAt: string; readonly validUntil: string; }
const fail = (reason: string): never => { throw new Error(`READINESS_${reason}`); };
const quantity = (value: unknown, field: string): bigint => parseUint(value, field);
// oxlint-disable-next-line complexity -- keep accounting and qualification in one atomic decision.
export function evaluateReadiness(evidence: ReadinessEvidence): ReadinessReport {
  if (!evidence || evidence.schema !== "agtmai-readiness-evidence-v1" || evidence.broadcastAllowed !== false) {fail("EVIDENCE_INVALID");}
  if (!evidence.ethereum || !evidence.solana || !evidence.ethereum.block || typeof evidence.ethereum.block !== "object" || typeof evidence.solana.genesisHash !== "string") { fail("EVIDENCE_INVALID"); }
  const observedAt = quantity(evidence.observedAt, "observedAt"), validUntil = quantity(evidence.validUntil, "validUntil");
  if (validUntil < observedAt || !/^0x[0-9a-f]{64}$/u.test(evidence.manifestSha256) || !/^0x[0-9a-f]{64}$/u.test(evidence.ethereum.block.hash) || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/u.test(evidence.solana.genesisHash)) { fail("EVIDENCE_INVALID"); }
  quantity(evidence.ethereum.block.number, "ethereum.block.number"); quantity(evidence.ethereum.block.timestamp, "ethereum.block.timestamp");
  quantity(evidence.solana.slot, "solana.slot"); quantity(evidence.solana.blockTime, "solana.blockTime");
  const reasons: string[] = [];
  if (evidence.ethereum.chainId !== "1") {reasons.push("ethereum-chain-mismatch");}
  if (!evidence.ethereum.deployed || !evidence.solana.deployed) {reasons.push("deployment-not-present");}
  if (!evidence.protocolQualified) {reasons.push("protocol-unqualified");}
  if (!evidence.coverageComplete) {reasons.push("activity-coverage-incomplete");}
  if (!evidence.ethereum.authorityComplete || !evidence.solana.authorityComplete) {reasons.push("authority-observation-incomplete");}
  const fixed = quantity(evidence.ethereum.fixedSupply, "fixedSupply"), backing = quantity(evidence.ethereum.backing, "backing"), supply = quantity(evidence.solana.supply, "supply");
  const pendingES = evidence.ethereum.pendingEthereumToSolana === null ? null : quantity(evidence.ethereum.pendingEthereumToSolana, "pendingEthereumToSolana");
  const pendingSE = evidence.ethereum.pendingSolanaToEthereum === null ? null : quantity(evidence.ethereum.pendingSolanaToEthereum, "pendingSolanaToEthereum");
  if (pendingES === null || pendingSE === null) { reasons.push("reconciliation-unknown"); }
  if (backing > fixed) {reasons.push("backing-exceeds-fixed-supply");}
  const adjusted = pendingES === null || pendingSE === null ? null : fixed - backing + supply + pendingES + pendingSE;
  const surplus = pendingES === null || pendingSE === null ? null : backing - supply - pendingES - pendingSE;
  const reconciliationStatus = surplus === null ? "unknown" : surplus < 0n ? "under-backed" : surplus > 0n ? "surplus" : "exact";
  if (reconciliationStatus !== "exact" && reconciliationStatus !== "unknown") {reasons.push(reconciliationStatus);}
  const estimatesComplete = evidence.estimates?.complete === true && (evidence.estimates.operations ?? []).every(op => quantity(op.estimatedNative, `estimate.${op.id}`) >= 0n && quantity(op.worstCaseNative, `estimate.${op.id}`) >= quantity(op.estimatedNative, `estimate.${op.id}`));
  if (!estimatesComplete) {reasons.push("estimates-incomplete");}
  const status = reasons.includes("backing-exceeds-fixed-supply") || reconciliationStatus === "under-backed" ? "inconsistent" : !evidence.ethereum.deployed || !evidence.solana.deployed ? "not-deployed" : reasons.length ? "incomplete" : "qualified";
  return { schema: "agtmai-readiness-report-v1", broadcastAllowed: false, status, reasons: reasons.toSorted(), manifestSha256: evidence.manifestSha256, reconciliation: { adjustedGlobalSupply: adjusted?.toString() ?? null, backingSurplus: surplus?.toString() ?? null, status: reconciliationStatus }, estimatesComplete, observedAt: observedAt.toString(), validUntil: validUntil.toString() };
}
