import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { deploymentBytes, type DeploymentSafe, type Hex } from "@agent-teams/supply/deployment";
import { startOwnedAnvil } from "../../local-evm/process.ts";
import { assertPrivateRpcUrl } from "../../local-evm/rpc.ts";
import { authenticateFoundryBinaries, pinnedFoundryBinaries, pinnedFoundryBinary } from "../../local-evm/toolchain.ts";
import { readRegularFile } from "../../local-evm/safe-fs.ts";
import { qualifySafeArtifacts, type SafeArtifactPins } from "../src/adapters/safe-artifacts.ts";
import { custodySafeHash, custodySafeCalldata, custodySafeResult, custodyTopic, custodySelector } from "../src/adapters/safe-custody.ts";
import { createCustodyReader } from "../src/adapters/custody-rpc.ts";
import { createCastSignatureVerifier } from "../src/adapters/evm-cast.ts";
import type { CustodySafeCall } from "../src/domain/custody-intent.ts";

const zero = "0x0000000000000000000000000000000000000000" as const;
const word = (v: bigint): string => v.toString(16).padStart(64, "0");
const purpose = `0x${Buffer.from("contributors").toString("hex").padEnd(64, "0")}` as Hex;
const execAbi = "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)";
const hashAbi = "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)";

const packed = (signatures: readonly { owner: Hex; signature: Hex }[]): Hex => `0x${signatures.toSorted((a, b) => a.owner < b.owner ? -1 : 1).map(s => s.signature.slice(2)).join("")}`;

