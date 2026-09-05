import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { SlitherGateError } from "../domain/model.ts";

export interface ValidatedEnvironment { readonly repositoryRoot: string; readonly candidateSha: string; readonly output: string }

export async function validateEnvironment(rootValue: string, shaValues: readonly (string | undefined)[], outputValue?: string): Promise<ValidatedEnvironment> {
  const validated = await validateEnvironmentPaths(rootValue, shaValues, outputValue);
  if ((await lstat(validated.output).catch(() => null)) !== null) {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "evidence output already exists");}
  return validated;
}

/** Read-only consumer contract; producers continue to require an absent output. */
export async function validateEvidenceEnvironment(rootValue: string, shaValues: readonly (string | undefined)[], outputValue?: string): Promise<ValidatedEnvironment> {
  const validated = await validateEnvironmentPaths(rootValue, shaValues, outputValue);
  const info = await lstat(validated.output).catch(() => {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "evidence output is unavailable");});
  const canonical = await realpath(validated.output).catch(() => {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "evidence output is unavailable");});
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== validated.output) {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "evidence output is not a canonical regular directory");}
  // These path checks do not retain a directory handle. Independent bundle
  // validation must reopen and validate the contents before accepting evidence.
  return validated;
}

async function validateEnvironmentPaths(rootValue: string, shaValues: readonly (string | undefined)[], outputValue?: string): Promise<ValidatedEnvironment> {
  const candidates = [...new Set(shaValues.filter((value): value is string => typeof value === "string" && value.length > 0))];
  if (candidates.length !== 1 || !/^[0-9a-f]{40}$/u.test(candidates[0]!)) {throw new SlitherGateError("CANDIDATE_SHA_INVALID", "one exact candidate SHA is required");}
  if (!rootValue.startsWith("/") || rootValue.includes("\0")) {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "repository path is invalid");}
  const root = await realpath(rootValue).catch(() => {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "repository root is unavailable");});
  const rootInfo = await lstat(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "repository root is invalid");}
  const requestedOutput = outputValue ?? `/tmp/agtmai-slither-evidence-${candidates[0]!}`;
  if (!requestedOutput.startsWith("/") || requestedOutput.includes("\0") || requestedOutput.endsWith("/") || requestedOutput.split("/").includes("..")) {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "evidence path is invalid");}
  const leaf = validatedLeaf(requestedOutput);
  const parent = await realpath(dirname(requestedOutput)).catch(() => {throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "evidence parent is unavailable");});
  const output = join(parent, leaf);
  if (isWithin(root, output)) {throw new SlitherGateError("EVIDENCE_INSIDE_REPOSITORY", "evidence path crosses the checkout boundary");}
  return {repositoryRoot: root, candidateSha: candidates[0]!, output};
}

export async function validateExternalTempRoot(repositoryRoot: string, tempRoot: string): Promise<string> {
  const root = await realpath(repositoryRoot).catch(() => {throw new SlitherGateError("TEMP_ROOT_INVALID", "repository root is unavailable");});
  const canonical = await realpath(tempRoot).catch(() => {throw new SlitherGateError("TEMP_ROOT_INVALID", "temporary root is unavailable");});
  const info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || isWithin(root, canonical)) {throw new SlitherGateError("TEMP_ROOT_INVALID", "temporary root crosses the checkout boundary");}
  return canonical;
}


function validatedLeaf(path: string): string {
  const leaf = basename(path);
  if (leaf.length === 0 || leaf === "." || leaf === ".." || leaf.includes("/") || leaf.includes("\\") || leaf.includes("\0")) {
    throw new SlitherGateError("ABSOLUTE_PATH_REQUIRED", "evidence output basename is invalid");
  }
  return leaf;
}

function isWithin(parent: string, child: string): boolean {const value = relative(parent, child); return value === "" || (value !== ".." && !value.startsWith("../") && !value.startsWith("/"));}
