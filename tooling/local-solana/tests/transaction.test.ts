import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { base58Decode, base58Encode, signedFreezeAccountTransaction, signedRestoreFreezeTransaction } from "../src/adapters/transaction.ts";
import type { RpcPort } from "../src/application/ports.ts";

test("base58 codec preserves leading zero bytes", () => {
  const bytes = Uint8Array.from([0, 0, 1, 2, 3, 254, 255]); assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
});

test("negative authority transactions contain two full Ed25519 signatures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-tx-test-"));
  try {
    const payer = Uint8Array.from({ length: 64 }, (_v, i) => i + 1); const authority = Uint8Array.from({ length: 64 }, (_v, i) => 200 - i);
    const payerPath = join(directory, "payer.json"); const authorityPath = join(directory, "freeze.json");
    await writeFile(payerPath, JSON.stringify([...payer])); await writeFile(authorityPath, JSON.stringify([...authority]));
    const rpc = { latestBlockhash: async () => base58Encode(new Uint8Array(32)) } as unknown as RpcPort;
    const mint = base58Encode(payer.slice(32)); const freeze = base58Encode(authority.slice(32));
    const context = { rpc, rpcUrl: "http://127.0.0.1:8899/", payerPath, authorityPath };
    for (const bytes of [await signedRestoreFreezeTransaction({ ...context, mint, newAuthority: freeze }), await signedFreezeAccountTransaction({ ...context, account: mint, mint })]) {
      assert.equal(bytes[0], 2); assert.equal(bytes.length > 200, true); assert.notDeepEqual(bytes.slice(1, 65), new Uint8Array(64)); assert.notDeepEqual(bytes.slice(65, 129), new Uint8Array(64));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("message compilation deduplicates a mint that is also the freeze authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-tx-dedup-test-"));
  try {
    const payer = Uint8Array.from({ length: 64 }, (_value, index) => index + 1);
    const authority = Uint8Array.from({ length: 64 }, (_value, index) => 200 - index);
    const payerPath = join(directory, "payer.json"); const authorityPath = join(directory, "freeze.json");
    await writeFile(payerPath, JSON.stringify([...payer])); await writeFile(authorityPath, JSON.stringify([...authority]));
    const rpc = { latestBlockhash: async () => base58Encode(new Uint8Array(32)) } as unknown as RpcPort;
    const mintAndAuthority = base58Encode(authority.slice(32));
    const tokenAccount = base58Encode(Uint8Array.from({ length: 32 }, (_value, index) => 80 + index));
    const context = { rpc, rpcUrl: "http://127.0.0.1:8899/", payerPath, authorityPath };

    const restore = messageFacts(await signedRestoreFreezeTransaction({ ...context, mint: mintAndAuthority, newAuthority: mintAndAuthority }));
    assert.deepEqual(restore.header, [2, 0, 1]);
    assert.equal(restore.accountCount, 3);
    assert.deepEqual(restore.instructionAccounts, [1, 1]);

    const freeze = messageFacts(await signedFreezeAccountTransaction({ ...context, account: tokenAccount, mint: mintAndAuthority }));
    assert.deepEqual(freeze.header, [2, 1, 1]);
    assert.equal(freeze.accountCount, 4);
    assert.deepEqual(freeze.instructionAccounts, [2, 1, 1]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function messageFacts(transaction: Uint8Array): { readonly header: readonly number[]; readonly accountCount: number; readonly instructionAccounts: readonly number[] } {
  const signatureCount = transaction[0]!;
  const messageOffset = 1 + signatureCount * 64;
  const header = Array.from(transaction.slice(messageOffset, messageOffset + 3));
  const accountCount = transaction[messageOffset + 3]!;
  const instructionOffset = messageOffset + 4 + accountCount * 32 + 32;
  assert.equal(transaction[instructionOffset], 1);
  const accountIndexCount = transaction[instructionOffset + 2]!;
  return {
    header,
    accountCount,
    instructionAccounts: Array.from(transaction.slice(instructionOffset + 3, instructionOffset + 3 + accountIndexCount)),
  };
}
