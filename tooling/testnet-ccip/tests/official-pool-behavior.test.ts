import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, glob, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { lockReleaseConstructor } from "../src/domain/evm-pool.ts";
import { testTokenConstructor } from "../src/composition/deploy-token.ts";
import { SOURCE_BUILT_POOL as pin } from "../artifacts/replacement-source-built-test-v1.ts";
interface Compiled { evm: { bytecode: { object: string }; deployedBytecode: { object: string; immutableReferences: Record<string, { start: number; length: number }[]> } } }
interface Output { contracts: Record<string, Record<string, Compiled>>; sources: Record<string, { ast: unknown }>; errors?: { severity: string; formattedMessage: string }[] }
const poolEntry = "@chainlink/contracts-ccip/contracts/pools/LockReleaseTokenPool.sol", testEntry = "official-pool-behavior.sol";
const administrator = "0x1d7bfcf10cbd789da22460265352126356701eb3", token = "0x812c4dcbc459a55f8517e87e825b8c728cee7316", pool = "0x8472aa06661671e7e4af43048f0d0446eff2e97d";
const rmn = "0xba3f6251de62ded61ff98590cb2fdf6871fbb991", router = "0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59";
const executable = (name: string) => resolve(".tools/foundry-v1.8.0-linux-x64", name);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function cast(...args: string[]): string {
  const r = spawnSync(executable("cast"), args, { encoding: "utf8", timeout: 10000 }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
async function observeBalances(read: (data: string) => Promise<string>, accounts: Record<string, string>): Promise<Record<string, string>> {
  const balances: Record<string, string> = {};
  for (const [name, address] of Object.entries(accounts)) { balances[name] = BigInt(await read(cast("calldata", "balanceOf(address)", address))).toString(); }
  return balances;
}
test("exact official creation executes offline with immutable runtime and independent behavioral assertions", { timeout: 120000 }, async () => {
  for (const [path, hash] of [[executable("anvil"), "3144d22206af1df0f109ce7045837e56b5b354e269b4ba8f979786ee90471020"],
    [executable("cast"), "b59c2db2c53abe0cae7fb8ef2c78c9603e0b9f5fc600e9cb6d5294a6628b9ff8"], [resolve(".tools/solc-v0.8.36-linux-x64/solc"), pin.compiler.sha256]]) {
    assert.equal(sha(await readFile(path)), hash, "pinned local executable");
  }
  const artifactBytes = await readFile(".local/INPUT/source-build/LockReleaseTokenPool.source-built.json"); assert.equal(sha(artifactBytes), pin.artifactSha256);
  const artifact = JSON.parse(artifactBytes.toString()) as { bytecode: { object: string }; deployedBytecode: { object: string } };
  const inputBytes = await readFile(".local/INPUT/source-build/SOLC-STANDARD-INPUT.json"); assert.equal(sha(inputBytes), pin.inputSha256);
  const input = JSON.parse(inputBytes.toString()) as { sources: Record<string, { content: string }>; settings: { outputSelection: unknown } };
  // Test-only compiler query adds output maps and the fixture. The deployed pool uses authenticated artifact bytes.
  for (const [file, hash] of Object.entries(pin.source)) { assert.equal(sha(Buffer.from(input.sources[file].content)), hash); }
  input.sources[testEntry] = { content: await readFile(new URL("./fixtures/official-pool-behavior.sol", import.meta.url), "utf8") };
  for await (const file of glob("contracts/evm/lib/openzeppelin-contracts/contracts/**/*.sol")) {
    input.sources[file.replace("contracts/evm/lib/openzeppelin-contracts/", "@openzeppelin/")] = { content: await readFile(file, "utf8") };
  }
  for (const name of ["AGTMAIToken", "AGTMAICCIPToken"]) { input.sources[`${name}.sol`] = { content: await readFile(`contracts/evm/src/features/token-genesis/${name}.sol`, "utf8") }; }
  input.settings.outputSelection = { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode"], "": ["ast"] } };
  const compiled = spawnSync(resolve(".tools/solc-v0.8.36-linux-x64/solc"), ["--standard-json"], { input: JSON.stringify(input), encoding: "utf8", maxBuffer: 30 * 1024 * 1024, timeout: 60000 });
  assert.equal(compiled.status, 0, compiled.stderr); const output = JSON.parse(compiled.stdout) as Output;
  assert.deepEqual(output.errors?.filter(e => e.severity === "error").map(e => e.formattedMessage) ?? [], []);
  const official = output.contracts[poolEntry].LockReleaseTokenPool;
  assert.equal("0x" + official.evm.bytecode.object, artifact.bytecode.object); assert.equal("0x" + official.evm.deployedBytecode.object, artifact.deployedBytecode.object);
  const temporary = await mkdtemp(join(tmpdir(), "official-pool-anvil-"));
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const address = reservation.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  await new Promise<void>((_resolve, reject) => { reservation.close(error => error ? reject(error) : _resolve()); });
  const child = spawn(executable("anvil"), ["--silent", "--accounts", "0", "--host", "127.0.0.1", "--port", String(port), "--chain-id", "11155111", "--hardfork", "paris"],
    { cwd: temporary, env: { PATH: "/usr/bin:/bin", HOME: temporary, TMPDIR: temporary }, stdio: "ignore" });
  const exited = once(child, "exit"); let id = 0;
  async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), headers: { "content-type": "application/json" } });
    const reply = await response.json() as { result: T; error?: unknown }; if (reply.error) { throw new Error(JSON.stringify(reply.error)); } return reply.result;
  }
  async function send(data: string, to?: string) {
    const hash = await rpc<string>("eth_sendTransaction", [{ from: administrator, ...(to ? { to } : {}), data, gas: "0xe4e1c0" }]);
    let receipt: { status: string; contractAddress: string; gasUsed: string } | null = null;
    for (let i = 0; i < 100 && !receipt; i++) { receipt = await rpc("eth_getTransactionReceipt", [hash]); if (!receipt) { await delay(10); } }
    assert.ok(receipt, "owned offline transaction receipt");
    assert.equal(receipt.status, "0x1", "offline transaction " + data.slice(0, 10)); return receipt;
  }
  const calldata = (sig: string, ...args: string[]) => cast("calldata", sig, ...args);
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      assert.equal(child.exitCode, null, "owned Anvil must remain live");
      try { ready = await rpc<string>("eth_chainId") === "0xaa36a7"; } catch { /* bounded startup only, same owned process */ }
      if (ready) { break; } await delay(25);
    }
    assert.ok(ready, "owned loopback Anvil readiness");
    await rpc("anvil_impersonateAccount", [administrator]); await rpc("anvil_setBalance", [administrator, "0x56bc75e2d63100000"]);
    assert.equal((await send("0x" + output.contracts["AGTMAICCIPToken.sol"].AGTMAICCIPToken.evm.bytecode.object + testTokenConstructor(administrator).slice(2))).contractAddress.toLowerCase(), token);
    for (const [name, at] of [["PoolTestRouter", router], ["PoolTestRMN", rmn]]) { await rpc("anvil_setCode", [at, "0x" + output.contracts[testEntry][name].evm.deployedBytecode.object]); }
    const creation = artifact.bytecode.object + lockReleaseConstructor(token).slice(2);
    const constructor = lockReleaseConstructor(token);
    const replaceWord = (index: number, word: string) => constructor.slice(0, 2 + index * 64) + word.padStart(64, "0") + constructor.slice(66 + index * 64);
    for (const malformed of [constructor.slice(0, -64), replaceWord(1, "100"), replaceWord(2, "ffff"), replaceWord(5, "1"),
      replaceWord(0, "1" + token.slice(2).padStart(63, "0")), replaceWord(1, "12")]) {
      await assert.rejects(rpc("eth_call", [{ from: administrator, data: artifact.bytecode.object + malformed.slice(2), gas: "0xe4e1c0" }, "latest"]), /revert/i, "actual official constructor decoder/check");
    }
    const estimate = await rpc<string>("eth_estimateGas", [{ from: administrator, data: creation }]);
    await assert.rejects(rpc("eth_estimateGas", [{ from: administrator, data: creation, gas: "0x30d400" }]));
    const deployed = await send(creation); assert.equal(deployed.contractAddress.toLowerCase(), pool);
    const immutableNames = new Map<string, string>();
    function visit(node: unknown): void {
      if (!node || typeof node !== "object") { return; } const record = node as Record<string, unknown>;
      if (record.mutability === "immutable" && typeof record.name === "string") { immutableNames.set(String(record.id), record.name); }
      for (const value of Object.values(record)) { if (Array.isArray(value)) { value.forEach(visit); } else { visit(value); } }
    }
    visit(output.sources["@chainlink/contracts-ccip/contracts/pools/TokenPool.sol"].ast);
    const bindings: Record<string, string> = { i_token: token.slice(2), i_tokenDecimals: "9", i_rmnProxy: rmn.slice(2), i_allowlistEnabled: "0" };
    const runtime = Buffer.from(artifact.deployedBytecode.object.slice(2), "hex"), counts: Record<string, number> = {};
    for (const [key, sites] of Object.entries(official.evm.deployedBytecode.immutableReferences)) {
      const name = immutableNames.get(key)!; assert.ok(Object.hasOwn(bindings, name)); counts[name] = sites.length;
      for (const site of sites) { assert.equal(site.length, 32); Buffer.from(bindings[name].padStart(64, "0"), "hex").copy(runtime, site.start); }
    }
    assert.deepEqual(counts, { i_token: 13, i_tokenDecimals: 9, i_rmnProxy: 3, i_allowlistEnabled: 3 });
    assert.equal(await rpc("eth_getCode", [pool, "latest"]), "0x" + runtime.toString("hex"));
    for (const [signature, expected] of [["owner()", administrator.slice(2)], ["getToken()", token.slice(2)], ["getTokenDecimals()", "9"], ["getRouter()", router.slice(2)], ["getRmnProxy()", rmn.slice(2)], ["getAllowListEnabled()", "0"], ["getRebalancer()", "0"]]) {
      assert.equal(await rpc("eth_call", [{ to: pool, data: calldata(signature) }, "latest"]), "0x" + expected.padStart(64, "0"));
    }
    assert.equal(BigInt(await rpc<string>("eth_call", [{ to: token, data: calldata("totalSupply()") }, "latest"])), 100000000000n);
    assert.equal(await rpc("eth_call", [{ to: token, data: calldata("getCCIPAdmin()") }, "latest"]), "0x" + administrator.slice(2).padStart(64, "0"));
    const harness = (await send("0x" + output.contracts[testEntry].OfficialPoolBehavior.evm.bytecode.object + cast("abi-encode", "f(address)", pool).slice(2))).contractAddress;
    await send(calldata("setRamp(address)", harness), router); await send(calldata("transferOwnership(address)", harness), pool);
    assert.equal(await rpc("eth_call", [{ to: pool, data: calldata("owner()") }, "latest"]), "0x" + administrator.slice(2).padStart(64, "0"));
    await send(calldata("accept()"), harness); await send(calldata("transfer(address,uint256)", pool, "50000000000"), token);
    assert.equal(await rpc("eth_call", [{ to: token, data: calldata("getCCIPAdmin()") }, "latest"]), "0x" + administrator.slice(2).padStart(64, "0"), "pool ownership does not transfer token admin");
    await send(calldata("transfer(address,uint256)", harness, "1"), token);
    const scenarios = ["testNoPullAndConservation", "testRejections", "testDepletion", "testRefill", "testRollbackAndDecimals", "testAllowlist", "testAuthorities", "testRebalancerBypass"];
    for (const scenario of scenarios) {
      if (scenario === "testRefill") { await rpc("evm_increaseTime", [2]); await rpc("evm_mine"); }
      await send(scenario === "testAllowlist" ? calldata("testAllowlist(bytes)", artifact.bytecode.object) : calldata(`${scenario}()`), harness);
    }
    const actor = "0x" + (await rpc<string>("eth_call", [{ to: harness, data: calldata("actor()") }, "latest"])).slice(-40);
    const balances = await observeBalances(data => rpc<string>("eth_call", [{ to: token, data }, "latest"]), {
      administrator, pool, receiver: "0x000000000000000000000000000000000000beef", rebalancer: actor });
    assert.equal(balances.pool, "0"); assert.equal(balances.receiver, "13000000012"); assert.equal(balances.rebalancer, "36999999989");
    assert.equal(Object.values(balances).reduce((sum, value) => sum + BigInt(value), 0n), 100000000000n);
    await writeFile(resolve(".local/evidence/official-pool-observations.json"), JSON.stringify({ artifactSha256: pin.artifactSha256, port, sender: administrator, token, pool,
      estimatedDeploymentGas: BigInt(estimate).toString(), actualDeploymentGas: BigInt(deployed.gasUsed).toString(), materializedImmutableSites: 28,
      runtimeSha256: sha(runtime), balances, scenarios, scope: "offline exact-code pool execution; repository token compiled for fixture; test router/RMN doubles; no real CCIP delivery or public pool deployment; operator gas/exposure remains Root" }, null, 2) + "\n");
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); }
    const cleanupTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await exited; } finally { clearTimeout(cleanupTimer); await rm(temporary, { recursive: true, force: true }); }
    await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }), /fetch failed|abort|timeout/i, "owned port released");
  }
});
