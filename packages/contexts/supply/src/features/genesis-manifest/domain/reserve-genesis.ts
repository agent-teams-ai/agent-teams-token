import { encodeAllocationId, normalizeAllocationSet, parseCanonicalUint } from "./model.js";
import { validateGrantSchedule, type GrantSchedule } from "./grant-schedule.js";

export interface ReserveGenesis {
  readonly schema: "agtmai-reserve-genesis-v1";
  readonly status: "accepted";
  readonly initialSupplyBaseUnits: string;
  readonly allocations: readonly {
    readonly id: string; readonly recipient: string; readonly amountBaseUnits: string; readonly bps: number;
  }[];
  readonly founder: {
    readonly beneficiary: string; readonly controller: string; readonly purpose: string;
    readonly schedule: GrantSchedule;
  };
  readonly contributors: {
    readonly controller: string; readonly purpose: string;
    readonly rollingCapBaseUnits: string; readonly perGrantCapBaseUnits: string;
  };
}

// ADR-0008: 100,000,000 AGTMAI at 9 decimals; the contributor 20% is split 3%/17%.
const APPROVED_SUPPLY_BASE_UNITS = 100_000_000_000_000_000n;
const APPROVED_ALLOCATION_BPS: Readonly<Record<string, number>> = {
  "long-term": 3000, users: 3000, founder: 300, contributors: 1700,
  operations: 900, ecosystem: 500, financing: 500, liquidity: 100,
};

function reject(): never { throw new Error("RESERVE_GENESIS_INVALID"); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) { return reject(); }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) { return reject(); }
  return record;
}
function address(value: unknown): void {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value) || /^0x0{40}$/.test(value)) { reject(); }
}
function purpose(value: unknown): void {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || /^0x0{64}$/.test(value)) { reject(); }
}
function positive(value: unknown): bigint {
  const result = parseCanonicalUint(value);
  if (result === undefined || result === 0n) { return reject(); }
  return result;
}

function validateAllocations(allocations: unknown, supply: bigint): void {
  if (!Array.isArray(allocations) || allocations.length !== 8) { reject(); }
  for (const value of allocations) {
    const allocation = object(value, ["id", "recipient", "amountBaseUnits", "bps"]);
    if (!encodeAllocationId(allocation.id) || !Number.isInteger(allocation.bps)
      || !Object.hasOwn(APPROVED_ALLOCATION_BPS, allocation.id as string)
      || allocation.bps !== APPROVED_ALLOCATION_BPS[allocation.id as string]) { reject(); }
    address(allocation.recipient);
    const numerator = supply * BigInt(allocation.bps as number);
    if (numerator % 10_000n !== 0n || positive(allocation.amountBaseUnits) !== numerator / 10_000n) { reject(); }
  }
}

/** Strict offline validation of the accepted production allocation policy.
 * The 20% contributor envelope is represented by separate 3% founder and 17% reserve recipients.
 * This verifies authored facts, never deployed code, transactions or custody observations. */
export function validateReserveGenesis(input: unknown): ReserveGenesis {
  const root = object(input, ["schema", "status", "initialSupplyBaseUnits", "allocations", "founder", "contributors"]);
  if (root.schema !== "agtmai-reserve-genesis-v1" || root.status !== "accepted") { reject(); }
  const supply = positive(root.initialSupplyBaseUnits);
  if (supply !== APPROVED_SUPPLY_BASE_UNITS) { reject(); }
  validateAllocations(root.allocations, supply);
  const typed = input as ReserveGenesis;
  const normalized = normalizeAllocationSet(typed.initialSupplyBaseUnits, typed.allocations, "deployment");
  if (normalized.diagnostics.length || !normalized.allocations) { reject(); }
  const contributorAllocation = typed.allocations.find(a => a.id === "contributors");
  if (!contributorAllocation) { reject(); }
  const founder = object(root.founder, ["beneficiary", "controller", "purpose", "schedule"]);
  address(founder.beneficiary); address(founder.controller); purpose(founder.purpose);
  const scheduleKeys = ["profile", "start", "cliff", "end"];
  const rawSchedule = founder.schedule;
  if (rawSchedule !== null && typeof rawSchedule === "object" && Object.hasOwn(rawSchedule, "anniversaryRule")) {
    scheduleKeys.push("anniversaryRule");
  }
  object(rawSchedule, scheduleKeys);
  if (validateGrantSchedule(rawSchedule as GrantSchedule, true, "/founder/schedule").length) { reject(); }
  const contributors = object(root.contributors, ["controller", "purpose", "rollingCapBaseUnits", "perGrantCapBaseUnits"]);
  address(contributors.controller); purpose(contributors.purpose);
  if (founder.beneficiary === founder.controller || founder.beneficiary === contributors.controller) { reject(); }
  const rolling = positive(contributors.rollingCapBaseUnits), perGrant = positive(contributors.perGrantCapBaseUnits);
  if (perGrant > rolling || rolling > positive(contributorAllocation.amountBaseUnits)) { reject(); }
  if (typed.allocations.some(a => a.recipient === founder.beneficiary || a.recipient === founder.controller
    || a.recipient === contributors.controller) || founder.purpose === contributors.purpose) { reject(); }
  return { ...structuredClone(typed), allocations: normalized.allocations.map(({ idBytes32: _id, ...allocation }) => ({
    ...allocation, bps: allocation.bps!,
  })) };
}
