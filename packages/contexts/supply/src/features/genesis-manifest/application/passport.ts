import { canonicalJson } from "./canonical.js";
import { deploymentBytes } from "./compile-deployment.js";
import type { DeploymentManifest, PreparedAssemblyManifest, ObservedAssemblyManifest } from "./deployment-manifest.js";
import type { JsonValue } from "./canonical.js";
export interface PassportHashPort { readonly sha256: (bytes: Uint8Array) => `0x${string}`; }

export interface PassportAuthorityObservation { readonly capability: string; readonly chain: string; readonly controlled: string; readonly observed?: string | null; readonly pending?: string | null; readonly evidence?: string | null; }
export interface PassportObservation {
  readonly schema: "agtmai-deployment-observations-v1"; readonly observedAt: string; readonly validUntil: string;
  readonly authorities?: readonly PassportAuthorityObservation[];
  readonly reconciliation?: { readonly status: string; readonly adjustedGlobalSupply?: string; readonly backingSurplus?: string };
  readonly estimates?: { readonly status: string; readonly operations?: readonly unknown[] };
  readonly unresolved?: readonly string[]; readonly [key: string]: unknown;
}
export interface AuthorityRegistryEntry { readonly capability: string; readonly chain: string; readonly controlled: string; readonly expected: string | null; readonly observed: string | null; readonly pending: string | null; readonly mechanism: "immutable" | "safe" | "pda" | "protocol" | "unknown"; readonly power: string; readonly limitation: string; readonly evidence: string | null; }
export interface TokenPassport { readonly broadcastAllowed?: false; readonly schema: "agtmai-token-passport-v1"; readonly manifestSha256: `0x${string}`; readonly observationsSha256: `0x${string}`; readonly generated: { readonly observedAt: string; readonly validUntil: string }; readonly markdown: string; readonly authorityRegistry: { readonly broadcastAllowed?: false; readonly schema: "agtmai-authority-registry-v1"; readonly manifestSha256: `0x${string}`; readonly observationsSha256: `0x${string}`; readonly entries: readonly AuthorityRegistryEntry[] }; }
const fail = (reason: string): never => { throw new Error(`PASSPORT_${reason}`); };
const validTime = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
// Flatten lines; encode ampersands first so entity-looking input stays literal.
const escape = (value: string): string => value.replace(/\r\n?|\n/g, " ")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll("\\", "\\\\").replaceAll("`", "\\`").replace(/([*_[\]~])/g, "\\$1");
function validateInputs(manifest: DeploymentManifest | PreparedAssemblyManifest | ObservedAssemblyManifest, observations: PassportObservation): void {
  if ((manifest.schema !== "agtmai-deployment-manifest-v1" && manifest.schema !== "agtmai-deployment-manifest-v2") || manifest.broadcastAllowed !== false) {fail("MANIFEST_REQUIRED");}
  if (observations.schema !== "agtmai-deployment-observations-v1" || !validTime(observations.observedAt) || !validTime(observations.validUntil) || BigInt(observations.validUntil) < BigInt(observations.observedAt)) {fail("OBSERVATIONS_INVALID");}
  if (/private|secret|password|keystore|seed|mnemonic|privatekey/i.test(JSON.stringify(observations))) {fail("PRIVATE_FIELD");}
}
function deploymentTransactions(manifest: DeploymentManifest): string[] {
  const deployments = [
    ...(manifest.token === null ? [] : [{ label: "Token", ...manifest.token }]),
    ...manifest.grants.map(grant => ({ label: `Grant ${grant.grantId}`, ...grant })),
  ];
  return ["## Deployment transactions", "",
    ...(deployments.length === 0 ? ["- No deployment transactions recorded."] : deployments.map(deployment =>
      `- ${escape(deployment.label)}: address \`${escape(deployment.address)}\`; transaction \`${escape(deployment.transactionHash)}\`; block ${escape(deployment.block.number)} (\`${escape(deployment.block.hash)}\`); artifact SHA-256 \`${escape(deployment.artifactSha256)}\`; compiler input SHA-256 \`${escape(deployment.compilerInputSha256)}\`.`)),
    "", "Transaction and artifact identities come from the deployment manifest. Explorer source verification and live contract state require separate checks.", ""];
}
function allocationDisclosure(config: DeploymentManifest["configuration"]): string[] {
  return ["## Allocations", "",
    ...config.allocations.map(allocation => `- ${escape(allocation.id)}: ${allocation.bps ?? "unresolved"} bps; ${escape(allocation.amountBaseUnits)} base units; configured recipient \`${escape(allocation.recipient)}\`.`),
    "", "## Configured custody", "",
    ...config.custodySafes.map(safe => `- ${escape(safe.id)}: Safe \`${escape(safe.address)}\`; threshold ${safe.threshold} of ${safe.owners.length}; owners ${safe.owners.map(owner => `\`${escape(owner)}\``).join(", ")}; beneficial control ${escape(safe.beneficialControl)}.`),
    "", "Configured recipients and Safe owners are intentions; live balances, ownership and extensions require separate observations.", ""];
}
function mechanism(capability: string, expected: string | null): AuthorityRegistryEntry["mechanism"] { const c = capability.toLowerCase(); return c.startsWith("bridge.") ? "unknown" : c.includes("safe") ? "safe" : c.includes("pda") || c.includes("mint authority") ? "pda" : c.includes("protocol") || c.includes("registry") ? "protocol" : expected ? "immutable" : "unknown"; }
function controlsManifestAddress(manifest: DeploymentManifest, observation: PassportAuthorityObservation): boolean {
  const c = manifest.configuration, evm = c.bridge?.ethereum, solana = c.bridge?.solana;
  const evmAddresses = [manifest.token?.address, ...manifest.grants.map(g => g.address), ...c.allocations.map(a => a.recipient), ...c.custodySafes.map(s => s.address),
    ...(evm ? [evm.token, evm.pool, evm.router, evm.rmn, evm.registry, evm.registryModule] : [])];
  const solanaAddresses = solana ? [solana.mint, solana.pool, solana.poolSigner, solana.poolTokenAccount, solana.lookupTable,
    solana.tokenProgram, solana.router, solana.offRamp, solana.rmn, solana.feeQuoter, solana.burnMintProgram] : [];
  return typeof observation.controlled === "string" && (
    (observation.chain === c.environment.evmChainId && evmAddresses.includes(observation.controlled))
    || (observation.chain === c.environment.solanaGenesisHash && solanaAddresses.includes(observation.controlled)));
}
type ExpectedAuthority = [string, string, string, string | null, string, string];
function bridgeAuthorityExpectations(c: DeploymentManifest["configuration"]): ExpectedAuthority[] {
  if (!c.bridge) { return []; }
  const { ethereum, solana } = c.bridge, evmChain = c.environment.evmChainId, solanaChain = c.environment.solanaGenesisHash;
  const evmPool = ethereum.pool ?? "unresolved", solanaPool = solana.pool ?? "unresolved", solanaMint = solana.mint ?? "unresolved";
  return [
    ["bridge.ethereum.pool-owner", evmChain, evmPool, ethereum.poolOwner, "configure pool and assign rebalancer", "Pool owner can assign a rebalancer able to withdraw locked backing"],
    ["bridge.ethereum.rebalancer", evmChain, evmPool, ethereum.rebalancer, "withdraw locked backing", "A missing configured rebalancer does not prevent the pool owner from assigning one later"],
    ["bridge.ethereum.rate-limit-admin", evmChain, evmPool, ethereum.rateLimitAdministrator, "change pool rate limits", "Rate limits do not prevent rebalancer withdrawal"],
    ["bridge.ethereum.registry-admin", evmChain, ethereum.registry, ethereum.registryAdministrator, "change the registered token pool", "Current TokenAdminRegistry administration requires live verification"],
    ["bridge.solana.pool-admin", solanaChain, solanaPool, solana.poolAdministrator, "change BurnMint pool configuration", "Configured pool administration is not live account evidence"],
    ["bridge.solana.registry-admin", solanaChain, solana.router, solana.registryAdministrator, "change the registered pool for the configured mint", "The mint-specific TokenAdminRegistry PDA and live administrator require separate verification"],
    ["bridge.solana.mint-authority", solanaChain, solanaMint, solana.poolSigner, "mint Solana representation", "The actual SPL mint authority requires live verification"],
    ["bridge.solana.program-upgrade", solanaChain, solana.burnMintProgram, solana.upgradeAuthority, "upgrade the BurnMint program", "ProgramData upgrade authority and program bytes require live verification"],
    ["bridge.solana.fee-quoter-upgrade", solanaChain, solana.feeQuoter, null, "upgrade the shared Fee Quoter program", "Exact Fee Quoter artifact and upgrade authority remain unqualified"],
  ];
}
function registryEntries(manifest: DeploymentManifest, observations: PassportObservation): AuthorityRegistryEntry[] {
  const c = manifest.configuration, observed = new Map((observations.authorities ?? []).map(a => [a.capability, a]));
  const expected: ExpectedAuthority[] = [["token.ccip-admin", c.environment.evmChainId, manifest.token?.address ?? "unresolved", c.token.initialCCIPAdmin, "administrative token control", "Initial administrator is recorded separately from current registry administration"]];
  for (const safe of c.custodySafes) {expected.push([`custody.safe.${safe.id}`, c.environment.evmChainId, safe.address, safe.address, "Safe CALL control", `threshold ${safe.threshold}; ${safe.beneficialControl}`]);}
  expected.push(...bridgeAuthorityExpectations(c));
  if (observed.size !== (observations.authorities ?? []).length) { fail("AUTHORITY_DUPLICATE"); }
  for (const a of observed.values()) {
    const binding = expected.find(([capability]) => capability === a.capability);
    if (!controlsManifestAddress(manifest, a) || (binding && (a.chain !== binding[1] || a.controlled !== binding[2]))) { fail("AUTHORITY_BINDING"); }
  }
  const result: AuthorityRegistryEntry[] = expected.map(([capability, chain, controlled, expectedValue, power, limitation]) => { const a = observed.get(capability); return { capability, chain, controlled, expected: expectedValue, observed: a?.observed ?? null, pending: a?.pending ?? null, mechanism: mechanism(capability, expectedValue), power, limitation, evidence: a?.evidence ?? null }; });
  for (const a of observations.authorities ?? []) { if (!result.some(e => e.capability === a.capability)) { result.push({ capability: a.capability, chain: a.chain, controlled: a.controlled, expected: null, observed: a.observed ?? null, pending: a.pending ?? null, mechanism: mechanism(a.capability, null), power: "unresolved", limitation: "No expected value is configured", evidence: a.evidence ?? null }); } }
  return result.toSorted((a, b) => a.capability.localeCompare(b.capability));
}
export function generatePassport(manifest: DeploymentManifest | PreparedAssemblyManifest | ObservedAssemblyManifest, observations: PassportObservation, hashes: PassportHashPort): TokenPassport {
  validateInputs(manifest, observations);
  if (manifest.schema === "agtmai-deployment-manifest-v2") { return manifest.status === "synthetic-local-observation" ? observedAssemblyPassport(manifest, observations, hashes) : preparedAssemblyPassport(manifest, observations, hashes); }
  const manifestSha256 = hashes.sha256(deploymentBytes(manifest)), observationsSha256 = hashes.sha256(deploymentBytes(observations)), entries = registryEntries(manifest, observations), registry = { schema: "agtmai-authority-registry-v1" as const, manifestSha256, observationsSha256, entries }, c = manifest.configuration;
  const lines = ["# AGTMAI token passport", "", `- Environment: \`${escape(c.environment.mode)}\``, `- Deployment status: \`${escape(manifest.status)}\``, `- Manifest digest: \`${manifestSha256}\``, `- Observation digest: \`${observationsSha256}\``, "- Broadcast allowed: `false`", "", "## Token", "", `- Name: ${escape(c.token.name)}`, `- Symbol: ${escape(c.token.symbol)}`, `- Decimals: ${c.token.decimals}`, `- Fixed issuance: ${c.token.initialSupplyBaseUnits} base units`, `- Ethereum token: \`${manifest.token?.address ?? "unresolved"}\``, "", ...allocationDisclosure(c), "## Grants", "", ...c.grants.map(cfg => { const deployed = manifest.grants.find(g => g.grantId === cfg.id); return `- ${escape(cfg.id)} (${cfg.kind}): ${cfg.amountBaseUnits} base units to \`${cfg.beneficiary}\`; schedule ${cfg.schedule.start}–${cfg.schedule.end}; vault \`${deployed?.address ?? "unresolved"}\`.`; }), "", ...deploymentTransactions(manifest), "## Readiness", "", `- Observation interval: ${observations.observedAt}–${observations.validUntil}`, `- Reconciliation: ${escape(observations.reconciliation?.status ?? "unresolved")}`, `- Estimates: ${escape(observations.estimates?.status ?? "unresolved")}`, ...(observations.unresolved ?? []).toSorted().map(x => `- Unresolved: ${escape(x)}`), "", "## Authority registry", "", "Expected authorities come from configuration. Observed values require separate live evidence; unresolved entries are not safety claims.", "", ...entries.map(e => `- ${escape(e.capability)} on ${escape(e.chain)}: power ${escape(e.power)}; expected ${escape(e.expected ?? "unresolved")}; observed ${escape(e.observed ?? "unresolved")}; ${escape(e.limitation)}.`)];
  return { schema: "agtmai-token-passport-v1", manifestSha256, observationsSha256, generated: { observedAt: observations.observedAt, validUntil: observations.validUntil }, markdown: `${lines.join("\n")}\n`, authorityRegistry: registry };
}
export function checkPassport(manifest: DeploymentManifest | PreparedAssemblyManifest | ObservedAssemblyManifest, observations: PassportObservation, passport: TokenPassport, hashes: PassportHashPort, now?: string): void { const expected = generatePassport(manifest, observations, hashes); if (now !== undefined && (!validTime(now) || BigInt(now) < BigInt(observations.observedAt) || BigInt(now) > BigInt(observations.validUntil))) { fail("OBSERVATIONS_EXPIRED"); } if (passport.broadcastAllowed !== expected.broadcastAllowed || passport.schema !== expected.schema || passport.manifestSha256 !== expected.manifestSha256 || passport.observationsSha256 !== expected.observationsSha256 || passport.markdown !== expected.markdown || canonicalJson(passport.authorityRegistry as unknown as JsonValue) !== canonicalJson(expected.authorityRegistry as unknown as JsonValue)) {fail("MISMATCH");} }
export function checkPassportFreshness(observations: PassportObservation, now: string): void { if (!validTime(now) || !validTime(observations.observedAt) || !validTime(observations.validUntil) || BigInt(now) < BigInt(observations.observedAt) || BigInt(now) > BigInt(observations.validUntil)) { fail("OBSERVATIONS_EXPIRED"); } }
export const generateTokenPassport = generatePassport;
export const deriveAuthorityRegistry = (manifest: DeploymentManifest | PreparedAssemblyManifest | ObservedAssemblyManifest, observations: PassportObservation, hashes: PassportHashPort): TokenPassport["authorityRegistry"] => generatePassport(manifest, observations, hashes).authorityRegistry;

