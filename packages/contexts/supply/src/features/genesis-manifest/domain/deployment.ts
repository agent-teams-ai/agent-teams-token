import { compareDiagnostics, encodeAllocationId, normalizeAllocationSet, parseCanonicalUint, UINT64_MAX, UINT256_MAX,
  EXPECTED_TOKEN, type Diagnostic, type NormalizedAllocation, type SourceAllocation } from "./model.js";
import { validateGrantSchedule, type GrantSchedule } from "./grant-schedule.js";

export type DeploymentMode = "local-test" | "owned-testnet" | "mainnet-dry-run";
export type Hex = `0x${string}`;
export interface DeploymentSafe {
  readonly id: string; readonly address: Hex; readonly owners: readonly Hex[]; readonly threshold: 2;
  readonly beneficialControl: "solo-founder" | "independent-disclosed";
  readonly disclosure: string;
}
export interface DeploymentGrant {
  readonly id: string; readonly kind: "founder" | "team"; readonly beneficiary: Hex;
  readonly fundingAllocation: string; readonly controllerSafe: string;
  readonly amountBaseUnits: string; readonly originalPurpose: Hex; readonly schedule: GrantSchedule;
}
export interface RateLimit { readonly enabled: boolean; readonly capacity: string; readonly rate: string }
export interface DeploymentBridge {
  readonly protocol: { readonly reference: string; readonly snapshotSha256: Hex; readonly networkDataSha256: Hex };
  readonly ethereum: {
    readonly token: Hex | null; readonly pool: Hex | null; readonly router: Hex; readonly rmn: Hex;
    readonly registry: Hex; readonly registryModule: Hex; readonly registryAdministrator: Hex;
    readonly poolOwner: Hex; readonly rateLimitAdministrator: Hex; readonly rebalancer: Hex | null;
    readonly inbound: RateLimit; readonly outbound: RateLimit;
  };
  readonly solana: {
    readonly mint: string | null; readonly pool: string | null; readonly poolSigner: string | null;
    readonly poolTokenAccount: string | null; readonly lookupTable: string | null;
    readonly tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    readonly router: string; readonly offRamp: string; readonly rmn: string; readonly feeQuoter: string;
    readonly burnMintProgram: string; readonly poolAdministrator: string; readonly registryAdministrator: string;
    readonly upgradeAuthority: string | null; readonly inbound: RateLimit; readonly outbound: RateLimit;
  };
}
export interface DeploymentPolicy {
  readonly tokenExpenditureCeilingBaseUnits: string;
  readonly evmMaxFeePerGasWei: string; readonly evmMaxPriorityFeePerGasWei: string;
  readonly evmMaxGasPerTransaction: string; readonly evmMaxTotalFeeWei: string;
  readonly solanaMaxFeeLamports: string; readonly solanaMaxTotalFeeLamports: string;
  readonly observationMaxAgeSeconds: string; readonly executionDeadline: string;
  readonly fundingDeadline: string; readonly fundingLeadSeconds: string; readonly estimateValiditySeconds: string; readonly gasBufferBps: number;
}
export interface DeploymentTestScenario {
  readonly label: "test-only";
  readonly transfers: readonly { readonly id: string; readonly direction: "ethereum-solana" | "solana-ethereum";
    readonly amountBaseUnits: string; readonly evmRecipient: Hex; readonly solanaRecipient: string }[];
}
export interface DeploymentConfig {
  readonly schemaVersion: 1; readonly deploymentId: string;
  readonly status: "draft" | "test-only" | "accepted";
  readonly environment: {
    readonly mode: DeploymentMode; readonly evmChainId: string;
    readonly solanaGenesisHash: string; readonly evmSelector: string; readonly solanaSelector: string;
  };
  readonly token: typeof EXPECTED_TOKEN & { readonly initialSupplyBaseUnits: string; readonly initialCCIPAdmin: Hex };
  readonly allocations: readonly SourceAllocation[]; readonly grants: readonly DeploymentGrant[];
  readonly custodySafes: readonly DeploymentSafe[];
  readonly roleAliases: readonly { readonly address: Hex; readonly roles: readonly string[] }[];
  readonly bridge: DeploymentBridge | null;
  readonly testScenario: DeploymentTestScenario | null;
  readonly policy: DeploymentPolicy;
}
declare const deploymentBrand: unique symbol;
export type ValidatedDeployment = DeploymentConfig & { readonly [deploymentBrand]: true };
export interface DeploymentValidation {
  readonly diagnostics: readonly Diagnostic[]; readonly value?: ValidatedDeployment;
  readonly allocations?: readonly NormalizedAllocation[];
}

