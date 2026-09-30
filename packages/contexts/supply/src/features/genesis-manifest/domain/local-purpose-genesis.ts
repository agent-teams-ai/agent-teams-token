import { encodeAllocationId, parseCanonicalUint, UINT64_MAX, UINT256_MAX } from "./model.js";
import { isEvmAddress, type DeploymentSafe, type Hex } from "./deployment.js";
import { validateReservePolicyBody, type ReservePolicyBody } from "./reserve-genesis.js";

export const PURPOSE_ALLOCATION_IDS = ["long-term", "users", "operations", "ecosystem", "financing", "liquidity"] as const;
export type PurposeAllocationId = typeof PURPOSE_ALLOCATION_IDS[number];

export interface LocalPurposePolicy {
  readonly allocationId: PurposeAllocationId;
  readonly opensAt: string;
  readonly windowSeconds: string;
  readonly rollingCapBaseUnits: string;
}
export interface LocalPurposeGenesis {
  readonly schema: "agtmai-local-purpose-genesis-v1";
  readonly status: "test-only";
  readonly chainId: "31337";
  readonly tokenContract: "AGTMAICCIPToken";
  readonly reserve: ReservePolicyBody;
  readonly custodySafes: readonly DeploymentSafe[];
  readonly roleAliases: readonly { readonly address: Hex; readonly roles: readonly string[] }[];
  readonly projectControllerSafeId: string;
  readonly founderBeneficiarySafeId: string;
  readonly purposeVaults: readonly LocalPurposePolicy[];
  readonly execution: {
    readonly sender: Hex;
    readonly startingNonce: string;
    readonly fundingDeadline: string;
    readonly fundingLeadSeconds: string;
    readonly executionDeadline: string;
    readonly maxFeePerGasWei: string;
    readonly maxPriorityFeePerGasWei: string;
    readonly maxGasPerTransaction: string;
    readonly maxTotalFeeWei: string;
  };
}

function reject(): never { throw new Error("LOCAL_PURPOSE_GENESIS_INVALID"); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) { return reject(); }
  const record = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))
    || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value");
    })) { return reject(); }
  return record;
}
function list(value: unknown, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length
    || Reflect.ownKeys(value).length !== length + 1) { return reject(); }
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) { return reject(); }
  }
  return value;
}
function address(value: unknown): asserts value is Hex { if (!isEvmAddress(value)) { reject(); } }
function uint(value: unknown, max = UINT64_MAX, positive = true): bigint {
  const parsed = parseCanonicalUint(value, max);
  if (parsed === undefined || (positive && parsed === 0n)) { return reject(); }
  return parsed;
}
function disclosure(value: unknown): void {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || [...value].some(c => c.charCodeAt(0) < 32)) { reject(); }
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function validateSafes(raw: unknown, reserve: ReservePolicyBody, projectId: unknown, founderId: unknown): {
  safes: DeploymentSafe[]; project: DeploymentSafe; founder: DeploymentSafe;
} {
  const safes = list(raw, 2).map(item => {
    const safe = exact(item, ["id", "address", "owners", "threshold", "beneficialControl", "disclosure"]);
    if (!encodeAllocationId(safe.id)) { reject(); }
    address(safe.address);
    const owners = list(safe.owners, 3);
    owners.forEach(address);
    if (new Set(owners).size !== 3 || owners.includes(safe.address) || safe.threshold !== 2
      || safe.beneficialControl !== "solo-founder") { reject(); }
    disclosure(safe.disclosure);
    return safe as unknown as DeploymentSafe;
  });
  if (safes[0]!.id === safes[1]!.id || safes[0]!.address === safes[1]!.address) { reject(); }
  const project = safes.find(safe => safe.id === projectId);
  const founder = safes.find(safe => safe.id === founderId);
  if (!project || !founder || project === founder) { return reject(); }
  if (reserve.founder.controller !== project.address || reserve.contributors.controller !== project.address
    || reserve.founder.beneficiary !== founder.address) { reject(); }
  return { safes, project, founder };
}

function validatePolicies(raw: unknown, reserve: ReservePolicyBody): LocalPurposePolicy[] {
  const policies = list(raw, PURPOSE_ALLOCATION_IDS.length).map(item => {
    const policy = exact(item, ["allocationId", "opensAt", "windowSeconds", "rollingCapBaseUnits"]);
    if (!PURPOSE_ALLOCATION_IDS.includes(policy.allocationId as PurposeAllocationId)) { reject(); }
    uint(policy.opensAt); uint(policy.windowSeconds);
    const cap = uint(policy.rollingCapBaseUnits);
    const amount = reserve.allocations.find(allocation => allocation.id === policy.allocationId)?.amountBaseUnits;
    if (!amount || cap > BigInt(amount)) { reject(); }
    return policy as unknown as LocalPurposePolicy;
  });
  if (new Set(policies.map(policy => policy.allocationId)).size !== PURPOSE_ALLOCATION_IDS.length) { reject(); }
  return policies;
}