function preparedAssemblyPassport(manifest: PreparedAssemblyManifest, observations: PassportObservation, hashes: PassportHashPort): TokenPassport {
  if (Object.keys(observations).some(k => !["schema", "observedAt", "validUntil", "unresolved"].includes(k))) { fail("ASSEMBLY_OBSERVATIONS_PENDING"); }
  const manifestSha256 = hashes.sha256(deploymentBytes(manifest)), observationsSha256 = hashes.sha256(deploymentBytes(observations));
  const c = manifest.configuration.deployment;
  const entries: AuthorityRegistryEntry[] = manifest.contracts.flatMap(contract => ["CONTROLLER", "BENEFICIARY", "INITIAL_CCIP_ADMIN"]
    .filter(name => contract.immutableValues[name] !== undefined).map(name => ({ capability: `${contract.id}.${name.toLowerCase()}`, chain: "1",
      controlled: contract.predictedAddress, expected: `0x${contract.immutableValues[name]!.slice(-40)}`, observed: null, pending: null,
      mechanism: "immutable" as const, power: name === "BENEFICIARY" ? "claim vested entitlement" : name === "INITIAL_CCIP_ADMIN" ? "initial CCIP administration" : "configured immutable control",
      limitation: "Predicted unsigned construction; deployed runtime, getters and Safe authority are unavailable", evidence: null })));
  const markdown = ["# AGTMAI token passport", "", "- Deployment status: `unsigned-preparation`", "- Broadcast allowed: `false`",
    `- Manifest digest: \`${manifestSha256}\``, "- Selected and accepted production configuration; deployment-unverified.",
    "", "## Readiness", "", `- Observation interval: ${observations.observedAt}–${observations.validUntil}`,
    ...(observations.unresolved ?? []).toSorted().map(x => `- Unresolved: ${escape(x)}`),
    "- Synthetic local observation: pending. Actual production deployment: unavailable.", "", ...allocationDisclosure(c),
    "## Purpose policies", "", ...manifest.facts.purposeVaults.map(p =>
      `- ${escape(p.allocationId)}: recipient \`${p.recipient}\`; opens ${p.opensAt}; window ${p.windowSeconds}; gross cap ${p.rollingCapBaseUnits}.`),
    "", manifest.facts.disclosure, "", "## Offline source-verification inputs", "", ...manifest.contracts.map(r =>
      `- ${escape(r.id)}: predicted \`${r.predictedAddress}\`; \`${r.fullyQualifiedName}\`; compiler input \`${r.compilerInputSha256}\`; runtime template \`${r.runtimeTemplateHash}\`; materialized expectation \`${r.materializedRuntimeHash}\`.`),
    "", "No deployment receipts or explorer verification are available. The nested founder vault belongs to its parent CREATE at child nonce 1.",
    "", "## Authority registry", "",
    "Expected authorities come from immutable construction and remain unobserved until deployment.", "",
    ...entries.map(e => `- ${escape(e.capability)} on ${escape(e.chain)}: power ${escape(e.power)}; expected ${escape(e.expected ?? "unresolved")}; observed ${escape(e.observed ?? "unresolved")}; ${escape(e.limitation)}.`),
    "",
    `Worst-case unsigned assembly cost: ${manifest.worstCaseWei} wei. Observed costs, live Ethereum fees and ETH/USD: unavailable.`, ""].join("\n");
  return { schema: "agtmai-token-passport-v1", manifestSha256, observationsSha256, generated: { observedAt: observations.observedAt, validUntil: observations.validUntil },
    markdown, authorityRegistry: { schema: "agtmai-authority-registry-v1", manifestSha256, observationsSha256, entries } };
}

