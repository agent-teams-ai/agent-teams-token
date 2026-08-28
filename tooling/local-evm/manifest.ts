import { basename, dirname } from "node:path";
import { canonicalJson, keccak256, sha256, strip0x } from "./crypto.ts";
import { APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256, LocalEvmError, type ConstructorInputs, type LocalManifest } from "./model.ts";
import { readRegularFile } from "./safe-fs.ts";

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const MANIFEST_KEYS = ["allocations", "genesisAllocationHash", "localFixtureArtifactSha256", "network", "purpose", "rawAllocationAbi", "schemaVersion", "sourceSha256", "status", "token", "tool"];

export async function readApprovedManifest(
  manifestPath: string,
  readyPath: string,
  approvedArtifactSha256: `0x${string}`,
): Promise<{ manifest: LocalManifest; bytes: Buffer }> {
  if (approvedArtifactSha256 !== APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256) {
    throw new LocalEvmError("VERIFY_APPROVED_ARTIFACT_MISMATCH", "artifact digest is not the separately pinned committed local fixture");
  }
  if (basename(manifestPath) !== "manifest.json" || basename(readyPath) !== "READY" || dirname(manifestPath) !== dirname(readyPath)) {
    throw new LocalEvmError("VERIFY_ARTIFACT_LAYOUT_INVALID", "manifest and READY must have their exact names in one directory");
  }
  if (basename(dirname(manifestPath)) !== strip0x(approvedArtifactSha256)) {
    throw new LocalEvmError("VERIFY_ARTIFACT_DIRECTORY_DIGEST_MISMATCH", "artifact directory is not content addressed by the approved digest");
  }
  const [bytes, readyBytes] = await Promise.all([
    readRegularFile(manifestPath, "MANIFEST"),
    readRegularFile(readyPath, "READY"),
  ]);
  const value = parseJson(bytes, "VERIFY_MANIFEST_JSON_INVALID");
  assertManifest(value);
  const manifest = value as unknown as LocalManifest;
  if (manifest.localFixtureArtifactSha256 !== approvedArtifactSha256) {
    throw new LocalEvmError("VERIFY_APPROVED_ARTIFACT_MISMATCH", "manifest is not the separately selected approved artifact");
  }
  const ready = parseJson(readyBytes, "VERIFY_READY_JSON_INVALID");
  if (!isRecord(ready) || !exactKeys(ready, ["localFixtureArtifactSha256", "sourceSha256"])
    || ready.localFixtureArtifactSha256 !== approvedArtifactSha256 || ready.sourceSha256 !== manifest.sourceSha256) {
    throw new LocalEvmError("VERIFY_READY_MISMATCH", "READY is stale, partial, or does not approve this artifact");
  }
  const canonicalBytes = Buffer.from(canonicalJson(manifest), "utf8");
  if (!bytes.equals(canonicalBytes)) {throw new LocalEvmError("VERIFY_MANIFEST_NOT_CANONICAL", "manifest bytes are not canonical JSON");}
  const { localFixtureArtifactSha256: _digest, ...withoutDigest } = manifest;
  const computed = sha256(Buffer.concat([
    Buffer.from("AGTMAI_LOCAL_FIXTURE_ARTIFACT_V1\0", "ascii"),
    Buffer.from(canonicalJson(withoutDigest), "utf8"),
  ]));
  if (computed !== approvedArtifactSha256) {throw new LocalEvmError("VERIFY_MANIFEST_DIGEST_MISMATCH", "approved artifact digest does not match its bytes");}
  const rawAbi = encodeAllocationCommitment(manifest);
  if (rawAbi !== manifest.rawAllocationAbi) {throw new LocalEvmError("VERIFY_ALLOCATION_ABI_MISMATCH", "manifest raw allocation ABI is not independently reproducible");}
  if (keccak256(rawAbi) !== manifest.genesisAllocationHash) {
    throw new LocalEvmError("VERIFY_ALLOCATION_HASH_MISMATCH", "manifest allocation hash is not the Keccak-256 of the independently reproduced ABI");
  }
  return { manifest, bytes };
}

