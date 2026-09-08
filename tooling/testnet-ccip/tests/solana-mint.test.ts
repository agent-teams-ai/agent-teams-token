import assert from "node:assert/strict";
import test from "node:test";
import { verifySolanaMintIntent, SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM } from "../src/domain/solana-mint.ts";
import type { SolanaMintIntent, SolanaMintExpectation } from "../src/domain/solana-mint.ts";

const payer = "1".repeat(31) + "2";
const mint = "1".repeat(31) + "3";
const tokenBytes = Buffer.from("06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9", "hex");
const expected: SolanaMintExpectation = { testOnly: true, cluster: "solana-devnet", payer, mint, rentLamports: 1_461_600n };
function fixture(): SolanaMintIntent {
  const create = Buffer.alloc(52); create.writeBigUInt64LE(1_461_600n, 4); create.writeBigUInt64LE(82n, 12);
  tokenBytes.copy(create, 20);
  const init = Buffer.alloc(35); init[0] = 20; init[1] = 9; init[33] = 1;
  return { feePayer: payer, instructions: [
    { programId: SYSTEM_PROGRAM, dataBase64: create.toString("base64"), accounts: [
      { address: payer, isSigner: true, isWritable: true }, { address: mint, isSigner: true, isWritable: true },
    ] },
    { programId: SPL_TOKEN_PROGRAM, dataBase64: init.toString("base64"),
      accounts: [{ address: mint, isSigner: true, isWritable: true }] },
  ] };
}
function alteredData(index: number, change: (data: Buffer) => Buffer | void): SolanaMintIntent {
  const intent = fixture();
  return { ...intent, instructions: intent.instructions.map((instruction, i) => {
    if (i !== index) { return instruction; }
    const data = Buffer.from(instruction.dataBase64, "base64");
    return { ...instruction, dataBase64: (change(data) ?? data).toString("base64") };
  }) };
}
test("exact official52byte create and35byte InitializeMint2 preserve zero supply/freezeNone", () => {
  const input = fixture(); const result = verifySolanaMintIntent(input, expected);
  assert.equal(result.rentLamports, "1461600"); assert.equal(result.initialSupply, "0");
  assert.equal(result.decimals, 9); assert.equal(result.freezeAuthority, null);
  assert.notEqual(result.instructions, input.instructions);
  assert.equal(JSON.stringify(result), JSON.stringify(verifySolanaMintIntent(input, { ...expected, rentLamports: "1461600" })));
});
test("rejects extras including mintTo, altered order and missing instruction", () => {
  const input = fixture();
  for (const instructions of [input.instructions.slice(0, 1), input.instructions.toReversed(),
    [...input.instructions, { ...input.instructions[1]!, dataBase64: Buffer.from([7, 1]).toString("base64") }]]) {
    assert.throws(() => verifySolanaMintIntent({ ...input, instructions }, expected));
  }
});
test("rejects rent, space, owner and system instruction discriminator mutations", () => {
  for (const change of [
    (data: Buffer) => { data.writeUInt32LE(2, 0); },
    (data: Buffer) => { data.writeBigUInt64LE(1_461_601n, 4); },
    (data: Buffer) => { data.writeBigUInt64LE(165n, 12); },
    (data: Buffer) => { data[20] = 0; },
    (data: Buffer) => Buffer.concat([data, Buffer.from([0])]),
  ]) { assert.throws(() => verifySolanaMintIntent(alteredData(0, change), expected)); }
});
test("rejects freezeSome,wrongdecimals,wrongauthority and trailing padded option bytes", () => {
  for (const change of [
    (data: Buffer) => { data[0] = 0; }, (data: Buffer) => { data[1] = 18; },
    (data: Buffer) => { data[33] = 2; }, (data: Buffer) => { data[34] = 1; },
    (data: Buffer) => Buffer.concat([data, Buffer.alloc(32)]),
  ]) { assert.throws(() => verifySolanaMintIntent(alteredData(1, change), expected)); }
});
test("requires exact compiled account privileges, identities,programs and fee payer", () => {
  const input = fixture();
  for (const patch of [{ isSigner: false }, { isWritable: false }, { address: payer }]) {
    const instructions = [input.instructions[0]!, { ...input.instructions[1]!, accounts: [{ ...input.instructions[1]!.accounts[0]!, ...patch }] }];
    assert.throws(() => verifySolanaMintIntent({ ...input, instructions }, expected));
  }
  assert.throws(() => verifySolanaMintIntent({ ...input, feePayer: mint }, expected));
  assert.throws(() => verifySolanaMintIntent({ ...input, instructions: [{ ...input.instructions[0]!, programId: SPL_TOKEN_PROGRAM }, input.instructions[1]!] }, expected));
  assert.throws(() => verifySolanaMintIntent({ ...input, instructions: [{ ...input.instructions[0]!, accounts: [...input.instructions[0]!.accounts, input.instructions[0]!.accounts[0]!] }, input.instructions[1]!] }, expected));
});
test("rejects mainnet labels,invalidaddresses,noncanonicalbase64 and unbounded/nonexactrent", () => {
  for (const patch of [{ testOnly: false }, { cluster: "mainnet-beta" }, { mint: payer },
    { mint: "1".repeat(33) }, { mint: "0".repeat(32) }, { rentLamports: "01461600" },
    { rentLamports: -1n }, { rentLamports: 0n }, { rentLamports: 10_000_001n }, { rentLamports: 1461600 }]) {
    assert.throws(() => verifySolanaMintIntent(fixture(), { ...expected, ...patch } as SolanaMintExpectation));
  }
  const input = fixture();
  assert.throws(() => verifySolanaMintIntent({ ...input, instructions: [
    { ...input.instructions[0]!, dataBase64: input.instructions[0]!.dataBase64 + "\n" }, input.instructions[1]!,
  ] }, expected));
});
