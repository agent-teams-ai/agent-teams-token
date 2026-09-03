import { lstat, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { SlitherGateError } from "../domain/model.ts";

export interface ValidatedEnvironment { readonly repositoryRoot: string; readonly candidateSha: string; readonly output: string }

export async function validateEnvironment(rootValue: string, shaValues: readonly (string | undefined)[], outputValue?: string): Promise<ValidatedEnvironment> {
  const candidates = [...new Set(shaValues.filter((value): value is string => typeof value === "string" && value.length > 0))];
  if (candidates.length !== 1 || !/^[0-9a-f]{40}$/u.test(candidates[0]!)) {throw new SlitherGateError("CANDIDATE_SHA_INVALID", "one exact candidate SHA is required");}
  if (!rootValue.startsWith("/") || rootValue.includes("\0")) {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "repository path is invalid");}
  const root = await realpath(rootValue).catch(() => {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "repository root is unavailable");});
  const rootInfo = await lstat(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "repository root is invalid");}
  const output = outputValue ?? `/tmp/agtmai-slither-evidence-${candidates[0]!}`;
  if (!output.startsWith("/") || output.includes("\0") || resolve(output) !== output) {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "evidence path is invalid");}
  const parent = await realpath(dirname(output)).catch(() => {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "evidence parent is unavailable");});
  if (parent !== dirname(output) || isWithin(root, output)) {throw new SlitherGateError("EVIDENCE_INSIDE_REPOSITORY", "evidence path crosses the checkout boundary");}
  return {repositoryRoot: root, candidateSha: candidates[0]!, output};
}

export async function validateExternalTempRoot(repositoryRoot: string, tempRoot: string): Promise<string> {
  const canonical = await realpath(tempRoot).catch(() => {throw new SlitherGateError("TEMP_ROOT_INVALID", "temporary root is unavailable");});
  const info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || isWithin(repositoryRoot, canonical)) {throw new SlitherGateError("TEMP_ROOT_INVALID", "temporary root crosses the checkout boundary");}
  return canonical;
}

function isWithin(parent: string, child: string): boolean {const value = relative(parent, child); return value === "" || (value !== ".." && !value.startsWith("../") && !value.startsWith("/"));}
