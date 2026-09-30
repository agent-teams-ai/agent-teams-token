import { canonicalJson, type JsonValue } from "./canonical.js";
import { encodeAllocationId, normalizeAllocationSet, parseCanonicalUint, UINT64_MAX, type NormalizedAllocation } from "../domain/model.js";
import { validateLocalPurposeGenesis, PURPOSE_ALLOCATION_IDS, type LocalPurposeGenesis } from "../domain/local-purpose-genesis.js";
import type { Hex } from "../domain/deployment.js";

export type LocalPurposeContract = "AGTMAICCIPToken" | "FounderGrantReserve" | "ReserveController" | "PurposeReserveVault" | "GrantVault";
export interface LocalPurposeArtifact {
  readonly contract: LocalPurposeContract;
  readonly compilerVersion: "0.8.36";
  readonly creationBytecode: Hex;
  readonly runtimeBytecode: Hex;
  readonly artifactSha256: Hex;
  readonly buildInfoSha256: Hex;
  readonly compilerInputSha256: Hex;
  readonly immutableReferences: readonly { readonly name: string; readonly start: number; readonly length: 32 }[];
}
export interface LocalPurposeArtifactSet {
  readonly sourceRevision: string;
  readonly artifacts: readonly LocalPurposeArtifact[];
}
export interface LocalPurposePorts {
  readonly sha256: (bytes: Uint8Array) => Hex;
  readonly keccak256: (bytes: Uint8Array) => Hex;
  readonly createAddress: (sender: Hex, nonce: string) => Hex;
  readonly encodeToken: (chainId: string, supply: string, administrator: Hex, allocations: readonly NormalizedAllocation[]) => { readonly constructorArgs: Hex; readonly genesisAllocationHash: Hex };
  readonly encodeFounderReserve: (input: { token: Hex; beneficiary: Hex; controller: Hex; allocation: string; start: string; cliff: string; end: string; purpose: Hex }) => Hex;
  readonly encodeReserveController: (token: Hex, controller: Hex, purpose: Hex, rollingCap: string, perGrantCap: string) => Hex;
  readonly encodePurposeVault: (input: { token: Hex; controller: Hex; purpose: Hex; opensAt: string; windowSeconds: string; rollingCap: string }) => Hex;
}
export interface LocalPurposeOperation {
  readonly id: string;
  readonly kind: "create" | "call";
  readonly nonce: string;
  readonly expectedAddress?: Hex;
  readonly nestedAddress?: Hex;
  readonly to?: Hex;
  readonly initcode?: Hex;
  readonly calldata?: Hex;
  readonly value: "0";
}
export interface PreparedLocalPurposeGenesis {
  readonly schema: "agtmai-prepared-local-purpose-genesis-v1";
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
  readonly chainId: "31337";
  readonly blockHash: Hex;
  readonly blockNumber: string;
  readonly timestamp: string;
  readonly sender: Hex;
  readonly nextNonce: string;
  readonly accounts: readonly { readonly address: Hex; readonly code: Hex; readonly nonce: string }[];
}

const requiredContracts: readonly LocalPurposeContract[] = ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController", "PurposeReserveVault", "GrantVault"];
const expectedImmutables: Readonly<Record<LocalPurposeContract, readonly string[]>> = {
  AGTMAICCIPToken: ["GENESIS_ALLOCATION_HASH", "INITIAL_CCIP_ADMIN", "INITIAL_SUPPLY"],
  FounderGrantReserve: ["TOKEN", "VAULT"],
  ReserveController: ["CONTROLLER", "PER_GRANT_CAP", "PURPOSE", "ROLLING_CAP", "TOKEN"],
  PurposeReserveVault: ["CONTROLLER", "OPENS_AT", "PURPOSE", "ROLLING_CAP", "TOKEN", "WINDOW_SECONDS"],
  GrantVault: ["BENEFICIARY", "CONTROLLER", "ORIGINAL_RESERVE", "TOKEN"],
};
const digest = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) && !/^0x0{64}$/.test(value);
const bytes = (value: unknown): value is Hex => typeof value === "string" && /^0x(?:[0-9a-f]{2})+$/.test(value);
const address = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const fail = (): never => { throw new Error("LOCAL_PURPOSE_PLAN_INVALID"); };
const hash = (value: unknown, ports: LocalPurposePorts): Hex => ports.sha256(new TextEncoder().encode(canonicalJson(value as JsonValue)));

