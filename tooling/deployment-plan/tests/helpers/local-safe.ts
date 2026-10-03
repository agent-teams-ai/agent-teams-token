import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import type { Hex } from "@agent-teams/supply/deployment";
import { startOwnedAnvil } from "../../../local-evm/process.ts";
import { pinnedFoundryBinaries, pinnedFoundryBinary } from "../../../local-evm/toolchain.ts";
import { type SafeArtifactPins } from "../../../testnet-ccip/src/adapters/safe-artifacts.ts";
import { provisionLocalSafes, ZERO, word } from "../../../testnet-ccip/src/adapters/local-safe.ts";

export { ZERO, word };
type Key = { owner: Hex; path: string };

/** Owned chain, test-only identities and official provisioned Safe 1.4.1 bytes. */
export async function setupLocalSafes(t: TestContext, count: 1 | 2 = 1) {
  const root = resolvePath(".");
  const selected = process.env.AGTMAI_SAFE_PINS_SHA256 as Hex | undefined;
  const directory = process.env.AGTMAI_SAFE_ARTIFACT_DIRECTORY;
  assert.ok(directory && selected, "SAFE_OFFICIAL_ARTIFACTS_REQUIRED: set AGTMAI_SAFE_ARTIFACT_DIRECTORY and AGTMAI_SAFE_PINS_SHA256");
  const temporary = await mkdtemp(join(tmpdir(), "agtmai-local-safe-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const foundry = pinnedFoundryBinaries(root);
  const cast = pinnedFoundryBinary(root, foundry, "cast");
  const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile(cast, args, { timeout: 30_000, maxBuffer: 2_000_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
  const keys: Key[] = [];
  for (const name of [...Array.from({ length: count * 3 }, (_, i) => `owner-${i}`), "executor"]) {
    await run(["wallet", "new", temporary, name, "--unsafe-password", "local-test-only"]);
    const path = join(temporary, name);
    keys.push({ path, owner: (await run(["wallet", "address", "--keystore", path, "--password", "local-test-only"])).toLowerCase() as Hex });
  }
  const executor = keys.at(-1)!;
  const anvil = await startOwnedAnvil(pinnedFoundryBinary(root, foundry, "anvil"), executor.owner, undefined, { timestamp: "1799999900" });
  t.after(() => anvil.stop());
  let id = 0;
  const rpc = async (method: string, params: readonly unknown[] = []): Promise<any> => {
    const response = await fetch(anvil.rpcUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    if (body.error) { throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data }); }
    return body.result;
  };
  assert.equal(await rpc("eth_chainId"), "0x7a69");
  await rpc("anvil_setBlockTimestampInterval", [1]);
  const beforeSlowOperation = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  await delay(1_200);
  await rpc("evm_mine");
  assert.equal(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp), beforeSlowOperation + 1n);
  const encode = (signature: string, args: string[]) => run(["calldata", signature, ...args]) as Promise<Hex>;
  const call = async (to: Hex, signature: string, args: string[] = [], options: { from?: Hex; block?: Hex } = {}) => rpc("eth_call", [{ to, data: await encode(signature, args), ...(options.from ? { from: options.from } : {}) }, options.block ?? "latest"]) as Promise<Hex>;
  const send = async (to: Hex | null, data: Hex) => {
    const nonce = await rpc("eth_getTransactionCount", [executor.owner, "latest"]);
    const hash = await run(["send", "--rpc-url", anvil.rpcUrl, "--chain", "31337", "--keystore", executor.path, "--password", "local-test-only", "--gas-limit", "6000000", "--async", ...(to ? [to, data] : ["--create", data])]);
    for (let attempt = 0; attempt < 200; attempt++) {
      const receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (receipt) {
        const transaction = await rpc("eth_getTransactionByHash", [hash]);
        assert.equal(transaction.from.toLowerCase(), executor.owner);
        assert.equal(transaction.nonce, nonce);
        assert.equal(transaction.input.toLowerCase(), data.toLowerCase());
        assert.equal(transaction.to?.toLowerCase() ?? null, to?.toLowerCase() ?? null);
        return receipt;
      }
      await delay(25);
    }
    throw new Error(`Unresolved local transaction ${hash}; do not resubmit`);
  };
  const deploy = async (initcode: Hex): Promise<Hex> => {
    const receipt = await send(null, initcode);
    assert.equal(receipt.status, "0x1");
    return (receipt.contractAddress as Hex).toLowerCase() as Hex;
  };
  const pins = JSON.parse(await readFile(join(directory, "pins.json"), "utf8")) as SafeArtifactPins;
  const bytes = { proxy: await readFile(join(directory, "SafeProxy.json")), singleton: await readFile(join(directory, "Safe.json")), buildInfo: await readFile(join(directory, "build-info.json")) };
  const passive = await provisionLocalSafes({ chainId: "31337", relayer: executor.owner, rpc, encode, call, send,
    sign: async (owner, hash) => {
      const key = keys.find(candidate => candidate.owner === owner)!;
      return await run(["wallet", "sign", "--no-hash", hash, "--keystore", key.path, "--password", "local-test-only"]) as Hex;
    },
    verifySignature: async (owner, hash, signature) => {
      await run(["wallet", "verify", "--address", owner, "--no-hash", hash, signature]); return true;
    },
  }, { pins, selected, bytes }, Array.from({ length: count }, (_, i) => keys.slice(i * 3, i * 3 + 3).map(key => key.owner)));
  const { safes, singleton, safeExec } = passive;
  const cleanup = async () => { await anvil.stop(); await rm(temporary, { recursive: true, force: true }); };
  return { root, temporary, executor, rpc, call, send, deploy, safes, safe: safes[0]!.safe, owners: safes[0]!.owners, singleton, pins, keys: keys.slice(0, 3), run, encode, safeExec, cleanup };
}
