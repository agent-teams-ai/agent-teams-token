import {
  ASSOCIATED_TOKEN_PROGRAM,
  CLASSIC_TOKEN_PROGRAM,
  FIXTURE_AMOUNT_BASE_UNITS,
  FIXTURE_DECIMALS,
  LIFECYCLE,
  LocalSolanaError,
  SYSTEM_PROGRAM,
  isExactLoopbackRpcUrl,
  parseUnsignedInteger,
  type EvidenceReport,
  type FixtureObservations,
  type InstructionFact,
  type LifecycleKind,
  type TransactionFact,
} from "../domain/model.ts";

const EXPECTED_DISABLED_FREEZE_ERROR = "Custom(16)";

export function verifyObservations(value: FixtureObservations): EvidenceReport {
  if (value.schemaVersion !== 1) { fail("SOLANA_EVIDENCE_SCHEMA", "unsupported observation schema"); }
  if (!isExactLoopbackRpcUrl(value.rpcUrl)) { fail("SOLANA_RPC_NOT_EXACT_LOOPBACK", "observations must come from the canonical loopback RPC boundary"); }
  if (!["ipv4-loopback", "ipv6-loopback", "wildcard"].includes(value.rpcListener.scope)) { fail("SOLANA_RPC_LISTENER_SCOPE", "validator listener scope is not an allowed authenticated fact"); }
  if (value.genesisHashBefore !== value.genesisHashAfter) { fail("SOLANA_GENESIS_CHANGED", "validator genesis changed during the fixture"); }
  verifyMintStates(value);
  verifySupply(value);
  verifyTokenAccountIdentity(value);
  verifyTransactions(value);
  return evidence(value);
}

function verifyMintStates(value: FixtureObservations): void {
  for (const state of [value.initialMint, value.afterRevokeMint, value.afterMint, value.finalMint]) {
    if (state.address !== value.mintAddress || state.programOwner !== CLASSIC_TOKEN_PROGRAM) { fail("SOLANA_PROGRAM_OWNER", "mint is not owned by classic Token Program"); }
    if (state.decimals !== FIXTURE_DECIMALS) { fail("SOLANA_DECIMALS", `expected ${FIXTURE_DECIMALS} decimals`); }
    if (state.mintAuthority !== value.mintAuthority) { fail("SOLANA_MINT_AUTHORITY", "ephemeral mint authority changed"); }
  }
  if (value.initialMint.supply !== "0" || value.afterRevokeMint.supply !== "0") {
    fail("SOLANA_PRE_MINT_SUPPLY", "mint supply was not canonical zero through freeze-authority revocation");
  }
  if (value.initialMint.freezeAuthority !== value.freezeAuthority || value.freezeAuthority !== value.mintAuthority) { fail("SOLANA_INITIAL_FREEZE", "mint creation did not bind the explicit ephemeral freeze authority"); }
  if (value.afterRevokeMint.freezeAuthority !== null || value.afterMint.freezeAuthority !== null || value.finalMint.freezeAuthority !== null) {
    fail("SOLANA_FREEZE_AUTHORITY", "freeze authority was not permanently disabled before minting");
  }
}

function verifySupply(value: FixtureObservations): void {
  const amount = FIXTURE_AMOUNT_BASE_UNITS.toString();
  if (value.afterMint.supply !== amount || value.afterMintTokenAccount.amount !== amount) { fail("SOLANA_INTERMEDIATE_AMOUNT", "minted supply or owner balance is wrong"); }
  if (value.finalMint.supply !== "0" || value.finalTokenAccount.amount !== "0") { fail("SOLANA_FINAL_SUPPLY", "burn did not return supply and balance to zero"); }
}

function verifyTokenAccountIdentity(value: FixtureObservations): void {
  if (value.afterMintTokenAccount.address !== value.tokenAccountAddress || value.finalTokenAccount.address !== value.tokenAccountAddress
    || value.afterMintTokenAccount.mint !== value.mintAddress || value.finalTokenAccount.mint !== value.mintAddress
    || value.afterMintTokenAccount.owner !== value.ownerAddress || value.finalTokenAccount.owner !== value.ownerAddress) {
    fail("SOLANA_TOKEN_ACCOUNT_IDENTITY", "token account identity changed");
  }
}

