import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";
import { renderPassport } from "../src/features/genesis-manifest/adapters/passport-render.js";
import { generatePassport } from "../src/features/genesis-manifest/application/passport.js";
import type { ObservedAssemblyManifest, AssemblyOperationObservation } from "../src/features/genesis-manifest/application/deployment-manifest.js";
import { projectLocalAssemblyFacts } from "../src/features/genesis-manifest/application/reserve-facts.js";
import { calendarSchedule } from "../src/features/genesis-manifest/domain/grant-schedule.js";
import type { LocalPurposeGenesis } from "../src/features/genesis-manifest/domain/local-purpose-genesis.js";
import type { Hex } from "../src/features/genesis-manifest/domain/deployment.js";

// Passive renderer inputs only: these do not claim native observation or artifact admission.
const controller: Hex = `0x${"b".repeat(40)}`, beneficiary: Hex = `0x${"a".repeat(40)}`;
const token: Hex = `0x${"1".repeat(40)}`, vault: Hex = `0x${"2".repeat(40)}`;
const digest: Hex = `0x${"d3".repeat(32)}`, allocationHash: Hex = `0x${"a1".repeat(12)}${"b2".repeat(20)}`;
const controllerWord: Hex = `0x${"0".repeat(24)}${controller.slice(2)}`;
const beneficiaryWord: Hex = `0x${"0".repeat(24)}${beneficiary.slice(2)}`;
const owners: Hex[] = [`0x${"3".repeat(40)}`, `0x${"4".repeat(40)}`, `0x${"5".repeat(40)}`];
const configuration: LocalPurposeGenesis = {
  schema: "agtmai-local-purpose-genesis-v2", chainId: "1", status: "test-only", tokenContract: "AGTMAICCIPToken",
  reserve: { initialSupplyBaseUnits: "100000000000000000", allocations: [],
    founder: { beneficiary, controller, purpose: digest, schedule: calendarSchedule("1800000000") },
    contributors: { controller, purpose: digest, rollingCapBaseUnits: "100", perGrantCapBaseUnits: "10" } },
  custodySafes: [{ id: "project-controller", address: controller, owners, threshold: 2, beneficialControl: "solo-founder", disclosure: "Test only" }],
  roleAliases: [], projectControllerSafeId: "project-controller", founderBeneficiarySafeId: "founder-beneficiary", purposeVaults: [],
  execution: { sender: owners[0]!, startingNonce: "0", fundingDeadline: "1800000000", fundingLeadSeconds: "60", executionDeadline: "1800000060",
    maxFeePerGasWei: "2", maxPriorityFeePerGasWei: "1", maxGasPerTransaction: "100", maxTotalFeeWei: "200" },
};
const block = { number: "10", hash: digest, timestamp: "1800000000" };
const operation: AssemblyOperationObservation = { id: "founder-fund", nonce: "9", sender: owners[0]!, chainId: "1", input: "0x", value: "0",
  gasEstimate: "1", gasLimit: "2", baseFeePerGas: "1", receiptBaseFeePerGas: "1", blockGasLimit: "100", maxPriorityFeePerGas: "1", maxFeePerGas: "2",
  gasUsed: "1", effectiveGasPrice: "2", observedCostWei: "2", predecessor: block, block, parentHash: digest, transactionHash: digest,
  status: "1", actualAddress: vault, logs: [] };
const contractInputs: readonly (Pick<ObservedAssemblyManifest["contracts"][number], "id" | "contract" | "predictedAddress" | "immutableValues">
  & { readonly getters: Readonly<Record<string, Hex>> })[] = [
  { id: "token-create", contract: "AGTMAICCIPToken", predictedAddress: token,
    immutableValues: { INITIAL_CCIP_ADMIN: controllerWord, GENESIS_ALLOCATION_HASH: allocationHash }, getters: { getCCIPAdmin: controllerWord, GENESIS_ALLOCATION_HASH: allocationHash } },
  { id: "founder-vault", contract: "GrantVault", predictedAddress: vault,
    immutableValues: { CONTROLLER: controllerWord, BENEFICIARY: beneficiaryWord }, getters: { CONTROLLER: controllerWord, BENEFICIARY: beneficiaryWord } },
];
const contracts: ObservedAssemblyManifest["contracts"] = contractInputs.map(({ getters, ...contract }) => ({ ...contract, fullyQualifiedName: `fixture.sol:${contract.contract}`, compilerVersion: "0.8.36",
  creation: { kind: "top-level", nonce: "0" }, compilerInputSha256: digest, artifactSha256: digest, buildInfoSha256: digest,
  constructorArgs: "0x", initcode: "0x", initcodeHash: digest, runtimeTemplate: "0x", runtimeTemplateHash: digest,
  materializedRuntime: "0x", materializedRuntimeHash: digest,
  observed: { id: contract.id, address: contract.predictedAddress, runtime: "0x", nonce: "1", getters, balance: "0", block, transactionHash: digest } }));
