import type { GateErrorCode, Suppression } from "../domain/model.ts";
import { SlitherGateError } from "../domain/model.ts";
import { parseJsonWithoutDuplicateKeys } from "./json-schema.ts";

export function assertSuppressionShape(suppressions: readonly Suppression[]): void {
  const expected = ["detectorId", "expiresAt", "findingIdentityHash", "fingerprint", "length", "owner", "path", "reason", "regressionEvidence", "reviewAt", "schemaVersion", "snippetHash", "sourceHash", "start"];
  for (const item of suppressions) {
    if (JSON.stringify(Object.keys(item).toSorted()) !== JSON.stringify(expected) || item.schemaVersion !== 1) {throw new SlitherGateError("SUPPRESSION_SHAPE_INVALID", "suppression entry has missing or unexpected fields");}
  }
}
export function parseTypedJson(raw: string, code: GateErrorCode, label: string): unknown {
  try {return parseJsonWithoutDuplicateKeys(raw);}
  catch {throw new SlitherGateError(code, `${label} is not unambiguous JSON`);}
}
