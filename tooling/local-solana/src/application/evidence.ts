import { CLASSIC_TOKEN_PROGRAM, LIFECYCLE, LocalSolanaError, type EvidenceReport } from "../domain/model.ts";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/u;
const INTEGER = /^(?:0|[1-9][0-9]*)$/u;

/** Runtime counterpart of evidence-report.schema.v1.json, invoked immediately before READY. */
export function assertEvidenceReport(value: unknown): asserts value is EvidenceReport {
  const root = record(value, "evidence report");
  exactKeys(root, ["schemaVersion", "status", "identity", "programId", "decimals", "testAmountBaseUnits", "initialSupply", "intermediateSupply", "finalSupply", "freezeAuthority", "payerAddress", "mintAddress", "tokenAccountAddress", "ownerAddress", "mintAuthority", "formerFreezeAuthority", "genesisHash", "validatorVersion", "rpcListener", "snapshots", "transactions", "assertions"], "evidence report");
  validateHeader(root);
  validateSnapshots(root.snapshots);
  validateTransactions(root.transactions);
  validateAssertions(root.assertions);
}

function validateHeader(root: Record<string, unknown>): void {
  assertValid(root.schemaVersion === 1 && root.status === "READY" && root.programId === CLASSIC_TOKEN_PROGRAM && root.decimals === 9, "header");
  const identity = record(root.identity, "identity"); exactKeys(identity, ["name", "symbol"], "identity"); assertValid(identity.name === "Agent Teams AI" && identity.symbol === "AGTMAI", "identity");
  assertValid(root.testAmountBaseUnits === "1000000000000" && root.initialSupply === "0" && root.intermediateSupply === "1000000000000" && root.finalSupply === "0" && root.freezeAuthority === null, "supply constants");
  for (const key of ["payerAddress", "mintAddress", "tokenAccountAddress", "ownerAddress", "mintAuthority", "formerFreezeAuthority", "genesisHash"] as const) { assertValid(typeof root[key] === "string" && ADDRESS.test(root[key]), key); }
  assertValid(typeof root.validatorVersion === "string" && root.validatorVersion.length > 0, "validatorVersion");
  const rpcListener = record(root.rpcListener, "rpcListener"); exactKeys(rpcListener, ["scope"], "rpcListener");
  assertValid(typeof rpcListener.scope === "string" && ["ipv4-loopback", "ipv6-loopback", "wildcard"].includes(rpcListener.scope), "rpcListener.scope");
}

function validateSnapshots(value: unknown): void {
  const snapshots = record(value, "snapshots"); exactKeys(snapshots, ["initialMint", "afterRevokeMint", "afterMint", "afterMintTokenAccount", "finalMint", "finalTokenAccount"], "snapshots");
  for (const key of ["initialMint", "afterRevokeMint", "afterMint", "finalMint"] as const) { validateMintSnapshot(snapshots[key], key); }
  for (const key of ["afterMintTokenAccount", "finalTokenAccount"] as const) { validateTokenSnapshot(snapshots[key], key); }
}

function validateTransactions(value: unknown): void {
  if (!Array.isArray(value) || value.length !== LIFECYCLE.length) { invalid("transactions must contain the exact seven-step tuple"); }
  value.forEach((item, index) => validateTransaction(item, LIFECYCLE[index] as string));
}

function validateAssertions(value: unknown): void {
  const assertions = record(value, "assertions");
  exactKeys(assertions, ["exactLoopbackRpc", "productionAuthorityProven", "ccip", "publicNetwork", "realAssetCostUsd", "mintAuthorityRevoked", "authorityKeyRetained", "remintPossibleUntilTeardown", "productionHardCapProven", "signedRestoreReachedTokenProgramAndFailed", "signedFreezeReachedTokenProgramAndFailed"], "assertions");
  assertValid(assertions.exactLoopbackRpc === true && assertions.productionAuthorityProven === false && assertions.ccip === false && assertions.publicNetwork === false && assertions.realAssetCostUsd === 0
    && assertions.mintAuthorityRevoked === false && assertions.authorityKeyRetained === false && assertions.remintPossibleUntilTeardown === true
    && assertions.productionHardCapProven === false && assertions.signedRestoreReachedTokenProgramAndFailed === true && assertions.signedFreezeReachedTokenProgramAndFailed === true, "assertions");
}

