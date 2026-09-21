import { validateDeployment, type DeploymentConfig, type DeploymentSafe, type ValidatedDeployment } from "./deployment.js";
import { validateReserveGenesis, type ReserveGenesis } from "./reserve-genesis.js";
import { compareDiagnostics, type Diagnostic } from "./model.js";

export interface ProductionDeploymentConfig {
  readonly schema: "agtmai-production-deployment-v1";
  readonly deployment: DeploymentConfig;
  readonly reserveGenesis: ReserveGenesis;
  readonly projectControllerSafeId: string;
  readonly founderBeneficiarySafeId: string;
}

export interface ValidatedProductionDeployment extends ProductionDeploymentConfig {
  readonly deployment: ValidatedDeployment;
}

export interface ProductionValidation {
  readonly diagnostics: readonly Diagnostic[];
  readonly value?: ValidatedProductionDeployment;
}

const error = (code: string, pointer: string): Diagnostic => ({
  code: `PRODUCTION_${code}`, pointer, severity: "error", message: "invalid or unresolved production input",
});
const object = (value: unknown, keys: readonly string[], pointer: string, diagnostics: Diagnostic[]): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) { diagnostics.push(error("OBJECT_REQUIRED", pointer)); return undefined; }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).toSorted().join() !== [...keys].toSorted().join()) { diagnostics.push(error("UNKNOWN_OR_MISSING_FIELD", pointer)); }
  return record;
};

function safeById(config: DeploymentConfig, id: string, pointer: string, diagnostics: Diagnostic[]): DeploymentSafe | undefined {
  const matches = config.custodySafes.filter(safe => safe.id === id);
  if (matches.length !== 1) { diagnostics.push(error("SAFE_REFERENCE", pointer)); return undefined; }
  return matches[0];
}

function sameAllocationSet(deployment: DeploymentConfig, reserve: ReserveGenesis, diagnostics: Diagnostic[]): void {
  const left = new Map(deployment.allocations.map(a => [a.id, `${a.recipient}:${a.amountBaseUnits}:${a.bps ?? ""}`]));
  const right = new Map(reserve.allocations.map(a => [a.id, `${a.recipient}:${a.amountBaseUnits}:${a.bps}`]));
  if (left.size !== right.size || [...left].some(([id, value]) => right.get(id) !== value)) {
    diagnostics.push(error("ALLOCATION_BINDING", "/reserveGenesis/allocations"));
  }
}

function checkSafe(safe: DeploymentSafe | undefined, pointer: string, diagnostics: Diagnostic[]): void {
  if (!safe) return;
  if (safe.owners.length !== 3 || new Set(safe.owners).size !== 3 || safe.threshold !== 2 || safe.beneficialControl !== "solo-founder") {
    diagnostics.push(error("SAFE_QUALIFICATION", pointer));
  }
}

/** Joins the two existing authorities without producing deployable defaults. */
export function validateProductionDeployment(input: unknown): ProductionValidation {
  const diagnostics: Diagnostic[] = [];
  const root = object(input, ["deployment", "founderBeneficiarySafeId", "projectControllerSafeId", "reserveGenesis", "schema"], "", diagnostics);
  if (!root || root.schema !== "agtmai-production-deployment-v1") diagnostics.push(error("SCHEMA", "/schema"));
  if (!root) return { diagnostics: diagnostics.toSorted(compareDiagnostics) };
  let deployment: ValidatedDeployment | undefined;
  if (root?.deployment !== undefined) {
    const result = validateDeployment(root.deployment);
    if (result.value) deployment = result.value;
    else diagnostics.push(...result.diagnostics.map(d => ({ ...d, code: `PRODUCTION_DEPLOYMENT_${d.code}` })));
  } else diagnostics.push(error("REQUIRED", "/deployment"));
  let reserve: ReserveGenesis | undefined;
  if (root?.reserveGenesis !== undefined) {
    try { reserve = validateReserveGenesis(root.reserveGenesis); }
    catch { diagnostics.push(error("RESERVE_GENESIS", "/reserveGenesis")); }
  } else diagnostics.push(error("REQUIRED", "/reserveGenesis"));
  const projectId = root?.projectControllerSafeId;
  const founderId = root?.founderBeneficiarySafeId;
  if (typeof projectId !== "string" || projectId.length === 0) diagnostics.push(error("SAFE_ID", "/projectControllerSafeId"));
  if (typeof founderId !== "string" || founderId.length === 0) diagnostics.push(error("SAFE_ID", "/founderBeneficiarySafeId"));
  if (!deployment || !reserve || typeof projectId !== "string" || typeof founderId !== "string") return { diagnostics: diagnostics.toSorted(compareDiagnostics) };
  if (deployment.status !== "accepted" || deployment.environment.mode !== "mainnet-dry-run" || deployment.environment.evmChainId !== "1") diagnostics.push(error("MAINNET_MODE", "/deployment/environment"));
  if (deployment.token.initialSupplyBaseUnits !== reserve.initialSupplyBaseUnits) diagnostics.push(error("SUPPLY_BINDING", "/deployment/token/initialSupplyBaseUnits"));
  sameAllocationSet(deployment, reserve, diagnostics);
  const project = safeById(deployment, projectId, "/projectControllerSafeId", diagnostics);
  const founder = safeById(deployment, founderId, "/founderBeneficiarySafeId", diagnostics);
  if (project?.address === founder?.address) diagnostics.push(error("SAFE_ALIAS", "/founderBeneficiarySafeId"));
  checkSafe(project, "/deployment/custodySafes/project", diagnostics);
  checkSafe(founder, "/deployment/custodySafes/founder", diagnostics);
  if (project && reserve.contributors.controller !== project.address) diagnostics.push(error("CONTRIBUTOR_CONTROLLER", "/reserveGenesis/contributors/controller"));
  if (founder && reserve.founder.beneficiary !== founder.address) diagnostics.push(error("FOUNDER_BENEFICIARY", "/reserveGenesis/founder/beneficiary"));
  if (project && reserve.founder.controller !== project.address) diagnostics.push(error("FOUNDER_CONTROLLER", "/reserveGenesis/founder/controller"));
  if (project && deployment.token.initialCCIPAdmin !== project.address) diagnostics.push(error("TOKEN_ADMINISTRATOR", "/deployment/token/initialCCIPAdmin"));
  if (reserve.allocations.find(a => a.id === "founder")?.bps !== 300 || reserve.allocations.find(a => a.id === "contributors")?.bps !== 1700) diagnostics.push(error("RESERVE_SPLIT", "/reserveGenesis/allocations"));
  if (diagnostics.length) return { diagnostics: diagnostics.toSorted(compareDiagnostics) };
  return { diagnostics: [], value: structuredClone({ schema: root.schema, deployment, reserveGenesis: reserve, projectControllerSafeId: projectId, founderBeneficiarySafeId: founderId }) as ValidatedProductionDeployment };
}
