import { calendarSchedule } from "../src/features/genesis-manifest/domain/grant-schedule.js";

const safe = (id: string, address: string, owners: string[]) => ({ id, address, owners, threshold: 2, beneficialControl: "solo-founder", disclosure: "Synthetic test-only Safe identity." });

export function syntheticProductionEnvelope(): Record<string, unknown> {
  const shares = [3000, 3000, 300, 1700, 900, 500, 500, 100];
  const ids = ["long-term", "users", "founder", "contributors", "operations", "ecosystem", "financing", "liquidity"];
  const allocations = shares.map((bps, index) => ({ id: ids[index], recipient: `0x${String(index + 1).padStart(40, "0")}`, amountBaseUnits: String(BigInt(bps) * 10_000_000_000_000n), bps }));
  const paused = { enabled: true, capacity: "0", rate: "0" };
  const evm = "0x1111111111111111111111111111111111111111";
  const solana = "11111111111111111111111111111111";
  const deployment = {
    schemaVersion: 1, deploymentId: "synthetic-production-envelope", status: "accepted",
    environment: { mode: "mainnet-dry-run", evmChainId: "1", solanaGenesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", evmSelector: "5009297550715157269", solanaSelector: "124615329519749607" },
    token: { name: "Agent Teams AI", symbol: "AGTMAI", decimals: 9, initialSupplyBaseUnits: "100000000000000000", initialCCIPAdmin: `0x${"b".repeat(40)}` },
    allocations, grants: [],
    custodySafes: [safe("project-controller", `0x${"b".repeat(40)}`, [`0x${"c".repeat(40)}`, `0x${"d".repeat(40)}`, `0x${"e".repeat(40)}`]), safe("founder-beneficiary", `0x${"a".repeat(40)}`, [`0x${"f".repeat(40)}`, `0x${"1".repeat(39)}2`, `0x${"1".repeat(39)}3`])],
    roleAliases: [{ address: `0x${"b".repeat(40)}`, roles: ["safe.project-controller.address", "token.initialCCIPAdmin"] }],
    bridge: { protocol: { reference: "synthetic-test-only", snapshotSha256: `0x${"1".repeat(64)}`, networkDataSha256: `0x${"2".repeat(64)}` }, ethereum: { token: null, pool: null, router: evm, rmn: evm, registry: evm, registryModule: evm, registryAdministrator: evm, poolOwner: evm, rateLimitAdministrator: evm, rebalancer: null, inbound: paused, outbound: paused }, solana: { mint: null, pool: null, poolSigner: null, poolTokenAccount: null, lookupTable: null, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", router: solana, offRamp: solana, rmn: solana, feeQuoter: solana, burnMintProgram: solana, poolAdministrator: solana, registryAdministrator: solana, upgradeAuthority: null, inbound: paused, outbound: paused } },
    testScenario: null, policy: { tokenExpenditureCeilingBaseUnits: "3000000000000000", evmMaxFeePerGasWei: "10000000000", evmMaxPriorityFeePerGasWei: "1000000000", evmMaxGasPerTransaction: "6000000", evmMaxTotalFeeWei: "300000000000000000", solanaMaxFeeLamports: "100000", solanaMaxTotalFeeLamports: "1000000", observationMaxAgeSeconds: "300", executionDeadline: "2000000000", fundingDeadline: "1799999940", fundingLeadSeconds: "60", estimateValiditySeconds: "300", gasBufferBps: 1500 },
  };
  return { schema: "agtmai-production-deployment-v1", deployment, reserveGenesis: { schema: "agtmai-reserve-genesis-v1", status: "accepted", initialSupplyBaseUnits: "100000000000000000", allocations, founder: { beneficiary: `0x${"a".repeat(40)}`, controller: `0x${"b".repeat(40)}`, purpose: `0x${"3".repeat(64)}`, schedule: calendarSchedule("1800000000") }, contributors: { controller: `0x${"b".repeat(40)}`, purpose: `0x${"4".repeat(64)}`, rollingCapBaseUnits: "16000000000000000", perGrantCapBaseUnits: "5000000000000000" } }, projectControllerSafeId: "project-controller", founderBeneficiarySafeId: "founder-beneficiary" };
}
