import { evaluateProductionGuards, type ApprovedProductionPolicy, type ProductionAttempt, type ProductionExpectations, type ProductionObservation, type ProductionGuardReport } from "../domain/production-guards.ts";
import { canonicalJson } from "../domain/identity.ts";

export interface ProductionPreflightRequest {
  readonly prepared: unknown;
  readonly expectations: ProductionExpectations;
  readonly observations: ProductionObservation;
  readonly attempt: ProductionAttempt;
  readonly nowSeconds: bigint;
  readonly preparedConfigurationSha256: string;
  readonly preparedReserveConfigurationSha256: string;
  readonly preparedArtifactPinsSha256: string;
  readonly expectedGenesisAllocationHash?: string;
}

/** Offline coordinator. It has no provider, signer, transaction or broadcast port. */
export function assessProductionPreflight(request: ProductionPreflightRequest): ProductionGuardReport {
  try {return assessProductionPreflightUnchecked(request);}
  catch {return { status: "invalid", broadcastAllowed: false, reasons: ["preflight-evidence-invalid"] };}
}

function assessProductionPreflightUnchecked(request: ProductionPreflightRequest): ProductionGuardReport {
  const prepared = request.prepared as Record<string, unknown> | null;
  const preparedOperations = prepared?.operations;
  const reasons: string[] = [];
  const preparedExpectations = prepared?.expectations as Record<string, unknown> | null;
  const approval = prepared?.approval as Record<string, unknown> | null;
  const artifacts = Array.isArray(prepared?.artifacts) ? prepared.artifacts as Record<string, unknown>[] : [];
  const artifactsValid = validArtifacts(artifacts);
  const approvalValid = validApproval(approval, prepared);
  if (!validEnvelope({ request, prepared, expectations: preparedExpectations, operations: preparedOperations, approval: approvalValid, artifacts: artifactsValid })) {
    return { status: "invalid", broadcastAllowed: false, reasons: ["prepared-deployment-invalid"] };
  }
  const preparedRecord = prepared!;
  const embeddedExpectations = preparedExpectations!;
  const actualOperations = preparedOperations as unknown[];
  if (canonicalJson(embeddedExpectations) !== canonicalJson(request.expectations)) {return { status: "invalid", broadcastAllowed: false, reasons: ["embedded-expectations-mismatch"] };}
  const expectedOperations = request.expectations.operations;
  const operationMatch = preparedOperationInventoryMatches(actualOperations, embeddedExpectations, expectedOperations);
  if (!operationMatch.inventory) {reasons.push("prepared-operation-inventory-mismatch");}
  else if (!operationMatch.binding) {reasons.push("prepared-operation-binding-mismatch");}
  if (reasons.length) {return { status: "blocked", broadcastAllowed: false, reasons };}
  const runtimeVerification = preparedRecord.runtimeVerification as Record<string, unknown> | undefined;
  const runtimeContracts = runtimeVerification?.contracts;
  const runtimeState = runtimeStatus(runtimeVerification, runtimeContracts, artifacts);
  const hasImmutables = runtimeState.hasImmutables;
  const runtimeValid = runtimeState.valid;
  if (!runtimeValid) {return { status: "invalid", broadcastAllowed: false, reasons: ["prepared-runtime-verification-invalid"] };}
  if (hasImmutables && request.observations.schema !== "agtmai-production-observation-v2") {return { status: "blocked", broadcastAllowed: false, reasons: ["runtime-immutables-require-deterministic-local-execution"] };}
  if (request.observations.schema === "agtmai-production-observation-v2") {
    const evidenceReasons = validateExecutionEvidence(preparedRecord, request.expectations, request.observations, artifacts, request.expectedGenesisAllocationHash ?? "");
    if (evidenceReasons.length) {return { status: "blocked", broadcastAllowed: false, reasons: evidenceReasons };}
  }
  const approved = approvedPolicy(preparedRecord);
  if (!approved) {return { status: "invalid", broadcastAllowed: false, reasons: ["prepared-policy-missing"] };}
  return evaluateProductionGuards(request.expectations, request.observations, request.attempt, request.nowSeconds, approved);
}

