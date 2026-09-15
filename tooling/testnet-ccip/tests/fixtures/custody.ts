// Synthetic policy records only. These records are deliberately not deployment/CCIP E2E evidence.
import { readFileSync } from "node:fs";
import { validateDeployment, type DeploymentManifest, type Hex } from "@agent-teams/supply/deployment";
import type { CustodyGrantState, CustodySnapshot } from "../../src/domain/custody.ts";
import type { CustodySafeCall } from "../../src/domain/custody-intent.ts";
export const hash = `0x${"a".repeat(64)}` as Hex;
export const blockHash = `0x${"b".repeat(64)}` as Hex;
export const token = "0x0000000000000000000000000000000000000080" as Hex;
const w = (v: string): string => BigInt(v).toString(16).padStart(64, "0");
/** ABI fixture with synthetic signature bytes; never authorization to submit a transaction. */
export function safeCalldataFixture(call: CustodySafeCall): Hex {
  const signatures = `${w("1")}${w("1")}1b`.repeat(2).padEnd(320, "0");
  return `0x6a761202${[w(call.to), w("0"), w("320"), w("0"), w(call.safeTxGas), w("0"), w("0"), w("0"), w("0"), w("384"),
    w("4"), "ea8a1af0".padEnd(64, "0"), w("130"), signatures].join("")}`;
}
export function manifestFixture(): DeploymentManifest {
  const configuration = validateDeployment(JSON.parse(readFileSync(new URL("../../../../packages/contexts/supply/tests/fixtures/deployment/local-test.json", import.meta.url), "utf8"))).value;
  if (!configuration) { throw new Error("Fixture invalid"); }
  const block = { number: "1", hash, timestamp: "1831550000" };
  return { schema: "agtmai-deployment-manifest-v1", broadcastAllowed: false, sourceRevision: "1".repeat(40), configurationSha256: hash,
    preparedSha256: hash, evidenceSha256: hash, configuration, status: "deployed",
    token: { address: token, transactionHash: hash, block, constructorArgs: "0x", artifactSha256: hash, compilerInputSha256: hash, genesisAllocationHash: hash },
    grants: configuration.grants.map((g, i) => ({ grantId: g.id, address: `0x${(200 + i).toString(16).padStart(40, "0")}` as Hex,
      transactionHash: hash, block, constructorArgs: "0x", artifactSha256: hash, compilerInputSha256: hash })),
    observationTrust: "selected RPC captures; hashes establish reproducibility, not independent consensus truth" };
}
export function stateFixture(manifest: DeploymentManifest, grantId: string, patch: Partial<CustodyGrantState> = {}): CustodyGrantState {
  const c = manifest.configuration, g = c.grants.find(candidate => candidate.id === grantId)!;
  return { grantId, address: manifest.grants.find(d => d.grantId === grantId)!.address, token,
    beneficiary: g.beneficiary, reserve: c.allocations.find(a => a.id === g.fundingAllocation)!.recipient as Hex,
    controller: c.custodySafes.find(s => s.id === g.controllerSafe)!.address, allocation: g.amountBaseUnits,
    start: g.schedule.start, cliff: g.schedule.cliff, end: g.schedule.end, kind: g.kind, originalPurpose: g.originalPurpose,
    initialized: true, funded: false, cancelled: false, released: "0", frozenEntitlement: "0", lastTransition: "0", available: "0", allowance: "0", donations: "0", ...patch };
}
export function snapshotFixture(manifest: DeploymentManifest, timestamp: string, number: string, states: readonly CustodyGrantState[], values: readonly string[]): CustodySnapshot {
  const addresses = [...new Set([...manifest.configuration.allocations.map(a => a.recipient as Hex), ...manifest.configuration.grants.map(g => g.beneficiary), ...manifest.grants.map(g => g.address)])].toSorted();
  if (values.length !== addresses.length) { throw new Error("Six explicit inventory amounts required"); }
  return { schema: "agtmai-custody-snapshot-v1", chainId: "31337", block: { timestamp, number, hash: number === "7" ? hash : blockHash }, token,
    totalSupply: "1000000", initialSupply: "1000000", balances: addresses.map((address, i) => ({ address, amount: values[i]! })), grants: states };
}
