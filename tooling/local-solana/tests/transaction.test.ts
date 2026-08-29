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