export function isEvmAddress(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
}
export function isDigest(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}
/** Decode base58 locally to check the canonical 32-byte public-address width. */
export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) { return false; }
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let decoded = 0n;
  for (const c of value) {
    const digit = alphabet.indexOf(c);
    if (digit < 0) { return false; }
    decoded = decoded * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (decoded > 0n) { bytes++; decoded >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}

/** One runtime authority for authored deployment facts; no IO, defaults, clock or approval lookup. */
export function validateDeployment(value: unknown): DeploymentValidation {
  const diagnostics: Diagnostic[] = [];
  const checks = deploymentChecks(diagnostics);
  const { root, production } = validateHeader(value, checks);
  validateAllocations(root.allocations, checks);
  validateSafes(root.custodySafes, checks);
  validateGrants(root.grants, production, checks, diagnostics);
  validateAliases(root.roleAliases, checks);
  validatePolicy(root.policy, checks);
  validateBridge(root.bridge, production, checks);
  validateTestScenario(root.testScenario, production, checks);
  if (diagnostics.length) { return { diagnostics: diagnostics.toSorted(compareDiagnostics) }; }
  const config = value as DeploymentConfig;
  const normalized = normalizeAllocationSet(config.token.initialSupplyBaseUnits, config.allocations, "deployment");
  diagnostics.push(...normalized.diagnostics.map(d => ({ ...d, message: "invalid or unresolved deployment input" })));
  validateReferences(config, checks.fail);
  validateOperationalPolicy(config, checks.fail);
  validateRoleAliases(config, checks.fail);
  if (diagnostics.length || !normalized.allocations) { return { diagnostics: diagnostics.toSorted(compareDiagnostics) }; }
  // Normalize unordered sets, then detach from the authored object. No caller mutation can change the selected facts.
  const normalizedConfig = structuredClone(config);
  const result = { ...normalizedConfig,
    allocations: normalized.allocations.map(({ idBytes32: _idBytes32, ...a }) => a),
    grants: [...normalizedConfig.grants].toSorted((a, b) => a.id < b.id ? -1 : 1),
    custodySafes: normalizedConfig.custodySafes.map(s => ({ ...s, owners: [...s.owners].toSorted() })).toSorted((a, b) => a.id < b.id ? -1 : 1),
    roleAliases: normalizedConfig.roleAliases.map(a => ({ ...a, roles: [...a.roles].toSorted() })).toSorted((a, b) => a.address < b.address ? -1 : 1),
  };
  return { diagnostics: [], value: result as DeploymentConfig as ValidatedDeployment, allocations: normalized.allocations };
}

type DeploymentChecks = ReturnType<typeof deploymentChecks>;
function deploymentChecks(diagnostics: Diagnostic[]) {
  const fail = (code: string, pointer: string): void => {
    diagnostics.push({ code: `DEPLOYMENT_${code}`, pointer, severity: "error", message: "invalid or unresolved deployment input" });
  };
  const object = (input: unknown, pointer: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) { fail("OBJECT_REQUIRED", pointer); return {}; }
    const record = input as Record<string, unknown>;
    // Unknown keys are deliberately not echoed: even field names can contain secrets.
    if (Object.keys(record).some(key => !keys.includes(key))) { fail("UNKNOWN_FIELD", pointer); }
    for (const key of keys) { if (!(key in record) && !optional.includes(key)) { fail("REQUIRED", `${pointer}/${key}`); } }
    return record;
  };
  const array = (input: unknown, pointer: string, max: number, min = 0): unknown[] => {
    if (!Array.isArray(input) || input.length < min || input.length > max) { fail("COLLECTION_BOUND", pointer); return []; }
    return input;
  };
  const uint = (input: unknown, pointer: string, max = UINT64_MAX, positive = true): bigint | undefined => {
    // Bound digits before bigint parsing, including when called without the source parser.
    const n = typeof input === "string" && input.length <= 78 ? parseCanonicalUint(input, max) : undefined;
    if (n === undefined || (positive && n === 0n)) { fail("UINT_INVALID", pointer); }
    return n;
  };
  const oneOf = (input: unknown, pointer: string, options: readonly unknown[]): void => {
    if (!options.includes(input)) { fail("VALUE_INVALID", pointer); }
  };
  const address = (input: unknown, pointer: string, chain: "evm" | "solana", nullable = false): void => {
    if (nullable && input === null) { return; }
    if (!(chain === "evm" ? isEvmAddress(input) : isSolanaAddress(input))) { fail("ADDRESS_INVALID", pointer); }
  };
  const id = (input: unknown, pointer: string): void => { if (!encodeAllocationId(input)) { fail("ID_INVALID", pointer); } };
  return { fail, object, array, uint, oneOf, address, id };
}
function validateHeader(value: unknown, checks: DeploymentChecks) {
  const { object, oneOf, id, address, uint, fail } = checks;
  const root = object(value, "", ["schemaVersion", "deploymentId", "status", "environment", "token", "allocations", "grants", "custodySafes", "roleAliases", "bridge", "testScenario", "policy"]);
  oneOf(root.schemaVersion, "/schemaVersion", [1]); id(root.deploymentId, "/deploymentId");
  oneOf(root.status, "/status", ["draft", "test-only", "accepted"]);
  const env = object(root.environment, "/environment", ["mode", "evmChainId", "solanaGenesisHash", "evmSelector", "solanaSelector"]);
  oneOf(env.mode, "/environment/mode", ["local-test", "owned-testnet", "mainnet-dry-run"]);
  const production = env.mode === "mainnet-dry-run";
  oneOf(env.evmChainId, "/environment/evmChainId", [production ? "1" : env.mode === "owned-testnet" ? "11155111" : "31337"]);
  address(env.solanaGenesisHash, "/environment/solanaGenesisHash", "solana");
  uint(env.evmSelector, "/environment/evmSelector"); uint(env.solanaSelector, "/environment/solanaSelector");
  if (env.evmSelector === env.solanaSelector) { fail("SELECTOR_ALIAS", "/environment"); }
  if (root.status !== "draft") { oneOf(root.status, "/status", [production ? "accepted" : "test-only"]); }
  const token = object(root.token, "/token", ["name", "symbol", "decimals", "initialSupplyBaseUnits", "initialCCIPAdmin"]);
  for (const key of ["name", "symbol", "decimals"] as const) { oneOf(token[key], `/token/${key}`, [EXPECTED_TOKEN[key]]); }
  uint(token.initialSupplyBaseUnits, "/token/initialSupplyBaseUnits");
  address(token.initialCCIPAdmin, "/token/initialCCIPAdmin", "evm");
  return { root, production };
}
function validateAllocations(input: unknown, checks: DeploymentChecks): void {
  const { array, object, id, address, uint, fail } = checks;
  const allocations = array(input, "/allocations", 32, 1);
  for (const [i, entry] of allocations.entries()) {
    const p = `/allocations/${i}`, a = object(entry, p, ["id", "recipient", "amountBaseUnits", "bps"], ["bps"]);
    id(a.id, `${p}/id`); address(a.recipient, `${p}/recipient`, "evm"); uint(a.amountBaseUnits, `${p}/amountBaseUnits`);
    if (a.bps !== undefined && (!Number.isInteger(a.bps) || (a.bps as number) < 0 || (a.bps as number) > 10_000)) { fail("BPS_INVALID", `${p}/bps`); }
  }

}
function validateSafes(input: unknown, checks: DeploymentChecks): void {
  const { array, object, id, address, oneOf, fail } = checks;
  const safes = array(input, "/custodySafes", 32);
  for (const [i, entry] of safes.entries()) {
    const p = `/custodySafes/${i}`, s = object(entry, p, ["id", "address", "owners", "threshold", "beneficialControl", "disclosure"]);
    id(s.id, `${p}/id`); address(s.address, `${p}/address`, "evm");
    const owners = array(s.owners, `${p}/owners`, 3, 3);
    for (const [j, owner] of owners.entries()) { address(owner, `${p}/owners/${j}`, "evm"); }
    if (new Set(owners).size !== 3 || owners.includes(s.address)) { fail("SAFE_OWNERS", `${p}/owners`); }
    oneOf(s.threshold, `${p}/threshold`, [2]);
    oneOf(s.beneficialControl, `${p}/beneficialControl`, ["solo-founder", "independent-disclosed"]);
    if (typeof s.disclosure !== "string" || !s.disclosure.trim() || s.disclosure.length > 512 || [...s.disclosure].some(c => c.charCodeAt(0) < 32)) { fail("DISCLOSURE_REQUIRED", `${p}/disclosure`); }
  }

}
function validateGrants(input: unknown, production: boolean, checks: DeploymentChecks, diagnostics: Diagnostic[]): void {
  const { array, object, id, address, uint, oneOf, fail } = checks;
  const grants = array(input, "/grants", 64);
  for (const [i, entry] of grants.entries()) {
    const p = `/grants/${i}`, g = object(entry, p, ["id", "kind", "beneficiary", "fundingAllocation", "controllerSafe", "amountBaseUnits", "originalPurpose", "schedule"]);
    id(g.id, `${p}/id`); oneOf(g.kind, `${p}/kind`, ["founder", "team"]); address(g.beneficiary, `${p}/beneficiary`, "evm");
    id(g.fundingAllocation, `${p}/fundingAllocation`); id(g.controllerSafe, `${p}/controllerSafe`);
    uint(g.amountBaseUnits, `${p}/amountBaseUnits`);
    if (!isDigest(g.originalPurpose) || /^0x0{64}$/.test(g.originalPurpose)) { fail("PURPOSE_INVALID", `${p}/originalPurpose`); }
    const schedule = object(g.schedule, `${p}/schedule`, ["profile", "start", "cliff", "end", "anniversaryRule"], ["anniversaryRule"]);
    diagnostics.push(...validateGrantSchedule(schedule as unknown as GrantSchedule, production, `${p}/schedule`));
  }

}
function validateAliases(input: unknown, checks: DeploymentChecks): void {
  const { array, object, address, fail } = checks;
  const aliases = array(input, "/roleAliases", 128);
  for (const [i, entry] of aliases.entries()) {
    const p = `/roleAliases/${i}`, a = object(entry, p, ["address", "roles"]);
    address(a.address, `${p}/address`, "evm");
    const roles = array(a.roles, `${p}/roles`, 128, 2);
    if (roles.some(role => typeof role !== "string" || role.length > 160) || new Set(roles).size !== roles.length) { fail("ROLE_ALIAS_INVALID", `${p}/roles`); }
  }

}
function validatePolicy(input: unknown, checks: DeploymentChecks): void {
  const { object, uint, fail } = checks;
  const policyKeys = ["tokenExpenditureCeilingBaseUnits", "evmMaxFeePerGasWei", "evmMaxPriorityFeePerGasWei", "evmMaxGasPerTransaction", "evmMaxTotalFeeWei", "solanaMaxFeeLamports", "solanaMaxTotalFeeLamports", "observationMaxAgeSeconds", "executionDeadline", "fundingDeadline", "fundingLeadSeconds", "estimateValiditySeconds", "gasBufferBps"] as const;
  const policy = object(input, "/policy", policyKeys);
  for (const key of policyKeys) {
    if (key === "gasBufferBps") {
      if (!Number.isInteger(policy[key]) || (policy[key] as number) < 0 || (policy[key] as number) > 10_000) { fail("GAS_BUFFER", `/policy/${key}`); }
    } else { uint(policy[key], `/policy/${key}`, key.startsWith("evm") ? UINT256_MAX : UINT64_MAX, key !== "evmMaxPriorityFeePerGasWei"); }
  }

}
function validateBridge(input: unknown, production: boolean, checks: DeploymentChecks): void {
  const { object, uint, oneOf, address, fail } = checks;
  const rate = (rateInput: unknown, pointer: string, max: bigint): void => {
    const r = object(rateInput, pointer, ["enabled", "capacity", "rate"]);
    oneOf(r.enabled, `${pointer}/enabled`, [true, false]);
    const capacity = uint(r.capacity, `${pointer}/capacity`, max, false), perSecond = uint(r.rate, `${pointer}/rate`, max, false);
    if (capacity !== undefined && perSecond !== undefined && (r.enabled === false ? capacity !== 0n || perSecond !== 0n : capacity === 0n || perSecond === 0n || perSecond > capacity)) { fail("LIMITER_INVALID", pointer); }
  };
  if (input !== null) {
    const b = object(input, "/bridge", ["protocol", "ethereum", "solana"]);
    const pin = object(b.protocol, "/bridge/protocol", ["reference", "snapshotSha256", "networkDataSha256"]);
    if (typeof pin.reference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9./_-]{0,159}$/.test(pin.reference) || pin.reference.includes("..")) { fail("PROTOCOL_REFERENCE", "/bridge/protocol/reference"); }
    for (const k of ["snapshotSha256", "networkDataSha256"]) { if (!isDigest(pin[k])) { fail("DIGEST_INVALID", `/bridge/protocol/${k}`); } }
    const evmKeys = ["token", "pool", "router", "rmn", "registry", "registryModule", "registryAdministrator", "poolOwner", "rateLimitAdministrator", "rebalancer", "inbound", "outbound"];
    const e = object(b.ethereum, "/bridge/ethereum", evmKeys);
    for (const k of evmKeys.filter(key => key !== "inbound" && key !== "outbound")) { address(e[k], `/bridge/ethereum/${k}`, "evm", ["token", "pool", "rebalancer"].includes(k)); }
    for (const k of ["inbound", "outbound"]) { rate(e[k], `/bridge/ethereum/${k}`, (1n << 128n) - 1n); }
    const solKeys = ["mint", "pool", "poolSigner", "poolTokenAccount", "lookupTable", "tokenProgram", "router", "offRamp", "rmn", "feeQuoter", "burnMintProgram", "poolAdministrator", "registryAdministrator", "upgradeAuthority", "inbound", "outbound"];
    const s = object(b.solana, "/bridge/solana", solKeys);
    for (const k of solKeys.filter(key => key !== "inbound" && key !== "outbound")) { address(s[k], `/bridge/solana/${k}`, "solana", ["mint", "pool", "poolSigner", "poolTokenAccount", "lookupTable", "upgradeAuthority"].includes(k)); }
    oneOf(s.tokenProgram, "/bridge/solana/tokenProgram", ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    for (const k of ["inbound", "outbound"]) { rate(s[k], `/bridge/solana/${k}`, UINT64_MAX); }
  } else if (production) { fail("BRIDGE_REQUIRED", "/bridge"); }

}
function validateTestScenario(input: unknown, production: boolean, checks: DeploymentChecks): void {
  const { array, object, uint, oneOf, id, address, fail } = checks;
  if (input !== null) {
    if (production) { fail("TEST_SCENARIO_FORBIDDEN", "/testScenario"); }
    const t = object(input, "/testScenario", ["label", "transfers"]);
    oneOf(t.label, "/testScenario/label", ["test-only"]);
    const transfers = array(t.transfers, "/testScenario/transfers", 32);
    for (const [i, entry] of transfers.entries()) {
      const p = `/testScenario/transfers/${i}`, transfer = object(entry, p, ["id", "direction", "amountBaseUnits", "evmRecipient", "solanaRecipient"]);
      id(transfer.id, `${p}/id`); oneOf(transfer.direction, `${p}/direction`, ["ethereum-solana", "solana-ethereum"]);
      uint(transfer.amountBaseUnits, `${p}/amountBaseUnits`); address(transfer.evmRecipient, `${p}/evmRecipient`, "evm"); address(transfer.solanaRecipient, `${p}/solanaRecipient`, "solana");
    }
  } else if (!production) { fail("TEST_LABEL_REQUIRED", "/testScenario"); }

}
function validateReferences(config: DeploymentConfig, fail: DeploymentChecks["fail"]): void {
  for (const [entries, path] of [[config.allocations, "/allocations"], [config.grants, "/grants"], [config.custodySafes, "/custodySafes"], [config.testScenario?.transfers ?? [], "/testScenario/transfers"]] as const) {
    if (new Set(entries.map(e => e.id)).size !== entries.length) { fail("DUPLICATE_ID", path); }
  }
  if (new Set(config.custodySafes.map(s => s.address)).size !== config.custodySafes.length) { fail("DUPLICATE_SAFE", "/custodySafes"); }
  for (const [i, grant] of config.grants.entries()) {
    if (!config.allocations.some(a => a.id === grant.fundingAllocation)) { fail("RESERVE_REFERENCE", `/grants/${i}/fundingAllocation`); }
    if (!config.custodySafes.some(s => s.id === grant.controllerSafe)) { fail("SAFE_REFERENCE", `/grants/${i}/controllerSafe`); }
    if (BigInt(config.policy.fundingDeadline) > BigInt(grant.schedule.start) - BigInt(config.policy.fundingLeadSeconds)) { fail("FUNDING_DEADLINE", `/grants/${i}/schedule/start`); }
  }
  for (const allocation of config.allocations) {
    const committed = config.grants.filter(g => g.fundingAllocation === allocation.id).reduce((sum, g) => sum + BigInt(g.amountBaseUnits), 0n);
    if (committed > BigInt(allocation.amountBaseUnits)) { fail("RESERVE_INSOLVENT", "/grants"); }
  }

}
function validateOperationalPolicy(config: DeploymentConfig, fail: DeploymentChecks["fail"]): void {
  const p = config.policy;
  if (BigInt(p.fundingDeadline) >= BigInt(p.executionDeadline)) { fail("EXECUTION_DEADLINE", "/policy/executionDeadline"); }
  const expenditure = config.grants.reduce((sum, g) => sum + BigInt(g.amountBaseUnits), 0n) + (config.testScenario?.transfers ?? []).reduce((sum, t) => sum + BigInt(t.amountBaseUnits), 0n);
  if (expenditure > BigInt(p.tokenExpenditureCeilingBaseUnits)) { fail("EXPENDITURE_EXCEEDED", "/policy/tokenExpenditureCeilingBaseUnits"); }
  if (BigInt(p.evmMaxPriorityFeePerGasWei) > BigInt(p.evmMaxFeePerGasWei)) { fail("FEE_POLICY", "/policy/evmMaxPriorityFeePerGasWei"); }
  if (BigInt(p.solanaMaxFeeLamports) > BigInt(p.solanaMaxTotalFeeLamports)) { fail("FEE_POLICY", "/policy/solanaMaxFeeLamports"); }
  if (BigInt(p.estimateValiditySeconds) > BigInt(p.observationMaxAgeSeconds)) { fail("ESTIMATE_FRESHNESS", "/policy/estimateValiditySeconds"); }

}

