import { parseCanonicalUint, UINT64_MAX, type Diagnostic } from "./model.js";

export type AnniversaryRule = "february-28" | "march-1";
export interface GrantSchedule {
  readonly profile: "calendar-12-48" | "accelerated-test";
  readonly start: string;
  readonly cliff: string;
  readonly end: string;
  readonly anniversaryRule?: AnniversaryRule;
}

const diagnostic = (code: string, pointer: string): Diagnostic => ({
  code, pointer, severity: "error", message: "invalid or unresolved grant schedule",
});
// The supported calendar range is intentionally narrower than the ABI uint64.
const LAST_START = 253276070399n; // 9995-12-31T23:59:59Z; four anniversaries fit in year 9999.

/** Calendar arithmetic with an explicit instant, never a wall-clock read. */
export function calendarSchedule(start: string, anniversaryRule?: AnniversaryRule): GrantSchedule {
  const seconds = parseCanonicalUint(start, UINT64_MAX);
  if (seconds === undefined || seconds > LAST_START) { throw new Error("DEPLOYMENT_CALENDAR_RANGE"); }
  if (anniversaryRule !== undefined && anniversaryRule !== "february-28" && anniversaryRule !== "march-1") {
    throw new Error("DEPLOYMENT_ANNIVERSARY_RULE");
  }
  const date = new Date(Number(seconds) * 1000);
  const leapDay = date.getUTCMonth() === 1 && date.getUTCDate() === 29;
  if (leapDay && anniversaryRule === undefined) { throw new Error("DEPLOYMENT_ANNIVERSARY_RULE_REQUIRED"); }
  const anniversary = (years: number): string => {
    const targetYear = date.getUTCFullYear() + years;
    const leapYear = targetYear % 4 === 0 && (targetYear % 100 !== 0 || targetYear % 400 === 0);
    const ambiguous = leapDay && !leapYear;
    const month = ambiguous && anniversaryRule === "march-1" ? 2 : date.getUTCMonth();
    const day = ambiguous ? (anniversaryRule === "march-1" ? 1 : 28) : date.getUTCDate();
    return String(Date.UTC(targetYear, month, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()) / 1000);
  };
  return { profile: "calendar-12-48", start, cliff: anniversary(1), end: anniversary(4),
    ...(anniversaryRule === undefined ? {} : { anniversaryRule }) };
}

export function validateGrantSchedule(schedule: GrantSchedule, production: boolean, pointer: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const [start, cliff, end] = [schedule.start, schedule.cliff, schedule.end].map(value => parseCanonicalUint(value, UINT64_MAX));
  if (start === undefined || cliff === undefined || end === undefined || start >= cliff || cliff >= end) {
    return [diagnostic("DEPLOYMENT_SCHEDULE_ORDER_OR_WIDTH", pointer)];
  }
  if (schedule.profile === "accelerated-test") {
    if (production || schedule.anniversaryRule !== undefined) {
      diagnostics.push(diagnostic("DEPLOYMENT_TEST_SCHEDULE_FORBIDDEN", pointer));
    }
  } else if (schedule.profile === "calendar-12-48") {
    try {
      const expected = calendarSchedule(schedule.start, schedule.anniversaryRule);
      if (expected.cliff !== schedule.cliff || expected.end !== schedule.end) {
        diagnostics.push(diagnostic("DEPLOYMENT_CALENDAR_ANNIVERSARY", pointer));
      }
    } catch (error) {
      diagnostics.push(diagnostic((error as Error).message, pointer));
    }
  } else {
    diagnostics.push(diagnostic("DEPLOYMENT_SCHEDULE_PROFILE", pointer));
  }
  return diagnostics;
}

/** Resolve a test schedule once, then persist these exact instants with the configuration. */
export function acceleratedSchedule(start: string, cliffOffsetSeconds: string, endOffsetSeconds: string): GrantSchedule {
  const values = [start, cliffOffsetSeconds, endOffsetSeconds].map(value => parseCanonicalUint(value, UINT64_MAX));
  const [base, cliff, end] = values;
  if (base === undefined || cliff === undefined || end === undefined || cliff === 0n || cliff >= end || base + end > UINT64_MAX) {
    throw new Error("DEPLOYMENT_TEST_SCHEDULE_INVALID");
  }
  return { profile: "accelerated-test", start, cliff: String(base + cliff), end: String(base + end) };
}
