import assert from "node:assert/strict";
import test from "node:test";
import { nextRemoteConfigStep, remoteConfigCalldata, SOLANA_REMOTE } from "../src/domain/evm-remote-config.ts";
import type { RemoteSnapshot } from "../src/domain/evm-remote-config.ts";
import { configureEvmRemote } from "../src/composition/configure-evm-remote.ts";
import type { RemoteConfigSettings } from "../src/composition/configure-evm-remote.ts";
import type { EvmJournalRecord } from "../src/application/evm-journal.ts";
const a = (n: string): string => "0x" + n.repeat(40);
const target = { testOnly: true as const, token: a("1"), pool: a("2"), administrator: a("3") };
const empty = { enabled: false, capacity: "0", rate: "0" };
const absent: RemoteSnapshot = { registration: { chainId: "11155111", finalizedBlockHash: "0x" + "a".repeat(64),
  token: target.token, tokenAdmin: target.administrator, administrator: target.administrator,
  pendingAdministrator: a("0"), tokenPool: target.pool, poolToken: target.token, poolOwner: target.administrator },
  supported: false, pools: [], token: "0x", inbound: empty, outbound: empty };
const configured: RemoteSnapshot = { ...absent, supported: true, pools: [SOLANA_REMOTE.pool], token: SOLANA_REMOTE.token,
  inbound: { enabled: true, capacity: SOLANA_REMOTE.capacity, rate: SOLANA_REMOTE.rate },
  outbound: { enabled: true, capacity: SOLANA_REMOTE.capacity, rate: SOLANA_REMOTE.rate } };
test("only empty chain is configured; exact registered chain is complete", () => {
  assert.equal(nextRemoteConfigStep(absent, target), "configure");
  assert.equal(nextRemoteConfigStep(configured, target), "complete");
  for (const changed of [ { ...configured, pools: [a("4")] }, { ...configured, pools: [...configured.pools, SOLANA_REMOTE.pool] },
    { ...configured, token: "0x" }, { ...configured, outbound: empty }, { ...absent, inbound: configured.inbound },
    { ...absent, registration: { ...absent.registration, tokenPool: a("0") } },
    { ...absent, registration: { ...absent.registration, poolOwner: a("4") } } ]) {
    assert.throws(() => nextRemoteConfigStep(changed, target));
  }
});
test("calldata has exact pinned ABI words, raw PDA and mint (not program id)", () => {
  const words = remoteConfigCalldata().slice(10).match(/.{64}/g)!;
  assert.equal(remoteConfigCalldata().slice(0, 10), "0xe8a1da17");
  assert.deepEqual(words.slice(0, 17).map(w => BigInt("0x" + w)),
    [64n,96n,0n,1n,32n,16423721717087811551n,288n,416n,1n,10000000000n,1000000000n,1n,10000000000n,1000000000n,1n,32n,32n]);
  assert.equal(words[17], SOLANA_REMOTE.pool.slice(2));
  assert.equal(words[18], "20".padStart(64, "0"));
  assert.equal(words[19], SOLANA_REMOTE.token.slice(2));
});
const settings = { ...target, nonce: "7", journalFile: "/tmp/test-only/config.json", signer: { testOnly: true } } as RemoteConfigSettings;
test("complete external config avoids signing; existing unknown journal still reconciles", async () => {
  let executions = 0;
  const ports = { snapshot: async () => configured, read: async () => null as EvmJournalRecord | null,
    execute: async () => { executions++; return { status: "unresolved", reason: "unknown", transactionHash: "0x123" }; } };
  assert.equal((await configureEvmRemote(settings, ports)).status, "succeeded");
  assert.equal(executions, 0);
  ports.read = async () => ({ phase: "submitted" } as EvmJournalRecord);
  assert.equal((await configureEvmRemote(settings, ports)).status, "unresolved");
  assert.equal(executions, 1);
  ports.read = async () => ({ phase: "signed" } as EvmJournalRecord);
  await assert.rejects(configureEvmRemote(settings, ports), /prerequisites changed/);
  assert.equal(executions, 1);
});
test("finalized journal with missing chain fails without second submission", async () => {
  let executions = 0;
  await assert.rejects(configureEvmRemote(settings, { snapshot: async () => absent,
    read: async () => ({ phase: "succeeded" } as EvmJournalRecord), execute: async () => {
      executions++; return { status: "succeeded", reason: "receipt", transactionHash: "0x123" };
    } }), /transaction\/state mismatch/);
  assert.equal(executions, 1);
});
