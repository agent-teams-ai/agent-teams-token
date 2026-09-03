import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SlitherGateError } from "../domain/model.ts";

export async function assertContainerResult(
  result: { readonly timedOut: boolean; readonly exitCode: number | null },
  output: string,
): Promise<void> {
  if (result.timedOut) {
    throw new SlitherGateError("CONTAINER_TIMEOUT", "container exceeded the bounded analysis timeout");
  }
  if (result.exitCode !== 0) {
    const stage = await readFile(join(output, "failure.stage"), "utf8").then((value) => value.trim(), () => "");
    if (stage === "compiler-build") {
      throw new SlitherGateError("COMPILER_BUILD_FAILED", "pinned compiler build failed");
    }
    if (stage === "analysis-runtime") {
      throw new SlitherGateError("ANALYZER_RUNTIME_FAILED", "pinned Slither runtime failed");
    }
    if (stage === "artifact-validation") {
      throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "fresh compiler artifacts could not be exported");
    }
    if (stage === "version-inventory") {
      throw new SlitherGateError("TOOL_VERSION_MISMATCH", "pinned tool version inventory failed");
    }
    if (stage === "detector-inventory") {
      throw new SlitherGateError("DETECTOR_INVENTORY_INVALID", `container phase failed: ${stage}`);
    }
    if (stage === "manifest-validation") {
      throw new SlitherGateError("TARGET_MANIFEST_INVALID", "container target manifest is invalid");
    }
    if (stage === "container-execution") {
      throw new SlitherGateError("CONTAINER_FAILED", "container security preflight failed");
    }
    throw new SlitherGateError("CONTAINER_FAILED", "container analysis command failed");
  }
}
