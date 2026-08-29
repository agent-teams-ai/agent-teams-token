import assert from "node:assert/strict";
import test from "node:test";
import { verifyObservations } from "../src/application/verifier.ts";
import type { FixtureObservations } from "../src/domain/model.ts";
import { ASSOCIATED_TOKEN_PROGRAM, CLASSIC_TOKEN_PROGRAM, SYSTEM_PROGRAM } from "../src/domain/model.ts";
import { amount, ata, instruction, mintAddress, observationFixture, owner, payer } from "./helpers/observations.ts";

test("verifier reconstructs an exact seven-step mint/ATA/burn/authority lifecycle", () => {
  const report = verifyObservations(observationFixture());
  assert.equal(report.transactions.length, 7); assert.equal(report.transactions[2]?.operation, "createAta"); assert.equal(report.snapshots.finalTokenAccount.amount, "0");
  assert.equal(report.mintAddress, mintAddress); assert.equal(report.tokenAccountAddress, ata); assert.equal(report.formerFreezeAuthority, mintAddress);
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
    (v) => ({ ...v, transactions: v.transactions.map((item) => item.operation === "createAta" ? { ...item, instructions: [instruction({ programId: ASSOCIATED_TOKEN_PROGRAM, accounts: [payer, ata, owner, owner, SYSTEM_PROGRAM, CLASSIC_TOKEN_PROGRAM] })] } : item) }),
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