function validateExecutionEvidence(prepared: Record<string, unknown>, expectations: ProductionExpectations, observations: ProductionObservation, artifacts: Record<string, unknown>[], expectedGenesisAllocationHash: string): string[] {
  const reasons: string[] = [];
  validateExecutionContext(expectations, observations, reasons);
  const byId = new Map(observations.operations.map(operation => [operation.id, operation]));
  validateExecutionOperations(expectations, observations, byId, reasons);
  const state = observations.state;
  if (!state) {reasons.push("execution-state-missing"); return unique(reasons);}
  validateStateFacts(prepared, expectations, observations, state, expectedGenesisAllocationHash, reasons);
  for (const expected of expectations.operations.filter(operation => operation.kind === "create")) {
    const seen = byId.get(expected.id);
    const artifact = artifacts.find(value => value.contract === (expected.id === "token-create" ? "AGTMAICCIPToken" : expected.id === "founder-reserve-create" ? "FounderGrantReserve" : "ReserveController"));
    if (seen && artifact && typeof seen.runtime === "string" && typeof artifact.runtimeBytecode === "string") {
      if (seen.artifactSha256 !== artifact.artifactSha256 || seen.artifact !== artifact.runtimeBytecode) {reasons.push(`artifact-${expected.id}-mismatch`);}
      const refs = Array.isArray(artifact.immutableReferences) ? artifact.immutableReferences as { name: string; start: number; length: number }[] : [];
      if (maskRuntime(seen.runtime, artifact.runtimeBytecode, refs) !== maskRuntime(artifact.runtimeBytecode, artifact.runtimeBytecode, refs)) {reasons.push(`runtime-${expected.id}-mismatch`);}
      const observedRefs = seen.immutableReferences ?? [];
      if (observedRefs.length !== refs.length || refs.some((reference, index) => { const observed = observedRefs[index], expectedValue = immutableValue(expected.id, reference.name, state); return !observed || observed.name !== reference.name || observed.start !== String(reference.start) || observed.length !== String(reference.length) || observed.value !== `0x${seen.runtime!.slice(2 + reference.start * 2, 2 + (reference.start + reference.length) * 2)}` || expectedValue === undefined || wordValue(expectedValue) !== observed.value.toLowerCase(); })) {reasons.push(`immutable-${expected.id}-mismatch`);}
    }
  }
  return unique(reasons);
}