async function localSafeFixture(t: TestContext) {
  // Missing qualification inputs are a failed acceptance gate, never a skipped or synthetic E2E.
  const directory = process.env.AGTMAI_SAFE_ARTIFACT_DIRECTORY;
  const selected = process.env.AGTMAI_SAFE_PINS_SHA256 as Hex | undefined;
  assert.ok(directory && selected, "CUSTODY_SAFE_OFFICIAL_ARTIFACTS_REQUIRED: independently reviewed directory and pins digest are required");
  const pins: SafeArtifactPins = JSON.parse((await readRegularFile(join(directory, "pins.json"), "SAFE_PINS")).toString());
  const bytes = { proxy: await readRegularFile(join(directory, "SafeProxy.json"), "SAFE_PROXY"),
    singleton: await readRegularFile(join(directory, "Safe.json"), "SAFE_SINGLETON"),
    buildInfo: await readRegularFile(join(directory, "build-info.json"), "SAFE_BUILD_INFO") };
  // Authenticate bytes before any deployment. The actual singleton address is bound after CREATE.
  qualifySafeArtifacts(pins, selected, bytes, "0x0000000000000000000000000000000000000099");
  const root = resolvePath(import.meta.dirname, "../../.."), foundry = authenticateFoundryBinaries(root, pinnedFoundryBinaries(root));
  const cast = pinnedFoundryBinary(root, foundry, "cast");
  const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile(cast, args, { timeout: 30_000, maxBuffer: 2_000_000,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...(process.env.HOME ? { HOME: process.env.HOME } : {}) } },
    (error, stdout) => error ? reject(new Error(`Local cast ${args[0]} operation failed`)) : resolve(stdout.trim()));
  });
  const privateDirectory = await mkdtemp(join(tmpdir(), "agtmai-safe-local-keys-"));
  // Public evidence outlives the test; keep it outside the wrapper's private temporary environment.
  await mkdir(join(root, ".local"), { recursive: true });
  const evidenceDirectory = await mkdtemp(join(root, ".local", "agtmai-safe-local-evidence-"));
  t.diagnostic(`Public local evidence: ${evidenceDirectory}`);
  const keyPaths: string[] = [];
  t.after(async () => { for (const path of keyPaths) { await unlink(path); } await rmdir(privateDirectory); });
  const keys: { owner: Hex; path: string }[] = [];
  for (const name of ["owner-a", "owner-b", "owner-c", "executor"]) {
    await run(["wallet", "new", privateDirectory, name, "--unsafe-password", "local-test-only"]);
    const path = join(privateDirectory, name); keyPaths.push(path);
    keys.push({ path, owner: (await run(["wallet", "address", "--keystore", path, "--password", "local-test-only"])).toLowerCase() as Hex });
  }
  const executor = keys[3]!;
  const anvil = await startOwnedAnvil(pinnedFoundryBinary(root, foundry, "anvil"), executor.owner);
  t.after(() => anvil.stop());
  assertPrivateRpcUrl(anvil.rpcUrl);
  let identifier = 0;
  const rpc = async (method: string, params: unknown[] = []): Promise<any> => {
    const response = await fetch(anvil.rpcUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++identifier, method, params }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    return result.result;
  };
  assert.equal(await rpc("eth_chainId"), "0x7a69");
  const encode = (signature: string, args: string[]): Promise<Hex> => run(["calldata", signature, ...args]) as Promise<Hex>;
  const call = async (to: Hex, signature: string, args: string[] = []): Promise<Hex> => rpc("eth_call", [{ to, data: await encode(signature, args) }, "latest"]);
  const records: unknown[] = [];
  t.after(async () => {
    await writeFile(join(evidenceDirectory, "observations.json"), deploymentBytes({ pins, selectedPinsSha256: selected, records }), { flag: "wx" });
  });
  const send = async (to: Hex | null, data: Hex) => {
    // Only the disposable executor signs an outer transaction; never impersonate a Safe.
    const hash = await run(["send", "--rpc-url", anvil.rpcUrl, "--chain", "31337", "--keystore", executor.path,
      "--password", "local-test-only", "--gas-limit", "6000000", "--async", ...(to ? [to, data] : ["--create", data])]);
    records.push({ submittedHash: hash });
    let receipt;
    for (let attempt = 0; attempt < 200; attempt++) {
      receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (receipt) { break; }
      await delay(25);
    }
    assert.ok(receipt, `Unresolved local transaction ${hash}; do not resubmit`);
    records.push({ transaction: await rpc("eth_getTransactionByHash", [hash]), receipt });
    return receipt;
  };
  const deploy = async (initcode: Hex): Promise<Hex> => {
    const receipt = await send(null, initcode); assert.equal(receipt.status, "0x1"); return receipt.contractAddress;
  };
  const singleton = await deploy(JSON.parse(Buffer.from(bytes.singleton).toString()).bytecode);
  const profile = qualifySafeArtifacts(pins, selected, bytes, singleton);
  const safeAddress = await deploy(`${JSON.parse(Buffer.from(bytes.proxy).toString()).bytecode}${word(BigInt(singleton))}` as Hex);
  const safe: DeploymentSafe = { id: "local-controller", address: safeAddress, owners: keys.slice(0, 3).map(k => k.owner), threshold: 2,
    beneficialControl: "solo-founder", disclosure: "Disposable local test keys; one process controls all three." };
  const setup = await encode("setup(address[],uint256,address,bytes,address,address,uint256,address)", [`[${safe.owners.join(",")}]`, "2", zero, "0x", zero, zero, "0", zero]);
  const initialization = await send(safe.address, setup);
  assert.equal(initialization.status, "0x1");
  assert.equal(BigInt(await call(safe.address, "getThreshold()")), 2n);
  const ownerList = async (): Promise<Hex[]> => {
    const raw = await call(safe.address, "getOwners()");
    assert.equal(BigInt(`0x${raw.slice(66, 130)}`), 3n);
    return [0, 1, 2].map(i => `0x${raw.slice(130 + i * 64 + 24, 130 + (i + 1) * 64)}` as Hex);
  };
  assert.deepEqual((await ownerList()).toSorted(), [...safe.owners].toSorted());
  const observe = async (expected = safe) => {
    const at = await rpc("eth_getBlockByNumber", ["latest", false]);
    await rpc("anvil_mine", ["0x40"]);
    const inspection = await createCustodyReader(anvil.rpcUrl, "local-test", "observe", fetch, { profile, initializationHash: initialization.transactionHash }).safe(expected, profile,
      { number: BigInt(at.number).toString(), timestamp: BigInt(at.timestamp).toString(), hash: at.hash });
    records.push({ inspection }); return inspection;
  };
  await observe();
  const tokenArtifact = JSON.parse(await readFile(join(root, "contracts/evm/out/AGTMAICCIPToken.sol/AGTMAICCIPToken.json"), "utf8"));
  const vaultArtifact = JSON.parse(await readFile(join(root, "contracts/evm/out/GrantVault.sol/GrantVault.json"), "utf8"));
  const tokenArgs = await run(["abi-encode", "f(uint256,(bytes32,address,uint256)[],address)", "1000000", `[(${purpose},${executor.owner},1000000)]`, executor.owner]);
  const token = await deploy(`${tokenArtifact.bytecode.object}${tokenArgs.slice(2)}` as Hex);
  const balance = async (address: Hex): Promise<bigint> => BigInt(await call(token, "balanceOf(address)", [address]));
  const allowance = async (owner: Hex, spender: Hex): Promise<bigint> => BigInt(await call(token, "allowance(address,address)", [owner, spender]));
  const allocation = 36000n;
  const grants: { address: Hex; reserve: Hex; start: bigint; cliff: bigint; end: bigint; founder: boolean }[] = [];
  const grant = async (founder = false, reserve = executor.owner) => {
    const now = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
    const start = now + 1000n, cliff = start + 1000n, end = cliff + 36000n;
    const args = await run(["abi-encode", "f(address,address,address,address,(uint256,uint64,uint64,uint64,uint8,bytes32))", token, executor.owner, reserve, safe.address,
      `(${allocation},${start},${cliff},${end},${founder ? 0 : 1},${purpose})`]);
    const address = await deploy(`${vaultArtifact.bytecode.object}${args.slice(2)}` as Hex);
    const result = { address, reserve, start, cliff, end, founder }; grants.push(result); return result;
  };
  const fund = async (address: Hex) => {
    assert.equal((await send(token, await encode("approve(address,uint256)", [address, allocation.toString()]))).status, "0x1");
    assert.equal((await send(address, custodySelector("fund()"))).status, "0x1");
  };
  const teams = [await grant(), await grant(), await grant()];
  const founder = await grant(true);
  for (const g of [...teams, founder]) { await fund(g.address); }
  const verifier = createCastSignatureVerifier({ executable: cast, executableSha256: createHash("sha256").update(await readFile(cast)).digest("hex") });
  const sign = async (hash: Hex, indexes: number[]) => Promise.all(indexes.map(async i => ({ owner: keys[i]!.owner,
    signature: await run(["wallet", "sign", "--no-hash", hash, "--keystore", keys[i]!.path, "--password", "local-test-only"]) as Hex })));
  const nonce = async (): Promise<string> => BigInt(await call(safe.address, "nonce()")).toString();
  const fields = (to: Hex, data: Hex, txGas = "400000") => [to, "0", data, "0", txGas, "0", "0", zero, zero];
  const cancelCall = async (target: Hex): Promise<CustodySafeCall> => {
    const raw: CustodySafeCall = { address: safe.address, nonce: await nonce(), transactionHash: purpose, to: target, data: "0xea8a1af0", value: "0", operation: "CALL",
      safeTxGas: "400000", baseGas: "0", gasPrice: "0", gasToken: zero, refundReceiver: zero };
    const transactionHash = custodySafeHash("31337", raw);
    assert.equal(await call(safe.address, hashAbi, [...fields(target, raw.data), raw.nonce]), transactionHash);
    return { ...raw, transactionHash };
  };
  const rawExec = async (to: Hex, data: Hex, indexes = [0, 1]) => {
    const hash = await call(safe.address, hashAbi, [...fields(to, data), await nonce()]);
    const signatures = await sign(hash, indexes);
    return send(safe.address, await encode(execAbi, [...fields(to, data), packed(signatures)]));
  };
  const state = async (g: { address: Hex; reserve: Hex }) => ({ ledger: await call(g.address, "grant()"), funded: await call(g.address, "funded()"),
    beneficiary: await call(g.address, "BENEFICIARY()"), vaultBalance: (await balance(g.address)).toString(), reserveBalance: (await balance(g.reserve)).toString() });
  return { safe, keys, teams, founder, token, grant, fund, observe, balance, allowance, call, send, nonce, sign, encode, rawExec, cancelCall, verifier, state, rpc, records, evidenceDirectory, pins, selected, grants, root, executor, ownerList, fields, singleton, allocation, deploy };
}

