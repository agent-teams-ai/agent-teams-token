import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCastSigner } from "../src/adapters/evm-cast.ts";
import type { CastRunner, CastSignerConfig } from "../src/adapters/evm-cast.ts";
import { validateSepoliaIntent } from "../src/domain/evm-intent.ts";
import type { SepoliaIntentInput } from "../src/domain/evm-intent.ts";

const from = "0x" + "ab".repeat(20);
const to = "0x" + "cd".repeat(20);
const hash = "0x" + "11".repeat(32);
const bytes = "0x02aabbcc";
const input: SepoliaIntentInput = { kind: "call", chainId: "11155111", from, to,
  nonce: "0", value: "0", data: "0x12345678" };
const intent = validateSepoliaIntent(input, input);
const decoded = { signer: from, type: "0x2", chainId: "0xaa36a7", nonce: "0x0",
  gas: "0x186a0", maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0xf4240",
  to, input: intent.data, value: "0x0", hash, accessList: [] };
function outer(value: unknown) {
  return JSON.stringify({ schema_version: 1, success: true, data: JSON.stringify(value), errors: [], warnings: [] });
}
async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "agtmai-cast-unit-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, "cast"); await writeFile(executable, "pinned-test-binary");
  const config: CastSignerConfig = { executable,
    executableSha256: createHash("sha256").update("pinned-test-binary").digest("hex"), testOnly: true,
    keystore: join(dir, "test-keystore"), passwordFile: join(dir, "test-password"),
    gasLimit: "100000", maxFeePerGas: "1000000000", maxPriorityFeePerGas: "1000000" };
  const calls: { args: readonly string[]; options: Parameters<CastRunner>[2] }[] = [];
  const runner: CastRunner = async (_executable, args, options) => {
    calls.push({ args, options });
    return args[0] === "mktx" ? bytes : outer(decoded);
  };
  return { config, calls, runner };
}
test("cast1.8 envelope decode recovers sender/hash and decimal fields", async t => {
  const { config, runner } = await fixture(t);
  assert.deepEqual(await createCastSigner(config, runner).inspectSigned(bytes), {
    hash, chainId: "11155111", from, to, data: intent.data, value: "0", nonce: "0",
  });
});
test("sign argv binds chain/nonce/value/fees and isolates environment without broadcasting", async t => {
  const { config, runner, calls } = await fixture(t);
  assert.deepEqual(await createCastSigner(config, runner).sign(intent), { bytes, hash });
  assert.deepEqual(calls[0]?.args, ["mktx", "--chain", "11155111", "--nonce", "0", "--value", "0",
    "--gas-limit", "100000", "--gas-price", "1000000000", "--priority-gas-price", "1000000",
    "--keystore", config.keystore, "--password-file", config.passwordFile, to, "0x12345678"]);
  assert.deepEqual(calls[0]?.options.env, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...(process.env.HOME ? { HOME: process.env.HOME } : {}) });
  assert.deepEqual(calls[1]?.args, ["decode-transaction", bytes, "--json"]);
  assert.equal(calls.length, 2);
});
test("deploy uses --create and must decode as contract creation", async t => {
  const { config, runner, calls } = await fixture(t);
  const deploy: SepoliaIntentInput = { ...input, kind: "deploy", to: undefined, data: "0x6000", deployment: {
    artifactId: "Pool", artifactSha256: "a".repeat(64), creationBytecode: "0x6000", constructorBytes: "0x",
    administrator: from, administratorBinding: "sender" } };
  const invoke: CastRunner = async (...args) => {
    const result = await runner(...args);
    return args[1][0] === "decode-transaction" ? outer({ ...decoded, to: null, input: "0x6000" }) : result;
  };
  await createCastSigner(config, invoke).sign(validateSepoliaIntent(deploy, deploy));
  assert.deepEqual(calls[0]?.args.slice(-2), ["--create", "0x6000"]);
});
test("gas, fees, chain, type and accesslist are mandatory exact signed constraints", async t => {
  const { config } = await fixture(t);
  for (const change of [{ gas: "0x186a1" }, { maxFeePerGas: "0x1" }, { maxPriorityFeePerGas: "0x0" },
    { chainId: "0x1" }, { type: "0x0" }, { accessList: [{}] }, { accessList: undefined }, { nonce: "0x00" }]) {
    await assert.rejects(createCastSigner(config, async () => outer({ ...decoded, ...change })).inspectSigned(bytes), /inspection failed/);
  }
});
test("binary mismatch prevents subprocess and bounds reject unsafe signer configuration", async t => {
  const { config, runner, calls } = await fixture(t);
  await writeFile(config.executable, "changed-binary");
  await assert.rejects(createCastSigner(config, runner).sign(intent), /signing failed/);
  assert.equal(calls.length, 0);
  for (const change of [{ executable: "cast" }, { testOnly: false }, { gasLimit: "30000001" },
    { maxFeePerGas: "100000000001" }, { maxPriorityFeePerGas: "1000000001" }]) {
    assert.throws(() => createCastSigner({ ...config, ...change } as CastSignerConfig, runner));
  }
});
test("subprocess and decode failures never expose raw transaction/password text", async t => {
  const { config } = await fixture(t);
  const secret = "private-password-secret";
  const runner: CastRunner = async () => { throw new Error(secret + bytes); };
  await assert.rejects(createCastSigner(config, runner).sign(intent), error => {
    assert.equal((error as Error).message, "Test-only transaction signing failed"); return true;
  });
  await assert.rejects(createCastSigner(config, async () => secret + bytes).inspectSigned(bytes), error => {
    assert.equal((error as Error).message, "Signed transaction inspection failed"); return true;
  });
});
test("wrong recovered sender and malformed success envelope cannot produce signed intent", async t => {
  const { config } = await fixture(t);
  await assert.rejects(createCastSigner(config, async (_file, args) => args[0] === "mktx" ? bytes : outer({ ...decoded, signer: to })).sign(intent));
  for (const envelope of [{ schema_version: 1, success: false, data: JSON.stringify(decoded), errors: [], warnings: [] },
    { schema_version: 1, success: true, data: JSON.stringify(decoded), errors: ["bad"], warnings: [] }]) {
    await assert.rejects(createCastSigner(config, async () => JSON.stringify(envelope)).inspectSigned(bytes));
  }
});