function observedAssemblyPassport(manifest: ObservedAssemblyManifest, observations: PassportObservation, hashes: PassportHashPort): TokenPassport {
  const manifestSha256 = hashes.sha256(deploymentBytes(manifest)), observationsSha256 = hashes.sha256(deploymentBytes(observations));
  const entries: AuthorityRegistryEntry[] = manifest.contracts.flatMap(contract => ["CONTROLLER", "BENEFICIARY", "INITIAL_CCIP_ADMIN"]
    .filter(name => contract.immutableValues[name] !== undefined).map(name => ({ capability: `${contract.id}.${name.toLowerCase()}`, chain: "1 (synthetic loopback)",
      controlled: contract.predictedAddress, expected: `0x${contract.immutableValues[name]!.slice(-40)}`,
      observed: `0x${contract.observed.getters[name === "INITIAL_CCIP_ADMIN" ? "getCCIPAdmin" : name]!.slice(-40)}`, pending: null,
      mechanism: "immutable" as const, power: name === "BENEFICIARY" ? "claim vested entitlement" : name === "INITIAL_CCIP_ADMIN" ? "initial CCIP administration" : "configured immutable control",
      limitation: "Owned synthetic local observation; actual production deployment unavailable", evidence: manifest.evidenceSha256 })));
  for (const safe of manifest.authority) {
    entries.push({ capability: `custody.safe.${manifest.configuration.custodySafes.find(c => c.address === safe.address)!.id}`, chain: "1 (synthetic loopback)",
      controlled: safe.address, expected: safe.address, observed: safe.address, pending: null, mechanism: "safe", power: "Safe CALL control",
      limitation: `Actual local threshold ${safe.threshold} of ${safe.owners.length}; nonce ${safe.nonce}; empty modules, guard and fallback; production authority unavailable`, evidence: safe.setupProvenance });
  }
  const markdown = ["# AGTMAI token passport", "", "- Deployment status: `synthetic-local-observation`", "- Broadcast allowed: `false`",
    `- Manifest digest: \`${manifestSha256}\``, "- Selected test-only policy; production configuration and approval unavailable.",
    "- Chain ID 1 is synthetic owned loopback evidence. Actual production deployment unavailable.", "", manifest.packageTiming, "",
    "## Readiness", "", `- Observation interval: ${observations.observedAt}–${observations.validUntil}`,
    ...(observations.unresolved ?? []).toSorted().map(x => `- Unresolved: ${escape(x)}`),
    "- Synthetic local observation: observed owned loopback. Actual production deployment: unavailable.", "",
    "## Purpose policies", "", ...manifest.facts.purposeVaults.map(p => `- ${escape(p.allocationId)}: recipient \`${p.recipient}\`; opens ${p.opensAt}; window ${p.windowSeconds}; gross cap ${p.rollingCapBaseUnits}.`),
    "", manifest.facts.disclosure, "", "## Offline source-verification inputs", "", ...manifest.contracts.map(c =>
      `- ${escape(c.id)}: predicted \`${c.predictedAddress}\`; observed \`${c.observed.address}\`; \`${c.fullyQualifiedName}\`; compiler input \`${c.compilerInputSha256}\`; materialized runtime \`${c.materializedRuntimeHash}\`.`),
    "", "Nested founder creation uses its parent receipt and child nonce 1; its gas is included in the parent. No explorer submission or source-verification claim.",
    "", "## Authority registry", "",
    "Expected authorities come from immutable construction; observed values are owned synthetic local evidence. Actual production authority is unavailable.", "",
    ...entries.map(e => `- ${escape(e.capability)} on ${escape(e.chain)}: power ${escape(e.power)}; expected ${escape(e.expected ?? "unresolved")}; observed ${escape(e.observed ?? "unresolved")}; ${escape(e.limitation)}.`),
    "", "## Assembly gas (wei; local fees)", "", "| Operation | Estimate | Limit | Base fee | Priority | Max fee | Gas used | Effective price | Cost |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...manifest.gas.map(g => `| ${g.id} | ${g.gasEstimate} | ${g.gasLimit} | ${g.baseFeePerGas} | ${g.maxPriorityFeePerGas} | ${g.maxFeePerGas} | ${g.gasUsed} | ${g.effectiveGasPrice} | ${g.observedCostWei} |`), "",
    `Worst-case assembly: ${manifest.worstCaseWei} wei. Observed assembly: ${manifest.observedWei} wei.`,
    "Bootstrap, gas funding and scenario costs are separate. Live Ethereum fees and ETH/USD unavailable.", ""].join("\n");
  return { broadcastAllowed: false, schema: "agtmai-token-passport-v1", manifestSha256, observationsSha256, generated: { observedAt: observations.observedAt, validUntil: observations.validUntil },
    markdown, authorityRegistry: { broadcastAllowed: false, schema: "agtmai-authority-registry-v1", manifestSha256, observationsSha256, entries } };
}
