import { svmFactoryUnit, svmReverseUnit, svmCompilerUnit, svmLookupFailureUnit, svmCaptured, svmSigningEffects } from './test-sdk-svm.native.mts';
// Direct node:test entry. Public args belong to this script, never to `node --test`.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, renameSync, symlinkSync, linkSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire, registerHooks } from "node:module";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import { openTestSdk, admitTestSdk, readTestSdkBytes, readTestSdkPayload, checkTestSdkRuntime, testSdkCounters } from "../src/adapters/test-sdk-admission.ts";
import { TEST_SDK_PROFILE, TEST_SDK_ROOT_HASHES, TEST_SDK_NODE_HASH } from "../src/adapters/test-sdk-policy.ts";
import { createEvmForwardSdk } from "../src/adapters/evm-forward-sdk.mjs";
import { readDevProviderArchive } from "../src/adapters/dev-provider-archive.mjs";
import { forwardIntent, forwardRoute } from "../src/domain/evm-forward.mjs";
import { validateSepoliaIntent, type SepoliaIntentInput } from "../src/domain/evm-intent.ts";
import { solanaPublicKeyBytes } from "../src/domain/solana-mint.ts";
import { selectedFixture } from "../src/domain/replacement-fixture.ts";
import { DEFAULT_SEPOLIA_RPC } from "../src/adapters/test-rpc.ts";
import data from "./fixtures/test-sdk-execution-v1.json" with { type: "json" };

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!key || !value || !["--phase", "--root", "--archives", "--fixture", "--captures", "--out", "--scenario"].includes(key) || args.has(key)) { throw new Error("Invalid public SDK runner arguments"); }
  args.set(key, value);
}
function arg(key: string): string { const value = args.get(key); if (!value) { throw new Error("Missing " + key); } return value; }
const phase = arg("--phase"), root = arg("--root"), archives = arg("--archives"), fixturePath = arg("--fixture"), captures = arg("--captures"), out = arg("--out");
const repo = fileURLToPath(new URL("../../../", import.meta.url));
for (const path of [root, archives, fixturePath, captures, out]) { if (resolve(path) !== path) { throw new Error("Absolute public runner paths required"); } }
if (!out.startsWith(join(repo, ".local") + "/") || !["admission", "forward", "contract", "svm"].includes(phase)) { throw new Error("Owned .local evidence and explicit implemented phase required"); }
mkdirSync(out, { recursive: true, mode: 0o700 });
const scenario = args.get("--scenario");
const results: { name: string; passed: boolean; reason?: string }[] = [];
let networkEffects = 0, unguardedLoadAttempts = 0;
const deny = (): never => { networkEffects++; throw new Error("Native TEST network sentinel"); };
globalThis.fetch = deny; http.request = deny; https.request = deny; http2.connect = deny; net.Socket.prototype.connect = deny;
// This observer sees only loads that reach the ordinary loader; the admission
// hook serves held bytes without next(). Its own counters count admitted loads.
const count = registerHooks({ load(url, context, next) { if (url.startsWith(pathToFileURL(root + "/").href)) { unguardedLoadAttempts++; } return next(url, context); } });
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function object(value: unknown): Record<string, unknown> { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
function readJson(path: string): Record<string, unknown> { return object(JSON.parse(readTestSdkBytes(path).toString()) as unknown); }
const selectionInput = readJson(fixturePath), fixture = selectedFixture(selectionInput);
assert.ok(fixture, "Required exact replacement fixture");
const selection = { providerProfile: TEST_SDK_PROFILE, testOnly: true, fixture, fixtureIdentity: fixture.identity, providerArchives: archives };
let admission: ReturnType<typeof admitTestSdk> | undefined;
const metrics: Record<string, unknown> = {};
const svmInputs = {root, archives, captures, out, fixture};
const custodyPath = join(dirname(root), "OPERATOR-SNAPSHOT-CUSTODY.json");
const mount = readFileSync("/proc/self/mountinfo", "utf8").split("\n").map(line => line.split(" ")).find(fields => fields[4] === root);
metrics.custody = { descriptorSha256: existsSync(custodyPath) ? digest(readTestSdkBytes(custodyPath)) : null,
  operatorDescriptor: existsSync(custodyPath) ? readJson(custodyPath) : null, observedReadOnlyMount: mount?.[5]?.split(",").includes("ro") ?? false,
  boundary: "Held source; metadata requires operator lifetime custody. Disposable mutation copies are quiescent test inputs, not immutable-execution proof." };
async function check(name: string, work: () => void | Promise<void>): Promise<void> {
  await test(name, async () => {
    try {
      await work();
      assert.equal(networkEffects, 0, 'Attempted network effects must be zero');
      assert.equal(svmSigningEffects(), 0, 'Attempted signing effects must be zero');
      assert.equal(unguardedLoadAttempts, 0, 'Unguarded provider load attempts must be zero');
      results.push({ name, passed: true });
    }
    catch (error) { results.push({ name, passed: false, reason: error instanceof Error ? error.message : String(error) }); throw error; }
  });
}
// This deliberate negative child catches the denial after a real admitted factory unit.
// The parent regression must observe refusal, with the attempted count retained.
async function caughtNetworkUnit(): Promise<void> {
  metrics.svm = await svmFactoryUnit('svm-mint-unit', svmInputs);
  assert.throws(() => globalThis.fetch('https://api.devnet.solana.com'), /Native TEST network sentinel/);
  assert.equal(networkEffects, 1);
}
async function networkSentinelRegression(): Promise<void> {
  const childOut = join(out, 'caught-child');
  const command = [fileURLToPath(import.meta.url), '--phase', 'svm', '--root', root, '--archives', archives,
    '--fixture', fixturePath, '--captures', captures, '--out', childOut, '--scenario', 'svm-caught-network-unit'];
  const child = spawnSync(process.execPath, command, { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: out },
    encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(join(out, 'caught-child.log'), child.stdout + child.stderr);
  assert.equal(child.status, 1, 'A caught network attempt must fail the child');
  const evidence = readJson(join(childOut, 'result.json'));
  assert.equal(evidence.networkEffects, 1); assert.equal(evidence.signingEffects, 0); assert.equal(evidence.unguardedLoadAttempts, 0);
  assert.ok(Array.isArray(evidence.results)); const result = object(evidence.results[0]);
  assert.equal(result.passed, false); assert.equal(typeof result.reason, 'string');
  assert.match(String(result.reason), /^Attempted network effects must be zero/);
  metrics.caughtNetworkRegression = evidence;
}
function modes(source: string, destination: string): void {
    chmodSync(destination, lstatSync(source).mode & 0o7777);
    for (const name of readdirSync(source)) { if (lstatSync(join(source, name)).isDirectory()) { modes(join(source, name), join(destination, name)); } }
  }
function ownedSnapshot(): { root: string; dispose(): void } {
  const parent = mkdtempSync(join(out, "snapshot-")), target = join(parent, "provider");
  cpSync(root, target, { recursive: true, preserveTimestamps: true }); chmodSync(parent, 0o700);
  modes(root, target);
  return { root: target, dispose: () => rmSync(parent, { recursive: true, force: true }) };
}
function countersZero(): void { assert.equal(networkEffects, 0); assert.equal(unguardedLoadAttempts, 0); assert.equal(testSdkCounters()?.loads ?? 0, 0); }
async function authentication(): Promise<void> {
  admission = admitTestSdk({ root, archives }); assert.equal(admission.owners, 99); assert.equal(admission.uniqueArchives, 95); countersZero();
  await assert.rejects(createEvmForwardSdk(root, undefined, fixture, DEFAULT_SEPOLIA_RPC), /Unreviewed CCIP provider installation/); countersZero();
  const index = object(readJson(join(archives, "index.json")).placements), lock = object(readJson(join(root, "package-lock.json")).packages);
  const ordinary = readTestSdkBytes(join(archives, String(index["node_modules/yaml"]))), tar = gunzipSync(ordinary);
  for (const boundary of ["checksum", "type", "path", "padding", "termination"]) {
    const changed = Buffer.from(tar); let header = false;
    if (boundary === "checksum") { changed[100] = (changed[100] ?? 0) ^ 1; }
    if (boundary === "type") { changed[156] = 50; header = true; }
    if (boundary === "path") { changed.fill(0, 0, 100); changed.write("package/../sentinel", 0, "ascii"); header = true; }
    if (header) {
      changed.fill(32, 148, 156); const checksum = changed.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
      changed.write(checksum.toString(8).padStart(6, "0") + "\0\0", 148, "ascii");
    }
    if (boundary === "padding") {
      let cursor = 0;
      for (;;) { const size = parseInt(changed.subarray(cursor + 124, cursor + 136).toString("ascii"), 8);
        if (size % 512) { changed[cursor + 512 + size] = 1; break; } cursor += 512 + size; }
    }
    if (boundary === "termination") { changed[changed.length - 1] = 1; }
    const archive = gzipSync(changed), integrity = "sha512-" + createHash("sha512").update(archive).digest("base64");
    assert.throws(() => readDevProviderArchive(archive, integrity), boundary === "checksum" ? /checksum mismatch/ : boundary === "type" ? /unsupported type/ : boundary === "path" ? /unsafe path/ : boundary === "padding" ? /nonzero padding/ : /invalid termination/);
    countersZero();
  }
  metrics.archiveReaderUnitBoundaries = ["checksum", "type", "path", "padding", "termination"];
  let exceptionFiles = 0;
  for (const owner of Object.keys(data.fixedMembers)) {
    const locator = index[owner]; assert.equal(typeof locator, "string"); const archive = readTestSdkBytes(join(archives, String(locator)));
    const integrity = object(lock[owner]).integrity; assert.equal(typeof integrity, "string");
    assert.throws(() => readDevProviderArchive(archive, integrity), /unreviewed mode|unsupported type/);
    const payload = readTestSdkPayload(owner, archive, String(integrity)); exceptionFiles += [...payload.values()].filter(v => v.type === "file").length;
    const changed = Buffer.from(archive); changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
    assert.throws(() => readTestSdkPayload(owner, changed, String(integrity)), /SRI mismatch/);
    // Even a supplied matching SRI cannot expand the fixed SHA-bound table.
    assert.throws(() => readTestSdkPayload(owner, changed, "sha512-" + createHash("sha512").update(changed).digest("base64")), /SHA256 mismatch/);
  }
  assert.equal(exceptionFiles, 59); metrics.exceptionFiles = exceptionFiles;
  const copy = ownedSnapshot(), mutated: string[] = [];
  const observer = registerHooks({ load(url, context, next) { if (url.startsWith(pathToFileURL(copy.root + "/").href)) { unguardedLoadAttempts++; } return next(url, context); } });
  try {
    const files = ["node_modules/@chainlink/ccip-sdk/package.json", "node_modules/@chainlink/ccip-sdk/dist/ton/index.js",
      "node_modules/ethers/lib.esm/abi/index.js", "node_modules/@noble/curves/node_modules/@noble/hashes/sha256.js",
      "node_modules/superstruct/lib/index.cjs.map", "node_modules/yaml/package.json"];
    for (const local of files) {
      const path = join(copy.root, local), original = readFileSync(path);
      writeFileSync(path, Buffer.concat([original, Buffer.from("\n ")]));
      try { await assert.rejects(openTestSdk({ root: copy.root, archives }), /payload byte drift/); countersZero(); mutated.push(local); }
      finally { writeFileSync(path, original); }
    }
    const target = join(copy.root, "node_modules/yaml/package.json"), original = readFileSync(target);
    chmodSync(target, 0o644); await assert.rejects(openTestSdk({ root: copy.root, archives }), /file type\/mode\/link/); chmodSync(target, 0o600); countersZero();
    const saved = target + ".owned-save"; renameSync(target, saved); symlinkSync(saved, target);
    await assert.rejects(openTestSdk({ root: copy.root, archives }), /payload|file type/); rmSync(target); renameSync(saved, target); countersZero();
    const hard = join(out, "hardlink-owned"); linkSync(target, hard);
    await assert.rejects(openTestSdk({ root: copy.root, archives }), /file type\/mode\/link/); rmSync(hard); countersZero();
    rmSync(target); await assert.rejects(openTestSdk({ root: copy.root, archives }), /missing payload/); writeFileSync(target, original, { mode: 0o600 }); countersZero();
    const npmIgnore = join(copy.root, "node_modules/jayson/.npmignore"), gitIgnore = join(copy.root, "node_modules/jayson/.gitignore");
    renameSync(npmIgnore, gitIgnore); await assert.rejects(openTestSdk({ root: copy.root, archives }), /injected payload/); renameSync(gitIgnore, npmIgnore); countersZero();
    const extra = join(copy.root, "node_modules/yaml/injected.js"); writeFileSync(extra, "throw new Error('must never evaluate')", { mode: 0o600 });
    await assert.rejects(openTestSdk({ root: copy.root, archives }), /injected payload/); rmSync(extra); countersZero();
    const locators = mkdtempSync(join(out, "locators-")); chmodSync(locators, 0o700);
    try {
      const originalIndex = readFileSync(join(archives, "index.json"), "utf8");
      const unsafe = { schema: "agtmai-test-sdk-archive-locator-v1", placements: { ...index, "node_modules/yaml": "../outside.tgz" } };
      for (const [content, reason] of [[JSON.stringify(unsafe), /unsafe\/missing archive locator/],
        [originalIndex.replace('"placements": {', '"placements": {}, "placements": {'), /ambiguous archive locator/]] as const) {
        writeFileSync(join(locators, "index.json"), content, { mode: 0o600 });
        // Earlier owners need valid real archives before the late traversal boundary.
        for (const name of new Set(Object.values(index))) { assert.equal(typeof name, "string"); cpSync(join(archives, String(name)), join(locators, String(name))); }
        await assert.rejects(openTestSdk({ root: copy.root, archives: locators }), reason); countersZero();
      }
    } finally { rmSync(locators, { recursive: true, force: true }); }
    metrics.mutations = mutated;
  } finally { observer.deregister(); copy.dispose(); }
}
async function optional(): Promise<void> {
  const copy = ownedSnapshot(), parentModules = join(dirname(copy.root), "node_modules"); mkdirSync(parentModules, { mode: 0o700 });
  try {
    for (const [owner, name] of [["ws/lib/buffer-util.js", "bufferutil"], ["ws/lib/validation.js", "utf-8-validate"], ["jayson/node_modules/ws/lib/buffer-util.js", "bufferutil"],
      ["jayson/node_modules/ws/lib/validation.js", "utf-8-validate"], ["node-fetch/lib/index.js", "encoding"], ["bigint-buffer/dist/node.js", "node-gyp-build"], ["debug/src/node.js", "supports-color"]]) {
      assert.ok(owner && name); const shadow = join(parentModules, name); mkdirSync(shadow, { mode: 0o700 });
      writeFileSync(join(shadow, "index.js"), "throw new Error('harmless sentinel never loaded')", { mode: 0o600 });
      const resolved = createRequire(join(copy.root, "node_modules", owner)).resolve(name); assert.equal(resolved, join(shadow, "index.js"));
      await assert.rejects(openTestSdk({ root: copy.root, archives }), /optional\/native branch reachable/); countersZero(); rmSync(shadow, { recursive: true });
    }
    for (const key of ["NODE_PATH", "NODE_OPTIONS", "NODE_BINDINGS_COMPILED_DIR", "HTTPS_PROXY", "NODE_COMPILE_CACHE", "AGTMAI_PUBLIC_NETWORK"]) {
      const previous = process.env[key]; process.env[key] = "sentinel";
      try { assert.throws(checkTestSdkRuntime, /runtime environment/); countersZero(); }
      finally { if (previous === undefined) { delete process.env[key]; } else { process.env[key] = previous; } }
    }
  } finally { copy.dispose(); }
}
async function guard(): Promise<void> {
  const copy = ownedSnapshot();
  try {
    const sdkTarget = join(copy.root, "node_modules/@chainlink/ccip-sdk/dist/ton/index.js");
    const control = createRequire(join(copy.root, "package.json"));
    assert.equal(control.resolve("@chainlink/ccip-sdk/dist/ton/index.js"), sdkTarget);
    const nativeTarget = join(out, "harmless-owned.node"), hostTarget = join(out, "harmless-host.cjs");
    writeFileSync(nativeTarget, "never executed", { mode: 0o600 }); writeFileSync(hostTarget, "throw new Error('never executed')", { mode: 0o600 });
    assert.equal(control.resolve(nativeTarget), nativeTarget); assert.equal(control.resolve(hostTarget), hostTarget);
    const session = await openTestSdk({ root: copy.root, archives }); admission = session.evidence;
    try {
      assert.equal(typeof session.evm.EVMChain.fromUrl, "function"); assert.ok(session.counters().loads > 500);
      assert.deepEqual(testSdkCounters(), session.counters());
      const req = createRequire(join(copy.root, "node_modules/ethers/package.json"));
      assert.equal(typeof req("ethers/abi").Interface, "function");
      // A previously unvisited published runtime member is mutated AFTER authentication.
      const local = "node_modules/yaml/bin.mjs", target = join(copy.root, local);
      // CLI sources are never granted execution merely by authenticating their payload.
      assert.ok(existsSync(target));
      const before = session.counters().loads;
      assert.throws(() => req("@chainlink/ccip-sdk"), /unadmitted/);
      assert.throws(() => req(target), /unadmitted/);
      await assert.rejects(import(pathToFileURL(sdkTarget).href), /unadmitted/);
      assert.equal(session.counters().loads, before); assert.throws(session.assertHealthy, /unadmitted/);
      // Actual computed CJS resolution from a candidate parent cannot import host source.
      assert.throws(() => req("node:child_process"), /specifier: node:child_process/);
      assert.throws(() => req(hostTarget), /candidate into host/);
      await assert.rejects(import(pathToFileURL(sdkTarget).href + "?query=1"), /specifier:.*query=1/);
      const dataUrl = "data:text/javascript,globalThis.__never=1";
      await assert.rejects(import(dataUrl), /specifier: data/);
      assert.throws(() => req(nativeTarget), /native target/);
      assert.equal(session.counters().loads, before); assert.equal(networkEffects, 0); metrics.guard = session.counters();
      metrics.forbiddenTargetEvaluations = 0; // Each real target rejected before any admitted load.
    } finally { session.close(); assert.equal(session.counters().closed, true); rmSync(nativeTarget); rmSync(hostTarget); }
  } finally { copy.dispose(); }
}
async function held(): Promise<void> {
  const copy = ownedSnapshot();
  try {
    const session = await openTestSdk({ root: copy.root, archives }); admission = session.evidence;
    try {
      const target = join(copy.root, "node_modules/bignumber.js/bignumber.js");
      const before = session.counters().loads; writeFileSync(target, "throw new Error('disk replacement must not evaluate')");
      const req = createRequire(join(copy.root, "package.json")); const ctor: unknown = req("bignumber.js");
      assert.equal(typeof ctor, "function"); assert.ok(session.counters().loads > before); session.assertHealthy(); metrics.held = session.counters();
    } finally { session.close(); }
  } finally { copy.dispose(); }
}
async function constructorUnit(): Promise<void> {
  let calls = 0;
  const client = await createEvmForwardSdk(root, undefined, fixture, DEFAULT_SEPOLIA_RPC, { ...selection, replayFetch: async (_input, init) => {
    calls++; const request: unknown = JSON.parse(String(init?.body));
    const answer = (r: unknown): unknown => { const row = object(r); assert.equal(row.method, "eth_chainId"); assert.deepEqual(row.params, []); return { jsonrpc: "2.0", id: row.id, result: "0xaa36a7" }; };
    return new Response(JSON.stringify(Array.isArray(request) ? request.map(answer) : answer(request)));
  } });
  try {
    assert.ok(Object.isFrozen(client)); assert.deepEqual(Object.keys(client).toSorted(), ["allowance", "destroy", "prepare", "verify"]);
    assert.ok(calls >= 1); metrics.controlledConstructorRequests = calls;
  } finally { await client.destroy(); }
  assert.equal(networkEffects, 0);
}
// Real admitted client with a stalled, signal-responsive unit transport. SDK
// request cancellation can settle before the transport has finished its cleanup.
async function destroyUnit(unresolved = false): Promise<void> {
  let stall = false, signal: AbortSignal | null | undefined, finishRead: (() => void) | undefined;
  const { promise: reading, resolve: entered } = Promise.withResolvers<void>();
  const replay: typeof fetch = async (_input, init) => {
    if (stall) {
      signal = init?.signal; assert.ok(signal);
      await new Promise<never>((_resolve, reject) => {
        finishRead = () => reject(new Error("Controlled stalled read aborted"));
        signal!.addEventListener("abort", () => {
          assert.equal(process.env.WS_NO_BUFFER_UTIL, "1", "guard retained during transport cancellation");
        }, { once: true });
        entered();
      });
    }
    const request: unknown = JSON.parse(String(init?.body));
    const answer = (value: unknown): unknown => { const row = object(value); assert.equal(row.method, "eth_chainId");
      return { jsonrpc: "2.0", id: row.id, result: "0xaa36a7" }; };
    return new Response(JSON.stringify(Array.isArray(request) ? request.map(answer) : answer(request)));
  };
  const client = await createEvmForwardSdk(root, undefined, fixture, DEFAULT_SEPOLIA_RPC, { ...selection, replayFetch: replay });
  stall = true;
  const pending = client.allowance();
  const rejected = assert.rejects(pending, unresolved ? /Unresolved TEST SDK forward drain/ : /aborted|cancelled|destroyed/i);
  await reading;
  let complete = false;
  const destroying = client.destroy();
  void destroying.then(() => complete = true, () => false);
  try {
    assert.equal(signal?.aborted, true, "destroy must abort the owned transport before awaiting busy");
    assert.strictEqual(client.destroy(), destroying, "repeat destroy shares the actual cleanup promise");
    await assert.rejects(client.allowance(), /busy\/destroyed|session destroyed/);
    await assert.rejects(client.prepare(), /busy\/destroyed|session destroyed/);
    await delay(30);
    assert.equal(complete, false, "destroy must drain transport cleanup as well as the SDK operation");
    assert.equal(process.env.WS_NO_BUFFER_UTIL, "1", "hooks remain installed until transport cleanup finishes");
    if (unresolved) {
      await assert.rejects(destroying, /^Error: Unresolved TEST SDK forward drain$/);
      assert.equal(testSdkCounters()?.closed, false, "unresolved transport must retain admission hooks");
      assert.strictEqual(client.destroy(), destroying, "unresolved destroy remains the same rejected promise");
    }
  } finally {
    // Also release the baseline run after its assertion fails, without hanging a child.
    finishRead?.();
  }
  await rejected;
  if (!unresolved) { await destroying; }
  await delay(0);
  assert.strictEqual(client.destroy(), destroying);
  assert.equal(process.env.WS_NO_BUFFER_UTIL, undefined);
  assert.equal(process.env.WS_NO_UTF_8_VALIDATE, undefined);
  await assert.rejects(client.allowance(), /busy\/destroyed|session destroyed/);
  assert.throws(() => client.verify({ from: "0x", to: "0x", data: "0x", value: 0n }, "send", 0n), /busy\/destroyed|session destroyed/);
  metrics.destroy = { ownedSignalAborted: true, repeatedPromiseShared: true, transportDrained: true, hooksClosedAfterDrain: true,
    unresolvedDrainReported: unresolved };
  assert.equal(networkEffects, 0);
}
// Full actual generator under controlled unit replies. These bytes are synthetic unit
// responses, never captures, deployment discovery evidence or T5/T6 qualification.
async function generatorUnit(name: string): Promise<void> {
  assert.ok(fixture);
  const req = createRequire(join(root, "package.json"));
  let abi: typeof import("../../../.local/INPUT/provider/node_modules/ethers/lib.commonjs/abi/index.js") | undefined;
  const router = "0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59", zero = "0x" + "00".repeat(20);
  const dummyRamp = fixture.administrator, dummyRegistry = fixture.token; // reused public identities in synthetic unit roles; no registration claim
  const signatures = ["function typeAndVersion() view returns(string)", "function allowance(address,address) view returns(uint256)",
    "function getOnRamp(uint64) view returns(address)", "function getStaticConfig() view returns((uint64,address,address,address))",
    "function getTokenConfig(address) view returns((address,address,address))", "function getToken() view returns(address)", "function getRouter() view returns(address)",
    "function getRemoteToken(uint64) view returns(bytes)", "function getRemotePools(uint64) view returns(bytes[])",
    "function getCurrentOutboundRateLimiterState(uint64) view returns((uint128,uint32,bool,uint128,uint128))",
    "function getCurrentInboundRateLimiterState(uint64) view returns((uint128,uint32,bool,uint128,uint128))",
    "function getFee(uint64,(bytes,bytes,(address,uint256)[],address,bytes)) view returns(uint256)"];
  let calls = 0, feeCalls = 0;
  const exact = name === "unsigned-exact-unit", amount = BigInt(fixture.amount);
  const replay: typeof fetch = async (_input, init) => {
    const payload: unknown = JSON.parse(String(init?.body));
    const answer = (value: unknown): unknown => {
      calls++; const r = object(value); let result: string;
      if (r.method === "eth_chainId") { assert.deepEqual(r.params, []); result = name === "invalid-chain-unit" ? "0x1" : "0xaa36a7"; }
      else {
        assert.equal(r.method, "eth_call"); assert.ok(abi); assert.ok(Array.isArray(r.params));
        const call = object(r.params[0]); assert.equal(typeof call.data, "string"); assert.equal(typeof call.to, "string");
        const iface = new abi.Interface(signatures), parsed = iface.parseTransaction({ data: String(call.data) }); assert.ok(parsed);
        const f = parsed.name, to = String(call.to).toLowerCase(); let values: readonly unknown[];
        if (f === "typeAndVersion") { values = [to === router ? "Router 1.2.0" : to === dummyRamp ? "EVM2EVMOnRamp 1.6.0" : "LockReleaseTokenPool 1.6.1"]; }
        else if (f === "allowance") { assert.equal(to, fixture.token); values = [name === "invalid-allowance-unit" ? amount + 1n : exact ? amount : 0n]; }
        else if (f === "getOnRamp") { assert.equal(to, router); assert.equal(parsed.args[0], BigInt(fixture.forwardSelector)); values = [dummyRamp]; }
        else if (f === "getStaticConfig") { assert.equal(to, dummyRamp); values = [[BigInt(fixture.reverseSelector), zero, zero, dummyRegistry]]; }
        else if (f === "getTokenConfig") { assert.equal(to, dummyRegistry); values = [[fixture.administrator, zero, name === "invalid-discovery-unit" ? zero : fixture.pool]]; }
        else if (f === "getToken") { assert.equal(to, fixture.pool); values = [fixture.token]; }
        else if (f === "getRouter") { assert.equal(to, fixture.pool); values = [router]; }
        else if (f === "getRemoteToken") { values = ["0x" + Buffer.from(solanaPublicKeyBytes(fixture.mint)).toString("hex")]; }
        else if (f === "getRemotePools") { values = [["0x" + Buffer.from(solanaPublicKeyBytes(fixture.solanaPool)).toString("hex")]]; }
        else if (f.startsWith("getCurrent")) { values = [[0n, 0, false, 0n, 0n]]; }
        else { assert.equal(f, "getFee"); assert.equal(to, router); feeCalls++; values = [name === "invalid-fee-unit" ? 0n : 5n]; }
        result = iface.encodeFunctionResult(parsed.fragment, values);
      }
      return { jsonrpc: "2.0", id: r.id, result };
    };
    return new Response(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
  };
  if (name === "invalid-chain-unit") {
    await assert.rejects(createEvmForwardSdk(root, undefined, fixture, DEFAULT_SEPOLIA_RPC, { ...selection, replayFetch: replay }), /Wrong TEST SDK source chain/);
    assert.equal(networkEffects, 0); metrics.constructorFailure = "wrong-chain rejected with owned abort/teardown"; return;
  }
  const client = await createEvmForwardSdk(root, undefined, fixture, DEFAULT_SEPOLIA_RPC, { ...selection, replayFetch: replay });
  abi = req("ethers/abi"); assert.ok(abi);
  try {
    if (name.startsWith("invalid-")) {
      await assert.rejects(client.prepare(), name === "invalid-allowance-unit" ? /Unbounded existing router allowance/ : name === "invalid-fee-unit" ? /Native fee outside/ : /selected forward pool discovery|not configured/i);
    } else {
      assert.equal(await client.allowance(), exact ? amount : 0n);
      const prepared = await client.prepare();
      const raw = object(prepared.send);
      assert.equal(typeof raw.from, "string"); assert.equal(typeof raw.to, "string"); assert.equal(typeof raw.data, "string"); assert.equal(typeof raw.value, "bigint");
      const candidate = { ...prepared, send: { from: String(raw.from), to: String(raw.to), data: String(raw.data), value: BigInt(String(raw.value)) } };
      assert.equal(candidate.fee, 5n); assert.equal(!!candidate.approval, !exact); assert.ok(Object.isFrozen(prepared.send));
      const iface = new abi.Interface(["function approve(address,uint256)", "function ccipSend(uint64,(bytes,bytes,(address,uint256)[],address,bytes)) payable returns(bytes32)"]);
      const extra = "0x1f3b3aba" + abi.AbiCoder.defaultAbiCoder().encode(["tuple(uint32,uint64,bool,bytes32,bytes32[])"],
        [[0n, 0n, true, "0x" + Buffer.from(solanaPublicKeyBytes(fixture.recipient)).toString("hex"), []]]).slice(2);
      const message = ["0x" + "00".repeat(32), "0x", [[fixture.token, amount]], zero, extra];
      assert.equal(candidate.send.data, iface.encodeFunctionData("ccipSend", [BigInt(fixture.forwardSelector), message]));
      if (candidate.approval) { assert.equal(candidate.approval.data, iface.encodeFunctionData("approve", [router, amount])); }
      const wrongMessages = [
        ["0x" + "00".repeat(20), ...message.slice(1)], [message[0], "0x01", ...message.slice(2)],
        [...message.slice(0, 2), [[fixture.token, amount + 1n]], ...message.slice(3)],
        [...message.slice(0, 2), [[fixture.pool, amount]], ...message.slice(3)],
        [...message.slice(0, 3), fixture.token, extra], [...message.slice(0, 4), "0x"],
      ];
      for (const tx of [{ ...candidate.send, value: 0n }, { ...candidate.send, to: fixture.token }, { ...candidate.send, from: fixture.token },
        { ...candidate.send, data: iface.encodeFunctionData("ccipSend", [BigInt(fixture.forwardSelector) + 1n, message]) },
        ...wrongMessages.map(m => ({ ...candidate.send, data: iface.encodeFunctionData("ccipSend", [BigInt(fixture.forwardSelector), m]) }))]) {
        assert.throws(() => client.verify(tx, "send", 5n), /decoded forward operation/);
      }
      assert.throws(() => client.verify({ from: fixture.administrator, to: fixture.token, value: 0n,
        data: iface.encodeFunctionData("approve", [router, (1n << 256n) - 1n]) }, "approval", 0n), /decoded forward operation/);
      assert.equal(feeCalls, 1); metrics.unitCandidate = { classification: "controlled-unit-only", approval: !exact, selector: fixture.forwardSelector };
    }
    metrics.unitRpcCalls = calls; assert.equal(networkEffects, 0);
  } finally { await client.destroy(); }
}
function safeFile(directory: string, name: unknown, sha: unknown): Buffer {
  assert.equal(typeof name, "string"); assert.match(String(name), /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/); assert.ok(!String(name).includes(".."));
  assert.equal(typeof sha, "string"); assert.match(String(sha), /^[a-f0-9]{64}$/);
  const bytes = readTestSdkBytes(join(directory, String(name))); assert.equal(digest(bytes), sha); return bytes;
}
function capturedIntent(value: unknown): SepoliaIntentInput {
  const r = object(value);
  assert.equal(r.kind, "call");
  for (const key of ["chainId", "from", "nonce", "value", "data", "to"]) { assert.equal(typeof r[key], "string"); }
  return { kind: "call", chainId: String(r.chainId), from: String(r.from), nonce: String(r.nonce),
    value: String(r.value), data: String(r.data), to: String(r.to) };
}
interface CaptureRow { url: string; request: unknown; response: unknown; status: number; headers: Record<string, string>; redirected: boolean }
function replayRows(index: Record<string, unknown>): CaptureRow[] {
  assert.ok(Array.isArray(index.rows) && index.rows.length > 0);
  return index.rows.map((value: unknown) => {
    const r = object(value); assert.equal(r.url, DEFAULT_SEPOLIA_RPC); assert.equal(r.method, "POST"); assert.ok(typeof r.status === "number" && r.status >= 200 && r.status <= 599);
    assert.equal(typeof r.redirected, "boolean"); const headers: Record<string, string> = {};
    for (const [key, headerValue] of Object.entries(object(r.responseHeaders))) { assert.equal(typeof headerValue, "string"); headers[key] = String(headerValue); }
    return { url: DEFAULT_SEPOLIA_RPC, request: JSON.parse(safeFile(captures, r.requestFile, r.requestSha256).toString()) as unknown,
      response: JSON.parse(safeFile(captures, r.responseFile, r.responseSha256).toString()) as unknown, status: r.status, headers, redirected: r.redirected === true };
  });
}
async function forwardCaptured(name: string): Promise<void> {
  assert.ok(existsSync(captures), "Missing required public capture directory: " + captures + "; replacement pool deployment/registration and new-pair constructor/discovery/allowance/fee/generator captures required; UNQUALIFIED");
  const manifest = readJson(join(captures, "index.json")); assert.equal(manifest.schema, "agtmai-test-sdk-forward-captures-v1"); assert.equal(manifest.fixtureIdentity, fixture?.identity);
  const cases = object(manifest.cases), c = object(cases[name]); const rows = replayRows(c); let cursor = 0;
  const expected = object(JSON.parse(safeFile(captures, c.expectedFile, c.expectedSha256).toString()) as unknown);
  assert.equal(typeof c.approvalNonce, "string"); assert.equal(typeof c.sendNonce, "string");
  assert.match(String(c.approvalNonce), /^(0|[1-9][0-9]*)$/); assert.match(String(c.sendNonce), /^(0|[1-9][0-9]*)$/);
  assert.equal(BigInt(String(c.sendNonce)), BigInt(String(c.approvalNonce)) + 1n);
  const normalize = (body: unknown): unknown => Array.isArray(body) ? body.map(normalize) : { ...object(body), id: null };
  const replay: typeof fetch = async (input, init) => {
    const row = rows[cursor++]; assert.ok(row, "Missing captured request"); assert.equal(String(input), row.url); assert.equal(init?.method, "POST");
    const actual: unknown = JSON.parse(String(init?.body)); assert.deepEqual(normalize(actual), normalize(row.request), "Exact capture request mismatch");
    const actualRequests = (Array.isArray(actual) ? actual : [actual]).map(object), recordedRequests = (Array.isArray(row.request) ? row.request : [row.request]).map(object);
    const rewrite = (reply: unknown): unknown => { const r = object(reply), i = recordedRequests.findIndex(q => q.id === r.id); assert.ok(i >= 0); return { ...r, id: actualRequests[i]?.id }; };
    const body = Array.isArray(row.response) ? row.response.map(rewrite) : rewrite(row.response);
    const response = new Response(JSON.stringify(body), { status: row.status, headers: row.headers });
    Object.defineProperty(response, "redirected", { value: row.redirected }); return response;
  };
  const client = await createEvmForwardSdk(root, undefined, fixture, DEFAULT_SEPOLIA_RPC, { ...selection, replayFetch: replay });
  try {
    assert.equal(await client.allowance(), name === "allowance-zero" ? 0n : 1000000000n);
    const candidate = await client.prepare();
    assert.deepEqual(JSON.parse(JSON.stringify(candidate, (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v)) as unknown, expected.candidate, "Independent captured approval/send expectations");
    assert.ok(candidate.send); const route = forwardRoute(fixture), rawSend = object(candidate.send);
    const send = { to: String(rawSend.to), data: String(rawSend.data), value: String(rawSend.value) };
    const intents = object(expected.intents);
    validateSepoliaIntent(forwardIntent(send, String(c.sendNonce), route), capturedIntent(intents.send));
    if (candidate.approval) {
      const rawApproval = object(candidate.approval), approval = { to: String(rawApproval.to), data: String(rawApproval.data), value: String(rawApproval.value ?? "0") };
      validateSepoliaIntent(forwardIntent(approval, String(c.approvalNonce), route), capturedIntent(intents.approval));
    } else { assert.equal(intents.approval, null); }
    assert.equal(cursor, rows.length, "Unused required capture"); assert.equal(networkEffects, 0); metrics.captureIndexSha256 = digest(readTestSdkBytes(join(captures, "index.json")));
  } finally { await client.destroy(); }
}
try {
  checkTestSdkRuntime();
  if (!scenario) {
    const scenarios = phase === "admission" ? ["authentication", "optional", "guard", "held"] : phase === "contract" ? ["constructor-unit", "unsigned-zero-unit", "unsigned-exact-unit", "invalid-allowance-unit", "invalid-fee-unit", "invalid-discovery-unit", "invalid-chain-unit", "destroy-unit", "destroy-drain-unit"] : phase === 'svm' ?
      ['svm-mint-unit', 'svm-pool-unit', 'svm-registration-unit', 'svm-configuration-unit', 'svm-reverse-approval-unit', 'svm-reverse-exact-unit', 'svm-compiler-unit', 'svm-reverse-lookup-failure-unit', 'svm-network-sentinel-unit', 'svm-approval-captured', 'svm-exact-captured'] : ["allowance-zero", "allowance-exact"];
    for (const name of scenarios) {
      await check(name, () => {
        const command = [fileURLToPath(import.meta.url), ...process.argv.slice(2), "--scenario", name, "--out", join(out, name)];
        // Replace the parent's out pair instead of passing duplicate argument keys.
        const outAt = command.indexOf("--out"); command.splice(outAt, 2);
        const result = spawnSync(process.execPath, command, { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TMPDIR: join(out, "tmp") }, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
        writeFileSync(join(out, name + ".log"), result.stdout + result.stderr);
        assert.equal(result.status, 0, name + ": " + (result.error?.message ?? result.stdout + result.stderr));
      });
    }
  } else {
    const jobs: Record<string, () => Promise<void>> = { authentication, optional, guard, held, "constructor-unit": constructorUnit,
      'svm-caught-network-unit': caughtNetworkUnit, 'svm-network-sentinel-unit': networkSentinelRegression,
      "destroy-unit": () => destroyUnit(), "destroy-drain-unit": () => destroyUnit(true),
      'svm-mint-unit': async () => { metrics.svm = await svmFactoryUnit('svm-mint-unit', svmInputs); }, 'svm-pool-unit': async () => { metrics.svm = await svmFactoryUnit('svm-pool-unit', svmInputs); },
      'svm-registration-unit': async () => { metrics.svm = await svmFactoryUnit('svm-registration-unit', svmInputs); }, 'svm-configuration-unit': async () => { metrics.svm = await svmFactoryUnit('svm-configuration-unit', svmInputs); },
      'svm-reverse-approval-unit': async () => { metrics.svm = await svmReverseUnit('svm-reverse-approval-unit', svmInputs); }, 'svm-reverse-exact-unit': async () => { metrics.svm = await svmReverseUnit('svm-reverse-exact-unit', svmInputs); },
      'svm-compiler-unit': async () => { metrics.svm = await svmCompilerUnit(svmInputs); },
      'svm-reverse-lookup-failure-unit': async () => { metrics.svm = await svmLookupFailureUnit(svmInputs); },
      'svm-approval-captured': async () => { metrics.svm = await svmCaptured('approval', svmInputs); }, 'svm-exact-captured': async () => { metrics.svm = await svmCaptured('exact', svmInputs); },
      "allowance-zero": () => forwardCaptured("allowance-zero"), "allowance-exact": () => forwardCaptured("allowance-exact") };
    const job = scenario.endsWith("-unit") && scenario !== "constructor-unit" && !scenario.startsWith("destroy-") && !scenario.startsWith('svm-') ? () => generatorUnit(scenario) : jobs[scenario]; assert.ok(job, "Unknown implemented scenario"); await check(scenario, job);
  }
} finally {
  count.deregister();
  const admitted = testSdkCounters();
  try {
  if (admitted) { assert.ok(admitted.loads > 500); assert.equal(admitted.closed, true); }
  assert.equal(unguardedLoadAttempts, 0, "No candidate target reached the unguarded loader"); assert.equal(svmSigningEffects(), 0);
  assert.equal(networkEffects, 0, 'Attempted network effects must be zero');
  } finally {
  writeFileSync(join(out, "result.json"), JSON.stringify({ schema: "agtmai-test-sdk-checkpoint-evidence-v1", phase, scenario: scenario ?? "all", results,
    qualification: "UNQUALIFIED", skipped: 0, networkEffects, signingEffects: svmSigningEffects(), candidateLoads: admitted?.loads ?? 0,
    loadCountScope: "this dedicated process; parent runners report each child in its scenario/result.json",
    admittedLoads: admitted, unguardedLoadAttempts, metrics, admission: admission ?? null,
    runtime: { version: process.version, binarySha256: TEST_SDK_NODE_HASH }, rootHashes: TEST_SDK_ROOT_HASHES,
    prerequisite: phase === 'svm' ? "Genuine SVM capture qualification, phase3 composition/status wiring and fresh public three-message acceptance remain pending. Controlled native units are not public E2E evidence." :
      "New replacement pool not deployed/registered; full real forward captures absent. Controlled unit/module checks are not captured qualification.",
    cleanup: "owned snapshot copies removed; hooks closed in finally; snapshot custody observations recorded in metrics" }, null, 2) + "\n");
  }
}

// Checked only under the strict .mts configuration, never executed.
function strictSelectionContracts(explicitSelection: import("../src/adapters/test-sdk-policy.ts").ExplicitTestSdkSelection): void {
  // @ts-expect-error explicit selection requires the actual fixture propagation
  const missing: import("../src/adapters/test-sdk-policy.ts").ExplicitTestSdkSelection = { providerProfile: TEST_SDK_PROFILE, testOnly: true, fixtureIdentity: "id", providerArchives: "/archives" };
  // @ts-expect-error exact optional properties do not permit an undefined identity
  const divergent: import("../src/adapters/test-sdk-policy.ts").TestSdkSelection = { ...explicitSelection, fixtureIdentity: undefined };
  void missing; void divergent;
}
void strictSelectionContracts;
