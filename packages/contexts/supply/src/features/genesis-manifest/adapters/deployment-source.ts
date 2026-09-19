import { canonicalJson, type JsonValue } from "../application/canonical.js";
import { validateDeployment, type DeploymentValidation } from "../domain/deployment.js";
import { parseStrict } from "./strict-source.js";

export function parseDeploymentSource(text: string): DeploymentValidation & { readonly canonicalBytes?: Uint8Array } {
  const parsed = parseStrict(text);
  if (parsed.diagnostics.length) {
    // YAML diagnostics may contain source fragments. Public errors never echo them.
    return { diagnostics: parsed.diagnostics.map(d => ({ code: d.code, pointer: "", severity: "error", message: "invalid deployment source" })) };
  }
  const result = validateDeployment(parsed.value);
  return result.value ? { ...result, canonicalBytes: new TextEncoder().encode(canonicalJson(result.value as unknown as JsonValue)) } : result;
}
