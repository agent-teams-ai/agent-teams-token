import { validateProductionDeployment } from "@agent-teams/supply/deployment";
import { encodeAllocationCommitment, encodeAllocationId } from "@agent-teams/supply/genesis-manifest";
import { loadPreparedProductionPackage, readDeploymentFile } from "@agent-teams/supply/deployment-files";
import { assessProductionPreflight } from "../application/production-preflight.ts";
import { parseProductionJsonWithoutDuplicates } from "../adapters/strict-json.ts";
import { parseProductionAttempt, parseProductionExpectations, parseProductionObservation } from "../adapters/production-inputs.ts";

function parse(value: string): unknown { return parseProductionJsonWithoutDuplicates(new TextEncoder().encode(value)); }
function options(args: readonly string[]): Map<string, string> | undefined {
  const allowed = ["--prepared", "--expectations", "--observations", "--attempt-state"];
  if (args.length !== 8) {return undefined;}
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) { if (!allowed.includes(args[i]!) || !args[i + 1] || result.has(args[i]!)) {return undefined;} result.set(args[i]!, args[i + 1]!); }
  return result.size === 4 ? result : undefined;
}
const output = (value: unknown, code: number): void => { process.stdout.write(`${JSON.stringify(value)}\n`); process.exitCode = code; };
const coverage = (executionEvidence = false) => ({ coverage: "token-and-reserves-only", unresolvedPrerequisites: [...(executionEvidence ? [] : ["runtime immutable values require deterministic local execution"]), "Safe deployment and live authority observation", "CCIP deployment/configuration", "contributor commitment execution", "authenticated live-chain evidence"] });
const main = async (): Promise<void> => {
  const opts = options(process.argv.slice(2));
  if (!opts) { output({ status: "invalid", reason: "PREFLIGHT_ARGUMENTS", broadcastAllowed: false, ...coverage() }, 2); return; }
  try {
    const prepared = await loadPreparedProductionPackage(opts.get("--prepared")!);
    if (!validateProductionDeployment(prepared.configuration).value) {throw new Error("PREFLIGHT_CONFIGURATION");}
    const decode = async (flag: string, limit: number): Promise<unknown> => parse(new TextDecoder().decode(await readDeploymentFile(opts.get(flag)!, limit)));
    const [expectations, observations, attempt] = await Promise.all([decode("--expectations", 2_097_152), decode("--observations", 2_097_152), decode("--attempt-state", 2_097_152)]);
    const preparedRecord = prepared as unknown as Record<string, unknown>;
    const preparedExpectations = preparedRecord.expectations as Record<string, unknown> | undefined;
    const parsedObservations = parseProductionObservation(observations);
    const deployment = prepared.configuration.deployment;
    const allocationHash = encodeAllocationCommitment({ network: { chainId: deployment.environment.evmChainId }, token: deployment.token }, deployment.allocations.map(allocation => ({ id: allocation.id, idBytes32: encodeAllocationId(allocation.id)!, recipient: allocation.recipient as `0x${string}`, amountBaseUnits: allocation.amountBaseUnits, ...(allocation.bps === undefined ? {} : { bps: allocation.bps }) }))).hash;
    const result = assessProductionPreflight({ prepared, expectations: parseProductionExpectations(expectations), observations: parsedObservations, attempt: parseProductionAttempt(attempt), nowSeconds: BigInt(Math.floor(Date.now() / 1000)), preparedConfigurationSha256: preparedRecord.configurationSha256 as string, preparedReserveConfigurationSha256: preparedRecord.reserveConfigurationSha256 as string, preparedArtifactPinsSha256: preparedExpectations?.artifactPinsSha256 as string, expectedGenesisAllocationHash: allocationHash });
    output({ ...result, ...coverage(parsedObservations.schema === "agtmai-production-observation-v2") }, result.status === "checks-passed-offline" ? 0 : 3);
  } catch { output({ status: "invalid", reason: "PREFLIGHT_INPUT", broadcastAllowed: false, ...coverage() }, 2); }
};
void main();
