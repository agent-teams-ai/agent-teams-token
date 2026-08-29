import { createHash } from "node:crypto";
import { fail } from "./model.ts";
export const PLAN_ID_DOMAIN = "AGTMAI_UNSIGNED_DEPLOYMENT_PLAN_V1";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("UNSAFE_NUMBER", "canonical numbers must be safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right));
    const properties = entries.map(
      ([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`,
    );
    return `{${properties.join(",")}}`;
  }
  fail("CANONICAL_TYPE", "unsupported canonical value");
}

export function sha256Hex(value: string | Uint8Array): `0x${string}` {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export function computePlanId(identity: Record<string, unknown>): `0x${string}` {
  return sha256Hex(`${PLAN_ID_DOMAIN}\0${canonicalJson(identity)}`);
}
