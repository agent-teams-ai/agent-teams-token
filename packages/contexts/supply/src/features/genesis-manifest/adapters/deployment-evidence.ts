import type { ContractDeploymentEvidence, DeploymentEvidence } from "../application/deployment-manifest.js";
import { compileDeployment, deploymentBytes, type DeploymentCompilerPorts, type PreparedDeployment } from "../application/compile-deployment.js";
import { parseStrict } from "./strict-source.js";

const invalid = (): never => { throw new Error("DEPLOYMENT_EVIDENCE_SHAPE"); };
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).toSorted().join() !== [...keys].toSorted().join()) { return invalid(); }
  return value as Record<string, unknown>;
}
export function parsePreparedDeployment(text: string, ports: DeploymentCompilerPorts): PreparedDeployment {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  const root = fields(value, ["schema", "broadcastAllowed", "sourceRevision", "configuration", "configurationSha256", "approval", "artifacts", "token"]);
  if (typeof root.sourceRevision !== "string" || !Array.isArray(root.artifacts) || root.artifacts.length !== 2) { return invalid(); }
  for (const a of root.artifacts) {
    const artifact = fields(a, ["contract", "compilerVersion", "artifactSha256", "buildInfoSha256", "compilerInputSha256", "creationBytecode", "runtimeBytecode", "immutableReferences"]);
    if (!Array.isArray(artifact.immutableReferences) || artifact.immutableReferences.length > 1024) { return invalid(); }
    for (const r of artifact.immutableReferences) { fields(r, ["start", "length"]); }
  }
  if (root.approval !== null) { fields(root.approval, ["schema", "reference", "configurationSha256"]); }
  const prepared = value as PreparedDeployment;
  const compiled = compileDeployment(prepared.configuration, { sourceRevision: prepared.sourceRevision, artifacts: prepared.artifacts, ...(prepared.approval === null ? {} : { approval: prepared.approval }) }, ports);
  // Comparing canonical bytes also rejects duplicate keys and unknown private fields.
  if (!compiled.prepared || text !== new TextDecoder().decode(deploymentBytes(compiled.prepared))) { return invalid(); }
  return compiled.prepared;
}
export function parseDeploymentEvidence(text: string): DeploymentEvidence {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  const root = fields(value, ["schema", "configurationSha256", "collector", "token", "grants"]);
  fields(root.collector, ["kind", "sourceRevision"]);
  if (!Array.isArray(root.grants) || root.grants.length > 64) { return invalid(); }
  if (root.token !== null) { contract(root.token); }
  for (const g of root.grants) { const grant = fields(g, ["grantId", "deployment"]); if (typeof grant.grantId !== "string") { return invalid(); } contract(grant.deployment); }
  // Evidence may be pretty printed, but duplicate JSON keys must still be rejected.
  // The strict parser is appropriate to these bounded scalar-only records.
  if (parseStrict(text, "deployment-evidence").diagnostics.length) { return invalid(); }
  return value as DeploymentEvidence;
}
function contract(value: unknown): asserts value is ContractDeploymentEvidence {
  const c = fields(value, ["address", "transaction", "receipt", "blockBefore", "blockAfter", "finalizedBlock", "runtime", "calls"]);
  const tx = fields(c.transaction, ["hash", "from", "nonce", "chainId", "to", "value", "input"]);
  if (Object.entries(tx).some(([k, v]) => k === "to" ? v !== null : typeof v !== "string")) { invalid(); }
  const receipt = fields(c.receipt, ["transactionHash", "blockHash", "blockNumber", "contractAddress", "status", "gasUsed", "effectiveGasPrice", "logs"]);
  if (!Array.isArray(receipt.logs) || receipt.logs.length > 64) { invalid(); }
  for (const log of receipt.logs as unknown[]) {
    const l = fields(log, ["address", "topics", "data", "logIndex", "removed"]);
    if (!Array.isArray(l.topics) || l.topics.length > 4 || l.topics.some(t => typeof t !== "string")) { invalid(); }
  }
  for (const name of ["blockBefore", "blockAfter", "finalizedBlock"]) {
    const block = fields(c[name], ["number", "hash", "timestamp"]);
    if (Object.values(block).some(v => typeof v !== "string")) { invalid(); }
  }
  fields(c.runtime, ["blockHash", "blockNumber", "code"]);
  if (!Array.isArray(c.calls) || c.calls.length > 64) { invalid(); }
  for (const call of c.calls as unknown[]) { fields(call, ["to", "data", "result", "blockHash", "blockNumber"]); }
}
