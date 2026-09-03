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
    verifyTransactionSemantics(fact, value);
  }
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
  assertCondition(relevant.tokenAccount === value.mintAddress && (relevant.mint === null || relevant.mint === value.mintAddress)
    && relevant.authority === value.freezeAuthority && relevant.authorityType === "freezeAccount" && relevant.newAuthority === null,
  "SOLANA_REVOKE_SEMANTICS", "freeze revocation does not bind mint and former authority");
  requireSigners(fact, [value.payerAddress, value.freezeAuthority]);
}

function verifyCreateAta(fact: TransactionFact, relevant: InstructionFact, value: FixtureObservations): void {
  const outer = fact.instructions.filter((item) => item.innerInstructionIndex === null);
  assertCondition(outer.length === 1 && outer[0] === relevant, "SOLANA_ATA_OUTER", "ATA lifecycle must contain exactly one outer Associated Token instruction");
  assertCondition(relevant.programId === ASSOCIATED_TOKEN_PROGRAM && ["raw", "create", "createIdempotent"].includes(relevant.kind), "SOLANA_ATA_PROGRAM", "ATA creation must reach the Associated Token Program");
  const expectedAccounts = [value.payerAddress, value.tokenAccountAddress, value.ownerAddress, value.mintAddress, SYSTEM_PROGRAM, CLASSIC_TOKEN_PROGRAM];
  const exactAccounts = relevant.accounts.length === expectedAccounts.length
    && expectedAccounts.every((address, index) => relevant.accounts[index] === address);
  const exactParsedSemantics = relevant.kind !== "raw" && relevant.authority === value.payerAddress
    && relevant.tokenAccount === value.tokenAccountAddress && relevant.owner === value.ownerAddress && relevant.mint === value.mintAddress;
  assertCondition(exactAccounts && (relevant.kind === "raw" || exactParsedSemantics),
  "SOLANA_ATA_ACCOUNTS", "ATA instruction must contain exactly payer, ATA, owner, mint, System Program and classic Token Program accounts");
  requireSigners(fact, [value.payerAddress]);
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
    mintAuthority: value.mintAuthority, formerFreezeAuthority: value.freezeAuthority, genesisHash: value.genesisHashBefore, validatorVersion: value.validatorVersion,
    snapshots: { initialMint: value.initialMint, afterRevokeMint: value.afterRevokeMint, afterMint: value.afterMint, afterMintTokenAccount: value.afterMintTokenAccount, finalMint: value.finalMint, finalTokenAccount: value.finalTokenAccount },
    transactions: value.transactions,
    assertions: { exactLoopbackRpc: true, productionAuthorityProven: false, ccip: false, publicNetwork: false, realAssetCostUsd: 0, mintAuthorityRevoked: false, authorityKeyRetained: false, remintPossibleUntilTeardown: true, productionHardCapProven: false, signedRestoreReachedTokenProgramAndFailed: true, signedFreezeReachedTokenProgramAndFailed: true },
  };
}

function fail(code: string, message: string): never { throw new LocalSolanaError(code, message); }