function checkArtifacts(artifacts: readonly LocalPurposeArtifact[]): readonly LocalPurposeArtifact[] {
  if (!Array.isArray(artifacts) || artifacts.length !== requiredContracts.length
    || artifacts.some(a => a === null || typeof a !== "object")
    || new Set(artifacts.map(a => a.contract)).size !== requiredContracts.length) { return fail(); }
  const sorted: readonly LocalPurposeArtifact[] = artifacts.toSorted((a: LocalPurposeArtifact, b: LocalPurposeArtifact) => a.contract < b.contract ? -1 : 1);
  for (const artifact of sorted) {
    if (Object.keys(artifact).toSorted().join() !== ["contract", "compilerVersion", "creationBytecode", "runtimeBytecode",
      "artifactSha256", "buildInfoSha256", "compilerInputSha256", "immutableReferences"].toSorted().join()
      || !requiredContracts.includes(artifact.contract) || artifact.compilerVersion !== "0.8.36"
      || !bytes(artifact.creationBytecode) || !bytes(artifact.runtimeBytecode)
      || !digest(artifact.artifactSha256) || !digest(artifact.buildInfoSha256) || !digest(artifact.compilerInputSha256)
      || !Array.isArray(artifact.immutableReferences)) { return fail(); }
    if (artifact.immutableReferences.some(r => !r || typeof r !== "object")) { return fail(); }
    const refs = artifact.immutableReferences.toSorted((a, b) => a.start - b.start);
    if (JSON.stringify([...new Set(refs.map(r => r.name))].toSorted()) !== JSON.stringify([...expectedImmutables[artifact.contract]].toSorted())
      || refs.some((r, i) => Object.keys(r).toSorted().join() !== "length,name,start" || !Number.isSafeInteger(r.start) || r.start < 0 || r.length !== 32
        || (r.start + 32) * 2 > artifact.runtimeBytecode.length - 2
        || (i > 0 && r.start < refs[i - 1]!.start + 32))) { return fail(); }
  }
  return sorted;
}