test("official Safe 1.4.1 local signature execution, grant custody and owner rotation", { timeout: 240_000 }, async t => {
  const { safe, keys, teams, founder, token, grant, fund, observe, balance, allowance, call, send, nonce, sign, encode, rawExec, cancelCall, verifier, state, rpc, records, evidenceDirectory, pins, selected, grants, root, executor, ownerList, fields, singleton, allocation, deploy } = await localSafeFixture(t);
  await t.test("signature attacks, every owner pair and founder failure", async () => {
  const frozen = await state(teams[0]!);
  const initial = await cancelCall(teams[0]!.address), validSignatures = await sign(initial.transactionHash, [0, 1]);
  // Invalid signatures must fail in official Safe code, independently of adapter refusals.
  for (const indexes of [[0], [0, 0], [0, 3]]) {
    const before = await nonce(), signatures = await sign(initial.transactionHash, indexes);
    const result = await send(safe.address, await encode(execAbi, [...fields(initial.to, initial.data), packed(signatures)]));
    assert.equal(result.status, "0x0"); assert.equal(await nonce(), before); assert.deepEqual(await state(teams[0]!), frozen);
  }
  for (const changed of [{ nonce: "9" }, { address: singleton }, { to: founder.address }]) {
    const signatures = await sign(custodySafeHash("31337", { ...initial, ...changed }), [0, 1]);
    assert.equal((await send(safe.address, await encode(execAbi, [...fields(initial.to, initial.data), packed(signatures)]))).status, "0x0");
  }
  const wrongChain = await sign(custodySafeHash("11155111", initial), [0, 1]);
  assert.equal((await send(safe.address, await encode(execAbi, [...fields(initial.to, initial.data), packed(wrongChain)]))).status, "0x0");
  assert.equal((await send(safe.address, await encode(execAbi, [...fields(initial.to, custodySelector("release()")), packed(validSignatures)]))).status, "0x0");
  assert.equal(await nonce(), initial.nonce);
  assert.deepEqual(await state(teams[0]!), frozen);

  await rpc("evm_setNextBlockTimestamp", [Number(teams[0]!.cliff + 18000n)]);
  await rpc("evm_mine");
  for (const [i, pair] of [[0, [0, 1]], [1, [0, 2]], [2, [1, 2]]] as const) {
    const g = teams[i]!, intent = await cancelCall(g.address), beforeReserve = await balance(g.reserve);
    const signatures = await sign(intent.transactionHash, [...pair]);
    const data = await custodySafeCalldata("31337", intent, safe, signatures, verifier);
    const receipt = await send(safe.address, data);
    assert.equal(receipt.status, "0x1");
    assert.equal(custodySafeResult("31337", intent, receipt.logs), "success");
    assert.equal(BigInt(await nonce()), BigInt(intent.nonce) + 1n);
    const at = await rpc("eth_getBlockByHash", [receipt.blockHash, false]);
    const vested = BigInt(at.timestamp) - g.cliff;
    assert.equal(await balance(g.address), vested);
    assert.equal(await balance(g.reserve) - beforeReserve, allocation - vested);
    assert.equal(BigInt(await call(g.address, "available()")), vested);
    records.push({ intent, recoveredSigners: signatures.map(s => s.owner), nonceAfter: await nonce(), state: await state(g) });
    const nonceBeforeReplay = await nonce();
    assert.equal((await send(safe.address, data)).status, "0x0");
    assert.equal(await nonce(), nonceBeforeReplay);
  }
  const founderBefore = await state(founder), founderCall = await cancelCall(founder.address);
  const founderData = await custodySafeCalldata("31337", founderCall, safe, await sign(founderCall.transactionHash, [0, 2]), verifier);
  const failure = await send(safe.address, founderData);
  assert.equal(failure.status, "0x1");
  assert.equal(custodySafeResult("31337", founderCall, failure.logs), "failure");
  assert.deepEqual(await state(founder), founderBefore);
  assert.equal(BigInt(await nonce()), BigInt(founderCall.nonce) + 1n);
  assert.equal(failure.logs.some((l: { topics: Hex[] }) => l.topics[0] === custodyTopic("TeamGrantCancelled(bytes32,uint256,uint256,uint64)")), false);
  // A fully signed outer revert (Safe requires success when safeTxGas == 0) preserves the nonce too.
  const beforeOuterRevert = await nonce(), zeroGasHash = await call(safe.address, hashAbi, [...fields(founder.address, "0xea8a1af0", "0"), beforeOuterRevert]);
  assert.equal((await send(safe.address, await encode(execAbi, [...fields(founder.address, "0xea8a1af0", "0"), packed(await sign(zeroGasHash, [0, 1]))]))).status, "0x0");
  assert.equal(await nonce(), beforeOuterRevert);
  assert.deepEqual(await state(founder), founderBefore);

  });

  await t.test("reserve caller routing", async () => {
  // Two ordinary transactions prove the local Safe-as-reserve route, without reserve-cap claims.
  const safeReserve = await grant(false, safe.address);
  assert.equal((await send(token, await encode("transfer(address,uint256)", [safe.address, allocation.toString()]))).status, "0x1");
  assert.equal((await rawExec(token, await encode("approve(address,uint256)", [safeReserve.address, allocation.toString()]))).status, "0x1");
  assert.equal(await allowance(safe.address, safeReserve.address), allocation);
  assert.equal(BigInt(await call(safeReserve.address, "funded()")), 0n);
  assert.equal((await rawExec(safeReserve.address, custodySelector("fund()"))).status, "0x1");
  assert.equal(await balance(safeReserve.address), allocation); assert.equal(await balance(safe.address), 0n);
  assert.equal(await allowance(safe.address, safeReserve.address), 0n);
  assert.equal(BigInt(await call(safeReserve.address, "funded()")), 1n);
  // A distinct contract reserve cannot be bypassed by the controller Safe.
  const reserveArtifact = JSON.parse(await readFile(join(root, "contracts/evm/out/GrantVaultFixtures.sol/ContractCaller.json"), "utf8"));
  const otherReserve = await deploy(reserveArtifact.bytecode.object), wrongRoute = await grant(false, otherReserve);
  const wrongRouteBefore = await state(wrongRoute), wrongNonce = await nonce();
  const wrongFunding = await rawExec(wrongRoute.address, custodySelector("fund()"));
  assert.equal(wrongFunding.status, "0x1");
  assert.ok(wrongFunding.logs.some((l: { topics: Hex[] }) => l.topics[0] === custodyTopic("ExecutionFailure(bytes32,uint256)")));
  assert.equal(BigInt(await nonce()), BigInt(wrongNonce) + 1n); assert.deepEqual(await state(wrongRoute), wrongRouteBefore);

  });

  const rotated = { ...safe, owners: safe.owners.map(o => o === keys[0]!.owner ? executor.owner : o) };
  await t.test("standard owner replacement invalidates old keys and observations", async () => {
  const list = await ownerList(), old = keys[0]!.owner, position = list.indexOf(old);
  const previous = position === 0 ? "0x0000000000000000000000000000000000000001" : list[position - 1]!;
  assert.equal((await rawExec(safe.address, await encode("swapOwner(address,address,address)", [previous, old, executor.owner]), [1, 2])).status, "0x1");
  assert.deepEqual((await ownerList()).toSorted(), [...rotated.owners].toSorted());
  assert.equal(BigInt(await call(safe.address, "getThreshold()")), 2n);
  await assert.rejects(observe(), /CUSTODY_SAFE_THRESHOLD_OR_OWNERS/);
  await observe(rotated);
  const rotatedTarget = await grant(); await fund(rotatedTarget.address);
  const oldNonce = await nonce(), oldKeyResult = await rawExec(rotatedTarget.address, "0xea8a1af0", [0, 1]);
  assert.equal(oldKeyResult.status, "0x0"); assert.equal(await nonce(), oldNonce);
  const rotatedCall = await cancelCall(rotatedTarget.address);
  const newData = await custodySafeCalldata("31337", rotatedCall, rotated, await sign(rotatedCall.transactionHash, [1, 3]), verifier);
  assert.equal(custodySafeResult("31337", rotatedCall, (await send(safe.address, newData)).logs), "success");

  });

  await t.test("frozen debt and founder claims survive the original end", async () => {
  await rpc("evm_setNextBlockTimestamp", [Number(founder.end + 100n)]); await rpc("evm_mine");
  for (const g of [...teams, founder]) {
    const owed = BigInt(await call(g.address, "available()")), before = await balance(executor.owner);
    assert.equal((await send(g.address, custodySelector("release()"))).status, "0x1");
    assert.equal(await balance(executor.owner) - before, owed); assert.equal(await balance(g.address), 0n);
  }
  assert.equal(BigInt(await call(token, "totalSupply()")), 1000000n);
  });
  await writeFile(join(evidenceDirectory, "evidence.json"), deploymentBytes({ schema: "agtmai-safe-local-test-evidence-v1", qualification: "local observations; acceptance requires a successful test exit",
    reserveCapEnforcement: "unimplemented-unproven", pins, selectedPinsSha256: selected, safe, rotated,
    grants: grants.map(g => ({ ...g, start: g.start.toString(), cliff: g.cliff.toString(), end: g.end.toString() })), records }), { flag: "wx" });
  const evidenceBytes = await readFile(join(evidenceDirectory, "evidence.json")), evidence = JSON.parse(evidenceBytes.toString());
  assert.deepEqual(evidenceBytes, Buffer.from(deploymentBytes(evidence)));
  assert.deepEqual(evidence.grants.map((g: { start: string; cliff: string; end: string }) => [g.start, g.cliff, g.end]),
    grants.map(g => [g.start.toString(), g.cliff.toString(), g.end.toString()]));
});
