import { deploymentBytes, validateGrantSchedule, validateProductionDeployment, type GrantSchedule, type PreparedProductionDeployment } from "@agent-teams/supply/deployment";
import { keccak256, sha256Hex } from "../domain/identity.ts";

const UINT256 = (1n << 256n) - 1n;
const UINT64 = (1n << 64n) - 1n;
const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) && !/^0x0{64}$/.test(value);
const decimal = (value: unknown, max = UINT256): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {throw new Error("COMMIT_DECIMAL");}
  const parsed = BigInt(value);
  if (parsed > max) {throw new Error("COMMIT_WIDTH");}
  return parsed;
};
const exact = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).toSorted().join() !== [...fields].toSorted().join()) {throw new Error("COMMIT_SCHEMA");}
  return value as Record<string, unknown>;
};
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const addressWord = (value: string): string => value.slice(2).padStart(64, "0");

export interface ContributorCommitmentInput {
  readonly schema: "agtmai-contributor-commitment-input-v1";
  readonly chainId: string;
  readonly token: string;
  readonly reserve: string;
  readonly projectControllerSafe: string;
  readonly safeNonce: string;
  readonly beneficiary: string;
  readonly amountBaseUnits: string;
  readonly purpose: string;
  readonly schedule: GrantSchedule;
  readonly configurationSha256: string;
  readonly reserveConfigurationSha256: string;
  readonly artifactPinsSha256: string;
  readonly sourceRevision: string;
}

/** Operator supplied state at one block. No RPC or authentication is implied. */
export interface ContributorCapacityObservation {
  readonly schema: "agtmai-contributor-capacity-observation-v1";
  readonly provenance: "supplied-unverified";
  readonly chainId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly blockTimestamp: string;
  readonly observedAt: string;
  readonly token: string;
  readonly reserve: string;
  readonly projectControllerSafe: string;
  readonly safeNonce: string;
  readonly safeThreshold: 2;
  readonly safeOwners: readonly string[];
  readonly safeProxyCodeHash: string;
  readonly safeSingletonCodeHash: string;
  readonly safeSingletonAddress: string;
  readonly controllerToken: string;
  readonly controllerSafe: string;
  readonly controllerPurpose: string;
  readonly rollingCapBaseUnits: string;
  readonly perGrantCapBaseUnits: string;
  readonly controllerWindowSeconds: string;
  readonly rollingCommittedBaseUnits: string;
  readonly grossCommittedBaseUnits: string;
  readonly reserveBalanceBaseUnits: string;
}

