import { encodeAllocationId, normalizeAllocationSet, parseCanonicalUint, UINT64_MAX, type NormalizedAllocation } from "../domain/model.js";
import { PURPOSE_ALLOCATION_IDS, type LocalPurposePolicy as PurposePolicy } from "../domain/local-purpose-genesis.js";
import type { ReservePolicyBody } from "../domain/reserve-genesis.js";
import type { DeploymentSafe, Hex } from "../domain/deployment.js";
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
  readonly encodeFounderVault?: (input: { token: Hex; reserve: Hex; beneficiary: Hex; controller: Hex; allocation: string; start: string; cliff: string; end: string; purpose: Hex }) => Hex;
}
export interface AssemblyConstructor {
  readonly id: string; readonly contract: LocalPurposeContract; readonly fullyQualifiedName: string;
  readonly predictedAddress: Hex; readonly observed: null;
  readonly creation: { readonly kind: "top-level"; readonly nonce: string } | { readonly kind: "nested"; readonly parentOperationId: "founder-reserve-create"; readonly nonce: "1" };
  readonly compilerVersion: "0.8.36"; readonly compilerInputSha256: Hex;
  readonly artifactSha256: Hex; readonly buildInfoSha256: Hex;
  readonly constructorArgs: Hex; readonly initcode: Hex; readonly initcodeHash: Hex;
  readonly runtimeTemplate: Hex; readonly runtimeTemplateHash: Hex;
  readonly materializedRuntime: Hex; readonly materializedRuntimeHash: Hex;
  readonly immutableValues: Readonly<Record<string, Hex>>;
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

export interface AssemblyConfiguration {
  readonly chainId: string;
  readonly reserve: ReservePolicyBody;
  readonly custodySafes: readonly DeploymentSafe[];
  readonly projectControllerSafeId: string;
  readonly purposeVaults: readonly PurposePolicy[];
  readonly execution: { readonly sender: Hex; readonly startingNonce: string };
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
const word = (value: string): Hex => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const fail = (): never => { throw new Error("LOCAL_PURPOSE_PLAN_INVALID"); };

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

/** Authority admission is separate; both production and synthetic preparation use these exact constructors. */
export function constructReserveAssembly(config: AssemblyConfiguration, artifacts: readonly LocalPurposeArtifact[], ports: LocalPurposePorts) {
  const nonce = parseCanonicalUint(config.execution.startingNonce, UINT64_MAX);
  if (nonce === undefined || nonce + 10n > UINT64_MAX) { fail(); }
  const pinned = checkArtifacts(artifacts);
  const artifact = (name: LocalPurposeContract): LocalPurposeArtifact => pinned.find(a => a.contract === name)!;
  const sender = config.execution.sender;
  if (!address(sender) || config.custodySafes.some(s => s.address === sender || s.owners.includes(sender))) { fail(); }
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
  const immutableValues: readonly Readonly<Record<string, Hex>>[] = [
    { GENESIS_ALLOCATION_HASH: token.genesisAllocationHash, INITIAL_CCIP_ADMIN: word(project.address), INITIAL_SUPPLY: word(config.reserve.initialSupplyBaseUnits) },
    { TOKEN: word(created[0]!), VAULT: word(nested) },
    { TOKEN: word(created[0]!), CONTROLLER: word(contributor.controller), PURPOSE: contributor.purpose as Hex,
      ROLLING_CAP: word(contributor.rollingCapBaseUnits), PER_GRANT_CAP: word(contributor.perGrantCapBaseUnits) },
    ...PURPOSE_ALLOCATION_IDS.map(id => {
      const policy = config.purposeVaults.find(p => p.allocationId === id)!;
      return { TOKEN: word(created[0]!), CONTROLLER: word(project.address), PURPOSE: encodeAllocationId(id)!,
        OPENS_AT: word(policy.opensAt), WINDOW_SECONDS: word(policy.windowSeconds), ROLLING_CAP: word(policy.rollingCapBaseUnits) };
    }),
  ];
  const constructor = (name: LocalPurposeContract, id: string, input: { at: Hex; args: Hex; values: Readonly<Record<string, Hex>>; creation: AssemblyConstructor["creation"] }): AssemblyConstructor => {
    const { at, args: constructorArgs, values, creation } = input;
    const a = artifact(name), runtime = materializeAssemblyRuntime(a, values);
    const initcode = `${a.creationBytecode}${constructorArgs.slice(2)}` as Hex;
    const hash = (hex: Hex) => ports.keccak256(Uint8Array.from(hex.slice(2).match(/../g) ?? [], byte => Number.parseInt(byte, 16)));
    const feature = name === "AGTMAICCIPToken" ? "token-genesis" : name === "PurposeReserveVault" ? "purpose-reserves" : "contributor-grants";
    return { id, contract: name, fullyQualifiedName: `src/features/${feature}/${name}.sol:${name}`, predictedAddress: at, observed: null,
      creation, compilerVersion: a.compilerVersion, compilerInputSha256: a.compilerInputSha256, artifactSha256: a.artifactSha256,
      buildInfoSha256: a.buildInfoSha256, constructorArgs, initcode, initcodeHash: hash(initcode), runtimeTemplate: a.runtimeBytecode,
      runtimeTemplateHash: hash(a.runtimeBytecode), materializedRuntime: runtime, materializedRuntimeHash: hash(runtime), immutableValues: values };
  };
  const constructors = names.map((name, i) => constructor(name, ids[i]!, { at: created[i]!, args: args[i]!, values: immutableValues[i]!,
    creation: { kind: "top-level", nonce: operations[i]!.nonce } }));
  if (ports.encodeFounderVault) {
    const childArgs = ports.encodeFounderVault({ token: created[0]!, reserve: created[1]!, beneficiary: founder.beneficiary as Hex,
      controller: founder.controller as Hex, allocation: founderAmount, start: founder.schedule.start,
      cliff: founder.schedule.cliff, end: founder.schedule.end, purpose: founder.purpose as Hex });
    if (!bytes(childArgs)) { fail(); }
    constructors.push(constructor("GrantVault", "founder-vault", { at: nested, args: childArgs,
      values: { TOKEN: word(created[0]!), BENEFICIARY: word(founder.beneficiary), ORIGINAL_RESERVE: word(created[1]!), CONTROLLER: word(founder.controller) },
      creation: { kind: "nested", parentOperationId: "founder-reserve-create", nonce: "1" } }));
  }
  return { artifacts: pinned, genesisAllocationHash: token.genesisAllocationHash, operations, constructors };
}

/** Replace only authenticated named immutable occurrences. Every other runtime byte remains exact. */
export function materializeAssemblyRuntime(artifact: LocalPurposeArtifact, values: Readonly<Record<string, Hex>>): Hex {
  const refs = artifact.immutableReferences.toSorted((a, b) => a.start - b.start);
  if (Object.keys(values).toSorted().join() !== [...expectedImmutables[artifact.contract]].toSorted().join()
    || [...new Set(refs.map(r => r.name))].toSorted().join() !== Object.keys(values).toSorted().join()) { fail(); }
  let runtime = artifact.runtimeBytecode;
  for (const [i, r] of refs.entries()) {
    const value = values[r.name];
    if (!/^0x[0-9a-f]{64}$/.test(value ?? "") || !Number.isSafeInteger(r.start) || r.start < 0 || r.length !== 32
      || (r.start + 32) * 2 > runtime.length - 2 || (i > 0 && r.start < refs[i - 1]!.start + 32)) { fail(); }
    const start = 2 + r.start * 2;
    runtime = `${runtime.slice(0, start)}${value!.slice(2)}${runtime.slice(start + 64)}` as Hex;
  }
  return runtime;
}

export function verifyAssemblyRuntime(artifact: LocalPurposeArtifact, values: Readonly<Record<string, Hex>>, actual: Hex): void {
  if (actual !== materializeAssemblyRuntime(artifact, values)) { fail(); }
}
