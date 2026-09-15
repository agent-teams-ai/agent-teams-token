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
declare const validatedLocalGenesisSourceBrand: unique symbol;
export type ValidatedLocalGenesisSource = LocalGenesisSource & {
  readonly [validatedLocalGenesisSourceBrand]: "strict-local-genesis-source";
};
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
  if (typeof text !== "string" || text.length > 78 || !/^(0|[1-9][0-9]*)$/.test(text)) {return undefined;}
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
  const diagnostics: Diagnostic[] = [];
  validateSourceProfile(value, diagnostics);
  const normalized = normalizeAllocationSet(value.token.initialSupplyBaseUnits, value.allocations, "local-fixture");
  const all = [...diagnostics, ...normalized.diagnostics].toSorted(compareDiagnostics);
  return all.length ? { diagnostics: all } : normalized;
}

export function normalizeAllocationSet(supplyText: string, sourceAllocations: readonly SourceAllocation[], recipientProfile: "local-fixture" | "deployment"): { diagnostics: Diagnostic[]; allocations?: NormalizedAllocation[] } {
  const diagnostics: Diagnostic[] = [];
  const allocations: NormalizedAllocation[] = [];
  const seenIds = new Set<string>();
  const seenRecipients = new Set<string>();
  if (!Array.isArray(sourceAllocations)) { return { diagnostics: [error("GENESIS_ALLOCATION_COUNT_INVALID", "/allocations", "must contain 1 through 32 allocations")] }; }
  const supply = parseCanonicalUint(supplyText, UINT64_MAX);
  if (supply === undefined || supply === 0n) {diagnostics.push(error("GENESIS_AMOUNT_INVALID", "/token/initialSupplyBaseUnits", "must be a positive canonical uint64 decimal string"));}
  if (sourceAllocations.length < 1 || sourceAllocations.length > 32) {
    diagnostics.push(error("GENESIS_ALLOCATION_COUNT_INVALID", "/allocations", "must contain 1 through 32 allocations"));
  }
  let sum = 0n;
  let bpsSum = 0;
  let hasBps = false;
  for (const [index, allocation] of sourceAllocations.entries()) {
    const pointer = `/allocations/${index}`;
    const idBytes32 = validateAllocationId(allocation.id, pointer, seenIds, diagnostics);
    const recipient = validateRecipient(allocation.recipient, pointer, seenRecipients, diagnostics, recipientProfile);
    const amount = validateAmount(allocation.amountBaseUnits, pointer, diagnostics);
    const bps = validateBps(allocation.bps, supply, amount, pointer, diagnostics);
    sum += amount ?? 0n;
    hasBps ||= allocation.bps !== undefined;
    bpsSum += bps ?? 0;
    if (idBytes32 && recipient && amount) {
      allocations.push({
        id: allocation.id,
        idBytes32,
        recipient,
        amountBaseUnits: amount.toString(),
        ...(allocation.bps === undefined ? {} : { bps: allocation.bps }),
      });
    }
  }
  if (supply !== undefined && sum !== supply) {diagnostics.push(error("GENESIS_ALLOCATION_SUM_MISMATCH", "/allocations", `allocation sum ${sum} does not equal initial supply ${supply}`));}
  if (hasBps && (sourceAllocations.some((entry) => entry.bps === undefined) || bpsSum !== 10_000)) {diagnostics.push(error("GENESIS_BPS_SUM_MISMATCH", "/allocations", "when present, bps are required on every allocation and must sum to 10000"));}
  const orderedDiagnostics = diagnostics.toSorted(compareDiagnostics);
  return orderedDiagnostics.length > 0
    ? { diagnostics: orderedDiagnostics }
    : { diagnostics: orderedDiagnostics, allocations: allocations.toSorted((left, right) => compareText(left.idBytes32, right.idBytes32)) };
}

