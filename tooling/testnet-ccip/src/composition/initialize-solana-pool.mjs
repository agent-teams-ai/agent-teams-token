// @ts-check
import { setupIngress, selectSetup, freezeSetupExpected, latestSetupBlock, signSetup, setupLifetime, setupObject, parseSetupCli, operatorTestFetch, testKeys, createPoolInitOperatorIO } from "./solana-setup-operator.ts";
import { createTestRpcRequest, DEFAULT_SOLANA_RPC } from "../adapters/test-rpc.ts";
import { bindFixture } from "../adapters/fixture-binding.ts";
import { BURNMINT_PROGRAM, POOL_GLOBAL } from "../domain/solana-pool-init.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSolanaPoolInitSdk } from "../adapters/solana-pool-init-sdk.mjs";
import { createSolanaPoolInitRpc } from "../adapters/solana-pool-init-rpc.ts";
import { createJournalFile } from "../adapters/evm-journal-file.ts";
/** @type {typeof createJournalFile<import('../application/solana-pool-init-journal.ts').SolanaPoolInitJournalRecord>} */
const setupJournalFile = createJournalFile;
import { runSolanaPoolInitJournal } from "../application/solana-pool-init-journal.ts";



/** @param {import('../domain/solana-pool-init.ts').SolanaPoolInitExpectation} expected @param {import('../adapters/solana-transaction-rpc.ts').SolanaRpcRead} readRpc */
async function verifyMintPrerequisite(expected, readRpc) {
  const mint = setupObject(await readRpc("getAccountInfo", [expected.mint, { commitment: "finalized", encoding: "jsonParsed" }]));
  const account = setupObject(mint.value), data = setupObject(account.data), parsed = setupObject(data.parsed), info = setupObject(parsed.info);
  if (account.owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || account.executable !== false ||
    parsed.type !== "mint" || data.space !== 82 || info.isInitialized !== true ||
    info.decimals !== 9 || info.supply !== "0" || info.mintAuthority !== expected.payer || info.freezeAuthority !== null) {
    throw new Error("Wrong finalized test mint prerequisite");
  }
}

/** @param {import('./solana-setup-operator.ts').InitSettings} settings @param {import('./solana-setup-operator.ts').SetupIO<import('../domain/solana-pool-init.ts').SolanaPoolInitExpectation, import('../adapters/solana-pool-init-sdk.mjs').UnsignedPoolInitSdk>} [io] @returns {Promise<import('./solana-setup-operator.ts').MintResult>} */
export async function initializeTestPool(settings, io) {
  const { selection, providerDirectory, journalFile, expected, lifetime } = setupIngress(() => {
    if (settings.testOnly !== true || settings.expected?.testOnly !== true || settings.expected.cluster !== "solana-devnet") {
      throw new Error("Test-only Solana settings required");
    }
    const selected = selectSetup(settings, io);
    const directory = settings.providerDirectory;
    const file = settings.journalFile;
    const fixture = bindFixture(settings, [file]);
    const captured = freezeSetupExpected({ ...settings.expected, ...(fixture ? { fixture } : {}) });
    const owner = setupLifetime(io?.fetcher ?? globalThis.fetch);
    return { selection: selected, providerDirectory: directory, journalFile: file, expected: captured, lifetime: owner };
  });
  /** @type {Awaited<ReturnType<typeof createSolanaPoolInitSdk>> | undefined} */ let acquiredSdk;
  let sdk;
  try { sdk = await lifetime.track(async () => {
    const value = await (selection ? (io?.openSdk ?? createSolanaPoolInitSdk)(providerDirectory, selection) : createSolanaPoolInitSdk(providerDirectory));
    acquiredSdk = value; return value;
  }); }
  catch {
    try { await lifetime.close(async () => { if (acquiredSdk && "destroy" in acquiredSdk) { await acquiredSdk.destroy(); } }); }
    catch { throw new Error("TEST setup provider unavailable; unresolved cleanup debt"); }
    throw new Error("TEST setup provider unavailable");
  }
  return lifetime.run(async () => { if ("destroy" in sdk) { await sdk.destroy(); } }, async () => {
  if (selection && "sign" in sdk) { throw new Error("Unsigned TEST setup view required"); }
  const readRpc = createTestRpcRequest(DEFAULT_SOLANA_RPC, lifetime.fetcher);
  const rpc = createSolanaPoolInitRpc((bytes, intent) => sdk.inspectSigned(bytes, {
    testOnly: true, cluster: intent.cluster, payer: intent.payer, mint: intent.mint, pool: intent.pool, ...(intent.fixture ? { fixture: intent.fixture } : {}),
  }).messageBase64, (bytes, intent) => sdk.verifyState(bytes, intent), lifetime.fetcher);
  const result = await runSolanaPoolInitJournal(expected, {
    ...setupJournalFile(journalFile), ...rpc,
    inspectSigned: async bytes => sdk.inspectSigned(bytes, expected),
    async sign() {
      if (await readRpc("getGenesisHash", []) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
        throw new Error("Wrong Solana cluster");
      }
      const existing = setupObject(await readRpc("getAccountInfo", [expected.pool, { commitment: "finalized", encoding: "base64" }]));
      if (existing.value !== null) { throw new Error("Pool already exists; reconcile existing operation"); }
      await verifyMintPrerequisite(expected, readRpc);
      const global = setupObject(await readRpc("getAccountInfo", [POOL_GLOBAL, { commitment: "finalized", encoding: "base64" }]));
      const account = setupObject(global.value);
      if (account.owner !== BURNMINT_PROGRAM || account.executable !== false ||
        !Array.isArray(account.data) || account.data[1] !== "base64" || typeof account.data[0] !== "string") { throw new Error("Wrong pool global account"); }
      sdk.verifyGlobal(account.data[0]);
      const latest = latestSetupBlock(await readRpc("getLatestBlockhash", [{ commitment: "finalized" }]));
      lifetime.assertOpen();
      const prepared = sdk.build(expected, latest);
      if (selection) { return lifetime.track(() => signSetup(prepared, expected, latest, sdk.inspectSigned, io?.signPrepared)); }
      if (!("sign" in sdk)) { throw new Error("Legacy setup signer unavailable"); }
      return lifetime.track(() => sdk.sign(prepared, expected, testKeys(settings)));

    },
  });
  return { status: result.status, reason: result.reason, signature: result.record.signed.signature };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 && process.argv.length !== 4 || !process.argv[2] || process.argv.length === 4 && process.argv[3] !== "--operator-test") { throw new Error("Invalid setup CLI invocation"); }
    const raw = /** @type {unknown} */ (JSON.parse(await readFile(resolve(process.argv[2]), "utf8")));
    const settings = parseSetupCli(raw, "init");
    const operator = process.argv[3] === "--operator-test";
    if (operator && !Object.hasOwn(settings, "providerProfile")) { throw new Error("Explicit TEST operator profile required"); }
    const io = operator ? createPoolInitOperatorIO(testKeys(raw), operatorTestFetch(raw)) : undefined;
    const publicSettings = operator ? settings : { ...settings, ...testKeys(raw) };
    console.log(JSON.stringify(await initializeTestPool(publicSettings, io)));
  } catch { console.error("Pool initialization failed"); process.exitCode = 1; }
}
