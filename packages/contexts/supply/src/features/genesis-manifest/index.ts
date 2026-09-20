export { ALLOCATION_DOMAIN, EXPECTED_TOKEN, UINT64_MAX, UINT256_MAX, encodeAllocationId, normalizeLocalSource, parseCanonicalUint } from "./domain/model.js";
export type { Diagnostic, LocalGenesisManifest, LocalGenesisSource, NormalizedAllocation } from "./domain/model.js";
export { canonicalJson } from "./application/canonical.js";
export { encodeAllocationCommitment } from "./adapters/abi.js";
export { sha256 } from "./adapters/digest.js";
export { parseLocalSource, parseProposal } from "./adapters/strict-source.js";
export { validateReserveGenesis, type ReserveGenesis } from "./domain/reserve-genesis.js";
export { verifyReserveFacts, type ReserveFactsPorts } from "./application/reserve-facts.js";
