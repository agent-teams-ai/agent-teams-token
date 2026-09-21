import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assessProductionPreflight } from "../application/production-preflight.ts";
import { parseJsonWithoutDuplicates } from "../adapters/strict-json.ts";
import { parseProductionAttempt, parseProductionExpectations, parseProductionObservation, validateProductionConfig } from "../adapters/production-inputs.ts";
import { canonicalJson, sha256Hex } from "../domain/identity.ts";

function parse(value: string): unknown { return parseJsonWithoutDuplicates(new TextEncoder().encode(value)); }
function options(args: readonly string[]): Map<string, string> | undefined {
  const allowed = ["--prepared", "--expectations", "--observations", "--attempt-state"];
  if (args.length !== 8) return undefined;
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) { if (!allowed.includes(args[i]!) || !args[i + 1] || result.has(args[i]!)) return undefined; result.set(args[i]!, args[i + 1]!); }
  return result.size === 4 ? result : undefined;
}
const output = (value: unknown, code: number): void => { process.stdout.write(`${JSON.stringify(value)}\n`); process.exitCode = code; };
const coverage = { coverage: "token-and-reserves-only", unresolvedPrerequisites: ["Safe deployment and live authority observation", "CCIP deployment/configuration", "contributor commitment execution", "authenticated live-chain evidence"] } as const;
const main = async (): Promise<void> => {
  const opts = options(process.argv.slice(2));
  if (!opts) { output({ status: "invalid", reason: "PREFLIGHT_ARGUMENTS", broadcastAllowed: false, ...coverage }, 2); return; }
  try {
    const [prepared, expectations, observations, attempt] = await Promise.all(["--prepared", "--expectations", "--observations", "--attempt-state"].map(async flag => parse(await readFile(flag === "--prepared" ? join(opts.get(flag)!, "prepared-production-deployment.json") : opts.get(flag)!, "utf8"))));
    const configuration = (prepared as Record<string, unknown> | null)?.configuration;
    const configurationResult = validateProductionConfig(configuration);
    if (!configurationResult.value) { output({ status: "invalid", reason: "PREFLIGHT_CONFIGURATION", diagnostics: configurationResult.diagnostics, broadcastAllowed: false, ...coverage }, 2); return; }
    const validated = configurationResult.value as unknown as Record<string, unknown>;
    const preparedRecord = prepared as Record<string, unknown>;
    const preparedExpectations = preparedRecord.expectations as Record<string, unknown> | undefined;
    const preparedArtifactPinsSha256 = sha256Hex(canonicalJson({ schema: "agtmai-production-artifact-pins-v1", sourceRevision: preparedExpectations?.sourceRevision, artifacts: preparedRecord.artifacts }));
    const result = assessProductionPreflight({ prepared, expectations: parseProductionExpectations(expectations), observations: parseProductionObservation(observations), attempt: parseProductionAttempt(attempt), nowSeconds: BigInt(Math.floor(Date.now() / 1000)), preparedConfigurationSha256: sha256Hex(canonicalJson(validated.deployment)), preparedReserveConfigurationSha256: sha256Hex(canonicalJson(validated.reserveGenesis)), preparedArtifactPinsSha256 });
    output({ ...result, ...coverage }, result.status === "checks-passed-offline" ? 0 : 3);
  } catch { output({ status: "invalid", reason: "PREFLIGHT_INPUT", broadcastAllowed: false, ...coverage }, 2); }
};
void main();
