import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const EXPECTED_TOOLING_BOUNDARIES = Object.freeze({
  "tooling.execution-environment": [],
  "tooling.local-solana.domain": [],
  "tooling.local-solana.application": ["tooling.local-solana.domain"],
  "tooling.local-solana.adapters": [
    "tooling.local-solana.application",
    "tooling.local-solana.domain",
  ],
  "tooling.local-solana.composition": [
    "tooling.local-solana.adapters",
    "tooling.local-solana.application",
    "tooling.local-solana.domain",
  ],
  "tooling.deployment-plan.domain": [],
  "tooling.deployment-plan.application": ["tooling.deployment-plan.domain"],
  "tooling.deployment-plan.adapters": [
    "tooling.deployment-plan.application",
    "tooling.deployment-plan.domain",
  ],
  "tooling.deployment-plan.composition": [
    "tooling.deployment-plan.adapters",
    "tooling.deployment-plan.application",
    "tooling.deployment-plan.domain",
  ],
  "tooling.slither.domain": [],
  "tooling.slither.application": ["tooling.slither.domain"],
  "tooling.slither.adapters": [
    "tooling.execution-environment",
    "tooling.slither.application",
    "tooling.slither.domain",
  ],
  "tooling.slither.composition": [
    "tooling.slither.adapters",
    "tooling.slither.application",
    "tooling.slither.domain",
  ],
});

const EXPECTED_ROOTS = Object.freeze([
  "tooling/local-solana/src",
  "tooling/deployment-plan/src",
  "tooling/security/slither/src",
  "scripts/execution-environment",
]);

// Exact four Slither declarations restored by restoreArchitectureBoundaries from
// b7a868f85d89c4bb7a9aeed1d854a5f949306a45. The shared boundary survives rollback.
// Empty entrypoints or a caller-supplied rollback flag are not state authority.
const SLITHER_BASELINE_BOUNDARIES_SHA256 =
  "baf18bd4a9f2eca0800df0cc3140ec244cd491a10db349488358e86aca5f8e41";

export function parseSourceDependencyPolicy(source) {
  const boundaries = {};
  const governedRoots = [];
  let section;
  let boundaryId;
  let inAllowedBoundaries = false;
  for (const line of source.split("\n")) {
    if (line === "governedRoots:") {section = "roots"; continue;}
    if (line === "boundaries:") {section = "boundaries"; continue;}
    if (section === "roots" && line.startsWith("  - ")) {
      governedRoots.push(line.slice(4));
      continue;
    }
    const id = line.match(/^  - id: (.+)$/)?.[1];
    if (section === "boundaries" && id) {
      boundaryId = id;
      if (id.startsWith("tooling.")) {
        if (Object.hasOwn(boundaries, id)) {
          throw new Error(`TOOLING_BOUNDARY_ID_DUPLICATE boundary=${id}`);
        }
        boundaries[id] = [];
      }
      inAllowedBoundaries = false;
      continue;
    }
    if (!boundaryId?.startsWith("tooling.")) {continue;}
    if (line.startsWith("      boundaries:")) {
      inAllowedBoundaries = true;
      continue;
    }
    if (/^      (?:packages|builtins|runtimeReferences):/.test(line)) {
      inAllowedBoundaries = false;
      continue;
    }
    if (inAllowedBoundaries && line.startsWith("        - ")) {
      boundaries[boundaryId].push(line.slice(10));
    }
  }
  const slitherBoundarySource = [...source.matchAll(/^  - id: tooling\.slither\.[^\n]+\n(?:(?!  - id: )[^\n]*\n)*/gm)]
    .map(([block]) => block).join("");
  return { boundaries, governedRoots, slitherBoundarySource };
}

export function validateToolingBoundaryPolicy(policy) {
  for (const root of EXPECTED_ROOTS) {
    if (!policy.governedRoots.includes(root)) {
      throw new Error(`TOOLING_BOUNDARY_ROOT_MISSING root=${root}`);
    }
  }
  const actualIds = Object.keys(policy.boundaries).toSorted();
  const expectedIds = Object.keys(EXPECTED_TOOLING_BOUNDARIES).toSorted();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error("TOOLING_BOUNDARY_IDS_MISMATCH");
  }
  const slitherRestored = typeof policy.slitherBoundarySource === "string"
    && createHash("sha256").update(policy.slitherBoundarySource).digest("hex")
      === SLITHER_BASELINE_BOUNDARIES_SHA256;
  for (const [id, candidateExpected] of Object.entries(EXPECTED_TOOLING_BOUNDARIES)) {
    const expected = slitherRestored && id === "tooling.slither.adapters"
      ? ["tooling.slither.application", "tooling.slither.domain"]
      : candidateExpected;
    const actual = policy.boundaries[id].toSorted();
    if (JSON.stringify(actual) !== JSON.stringify(expected.toSorted())) {
      throw new Error(`TOOLING_BOUNDARY_ALLOW_MISMATCH boundary=${id}`);
    }
  }
}

export function readAndValidateToolingBoundaryPolicy(path) {
  const policy = parseSourceDependencyPolicy(readFileSync(path, "utf8"));
  validateToolingBoundaryPolicy(policy);
  return policy;
}