// oxlint-disable-next-line complexity, max-params -- one closed boundary checks the complete commitment and one supplied snapshot.
export function createContributorCommitmentIntent(prepared: PreparedProductionDeployment, input: ContributorCommitmentInput, observation: ContributorCapacityObservation, nowSeconds: bigint) {
  const fail = (reason: string): never => {throw new Error(`COMMIT_${reason}`);};
  exact(input, ["schema", "chainId", "token", "reserve", "projectControllerSafe", "safeNonce", "beneficiary", "amountBaseUnits", "purpose", "schedule", "configurationSha256", "reserveConfigurationSha256", "artifactPinsSha256", "sourceRevision"]);
  exact(observation, ["schema", "provenance", "chainId", "blockNumber", "blockHash", "blockTimestamp", "observedAt", "token", "reserve", "projectControllerSafe", "safeNonce", "safeThreshold", "safeOwners", "safeProxyCodeHash", "safeSingletonCodeHash", "safeSingletonAddress", "controllerToken", "controllerSafe", "controllerPurpose", "rollingCapBaseUnits", "perGrantCapBaseUnits", "controllerWindowSeconds", "rollingCommittedBaseUnits", "grossCommittedBaseUnits", "reserveBalanceBaseUnits"]);
  if (input.schema !== "agtmai-contributor-commitment-input-v1" || observation.schema !== "agtmai-contributor-capacity-observation-v1" || observation.provenance !== "supplied-unverified") {fail("VERSION");}
  if (!prepared || prepared.schema !== "agtmai-prepared-production-deployment-v1" || prepared.broadcastAllowed !== false || prepared.coverage !== "token-and-reserves-only") {fail("PREPARED");}
  const validated = validateProductionDeployment(prepared.configuration);
  if (!validated.value) {fail("CONFIGURATION");}
  const config = validated.value;
  const expectedConfiguration = sha256Hex(deploymentBytes(config.deployment));
  const expectedReserve = sha256Hex(deploymentBytes(config.reserveGenesis));
  const pins = sha256Hex(deploymentBytes({ schema: "agtmai-production-artifact-pins-v1", sourceRevision: prepared.expectations.sourceRevision, artifacts: prepared.artifacts.toSorted((a, b) => a.contract.localeCompare(b.contract)) }));
  if (prepared.configurationSha256 !== expectedConfiguration || prepared.reserveConfigurationSha256 !== expectedReserve || prepared.expectations.configurationSha256 !== expectedConfiguration || prepared.expectations.reserveConfigurationSha256 !== expectedReserve || prepared.expectations.artifactPinsSha256 !== pins || prepared.approval.configurationSha256 !== expectedConfiguration || prepared.approval.reserveConfigurationSha256 !== expectedReserve || prepared.expectations.sourceRevision !== input.sourceRevision || !/^[0-9a-f]{40}$/.test(input.sourceRevision) || input.configurationSha256 !== expectedConfiguration || input.reserveConfigurationSha256 !== expectedReserve || input.artifactPinsSha256 !== pins) {fail("BINDING");}
  const projectSafe = config.deployment.custodySafes.find(safe => safe.id === config.projectControllerSafeId);
  const expectedSafeState = prepared.expectations.authority.find(safe => safe.address === input.projectControllerSafe);
  const token = prepared.operations.find(operation => operation.id === "token-create");
  const controller = prepared.operations.find(operation => operation.id === "controller-create");
  const policy = config.reserveGenesis.contributors;
  if (!projectSafe || prepared.operations.map(operation => `${operation.id}:${operation.kind}`).join() !== "token-create:create,founder-reserve-create:create,controller-create:create,founder-fund:call" || !token?.expectedAddress || !controller?.expectedAddress || input.chainId !== "1" || observation.chainId !== "1" || input.chainId !== config.deployment.environment.evmChainId || !address(input.token) || !address(input.reserve) || !address(input.projectControllerSafe) || !address(input.beneficiary) || !hash(input.purpose) || input.token !== token.expectedAddress || input.reserve !== controller.expectedAddress || input.projectControllerSafe !== projectSafe.address || input.projectControllerSafe !== policy.controller || input.purpose !== policy.purpose || input.beneficiary === input.token || input.beneficiary === input.reserve) {fail("IDENTITY");}
  if (!expectedSafeState || observation.token !== input.token || observation.reserve !== input.reserve || observation.projectControllerSafe !== input.projectControllerSafe || observation.safeNonce !== input.safeNonce || observation.controllerToken !== input.token || observation.controllerSafe !== input.projectControllerSafe || observation.controllerPurpose !== input.purpose || observation.rollingCapBaseUnits !== policy.rollingCapBaseUnits || observation.perGrantCapBaseUnits !== policy.perGrantCapBaseUnits || observation.controllerWindowSeconds !== "31536000" || observation.safeThreshold !== 2 || !Array.isArray(observation.safeOwners) || observation.safeOwners.length !== 3 || observation.safeOwners.some(owner => !address(owner)) || new Set(observation.safeOwners).size !== 3 || observation.safeOwners.toSorted().join() !== projectSafe.owners.toSorted().join() || !hash(observation.safeProxyCodeHash) || observation.safeProxyCodeHash !== expectedSafeState.proxyCodeHash || !hash(observation.safeSingletonCodeHash) || observation.safeSingletonCodeHash !== expectedSafeState.singletonCodeHash || !address(observation.safeSingletonAddress) || observation.safeSingletonAddress !== expectedSafeState.singletonAddress) {fail("OBSERVATION_BINDING");}
  decimal(input.safeNonce); decimal(observation.blockNumber); const blockTime = decimal(observation.blockTimestamp, UINT64); const seenAt = decimal(observation.observedAt, UINT64);
  if (!hash(observation.blockHash) || seenAt < blockTime || nowSeconds < seenAt || nowSeconds - seenAt > decimal(config.deployment.policy.observationMaxAgeSeconds) || nowSeconds > UINT64) {fail("STALE_OBSERVATION");}
  const amount = decimal(input.amountBaseUnits);
  const rolling = decimal(observation.rollingCommittedBaseUnits);
  const gross = decimal(observation.grossCommittedBaseUnits);
  const balance = decimal(observation.reserveBalanceBaseUnits);
  const cap = decimal(policy.rollingCapBaseUnits);
  if (amount === 0n || amount > decimal(policy.perGrantCapBaseUnits) || rolling > gross || rolling > cap || amount > cap - rolling) {fail("CAP");}
  if (balance < amount) {fail("INVENTORY");}
  exact(input.schedule, input.schedule.anniversaryRule === undefined ? ["profile", "start", "cliff", "end"] : ["profile", "start", "cliff", "end", "anniversaryRule"]);
  if (validateGrantSchedule(input.schedule, true, "/schedule").length) {fail("SCHEDULE");}
  const start = decimal(input.schedule.start, UINT64), cliff = decimal(input.schedule.cliff, UINT64), end = decimal(input.schedule.end, UINT64);
  if (start < nowSeconds || start < blockTime) {fail("BACKDATED");}
  // ABI: commit(address,(uint256,uint64,uint64,uint64,uint8,bytes32)); tuple is static.
  const selector = keccak256(new TextEncoder().encode("commit(address,(uint256,uint64,uint64,uint64,uint8,bytes32))")).slice(2, 10);
  const data = `0x${selector}${addressWord(input.beneficiary)}${word(amount)}${word(start)}${word(cliff)}${word(end)}${word(1n)}${input.purpose.slice(2)}` as `0x${string}`;
  const safeTransaction = { to: input.reserve, value: "0", data, operation: 0 as const };
  const identity = { domain: "AGTMAI_CONTRIBUTOR_COMMITMENT_INTENT_V1", chainId: input.chainId, safe: input.projectControllerSafe, safeNonce: input.safeNonce, input, observation, safeTransaction };
  const intentDigest = sha256Hex(deploymentBytes(identity));
  return { schema: "agtmai-unsigned-contributor-commitment-v1" as const, status: "review-only" as const, broadcastAllowed: false as const, evidenceStatus: "supplied-unverified" as const, input, observation, safeTransaction, calldataKeccak256: keccak256(Buffer.from(data.slice(2), "hex")), intentDigest, capacityAfterIfExecutedBaseUnits: (cap - rolling - amount).toString(), limitations: ["Supplied observation is not authenticated chain evidence.", "This intent does not reserve funds or cap capacity.", "Safe transaction hash and signatures are intentionally absent."] as const };
}