function validateRoleAliases(config: DeploymentConfig, fail: (code: string, pointer: string) => void): void {
  const roles = new Map<string, string[]>();
  const add = (address: string, role: string): void => { roles.set(address, [...(roles.get(address) ?? []), role]); };
  add(config.token.initialCCIPAdmin, "token.initialCCIPAdmin");
  for (const a of config.allocations) { add(a.recipient, `allocation.${a.id}.recipient`); }
  for (const g of config.grants) { add(g.beneficiary, `grant.${g.id}.beneficiary`); }
  for (const s of config.custodySafes) {
    add(s.address, `safe.${s.id}.address`);
    for (const owner of s.owners) { add(owner, `safe.${s.id}.owner`); }
  }
  for (const [address, names] of roles) {
    if (names.length < 2) { continue; }
    const matches = config.roleAliases.filter(a => a.address === address);
    if (matches.length !== 1 || JSON.stringify([...matches[0]!.roles].toSorted()) !== JSON.stringify([...names].toSorted())) { fail("ROLE_ALIAS_UNAPPROVED", "/roleAliases"); }
  }
  for (const a of config.roleAliases) {
    if ((roles.get(a.address)?.length ?? 0) < 2) { fail("ROLE_ALIAS_UNUSED", "/roleAliases"); }
  }
}
