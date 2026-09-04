import assert from "node:assert/strict";
import test from "node:test";
import { verifyObservations } from "../src/application/verifier.ts";
import type { FixtureObservations } from "../src/domain/model.ts";
import { ASSOCIATED_TOKEN_PROGRAM, CLASSIC_TOKEN_PROGRAM, SYSTEM_PROGRAM } from "../src/domain/model.ts";
import { amount, ata, instruction, mintAddress, observationFixture, owner, payer } from "./helpers/observations.ts";

function mutateAta(change: (transaction: FixtureObservations["transactions"][number]) => FixtureObservations["transactions"][number]): FixtureObservations {
  const base = observationFixture(); return { ...base, transactions: base.transactions.map((transaction) => transaction.operation === "createAta" ? change(transaction) : transaction) };
}

function mutateAtaGetSize(change: (instruction: FixtureObservations["transactions"][number]["instructions"][number]) => FixtureObservations["transactions"][number]["instructions"][number]): FixtureObservations {
  return mutateAta((transaction) => ({
    ...transaction,
    instructions: transaction.instructions.map((item) => item.innerInstructionIndex === 0 ? change(item) : item),
  }));
}

test("verifier reconstructs an exact seven-step mint/ATA/burn/authority lifecycle", () => {
  const report = verifyObservations(observationFixture());
  assert.equal(report.transactions.length, 7); assert.equal(report.transactions[2]?.operation, "createAta"); assert.equal(report.snapshots.finalTokenAccount.amount, "0");
  assert.equal(report.mintAddress, mintAddress); assert.equal(report.tokenAccountAddress, ata); assert.equal(report.formerFreezeAuthority, mintAddress);
  assert.equal(report.assertions.exactLoopbackRpc, true);
  assert.equal(verifyObservations({ ...observationFixture(), rpcListener: { scope: "wildcard" } }).rpcListener.scope, "wildcard");
  assert.equal("rpcUrl" in report, false);
});

test("verifier binds observations to an exact loopback RPC without publishing its URL", () => {
  for (const rpcUrl of ["http://127.0.0.2:8899/", "http://localhost:8899/", "https://127.0.0.1:8899/", "http://127.0.0.1:8899/path", "http://127.0.0.1:65536/"]) {
    assert.throws(() => verifyObservations({ ...observationFixture(), rpcUrl }), /SOLANA_RPC_NOT_EXACT_LOOPBACK/u);
  }
});

test("verifier rejects caller-style relabels, duplicate signatures and nonmonotonic slots", () => {
  const mutations: readonly ((value: FixtureObservations) => FixtureObservations)[] = [
    (v) => ({ ...v, transactions: v.transactions.map((item, index) => index === 1 ? { ...item, operation: "mint" } : item) }),
    (v) => ({ ...v, transactions: v.transactions.map((item, index) => index === 1 ? { ...item, signature: v.transactions[0]!.signature } : item) }),
    (v) => ({ ...v, transactions: v.transactions.map((item, index) => index === 3 ? { ...item, slot: v.transactions[2]!.slot } : item) }),
    (v) => ({ ...v, transactions: v.transactions.map((item) => item.operation === "mint" ? { ...item, instructions: [instruction({ kind: "transfer", tokenAccount: ata, amountBaseUnits: amount })] } : item) }),
    (v) => ({ ...v, transactions: v.transactions.map((item) => item.operation === "restoreFreezeAttempt" ? { ...item, error: { instructionIndex: 1, code: "Custom(16)" } } : item) }),
    (v) => ({ ...v, transactions: v.transactions.map((item) => item.operation === "restoreFreezeAttempt" ? { ...item, error: { instructionIndex: 0, code: "Custom(15)" } } : item) }),
    (v) => ({ ...v, transactions: v.transactions.map((item) => item.operation === "freezeAttempt" ? { ...item, signers: [payer, owner] } : item) }),
    (v) => ({ ...v, transactions: v.transactions.map((item) => item.operation === "createAta" ? { ...item, instructions: [instruction({ programId: ASSOCIATED_TOKEN_PROGRAM, accounts: [payer, ata, owner, mintAddress, SYSTEM_PROGRAM, CLASSIC_TOKEN_PROGRAM, "extra-account"] })] } : item) }),
    (v) => ({ ...v, transactions: v.transactions.map((item) => item.operation === "createAta" ? { ...item, instructions: [...item.instructions, instruction({ programId: CLASSIC_TOKEN_PROGRAM, kind: "transfer" })] } : item) }),
  ];
  for (const mutate of mutations) { assert.throws(() => verifyObservations(mutate(observationFixture())), /SOLANA_/u); }
});

test("verifier fails closed on state and authority mutations", () => {
  const mutations: readonly ((value: FixtureObservations) => FixtureObservations)[] = [
    (v) => ({ ...v, genesisHashAfter: "7".repeat(32) }), (v) => ({ ...v, initialMint: { ...v.initialMint, supply: "1" } }),
    (v) => ({ ...v, afterMint: { ...v.afterMint, decimals: 18 } }), (v) => ({ ...v, finalMint: { ...v.finalMint, programOwner: "Token2022" } }),
    (v) => ({ ...v, afterRevokeMint: { ...v.afterRevokeMint, freezeAuthority: mintAddress } }), (v) => ({ ...v, finalMint: { ...v.finalMint, mintAuthority: null } }),
    (v) => ({ ...v, finalTokenAccount: { ...v.finalTokenAccount, amount: "1" } }), (v) => ({ ...v, transactions: v.transactions.slice(1) }),
  ];
  for (const mutate of mutations) { assert.throws(() => verifyObservations(mutate(observationFixture())), /SOLANA_/u); }
});

