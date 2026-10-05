import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replacementFixture } from "../src/domain/replacement-fixture.ts";
import { registrationInstruction, verifySolanaRegistrationIntent } from "../src/domain/solana-registration.ts";
import type { SolanaRegistrationExpectation } from "../src/domain/solana-registration.ts";
import { verifySolanaPoolInitIntent, BURNMINT_PROGRAM, BURNMINT_PROGRAM_DATA, POOL_GLOBAL } from "../src/domain/solana-pool-init.ts";
import { SYSTEM_PROGRAM } from "../src/domain/solana-mint.ts";
import { runSolanaRegistrationJournal } from "../src/application/solana-registration-journal.ts";
import type { SolanaRegistrationRecord, SolanaRegistrationPorts } from "../src/application/solana-registration-journal.ts";
import { runSolanaPoolInitJournal } from "../src/application/solana-pool-init-journal.ts";
import type { SolanaPoolInitJournalRecord, SolanaPoolInitJournalPorts } from "../src/application/solana-pool-init-journal.ts";
import { createJournalFile } from "../src/adapters/evm-journal-file.ts";
import { verifyPoolConfigPredecessor } from "../src/composition/configure-solana-pool.mjs";

// Public synthetic peers; signatures and decoded observations are in-memory test evidence.
const fixture = replacementFixture("0x" + "11".repeat(20), "0x" + "22".repeat(20));
const expected = { testOnly: true as const, cluster: "solana-devnet" as const,
  payer: fixture.payer, mint: fixture.mint, pool: fixture.solanaPool, fixture };
const signed = { bytesBase64: "c2lnbmVk", signature: "2".repeat(88), blockhash: "3".repeat(44), lastValidBlockHeight: "150" };
const messageBase64 = "bWVzc2FnZQ==";
const registration: SolanaRegistrationExpectation = { ...expected, operation: "transfer-mint-authority",
  signer: "1".repeat(31) + "2", ata: "1".repeat(31) + "3", registry: "1".repeat(31) + "4", routerConfig: "1".repeat(31) + "5" };
const registrationIntent = { feePayer: expected.payer, instructions: [registrationInstruction(registration)] };