function verifyTransactions(value: FixtureObservations): void {
  if (value.transactions.length !== LIFECYCLE.length) { fail("SOLANA_TRANSACTION_COUNT", "exact seven-step lifecycle is incomplete"); }
  const signatures = new Set<string>(); let previousSlot = -1n;
  for (const [index, fact] of value.transactions.entries()) {
    const expected = LIFECYCLE[index] as LifecycleKind;
    if (fact.operation !== expected) { fail("SOLANA_TRANSACTION_ORDER", `decoded ${fact.operation} at lifecycle index ${index}; expected ${expected}`); }
    if (signatures.has(fact.signature)) { fail("SOLANA_TRANSACTION_DUPLICATE", "lifecycle signatures must be unique"); }
    signatures.add(fact.signature);
    if (fact.genesisHash !== value.genesisHashBefore || fact.confirmationStatus !== "finalized") { fail("SOLANA_TRANSACTION_FINALITY", "transaction is not finalized on the owned genesis"); }
    const slot = parseUnsignedInteger(fact.slot, "transaction slot");
    if (slot <= previousSlot) { fail("SOLANA_TRANSACTION_SLOT_ORDER", "lifecycle slots must be strictly increasing"); }
    previousSlot = slot;
    verifyRawBindings(fact);
    verifyTransactionSemantics(fact, value);
  }
}

function verifyRawBindings(fact: TransactionFact): void {
  assertCondition(new Set(fact.accountKeys).size === fact.accountKeys.length, "SOLANA_TRANSACTION_ACCOUNT_KEYS", "transaction account keys must be unique");
  const outer = fact.instructions.filter((item) => item.innerInstructionIndex === null);
  assertCondition(outer.every((item, index) => item.instructionIndex === index && item.innerGroupIndex === null), "SOLANA_TRANSACTION_OUTER_INDEX", "outer instruction indexes are not contiguous");
  for (const item of fact.instructions) {
    assertCondition(fact.accountKeys[item.programIdIndex] === item.programId
      && item.accountIndices.length === item.accounts.length
      && item.accountIndices.every((accountIndex, index) => fact.accountKeys[accountIndex] === item.accounts[index])
      && /^(?:[0-9a-f]{2})*$/u.test(item.dataHex), "SOLANA_TRANSACTION_RAW_BINDING", "retained instruction bytes or account indexes are not cross-bound");
  }
  for (const [groupIndex, group] of fact.innerInstructionGroups.entries()) {
    assertCondition(group.groupIndex === groupIndex && Number.isSafeInteger(group.outerInstructionIndex) && group.outerInstructionIndex >= 0 && group.outerInstructionIndex < outer.length,
      "SOLANA_TRANSACTION_CPI_GROUP", "inner instruction group is sparse, duplicated or out of range");
    assertCondition(fact.instructions.some((item) => item.innerGroupIndex === groupIndex && item.instructionIndex === group.outerInstructionIndex),
      "SOLANA_TRANSACTION_CPI_GROUP", "inner instruction group has no bound instructions");
  }
  const innerGroups = fact.instructions.filter((item) => item.innerInstructionIndex !== null).map((item) => item.innerGroupIndex);
  assertCondition(innerGroups.every((groupIndex) => groupIndex !== null && fact.innerInstructionGroups[groupIndex]?.groupIndex === groupIndex),
    "SOLANA_TRANSACTION_CPI_GROUP", "inner instruction is not bound to a retained group");
}

function verifyTransactionSemantics(fact: TransactionFact, value: FixtureObservations): void {
  const relevant = relevantInstruction(fact);
  verifyTransactionResult(fact, relevant);

  switch (fact.operation) {
    case "createMint": verifyCreateMint(fact, relevant, value); break;
    case "revokeFreeze": verifyRevokeFreeze(fact, relevant, value); break;
    case "createAta": verifyCreateAta(fact, relevant, value); break;
    case "mint": verifyMint(fact, relevant, value); break;
    case "burn": verifyBurn(fact, relevant, value); break;
    case "restoreFreezeAttempt": verifyRestoreFreeze(fact, relevant, value); break;
    case "freezeAttempt": verifyFreeze(fact, relevant, value); break;
  }
}

function verifyTransactionResult(fact: TransactionFact, relevant: InstructionFact): void {
  const shouldFail = fact.operation === "restoreFreezeAttempt" || fact.operation === "freezeAttempt";
  if (shouldFail) {
    if (fact.error === null || fact.error.instructionIndex !== relevant.instructionIndex || relevant.innerInstructionIndex !== null) {
      fail("SOLANA_TRANSACTION_ERROR_INDEX", `${fact.operation} did not fail at its exact outer Token instruction`);
    }
    if (fact.error.code !== EXPECTED_DISABLED_FREEZE_ERROR) {
      fail("SOLANA_TRANSACTION_ERROR_CODE", `${fact.operation} did not return the expected classic Token error`);
    }
  } else if (fact.error !== null) { fail("SOLANA_TRANSACTION_RESULT", `${fact.operation} unexpectedly failed`); }
}