export function constructorInputsFromManifest(manifest: LocalManifest): ConstructorInputs {
  return {
    schemaVersion: 1,
    initialSupplyBaseUnits: manifest.token.initialSupplyBaseUnits,
    allocations: manifest.allocations.map(({ idBytes32, recipient, amountBaseUnits }) => ({ idBytes32, recipient, amountBaseUnits })),
  };
}

export function assertConstructorInputs(value: unknown, manifest: LocalManifest): asserts value is ConstructorInputs {
  if (!isRecord(value) || !exactKeys(value, ["allocations", "initialSupplyBaseUnits", "schemaVersion"])
    || value.schemaVersion !== 1 || value.initialSupplyBaseUnits !== manifest.token.initialSupplyBaseUnits
    || !Array.isArray(value.allocations) || value.allocations.length !== manifest.allocations.length) {
    throw new LocalEvmError("VERIFY_CONSTRUCTOR_INPUTS_MISMATCH", "constructor inputs do not match the approved manifest");
  }
  for (const [index, expected] of constructorInputsFromManifest(manifest).allocations.entries()) {
    const actual = value.allocations[index];
    if (!isRecord(actual) || !exactKeys(actual, ["amountBaseUnits", "idBytes32", "recipient"])
      || actual.idBytes32 !== expected.idBytes32 || actual.recipient !== expected.recipient || actual.amountBaseUnits !== expected.amountBaseUnits) {
      throw new LocalEvmError("VERIFY_CONSTRUCTOR_INPUTS_MISMATCH", `constructor allocation ${index} does not match the approved manifest`);
    }
  }
}

export function encodeAllocationCommitment(manifest: LocalManifest): `0x${string}` {
  const words = [
    "4147544d41495f414c4c4f434154494f4e5f5631000000000000000000000000",
    BigInt(manifest.network.chainId).toString(16).padStart(64, "0"),
    "c9c783aec84b864926fc3f1a31f0eb38007b88e0302ca51c49409664d54679e",
    "7b615d1628f56132d749a4b7665073bd2fc455bf558d529109f96e1d9741f1dc5",
    BigInt(manifest.token.decimals).toString(16).padStart(64, "0"),
    BigInt(manifest.token.initialSupplyBaseUnits).toString(16).padStart(64, "0"),
    (7n * 32n).toString(16).padStart(64, "0"),
    BigInt(manifest.allocations.length).toString(16).padStart(64, "0"),
  ];
  for (const allocation of manifest.allocations) {
    words.push(strip0x(allocation.idBytes32));
    words.push(strip0x(allocation.recipient).padStart(64, "0"));
    words.push(BigInt(allocation.amountBaseUnits).toString(16).padStart(64, "0"));
  }
  return `0x${words.join("")}`;
}

function assertManifest(value: unknown): asserts value is LocalManifest {
  assertManifestHeader(value);
  const network = value.network;
  const token = value.token;
  const tool = value.tool;
  assertNetwork(network);
  assertToken(token);
  assertTool(tool);
  assertManifestDigests(value);
  if (!Array.isArray(value.allocations) || value.allocations.length < 1 || value.allocations.length > 32) {
    throw new LocalEvmError("VERIFY_MANIFEST_ALLOCATIONS_INVALID", "manifest allocations are invalid");
  }
  let previous = "";
  let sum = 0n;
  let bpsSum = 0;
  let hasBps = false;
  const recipients = new Set<string>();
  for (const allocation of value.allocations) {
    assertAllocation(allocation, previous, recipients);
    previous = String(allocation.idBytes32);
    recipients.add(String(allocation.recipient));
    const amount = BigInt(String(allocation.amountBaseUnits));
    sum += amount;
    if (allocation.bps !== undefined) {
      const bps = assertBps(allocation.bps, amount, String(token.initialSupplyBaseUnits));
      hasBps = true;
      bpsSum += bps;
    }
  }
  if (sum !== BigInt(String(token.initialSupplyBaseUnits))) {throw new LocalEvmError("VERIFY_MANIFEST_SUPPLY_MISMATCH", "allocation sum differs from supply");}
  if (hasBps && (value.allocations.some((entry) => !isRecord(entry) || entry.bps === undefined) || bpsSum !== 10_000)) {
    throw new LocalEvmError("VERIFY_MANIFEST_BPS_SUM_MISMATCH", "bps must be present on every allocation and sum exactly to 10000");
  }
}

