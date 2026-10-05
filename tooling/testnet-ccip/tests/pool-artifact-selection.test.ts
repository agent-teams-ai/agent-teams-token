import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { selectPoolArtifact, assertSelectedPoolAddress } from "../src/adapters/pool-artifact-selection.ts";
import { deployTestPool, loadOfficialPoolArtifact } from "../src/composition/deploy-pool.ts";
import { registerTestToken } from "../src/composition/register-token.ts";
import { testTokenConstructor } from "../src/composition/deploy-token.ts";
import { fixtureNamespace, replacementFixture } from "../src/domain/replacement-fixture.ts";
import { validateSepoliaIntent } from "../src/domain/evm-intent.ts";
import type { EvmJournalRecord } from "../src/application/evm-journal.ts";
import type { RegistrationSettings } from "../src/composition/register-token.ts";
import { runEvmJournal } from "../src/application/evm-journal.ts";
const fixture = replacementFixture("0x812c4dcbc459a55f8517e87e825b8c728cee7316", "0x8472aa06661671e7e4af43048f0d0446eff2e97d");
const selection = { testOnly: true as const, fixture, fixtureIdentity: fixture.identity, poolArtifactProfile: "replacement-source-built-test-v1" as const };
const artifactFile = fileURLToPath(new URL("./fixtures/source-built-test-pool/LockReleaseTokenPool.source-built.json", import.meta.url));
const hash = "0x" + "ab".repeat(32), zero = "0x" + "00".repeat(20);
const word = (n: string) => n.padStart(64, "0");
function constructorOracle(): string {
  const result = spawnSync(resolve(".tools/foundry-v1.8.0-linux-x64/cast"), ["abi-encode", "f(address,uint8,address[],address,address)",
    fixture.token, "9", "[]", "0xba3f6251de62ded61ff98590cb2fdf6871fbb991", "0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59"], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pool-admission-")), directory = join(root, fixtureNamespace(fixture));
  await mkdir(directory, { mode: 0o700 });
  const artifact = await selectPoolArtifact(selection, loadOfficialPoolArtifact).load(artifactFile);
  const records = new Map<string, EvmJournalRecord>(), effects: unknown[] = [];
  const deployment = (pool: boolean) => {
    const creationBytecode = pool ? artifact.creationBytecode : "0x6000", constructorBytes = pool ? constructorOracle() : testTokenConstructor(fixture.administrator);
    const intent = { chainId: "11155111", kind: "deploy" as const, from: fixture.administrator, nonce: pool ? "1" : "0", value: "0",
      data: creationBytecode + constructorBytes.slice(2), deployment: { artifactId: pool ? "@chainlink/contracts-ccip@1.6.1/LockReleaseTokenPool/source-built-test-v1" : "AGTMAICCIPToken",
        artifactSha256: pool ? artifact.artifactSha256 : "ab".repeat(32), creationBytecode, constructorBytes, administrator: fixture.administrator,
        administratorBinding: pool ? "sender" as const : "constructor-word-2" as const } };
    const journalFile = join(directory, pool ? "pool" : "token");
    records.set(journalFile, { schema: "agtmai-evm-journal-v1", intent: validateSepoliaIntent(intent, intent), phase: "succeeded",
      signed: { bytes: "0x1234", hash: pool ? "0x" + "cd".repeat(32) : hash }, receipt: { transactionHash: pool ? "0x" + "cd".repeat(32) : hash, blockHash: hash, blockNumber: "10", status: 1 } });
    return { artifactFile, journalFile, intent };
  };
  const settings: RegistrationSettings = { ...selection, administrator: fixture.administrator, token: fixture.token, pool: fixture.pool,
    signer: { testOnly: true, executable: "unused", executableSha256: "", keystore: "unused", passwordFile: "unused", gasLimit: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1" },
    tokenDeployment: deployment(false), poolDeployment: deployment(true), steps: { "register-admin": { journalFile: join(directory, "register"), nonce: "2" },
      "accept-admin": { journalFile: join(directory, "accept"), nonce: "3" }, "set-pool": { journalFile: join(directory, "set"), nonce: "4" } } };
  const read = async (file: string) => { const r = records.get(file); if (!r) { throw Object.assign(new Error("absent"), { code: "ENOENT" }); } return r; };
  const ports = { poolArtifact: loadOfficialPoolArtifact, read, tokenDecimals: async () => "0x" + word("9"),
    observe: async (h: string) => { const r = [...records.values()].find(candidate => candidate.signed.hash === h)!; return { kind: "observed" as const,
      transaction: { hash: h, chainId: "11155111", from: fixture.administrator, to: null, nonce: r.intent.nonce, data: r.intent.data, value: "0" },
      receipt: r.receipt!, finalizedBlock: { hash, number: "10" } }; },
    address: async (r: EvmJournalRecord) => r.intent.nonce === "0" ? fixture.token : fixture.pool,
    snapshot: async () => ({ chainId: "11155111" as const, finalizedBlockHash: hash, token: fixture.token, tokenAdmin: fixture.administrator,
      administrator: zero, pendingAdministrator: zero, tokenPool: zero, poolToken: fixture.token, poolOwner: fixture.administrator }),
    execute: async (intent: Parameters<typeof validateSepoliaIntent>[0], config: { journalFile: string }) => { effects.push({ intent, config }); return { status: "unresolved", reason: "unknown", transactionHash: hash }; } };
  const tokenSettings = { ...selection, administrator: fixture.administrator, nonce: "0", artifactFile, artifactSha256: "ab".repeat(32), journalFile: settings.tokenDeployment.journalFile, signer: settings.signer };
  const tokenSettingsFile = join(directory, "settings.json");
  await writeFile(tokenSettingsFile, JSON.stringify(tokenSettings), { mode: 0o600 });
  await writeFile(tokenSettings.journalFile, JSON.stringify(await read(tokenSettings.journalFile)), { mode: 0o600 });
  const poolSettings = { ...selection, tokenSettingsFile, artifactFile, journalFile: settings.poolDeployment.journalFile, nonce: "1", signer: settings.signer };
  const poolPorts = { reconcile: async () => ({ status: "succeeded", reason: "finalized", transactionHash: hash }), execute: ports.execute,
    request: (_endpoint: string) => async (method: string, _params: readonly unknown[]) => method === "eth_call" ? "0x" + word("9") : { transactionHash: hash, blockHash: hash, status: "0x1", contractAddress: fixture.token } };
  return { root, directory, settings, records, effects, ports, poolSettings, poolPorts, tokenSettingsFile };
}
test("exact replacement bytes and CREATE identity bind both deployment and registration", async () => {
  const f = await setup(); try {
    assertSelectedPoolAddress(fixture.administrator, "1", fixture.pool);
    assert.throws(() => assertSelectedPoolAddress(fixture.administrator, "2", fixture.pool), /mismatch/);
    await assert.rejects(deployTestPool({ ...f.poolSettings, nonce: "2" }, f.poolPorts), /CREATE address mismatch/);
    await assert.rejects(deployTestPool(f.poolSettings, { ...f.poolPorts, request: () => async method => method === "eth_call" ? "0x" + word("12") :
      { transactionHash: hash, blockHash: hash, status: "0x1", contractAddress: fixture.token } }), /decimals mismatch/);
    await assert.rejects(deployTestPool(f.poolSettings, { ...f.poolPorts, request: () => async () =>
      ({ transactionHash: hash, blockHash: hash, status: "0x1", contractAddress: fixture.pool }) }), /identity\/decimals mismatch/);
    assert.equal(f.effects.length, 0);
    await deployTestPool(f.poolSettings, f.poolPorts);
    assert.deepEqual((f.effects[0] as { intent: unknown }).intent, f.settings.poolDeployment.intent);
    f.effects.length = 0; assert.equal((await registerTestToken(f.settings, f.ports)).step, "register-admin");
    assert.equal(f.effects.length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("absence calls only legacy; explicit malformed/unknown selectors and foreign fixtures never fall back", async () => {
  let calls = 0; const legacy = async () => { calls++; return { artifactSha256: "legacy", creationBytecode: "0x6000" }; };
  assert.equal((await selectPoolArtifact({ testOnly: true }, legacy).load("unused")).artifactSha256, "legacy");
  for (const changed of [{ poolArtifactProfile: undefined }, { poolArtifactProfile: null }, { poolArtifactProfile: "legacy" },
    { testOnly: false }, { chainId: "1" }, { fixture: undefined }, { fixtureIdentity: "ab".repeat(32) },
    { fixture: replacementFixture("0x" + "12".repeat(20), fixture.pool), fixtureIdentity: replacementFixture("0x" + "12".repeat(20), fixture.pool).identity }]) {
    assert.throws(() => selectPoolArtifact({ ...selection, ...changed } as unknown as typeof selection, legacy));
  }
  assert.equal(calls, 1);
  await assert.rejects(loadOfficialPoolArtifact(artifactFile), /Official pool artifact mismatch/);
});
test("source/compiler/input/ABI drift, copied pin text and replacement-to-legacy fallback reject before reconciliation", async () => {
  const f = await setup(); try {
    const bytes = await readFile(artifactFile, "utf8"), file = join(f.directory, "mutated.json"); let reconciled = 0;
    for (const changed of [bytes + "\n", bytes.replace("0.8.36", "0.8.35"), bytes.replace("LockReleaseTokenPool.sol", "WrongPool.sol"),
      bytes.replace('"uint8"', '"uint16"'), '{"bytecode":{"object":"0x6000"},"sha256":"e90a1b903d867511355a99f5d809ee8e48f856501f6854785ec9b9d59f385751"}']) {
      await writeFile(file, changed); await assert.rejects(deployTestPool({ ...f.poolSettings, artifactFile: file }, { ...f.poolPorts, reconcile: async () => { reconciled++; return f.poolPorts.reconcile(); } }), /artifact mismatch/);
    }
    const { poolArtifactProfile: _profile, ...legacySettings } = f.poolSettings;
    await assert.rejects(deployTestPool(legacySettings, f.poolPorts), /Official pool artifact mismatch/);
    assert.equal(reconciled, 0); assert.equal(f.effects.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("each constructor word, creation bytes, hash, identity, calldata tail and journal mutation blocks registration", async () => {
  const f = await setup(); try {
    const d = f.settings.poolDeployment, original = f.records.get(d.journalFile)!;
    const mutations = [d.intent.data + "00", "0x00" + d.intent.data.slice(4), ...Array.from({ length: 6 }, (_, i) => {
      const start = d.intent.data.length - 384 + i * 64; return d.intent.data.slice(0, start) + "f" + d.intent.data.slice(start + 1);
    })];
    for (const data of mutations) {
      const observe = f.ports.observe; await assert.rejects(registerTestToken(f.settings, { ...f.ports, observe: async h => {
        const o = await observe(h); return h === original.signed.hash ? { ...o, transaction: { ...o.transaction, data } } : o;
      } }), /calldata mismatch/);
    }
    for (const change of [{ artifactSha256: "ab".repeat(32) }, { artifactId: "@chainlink/contracts-ccip@1.6.1/LockReleaseTokenPool" },
      { constructorBytes: constructorOracle() + "00" }, { administrator: fixture.token }, { administratorBinding: "constructor-word-2" as const }, { creationBytecode: "0x6000" }]) {
      await assert.rejects(registerTestToken({ ...f.settings, poolDeployment: { ...d, intent: { ...d.intent, deployment: { ...d.intent.deployment!, ...change } } } }, f.ports));
    }
    f.records.set(d.journalFile, { ...original, intent: { ...original.intent, nonce: "2" } });
    await assert.rejects(registerTestToken(f.settings, f.ports), /Conflicting journal/);
    assert.equal(f.effects.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("foreign addresses/decimals, unfinished or unknown prerequisites, namespace/symlink and public journals fail closed", async () => {
  const f = await setup(); try {
    for (const change of [{ token: fixture.pool }, { pool: fixture.token }, { administrator: fixture.token }]) {
      await assert.rejects(registerTestToken({ ...f.settings, ...change }, f.ports));
    }
    await assert.rejects(registerTestToken(f.settings, { ...f.ports, address: async () => fixture.administrator }), /address mismatch/);
    await assert.rejects(registerTestToken(f.settings, { ...f.ports, tokenDecimals: async () => "0x" + word("12") }), /decimals mismatch/);
    for (const phase of ["submitted", "submitting", "reverted"] as const) {
      const tokenRecord = f.records.get(f.settings.tokenDeployment.journalFile)!;
      await writeFile(f.settings.tokenDeployment.journalFile, JSON.stringify({ ...tokenRecord, phase }));
      await assert.rejects(deployTestPool(f.poolSettings, f.poolPorts), /Finalized replacement/);
    }
    for (const kind of ["unknown", "not-found"] as const) {
      await assert.rejects(registerTestToken(f.settings, { ...f.ports, observe: async h => h === hash ? f.ports.observe(h) : { kind } }), /observation unavailable/);
    }
    const poolRecord = f.records.get(f.settings.poolDeployment.journalFile)!;
    f.records.set(f.settings.poolDeployment.journalFile, { ...poolRecord, phase: "reverted" });
    await assert.rejects(registerTestToken(f.settings, f.ports), /Finalized deployment/); f.records.set(f.settings.poolDeployment.journalFile, poolRecord);
    await assert.rejects(registerTestToken({ ...f.settings, poolDeployment: { ...f.settings.poolDeployment, journalFile: join(f.root, "legacy") } }, f.ports), /namespace/);
    await symlink(f.root, join(f.directory, "alias"));
    await assert.rejects(deployTestPool({ ...f.poolSettings, journalFile: join(f.directory, "alias", "pool") }, f.poolPorts), /symlink/);
    await chmod(f.settings.tokenDeployment.journalFile, 0o640); await assert.rejects(registerTestToken(f.settings, f.ports), /Private owned/);
    await chmod(f.settings.tokenDeployment.journalFile, 0o600);
    await chmod(f.directory, 0o755); await assert.rejects(registerTestToken(f.settings, f.ports), /Private owned/);
    assert.equal(f.effects.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("source selection rejects before observation and mixed token settings before reconciliation", async () => {
  const f = await setup(); try {
    let reads = 0, reconciles = 0;
    await assert.rejects(registerTestToken({ ...f.settings, poolArtifactProfile: undefined }, { ...f.ports, read: async file => { reads++; return f.ports.read(file); } }));
    assert.equal(reads, 0);
    const tokenSettings = JSON.parse(await readFile(f.tokenSettingsFile, "utf8")) as Record<string, unknown>;
    for (const change of [{ fixtureIdentity: "ab".repeat(32) }, { administrator: fixture.token }, { fixture: undefined }]) {
      await writeFile(f.tokenSettingsFile, JSON.stringify({ ...tokenSettings, ...change }));
      await assert.rejects(deployTestPool(f.poolSettings, { ...f.poolPorts, reconcile: async () => { reconciles++; return f.poolPorts.reconcile(); } }));
    }
    assert.equal(reconciles, 0); assert.equal(f.effects.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("replacement uncertain registration reconciles saved intent without advancing or resending", async () => {
  const f = await setup(); try {
    const intent = { chainId: "11155111", kind: "call" as const, from: fixture.administrator, nonce: "2", value: "0",
      to: "0xa3c796d480638d7476792230da1e2ada86e031b0", data: "0xff12c354" + fixture.token.slice(2).padStart(64, "0") };
    const record: EvmJournalRecord = { schema: "agtmai-evm-journal-v1", phase: "submitting", signed: { bytes: "0x1234", hash }, intent: validateSepoliaIntent(intent, intent) };
    f.records.set(f.settings.steps["register-admin"].journalFile, record);
    let executed = 0;
    const result = await registerTestToken(f.settings, { ...f.ports, snapshot: async () => ({ ...await f.ports.snapshot(), pendingAdministrator: fixture.administrator }),
      execute: async actual => {
        executed++; const outcome = await runEvmJournal(actual, intent, { exclusive: work => work(), read: async () => record,
          write: async () => { throw new Error("uncertainty must not mutate"); }, sign: async () => { throw new Error("no new signing"); },
          broadcast: async () => { throw new Error("no resend"); }, inspectSigned: async () => ({ ...record.intent, hash }), observe: async () => ({ kind: "unknown" }) });
        return { status: outcome.status, reason: outcome.reason, transactionHash: hash };
      } });
    assert.equal(result.status, "unresolved"); assert.equal(result.step, "register-admin"); assert.equal(executed, 1); assert.equal(record.phase, "submitting");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