function verifyCreateMint(fact: TransactionFact, relevant: InstructionFact, value: FixtureObservations): void {
  requireKind(relevant, ["initializeMint", "initializeMint2"]);
  assertCondition(relevant.mint === value.mintAddress && relevant.authority === value.mintAuthority && relevant.newAuthority === value.freezeAuthority && relevant.decimals === FIXTURE_DECIMALS,
    "SOLANA_CREATE_SEMANTICS", "mint initialization does not bind mint, authorities and decimals");
  requireSigners(fact, [value.payerAddress, value.mintAddress]);
}

function verifyRevokeFreeze(fact: TransactionFact, relevant: InstructionFact, value: FixtureObservations): void {
  requireKind(relevant, ["setAuthority"]);
  verifySetAuthorityWire(relevant, null);
  assertCondition(relevant.tokenAccount === value.mintAddress && (relevant.mint === null || relevant.mint === value.mintAddress)
    && relevant.authority === value.freezeAuthority && relevant.authorityType === "freezeAccount" && relevant.newAuthority === null,
  "SOLANA_REVOKE_SEMANTICS", "freeze revocation does not bind mint and former authority");
  requireSigners(fact, [value.payerAddress, value.freezeAuthority]);
}

function verifyCreateAta(fact: TransactionFact, relevant: InstructionFact, value: FixtureObservations): void {
  verifyAtaOuter(fact, relevant, value);
  const inner = verifyAtaGroups(fact);
  verifyAtaCpis(inner, value);
  requireSigners(fact, [value.payerAddress]);
}

function verifyAtaOuter(fact: TransactionFact, relevant: InstructionFact, value: FixtureObservations): void {
  const outer = fact.instructions.filter((item) => item.innerInstructionIndex === null);
  assertCondition(outer.length === 1 && outer[0] === relevant && relevant.instructionIndex === 0 && relevant.innerGroupIndex === null,
    "SOLANA_ATA_OUTER", "ATA lifecycle must contain exactly one outer Associated Token instruction at index 0");
  assertCondition(relevant.programId === ASSOCIATED_TOKEN_PROGRAM && (relevant.kind === "raw" || relevant.kind === "create") && relevant.dataHex === "00",
    "SOLANA_ATA_DISCRIMINANT", "ATA creation must use the pinned Create discriminant");
  const expectedOuterAccounts = [value.payerAddress, value.tokenAccountAddress, value.ownerAddress, value.mintAddress, SYSTEM_PROGRAM, CLASSIC_TOKEN_PROGRAM];
  assertCondition(sameAddresses(relevant.accounts, expectedOuterAccounts), "SOLANA_ATA_ACCOUNTS", "ATA Create outer metas are not exact");
}

function verifyAtaGroups(fact: TransactionFact): readonly [InstructionFact, InstructionFact, InstructionFact, InstructionFact] {
  assertCondition(fact.innerInstructionGroups.length === 1 && fact.innerInstructionGroups[0]?.groupIndex === 0 && fact.innerInstructionGroups[0]?.outerInstructionIndex === 0,
    "SOLANA_ATA_CPI_GROUPS", "ATA Create must contain exactly one CPI group for outer index zero");
  const inner = fact.instructions.filter((item) => item.innerInstructionIndex !== null);
  assertCondition(inner.length === 4 && inner.every((item, index) => item.instructionIndex === 0 && item.innerGroupIndex === 0 && item.innerInstructionIndex === index),
    "SOLANA_ATA_INNER_SEQUENCE", "ATA CPI instructions must be one contiguous four-instruction sequence");
  return inner as unknown as readonly [InstructionFact, InstructionFact, InstructionFact, InstructionFact];
}

function verifyAtaCpis(inner: readonly [InstructionFact, InstructionFact, InstructionFact, InstructionFact], value: FixtureObservations): void {
  const [size, create, immutableOwner, initialize] = inner;
  assertCondition(size.programId === CLASSIC_TOKEN_PROGRAM && size.kind === "getAccountDataSize" && size.dataHex === "150700"
    && sameAddresses(size.accounts, [value.mintAddress]), "SOLANA_ATA_GET_SIZE", "ATA CPI getAccountDataSize semantics differ");
  verifyAtaAccountCreation(create, value);
  verifyAtaInitialization(immutableOwner, initialize, value);
}

