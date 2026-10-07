import assert from "node:assert/strict";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { mkdir, mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestMint } from "../src/composition/create-solana-mint.mjs";
import { initializeTestPool } from "../src/composition/initialize-solana-pool.mjs";
import { registerTestSolanaPool } from "../src/composition/register-solana-pool.mjs";
import { configureTestSolanaPool } from "../src/composition/configure-solana-pool.mjs";
import { TEST_SDK_PROFILE } from "../src/adapters/test-sdk-policy.ts";
import { replacementFixture, fixtureNamespace } from "../src/domain/replacement-fixture.ts";
import { setupObject, parseSetupCli, selectSetup } from "../src/composition/solana-setup-operator.ts";
import type { MintSettings, InitSettings, RegistrationSettings, ConfigSettings } from "../src/composition/solana-setup-operator.ts";

// Default controls require declarations only; native build/sign/recovery units are required in .native.mts.
const fixture = replacementFixture("0x812c4dcbc459a55f8517e87e825b8c728cee7316", "0x8472aa06661671e7e4af43048f0d0446eff2e97d");
const selection = { testOnly: true, providerProfile: TEST_SDK_PROFILE, fixture, fixtureIdentity: fixture.identity,
  providerDirectory: resolve(".local/INPUT/provider"), providerArchives: resolve(".local/INPUT/archives") } as const;
const expected = { testOnly: true, cluster: "solana-devnet", payer: fixture.payer, mint: fixture.mint } as const;
const poolExpected = { ...expected, pool: fixture.solanaPool, fixture };
async function disposable() {
  const root = resolve(".local/setup-operator/units", fixtureNamespace(fixture)); await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, "caller-"));
}

const cases = [
  { name: "mint", file: "mint.json", schema: "agtmai-solana-mint-journal-v1",
    settings: (directory: string): MintSettings => ({ ...selection, expected: { ...expected, rentLamports: "1461600" }, journalFile: join(directory, "mint.json") }),
  },
  { name: "init", file: "init.json", schema: "agtmai-solana-pool-init-journal-v1",
    settings: (directory: string): InitSettings => ({ ...selection, expected: poolExpected, journalFile: join(directory, "init.json") }),
  },
  { name: "registration", file: "create-token-account.json", schema: "agtmai-solana-registration-journal-v1",
    settings: (directory: string): RegistrationSettings => ({ ...selection, expected: { ...poolExpected, operation: "create-token-account" }, journalDirectory: directory }),
  },
  { name: "config", file: "init-chain-remote-config.json", schema: "agtmai-solana-pool-config-journal-v1",
    settings: (directory: string): ConfigSettings => ({ ...selection, expected: { ...poolExpected, operation: "init-chain-remote-config" }, journalDirectory: directory, registrationJournalFile: join(directory, "transfer-mint-authority.json") }),
  },
] as const;

const inertFetch: typeof fetch = async () => { throw new Error("IO must remain inert"); };

