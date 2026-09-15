import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReadiness } from "../src/domain/readiness.ts";
import { parseReadinessEvidence } from "../src/adapters/readiness-evidence.ts";

const base = () => ({
  schema: "agtmai-readiness-evidence-v1" as const, broadcastAllowed: false as const,
  manifestSha256: `0x${"11".repeat(32)}`, observedAt: "100", validUntil: "200",
  ethereum: { chainId: "1" as const, deployed: true, fixedSupply: "1000", backing: "500", pendingEthereumToSolana: "0", pendingSolanaToEthereum: "0", block: { number: "10", hash: `0x${"22".repeat(32)}`, timestamp: "100" }, authorityComplete: true },
  solana: { genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", deployed: true, supply: "500", authorityComplete: true, slot: "20", blockTime: "100" },
  protocolQualified: true, coverageComplete: true, estimates: { complete: true, operations: [] },
});

test("readiness reconciles fixed supply and rejects a surplus or under-backing claim", () => {
  const exact = evaluateReadiness(base());
  assert.equal(exact.status, "qualified");
  assert.equal(exact.reconciliation.status, "exact");
  assert.equal(exact.reconciliation.adjustedGlobalSupply, "1000");
  const surplus = evaluateReadiness({ ...base(), ethereum: { ...base().ethereum, backing: "600" } });
  assert.equal(surplus.status, "incomplete");
  assert.equal(surplus.reconciliation.status, "surplus");
  const under = evaluateReadiness({ ...base(), ethereum: { ...base().ethereum, backing: "400" } });
  assert.equal(under.status, "inconsistent");
  assert.ok(under.reasons.includes("under-backed"));
});

test("unknown pending effects remain explicitly unknown", () => {
  const report = evaluateReadiness({ ...base(), ethereum: { ...base().ethereum, pendingEthereumToSolana: null } });
  assert.equal(report.reconciliation.status, "unknown");
  assert.equal(report.reconciliation.adjustedGlobalSupply, null);
  assert.ok(report.reasons.includes("reconciliation-unknown"));
});

test("readiness evidence rejects duplicate JSON members before evaluation", () => {
  const value = JSON.stringify(base());
  assert.equal(JSON.stringify(parseReadinessEvidence(new TextEncoder().encode(value))), value);
  assert.throws(() => parseReadinessEvidence(new TextEncoder().encode(value.replace('"schema":"agtmai-readiness-evidence-v1"', '"schema":"agtmai-readiness-evidence-v1","schema":"other"'))), /READINESS_EVIDENCE_SCHEMA|duplicate/i);
});