function assertManifestHeader(value: unknown): asserts value is Record<string, unknown> {
  const valid = isRecord(value) && exactKeys(value, MANIFEST_KEYS)
    && value.schemaVersion === 1 && value.purpose === "local-fixture-artifact" && value.status === "test-only";
  if (!valid) {throw new LocalEvmError("VERIFY_MANIFEST_PROFILE_INVALID", "artifact is not an explicit test-only local fixture");}
}

function assertNetwork(value: unknown): asserts value is Record<string, unknown> {
  const valid = isRecord(value) && exactKeys(value, ["chainId", "kind"])
    && value.kind === "local-evm" && value.chainId === "31337";
  if (!valid) {throw new LocalEvmError("VERIFY_MANIFEST_NETWORK_INVALID", "manifest network must be local-evm chain 31337");}
}

function assertToken(value: unknown): asserts value is Record<string, unknown> {
  const valid = isRecord(value) && exactKeys(value, ["decimals", "initialSupplyBaseUnits", "name", "symbol"])
    && value.name === "Agent Teams AI" && value.symbol === "AGTMAI" && value.decimals === 9
    && UINT.test(String(value.initialSupplyBaseUnits));
  if (!valid) {throw new LocalEvmError("VERIFY_MANIFEST_TOKEN_INVALID", "manifest token profile is invalid");}
}

function assertTool(value: unknown): void {
  const valid = isRecord(value) && exactKeys(value, ["feature", "name", "version"])
    && value.name === "@agent-teams/supply" && value.feature === "genesis-manifest" && value.version === "1";
  if (!valid) {throw new LocalEvmError("VERIFY_MANIFEST_TOOL_INVALID", "manifest compiler identity is invalid");}
}

function assertManifestDigests(value: Record<string, unknown>): void {
  const valid = HASH.test(String(value.sourceSha256)) && HASH.test(String(value.genesisAllocationHash))
    && HASH.test(String(value.localFixtureArtifactSha256)) && /^0x(?:[0-9a-f]{2})+$/.test(String(value.rawAllocationAbi));
  if (!valid) {throw new LocalEvmError("VERIFY_MANIFEST_DIGESTS_INVALID", "manifest digest fields are malformed");}
}

function assertAllocation(value: unknown, previous: string, recipients: ReadonlySet<string>): asserts value is Record<string, unknown> {
  const keys = isRecord(value) && value.bps === undefined
    ? ["amountBaseUnits", "id", "idBytes32", "recipient"]
    : ["amountBaseUnits", "bps", "id", "idBytes32", "recipient"];
  const valid = isRecord(value) && exactKeys(value, keys) && typeof value.id === "string"
    && encodeAllocationId(value.id) === value.idBytes32 && ADDRESS.test(String(value.recipient))
    && UINT.test(String(value.amountBaseUnits)) && BigInt(String(value.amountBaseUnits)) > 0n
    && String(value.idBytes32) > previous && !recipients.has(String(value.recipient));
  if (!valid) {throw new LocalEvmError("VERIFY_MANIFEST_ALLOCATIONS_INVALID", "manifest allocations are not canonical and strictly sorted");}
}

function assertBps(value: unknown, amount: bigint, supply: string): number {
  const valid = typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
  if (!valid) {throw new LocalEvmError("VERIFY_MANIFEST_BPS_INVALID", "allocation bps is outside the integer 0..10000 range");}
  if (amount * 10_000n !== BigInt(supply) * BigInt(value)) {
    throw new LocalEvmError("VERIFY_MANIFEST_BPS_AMOUNT_MISMATCH", "allocation bps does not exactly match its authoritative amount");
  }
  return value;
}

function encodeAllocationId(id: string): string | undefined {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(id)) {return undefined;}
  const bytes = Buffer.alloc(32);
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index);
    if (code === 0 || code > 0x7f) {return undefined;}
    bytes[index] = code;
  }
  return `0x${bytes.toString("hex")}`;
}

function parseJson(bytes: Uint8Array, code: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new LocalEvmError(code, "invalid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}
