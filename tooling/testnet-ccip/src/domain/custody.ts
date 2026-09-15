import { deploymentBytes, isDigest, isEvmAddress, parseCanonicalUint, UINT64_MAX, validateDeployment,
  type DeploymentGrant, type DeploymentManifest, type Hex, type DeploymentBlock } from "@agent-teams/supply/deployment";
import { canonicalCustodyIntent, type CustodyIntent, type CustodyOperation } from "./custody-intent.ts";

export interface CustodyGrantState {
  readonly grantId: string; readonly address: Hex; readonly token: Hex; readonly beneficiary: Hex;
  readonly reserve: Hex; readonly controller: Hex;
  readonly allocation: string; readonly start: string; readonly cliff: string; readonly end: string;
  readonly kind: "founder" | "team"; readonly originalPurpose: Hex;
  readonly funded: boolean; readonly initialized: boolean; readonly cancelled: boolean;
  readonly released: string; readonly frozenEntitlement: string; readonly lastTransition: string;
  readonly available: string; readonly allowance: string; readonly donations: string;
}
export interface CustodySnapshot {
  readonly schema: "agtmai-custody-snapshot-v1";
  readonly chainId: "31337" | "11155111"; readonly block: DeploymentBlock;
  readonly token: Hex; readonly totalSupply: string; readonly initialSupply: string;
  /** Complete unique-address inventory of the fresh custody-only deployment. */
  readonly balances: readonly { readonly address: Hex; readonly amount: string }[];
  readonly grants: readonly CustodyGrantState[];
}
export interface CustodyMovement { readonly from: Hex; readonly to: Hex; readonly amount: string }
export interface CustodyTransition {
  readonly operationId: string; readonly grantId: string; readonly operation: Exclude<CustodyOperation, "deploy-token" | "deploy-grant">;
  readonly intent: CustodyIntent; readonly transactionHash: Hex; readonly block: DeploymentBlock;
  readonly before: CustodySnapshot; readonly after: CustodySnapshot;
  /** Adapter authenticates these movements against exact native receipt logs. */
  readonly movements: readonly CustodyMovement[];
  readonly receiptStatus: 0 | 1; readonly safeResult: "success" | "failure" | null;
  readonly gasUsed: string; readonly effectiveGasPrice: string;
}
export interface CustodyTransitionResult {
  readonly operationId: string; readonly transactionHash: Hex; readonly grantId: string;
  readonly operation: CustodyTransition["operation"]; readonly timestamp: string;
  readonly released: string; readonly refunded: string; readonly vestedDebt: string;
  readonly remainingPrincipal: string; readonly donations: string; readonly feeWei: string;
  readonly proof: "finalized-transaction"; readonly founderRejection: boolean;
}
const fail = (reason: string): never => { throw new Error(`CUSTODY_${reason}`); };
const same = (a: unknown, b: unknown): boolean => new TextDecoder().decode(deploymentBytes(a)) === new TextDecoder().decode(deploymentBytes(b));
const uint = (value: string): bigint => parseCanonicalUint(value) ?? fail("INVALID_QUANTITY");
/** Independent verification curve. Contract time comes from the mined block, never wall-clock rescheduling. */
export function custodyVested(grant: DeploymentGrant, timestamp: string): bigint {
  const time = parseCanonicalUint(timestamp, UINT64_MAX), a = uint(grant.amountBaseUnits);
  const { cliff, end } = grant.schedule;
  if (time === undefined || uint(cliff) >= uint(end) || a === 0n) { return fail("INVALID_SCHEDULE"); }
  if (time <= BigInt(cliff)) { return 0n; }
  if (time >= BigInt(end)) { return a; }
  return a * (time - BigInt(cliff)) / (BigInt(end) - BigInt(cliff));
}
function inventoryAddresses(manifest: DeploymentManifest): Hex[] {
  const c = manifest.configuration;
  return [...new Set([...c.allocations.map(a => a.recipient as Hex), ...c.grants.map(g => g.beneficiary),
    ...manifest.grants.map(g => g.address)])].toSorted();
}
function validateBlock(block: DeploymentBlock): void {
  if (!isDigest(block.hash) || parseCanonicalUint(block.number) === undefined || parseCanonicalUint(block.timestamp, UINT64_MAX) === undefined) { fail("BLOCK_INVALID"); }
}
function immutableGrant(manifest: DeploymentManifest, state: CustodyGrantState): DeploymentGrant {
  const config = manifest.configuration, g = config.grants.find(item => item.id === state.grantId);
  const deployment = manifest.grants.find(item => item.grantId === state.grantId);
  if (!g || !deployment || state.address !== deployment.address || state.token !== manifest.token?.address
    || state.beneficiary !== g.beneficiary || state.reserve !== config.allocations.find(a => a.id === g.fundingAllocation)?.recipient
    || state.controller !== config.custodySafes.find(s => s.id === g.controllerSafe)?.address
    || state.allocation !== g.amountBaseUnits || state.start !== g.schedule.start || state.cliff !== g.schedule.cliff || state.end !== g.schedule.end
    || state.kind !== g.kind || state.originalPurpose !== g.originalPurpose || state.initialized !== true) { return fail("IMMUTABLE_BINDING"); }
  return g;
}
export function verifyCustodySnapshot(manifest: DeploymentManifest, snapshot: CustodySnapshot): void {
  const config = validateDeployment(manifest.configuration).value;
  if (!config) { return fail("CONFIGURATION_INVALID"); }
  if (config.environment.mode === "mainnet-dry-run" || !manifest.token || snapshot.schema !== "agtmai-custody-snapshot-v1"
    || snapshot.chainId !== config.environment.evmChainId || snapshot.token !== manifest.token.address
    || snapshot.initialSupply !== config.token.initialSupplyBaseUnits || snapshot.totalSupply !== config.token.initialSupplyBaseUnits) { fail("TOKEN_IDENTITY"); }
  validateBlock(snapshot.block);
  const addresses = inventoryAddresses(manifest), observed = snapshot.balances.map(b => b.address).toSorted();
  if (!same(addresses, observed) || snapshot.balances.some(b => !isEvmAddress(b.address))
    || snapshot.balances.reduce((sum, b) => sum + uint(b.amount), 0n) !== BigInt(config.token.initialSupplyBaseUnits)) { fail("INVENTORY_CONSERVATION"); }
  if (snapshot.grants.length !== manifest.grants.length || new Set(snapshot.grants.map(g => g.grantId)).size !== snapshot.grants.length) { fail("GRANT_COVERAGE"); }
  for (const state of snapshot.grants) { verifyGrantState(manifest, snapshot, state); }
}
function verifyGrantState(manifest: DeploymentManifest, snapshot: CustodySnapshot, state: CustodyGrantState): void {
  const g = immutableGrant(manifest, state), allocation = uint(state.allocation), released = uint(state.released), frozen = uint(state.frozenEntitlement);
  verifyGrantFlags(g, snapshot.block.timestamp, state);
  uint(state.allowance);
  const entitlement = state.cancelled ? frozen : custodyVested(g, snapshot.block.timestamp);
  const refund = state.cancelled ? allocation - frozen : 0n;
  if (frozen > allocation || released > entitlement || (!state.cancelled && frozen !== 0n) || (state.cancelled && frozen !== custodyVested(g, state.lastTransition))
    || (!state.funded && (released !== 0n || state.cancelled || state.lastTransition !== "0"))
    || uint(state.available) !== (state.funded ? entitlement - released : 0n)) { fail("GRANT_ACCOUNTING"); }
  const remaining = state.funded ? allocation - released - refund : 0n;
  const balance = snapshot.balances.find(b => b.address === state.address);
  if (!balance || uint(balance.amount) !== remaining + uint(state.donations)) { fail("PRINCIPAL_CONSERVATION"); }
}
function verifyGrantFlags(g: DeploymentGrant, timestamp: string, state: CustodyGrantState): void {
  if (typeof state.funded !== "boolean" || typeof state.cancelled !== "boolean" || uint(state.lastTransition) > uint(timestamp)
    || uint(state.lastTransition) > UINT64_MAX || (state.cancelled && g.kind !== "team")) { fail("GRANT_STATE"); }
}
export function custodyNextAction(g: DeploymentGrant, state: CustodyGrantState, timestamp: string, founderRejected: boolean): CustodyTransition["operation"] | "wait" | "complete" {
  const t = uint(timestamp), a = uint(g.amountBaseUnits);
  if (!state.funded) {
    if (t > uint(g.schedule.start)) { return fail("FUNDING_DEADLINE_MISSED"); }
    if (uint(state.allowance) > a) { return fail("EXCESS_ALLOWANCE"); }
    return uint(state.allowance) === a ? "fund" : "approve";
  }
  if (g.kind === "founder") {
    if (!founderRejected) { return "reject-founder-cancel"; }
    return uint(state.released) > 0n ? "complete" : uint(state.available) > 0n ? "release" : "wait";
  }
  if (state.cancelled) { return uint(state.available) > 0n ? "claim-debt" : "complete"; }
  const vested = custodyVested(g, timestamp), released = uint(state.released);
  if (vested >= a) { return fail("POSITIVE_CANCELLATION_WINDOW_MISSED"); }
  if (released === 0n) { return vested > 0n ? "release" : "wait"; }
  return vested > released ? "cancel-team" : "wait";
}
function bindTransition(manifest: DeploymentManifest, t: CustodyTransition): { before: CustodyGrantState; after: CustodyGrantState; grant: DeploymentGrant } {
  canonicalCustodyIntent(t.intent);
  verifyCustodySnapshot(manifest, t.before); verifyCustodySnapshot(manifest, t.after); validateBlock(t.block);
  const before = t.before.grants.find(g => g.grantId === t.grantId), after = t.after.grants.find(g => g.grantId === t.grantId);
  if (!before || !after || !isDigest(t.transactionHash) || !same(t.block, t.after.block)
    || BigInt(t.block.number) !== BigInt(t.before.block.number) + 1n || BigInt(t.block.timestamp) < BigInt(t.before.block.timestamp)
    || t.intent.operationId !== t.operationId || t.intent.operation !== t.operation || t.intent.configurationSha256 !== manifest.configurationSha256) { return fail("TRANSITION_BINDING"); }
  if (t.before.grants.some(g => g.grantId !== t.grantId && !same({ ...g, available: "0" }, { ...t.after.grants.find(a => a.grantId === g.grantId), available: "0" }))) { fail("UNRELATED_GRANT_CHANGE"); }
  if (before.donations !== after.donations) { fail("UNATTRIBUTED_DONATION"); }
  return { before, after, grant: immutableGrant(manifest, after) };
}
interface ExpectedTransition { readonly state: CustodyGrantState; readonly movement: CustodyMovement | null; readonly founderRejection: boolean }
const movement = (from: Hex, to: Hex, amount: bigint): CustodyMovement => ({ from, to, amount: amount.toString() });
function expectedTransition(t: CustodyTransition, g: DeploymentGrant, before: CustodyGrantState): ExpectedTransition {
  if (t.operation === "approve" || t.operation === "fund") { return expectedFunding(t, g, before); }
  if (!before.funded) { return fail("NOT_FUNDED"); }
  if (t.operation === "release" || t.operation === "claim-debt") { return expectedRelease(t, g, before); }
  return expectedCancellation(t, g, before);
}
function expectedFunding(t: CustodyTransition, g: DeploymentGrant, before: CustodyGrantState): ExpectedTransition {
  const a = uint(g.amountBaseUnits), vested = custodyVested(g, t.block.timestamp), state = { ...before }, intent = t.intent;
  if (t.operation === "approve") {
    if (before.funded || intent.from !== before.reserve || intent.to !== before.token || uint(before.allowance) > a) { fail("APPROVAL_POLICY"); }
    if (intent.data !== "0x095ea7b3" + before.address.slice(2).padStart(64, "0") + a.toString(16).padStart(64, "0")) { fail("CALLDATA_MISMATCH"); }
    state.allowance = g.amountBaseUnits;
    return { state, movement: null, founderRejection: false };
  }
  if (t.operation === "fund") {
    if (before.funded || intent.from !== before.reserve || intent.to !== before.address || uint(before.allowance) !== a || uint(t.block.timestamp) > uint(g.schedule.start)) { fail("FUNDING_POLICY"); }
    if (intent.data !== "0xb60d4288") { fail("CALLDATA_MISMATCH"); }
    state.funded = true; state.allowance = "0"; state.available = vested.toString();
    return { state, movement: movement(before.reserve, before.address, a), founderRejection: false };
  }
  return fail("UNEXPECTED_OPERATION");
}
function expectedRelease(t: CustodyTransition, g: DeploymentGrant, before: CustodyGrantState): ExpectedTransition {
  const vested = custodyVested(g, t.block.timestamp), state = { ...before }, intent = t.intent;
  if (!before.funded) { fail("NOT_FUNDED"); }
  if (["release", "claim-debt"].includes(t.operation)) {
    const entitlement = before.cancelled ? uint(before.frozenEntitlement) : vested, amount = entitlement - uint(before.released);
    if (intent.from !== before.beneficiary || intent.to !== before.address || amount <= 0n || (t.operation === "claim-debt" && !before.cancelled)) { fail("RELEASE_POLICY"); }
    if (intent.data !== "0x86d1a69f") { fail("CALLDATA_MISMATCH"); }
    state.released = entitlement.toString(); state.available = "0"; state.lastTransition = t.block.timestamp;
    return { state, movement: movement(before.address, before.beneficiary, amount), founderRejection: false };
  }
  return fail("UNEXPECTED_OPERATION");
}
function expectedCancellation(t: CustodyTransition, g: DeploymentGrant, before: CustodyGrantState): ExpectedTransition {
  const a = uint(g.amountBaseUnits), vested = custodyVested(g, t.block.timestamp), state = { ...before }, intent = t.intent;
  if (intent.to !== before.controller || intent.safe?.to !== before.address || before.cancelled) { fail("CONTROLLER_POLICY"); }
  if (t.operation === "reject-founder-cancel") {
    if (g.kind !== "founder" || t.safeResult !== "failure") { fail("FOUNDER_REJECTION_UNPROVEN"); }
    state.available = (vested - uint(before.released)).toString();
    return { state, movement: null, founderRejection: true };
  }
  if (t.operation !== "cancel-team" || g.kind !== "team" || uint(before.released) === 0n || vested <= uint(before.released) || vested >= a) { fail("POSITIVE_CANCELLATION_REQUIRED"); }
  state.cancelled = true; state.frozenEntitlement = vested.toString(); state.lastTransition = t.block.timestamp;
  state.available = (vested - uint(before.released)).toString();
  return { state, movement: movement(before.address, before.reserve, a - vested), founderRejection: false };
}
/** Native receipt authentication is separate. This independently proves time, role and token arithmetic. */
export function verifyCustodyTransition(manifest: DeploymentManifest, t: CustodyTransition): CustodyTransitionResult {
  const { before, after, grant } = bindTransition(manifest, t);
  const expected = expectedTransition(t, grant, before);
  if (t.receiptStatus !== 1 || (t.intent.safe !== null && t.safeResult !== (expected.founderRejection ? "failure" : "success"))
    || (t.intent.safe === null && t.safeResult !== null) || !same(after, expected.state)
    || !same(t.movements, expected.movement ? [expected.movement] : [])) { fail("TRANSITION_EFFECT_MISMATCH"); }
  for (const b of t.before.balances) {
    const m = expected.movement, delta = m === null ? 0n : (b.address === m.to ? uint(m.amount) : 0n) - (b.address === m.from ? uint(m.amount) : 0n);
    if (uint(t.after.balances.find(a => a.address === b.address)!.amount) - uint(b.amount) !== delta) { fail("TOKEN_MOVEMENT_MISMATCH"); }
  }
  const refunded = after.cancelled ? uint(after.allocation) - uint(after.frozenEntitlement) : 0n;
  if (uint(t.gasUsed) === 0n) { fail("RECEIPT_GAS_INVALID"); }
  return { operationId: t.operationId, transactionHash: t.transactionHash, grantId: t.grantId, operation: t.operation,
    timestamp: t.block.timestamp, released: after.released, refunded: refunded.toString(), vestedDebt: after.available,
    remainingPrincipal: (after.funded ? uint(after.allocation) - uint(after.released) - refunded : 0n).toString(),
    donations: after.donations, feeWei: (uint(t.gasUsed) * uint(t.effectiveGasPrice)).toString(), proof: "finalized-transaction", founderRejection: expected.founderRejection };
}