// The real registration writer and file adapter feed the actual composition predecessor boundary.
test("selected registration journal survives finalized pool-config predecessor reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "replacement-predecessor-"));
  try {
    const path = join(directory, "registration.json"), file = createJournalFile<SolanaRegistrationRecord>(path);
    let observations = 0;
    const rpc: Pick<SolanaRegistrationPorts, "observe"> = { observe: async () => {
      observations++;
      return { kind: "finalized", ...signed, messageBase64, slot: "100", err: null,
        state: { operation: registration.operation, mint: expected.mint, verified: true } };
    } };
    const inspectSigned = async () => ({ ...signed, messageBase64, intent: registrationIntent });
    const result = await runSolanaRegistrationJournal(registration, { ...file, ...rpc, inspectSigned,
      sign: async () => signed, broadcast: async () => assert.fail("Finalized checkpoint cannot send") });
    assert.equal(result.status, "succeeded");
    const persisted = await file.exclusive(() => file.read());
    const provider = { derive: (intent: SolanaRegistrationExpectation) => intent, inspectSigned };
    await verifyPoolConfigPredecessor({ registrationJournalFile: path, journalDirectory: directory },
      { ...expected, operation: "init-chain-remote-config" },
      { sdk: provider, rpc, registrationSdk: provider, registrationRpc: rpc });
    assert.deepEqual(persisted?.intent.fixture, fixture);
    assert.equal(observations, 2, "Predecessor must re-observe the finalized checkpoint");
    assert.deepEqual(await file.exclusive(() => file.read()), persisted);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("legacy registration retains its exact envelope serialization and no fixture property", () => {
  const { fixture: _fixture, ...legacy } = registration;
  const envelope = verifySolanaRegistrationIntent(registrationIntent, legacy);
  assert.equal(Object.hasOwn(envelope, "fixture"), false);
  assert.equal(JSON.stringify(envelope), JSON.stringify({ schema: "agtmai-solana-registration-v1", testOnly: true,
    cluster: legacy.cluster, operation: legacy.operation, payer: legacy.payer, mint: legacy.mint, pool: legacy.pool,
    signer: legacy.signer, ata: legacy.ata, registry: legacy.registry, routerConfig: legacy.routerConfig,
    instructions: registrationIntent.instructions }));
});

const initIntent = { feePayer: expected.payer, instructions: [{ programId: BURNMINT_PROGRAM,
  dataBase64: "r69tHw2Ym+0=", accounts: [expected.pool, expected.mint, expected.payer, SYSTEM_PROGRAM,
    BURNMINT_PROGRAM, BURNMINT_PROGRAM_DATA, POOL_GLOBAL].map((address, i) => ({ address, isSigner: i === 2, isWritable: i === 0 || i === 2 })) }] };
function resume(record: SolanaPoolInitJournalRecord) {
  const counters = { inspect: 0, observe: 0, write: 0, sign: 0, send: 0 };
  const ports: SolanaPoolInitJournalPorts = { exclusive: work => work(), read: async () => record,
    write: async next => { counters.write++; record = next; },
    inspectSigned: async () => { counters.inspect++; return { ...signed, messageBase64, intent: initIntent }; },
    observe: async () => { counters.observe++; return { kind: "not-found" }; },
    sign: async () => { counters.sign++; return signed; },
    broadcast: async () => { counters.send++; return signed.signature; } };
  return { counters, ports, read: () => record };
}
function initRecord(): SolanaPoolInitJournalRecord {
  return { schema: "agtmai-solana-pool-init-journal-v1", intent: verifySolanaPoolInitIntent(initIntent, expected),
    signed, messageBase64, phase: "signed" };
}
// Only stored metadata changes. Rejection must precede even signed inspection, with no journal or send effects.
test("pool-init rejects missing, different valid and mutated stored fixtures before all effects", async t => {
  const different = replacementFixture("0x" + "33".repeat(20), "0x" + "44".repeat(20));
  for (const [name, stored] of [["missing", undefined], ["different valid", different], ["mutated hash", { ...fixture, identity: "0".repeat(64) }],
    ["mutated peer", { ...fixture, token: different.token }], ["extra field", { ...fixture, extra: true }]] as const) {
    await t.test(name, async () => {
    const record = initRecord();
    const { fixture: _fixture, ...intent } = record.intent;
    const changed = { ...record, intent: { ...intent, ...(stored === undefined ? {} : { fixture: stored }) } } as SolanaPoolInitJournalRecord;
    const before = JSON.stringify(changed), state = resume(changed);
    let rejection: unknown;
    try { await runSolanaPoolInitJournal(expected, state.ports); } catch (error) { rejection = error; }
    assert.ok(rejection instanceof Error, "Expected rejection; effects=" + JSON.stringify(state.counters));
    assert.match(rejection.message, /fixture/i);
    assert.deepEqual(state.counters, { inspect: 0, observe: 0, write: 0, sign: 0, send: 0 });
    assert.equal(JSON.stringify(state.read()), before);
    });
  }
});

test("correct selected pool-init resumes once; submitting uncertainty never resends", async () => {
  const state = resume(initRecord());
  assert.equal((await runSolanaPoolInitJournal(expected, state.ports)).record.phase, "submitted");
  assert.deepEqual(state.counters, { inspect: 1, observe: 1, write: 2, sign: 0, send: 1 });
  await runSolanaPoolInitJournal(expected, state.ports);
  assert.equal(state.counters.send, 1);
  assert.deepEqual(state.read().intent.fixture, fixture);
  const uncertain = resume({ ...initRecord(), phase: "submitting" });
  assert.equal((await runSolanaPoolInitJournal(expected, uncertain.ports)).status, "unresolved");
  assert.deepEqual(uncertain.counters, { inspect: 1, observe: 1, write: 0, sign: 0, send: 0 });
});

test("legacy pool-init resumes without introducing fixture metadata", async () => {
  const { fixture: _fixture, ...legacy } = expected;
  const intent = verifySolanaPoolInitIntent(initIntent, legacy);
  assert.equal(Object.hasOwn(intent, "fixture"), false);
  const state = resume({ ...initRecord(), intent });
  await runSolanaPoolInitJournal(legacy, state.ports);
  assert.equal(JSON.stringify(state.read().intent), JSON.stringify(intent));
  assert.equal(state.counters.send, 1);
  const selected = resume(initRecord());
  await assert.rejects(runSolanaPoolInitJournal(legacy, selected.ports), /fixture/i);
  assert.deepEqual(selected.counters, { inspect: 0, observe: 0, write: 0, sign: 0, send: 0 });
});
