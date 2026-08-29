import { ASSOCIATED_TOKEN_PROGRAM, CLASSIC_TOKEN_PROGRAM, LIFECYCLE, SYSTEM_PROGRAM, type FixtureObservations, type InstructionFact, type LifecycleKind, type TransactionFact } from "../../src/domain/model.ts";

export const payer = "5".repeat(32); export const mintAddress = "2".repeat(32); export const owner = "3".repeat(32); export const ata = "4".repeat(32); export const genesis = "6".repeat(32); export const amount = "1000000000000";
export function instruction(partial: Partial<InstructionFact> = {}): InstructionFact { return { programId: CLASSIC_TOKEN_PROGRAM, instructionIndex: 0, innerInstructionIndex: null, kind: "raw", accounts: [], mint: null, tokenAccount: null, owner: null, authority: null, newAuthority: null, authorityType: null, amountBaseUnits: null, decimals: null, ...partial }; }
function fact(operation: LifecycleKind, index: number): TransactionFact {
  const common = { operation, signature: String(index + 2).repeat(64), slot: String(index + 1), confirmationStatus: "finalized" as const, error: null, genesisHash: genesis };
  switch (operation) {
    case "createMint": return { ...common, signers: [payer, mintAddress], instructions: [instruction({ kind: "initializeMint2", accounts: [mintAddress, mintAddress], mint: mintAddress, authority: mintAddress, newAuthority: mintAddress, decimals: 9 })] };
    case "revokeFreeze": return { ...common, signers: [payer, mintAddress], instructions: [instruction({ kind: "setAuthority", accounts: [mintAddress, mintAddress], tokenAccount: mintAddress, authority: mintAddress, authorityType: "freezeAccount", newAuthority: null })] };
    case "createAta": return { ...common, signers: [payer], instructions: [instruction({ programId: ASSOCIATED_TOKEN_PROGRAM, kind: "raw", accounts: [payer, ata, owner, mintAddress, SYSTEM_PROGRAM, CLASSIC_TOKEN_PROGRAM] })] };
    case "mint": return { ...common, signers: [payer, mintAddress], instructions: [instruction({ kind: "mintTo", accounts: [mintAddress, ata, mintAddress], mint: mintAddress, tokenAccount: ata, authority: mintAddress, amountBaseUnits: amount })] };
    case "burn": return { ...common, signers: [payer, owner], instructions: [instruction({ kind: "burn", accounts: [ata, mintAddress, owner], mint: mintAddress, tokenAccount: ata, authority: owner, amountBaseUnits: amount })] };
    case "restoreFreezeAttempt": return { ...common, error: { instructionIndex: 0, code: "Custom(4)" }, signers: [payer, mintAddress], instructions: [instruction({ kind: "setAuthority", accounts: [mintAddress, mintAddress], tokenAccount: mintAddress, authority: mintAddress, authorityType: "freezeAccount", newAuthority: mintAddress })] };
    case "freezeAttempt": return { ...common, error: { instructionIndex: 0, code: "Custom(4)" }, signers: [payer, mintAddress], instructions: [instruction({ kind: "freezeAccount", accounts: [ata, mintAddress, mintAddress], tokenAccount: ata, mint: mintAddress, authority: mintAddress })] };
  }
}
export function observationFixture(): FixtureObservations {
  const mint = (supply: string, freezeAuthority: string | null) => ({ address: mintAddress, programOwner: CLASSIC_TOKEN_PROGRAM, decimals: 9, supply, mintAuthority: mintAddress, freezeAuthority });
  const token = (balance: string) => ({ address: ata, mint: mintAddress, owner, amount: balance });
  return { schemaVersion: 1, rpcUrl: "http://127.0.0.1:8899/", genesisHashBefore: genesis, genesisHashAfter: genesis, validatorVersion: "4.2.1", payerAddress: payer, mintAddress, mintAuthority: mintAddress, freezeAuthority: mintAddress, ownerAddress: owner, tokenAccountAddress: ata,
    initialMint: mint("0", mintAddress), afterRevokeMint: mint("0", null), afterMint: mint(amount, null), afterMintTokenAccount: token(amount), finalMint: mint("0", null), finalTokenAccount: token("0"), transactions: LIFECYCLE.map((operation, index) => fact(operation, index)) };
}
