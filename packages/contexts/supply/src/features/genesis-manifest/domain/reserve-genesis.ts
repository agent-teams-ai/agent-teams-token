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

function reject(): never { throw new Error("RESERVE_GENESIS_INVALID"); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) { return reject(); }
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
      || (allocation.bps as number) <= 0 || (allocation.bps as number) > 10_000) { reject(); }
    address(allocation.recipient);
    const numerator = supply * BigInt(allocation.bps as number);
    if (numerator % 10_000n !== 0n || positive(allocation.amountBaseUnits) !== numerator / 10_000n) { reject(); }
  }
}

/** Strict offline policy validation. Names of the other six buckets remain explicit approved input.
 * The 20% contributor envelope is represented by separate 3% founder and 17% reserve recipients.
 * This verifies authored facts, never deployed code, transactions or custody observations. */
export function validateReserveGenesis(input: unknown): ReserveGenesis {
  const root = object(input, ["schema", "status", "initialSupplyBaseUnits", "allocations", "founder", "contributors"]);
  if (root.schema !== "agtmai-reserve-genesis-v1" || root.status !== "accepted") { reject(); }
  const supply = positive(root.initialSupplyBaseUnits);
  validateAllocations(root.allocations, supply);
  const typed = input as ReserveGenesis;
  const normalized = normalizeAllocationSet(typed.initialSupplyBaseUnits, typed.allocations, "deployment");
  if (normalized.diagnostics.length || !normalized.allocations) { reject(); }
  const founderAllocation = typed.allocations.find(a => a.id === "founder");
  const contributorAllocation = typed.allocations.find(a => a.id === "contributors");
  if (founderAllocation?.bps !== 300 || contributorAllocation?.bps !== 1700) { reject(); }
  const otherBps = typed.allocations.filter(a => a.id !== "founder" && a.id !== "contributors")
    .map(a => a.bps).toSorted((a, b) => a - b);
  if (JSON.stringify(otherBps) !== "[100,500,500,900,3000,3000]") { reject(); }
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
  const rolling = positive(contributors.rollingCapBaseUnits), perGrant = positive(contributors.perGrantCapBaseUnits);
  if (perGrant > rolling || rolling > positive(contributorAllocation.amountBaseUnits)) { reject(); }
  if (typed.allocations.some(a => a.recipient === founder.beneficiary || a.recipient === founder.controller
    || a.recipient === contributors.controller) || founder.purpose === contributors.purpose) { reject(); }
  return { ...structuredClone(typed), allocations: normalized.allocations.map(({ idBytes32: _id, ...allocation }) => ({
    ...allocation, bps: allocation.bps!,
  })) };
}
