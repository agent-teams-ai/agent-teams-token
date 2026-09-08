import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTestToken } from "../src/composition/register-token.ts";
import type { RegistrationSettings } from "../src/composition/register-token.ts";
import { testTokenConstructor } from "../src/composition/deploy-token.ts";
import { lockReleaseConstructor } from "../src/domain/evm-pool.ts";
import { validateSepoliaIntent } from "../src/domain/evm-intent.ts";
import type { EvmJournalRecord } from "../src/application/evm-journal.ts";
const admin = "0x" + "1".repeat(40), token = "0x" + "2".repeat(40), pool = "0x" + "3".repeat(40);
const zero = "0x" + "0".repeat(40), hash = "0x" + "a".repeat(64);
function fixture() {
  const deployment = (isPool: boolean) => {
    const constructorBytes = isPool ? lockReleaseConstructor(token) : testTokenConstructor(admin);
    return { journalFile: join(tmpdir(), isPool ? "reg-test-pool.json" : "reg-test-token.json"), intent: {
      chainId: "11155111", kind: "deploy" as const, from: admin, nonce: isPool ? "1" : "0", value: "0",
      data: "0x6000" + constructorBytes.slice(2), deployment: {
        artifactId: isPool ? "@chainlink/contracts-ccip@1.6.1/LockReleaseTokenPool" : "AGTMAICCIPToken",
        artifactSha256: isPool ? "82dac8896b84a7abe909e076a4de830258e19f5aae50f48ce17cfe8305f74114" : "b".repeat(64),
        creationBytecode: "0x6000", constructorBytes, administrator: admin,
        administratorBinding: isPool ? "sender" as const : "constructor-word-2" as const,
      },
    } };
  };
  const settings: RegistrationSettings = { testOnly: true, token, pool, administrator: admin,
    signer: { testOnly: true, executable: "unused", executableSha256: "", keystore: "unused", passwordFile: "unused",
      gasLimit: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1" },
    tokenDeployment: deployment(false), poolDeployment: deployment(true), steps: {
      "register-admin": { journalFile: join(tmpdir(), "reg-test-register.json"), nonce: "2" },
      "accept-admin": { journalFile: join(tmpdir(), "reg-test-accept.json"), nonce: "3" },
      "set-pool": { journalFile: join(tmpdir(), "reg-test-set.json"), nonce: "4" },
    } };
  const records = new Map<string, EvmJournalRecord>();
  for (const d of [settings.tokenDeployment, settings.poolDeployment]) {
    records.set(d.journalFile, { schema: "agtmai-evm-journal-v1", intent: validateSepoliaIntent(d.intent, d.intent),
      signed: { bytes: "0x1234", hash: d === settings.tokenDeployment ? hash : "0x" + "b".repeat(64) }, phase: "succeeded",
      receipt: { transactionHash: d === settings.tokenDeployment ? hash : "0x" + "b".repeat(64), blockHash: hash, blockNumber: "10", status: 1 } });
  }
  const calls: string[] = [];
  const ports = {
    read: async (file: string) => { const record = records.get(file); if (!record) { throw Object.assign(new Error("absent"), { code: "ENOENT" }); } return record; },
    observe: async (txHash: string) => {
      const r = [...records.values()].find(candidate => candidate.signed.hash === txHash)!;
      return { kind: "observed" as const, transaction: { hash: txHash, chainId: "11155111", from: admin, to: r.intent.to,
        data: r.intent.data, nonce: r.intent.nonce, value: "0" }, receipt: r.receipt!, finalizedBlock: { hash, number: "10" } };
    },
    address: async (r: EvmJournalRecord) => r.intent.nonce === "0" ? token : pool,
    snapshot: async () => ({ chainId: "11155111" as const, finalizedBlockHash: hash, token, tokenAdmin: admin,
      administrator: zero, pendingAdministrator: zero, tokenPool: zero, poolToken: token, poolOwner: admin }),
    execute: async (intent: Parameters<typeof validateSepoliaIntent>[0], config: { journalFile: string }) => {
      calls.push(config.journalFile); assert.equal(intent.to, "0xa3c796d480638d7476792230da1e2ada86e031b0");
      assert.equal(intent.data, "0xff12c354" + token.slice(2).padStart(64, "0"));
      return { status: "unresolved", reason: "submitted-awaiting-observation", transactionHash: hash };
    },
  };
  return { settings, ports, records, calls };
}
test("runs only the next finalized-state step with its exact journal/intent", async () => {
  const f = fixture(); const result = await registerTestToken(f.settings, f.ports);
  assert.equal(result.step, "register-admin"); assert.equal(result.status, "unresolved");
  assert.deepEqual(f.calls, [f.settings.steps["register-admin"].journalFile]);
});
test("rejects wrong deployment address or unfinished deployment before executing", async () => {
  const f = fixture();
  await assert.rejects(registerTestToken(f.settings, { ...f.ports, address: async () => admin }), /address mismatch/);
  const record = f.records.get(f.settings.tokenDeployment.journalFile)!;
  f.records.set(f.settings.tokenDeployment.journalFile, { ...record, phase: "submitted" });
  await assert.rejects(registerTestToken(f.settings, f.ports), /Finalized deployment/); assert.equal(f.calls.length, 0);
});
test("rejects reused journals and deployment intent mismatch", async () => {
  const f = fixture();
  await assert.rejects(registerTestToken({ ...f.settings, steps: { ...f.settings.steps,
    "set-pool": f.settings.steps["accept-admin"] } }, f.ports), /Distinct/);
  await assert.rejects(registerTestToken({ ...f.settings, tokenDeployment: { ...f.settings.tokenDeployment,
    intent: { ...f.settings.tokenDeployment.intent, nonce: "42" } } }, f.ports), /Conflicting journal/);
  assert.equal(f.calls.length, 0);
});
test("complete finalized state returns success without another transaction", async () => {
  const f = fixture(); const result = await registerTestToken(f.settings, { ...f.ports,
    snapshot: async () => ({ ...await f.ports.snapshot(), administrator: admin, tokenPool: pool }) });
  assert.equal(result.status, "succeeded"); assert.equal(f.calls.length, 0);
});
test("accept and set-pool use separate bounded steps", async () => {
  for (const kind of ["accept-admin", "set-pool"] as const) {
    const f = fixture();
    const result = await registerTestToken(f.settings, { ...f.ports,
      snapshot: async () => ({ ...await f.ports.snapshot(),
        ...(kind === "accept-admin" ? { pendingAdministrator: admin } : { administrator: admin }) }),
      execute: async (intent, config) => {
        assert.equal(config.journalFile, f.settings.steps[kind].journalFile);
        assert.equal(intent.nonce, f.settings.steps[kind].nonce);
        assert.equal(intent.to, "0x95f29fee11c5c55d26cccf1db6772de953b37b82");
        assert.ok(intent.data.startsWith(kind === "accept-admin" ? "0x156194da" : "0x4e847fc7"));
        return { status: "unresolved", reason: "submitted-awaiting-observation", transactionHash: hash };
      },
    }); assert.equal(result.step, kind);
  }
});
test("unknown prior registration journal blocks advancement despite registry progress", async () => {
  const f = fixture();
  f.records.set(f.settings.steps["register-admin"].journalFile,
    { ...f.records.get(f.settings.tokenDeployment.journalFile)!, phase: "submitted" });
  const result = await registerTestToken(f.settings, { ...f.ports,
    snapshot: async () => ({ ...await f.ports.snapshot(), pendingAdministrator: admin }) });
  assert.equal(result.status, "unresolved"); assert.equal(result.step, "register-admin");
  assert.equal(f.calls.length, 1);
});