function validateMintSnapshot(value: unknown, label: string): void {
  const root = record(value, label); exactKeys(root, ["address", "programOwner", "decimals", "supply", "mintAuthority", "freezeAuthority"], label);
  assertValid(typeof root.address === "string" && ADDRESS.test(root.address) && root.programOwner === CLASSIC_TOKEN_PROGRAM && root.decimals === 9 && typeof root.supply === "string" && INTEGER.test(root.supply), label);
  for (const key of ["mintAuthority", "freezeAuthority"] as const) { assertValid(root[key] === null || (typeof root[key] === "string" && ADDRESS.test(root[key])), `${label}.${key}`); }
}
function validateTokenSnapshot(value: unknown, label: string): void {
  const root = record(value, label); exactKeys(root, ["address", "mint", "owner", "amount"], label);
  assertValid([root.address, root.mint, root.owner].every((item) => typeof item === "string" && ADDRESS.test(item)) && typeof root.amount === "string" && INTEGER.test(root.amount), label);
}
function validateTransaction(value: unknown, operation: string): void {
  const root = record(value, `transaction ${operation}`); exactKeys(root, ["operation", "signature", "slot", "confirmationStatus", "error", "signers", "accountKeys", "instructions", "innerInstructionGroups", "genesisHash"], `transaction ${operation}`);
  validateTransactionHeader(root, operation);
  if (!Array.isArray(root.accountKeys) || !root.accountKeys.every((item) => typeof item === "string" && ADDRESS.test(item))) { invalid(`${operation} account keys`); }
  validateInnerInstructionGroups(root.innerInstructionGroups, operation);
  if (!Array.isArray(root.signers) || !root.signers.every((item) => typeof item === "string" && ADDRESS.test(item))) { invalid(`${operation} signers`); }
  if (!Array.isArray(root.instructions) || root.instructions.length === 0) { invalid(`${operation} instructions`); }
  root.instructions.forEach((item) => validateInstruction(item));
  validateTransactionError(root.error);
}
function validateTransactionHeader(root: Record<string, unknown>, operation: string): void {
  assertValid(root.operation === operation && typeof root.signature === "string" && SIGNATURE.test(root.signature) && typeof root.slot === "string" && INTEGER.test(root.slot)
    && root.confirmationStatus === "finalized" && typeof root.genesisHash === "string" && ADDRESS.test(root.genesisHash), `transaction ${operation}`);
}
function validateInnerInstructionGroups(value: unknown, operation: string): void {
  if (!Array.isArray(value) || !value.every((item) => { const group = record(item, "inner instruction group"); exactKeys(group, ["groupIndex", "outerInstructionIndex"], "inner instruction group"); return Number.isSafeInteger(group.groupIndex) && Number.isSafeInteger(group.outerInstructionIndex); })) { invalid(`${operation} inner instruction groups`); }
}
function validateTransactionError(value: unknown): void {
  if (value === null) { return; }
  const error = record(value, "transaction error"); exactKeys(error, ["instructionIndex", "code"], "transaction error");
  assertValid(typeof error.instructionIndex === "number" && Number.isSafeInteger(error.instructionIndex) && error.instructionIndex >= 0 && typeof error.code === "string" && error.code.length > 0, "transaction error");
}
function validateInstruction(value: unknown): void {
  const root = record(value, "instruction"); exactKeys(root, ["programId", "programIdIndex", "instructionIndex", "innerInstructionIndex", "innerGroupIndex", "kind", "accounts", "accountIndices", "dataHex", "mint", "tokenAccount", "owner", "newAccount", "authority", "newAuthority", "authorityType", "amountBaseUnits", "decimals"], "instruction");
  validateInstructionIdentity(root);
  for (const key of ["mint", "tokenAccount", "owner", "newAccount", "authority", "newAuthority"] as const) { assertValid(root[key] === null || (typeof root[key] === "string" && ADDRESS.test(root[key])), `instruction.${key}`); }
  assertValid(root.authorityType === null || typeof root.authorityType === "string", "instruction.authorityType");
  assertValid(root.amountBaseUnits === null || (typeof root.amountBaseUnits === "string" && INTEGER.test(root.amountBaseUnits)), "instruction.amountBaseUnits");
  assertValid(root.decimals === null || (typeof root.decimals === "number" && Number.isSafeInteger(root.decimals) && root.decimals >= 0), "instruction.decimals");
}
function validateInstructionIdentity(root: Record<string, unknown>): void {
  assertValid(typeof root.programId === "string" && ADDRESS.test(root.programId), "instruction.programId");
  assertValid(typeof root.programIdIndex === "number" && Number.isSafeInteger(root.programIdIndex) && root.programIdIndex >= 0, "instruction.programIdIndex");
  assertValid(typeof root.instructionIndex === "number" && Number.isSafeInteger(root.instructionIndex) && root.instructionIndex >= 0, "instruction.instructionIndex");
  assertValid(root.innerInstructionIndex === null || (typeof root.innerInstructionIndex === "number" && Number.isSafeInteger(root.innerInstructionIndex) && root.innerInstructionIndex >= 0), "instruction.innerInstructionIndex");
  assertValid(root.innerGroupIndex === null || (typeof root.innerGroupIndex === "number" && Number.isSafeInteger(root.innerGroupIndex) && root.innerGroupIndex >= 0), "instruction.innerGroupIndex");
  assertValid(typeof root.kind === "string" && root.kind.length > 0, "instruction.kind");
  assertValid(Array.isArray(root.accountIndices) && root.accountIndices.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0), "instruction.accountIndices");
  assertValid(typeof root.dataHex === "string" && /^(?:[0-9a-f]{2})*$/u.test(root.dataHex), "instruction.dataHex");
  assertValid(Array.isArray(root.accounts) && root.accounts.every((item) => typeof item === "string" && ADDRESS.test(item)), "instruction.accounts");
}
function record(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) { invalid(`${label} must be an object`); } return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void { const actual = Object.keys(value).toSorted(); const expected = keys.toSorted(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) { invalid(`${label} has unexpected or missing fields`); } }
function assertValid(condition: boolean, label: string): asserts condition { if (!condition) { invalid(`${label} is invalid`); } }
function invalid(message: string): never { throw new LocalSolanaError("SOLANA_EVIDENCE_SCHEMA", message); }
