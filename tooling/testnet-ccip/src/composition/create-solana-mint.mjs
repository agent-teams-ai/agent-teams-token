// @ts-check
import { setupIngress, selectSetup, freezeSetupExpected, latestSetupBlock, signSetup, setupLifetime, setupObject, parseSetupCli, operatorTestFetch, mintTestKeys, createMintOperatorIO } from "./solana-setup-operator.ts";
import { createTestRpcRequest, DEFAULT_SOLANA_RPC } from "../adapters/test-rpc.ts";
import { bindFixture } from "../adapters/fixture-binding.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSolanaMintSdk } from "../adapters/solana-sdk.mjs";
import { createSolanaMintRpc } from "../adapters/solana-rpc.ts";
import { createJournalFile } from "../adapters/evm-journal-file.ts";
/** @type {typeof createJournalFile<import('../application/solana-journal.ts').SolanaMintJournalRecord>} */
const setupJournalFile = createJournalFile;
import { runSolanaMintJournal } from "../application/solana-journal.ts";



/** @param {import('./solana-setup-operator.ts').MintSettings} settings @param {import('./solana-setup-operator.ts').SetupIO<import('../domain/solana-mint.ts').SolanaMintExpectation, import('../adapters/solana-sdk.mjs').UnsignedMintSdk>} [io] @returns {Promise<import('./solana-setup-operator.ts').MintResult>} */
export async function createTestMint(settings, io) {
  const { selection, providerDirectory, journalFile, expected, lifetime } = setupIngress(() => {
    if (settings.testOnly !== true || settings.expected?.testOnly !== true || settings.expected.cluster !== "solana-devnet") {
      throw new Error("Test-only Solana settings required");
    }
    const selected = selectSetup(settings, io);
    const directory = settings.providerDirectory;
    const file = settings.journalFile;
    bindFixture(settings, [file]);
    const captured = freezeSetupExpected(settings.expected);
    const owner = setupLifetime(io?.fetcher ?? globalThis.fetch);
    return { selection: selected, providerDirectory: directory, journalFile: file, expected: captured, lifetime: owner };
  });
  /** @type {Awaited<ReturnType<typeof createSolanaMintSdk>> | undefined} */ let acquiredSdk;
  let sdk;
  try { sdk = await lifetime.track(async () => {
    const value = await (selection ? (io?.openSdk ?? createSolanaMintSdk)(providerDirectory, selection) : createSolanaMintSdk(providerDirectory));
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
  const rpc = createSolanaMintRpc((bytes, intent) => sdk.inspectSigned(bytes, {
    testOnly: true, cluster: intent.cluster, payer: intent.payer, mint: intent.mint, rentLamports: intent.rentLamports,
  }).messageBase64, lifetime.fetcher);
  const result = await runSolanaMintJournal(expected, {
    ...setupJournalFile(journalFile), ...rpc,
    inspectSigned: async bytes => sdk.inspectSigned(bytes, expected),
    async sign() {
      if (await readRpc("getGenesisHash", []) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
        throw new Error("Wrong Solana cluster");
      }
      const existing = setupObject(await readRpc("getAccountInfo", [expected.mint, { commitment: "finalized", encoding: "base64" }]));
      if (existing.value !== null) { throw new Error("Mint already exists; reconcile existing operation"); }
      const rent = await readRpc("getMinimumBalanceForRentExemption", [82, { commitment: "finalized" }]);
      if (typeof rent !== "number" || !Number.isSafeInteger(rent) || String(rent) !== String(expected.rentLamports)) { throw new Error("Mint rent changed"); }
      const balance = setupObject(await readRpc("getBalance", [expected.payer, { commitment: "finalized" }]));
      if (typeof balance.value !== "number" || !Number.isSafeInteger(balance.value) || balance.value < rent + 10_000) {
        throw new Error("Test address needs faucet SOL before mint creation");
      }
      const latest = latestSetupBlock(await readRpc("getLatestBlockhash", [{ commitment: "finalized" }]));
      lifetime.assertOpen();
      const prepared = sdk.build(expected, latest);
      if (selection) { return lifetime.track(() => signSetup(prepared, expected, latest, sdk.inspectSigned, io?.signPrepared)); }
      if (!("sign" in sdk)) { throw new Error("Legacy setup signer unavailable"); }
      return lifetime.track(() => sdk.sign(prepared, expected, mintTestKeys(settings)));

    },
  });
  return { status: result.status, reason: result.reason, signature: result.record.signed.signature };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 && process.argv.length !== 4 || !process.argv[2] || process.argv.length === 4 && process.argv[3] !== "--operator-test") { throw new Error("Invalid setup CLI invocation"); }
    const raw = /** @type {unknown} */ (JSON.parse(await readFile(resolve(process.argv[2]), "utf8")));
    const settings = parseSetupCli(raw, "mint");
    const operator = process.argv[3] === "--operator-test";
    if (operator && !Object.hasOwn(settings, "providerProfile")) { throw new Error("Explicit TEST operator profile required"); }
    const io = operator ? createMintOperatorIO(mintTestKeys(raw), operatorTestFetch(raw)) : undefined;
    const publicSettings = operator ? settings : { ...settings, ...mintTestKeys(raw) };
    console.log(JSON.stringify(await createTestMint(publicSettings, io)));
  } catch { console.error("Mint creation failed"); process.exitCode = 1; }
}
