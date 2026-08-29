import type { GateManifest } from "../domain/model.ts";
import { SlitherGateError } from "../domain/model.ts";

export function assertProductionCoverage(
  trackedProductionSources: readonly string[],
  manifest: GateManifest,
): void {
  const targetPaths = manifest.targets.map(({ path }) => path);
  if (
    manifest.targets.length === 0
    || new Set(targetPaths).size !== targetPaths.length
    || manifest.targets.some(({ path, contract }) =>
      !trackedProductionSources.includes(path)
      || !manifest.sources.some((source) => source.path === path)
      || contract.length === 0)
  ) {
    throw new SlitherGateError("TARGET_MANIFEST_INVALID", "each target must identify one tracked production source in the closure");
  }
  const assigned = targetPaths.toSorted();
  if (
    assigned.length !== trackedProductionSources.length
    || assigned.some((path, index) => path !== trackedProductionSources[index])
  ) {
    throw new SlitherGateError(
      "PRODUCTION_SOURCE_UNASSIGNED",
      "every tracked production Solidity source must be assigned to an analyzed target",
    );
  }
}
