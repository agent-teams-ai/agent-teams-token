export const ALLOCATION_DOMAIN = "0x4147544d41495f414c4c4f434154494f4e5f5631000000000000000000000000" as const;
export const EXPECTED_TOKEN = Object.freeze({ name: "Agent Teams AI", symbol: "AGTMAI", decimals: 9 });
export const UINT256_MAX = (1n << 256n) - 1n;
export const UINT64_MAX = (1n << 64n) - 1n;
export interface SourcePosition { readonly line: number; readonly column: number; readonly offset: number }
export interface Diagnostic { readonly code: string; readonly severity: "error"; readonly pointer: string; readonly message: string; readonly position?: SourcePosition }
export interface SourceAllocation { readonly id: string; readonly recipient: string; readonly amountBaseUnits: string; readonly bps?: number }
export interface LocalGenesisSource {
  readonly schemaVersion: 1; readonly purpose: "local-fixture"; readonly status: "test-only";
  readonly network: { readonly kind: "local-evm"; readonly chainId: string };
  readonly token: { readonly name: string; readonly symbol: string; readonly decimals: number; readonly initialSupplyBaseUnits: string };
  readonly allocations: readonly SourceAllocation[];
}
export interface NormalizedAllocation { readonly id: string; readonly idBytes32: `0x${string}`; readonly recipient: `0x${string}`; readonly amountBaseUnits: string; readonly bps?: number }
export interface LocalGenesisManifest {
  readonly schemaVersion: 1; readonly purpose: "local-fixture-artifact"; readonly status: "test-only";
  readonly network: { readonly kind: "local-evm"; readonly chainId: string };
  readonly token: typeof EXPECTED_TOKEN & { readonly initialSupplyBaseUnits: string };
  readonly allocations: readonly NormalizedAllocation[]; readonly sourceSha256: `0x${string}`;
  readonly rawAllocationAbi: `0x${string}`; readonly genesisAllocationHash: `0x${string}`;
  readonly tool: { readonly name: "@agent-teams/supply"; readonly feature: "genesis-manifest"; readonly version: "1" };
  readonly localFixtureArtifactSha256: `0x${string}`;
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
export function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return compareText(left.pointer, right.pointer) || compareText(left.code, right.code) || (left.position?.offset ?? -1) - (right.position?.offset ?? -1) || compareText(left.message, right.message);
}
export function parseCanonicalUint(text: unknown, max = UINT256_MAX): bigint | undefined {
  if (typeof text !== "string" || !/^(0|[1-9][0-9]*)$/.test(text)) {return undefined;}
  const value = BigInt(text); return value <= max ? value : undefined;
}
export function encodeAllocationId(id: unknown): `0x${string}` | undefined {
  if (typeof id !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(id)) {return undefined;}
  const bytes = new Uint8Array(32);
  for (let index = 0; index < id.length; index += 1) { const code = id.charCodeAt(index); if (code > 0x7f || code === 0) {return undefined;} bytes[index] = code; }
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function error(code: string, pointer: string, message: string): Diagnostic { return { code, severity: "error", pointer, message }; }
export function normalizeLocalSource(value: LocalGenesisSource): { diagnostics: Diagnostic[]; allocations?: NormalizedAllocation[] } {
  const diagnostics: Diagnostic[] = [], seenIds = new Set<string>(), seenRecipients = new Set<string>();
  let sum = 0n, bpsSum = 0, hasBps = false; const allocations: NormalizedAllocation[] = [];
  const supply = parseCanonicalUint(value.token.initialSupplyBaseUnits);
  if (supply === undefined || supply === 0n) {diagnostics.push(error("GENESIS_AMOUNT_INVALID", "/token/initialSupplyBaseUnits", "must be a positive canonical uint256 decimal string"));}
  else if (supply > UINT64_MAX) {diagnostics.push(error("GENESIS_SPL_SUPPLY_OVERFLOW", "/token/initialSupplyBaseUnits", "must fit the selected SPL-compatible uint64 profile"));}
  if (parseCanonicalUint(value.network.chainId) === undefined) {diagnostics.push(error("GENESIS_CHAIN_ID_INVALID", "/network/chainId", "must be a canonical uint256 decimal string"));}
  if (value.network.chainId !== "31337" || value.network.kind !== "local-evm") {diagnostics.push(error("GENESIS_NETWORK_MISMATCH", "/network", "local fixtures are restricted to local-evm chain 31337"));}
  if (value.purpose !== "local-fixture" || value.status !== "test-only") {diagnostics.push(error("GENESIS_PURPOSE_STATUS_MISMATCH", "", "only purpose local-fixture with status test-only is compilable"));}
  if (value.token.name !== EXPECTED_TOKEN.name || value.token.symbol !== EXPECTED_TOKEN.symbol || value.token.decimals !== EXPECTED_TOKEN.decimals) {diagnostics.push(error("GENESIS_TOKEN_PROFILE_MISMATCH", "/token", "token identity must match the AGTMAI local profile"));}
  if (!Array.isArray(value.allocations) || value.allocations.length < 1 || value.allocations.length > 32) {
    diagnostics.push(error("GENESIS_ALLOCATION_COUNT_INVALID", "/allocations", "must contain 1 through 32 allocations"));
  }
  value.allocations.forEach((allocation, index) => {
    const pointer = `/allocations/${index}`, idBytes32 = encodeAllocationId(allocation.id), recipient = allocation.recipient, amount = parseCanonicalUint(allocation.amountBaseUnits);
    if (!idBytes32) {diagnostics.push(error("GENESIS_ID_INVALID", `${pointer}/id`, "must be 1-31 lowercase ASCII [a-z0-9-] and start/end alphanumeric"));}
    else if (seenIds.has(idBytes32)) {diagnostics.push(error("GENESIS_ID_DUPLICATE", `${pointer}/id`, "duplicate encoded allocation id"));} else {seenIds.add(idBytes32);}
    if (typeof recipient !== "string" || !/^0x[0-9a-f]{40}$/.test(recipient)) {diagnostics.push(error("GENESIS_RECIPIENT_INVALID", `${pointer}/recipient`, "must be lowercase 0x plus 40 hex digits"));}
    else if (/^0x0{40}$/.test(recipient)) {diagnostics.push(error("GENESIS_RECIPIENT_ZERO", `${pointer}/recipient`, "zero address is forbidden"));}
    else if (seenRecipients.has(recipient)) {diagnostics.push(error("GENESIS_RECIPIENT_DUPLICATE", `${pointer}/recipient`, "duplicate 20-byte recipient"));}
    else if (!/^0x0{36}100[1-9]$/.test(recipient)) {diagnostics.push(error("GENESIS_RECIPIENT_NOT_ALLOWLISTED", `${pointer}/recipient`, "recipient is outside the local test address allowlist"));} else {seenRecipients.add(recipient);}
    if (amount === undefined || amount === 0n) {diagnostics.push(error("GENESIS_AMOUNT_INVALID", `${pointer}/amountBaseUnits`, "must be a positive canonical uint256 decimal string"));} else {sum += amount;}
    if (allocation.bps !== undefined) { hasBps = true; if (!Number.isInteger(allocation.bps) || allocation.bps < 0 || allocation.bps > 10_000) {diagnostics.push(error("GENESIS_BPS_INVALID", `${pointer}/bps`, "must be an integer from 0 through 10000"));} else {bpsSum += allocation.bps;} }
    if (supply !== undefined && amount !== undefined && allocation.bps !== undefined && Number.isInteger(allocation.bps) && amount * 10_000n !== supply * BigInt(allocation.bps)) {diagnostics.push(error("GENESIS_BPS_AMOUNT_MISMATCH", `${pointer}/bps`, "bps verification does not exactly match the authoritative base-unit amount"));}
    if (idBytes32 && /^0x[0-9a-f]{40}$/.test(recipient) && amount !== undefined && amount > 0n) {allocations.push({ id: allocation.id, idBytes32, recipient: recipient as `0x${string}`, amountBaseUnits: amount.toString(), ...(allocation.bps === undefined ? {} : { bps: allocation.bps }) });}
  });
  if (supply !== undefined && sum !== supply) {diagnostics.push(error("GENESIS_ALLOCATION_SUM_MISMATCH", "/allocations", `allocation sum ${sum} does not equal initial supply ${supply}`));}
  if (hasBps && (value.allocations.some((entry) => entry.bps === undefined) || bpsSum !== 10_000)) {diagnostics.push(error("GENESIS_BPS_SUM_MISMATCH", "/allocations", "when present, bps are required on every allocation and must sum to 10000"));}
  allocations.sort((left, right) => compareText(left.idBytes32, right.idBytes32)); diagnostics.sort(compareDiagnostics);
  return diagnostics.length ? { diagnostics } : { diagnostics, allocations };
}
