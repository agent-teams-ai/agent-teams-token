/** Pure deployment contract. Parsing, cryptography, files and provider adapters remain outside this entrypoint. */
export { validateDeployment, isEvmAddress, isSolanaAddress, isDigest } from "./domain/deployment.js";
export type { DeploymentConfig, DeploymentValidation, ValidatedDeployment, DeploymentMode, DeploymentGrant, DeploymentSafe,
  DeploymentBridge, DeploymentPolicy, DeploymentTestScenario, RateLimit, Hex } from "./domain/deployment.js";
export { calendarSchedule, acceleratedSchedule, validateGrantSchedule } from "./domain/grant-schedule.js";
export type { GrantSchedule, AnniversaryRule } from "./domain/grant-schedule.js";
export { compileDeployment, prepareGrant, deploymentBytes } from "./application/compile-deployment.js";
export type { DeploymentArtifact, DeploymentApproval, PreparedDeployment, DeploymentCompilerPorts } from "./application/compile-deployment.js";
export { materializeDeploymentManifest, verifyDeploymentRuntime } from "./application/deployment-manifest.js";
export type { DeploymentBlock, ContractDeploymentEvidence, DeploymentEvidence, DeploymentManifest, DeploymentManifestPorts } from "./application/deployment-manifest.js";
export { parseCanonicalUint, UINT64_MAX, UINT256_MAX } from "./domain/model.js";
export { generatePassport, generateTokenPassport, deriveAuthorityRegistry, checkPassport, checkPassportFreshness } from "./application/passport.js";
export type { PassportHashPort, PassportObservation, PassportAuthorityObservation, TokenPassport, AuthorityRegistryEntry } from "./application/passport.js";