test("verifier rejects supply introduced only after freeze-authority revocation", () => {
  const observation = observationFixture();
  assert.throws(
    () => verifyObservations({ ...observation, afterRevokeMint: { ...observation.afterRevokeMint, supply: "777" } }),
    /SOLANA_PRE_MINT_SUPPLY/u,
  );
});

test("verifier rejects zero, extra, duplicate, sparse, reordered and semantically forged ATA CPI evidence", () => {
  const attacks = [
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.slice(0, 1), innerInstructionGroups: [] })),
    mutateAta((transaction) => ({ ...transaction, innerInstructionGroups: [...transaction.innerInstructionGroups, { groupIndex: 1, outerInstructionIndex: 0 }] })),
    mutateAta((transaction) => ({ ...transaction, innerInstructionGroups: [{ groupIndex: 0, outerInstructionIndex: 0 }, { groupIndex: 0, outerInstructionIndex: 0 }] })),
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.map((item) => item.innerInstructionIndex === 2 ? { ...item, innerInstructionIndex: 7 } : item) })),
    mutateAta((transaction) => ({ ...transaction, instructions: [transaction.instructions[0]!, transaction.instructions[2]!, transaction.instructions[1]!, ...transaction.instructions.slice(3)] })),
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.map((item, index) => index === 0 ? { ...item, dataHex: "01" } : item) })),
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.map((item) => item.programId === SYSTEM_PROGRAM ? { ...item, dataHex: item.dataHex.slice(0, 24) + "a600000000000000" + item.dataHex.slice(40) } : item) })),
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.map((item) => item.programId === SYSTEM_PROGRAM ? { ...item, newAccount: owner } : item) })),
    mutateAta((transaction) => ({ ...transaction, instructions: [...transaction.instructions, { ...transaction.instructions[2]!, innerInstructionIndex: 4 }] })),
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.map((item) => item.kind === "initializeAccount3" ? { ...item, owner: payer } : item) })),
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.map((item) => item.kind === "getAccountDataSize" ? { ...item, accountIndices: [0] } : item) })),
  ];
  for (const attack of attacks) { assert.throws(() => verifyObservations(attack), /SOLANA_/u); }
});

test("verifier binds ATA account sizing to the exact immutable-owner request", () => {
  const exact = observationFixture();
  const size = exact.transactions[2]?.instructions[1];
  assert.equal(size?.kind, "getAccountDataSize");
  assert.equal(size?.dataHex, "150700");
  assert.doesNotThrow(() => verifyObservations(exact));

  for (const dataHex of ["15", "150000", "15070000", "150800"]) {
    assert.throws(() => verifyObservations(mutateAtaGetSize((item) => ({ ...item, dataHex }))), /SOLANA_ATA_GET_SIZE/u);
  }

  const wrongKind = mutateAtaGetSize((item) => ({ ...item, kind: "raw" }));
  const wrongProgram = mutateAtaGetSize((item) => ({
    ...item,
    programId: SYSTEM_PROGRAM,
    programIdIndex: observationFixture().transactions[2]!.accountKeys.indexOf(SYSTEM_PROGRAM),
  }));
  const wrongAccount = mutateAtaGetSize((item) => ({
    ...item,
    accounts: [owner],
    accountIndices: [observationFixture().transactions[2]!.accountKeys.indexOf(owner)],
  }));
  for (const attack of [wrongKind, wrongProgram, wrongAccount]) {
    assert.throws(() => verifyObservations(attack), /SOLANA_ATA_GET_SIZE/u);
  }

  const wrongOrder = mutateAta((transaction) => ({
    ...transaction,
    instructions: [transaction.instructions[0]!, transaction.instructions[2]!, transaction.instructions[1]!, ...transaction.instructions.slice(3)],
  }));
  assert.throws(() => verifyObservations(wrongOrder), /SOLANA_ATA_INNER_SEQUENCE/u);
});

test("verifier accepts only raw or parsed Create bound to discriminant zero", () => {
  const parsedCreate = mutateAta((transaction) => ({
    ...transaction,
    instructions: transaction.instructions.map((item, index) => index === 0 ? { ...item, kind: "create" } : item),
  }));
  assert.equal(verifyObservations(observationFixture()).transactions[2]?.instructions[0]?.kind, "raw");
  assert.equal(verifyObservations(parsedCreate).transactions[2]?.instructions[0]?.kind, "create");

  const attacks = [
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.map((item, index) => index === 0 ? { ...item, dataHex: "01" } : item) })),
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.map((item, index) => index === 0 ? { ...item, kind: "create", dataHex: "01" } : item) })),
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.map((item, index) => index === 0 ? { ...item, kind: "createIdempotent" } : item) })),
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.map((item, index) => index === 0 ? { ...item, kind: "create", accounts: [payer, ata, mintAddress, owner, SYSTEM_PROGRAM, CLASSIC_TOKEN_PROGRAM] } : item) })),
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.map((item, index) => index === 0 ? { ...item, kind: "create", programId: CLASSIC_TOKEN_PROGRAM } : item) })),
    mutateAta((transaction) => ({ ...transaction, instructions: transaction.instructions.map((item, index) => index === 0 ? { ...item, kind: "create" } : item), innerInstructionGroups: [{ groupIndex: 0, outerInstructionIndex: 1 }] })),
    mutateAta((transaction) => ({ ...transaction, instructions: [transaction.instructions[0]!, transaction.instructions[2]!, transaction.instructions[1]!, ...transaction.instructions.slice(3)].map((item, index) => index === 0 ? { ...item, kind: "create" } : item) })),
  ];
  for (const attack of attacks) { assert.throws(() => verifyObservations(attack), /SOLANA_/u); }
});
