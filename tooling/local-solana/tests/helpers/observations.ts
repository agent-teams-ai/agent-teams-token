import { ASSOCIATED_TOKEN_PROGRAM, CLASSIC_TOKEN_PROGRAM, LIFECYCLE, SYSTEM_PROGRAM, type FixtureObservations, type InstructionFact, type LifecycleKind, type TransactionFact } from "../../src/domain/model.ts";
import { base58Decode, base58Encode } from "../../src/adapters/transaction.ts";

export const payer = base58Encode(Uint8Array.from({ length: 32 }, () => 5)); export const mintAddress = base58Encode(Uint8Array.from({ length: 32 }, () => 2)); export const owner = base58Encode(Uint8Array.from({ length: 32 }, () => 3)); export const ata = base58Encode(Uint8Array.from({ length: 32 }, () => 4)); export const genesis = base58Encode(Uint8Array.from({ length: 32 }, () => 6)); export const amount = "1000000000000";
export function instruction(partial: Partial<InstructionFact> = {}): InstructionFact { return { programId: CLASSIC_TOKEN_PROGRAM, programIdIndex: 0, instructionIndex: 0, innerInstructionIndex: null, innerGroupIndex: null, kind: "raw", accounts: [], accountIndices: [], dataHex: "", mint: null, tokenAccount: null, owner: null, newAccount: null, authority: null, newAuthority: null, authorityType: null, amountBaseUnits: null, decimals: null, ...partial }; }
function transaction(common: Omit<TransactionFact, "accountKeys" | "instructions" | "innerInstructionGroups">, source: readonly InstructionFact[], innerInstructionGroups: TransactionFact["innerInstructionGroups"] = []): TransactionFact {
  const accountKeys = [...new Set([...common.signers, ...source.flatMap((item) => [item.programId, ...item.accounts])])];
  const instructions = source.map((item) => ({ ...item, programIdIndex: accountKeys.indexOf(item.programId), accountIndices: item.accounts.map((account) => accountKeys.indexOf(account)) }));
  return { ...common, accountKeys, instructions, innerInstructionGroups };
}
function fact(operation: LifecycleKind, index: number): TransactionFact {
  const common = { operation, signature: String(index + 2).repeat(64), slot: String(index + 1), confirmationStatus: "finalized" as const, error: null, genesisHash: genesis, signers: [] as readonly string[] };
  switch (operation) {
    case "createMint": return transaction({ ...common, signers: [payer, mintAddress] }, [instruction({ kind: "initializeMint2", accounts: [mintAddress, mintAddress], mint: mintAddress, authority: mintAddress, newAuthority: mintAddress, decimals: 9 })]);
    case "revokeFreeze": return transaction({ ...common, signers: [payer, mintAddress] }, [instruction({ kind: "setAuthority", accounts: [mintAddress, mintAddress], dataHex: "060100", tokenAccount: mintAddress, authority: mintAddress, authorityType: "freezeAccount", newAuthority: null })]);
    case "createAta": {
      const systemData = Buffer.alloc(52); systemData.writeBigUInt64LE(2_039_280n, 4); systemData.writeBigUInt64LE(165n, 12); Buffer.from(base58Decode(CLASSIC_TOKEN_PROGRAM)).copy(systemData, 20);
      const initializeData = Buffer.concat([Buffer.from([18]), Buffer.from(base58Decode(owner))]);
      return transaction({ ...common, signers: [payer] }, [
        instruction({ programId: ASSOCIATED_TOKEN_PROGRAM, kind: "raw", accounts: [payer, ata, owner, mintAddress, SYSTEM_PROGRAM, CLASSIC_TOKEN_PROGRAM], dataHex: "00" }),
        instruction({ kind: "getAccountDataSize", accounts: [mintAddress], dataHex: "150700", instructionIndex: 0, innerInstructionIndex: 0, innerGroupIndex: 0, mint: mintAddress }),
        instruction({ programId: SYSTEM_PROGRAM, kind: "createAccount", accounts: [payer, ata], dataHex: systemData.toString("hex"), instructionIndex: 0, innerInstructionIndex: 1, innerGroupIndex: 0, newAccount: ata, owner: CLASSIC_TOKEN_PROGRAM }),
        instruction({ kind: "initializeImmutableOwner", accounts: [ata], dataHex: "16", instructionIndex: 0, innerInstructionIndex: 2, innerGroupIndex: 0, tokenAccount: ata }),
        instruction({ kind: "initializeAccount3", accounts: [ata, mintAddress], dataHex: initializeData.toString("hex"), instructionIndex: 0, innerInstructionIndex: 3, innerGroupIndex: 0, tokenAccount: ata, mint: mintAddress, owner }),
      ], [{ groupIndex: 0, outerInstructionIndex: 0 }]);
    }
    case "mint": return transaction({ ...common, signers: [payer, mintAddress] }, [instruction({ kind: "mintTo", accounts: [mintAddress, ata, mintAddress], mint: mintAddress, tokenAccount: ata, authority: mintAddress, amountBaseUnits: amount })]);
    case "burn": return transaction({ ...common, signers: [payer, owner] }, [instruction({ kind: "burn", accounts: [ata, mintAddress, owner], mint: mintAddress, tokenAccount: ata, authority: owner, amountBaseUnits: amount })]);
    case "restoreFreezeAttempt": return transaction({ ...common, error: { instructionIndex: 0, code: "Custom(16)" }, signers: [payer, mintAddress] }, [instruction({ kind: "setAuthority", accounts: [mintAddress, mintAddress], dataHex: `060101${"02".repeat(32)}`, tokenAccount: mintAddress, authority: mintAddress, authorityType: "freezeAccount", newAuthority: mintAddress })]);
    case "freezeAttempt": return transaction({ ...common, error: { instructionIndex: 0, code: "Custom(16)" }, signers: [payer, mintAddress] }, [instruction({ kind: "freezeAccount", accounts: [ata, mintAddress, mintAddress], dataHex: "0a", tokenAccount: ata, mint: mintAddress, authority: mintAddress })]);
  }
}

export function observationFixture(): FixtureObservations {
  const mint = (supply: string, freezeAuthority: string | null) => ({ address: mintAddress, programOwner: CLASSIC_TOKEN_PROGRAM, decimals: 9, supply, mintAuthority: mintAddress, freezeAuthority });
  const token = (balance: string) => ({ address: ata, mint: mintAddress, owner, amount: balance });
  return { schemaVersion: 1, rpcUrl: "http://127.0.0.1:8899/", genesisHashBefore: genesis, genesisHashAfter: genesis, validatorVersion: "4.2.1", rpcListener: { scope: "ipv4-loopback" }, payerAddress: payer, mintAddress, mintAuthority: mintAddress, freezeAuthority: mintAddress, ownerAddress: owner, tokenAccountAddress: ata,
    initialMint: mint("0", mintAddress), afterRevokeMint: mint("0", null), afterMint: mint(amount, null), afterMintTokenAccount: token(amount), finalMint: mint("0", null), finalTokenAccount: token("0"), transactions: LIFECYCLE.map((operation, index) => fact(operation, index)) };
}