function validateExecutionContext(expectations: ProductionExpectations, observations: ProductionObservation, reasons: string[]): void {
  const binding = observations.binding;
  if (!binding || binding.sourceRevision !== expectations.sourceRevision || binding.configurationSha256 !== expectations.configurationSha256 || binding.reserveConfigurationSha256 !== expectations.reserveConfigurationSha256 || binding.artifactPinsSha256 !== expectations.artifactPinsSha256) {reasons.push("execution-binding-mismatch");}
  if (!observations.rpcEndpoint || !/^http:\/\/127[.]0[.]0[.]1:[1-9][0-9]{0,4}\/$/.test(observations.rpcEndpoint) || observations.netVersion !== "1") {reasons.push("execution-chain-identity-mismatch");}
  if (!observations.cleanup || observations.cleanup.processExited !== true || observations.cleanup.exitCode !== "0" || observations.cleanup.descriptorsClosed !== true || observations.cleanup.temporaryRootRemoved !== true || observations.cleanup.diagnostic !== null) {reasons.push("execution-cleanup-incomplete");}
}
// oxlint-disable-next-line complexity -- every receipt identity field is mandatory and independently bound.
function validateExecutionOperations(expectations: ProductionExpectations, observations: ProductionObservation, byId: ReadonlyMap<string, ProductionObservation["operations"][number]>, reasons: string[]): void {
  let previousBlock: bigint | undefined;
  let observedTotal = 0n;
  for (const [index, expected] of expectations.operations.entries()) {
    const seen = byId.get(expected.id);
    const input = expected.kind === "create" ? expected.initcode : expected.calldata;
    if (!seen || !/^0x[0-9a-f]{64}$/.test(seen.transactionHash ?? "") || seen.receiptTransactionHash !== seen.transactionHash || seen.transactionIndex !== "0" || seen.sender !== expectations.sender || seen.nonce !== expected.nonce || seen.input !== input || seen.value !== expected.value || seen.status !== "1" || !/^(0|[1-9][0-9]*)$/.test(seen.blockNumber ?? "") || !/^0x[0-9a-f]{64}$/.test(seen.blockHash ?? "") || !/^(0|[1-9][0-9]*)$/.test(seen.timestamp ?? "") || seen.expectedAddress !== expected.expectedAddress || seen.actualAddress !== expected.expectedAddress) {reasons.push(`execution-${expected.id}-mismatch`); continue;}
    if (seen.gasLimit !== expected.gasLimit || seen.maxFeePerGas !== expected.maxFeePerGas || seen.maxPriorityFeePerGas !== expected.maxPriorityFeePerGas) {reasons.push(`execution-${expected.id}-fee-mismatch`);}
    const gasLimit = BigInt(seen.gasLimit!), gasUsed = BigInt(seen.gasUsed!), effectiveGasPrice = BigInt(seen.effectiveGasPrice!);
    const cost = gasUsed * effectiveGasPrice + BigInt(seen.value!);
    if (gasUsed === 0n || gasUsed > gasLimit || effectiveGasPrice === 0n || effectiveGasPrice > BigInt(seen.maxFeePerGas!) || seen.observedCostWei !== cost.toString()) {reasons.push(`execution-${expected.id}-cost-mismatch`);}
    observedTotal += cost;
    const block = BigInt(seen.blockNumber!);
    if (previousBlock !== undefined && block !== previousBlock + 1n) {reasons.push("execution-block-sequence-mismatch");}
    previousBlock = block;
    if (index === expectations.operations.length - 1 && (observations.blockNumber !== seen.blockNumber || observations.blockHash !== seen.blockHash)) {reasons.push("execution-final-block-mismatch");}
  }
  if (observations.observedTotalCostWei !== observedTotal.toString() || observedTotal > BigInt(expectations.maxTotalCostWei)) {reasons.push("execution-observed-cost-mismatch");}
}
// oxlint-disable-next-line complexity, max-params -- this is the single cross-contract state binding gate.
function validateStateFacts(prepared: Record<string, unknown>, expectations: ProductionExpectations, observations: ProductionObservation, state: NonNullable<ProductionObservation["state"]>, expectedGenesisAllocationHash: string, reasons: string[]): void {
  const configuration = prepared.configuration as Record<string, unknown>;
  const deployment = configuration.deployment as Record<string, unknown> | undefined;
  const reserveGenesis = configuration.reserveGenesis as Record<string, unknown> | undefined;
  const tokenOperation = expectations.operations.find(operation => operation.id === "token-create");
  const founderOperation = expectations.operations.find(operation => operation.id === "founder-reserve-create");
  const controllerOperation = expectations.operations.find(operation => operation.id === "controller-create");
  const configuredToken = deployment?.token as Record<string, unknown> | undefined;
  if (state.blockNumber !== observations.blockNumber || state.blockHash !== observations.blockHash) {reasons.push("state-block-mismatch");}
  if (!state.token || state.token.address !== tokenOperation?.expectedAddress || state.token.name !== "Agent Teams AI" || state.token.symbol !== "AGTMAI" || state.token.decimals !== "9" || state.token.initialSupply !== "100000000000000000" || state.token.totalSupply !== "100000000000000000" || state.token.genesisAllocationHash !== expectedGenesisAllocationHash || state.token.ccipAdmin !== configuredToken?.initialCCIPAdmin) {reasons.push("token-state-mismatch");}
  if (!founderOperation || state.founderReserve.address !== founderOperation.expectedAddress || state.founderReserve.vault !== founderOperation.nestedAddress || state.founderVault.address !== founderOperation.nestedAddress || state.founderReserve.token !== tokenOperation?.expectedAddress || state.founderVault.token !== tokenOperation?.expectedAddress || state.founderVault.originalReserve !== founderOperation.expectedAddress) {reasons.push("founder-getter-mismatch");}
  validateFounderTerms(reserveGenesis, state, reasons);
  validateController(reserveGenesis, controllerOperation, tokenOperation, state, reasons);
  validateAllocations(deployment, state, reasons);
  validateFunding(reserveGenesis, expectations, observations, state, reasons);
  const observedBalance = state.allocations.reduce((sum, allocation) => sum + BigInt(allocation.balance), 0n) + BigInt(state.funding.vaultAfter);
  if (state.conservation.totalSupplyBaseUnits !== state.token.totalSupply || state.conservation.observedBalancesBaseUnits !== observedBalance.toString() || observedBalance !== 100000000000000000n) {reasons.push("supply-conservation-mismatch");}
  if (state.controller.grossCommitted !== "0" || state.controller.rollingCommitted !== "0") {reasons.push("controller-counters-nonzero");}
}
function validateFounderTerms(reserveGenesis: Record<string, unknown> | undefined, state: NonNullable<ProductionObservation["state"]>, reasons: string[]): void { const founder = reserveGenesis?.founder as Record<string, unknown> | undefined; const schedule = founder?.schedule as Record<string, unknown> | undefined; if (!founder || !schedule || state.founderVault.beneficiary !== founder.beneficiary || state.founderVault.controller !== founder.controller || state.founderVault.terms.allocation !== "3000000000000000" || state.founderVault.terms.start !== schedule.start || state.founderVault.terms.cliff !== schedule.cliff || state.founderVault.terms.end !== schedule.end || state.founderVault.terms.kind !== "0" || state.founderVault.terms.originalPurpose !== founder.purpose) {reasons.push("founder-terms-mismatch");} }
function validateController(reserveGenesis: Record<string, unknown> | undefined, controllerOperation: ProductionExpectations["operations"][number] | undefined, tokenOperation: ProductionExpectations["operations"][number] | undefined, state: NonNullable<ProductionObservation["state"]>, reasons: string[]): void { const contributors = reserveGenesis?.contributors as Record<string, unknown> | undefined; if (!controllerOperation || state.controller.address !== controllerOperation.expectedAddress || state.controller.token !== tokenOperation?.expectedAddress || !contributors || state.controller.controller !== contributors.controller || state.controller.purpose !== contributors.purpose || state.controller.rollingCap !== contributors.rollingCapBaseUnits || state.controller.perGrantCap !== contributors.perGrantCapBaseUnits || state.controller.window !== "31536000") {reasons.push("controller-policy-mismatch");} }
function validateAllocations(deployment: Record<string, unknown> | undefined, state: NonNullable<ProductionObservation["state"]>, reasons: string[]): void { const expected = [["long-term", "3000", "30000000000000000"], ["users", "3000", "30000000000000000"], ["founder", "300", "3000000000000000"], ["contributors", "1700", "17000000000000000"], ["operations", "900", "9000000000000000"], ["ecosystem", "500", "5000000000000000"], ["financing", "500", "5000000000000000"], ["liquidity", "100", "1000000000000000"]] as const; const configured = Array.isArray(deployment?.allocations) ? deployment.allocations as Record<string, unknown>[] : []; if (state.allocations.length !== expected.length || new Set(state.allocations.map(allocation => allocation.identifier)).size !== expected.length || expected.some(([id, bps, amount]) => {const actual = state.allocations.find(allocation => allocation.identifier === id); const source = configured.find(entry => entry.id === id); return !actual || !source || source.bps !== Number(bps) || actual.bps !== bps || actual.amountBaseUnits !== amount || actual.recipient !== source.recipient || actual.balance !== (id === "founder" ? "0" : amount) || actual.syntheticPreparedAddress !== true;})) {reasons.push("allocation-conservation-mismatch");} }
// oxlint-disable-next-line complexity -- every funding delta and its two receipt blocks are authoritative.
function validateFunding(reserveGenesis: Record<string, unknown> | undefined, expectations: ProductionExpectations, observations: ProductionObservation, state: NonNullable<ProductionObservation["state"]>, reasons: string[]): void { const expected = (reserveGenesis?.allocations as unknown[] | undefined)?.find(entry => (entry as Record<string, unknown>)?.id === "founder") as Record<string, unknown> | undefined; const funding = state.funding; const before = observations.operations[2], after = observations.operations[3]; if (expected && funding.amountBaseUnits !== expected.amountBaseUnits) {reasons.push("founder-funding-amount-mismatch");} if (funding.caller !== expectations.sender || funding.amountBaseUnits !== "3000000000000000" || funding.beforeBlockNumber !== before?.blockNumber || funding.beforeBlockHash !== before.blockHash || funding.afterBlockNumber !== after?.blockNumber || funding.afterBlockHash !== after.blockHash || funding.reserveBefore !== "3000000000000000" || funding.reserveAfter !== "0" || funding.vaultBefore !== "0" || funding.vaultAfter !== "3000000000000000" || funding.allowanceBefore !== "0" || funding.allowanceAfter !== "0" || funding.fundedBefore !== false || funding.fundedAfter !== true || state.founderVault.funded !== true || state.founderVault.funded !== funding.fundedAfter || funding.secondCallRejected !== true) {reasons.push("founder-funding-mismatch");} }