const manifest: ObservedAssemblyManifest = {
  schema: "agtmai-deployment-manifest-v2", coverage: "full-ethereum-reserve-assembly", broadcastAllowed: false,
  status: "synthetic-local-observation", configuration, configurationSha256: digest, sourceRevision: "1".repeat(40), preparedSha256: digest,
  evidenceSha256: digest, attemptIdentity: digest, approval: null, authorityClass: "test-only", chainId: "1",
  packageTiming: "complete gas-bearing rehearsal package reconstructed after execution of pre-frozen inventory",
  facts: projectLocalAssemblyFacts(configuration, digest), contracts,
  funding: { operation: { id: "founder-fund", kind: "call", nonce: "9", value: "0" },
    before: { block, reserveBalance: "0", vaultBalance: "0", allowance: "0", funded: "0x" }, after: { allowance: "0", repeatCallRevert: "0x" }, observed: operation },
  gas: [operation], gasBufferBps: 2000, genesis: block, worstCaseWei: "4", observedWei: "2", actualProductionDeployment: "unavailable",
  authority: [{ address: controller, owners, threshold: 2, nonce: "7", proxyCodeHash: digest, singletonCodeHash: digest,
    singletonAddress: token, singletonSlot: controllerWord, modules: [], guard: null, fallbackHandler: null, setupProvenance: "fixture setup" }],
};
const observations = { schema: "agtmai-deployment-observations-v1" as const, observedAt: "1800000000", validUntil: "1800000300",
  unresolved: ["z production unavailable", "a `<pending>` &amp;\nnext"] };

test("observed passport renders its observation interval and escaped unresolved diagnostics", () => {
  const markdown = new TextDecoder().decode(renderPassport(generatePassport(manifest, observations, { sha256 })));
  assert.ok(markdown.includes("## Readiness\n\n- Observation interval: 1800000000–1800000300"));
  assert.ok(markdown.includes("- Unresolved: a \\`&lt;pending&gt;\\` &amp;amp; next\n- Unresolved: z production unavailable"));
  const refreshed = generatePassport(manifest, { ...observations, observedAt: "1800000100", validUntil: "1800000400", unresolved: ["new blocker"] }, { sha256 });
  assert.ok(refreshed.markdown.includes("- Observation interval: 1800000100–1800000400\n- Unresolved: new blocker"));
  assert.doesNotMatch(refreshed.markdown, /z production unavailable/);
  assert.match(markdown, /Selected test-only policy; production configuration and approval unavailable/);
  assert.match(markdown, /Chain ID 1 is synthetic owned loopback evidence/);
});

test("observed passport discloses initial CCIP administration, grant rights and Safe control", () => {
  const passport = generatePassport(manifest, observations, { sha256 });
  assert.equal(passport.authorityRegistry.entries.find(e => e.capability === "token-create.initial_ccip_admin")!.power, "initial CCIP administration");
  const markdown = new TextDecoder().decode(renderPassport(passport));
  assert.match(markdown, /## Authority registry/);
  assert.ok(markdown.includes(`token-create.initial\\_ccip\\_admin on 1 (synthetic loopback): power initial CCIP administration; expected ${controller}; observed ${controller}; Owned synthetic local observation; actual production deployment unavailable.`));
  assert.ok(markdown.includes(`founder-vault.beneficiary on 1 (synthetic loopback): power claim vested entitlement; expected ${beneficiary}; observed ${beneficiary};`));
  assert.ok(markdown.includes(`founder-vault.controller on 1 (synthetic loopback): power configured immutable control; expected ${controller}; observed ${controller};`));
  assert.ok(markdown.includes(`custody.safe.project-controller on 1 (synthetic loopback): power Safe CALL control; expected ${controller}; observed ${controller}; Actual local threshold 2 of 3; nonce 7; empty modules, guard and fallback; production authority unavailable.`));
  assert.equal(passport.broadcastAllowed, false);
  assert.equal(passport.authorityRegistry.broadcastAllowed, false);
});

test("allocation digest is excluded from address authority entries", () => {
  const passport = generatePassport(manifest, observations, { sha256 });
  assert.deepEqual(passport.authorityRegistry.entries.map(e => e.capability).toSorted(),
    ["custody.safe.project-controller", "founder-vault.beneficiary", "founder-vault.controller", "token-create.initial_ccip_admin"]);
});
