import assert from "node:assert/strict";
import test from "node:test";
import { verifyObservations } from "../src/application/verifier.ts";
import { CLASSIC_TOKEN_PROGRAM, type FixtureObservations, type TransactionFact } from "../src/domain/model.ts";

const address = "11111111111111111111111111111111";
const amount = "1000000000000";
const kinds: readonly TransactionFact["kind"][] = ["create", "assignFreeze", "revokeFreeze", "mint", "burn", "restoreFreezeAttempt", "freezeAttempt"];
function fixture(): FixtureObservations {
  const mint = (supply: string, freezeAuthority: string | null) => ({ address, programOwner: CLASSIC_TOKEN_PROGRAM, decimals: 9, supply, mintAuthority: address, freezeAuthority });
  const token = (balance: string) => ({ address, mint: address, owner: address, amount: balance });
  return {
    schemaVersion: 1, rpcUrl: "http://127.0.0.1:8899/", genesisHashBefore: address, genesisHashAfter: address, validatorVersion: "4.2.1",
    mintAddress: address, mintAuthority: address, freezeAuthority: address, ownerAddress: address, tokenAccountAddress: address,
    initialMint: mint("0", address), afterRevokeMint: mint("0", null), afterMint: mint(amount, null), afterMintTokenAccount: token(amount), finalMint: mint("0", null), finalTokenAccount: token("0"),
    transactions: kinds.map((kind, index) => ({ kind, signature: "2".repeat(64), slot: String(index + 1), confirmationStatus: "finalized", err: kind.endsWith("Attempt") ? { InstructionError: [0, "Custom"] } : null, programIds: [CLASSIC_TOKEN_PROGRAM], instructionKinds: [kind], amountBaseUnits: kind === "mint" || kind === "burn" ? amount : null, genesisHash: address })),
  };
}

test("verifier reconstructs lifecycle and freezes corrected authority claims", () => {
  const report = verifyObservations(fixture());
  assert.equal(report.decimals, 9); assert.equal(report.finalSupply, "0"); assert.equal(report.freezeAuthority, null);
  assert.deepEqual(report.assertions, {
    productionAuthorityProven: false, ccip: false, publicNetwork: false, realAssetCostUsd: 0,
    mintAuthorityRevoked: false, authorityKeyRetained: false, remintPossibleUntilTeardown: true, productionHardCapProven: false,
    signedRestoreReachedTokenProgramAndFailed: true, signedFreezeReachedTokenProgramAndFailed: true,
  });
});

test("verifier fails closed on every core lifecycle invariant", () => {
  const mutations: readonly ((value: FixtureObservations) => FixtureObservations)[] = [
    (v) => ({ ...v, genesisHashAfter: "3".repeat(32) }),
    (v) => ({ ...v, initialMint: { ...v.initialMint, supply: "1" } }),
    (v) => ({ ...v, afterMint: { ...v.afterMint, decimals: 18 } }),
    (v) => ({ ...v, finalMint: { ...v.finalMint, programOwner: "Token2022" } }),
    (v) => ({ ...v, afterRevokeMint: { ...v.afterRevokeMint, freezeAuthority: address } }),
    (v) => ({ ...v, finalMint: { ...v.finalMint, mintAuthority: null } }),
    (v) => ({ ...v, finalTokenAccount: { ...v.finalTokenAccount, amount: "1" } }),
    (v) => ({ ...v, transactions: v.transactions.slice(1) }),
    (v) => ({ ...v, transactions: v.transactions.map((fact) => fact.kind === "restoreFreezeAttempt" ? { ...fact, err: null } : fact) }),
    (v) => ({ ...v, transactions: v.transactions.map((fact) => fact.kind === "freezeAttempt" ? { ...fact, programIds: [] } : fact) }),
    (v) => ({ ...v, transactions: v.transactions.map((fact) => fact.kind === "mint" ? { ...fact, amountBaseUnits: "1" } : fact) }),
  ];
  for (const mutate of mutations) { assert.throws(() => verifyObservations(mutate(fixture())), /SOLANA_/u); }
});