test("all four function ingresses redact ENAMETOOLONG, EACCES and expectation-capture failures before opening", async context => {
  const directory = await disposable();
  const marker = "private-operator-journal-marker";
  let opened = 0, fetched = 0, signed = 0;
  const io = { fetcher: async () => { fetched++; assert.fail("No transport allowed"); },
    openSdk: async (): Promise<never> => { opened++; assert.fail("No Host open allowed"); },
    signPrepared: async (): Promise<never> => { signed++; assert.fail("No key/sign work allowed"); } };
  const invoke = (path: string, captureFailure = false) => {
    const extra = captureFailure ? { privateBytes: () => marker } : {};
    const mint = { ...expected, rentLamports: "1461600", ...extra }, pool = { ...poolExpected, ...extra };
    return [
      () => createTestMint({ ...selection, expected: mint, journalFile: path }, io),
      () => initializeTestPool({ ...selection, expected: pool, journalFile: path }, io),
      () => registerTestSolanaPool({ ...selection, expected: { ...pool, operation: "create-token-account" }, journalDirectory: path }, io),
      () => configureTestSolanaPool({ ...selection, expected: { ...pool, operation: "init-chain-remote-config" }, journalDirectory: path, registrationJournalFile: path }, io),
    ];
  };
  const check = async (callers: ReturnType<typeof invoke>) => {
    for (const caller of callers) {
      await assert.rejects(caller(), error => {
        assert.ok(error instanceof Error); assert.equal(error.message, "TEST setup failed");
        assert.ok(!error.message.includes(marker)); assert.ok(!("code" in error)); assert.ok(!("path" in error));
        assert.ok(!("cause" in error), "Private exception objects must not escape through cause");
        return true;
      });
    }
  };
  try {
    await check(invoke(join(directory, `${marker}-${"x".repeat(300)}`)));
    const deniedPath = join(directory, marker);
    const original = fs.lstatSync;
    const probe = context.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      if (args[0] === deniedPath) { throw Object.assign(new Error(`EACCES: lstat '${deniedPath}'`), { code: "EACCES", path: deniedPath }); }
      return original(...args);
    });
    syncBuiltinESMExports();
    try { await check(invoke(deniedPath)); }
    finally { probe.mock.restore(); syncBuiltinESMExports(); }
    await check(invoke(join(directory, "capture.json"), true));
    assert.deepEqual({ opened, fetched, signed }, { opened: 0, fetched: 0, signed: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("four ingress functions reject invalid own profile/fetch/aliases before fixture symlink checks, locks or provider IO", async () => {
  const directory = await disposable();
  try {
    for (const entry of cases) {
      const original = entry.settings(directory);
      const invoke = async (value: unknown, io?: unknown) => {
        // Runtime ingress assertions deliberately bypass TS only via JSON CLI validation, never a provider declaration.
        const settings = setupObject(value);
        switch (entry.name) {
          case "mint": return createTestMint(parseSetupCli(settings, "mint"), io === undefined ? undefined : { fetcher: async () => { throw new Error("fetch sentinel"); } });
          case "init": return initializeTestPool(parseSetupCli(settings, "init"));
          case "registration": return registerTestSolanaPool(parseSetupCli(settings, "registration"));
          case "config": return configureTestSolanaPool(parseSetupCli(settings, "config"));
        }
      };
      for (const profile of [undefined, null, "", "unknown", "legacy"]) { await assert.rejects(invoke({ ...original, providerProfile: profile }), /profile/); }
      await assert.rejects(invoke({ ...original, sdkDirectory: "/divergent" }), /alias/);
      await assert.rejects(invoke(original), /IO required/);
      for (const [key, value] of [["fetcher", undefined], ["fetcher", null], ["fetcher", "fetch"], ["openSdk", null], ["signPrepared", {}]] as const) {
        const io = { fetcher: inertFetch }; Object.defineProperty(io, key, { value });
        assert.throws(() => selectSetup(original, io), /IO required/);
      }
      assert.throws(() => selectSetup({ ...original, replayFetch: async () => new Response() }, { fetcher: inertFetch }), /IO required/);
      assert.throws(() => selectSetup({ ...original, fixtureIdentity: "0".repeat(64) }, { fetcher: inertFetch }));
      await assert.rejects(access(join(directory, entry.file + ".lock")));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("four actual JSON CLIs require explicit operator mode and reject unknown flags without custody, admission or public transport", async () => {
  const directory = await disposable();
  try {
    for (const [index, file] of ["create-solana-mint", "initialize-solana-pool", "register-solana-pool", "configure-solana-pool"].entries()) {
      const entry = cases[index]; assert.ok(entry);
      const path = join(directory, `${file}-settings.json`);
      await writeFile(path, JSON.stringify({ ...entry.settings(directory), payerFile: "/never-read/private-test", mintFile: "/never-read/private-mint", solanaRpc: "https://api.devnet.solana.com" }), { mode: 0o600 });
      for (const flag of [[], ["--unknown"], ["--operator-test", "--extra"]]) {
        await assert.rejects(promisify(execFile)(process.execPath, [resolve(`tooling/testnet-ccip/src/composition/${file}.mjs`), path, ...flag]));
      }
      // Explicit mode validates the chosen endpoint before opening the provider or key references.
      await writeFile(path, JSON.stringify({ ...entry.settings(directory), payerFile: "/never-read/private-test", mintFile: "/never-read/private-mint", solanaRpc: "https://mainnet.invalid" }), { mode: 0o600 });
      await assert.rejects(promisify(execFile)(process.execPath, [resolve(`tooling/testnet-ccip/src/composition/${file}.mjs`), path, "--operator-test"]));
      await assert.rejects(access(join(directory, entry.file)));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
