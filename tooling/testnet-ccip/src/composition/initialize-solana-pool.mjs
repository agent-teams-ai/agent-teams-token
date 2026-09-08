import { BURNMINT_PROGRAM, POOL_GLOBAL } from "../domain/solana-pool-init.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSolanaPoolInitSdk } from "../adapters/solana-pool-init-sdk.mjs";
import { createSolanaPoolInitRpc } from "../adapters/solana-pool-init-rpc.ts";
import { createJournalFile } from "../adapters/evm-journal-file.ts";
import { runSolanaPoolInitJournal } from "../application/solana-pool-init-journal.ts";

async function readRpc(method, params) {
  const response = await fetch("https://api.devnet.solana.com", { method: "POST",
    headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json();
  if (!response.ok || body.jsonrpc !== "2.0" || body.id !== 1 || "error" in body || !("result" in body)) {
    throw new Error("Solana pool preflight unavailable");
  }
  return body.result;
}

async function verifyMintPrerequisite(expected) {
  const mint = await readRpc("getAccountInfo", [expected.mint, { commitment: "finalized", encoding: "jsonParsed" }]);
  const info = mint.value?.data?.parsed?.info;
  if (mint.value?.owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || mint.value.executable !== false ||
    mint.value.data.parsed.type !== "mint" || mint.value.data.space !== 82 || info?.isInitialized !== true ||
    info.decimals !== 9 || info.supply !== "0" || info.mintAuthority !== expected.payer || info.freezeAuthority !== null) {
    throw new Error("Wrong finalized test mint prerequisite");
  }
}

export async function initializeTestPool(settings) {
  if (settings.testOnly !== true || settings.expected.testOnly !== true || settings.expected.cluster !== "solana-devnet") {
    throw new Error("Test-only Solana settings required");
  }
  const expected = settings.expected;
  const sdk = await createSolanaPoolInitSdk(settings.providerDirectory);
  const rpc = createSolanaPoolInitRpc((bytes, intent) => sdk.inspectSigned(bytes, {
    testOnly: true, cluster: intent.cluster, payer: intent.payer, mint: intent.mint, pool: intent.pool,
  }).messageBase64, (bytes, intent) => sdk.verifyState(bytes, intent));
  const result = await runSolanaPoolInitJournal(expected, {
    ...createJournalFile(settings.journalFile), ...rpc,
    inspectSigned: async bytes => sdk.inspectSigned(bytes, expected),
    async sign() {
      if (await readRpc("getGenesisHash", []) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
        throw new Error("Wrong Solana cluster");
      }
      const existing = await readRpc("getAccountInfo", [expected.pool, { commitment: "finalized", encoding: "base64" }]);
      if (existing.value !== null) { throw new Error("Pool already exists; reconcile existing operation"); }
      await verifyMintPrerequisite(expected);
      const global = await readRpc("getAccountInfo", [POOL_GLOBAL, { commitment: "finalized", encoding: "base64" }]);
      if (global.value?.owner !== BURNMINT_PROGRAM || global.value.executable !== false ||
        !Array.isArray(global.value.data) || global.value.data[1] !== "base64") { throw new Error("Wrong pool global account"); }
      sdk.verifyGlobal(global.value.data[0]);
      const latest = await readRpc("getLatestBlockhash", [{ commitment: "finalized" }]);
      if (!Number.isSafeInteger(latest.value.lastValidBlockHeight)) { throw new Error("Invalid block height"); }
      const prepared = sdk.build(expected, { blockhash: latest.value.blockhash,
        lastValidBlockHeight: String(latest.value.lastValidBlockHeight) });
      return sdk.sign(prepared, expected, { testOnly: true, payerFile: settings.payerFile });
    },
  });
  return { status: result.status, reason: result.reason, signature: result.record.signed.signature };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) { throw new Error("Usage: initialize-solana-pool.mjs <private-test-settings.json>"); }
    console.log(JSON.stringify(await initializeTestPool(JSON.parse(await readFile(resolve(process.argv[2]), "utf8")))));
  } catch (error) { console.error(error instanceof Error ? error.message : "Pool initialization failed"); process.exitCode = 1; }
}