function maskRuntime(actual: string, template: string, refs: readonly { start: number; length: number }[]): string {
  if (!/^0x[0-9a-f]*$/.test(actual) || !/^0x[0-9a-f]*$/.test(template) || actual.length !== template.length) {return "";}
  const bytes = actual.slice(2).split("");
  for (const ref of refs) {for (let index = ref.start * 2; index < (ref.start + ref.length) * 2; index += 1) {if (index < bytes.length) {bytes[index] = template.slice(2)[index]!;}}}
  return bytes.join("");
}
function wordValue(value: string): string { if (/^0x[0-9a-f]{40}$/.test(value)) {return `0x${value.slice(2).padStart(64, "0")}`;} if (/^0x[0-9a-f]{64}$/.test(value)) {return value;} if (/^[0-9]+$/.test(value)) {return `0x${BigInt(value).toString(16).padStart(64, "0")}`;} return value; }
function immutableValue(id: string, name: string, state: NonNullable<ProductionObservation["state"]>): string | undefined {
  const values: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    "token-create": { INITIAL_SUPPLY: state.token.initialSupply, GENESIS_ALLOCATION_HASH: state.token.genesisAllocationHash, INITIAL_CCIP_ADMIN: state.token.ccipAdmin },
    "founder-reserve-create": { TOKEN: state.founderReserve.token, VAULT: state.founderReserve.vault },
    "controller-create": { TOKEN: state.controller.token, CONTROLLER: state.controller.controller, PURPOSE: state.controller.purpose, ROLLING_CAP: state.controller.rollingCap, PER_GRANT_CAP: state.controller.perGrantCap },
  };
  return values[id]?.[name];
}
function unique(values: readonly string[]): string[] {return [...new Set(values)];}

