/** Pure deployment contract. Parsing, cryptography, files and provider adapters remain outside this entrypoint. */
export { validateDeployment, isEvmAddress, isSolanaAddress, isDigest } from "./domain/deployment.js";
export { validateProductionDeployment } from "./domain/production-deployment.js";
export { validateLocalPurposeGenesis, PURPOSE_ALLOCATION_IDS } from "./domain/local-purpose-genesis.js";
export type { LocalPurposeGenesis, LocalPurposePolicy, PurposeAllocationId } from "./domain/local-purpose-genesis.js";
export type { ProductionDeploymentConfig, ProductionValidation, ValidatedProductionDeployment } from "./domain/production-deployment.js";
export type { DeploymentConfig, DeploymentValidation, ValidatedDeployment, DeploymentMode, DeploymentGrant, DeploymentSafe,
  DeploymentBridge, DeploymentPolicy, DeploymentTestScenario, RateLimit, Hex } from "./domain/deployment.js";
export { calendarSchedule, acceleratedSchedule, validateGrantSchedule } from "./domain/grant-schedule.js";
export type { GrantSchedule, AnniversaryRule } from "./domain/grant-schedule.js";
export { compileDeployment, prepareGrant, deploymentBytes } from "./application/compile-deployment.js";
export { prepareProductionDeployment, constructProductionAssembly } from "./application/prepare-production-deployment.js";
export { prepareLocalPurposeGenesis, verifyPreparedLocalPurposeGenesis, verifyLocalPurposePreflight } from "./application/prepare-local-purpose-genesis.js";
export type { LocalPurposeArtifact, LocalPurposeArtifactSet, LocalPurposePorts, LocalPurposeOperation, LocalPurposePreflight, PreparedLocalPurposeGenesis } from "./application/prepare-local-purpose-genesis.js";
export type { ProductionArtifactPin, ProductionExpectation, ProductionApproval, PreparedProductionDeployment, ProductionPreparationPorts } from "./application/prepare-production-deployment.js";
export type { DeploymentArtifact, DeploymentApproval, PreparedDeployment, DeploymentCompilerPorts } from "./application/compile-deployment.js";
export { materializeDeploymentManifest, verifyDeploymentRuntime, prepareAssemblyManifest } from "./application/deployment-manifest.js";
export type { PreparedAssemblyManifest } from "./application/deployment-manifest.js";
export type { DeploymentBlock, ContractDeploymentEvidence, DeploymentEvidence, DeploymentManifest, DeploymentManifestPorts } from "./application/deployment-manifest.js";
export { parseCanonicalUint, UINT64_MAX, UINT256_MAX } from "./domain/model.js";
export { generatePassport, generateTokenPassport, deriveAuthorityRegistry, checkPassport, checkPassportFreshness } from "./application/passport.js";
export type { PassportHashPort, PassportObservation, PassportAuthorityObservation, TokenPassport, AuthorityRegistryEntry } from "./application/passport.js";

export type { AssemblyConstructor } from "./application/prepare-local-purpose-genesis.js";
export { materializeAssemblyRuntime, verifyAssemblyRuntime } from "./application/prepare-local-purpose-genesis.js";
export { projectAssemblyFacts } from "./application/reserve-facts.js";

export { materializeObservedAssemblyManifest } from "./application/deployment-manifest.js";
export type { ObservedAssemblyManifest, LocalAssemblyObservation, AssemblyOperationObservation, AssemblyContractObservation } from "./application/deployment-manifest.js";