function validateSourceProfile(value: LocalGenesisSource, diagnostics: Diagnostic[]): bigint | undefined {
  const supply = parseCanonicalUint(value.token.initialSupplyBaseUnits);
  if (supply === undefined || supply === 0n) {diagnostics.push(error("GENESIS_AMOUNT_INVALID", "/token/initialSupplyBaseUnits", "must be a positive canonical uint256 decimal string"));}
  else if (supply > UINT64_MAX) {diagnostics.push(error("GENESIS_SPL_SUPPLY_OVERFLOW", "/token/initialSupplyBaseUnits", "must fit the selected SPL-compatible uint64 profile"));}
  if (parseCanonicalUint(value.network.chainId) === undefined) {diagnostics.push(error("GENESIS_CHAIN_ID_INVALID", "/network/chainId", "must be a canonical uint256 decimal string"));}
  if (value.network.chainId !== "31337" || value.network.kind !== "local-evm") {diagnostics.push(error("GENESIS_NETWORK_MISMATCH", "/network", "local fixtures are restricted to local-evm chain 31337"));}
  if (value.purpose !== "local-fixture" || value.status !== "test-only") {diagnostics.push(error("GENESIS_PURPOSE_STATUS_MISMATCH", "", "only purpose local-fixture with status test-only is compilable"));}
  if (value.token.name !== EXPECTED_TOKEN.name || value.token.symbol !== EXPECTED_TOKEN.symbol || value.token.decimals !== EXPECTED_TOKEN.decimals) {diagnostics.push(error("GENESIS_TOKEN_PROFILE_MISMATCH", "/token", "token identity must match the AGTMAI local profile"));}
  return supply;
}

function validateAllocationId(id: string, pointer: string, seen: Set<string>, diagnostics: Diagnostic[]): `0x${string}` | undefined {
  const encoded = encodeAllocationId(id);
  if (!encoded) {
    diagnostics.push(error("GENESIS_ID_INVALID", `${pointer}/id`, "must be 1-31 lowercase ASCII [a-z0-9-] and start/end alphanumeric"));
    return undefined;
  }
  if (seen.has(encoded)) {
    diagnostics.push(error("GENESIS_ID_DUPLICATE", `${pointer}/id`, "duplicate encoded allocation id"));
    return undefined;
  }
  seen.add(encoded);
  return encoded;
}

function validateRecipient(recipient: string, pointer: string, seen: Set<string>, diagnostics: Diagnostic[], profile: "local-fixture" | "deployment"): `0x${string}` | undefined {
  if (!/^0x[0-9a-f]{40}$/.test(recipient)) {
    diagnostics.push(error("GENESIS_RECIPIENT_INVALID", `${pointer}/recipient`, "must be lowercase 0x plus 40 hex digits"));
    return undefined;
  }
  if (/^0x0{40}$/.test(recipient)) {
    diagnostics.push(error("GENESIS_RECIPIENT_ZERO", `${pointer}/recipient`, "zero address is forbidden"));
    return undefined;
  }
  if (seen.has(recipient)) {
    diagnostics.push(error("GENESIS_RECIPIENT_DUPLICATE", `${pointer}/recipient`, "duplicate 20-byte recipient"));
    return undefined;
  }
  if (profile === "local-fixture" && !/^0x0{36}100[1-9]$/.test(recipient)) {
    diagnostics.push(error("GENESIS_RECIPIENT_NOT_ALLOWLISTED", `${pointer}/recipient`, "recipient is outside the local test address allowlist"));
    return undefined;
  }
  seen.add(recipient);
  return recipient as `0x${string}`;
}

function validateAmount(amountText: string, pointer: string, diagnostics: Diagnostic[]): bigint | undefined {
  const amount = parseCanonicalUint(amountText);
  if (amount === undefined || amount === 0n) {
    diagnostics.push(error("GENESIS_AMOUNT_INVALID", `${pointer}/amountBaseUnits`, "must be a positive canonical uint256 decimal string"));
    return undefined;
  }
  return amount;
}

function validateBps(bps: number | undefined, supply: bigint | undefined, amount: bigint | undefined, pointer: string, diagnostics: Diagnostic[]): number | undefined {
  if (bps === undefined) {return undefined;}
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    diagnostics.push(error("GENESIS_BPS_INVALID", `${pointer}/bps`, "must be an integer from 0 through 10000"));
    return undefined;
  }
  if (supply !== undefined && amount !== undefined && amount * 10_000n !== supply * BigInt(bps)) {
    diagnostics.push(error("GENESIS_BPS_AMOUNT_MISMATCH", `${pointer}/bps`, "bps verification does not exactly match the authoritative base-unit amount"));
  }
  return bps;
}