function validEnvelope(input: { request: ProductionPreflightRequest; prepared: Record<string, unknown> | null; expectations: Record<string, unknown> | null; operations: unknown; approval: boolean; artifacts: boolean }): boolean {
  const { request, prepared, expectations, operations, approval, artifacts } = input;
  const allocationHashValid = request.observations.schema !== "agtmai-production-observation-v2" || /^0x[0-9a-f]{64}$/.test(request.expectedGenesisAllocationHash ?? "");
  return prepared !== null && prepared.schema === "agtmai-prepared-production-deployment-v1" && prepared.broadcastAllowed === false && prepared.coverage === "token-and-reserves-only" && allocationHashValid && prepared.configurationSha256 === request.preparedConfigurationSha256 && prepared.reserveConfigurationSha256 === request.preparedReserveConfigurationSha256 && request.preparedArtifactPinsSha256 === request.expectations.artifactPinsSha256 && prepared.configurationSha256 === request.expectations.configurationSha256 && prepared.reserveConfigurationSha256 === request.expectations.reserveConfigurationSha256 && expectations !== null && Array.isArray(operations) && approval && artifacts;
}

function validApproval(approval: Record<string, unknown> | null, prepared: Record<string, unknown> | null): boolean {
  return approval !== null && approval !== undefined && prepared !== null && prepared !== undefined && Object.keys(approval).toSorted().join() === "configurationSha256,reference,reserveConfigurationSha256,schema" && approval.schema === "agtmai-production-approval-v1" && typeof approval.reference === "string" && approval.configurationSha256 === prepared.configurationSha256 && approval.reserveConfigurationSha256 === prepared.reserveConfigurationSha256;
}

function runtimeStatus(runtime: Record<string, unknown> | undefined, contracts: unknown, artifacts: Record<string, unknown>[]): { valid: boolean; hasImmutables: boolean } {
  const identities = artifacts.map(value => ({ contract: value.contract, compilerVersion: value.compilerVersion, compilerInputSha256: value.compilerInputSha256, immutableReferences: value.immutableReferences }));
  const hasImmutables = identities.some(identity => Array.isArray(identity.immutableReferences) && identity.immutableReferences.length > 0);
  return { valid: validRuntime(runtime, contracts, identities, hasImmutables), hasImmutables };
}

function approvedPolicy(prepared: Record<string, unknown>): ApprovedProductionPolicy | undefined {
  const configuration = prepared.configuration as Record<string, unknown> | undefined;
  const deployment = configuration?.deployment as Record<string, unknown> | undefined;
  const reserveGenesis = configuration?.reserveGenesis as Record<string, unknown> | undefined;
  const policy = deployment?.policy as Record<string, unknown> | undefined;
  const schedule = (reserveGenesis?.founder as Record<string, unknown> | undefined)?.schedule as Record<string, unknown> | undefined;
  const allocations = reserveGenesis?.allocations;
  const founderAllocation = Array.isArray(allocations) ? allocations.find(entry => (entry as Record<string, unknown>)?.id === "founder") as Record<string, unknown> | undefined : undefined;
  return policy && typeof schedule?.start === "string" && typeof founderAllocation?.amountBaseUnits === "string" ? { ...policy, founderStart: schedule.start, tokenExpenditureBaseUnits: founderAllocation.amountBaseUnits } as unknown as ApprovedProductionPolicy : undefined;
}