function verifyAtaAccountCreation(create: InstructionFact, value: FixtureObservations): void {
  assertCondition(create.programId === SYSTEM_PROGRAM && create.kind === "createAccount" && create.dataHex.length === 104
    && create.dataHex.startsWith("00000000") && create.newAccount === value.tokenAccountAddress && create.owner === CLASSIC_TOKEN_PROGRAM
    && sameAddresses(create.accounts, [value.payerAddress, value.tokenAccountAddress]) && systemCreateLamports(create.dataHex) > 0n
    && systemCreateSpace(create.dataHex) === 165n && systemCreateOwner(create.dataHex) === CLASSIC_TOKEN_PROGRAM,
    "SOLANA_ATA_CREATE_ACCOUNT", "ATA CPI System createAccount semantics differ");
}

function verifyAtaInitialization(immutableOwner: InstructionFact, initialize: InstructionFact, value: FixtureObservations): void {
  assertCondition(immutableOwner.programId === CLASSIC_TOKEN_PROGRAM && immutableOwner.kind === "initializeImmutableOwner" && immutableOwner.dataHex === "16"
    && sameAddresses(immutableOwner.accounts, [value.tokenAccountAddress]), "SOLANA_ATA_IMMUTABLE_OWNER", "ATA CPI initializeImmutableOwner semantics differ");
  assertCondition(initialize.programId === CLASSIC_TOKEN_PROGRAM && initialize.kind === "initializeAccount3" && initialize.dataHex.length === 66
    && initialize.dataHex.startsWith("12") && initialize.owner === value.ownerAddress && initialize.tokenAccount === value.tokenAccountAddress
    && initialize.mint === value.mintAddress && sameAddresses(initialize.accounts, [value.tokenAccountAddress, value.mintAddress])
    && base58(initialize.dataHex.slice(2)) === value.ownerAddress, "SOLANA_ATA_INITIALIZE", "ATA CPI initializeAccount3 semantics differ");
}

function verifyMint(fact: TransactionFact, relevant: InstructionFact, value: FixtureObservations): void {
  requireKind(relevant, ["mintTo", "mintToChecked"]);
  assertCondition(relevant.mint === value.mintAddress && relevant.tokenAccount === value.tokenAccountAddress && relevant.authority === value.mintAuthority && relevant.amountBaseUnits === FIXTURE_AMOUNT_BASE_UNITS.toString(),
    "SOLANA_MINT_SEMANTICS", "mint instruction does not bind mint, ATA, authority and amount");
  requireSigners(fact, [value.payerAddress, value.mintAuthority]);
}

function verifyBurn(fact: TransactionFact, relevant: InstructionFact, value: FixtureObservations): void {
  requireKind(relevant, ["burn", "burnChecked"]);
  assertCondition(relevant.mint === value.mintAddress && relevant.tokenAccount === value.tokenAccountAddress && relevant.authority === value.ownerAddress && relevant.amountBaseUnits === FIXTURE_AMOUNT_BASE_UNITS.toString(),
    "SOLANA_BURN_SEMANTICS", "burn instruction does not bind mint, ATA, owner and amount");
  requireSigners(fact, [value.payerAddress, value.ownerAddress]);
}

function verifyRestoreFreeze(fact: TransactionFact, relevant: InstructionFact, value: FixtureObservations): void {
  requireKind(relevant, ["setAuthority"]);
  verifySetAuthorityWire(relevant, value.freezeAuthority);
  assertCondition(relevant.tokenAccount === value.mintAddress && (relevant.mint === null || relevant.mint === value.mintAddress)
    && relevant.authority === value.freezeAuthority && relevant.authorityType === "freezeAccount" && relevant.newAuthority === value.freezeAuthority,
  "SOLANA_RESTORE_SEMANTICS", "restore attempt does not bind mint and former authority");
  requireSigners(fact, [value.payerAddress, value.freezeAuthority]);
}

function verifyFreeze(fact: TransactionFact, relevant: InstructionFact, value: FixtureObservations): void {
  requireKind(relevant, ["freezeAccount"]);
  assertCondition(relevant.mint === value.mintAddress && relevant.tokenAccount === value.tokenAccountAddress && relevant.authority === value.freezeAuthority,
    "SOLANA_FREEZE_SEMANTICS", "freeze attempt does not bind ATA, mint and former authority");
  requireSigners(fact, [value.payerAddress, value.freezeAuthority]);
}

