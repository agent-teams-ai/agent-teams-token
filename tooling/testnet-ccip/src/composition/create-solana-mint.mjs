import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSolanaMintSdk } from "../adapters/solana-sdk.mjs";
import { createSolanaMintRpc } from "../adapters/solana-rpc.ts";
import { createJournalFile } from "../adapters/evm-journal-file.ts";
import { runSolanaMintJournal } from "../application/solana-journal.ts";

async function readRpc(method, params) {
  const response = await fetch("https://api.devnet.solana.com", { method: "POST",
    headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json();
  if (!response.ok || body.jsonrpc !== "2.0" || body.id !== 1 || "error" in body || !("result" in body)) {
    throw new Error("Solana mint preflight unavailable");
  }
  return body.result;
}

export async function createTestMint(settings) {
  if (settings.testOnly !== true || settings.expected.testOnly !== true || settings.expected.cluster !== "solana-devnet") {
    throw new Error("Test-only Solana settings required");
  }
  const expected = settings.expected;
  const sdk = await createSolanaMintSdk(settings.providerDirectory);
  const rpc = createSolanaMintRpc((bytes, intent) => sdk.inspectSigned(bytes, {
    testOnly: true, cluster: intent.cluster, payer: intent.payer, mint: intent.mint, rentLamports: intent.rentLamports,
  }).messageBase64);
  const result = await runSolanaMintJournal(expected, {
    ...createJournalFile(settings.journalFile), ...rpc,
    inspectSigned: async bytes => sdk.inspectSigned(bytes, expected),
    async sign() {
      if (await readRpc("getGenesisHash", []) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
        throw new Error("Wrong Solana cluster");
      }
      const existing = await readRpc("getAccountInfo", [expected.mint, { commitment: "finalized", encoding: "base64" }]);
      if (existing.value !== null) { throw new Error("Mint already exists; reconcile existing operation"); }
      const rent = await readRpc("getMinimumBalanceForRentExemption", [82, { commitment: "finalized" }]);
      if (!Number.isSafeInteger(rent) || String(rent) !== expected.rentLamports) { throw new Error("Mint rent changed"); }
      const balance = await readRpc("getBalance", [expected.payer, { commitment: "finalized" }]);
      if (!Number.isSafeInteger(balance.value) || balance.value < rent + 10_000) {
        throw new Error("Test address needs faucet SOL before mint creation");
      }
      const latest = await readRpc("getLatestBlockhash", [{ commitment: "finalized" }]);
      if (!Number.isSafeInteger(latest.value.lastValidBlockHeight)) { throw new Error("Invalid block height"); }
      const prepared = sdk.build(expected, { blockhash: latest.value.blockhash,
        lastValidBlockHeight: String(latest.value.lastValidBlockHeight) });
      return sdk.sign(prepared, expected, { testOnly: true, payerFile: settings.payerFile, mintFile: settings.mintFile });
    },
  });
  return { status: result.status, reason: result.reason, signature: result.record.signed.signature };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) { throw new Error("Usage: create-solana-mint.mjs <private-test-settings.json>"); }
    console.log(JSON.stringify(await createTestMint(JSON.parse(await readFile(resolve(process.argv[2]), "utf8")))));
  } catch (error) { console.error(error instanceof Error ? error.message : "Mint creation failed"); process.exitCode = 1; }
}