function validArtifacts(artifacts: unknown): boolean {
  if (!Array.isArray(artifacts) || artifacts.length !== 3) {return false;}
  return artifacts.every(artifact => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {return false;}
    const value = artifact as Record<string, unknown>;
    const hashes = [value.artifactSha256, value.buildInfoSha256, value.compilerInputSha256].every(item => typeof item === "string" && /^0x[0-9a-f]{64}$/.test(item));
    const references = Array.isArray(value.immutableReferences) ? value.immutableReferences as Record<string, unknown>[] : [];
    const refs = references.every((reference, index) => reference !== null && typeof reference === "object" && !Array.isArray(reference) && Object.keys(reference).toSorted().join() === "length,name,start" && typeof reference.name === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(reference.name) && Number.isSafeInteger(reference.start) && (reference.start as number) >= 0 && reference.length === 32 && (index === 0 || (reference.start as number) >= (references[index - 1]!.start as number) + 32));
    return Object.keys(value).toSorted().join() === "artifactSha256,buildInfoSha256,compilerInputSha256,compilerVersion,contract,creationBytecode,immutableReferences,runtimeBytecode" && ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController"].includes(value.contract as string) && value.compilerVersion === "0.8.36" && hashes && typeof value.creationBytecode === "string" && typeof value.runtimeBytecode === "string" && refs;
  });
}

function preparedOperationInventoryMatches(actual: unknown[], embedded: Record<string, unknown> | null, expected: readonly { readonly id: string; readonly kind: string; readonly intentHash: string; readonly nonce?: string; readonly expectedAddress?: string; readonly nestedAddress?: string; readonly initcode?: string; readonly calldata?: string; readonly value?: string }[]): { inventory: boolean; binding: boolean } {
  const embeddedOperations = Array.isArray(embedded?.operations) ? embedded.operations : [];
  if (actual.length !== expected.length || embeddedOperations.length !== expected.length) {return { inventory: false, binding: false };}
  const binding = expected.every((operation, index) => {
    const selected = embeddedOperations[index];
    const wanted = operation.kind === "create" ? { id: operation.id, kind: operation.kind, intentHash: operation.intentHash, nonce: operation.nonce, expectedAddress: operation.expectedAddress, ...(operation.nestedAddress === undefined ? {} : { nestedAddress: operation.nestedAddress }), initcode: operation.initcode, value: operation.value } : { id: operation.id, kind: operation.kind, intentHash: operation.intentHash, nonce: operation.nonce, to: operation.expectedAddress, calldata: operation.calldata, value: operation.value };
    const selectedRecord = selected && typeof selected === "object" ? selected as Record<string, unknown> : undefined;
    const selectedComparable = operation.kind === "create" && selectedRecord ? { id: selectedRecord.id, kind: selectedRecord.kind, intentHash: selectedRecord.intentHash, nonce: selectedRecord.nonce, expectedAddress: selectedRecord.expectedAddress, ...((operation.nestedAddress === undefined) ? {} : { nestedAddress: selectedRecord.nestedAddress }), initcode: selectedRecord.initcode, value: selectedRecord.value } : operation.kind === "call" && selectedRecord ? { id: selectedRecord.id, kind: selectedRecord.kind, intentHash: selectedRecord.intentHash, nonce: selectedRecord.nonce, to: selectedRecord.to ?? selectedRecord.expectedAddress, calldata: selectedRecord.calldata, value: selectedRecord.value } : undefined;
    return selected !== undefined && canonicalOperation(actual[index]) === canonicalOperation(wanted) && canonicalOperation(selectedComparable) === canonicalOperation(wanted);
  });
  return { inventory: true, binding };
}

function canonicalOperation(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value)));
}

function validRuntime(runtime: Record<string, unknown> | undefined, contracts: unknown, identities: unknown, hasImmutables: boolean): boolean {
  if (!runtime || !Array.isArray(contracts) || canonicalJson(contracts) !== canonicalJson(identities)) {return false;}
  return hasImmutables ? runtime.status === "unresolved-immutables" && runtime.reason === "PRODUCTION_RUNTIME_IMMUTABLES_REQUIRE_DETERMINISTIC_LOCAL_EXECUTION" : runtime.status === "exact-static-runtime" && runtime.reason === null;
}
