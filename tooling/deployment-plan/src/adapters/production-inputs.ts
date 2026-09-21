import type { GrantTermsObservation, ProductionAttempt, ProductionExpectations, ProductionObservation, ProductionOperationObservation, SafeState } from "../domain/production-guards.ts";

const reject = (code: string): never => { throw new Error(`PREFLIGHT_${code}`); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : reject("OBJECT");
const keys = (value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): void => {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {reject("SCHEMA");}
};
const mapArray = (value: unknown, mapper: (value: unknown) => unknown): unknown[] => {
  const values = Array.isArray(value) ? value : reject("ARRAY");
  return values.map(mapper);
};
const optional = (value: unknown, check: (value: unknown) => boolean): void => { if (value !== undefined && !check(value)) {reject("VALUE");} };
const stringValue = (value: unknown): value is string => typeof value === "string";
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const bytes = (value: unknown): value is string => typeof value === "string" && /^0x(?:[0-9a-f]{2})+$/.test(value);
const safe = (value: unknown): SafeState => {
  const item = record(value);
  keys(item, ["address", "owners", "threshold", "nonce", "proxyCodeHash", "singletonCodeHash", "singletonAddress", "singletonSlot", "modules", "guard", "fallbackHandler", "setupProvenance"], ["address", "owners", "threshold", "nonce", "proxyCodeHash", "singletonCodeHash", "singletonAddress", "singletonSlot", "modules", "guard", "fallbackHandler", "setupProvenance"]);
  return item as unknown as SafeState;
};

export function parseProductionExpectations(input: unknown): ProductionExpectations {
  const value = record(input);
  keys(value, ["schema", "chainId", "sender", "deployer", "configurationSha256", "reserveConfigurationSha256", "sourceRevision", "artifactPinsSha256", "startingNonce", "maxObservationAgeSeconds", "operations", "maxTotalCostWei", "attemptIdentity", "authority"], ["schema", "chainId", "sender", "deployer", "configurationSha256", "reserveConfigurationSha256", "sourceRevision", "artifactPinsSha256", "startingNonce", "maxObservationAgeSeconds", "operations", "maxTotalCostWei", "attemptIdentity", "authority"]);
  mapArray(value.authority, safe);
  mapArray(value.operations, operation => {
    const item = record(operation);
    const common = ["id", "kind", "intentHash", "nonce", "expectedAddress", "gasEstimate", "gasLimit", "baseFeePerGas", "maxPriorityFeePerGas", "maxFeePerGas", "blockGasLimit", "value"];
    const allowed = item.kind === "call" ? [...common, "calldata"] : item.id === "founder-reserve-create" ? [...common, "nestedAddress", "initcode", "initcodeHash", "runtime", "runtimeHash"] : [...common, "initcode", "initcodeHash", "runtime", "runtimeHash"];
    keys(item, allowed, allowed);
    if (!stringValue(item.id) || !stringValue(item.kind) || !digest(item.intentHash)) {reject("VALUE");}
    optional(item.nonce, decimal); optional(item.expectedAddress, address); optional(item.nestedAddress, address); optional(item.initcode, bytes); optional(item.initcodeHash, digest); optional(item.runtime, bytes); optional(item.runtimeHash, digest); optional(item.calldata, bytes);
    for (const field of ["gasEstimate", "gasLimit", "baseFeePerGas", "maxPriorityFeePerGas", "maxFeePerGas", "blockGasLimit", "value"]) {if (!decimal(item[field])) {reject("VALUE");}}
    return item;
  });
  return value as unknown as ProductionExpectations;
}

// oxlint-disable-next-line complexity -- the strict boundary rejects the complete closed observation shape.
export function parseProductionObservation(input: unknown): ProductionObservation {
  const value = record(input);
  const v2 = value.schema !== undefined;
  keys(value, ["schema", "chainId", "sender", "pendingNonce", "blockNumber", "blockHash", "observedAt", "expiresAt", "observedTotalCostWei", "rpcEndpoint", "netVersion", "binding", "operations", "checkedAddresses", "occupiedAddresses", "authority", "state", "cleanup"], ["chainId", "sender", "pendingNonce", "blockNumber", "blockHash", "observedAt", "expiresAt", "operations", "checkedAddresses", "occupiedAddresses", "authority", ...(v2 ? ["schema", "observedTotalCostWei", "rpcEndpoint", "netVersion", "binding", "state", "cleanup"] : [])]);
  if (v2 && value.schema !== "agtmai-production-observation-v2") {reject("VALUE");}
  if (!stringValue(value.chainId) || (v2 && value.chainId !== "1") || !address(value.sender) || !decimal(value.pendingNonce) || !decimal(value.blockNumber) || !digest(value.blockHash) || !decimal(value.observedAt) || !decimal(value.expiresAt) || (v2 && !decimal(value.observedTotalCostWei))) {reject("VALUE");}
  if (v2 && (typeof value.rpcEndpoint !== "string" || !/^http:\/\/127[.]0[.]0[.]1:[1-9][0-9]{0,4}\/$/.test(value.rpcEndpoint) || value.netVersion !== "1")) {reject("VALUE");}
  if (v2) { parseBinding(value.binding); parseState(value.state); parseCleanup(value.cleanup); }
  mapArray(value.authority, safe);
  const checkedAddresses = mapArray(value.checkedAddresses, address);
  if (checkedAddresses.some(entry => entry !== true)) {reject("VALUE");}
  const occupiedAddresses = mapArray(value.occupiedAddresses, address);
  if (occupiedAddresses.some(entry => entry !== true)) {reject("VALUE");}
  // oxlint-disable-next-line complexity -- each operation kind is closed and validated in one boundary pass.
  const operations = mapArray(value.operations, operation => {
    const item = record(operation);
    const common = ["id", "address", "nestedAddress", "value", "nonce", "transactionHash", "receiptTransactionHash", "transactionIndex", "sender", "input", "status", "blockNumber", "blockHash", "timestamp", "expectedAddress", "actualAddress", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "gasUsed", "effectiveGasPrice", "observedCostWei"];
    const allowed = item.id === "founder-fund" ? [...common, "calldata"] : [...common, "creation", "runtime", "runtimeHash", "artifact", "artifactSha256", "immutableReferences"];
    const required = v2 ? [...common.filter(field => field !== "nestedAddress"), ...(item.id === "founder-fund" ? ["calldata"] : ["creation", "runtime", "runtimeHash", "artifact", "artifactSha256", "immutableReferences"])] : [];
    keys(item, allowed, required);
    if (!stringValue(item.id)) {reject("VALUE");} optional(item.address, address); optional(item.nestedAddress, address); optional(item.creation, bytes); optional(item.runtime, bytes); optional(item.runtimeHash, digest); optional(item.calldata, bytes); optional(item.value, decimal); optional(item.nonce, decimal);
    if (v2) {
      if (!address(item.sender) || !digest(item.transactionHash) || !digest(item.receiptTransactionHash) || item.transactionHash !== item.receiptTransactionHash || !decimal(item.transactionIndex) || !bytes(item.input) || item.status !== "1" || !decimal(item.blockNumber) || !digest(item.blockHash) || !decimal(item.timestamp) || !address(item.expectedAddress) || (item.actualAddress !== null && !address(item.actualAddress)) || item.expectedAddress !== item.address || item.actualAddress !== item.address || item.input !== (item.creation ?? item.calldata) || ![item.gasLimit, item.maxFeePerGas, item.maxPriorityFeePerGas, item.gasUsed, item.effectiveGasPrice, item.observedCostWei].every(decimal)) {reject("VALUE");}
      optional(item.artifact, bytes); optional(item.artifactSha256, digest);
      if (item.id !== "founder-fund") {mapArray(item.immutableReferences, reference => { const ref = record(reference); keys(ref, ["name", "start", "length", "value"], ["name", "start", "length", "value"]); if (typeof ref.name !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(ref.name) || !decimal(ref.start) || ref.length !== "32" || !bytes(ref.value) || ref.value.length !== 66) {reject("VALUE");} return ref; });}
    }
    return item as unknown as ProductionOperationObservation;
  });
  if (v2 && operations.map(operation => (operation as Record<string, unknown>).id).join(",") !== "token-create,founder-reserve-create,controller-create,founder-fund") {reject("VALUE");}
  return value as unknown as ProductionObservation;
}

function parseBinding(value: unknown): void {
  const item = record(value); keys(item, ["sourceRevision", "configurationSha256", "reserveConfigurationSha256", "artifactPinsSha256"], ["sourceRevision", "configurationSha256", "reserveConfigurationSha256", "artifactPinsSha256"]);
  if (typeof item.sourceRevision !== "string" || !/^[0-9a-f]{40}$/.test(item.sourceRevision) || !digest(item.configurationSha256) || !digest(item.reserveConfigurationSha256) || !digest(item.artifactPinsSha256)) {reject("VALUE");}
}
function parseTerms(value: unknown): GrantTermsObservation {
  const item = record(value); keys(item, ["allocation", "start", "cliff", "end", "kind", "originalPurpose"], ["allocation", "start", "cliff", "end", "kind", "originalPurpose"]);
  if (![item.allocation, item.start, item.cliff, item.end].every(decimal) || !stringValue(item.kind) || !digest(item.originalPurpose)) {reject("VALUE");} return item as unknown as GrantTermsObservation;
}
// oxlint-disable-next-line complexity -- strict v2 observation schema validates each block-bound fact in one pass.
function parseState(value: unknown): void {
  const item = record(value); keys(item, ["blockNumber", "blockHash", "token", "founderReserve", "founderVault", "controller", "allocations", "funding", "conservation"], ["blockNumber", "blockHash", "token", "founderReserve", "founderVault", "controller", "allocations", "funding", "conservation"]);
  if (!decimal(item.blockNumber) || !digest(item.blockHash)) {reject("VALUE");}
  const token = record(item.token); keys(token, ["address", "name", "symbol", "decimals", "initialSupply", "totalSupply", "genesisAllocationHash", "ccipAdmin"], ["address", "name", "symbol", "decimals", "initialSupply", "totalSupply", "genesisAllocationHash", "ccipAdmin"]); if (!address(token.address) || !stringValue(token.name) || !stringValue(token.symbol) || !decimal(token.decimals) || !decimal(token.initialSupply) || !decimal(token.totalSupply) || !digest(token.genesisAllocationHash) || !address(token.ccipAdmin)) {reject("VALUE");}
  const reserve = record(item.founderReserve); keys(reserve, ["address", "token", "vault"], ["address", "token", "vault"]); if (!address(reserve.address) || !address(reserve.token) || !address(reserve.vault)) {reject("VALUE");}
  const vault = record(item.founderVault); keys(vault, ["address", "token", "beneficiary", "originalReserve", "controller", "funded", "terms"], ["address", "token", "beneficiary", "originalReserve", "controller", "funded", "terms"]); if (!address(vault.address) || !address(vault.token) || !address(vault.beneficiary) || !address(vault.originalReserve) || !address(vault.controller) || typeof vault.funded !== "boolean") {reject("VALUE");} parseTerms(vault.terms);
  const controller = record(item.controller); keys(controller, ["address", "token", "controller", "purpose", "rollingCap", "perGrantCap", "window", "grossCommitted", "rollingCommitted"], ["address", "token", "controller", "purpose", "rollingCap", "perGrantCap", "window", "grossCommitted", "rollingCommitted"]); if (![controller.address, controller.token, controller.controller].every(address) || !digest(controller.purpose) || ![controller.rollingCap, controller.perGrantCap, controller.window, controller.grossCommitted, controller.rollingCommitted].every(decimal)) {reject("VALUE");}
  mapArray(item.allocations, allocation => { const a = record(allocation); keys(a, ["identifier", "bps", "amountBaseUnits", "recipient", "balance", "syntheticPreparedAddress"], ["identifier", "bps", "amountBaseUnits", "recipient", "balance", "syntheticPreparedAddress"]); if (!stringValue(a.identifier) || !decimal(a.bps) || !decimal(a.amountBaseUnits) || !address(a.recipient) || !decimal(a.balance) || a.syntheticPreparedAddress !== true) {reject("VALUE");} return a; });
  const funding = record(item.funding); keys(funding, ["caller", "amountBaseUnits", "beforeBlockNumber", "beforeBlockHash", "afterBlockNumber", "afterBlockHash", "reserveBefore", "reserveAfter", "vaultBefore", "vaultAfter", "allowanceBefore", "allowanceAfter", "fundedBefore", "fundedAfter", "secondCallRejected"], ["caller", "amountBaseUnits", "beforeBlockNumber", "beforeBlockHash", "afterBlockNumber", "afterBlockHash", "reserveBefore", "reserveAfter", "vaultBefore", "vaultAfter", "allowanceBefore", "allowanceAfter", "fundedBefore", "fundedAfter", "secondCallRejected"]); if (!address(funding.caller) || ![funding.amountBaseUnits, funding.beforeBlockNumber, funding.afterBlockNumber, funding.reserveBefore, funding.reserveAfter, funding.vaultBefore, funding.vaultAfter, funding.allowanceBefore, funding.allowanceAfter].every(decimal) || !digest(funding.beforeBlockHash) || !digest(funding.afterBlockHash) || funding.fundedBefore !== false || funding.fundedAfter !== true || funding.secondCallRejected !== true) {reject("VALUE");}
  const conservation = record(item.conservation); keys(conservation, ["totalSupplyBaseUnits", "observedBalancesBaseUnits"], ["totalSupplyBaseUnits", "observedBalancesBaseUnits"]); if (!decimal(conservation.totalSupplyBaseUnits) || !decimal(conservation.observedBalancesBaseUnits)) {reject("VALUE");}
}
function parseCleanup(value: unknown): void { const item = record(value); keys(item, ["processExited", "exitCode", "descriptorsClosed", "temporaryRootRemoved", "diagnostic"], ["processExited", "exitCode", "descriptorsClosed", "temporaryRootRemoved", "diagnostic"]); if (item.processExited !== true || !decimal(item.exitCode) || item.descriptorsClosed !== true || item.temporaryRootRemoved !== true || (item.diagnostic !== null && typeof item.diagnostic !== "string")) {reject("VALUE");} }

export function parseProductionAttempt(input: unknown): ProductionAttempt {
  const value = record(input);
  keys(value, ["schema", "identity", "states"], ["schema", "identity", "states"]);
  mapArray(value.states, state => { const item = record(state); keys(item, ["operationId", "state", "intent"], ["operationId", "state", "intent"]); if (!stringValue(item.operationId) || !["unattempted", "pending", "uncertain", "finalized-success", "finalized-revert"].includes(item.state as string) || !digest(item.intent)) {reject("VALUE");} return item; });
  return value as unknown as ProductionAttempt;
}
