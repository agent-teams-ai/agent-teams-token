import {
  CLASSIC_TOKEN_PROGRAM,
  FIXTURE_AMOUNT_BASE_UNITS,
  FIXTURE_DECIMALS,
  LocalSolanaError,
  parseUnsignedInteger,
  type EvidenceReport,
  type FixtureObservations,
  type TransactionFact,
} from "../domain/model.ts";

export function verifyObservations(value: FixtureObservations): EvidenceReport {
  if (value.schemaVersion !== 1) { fail("SOLANA_EVIDENCE_SCHEMA", "unsupported observation schema"); }
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
  if (value.initialMint.supply !== "0") { fail("SOLANA_INITIAL_SUPPLY", "mint did not begin at zero"); }
  if (value.initialMint.freezeAuthority !== value.freezeAuthority) { fail("SOLANA_INITIAL_FREEZE", "mint was not assigned to the explicit ephemeral freeze authority"); }
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
  const amount = FIXTURE_AMOUNT_BASE_UNITS.toString();
  const expected: readonly TransactionFact["kind"][] = ["create", "assignFreeze", "revokeFreeze", "mint", "burn", "restoreFreezeAttempt", "freezeAttempt"];
  if (value.transactions.length !== expected.length) { fail("SOLANA_TRANSACTION_COUNT", "lifecycle transaction set is incomplete"); }
  for (const [index, fact] of value.transactions.entries()) {
    if (fact.kind !== expected[index]) { fail("SOLANA_TRANSACTION_ORDER", `expected ${expected[index]} at lifecycle index ${index}`); }
    if (fact.genesisHash !== value.genesisHashBefore || fact.confirmationStatus !== "finalized") { fail("SOLANA_TRANSACTION_FINALITY", "transaction is not finalized on the owned genesis"); }
    parseUnsignedInteger(fact.slot, "transaction slot");
    if (!fact.programIds.includes(CLASSIC_TOKEN_PROGRAM)) { fail("SOLANA_TRANSACTION_PROGRAM", `${fact.kind} did not reach classic Token Program`); }
    const shouldFail = fact.kind === "restoreFreezeAttempt" || fact.kind === "freezeAttempt";
    if (shouldFail ? fact.err === null : fact.err !== null) { fail("SOLANA_TRANSACTION_RESULT", `${fact.kind} has an unexpected transaction result`); }
    if ((fact.kind === "mint" || fact.kind === "burn") && fact.amountBaseUnits !== amount) { fail("SOLANA_TRANSACTION_AMOUNT", `${fact.kind} amount is wrong`); }
  }
}

function evidence(value: FixtureObservations): EvidenceReport {
  const amount = FIXTURE_AMOUNT_BASE_UNITS.toString();
  return {
    schemaVersion: 1,
    status: "READY",
    identity: { name: "Agent Teams AI", symbol: "AGTMAI" },
    programId: CLASSIC_TOKEN_PROGRAM,
    decimals: 9,
    testAmountBaseUnits: amount,
    initialSupply: "0",
    intermediateSupply: amount,
    finalSupply: "0",
    freezeAuthority: null,
    mintAuthority: value.mintAuthority,
    genesisHash: value.genesisHashBefore,
    validatorVersion: value.validatorVersion,
    transactions: value.transactions,
    assertions: {
      productionAuthorityProven: false,
      ccip: false,
      publicNetwork: false,
      realAssetCostUsd: 0,
      mintAuthorityRevoked: false,
      authorityKeyRetained: false,
      remintPossibleUntilTeardown: true,
      productionHardCapProven: false,
      signedRestoreReachedTokenProgramAndFailed: true,
      signedFreezeReachedTokenProgramAndFailed: true,
    },
  };
}

function fail(code: string, message: string): never { throw new LocalSolanaError(code, message); }