function relevantInstruction(fact: TransactionFact): InstructionFact {
  const candidates = fact.operation === "createAta"
    ? fact.instructions.filter((item) => item.programId === ASSOCIATED_TOKEN_PROGRAM)
    : fact.instructions.filter((item) => item.programId === CLASSIC_TOKEN_PROGRAM);
  if (candidates.length !== 1) { fail("SOLANA_TRANSACTION_INSTRUCTION_COUNT", `${fact.operation} must contain exactly one relevant instruction`); }
  return candidates[0] as InstructionFact;
}

/** Independently validates the classic SPL Token SetAuthority instruction wire format. */
function verifySetAuthorityWire(instruction: InstructionFact, expectedNewAuthority: string | null): void {
  const prefix = "0601"; // SetAuthority, AuthorityType::FreezeAccount
  if (expectedNewAuthority === null) {
    assertCondition(instruction.dataHex === `${prefix}00`,
      "SOLANA_SET_AUTHORITY_WIRE", "freeze revocation is not the exact three-byte None encoding");
    return;
  }
  assertCondition(instruction.dataHex.length === 70 && instruction.dataHex.startsWith(`${prefix}01`),
    "SOLANA_SET_AUTHORITY_WIRE", "freeze restoration is not the exact 35-byte Some encoding");
  assertCondition(base58(instruction.dataHex.slice(6)) === expectedNewAuthority,
    "SOLANA_SET_AUTHORITY_WIRE", "freeze restoration pubkey bytes do not match the expected authority");
}

function requireKind(instruction: InstructionFact, kinds: readonly string[]): void { assertCondition(kinds.includes(instruction.kind), "SOLANA_INSTRUCTION_KIND", `unexpected instruction ${instruction.kind}`); }
function requireSigners(fact: TransactionFact, expected: readonly string[]): void {
  assertCondition(new Set(fact.signers).size === fact.signers.length && fact.signers.length === expected.length && expected.every((signer) => fact.signers.includes(signer)), "SOLANA_TRANSACTION_SIGNERS", `${fact.operation} does not have the exact signer set`);
}
function assertCondition(condition: boolean, code: string, message: string): asserts condition { if (!condition) { fail(code, message); } }

function evidence(value: FixtureObservations): EvidenceReport {
  const amount = FIXTURE_AMOUNT_BASE_UNITS.toString();
  return {
    schemaVersion: 1, status: "READY", identity: { name: "Agent Teams AI", symbol: "AGTMAI" }, programId: CLASSIC_TOKEN_PROGRAM, decimals: 9,
    testAmountBaseUnits: amount, initialSupply: "0", intermediateSupply: amount, finalSupply: "0", freezeAuthority: null,
    payerAddress: value.payerAddress, mintAddress: value.mintAddress, tokenAccountAddress: value.tokenAccountAddress, ownerAddress: value.ownerAddress,
    mintAuthority: value.mintAuthority, formerFreezeAuthority: value.freezeAuthority, genesisHash: value.genesisHashBefore, validatorVersion: value.validatorVersion, rpcListener: value.rpcListener,
    snapshots: { initialMint: value.initialMint, afterRevokeMint: value.afterRevokeMint, afterMint: value.afterMint, afterMintTokenAccount: value.afterMintTokenAccount, finalMint: value.finalMint, finalTokenAccount: value.finalTokenAccount },
    transactions: value.transactions,
    assertions: { exactLoopbackRpc: true, productionAuthorityProven: false, ccip: false, publicNetwork: false, realAssetCostUsd: 0, mintAuthorityRevoked: false, authorityKeyRetained: false, remintPossibleUntilTeardown: true, productionHardCapProven: false, signedRestoreReachedTokenProgramAndFailed: true, signedFreezeReachedTokenProgramAndFailed: true },
  };
}

function sameAddresses(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function systemCreateLamports(dataHex: string): bigint { return dataHex.length === 104 ? Buffer.from(dataHex, "hex").readBigUInt64LE(4) : -1n; }
function systemCreateSpace(dataHex: string): bigint { return dataHex.length === 104 ? Buffer.from(dataHex, "hex").readBigUInt64LE(12) : -1n; }
function systemCreateOwner(dataHex: string): string | null { return dataHex.length === 104 ? base58(dataHex.slice(40)) : null; }
function base58(hex: string): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; const bytes = Buffer.from(hex, "hex");
  let number = 0n; for (const byte of bytes) { number = (number << 8n) + BigInt(byte); }
  let result = ""; while (number > 0n) { result = alphabet[Number(number % 58n)] + result; number /= 58n; }
  for (const byte of bytes) { if (byte === 0) { result = `1${result}`; } else { break; } }
  return result || "1";
}

function fail(code: string, message: string): never { throw new LocalSolanaError(code, message); }
