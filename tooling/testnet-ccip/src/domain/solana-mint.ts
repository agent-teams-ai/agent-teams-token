/** Official standard SPL mint slice only. The adapter separately authenticates Devnet and test keys. */
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export interface MintAccountMeta {
  readonly address: string; readonly isSigner: boolean; readonly isWritable: boolean;
}
export interface MintInstruction {
  readonly programId: string; readonly accounts: readonly MintAccountMeta[]; readonly dataBase64: string;
}
export interface SolanaMintIntent {
  readonly feePayer: string; readonly instructions: readonly MintInstruction[];
}
export interface SolanaMintExpectation {
  readonly testOnly: true; readonly cluster: "solana-devnet";
  readonly payer: string; readonly mint: string; readonly rentLamports: bigint | string;
}
export interface SolanaMintEnvelope {
  readonly schema: "agtmai-solana-mint-v1"; readonly cluster: "solana-devnet";
  readonly payer: string; readonly mint: string; readonly rentLamports: string;
  readonly decimals: 9; readonly initialSupply: "0"; readonly freezeAuthority: null;
  readonly instructions: readonly MintInstruction[];
}
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const invalid = (): never => { throw new Error("Invalid test-only Solana mint intent"); };
function publicKey(address: string): Buffer {
  if (typeof address !== "string" || address.length < 32 || address.length > 44) { return invalid(); }
  let value = 0n;
  for (const character of address) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) { return invalid(); }
    value = value * 58n + BigInt(digit);
  }
  const significant = value === 0n ? Buffer.alloc(0) : Buffer.from(value.toString(16).padStart(Math.ceil(value.toString(16).length / 2) * 2, "0"), "hex");
  const leading = address.match(/^1*/)?.[0].length ?? 0;
  if (leading + significant.length !== 32) { return invalid(); }
  return Buffer.concat([Buffer.alloc(leading), significant]);
}
function data(encoded: string, length: number): Buffer {
  if (typeof encoded !== "string") { return invalid(); }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== length || decoded.toString("base64") !== encoded) { return invalid(); }
  return decoded;
}
function checkAccount(account: MintAccountMeta | undefined, address: string): void {
  if (!account || account.address !== address || account.isWritable !== true ||
    account.isSigner !== true) { return invalid(); }
}
function validateExpectation(expected: SolanaMintExpectation): { rent: bigint; payerBytes: Buffer } {
  if (expected.testOnly !== true || expected.cluster !== "solana-devnet" ||
    expected.payer === expected.mint || [SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM].includes(expected.payer) ||
    [SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM].includes(expected.mint)) { return invalid(); }
  const payerBytes = publicKey(expected.payer);
  publicKey(expected.mint);
  if (typeof expected.rentLamports !== "bigint" &&
    (typeof expected.rentLamports !== "string" || !/^[1-9][0-9]*$/.test(expected.rentLamports))) { return invalid(); }
  const rent = BigInt(expected.rentLamports);
  // Exact RPC-quoted rent is additionally bounded to 0.01 test SOL for this 82-byte mint.
  if (rent <= 0n || rent > 10_000_000n) { return invalid(); }
  return { rent, payerBytes };
}
/** Checks actual instruction bytes, not names or caller-supplied decoded field summaries. */
export function verifySolanaMintIntent(intent: SolanaMintIntent, expected: SolanaMintExpectation): SolanaMintEnvelope {
  const { rent, payerBytes } = validateExpectation(expected);
  if (intent.feePayer !== expected.payer || !Array.isArray(intent.instructions) || intent.instructions.length !== 2) { return invalid(); }
  const [create, initialize] = intent.instructions;
  if (!create || !initialize || create.programId !== SYSTEM_PROGRAM || initialize.programId !== SPL_TOKEN_PROGRAM ||
    create.accounts.length !== 2 || initialize.accounts.length !== 1) { return invalid(); }
  checkAccount(create.accounts[0], expected.payer);
  checkAccount(create.accounts[1], expected.mint);
  // Input is decompiled transaction metadata: createAccount promotes mint to signer globally.
  checkAccount(initialize.accounts[0], expected.mint);
  const createData = data(create.dataBase64, 52);
  if (createData.readUInt32LE(0) !== 0 || createData.readBigUInt64LE(4) !== rent ||
    createData.readBigUInt64LE(12) !== 82n || !createData.subarray(20).equals(publicKey(SPL_TOKEN_PROGRAM))) { return invalid(); }
  const mintData = data(initialize.dataBase64, 35);
  if (mintData[0] !== 20 || mintData[1] !== 9 || !mintData.subarray(2, 34).equals(payerBytes) || mintData[34] !== 0) { return invalid(); }
  return { schema: "agtmai-solana-mint-v1", cluster: "solana-devnet", payer: expected.payer,
    mint: expected.mint, rentLamports: rent.toString(), decimals: 9, initialSupply: "0", freezeAuthority: null,
    instructions: intent.instructions.map(instruction => ({ programId: instruction.programId,
      dataBase64: instruction.dataBase64, accounts: instruction.accounts.map((account: MintAccountMeta) => ({
        address: account.address, isSigner: account.isSigner, isWritable: account.isWritable,
      })) })),
  };
}