function validateExecution(raw: unknown, reserve: ReservePolicyBody, policies: readonly LocalPurposePolicy[]): LocalPurposeGenesis["execution"] {
  const execution = exact(raw, ["sender", "startingNonce", "fundingDeadline", "fundingLeadSeconds",
    "executionDeadline", "maxFeePerGasWei", "maxPriorityFeePerGasWei", "maxGasPerTransaction", "maxTotalFeeWei"]);
  address(execution.sender);
  const nonce = uint(execution.startingNonce, UINT64_MAX, false);
  if (nonce + 10n > UINT64_MAX) { reject(); }
  const funding = uint(execution.fundingDeadline), lead = uint(execution.fundingLeadSeconds);
  const deadline = uint(execution.executionDeadline);
  const maxFee = uint(execution.maxFeePerGasWei, UINT256_MAX);
  const priority = uint(execution.maxPriorityFeePerGasWei, UINT256_MAX, false);
  uint(execution.maxGasPerTransaction); uint(execution.maxTotalFeeWei, UINT256_MAX);
  if (priority > maxFee || funding >= deadline || funding + lead > BigInt(reserve.founder.schedule.start)
    || policies.some(policy => deadline >= BigInt(policy.opensAt))) { reject(); }
  return execution as unknown as LocalPurposeGenesis["execution"];
}

function validateAliases(raw: unknown, execution: LocalPurposeGenesis["execution"], safes: readonly DeploymentSafe[],
  bindings: { project: DeploymentSafe; founder: DeploymentSafe }, reserve: ReservePolicyBody): LocalPurposeGenesis["roleAliases"] {
  const { project, founder } = bindings;
  // Explicitly disclose every intentional role overlap, including the bound Safe roles.
  const roles = new Map<string, string[]>();
  const add = (at: string, role: string): void => { roles.set(at, [...(roles.get(at) ?? []), role]); };
  add(execution.sender, "execution.sender");
  for (const safe of safes) {
    add(safe.address, `safe.${safe.id}.address`);
    for (const owner of safe.owners) { add(owner, `safe.${safe.id}.owner`); }
  }
  add(project.address, "token.initialCCIPAdmin");
  add(project.address, "founder.controller");
  add(project.address, "contributors.controller");
  add(founder.address, "founder.beneficiary");
  for (const allocation of reserve.allocations) { add(allocation.recipient, `allocation.${allocation.id}.recipient`); }
  if (roles.get(execution.sender)!.length !== 1
    || reserve.allocations.some(allocation => allocation.recipient === project.address || allocation.recipient === founder.address)) { reject(); }
  const aliases = Array.isArray(raw) && raw.length <= 32 ? list(raw, raw.length) : reject();
  const seen = new Set<string>();
  for (const item of aliases) {
    const alias = exact(item, ["address", "roles"]);
    address(alias.address);
    if (seen.has(alias.address)) { reject(); }
    seen.add(alias.address);
    const declared = Array.isArray(alias.roles) ? list(alias.roles, alias.roles.length) : reject();
    const actual = roles.get(alias.address);
    if (!actual || actual.length < 2 || declared.length !== actual.length
      || declared.some(role => typeof role !== "string" || !actual.includes(role))
      || new Set(declared).size !== declared.length) { reject(); }
  }
  if ([...roles].some(([at, names]) => names.length > 1 && !seen.has(at))) { reject(); }
  return aliases as LocalPurposeGenesis["roleAliases"];
}

/** Offline test-only policy validation. Predicted CREATE recipients are checked by the planner. */
export function validateLocalPurposeGenesis(input: unknown): LocalPurposeGenesis {
  const root = exact(input, ["schema", "status", "chainId", "tokenContract", "reserve", "custodySafes",
    "roleAliases", "projectControllerSafeId", "founderBeneficiarySafeId", "purposeVaults", "execution"]);
  if (root.schema !== "agtmai-local-purpose-genesis-v1" || root.status !== "test-only"
    || root.chainId !== "31337" || root.tokenContract !== "AGTMAICCIPToken") { reject(); }
  let reserve: ReservePolicyBody;
  try { reserve = validateReservePolicyBody(root.reserve); } catch { return reject(); }

  const { safes, project, founder } = validateSafes(root.custodySafes, reserve,
    root.projectControllerSafeId, root.founderBeneficiarySafeId);
  const policies = validatePolicies(root.purposeVaults, reserve);
  const execution = validateExecution(root.execution, reserve, policies);
  const aliases = validateAliases(root.roleAliases, execution, safes, { project, founder }, reserve);
  return { ...structuredClone(input as LocalPurposeGenesis), reserve,
    custodySafes: safes.map(s => ({ ...s, owners: [...s.owners].toSorted() })).toSorted((a, b) => compareText(a.id, b.id)),
    roleAliases: aliases.map(a => ({ ...a, roles: [...a.roles].toSorted() })).toSorted((a, b) => compareText(a.address, b.address)),
    purposeVaults: structuredClone(policies).toSorted((a, b) => PURPOSE_ALLOCATION_IDS.indexOf(a.allocationId) - PURPOSE_ALLOCATION_IDS.indexOf(b.allocationId)),
  };
}