/** Pure, unsigned, closed ten-operation plan for an already configured disposable chain. */
export function prepareLocalPurposeGenesis(input: unknown, candidateRevision: string, artifactSet: LocalPurposeArtifactSet, ports: LocalPurposePorts): PreparedLocalPurposeGenesis {
  const config = validateLocalPurposeGenesis(input);
  if (!/^[0-9a-f]{40}$/.test(candidateRevision) || artifactSet?.sourceRevision !== candidateRevision) { return fail(); }
  const pinned = checkArtifacts(artifactSet.artifacts);
  const artifact = (name: LocalPurposeContract): LocalPurposeArtifact => pinned.find(a => a.contract === name)!;
  const sender = config.execution.sender;
  const firstNonce = BigInt(config.execution.startingNonce);
  const created = Array.from({ length: 9 }, (_, i) => ports.createAddress(sender, (firstNonce + BigInt(i)).toString()));
  const nested = ports.createAddress(created[1]!, "1");
  if ([...created, nested].some(a => !address(a)) || new Set([...created, nested]).size !== 10) { return fail(); }
  const safes = config.custodySafes;
  const forbidden = new Set([sender, ...safes.flatMap(s => [s.address, ...s.owners])]);
  if ([...created, nested].some(a => forbidden.has(a))) { return fail(); }
  const expectedRecipients = new Map<string, Hex>([["founder", created[1]!], ["contributors", created[2]!],
    ...PURPOSE_ALLOCATION_IDS.map((id, i): [string, Hex] => [id, created[i + 3]!])]);
  if (config.reserve.allocations.some(a => a.recipient !== expectedRecipients.get(a.id))) { return fail(); }
  const normalized = normalizeAllocationSet(config.reserve.initialSupplyBaseUnits, config.reserve.allocations, "deployment");
  if (normalized.diagnostics.length || !normalized.allocations) { return fail(); }
  const project = safes.find(s => s.id === config.projectControllerSafeId)!;
  const founder = config.reserve.founder;
  const token = ports.encodeToken(config.chainId, config.reserve.initialSupplyBaseUnits, project.address, normalized.allocations);
  if (!digest(token.genesisAllocationHash) || !bytes(token.constructorArgs)) { return fail(); }
  const founderAmount = config.reserve.allocations.find(a => a.id === "founder")!.amountBaseUnits;
  const founderArgs = ports.encodeFounderReserve({ token: created[0]!, beneficiary: founder.beneficiary as Hex,
    controller: founder.controller as Hex, allocation: founderAmount, start: founder.schedule.start,
    cliff: founder.schedule.cliff, end: founder.schedule.end, purpose: founder.purpose as Hex });
  const contributor = config.reserve.contributors;
  const controllerArgs = ports.encodeReserveController(created[0]!, contributor.controller as Hex, contributor.purpose as Hex,
    contributor.rollingCapBaseUnits, contributor.perGrantCapBaseUnits);
  const purposeArgs = PURPOSE_ALLOCATION_IDS.map(id => {
    const policy = config.purposeVaults.find(p => p.allocationId === id)!;
    return ports.encodePurposeVault({ token: created[0]!, controller: project.address, purpose: encodeAllocationId(id)!,
      opensAt: policy.opensAt, windowSeconds: policy.windowSeconds, rollingCap: policy.rollingCapBaseUnits });
  });
  const names: LocalPurposeContract[] = ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController", ...PURPOSE_ALLOCATION_IDS.map(() => "PurposeReserveVault" as const)];
  const args = [token.constructorArgs, founderArgs, controllerArgs, ...purposeArgs];
  if (args.some(a => !bytes(a))) { return fail(); }
  const ids = ["token-create", "founder-reserve-create", "controller-create", ...PURPOSE_ALLOCATION_IDS.map(id => `purpose-${id}-create`)];
  const operations: LocalPurposeOperation[] = names.map((name, i) => ({ id: ids[i]!, kind: "create", nonce: (firstNonce + BigInt(i)).toString(),
    expectedAddress: created[i]!, ...(i === 1 ? { nestedAddress: nested } : {}),
    initcode: `${artifact(name).creationBytecode}${args[i]!.slice(2)}` as Hex, value: "0" }));
  operations.push({ id: "founder-fund", kind: "call", nonce: (firstNonce + 9n).toString(), to: created[1]!,
    calldata: `0x${ports.keccak256(new TextEncoder().encode("fund()")).slice(2, 10)}`, value: "0" });
  const configurationSha256 = hash(config, ports);
  const planSha256 = hash({ domain: "AGTMAI_LOCAL_PURPOSE_PLAN_V1", candidateRevision, configurationSha256,
    artifactPins: pinned, chainId: config.chainId, sender, execution: config.execution, genesisAllocationHash: token.genesisAllocationHash,
    operations }, ports);
  return { schema: "agtmai-prepared-local-purpose-genesis-v1", evidenceClass: "local-preparation-only", broadcastAllowed: false,
    candidateRevision, configuration: config, configurationSha256, artifacts: pinned,
    genesisAllocationHash: token.genesisAllocationHash, operations, planSha256 };
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
  if (observed?.chainId !== "31337" || !digest(observed.blockHash)
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
