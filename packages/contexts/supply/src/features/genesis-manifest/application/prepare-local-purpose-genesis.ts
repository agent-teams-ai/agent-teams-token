import { canonicalJson, type JsonValue } from "./canonical.js";
import { parseCanonicalUint, UINT64_MAX } from "../domain/model.js";
import { validateLocalPurposeGenesis, type LocalPurposeGenesis } from "../domain/local-purpose-genesis.js";
import type { Hex } from "../domain/deployment.js";

export type { LocalPurposeContract, LocalPurposeArtifact, LocalPurposeArtifactSet, LocalPurposePorts, LocalPurposeOperation, AssemblyConstructor } from "./assembly-construction.js";
import { constructReserveAssembly, type LocalPurposeArtifact, type LocalPurposeArtifactSet, type LocalPurposePorts, type LocalPurposeOperation, type AssemblyConstructor } from "./assembly-construction.js";
export interface PreparedLocalPurposeGenesis {
  readonly schema: "agtmai-prepared-local-purpose-genesis-v1" | "agtmai-prepared-local-purpose-genesis-v2";
  readonly constructors?: readonly AssemblyConstructor[];
  readonly approval?: null;
  readonly authorityClass?: "test-only";
  readonly coverage?: "full-ethereum-reserve-assembly";
  readonly evidenceClass: "local-preparation-only";
  readonly broadcastAllowed: false;
  readonly candidateRevision: string;
  readonly configuration: LocalPurposeGenesis;
  readonly configurationSha256: Hex;
  readonly artifacts: readonly LocalPurposeArtifact[];
  readonly genesisAllocationHash: Hex;
  readonly operations: readonly LocalPurposeOperation[];
  readonly planSha256: Hex;
}
export interface LocalPurposePreflight {
  readonly chainId: "31337" | "1";
  readonly blockHash: Hex;
  readonly blockNumber: string;
  readonly timestamp: string;
  readonly sender: Hex;
  readonly nextNonce: string;
  readonly accounts: readonly { readonly address: Hex; readonly code: Hex; readonly nonce: string }[];
}

const digest = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) && !/^0x0{64}$/.test(value);
const address = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const fail = (): never => { throw new Error("LOCAL_PURPOSE_PLAN_INVALID"); };
const hash = (value: unknown, ports: LocalPurposePorts): Hex => ports.sha256(new TextEncoder().encode(canonicalJson(value as JsonValue)));

/** Pure, unsigned, closed ten-operation plan for an already configured disposable chain. */
export function prepareLocalPurposeGenesis(input: unknown, candidateRevision: string, artifactSet: LocalPurposeArtifactSet, ports: LocalPurposePorts): PreparedLocalPurposeGenesis {
  const config = validateLocalPurposeGenesis(input);
  if (!/^[0-9a-f]{40}$/.test(candidateRevision) || artifactSet?.sourceRevision !== candidateRevision) { return fail(); }
  const { artifacts: pinned, operations, genesisAllocationHash, constructors } = constructReserveAssembly(config, artifactSet.artifacts, ports);
  if (config.schema === "agtmai-local-purpose-genesis-v2" && constructors.length !== 10) { fail(); }
  const sender = config.execution.sender;
  const configurationSha256 = hash(config, ports);
  const planSha256 = hash({ domain: config.schema === "agtmai-local-purpose-genesis-v1" ? "AGTMAI_LOCAL_PURPOSE_PLAN_V1" : "AGTMAI_LOCAL_PURPOSE_PLAN_V2", candidateRevision, configurationSha256,
    artifactPins: pinned, chainId: config.chainId, sender, execution: config.execution, genesisAllocationHash: genesisAllocationHash,
    operations }, ports);
  return { schema: config.schema === "agtmai-local-purpose-genesis-v1" ? "agtmai-prepared-local-purpose-genesis-v1" : "agtmai-prepared-local-purpose-genesis-v2", evidenceClass: "local-preparation-only", broadcastAllowed: false,
    candidateRevision, configuration: config, configurationSha256, artifacts: pinned,
    ...(config.schema === "agtmai-local-purpose-genesis-v2" ? { constructors, approval: null, authorityClass: "test-only" as const, coverage: "full-ethereum-reserve-assembly" as const } : {}),
    genesisAllocationHash: genesisAllocationHash, operations, planSha256 };
}

/** Reconstruct a selected plan from separately selected configuration and artifact pins. */
export function verifyPreparedLocalPurposeGenesis(selected: unknown, candidateRevision: string, artifactSet: LocalPurposeArtifactSet,
  published: PreparedLocalPurposeGenesis, ports: LocalPurposePorts): void {
  const expected = prepareLocalPurposeGenesis(selected, candidateRevision, artifactSet, ports);
  if (canonicalJson(published as unknown as JsonValue) !== canonicalJson(expected as unknown as JsonValue)) { fail(); }
}

/** Check one identified local block before token creation; the caller owns the chain observation. */
export function verifyLocalPurposePreflight(prepared: PreparedLocalPurposeGenesis, observed: LocalPurposePreflight): void {
  const execution = prepared.configuration.execution;
  if (observed?.chainId !== prepared.configuration.chainId || !digest(observed.blockHash)
    || parseCanonicalUint(observed.blockNumber, UINT64_MAX) === undefined
    || parseCanonicalUint(observed.timestamp, UINT64_MAX) === undefined
    || observed.sender !== execution.sender || observed.nextNonce !== execution.startingNonce
    || BigInt(observed.timestamp) > BigInt(execution.fundingDeadline)
    || !Array.isArray(observed.accounts)) { fail(); }
  assertLocalPurposeCreateTargetsUnoccupied(prepared, observed.accounts);
}

/** Require exactly one own, dense, empty observation for every top-level and nested CREATE. */
function assertLocalPurposeCreateTargetsUnoccupied(prepared: PreparedLocalPurposeGenesis, accounts: LocalPurposePreflight["accounts"]): void {
  const targets = [...prepared.operations.filter(o => o.kind === "create").map(o => o.expectedAddress!),
    prepared.operations[1]?.nestedAddress];
  if (targets.length !== 10 || targets.some(a => !address(a))
    || new Set(targets).size !== targets.length || accounts.length !== targets.length) { fail(); }
  const remaining = new Set(targets);
  for (let index = 0; index < accounts.length; index++) {
    if (!Object.hasOwn(accounts, index)) { fail(); }
    const account = accounts[index];
    if (!account || !remaining.delete(account.address) || account.code !== "0x" || account.nonce !== "0") { fail(); }
  }
  if (remaining.size) { fail(); }
}

export { materializeAssemblyRuntime, verifyAssemblyRuntime } from "./assembly-construction.js";
