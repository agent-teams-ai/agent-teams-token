import assert from "node:assert/strict";
import test from "node:test";
import { assertLoopbackRpcUrl, CLASSIC_TOKEN_PROGRAM, parseAccountState, parseTokenAccountState, parseUnsignedInteger } from "../src/domain/model.ts";

test("canonical bigint parser accepts only unsigned decimal strings", () => {
  assert.equal(parseUnsignedInteger("100000000000000000000", "amount"), 100000000000000000000n);
  for (const value of [1, -1, "-1", "+1", "01", "1.0", " 1", "1e9", null]) {
    assert.throws(() => parseUnsignedInteger(value, "amount"), /SOLANA_INTEGER_INVALID/u);
  }
});

test("RPC policy accepts exact IPv4 loopback only", () => {
  assert.equal(assertLoopbackRpcUrl("http://127.0.0.1:8899/").port, "8899");
  for (const value of ["https://127.0.0.1:8899/", "http://localhost:8899/", "http://[::1]:8899/", "http://127.0.0.1:80/", "http://127.0.0.1:8899/path", "http://user@127.0.0.1:8899/", "http://127.0.0.1:8899/?next=http://evil.test"]) {
    assert.throws(() => assertLoopbackRpcUrl(value), /SOLANA_RPC_/u, value);
  }
});

test("strict account parsing rejects Token-2022, decimals and malformed integers", () => {
  const mint = { owner: CLASSIC_TOKEN_PROGRAM, data: { parsed: { type: "mint", info: { decimals: 9, supply: "0", mintAuthority: "mint", freezeAuthority: null } } } };
  assert.equal(parseAccountState(mint, "address").supply, "0");
  assert.throws(() => parseAccountState({ ...mint, owner: "TokenzQdYToken2022" }, "address"), /SOLANA_MINT_PROGRAM/u);
  assert.throws(() => parseAccountState({ ...mint, data: { parsed: { type: "mint", info: { decimals: 9, supply: "01", mintAuthority: "mint", freezeAuthority: null } } } }, "address"), /SOLANA_INTEGER_INVALID/u);
  const token = { owner: CLASSIC_TOKEN_PROGRAM, data: { parsed: { type: "account", info: { mint: "mint", owner: "owner", tokenAmount: { amount: "0" } } } } };
  assert.equal(parseTokenAccountState(token, "ata").amount, "0");
  assert.throws(() => parseTokenAccountState({ ...token, owner: "Token2022" }, "ata"), /SOLANA_TOKEN_ACCOUNT_PROGRAM/u);
});
