import { parseCanonicalUint, UINT64_MAX, UINT256_MAX } from "./model.js";
import type { ReservePolicyBody } from "./reserve-genesis.js";
export const PURPOSE_ALLOCATION_IDS = ["long-term", "users", "operations", "ecosystem", "financing", "liquidity"] as const;
export type PurposeAllocationId = typeof PURPOSE_ALLOCATION_IDS[number];

export interface PurposePolicy {
  readonly allocationId: PurposeAllocationId;
  readonly opensAt: string;
  readonly windowSeconds: string;
  readonly rollingCapBaseUnits: string;
}
function reject(): never { throw new Error("PURPOSE_POLICY_INVALID"); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) { return reject(); }
  const record = value as Record<string, unknown>;
  const own = Reflect.ownKeys(record);
  if (own.length !== keys.length || own.some(k => typeof k !== "string" || !keys.includes(k))
    || keys.some(k => { const d = Object.getOwnPropertyDescriptor(record, k); return !d?.enumerable || !Object.hasOwn(d, "value"); })) { reject(); }
  return record;
}
function list(value: unknown, length: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length || Reflect.ownKeys(value).length !== length + 1) { return reject(); }
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !Object.hasOwn(d, "value")) { reject(); }
  }
  return value;
}
function uint(value: unknown, max = UINT64_MAX): bigint {
  const n = parseCanonicalUint(value, max);
  if (n === undefined || n === 0n) { return reject(); }
  return n;
}
export function validatePurposePolicies(raw: unknown, reserve: ReservePolicyBody): PurposePolicy[] {
  const policies = list(raw, PURPOSE_ALLOCATION_IDS.length).map(item => {
    const policy = exact(item, ["allocationId", "opensAt", "windowSeconds", "rollingCapBaseUnits"]);
    if (!PURPOSE_ALLOCATION_IDS.includes(policy.allocationId as PurposeAllocationId)) { reject(); }
    uint(policy.opensAt); uint(policy.windowSeconds);
    const cap = uint(policy.rollingCapBaseUnits, UINT256_MAX);
    const amount = reserve.allocations.find(allocation => allocation.id === policy.allocationId)?.amountBaseUnits;
    if (!amount || cap > BigInt(amount)) { reject(); }
    return policy as unknown as PurposePolicy;
  });
  if (new Set(policies.map(policy => policy.allocationId)).size !== PURPOSE_ALLOCATION_IDS.length) { reject(); }
  return structuredClone(policies).toSorted((a, b) => PURPOSE_ALLOCATION_IDS.indexOf(a.allocationId) - PURPOSE_ALLOCATION_IDS.indexOf(b.allocationId));
}
