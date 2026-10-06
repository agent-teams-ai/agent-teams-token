import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createMintSdk, createSolanaMintSdk, createSolanaMintOperatorAttempt, type UnsignedMintSdk } from "../src/adapters/solana-sdk.mjs";
import { createPoolInitSdk } from "../src/adapters/solana-pool-init-sdk.mjs";
import { createRegistrationSdk, type RegistrationPredecessorVerifier } from "../src/adapters/solana-registration-sdk.mjs";
import { createPoolConfigSdk, createRegistrationInspector } from "../src/adapters/solana-pool-config-sdk.mjs";
import { checkSetupPrepared, createSetupSigning, capturePrepared } from "../src/adapters/solana-setup-operator.ts";
import { createMintOperatorIO, createPoolInitOperatorIO, createRegistrationOperatorIO, createPoolConfigOperatorIO, signSetup, setupLifetime, setupObject } from "../src/composition/solana-setup-operator.ts";
import type { ExplicitTestSdkSelection, TestSdkSelection } from "../src/adapters/test-sdk-policy.ts";
import type { MintResult } from "../src/composition/solana-setup-operator.ts";
import { parseSolanaRpcAccount } from "../src/adapters/solana-transaction-rpc.ts";
import { BURNMINT_PROGRAM, POOL_GLOBAL } from "../src/domain/solana-pool-init.ts";
import { ROUTER_PROGRAM } from "../src/domain/solana-registration.ts";
import { createJournalFile } from "../src/adapters/evm-journal-file.ts";
import type { SolanaRegistrationRecord } from "../src/application/solana-registration-journal.ts";
import { createHash } from "node:crypto";
import type { SolanaMintExpectation } from "../src/domain/solana-mint.ts";
import type { PreparedTransaction, RpcAccount } from "../src/adapters/solana-transaction-sdk.mjs";
import type { SignedSolanaTransaction } from "../src/application/solana-transaction-journal.ts";
import type { NativeSolanaProvider } from "../src/adapters/test-sdk-admission.ts";
import { createSolanaRegistrationRpc } from "../src/adapters/solana-registration-rpc.ts";
import { verifyPoolConfigPredecessor } from "../src/composition/configure-solana-pool.mjs";

// Actual staged pinned libraries, controlled units only. This is not an admitted runtime/capture replay.
const require = createRequire(resolve(".local/INPUT/provider/package.json"));
const web3: typeof import("../../../.local/INPUT/provider/node_modules/@solana/web3.js/lib/index.js") = require("@solana/web3.js");
const spl: typeof import("../../../.local/INPUT/provider/node_modules/@solana/spl-token/lib/types/index.js") = require("@solana/spl-token");
const bs58: typeof import("../../../.local/INPUT/provider/node_modules/bs58/src/cjs/index.js").default = require("bs58").default;
const native: NativeSolanaProvider = { web3, spl, bs58 };
// Deterministic PUBLIC synthetic seeds, only for these ignored disposable unit outputs.
const payer = web3.Keypair.fromSeed(new Uint8Array(32).fill(101)), mint = web3.Keypair.fromSeed(new Uint8Array(32).fill(102));
const latest = { blockhash: web3.Keypair.fromSeed(new Uint8Array(32).fill(103)).publicKey.toBase58(), lastValidBlockHeight: "150" };
const expected: SolanaMintExpectation = { testOnly: true, cluster: "solana-devnet", payer: payer.publicKey.toBase58(), mint: mint.publicKey.toBase58(), rentLamports: "1461600" };
const poolExpected = { testOnly: true, cluster: "solana-devnet", payer: expected.payer, mint: expected.mint,
  pool: web3.PublicKey.findProgramAddressSync([Buffer.from("ccip_tokenpool_config"), mint.publicKey.toBuffer()], new web3.PublicKey(BURNMINT_PROGRAM))[0].toBase58() } as const;
function publicSigned(prepared: PreparedTransaction, two = false): SignedSolanaTransaction {
  const tx = web3.Transaction.from(Buffer.from(prepared.bytesBase64, "base64")); tx.sign(...(two ? [payer, mint] : [payer]));
  assert.ok(tx.signature);
  return { bytesBase64: tx.serialize().toString("base64"), signature: bs58.encode(tx.signature), blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight };
}
function deferred<T>() { let complete!: (value: T) => void; const promise = new Promise<T>(_resolve => { complete = _resolve; }); return { promise, complete }; }

const anchor = (name: string, size: number, version = 1) => { const b = Buffer.alloc(size); createHash("sha256").update("account:" + name).digest().copy(b, 0, 0, 8); b[8] = version; return b; };
const rpcAccount = (b: Buffer, owner: string): RpcAccount => ({ owner, executable: false, lamports: 10000000, data: [b.toString("base64"), "base64"] });
const denied = async (): Promise<never> => { throw new Error("Config RPC unused in initial registration predecessor"); };

test("actual native mint owner signs both synthetic keys; either missing/corrupt signature and trailing packet bytes reject", async context => {
  const root = resolve(".local/setup-operator/units"); await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "public-synthetic-"));
  try {
    const payerFile = join(directory, "public-payer.json"), mintFile = join(directory, "public-mint.json");
    await writeFile(payerFile, JSON.stringify([...payer.secretKey]), { mode: 0o600 });
    await writeFile(mintFile, JSON.stringify([...mint.secretKey]), { mode: 0o600 });
    const core = createMintSdk(native); let closed = 0;
    const ownedSecrets: Uint8Array[] = [], retainedPairs: InstanceType<typeof web3.Keypair>[] = [];
    const fromSecret = web3.Keypair.fromSecretKey, nativeSign = web3.Transaction.prototype.sign;
    const keyProbe = context.mock.method(web3.Keypair, "fromSecretKey", (bytes: Uint8Array) => {
      ownedSecrets.push(bytes); const pair = fromSecret(bytes); retainedPairs.push(pair); return pair;
    });
    const signProbe = context.mock.method(web3.Transaction.prototype, "sign", function(this: InstanceType<typeof web3.Transaction>, ...signers: Parameters<InstanceType<typeof web3.Transaction>["sign"]>) {
      ownedSecrets.push(...signers.map(s => s.secretKey)); return nativeSign.apply(this, signers);
    });
    const owner = createSetupSigning(core, () => { assert.equal(closed, 0); }, () => { closed++; });
    const prepared = owner.build(expected, latest);
    const signed = await owner.acquireSigner({ testOnly: true, payerFile, mintFile })(capturePrepared(prepared), expected);
    keyProbe.mock.restore(); signProbe.mock.restore();
    assert.equal(retainedPairs.length, 2); assert.equal(ownedSecrets.length, 4);
    assert.ok(ownedSecrets.every(secret => secret.every(byte => byte === 0)));
    assert.ok(retainedPairs.every(pair => pair.secretKey.every(byte => byte === 0)));
    assert.equal(core.inspectSigned(signed.bytesBase64, expected).messageBase64, prepared.messageBase64);
    for (const index of [0, 1]) {
      const tx = web3.Transaction.from(Buffer.from(signed.bytesBase64, "base64"));
      const entry = tx.signatures[index]; assert.ok(entry?.signature); entry.signature[0] = entry.signature[0]! ^ 1;
      assert.throws(() => core.inspectSigned(tx.serialize({ verifySignatures: false }).toString("base64"), expected));
      entry.signature = null;
      assert.throws(() => core.inspectSigned(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), expected));
    }
    assert.throws(() => core.inspectSigned(Buffer.concat([Buffer.from(signed.bytesBase64, "base64"), Buffer.from([0])]).toString("base64"), expected));
    assert.throws(() => owner.acquireSigner({ testOnly: true, payerFile, mintFile }));
    const first = owner.destroy(); assert.equal(owner.destroy(), first); await first; assert.equal(closed, 1);
    assert.throws(() => owner.build(expected, latest));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("prepared mutations fail before the native signing/key owner; one captured authenticated validity cannot be replaced", () => {
  const core = createMintSdk(native), prepared = core.build(expected, latest);
  const mutations: PreparedTransaction[] = [
    { ...prepared, bytesBase64: prepared.bytesBase64 + "=" },
    { ...prepared, bytesBase64: Buffer.alloc(1233).toString("base64") },
    { ...prepared, bytesBase64: Buffer.concat([Buffer.from(prepared.bytesBase64, "base64"), Buffer.from([0])]).toString("base64") },
    { ...prepared, messageBase64: Buffer.from("wrong-message").toString("base64") },
    { ...prepared, blockhash: expected.mint }, { ...prepared, lastValidBlockHeight: "151" },
    { ...prepared, lastValidBlockHeight: "0150" }, { ...prepared, lastValidBlockHeight: "18446744073709551616" },
    { ...prepared, bytesBase64: publicSigned(prepared, true).bytesBase64 },
  ];
  const extra = web3.Transaction.from(Buffer.from(prepared.bytesBase64, "base64"));
  extra.add(web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: mint.publicKey, lamports: 1 }));
  mutations.push({ ...prepared, bytesBase64: extra.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), messageBase64: extra.serializeMessage().toString("base64") });
  const message = web3.Transaction.from(Buffer.from(prepared.bytesBase64, "base64")).compileMessage();
  const promoted = new web3.Message({ header: { ...message.header, numReadonlyUnsignedAccounts: 0 }, accountKeys: message.accountKeys,
    recentBlockhash: message.recentBlockhash, instructions: message.instructions });
  const privilege = web3.Transaction.populate(promoted);
  mutations.push({ ...prepared, bytesBase64: privilege.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), messageBase64: privilege.serializeMessage().toString("base64") });
  const nonce = web3.Transaction.from(Buffer.from(prepared.bytesBase64, "base64"));
  nonce.add(web3.SystemProgram.nonceAdvance({ noncePubkey: mint.publicKey, authorizedPubkey: payer.publicKey }));
  mutations.push({ ...prepared, bytesBase64: nonce.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), messageBase64: nonce.serializeMessage().toString("base64") });
  const versioned = new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: payer.publicKey,
    recentBlockhash: latest.blockhash, instructions: extra.instructions }).compileToV0Message());
  mutations.push({ ...prepared, bytesBase64: Buffer.from(versioned.serialize()).toString("base64"), messageBase64: Buffer.from(versioned.message.serialize()).toString("base64") });
  let signing = 0;
  const owner = createSetupSigning({ ...core, sign: async () => { signing++; throw new Error("custody sentinel"); } }, () => {}, () => {});
  const captured = owner.build(expected, latest), sign = owner.acquireSigner({ testOnly: true, payerFile: "never-read", mintFile: "never-read" });
  for (const mutation of mutations) {
    assert.throws(() => core.inspectPrepared(mutation, expected, latest));
    assert.throws(() => sign(mutation, expected));
  }
  assert.throws(() => checkSetupPrepared(native, prepared, latest, [expected.mint, expected.payer]));
  assert.throws(() => core.inspectPrepared(captured, { ...expected, payer: expected.mint }, latest));
  assert.equal(signing, 0);
});

test("all native signing owners clear parsed arrays and owned signer inputs after success or invalid synthetic key failure", async context => {
  const root = resolve(".local/setup-operator/units"); await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "public-key-cleanup-"));
  const rawArrays: unknown[][] = [], ownedInputs: Uint8Array[] = [];
  const parse = JSON.parse, fromSecret = web3.Keypair.fromSecretKey, nativeSign = web3.Transaction.prototype.sign;
  const parseProbe = context.mock.method(JSON, "parse", (text: string) => {
    const value = parse(text) as unknown; if (Array.isArray(value)) { rawArrays.push(value); } return value;
  });
  const keyProbe = context.mock.method(web3.Keypair, "fromSecretKey", (bytes: Uint8Array) => { ownedInputs.push(bytes); return fromSecret(bytes); });
  const signProbe = context.mock.method(web3.Transaction.prototype, "sign", function(this: InstanceType<typeof web3.Transaction>, ...signers: Parameters<InstanceType<typeof web3.Transaction>["sign"]>) {
    ownedInputs.push(...signers.map(s => s.secretKey)); return nativeSign.apply(this, signers);
  });
  try {
    const mintCore = createMintSdk(native), pool = createPoolInitSdk(native), registration = createRegistrationSdk(native, pool), config = createPoolConfigSdk(native, registration, pool);
    const r = registration.derive({ ...poolExpected, operation: "transfer-mint-authority" }), c = config.derive({ ...poolExpected, operation: "init-chain-remote-config" });
    const keys = { testOnly: true, payerFile: join(directory, "public-payer.json"), mintFile: join(directory, "public-mint.json") } as const;
    const preparedMint = mintCore.build(expected, latest), preparedPool = pool.build(poolExpected, latest), preparedRegistration = registration.build(r, latest), preparedConfig = config.build(c, latest);
    const entries = [
      { name: "mint", sign: () => mintCore.sign(preparedMint, expected, keys), inspect: (bytes: string) => mintCore.inspectSigned(bytes, expected), prepared: preparedMint },
      { name: "init", sign: () => pool.sign(preparedPool, poolExpected, keys), inspect: (bytes: string) => pool.inspectSigned(bytes, poolExpected), prepared: preparedPool },
      { name: "registration", sign: () => registration.sign(preparedRegistration, r, keys), inspect: (bytes: string) => registration.inspectSigned(bytes, r), prepared: preparedRegistration },
      { name: "config", sign: () => config.sign(preparedConfig, c, keys), inspect: (bytes: string) => config.inspectSigned(bytes, c), prepared: preparedConfig },
    ];
    for (const entry of entries) {
      for (const stage of ["valid", "short-payer", "invalid-payer-byte", "wrong-payer", ...(entry.name === "mint" ? ["short-mint", "wrong-mint"] : [])]) {
        rawArrays.length = ownedInputs.length = 0;
        const payerValues = [...(stage === "wrong-payer" ? mint.secretKey : payer.secretKey)], mintValues = [...(stage === "wrong-mint" ? payer.secretKey : mint.secretKey)];
        if (stage === "short-payer") { payerValues.pop(); }
        if (stage === "invalid-payer-byte") { payerValues[0] = 256; }
        if (stage === "short-mint") { mintValues.pop(); }
        await writeFile(keys.payerFile, JSON.stringify(payerValues), { mode: 0o600 });
        await writeFile(keys.mintFile, JSON.stringify(mintValues), { mode: 0o600 });
        if (stage === "valid") { const signed = await entry.sign(); assert.equal(entry.inspect(signed.bytesBase64).messageBase64, entry.prepared.messageBase64); }
        else { await assert.rejects(entry.sign(), error => error instanceof Error && /signing failed/.test(error.message) && !error.message.includes(directory)); }
        assert.ok(rawArrays.length > 0); assert.ok(rawArrays.every(values => values.every(value => value === 0)), `${entry.name}/${stage}/parsed arrays`);
        assert.ok(ownedInputs.every(bytes => bytes.every(byte => byte === 0)), `${entry.name}/${stage}/owned inputs`);
      }
    }
  } finally { parseProbe.mock.restore(); keyProbe.mock.restore(); signProbe.mock.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("single signer native initialization, registration and config use actual provider declarations and independently reject a different valid message", async () => {
  const pool = createPoolInitSdk(native), registration = createRegistrationSdk(native, pool), config = createPoolConfigSdk(native, registration, pool);
  const r = registration.derive({ ...poolExpected, operation: "transfer-mint-authority" }), c = config.derive({ ...poolExpected, operation: "init-chain-remote-config" });
  for (const [prepared, inspect] of [
    [pool.build(poolExpected, latest), (bytes: string) => pool.inspectSigned(bytes, poolExpected)],
    [registration.build(r, latest), (bytes: string) => registration.inspectSigned(bytes, r)],
    [config.build(c, latest), (bytes: string) => config.inspectSigned(bytes, c)],
  ] as const) { assert.equal(inspect(publicSigned(prepared).bytesBase64).messageBase64, prepared.messageBase64); }
  const core = createMintSdk(native), prepared = core.build(expected, latest), signed = publicSigned(prepared, true);
  const other = core.build(expected, { ...latest, blockhash: expected.mint }), different = publicSigned(other, true);
  await assert.rejects(signSetup(prepared, expected, latest, core.inspectSigned, async () => different), /match/);
  await assert.rejects(signSetup(prepared, expected, latest, core.inspectSigned, async () => ({ ...signed, lastValidBlockHeight: "151" })), /match/);
  await assert.rejects(signSetup(prepared, expected, latest, core.inspectSigned, async () => ({ ...signed, signature: "2".repeat(88) })), /match/);
  await assert.rejects(signSetup({ ...prepared, lastValidBlockHeight: "151" }, expected, latest, core.inspectSigned, async () => signed), /validity/);
  await signSetup(prepared, Object.freeze({ ...expected }), latest, core.inspectSigned, async input => {
    assert.ok(Object.isFrozen(input)); assert.equal(Reflect.set(input, "messageBase64", other.messageBase64), false);
    return signed;
  });
});

test("borrowed registration has exactly five guarded methods and rejects every use after the owning lifetime closes", async () => {
  const pool = createPoolInitSdk(native), registration = createRegistrationSdk(native, pool); let closed = false;
  const borrowed = createRegistrationInspector(registration, () => { if (closed) { throw new Error("owner closed"); } });
  const r = borrowed.derive({ ...poolExpected, operation: "transfer-mint-authority" });
  const prepared = registration.build(r, latest), signed = publicSigned(prepared);
  assert.deepEqual(Object.keys(borrowed).toSorted(), ["decodeRegistry", "derive", "inspectSigned", "snapshotAddresses", "verifySnapshot"]);
  assert.equal(borrowed.inspectSigned(signed.bytesBase64, r).messageBase64, prepared.messageBase64);
  assert.equal(borrowed.snapshotAddresses(r).length, 6); closed = true;
  for (const call of [() => borrowed.derive(r), () => borrowed.inspectSigned(signed.bytesBase64, r),
    () => borrowed.snapshotAddresses(r), () => borrowed.decodeRegistry(null), () => borrowed.verifySnapshot([], r, "after")]) { assert.throws(call, /owner closed/); }
});

test("actual first-config predecessor: borrowed native crypto inspector and coherent six-account observer admit only finalized original transfer", async () => {
  const root = resolve(".local/setup-operator/units"); await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "public-predecessor-"));
  try {
    const pool = createPoolInitSdk(native), registration = createRegistrationSdk(native, pool), config = createPoolConfigSdk(native, registration, pool);
    const r = registration.derive({ ...poolExpected, operation: "transfer-mint-authority" }), c = config.derive({ ...poolExpected, operation: "init-chain-remote-config" });
    const prepared = registration.build(r, latest), signed = publicSigned(prepared);
    const key = (b: Buffer, offset: number, address: string) => new web3.PublicKey(address).toBuffer().copy(b, offset);
    const mintData = Buffer.alloc(82); mintData.writeUInt32LE(1); key(mintData, 4, r.signer); mintData[44] = 9; mintData[45] = 1;
    const state = anchor("State", 368); state[73] = 9;
    for (const [offset, address] of [[9, spl.TOKEN_PROGRAM_ID.toBase58()], [41, r.mint], [74, r.signer], [106, r.ata], [138, r.payer], [202, r.payer],
      [234, web3.PublicKey.findProgramAddressSync([Buffer.from("external_token_pools_signer"), new web3.PublicKey(BURNMINT_PROGRAM).toBuffer()], new web3.PublicKey(ROUTER_PROGRAM))[0].toBase58()],
      [266, ROUTER_PROGRAM], [336, "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7"]] as const) { key(state, offset, address); }
    const ata = Buffer.alloc(165); key(ata, 0, r.mint); key(ata, 32, r.signer); ata[108] = 1;
    const registry = anchor("TokenAdminRegistry", 170, 2); key(registry, 9, r.payer); key(registry, 137, r.mint);
    const global = anchor("PoolConfig", 74); global[9] = 1; key(global, 10, ROUTER_PROGRAM); key(global, 42, "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7");
    const routerConfig = anchor("Config", 210); routerConfig[9] = 1; routerConfig.writeBigUInt64LE(16423721717087811551n, 10);
    key(routerConfig, 82, "FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi"); key(routerConfig, 114, "RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7");
    const values = [rpcAccount(mintData, spl.TOKEN_PROGRAM_ID.toBase58()), rpcAccount(state, BURNMINT_PROGRAM), rpcAccount(ata, spl.TOKEN_PROGRAM_ID.toBase58()), rpcAccount(registry, ROUTER_PROGRAM), rpcAccount(global, BURNMINT_PROGRAM), rpcAccount(routerConfig, ROUTER_PROGRAM)];
    let finality = "finalized", inspectCalls = 0, stateReads = 0, preparation = 0, unknown = false;
    const borrowed = createRegistrationInspector({ ...registration, inspectSigned(bytes, e) { inspectCalls++; return registration.inspectSigned(bytes, e); } }, () => {});
    const fetcher: typeof fetch = async (_input, init) => {
      const request = setupObject(JSON.parse(String(init?.body)) as unknown);
      assert.equal(typeof request.method, "string"); assert.equal(typeof request.id, "number"); assert.ok(Array.isArray(request.params));
      let result: unknown;
      switch (request.method) {
        case "getGenesisHash": result = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"; break;
        case "getTransaction": if (unknown) { throw new Error("controlled unavailable"); } result = { slot: 10, transaction: [signed.bytesBase64, "base64"], meta: { err: null } }; break;
        case "getSignatureStatuses": result = { value: [{ slot: 10, confirmationStatus: finality, err: null }] }; break;
        case "getMultipleAccounts": assert.deepEqual(request.params[0], [r.mint, r.pool, r.ata, r.registry, POOL_GLOBAL, r.routerConfig]); stateReads++; result = { context: { slot: 11 }, value: values }; break;
        default: throw new Error("Predecessor signing/send/fresh quote forbidden");
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    };
    const registrationRpc = createSolanaRegistrationRpc((bytes, e) => borrowed.inspectSigned(bytes, e).messageBase64, borrowed, fetcher);
    const file = createJournalFile<SolanaRegistrationRecord>(join(directory, "transfer-mint-authority.json"));
    const record: SolanaRegistrationRecord = { schema: "agtmai-solana-registration-journal-v1", phase: "succeeded", signed, messageBase64: prepared.messageBase64, intent: prepared.envelope };
    const write = (saved: SolanaRegistrationRecord) => file.exclusive(() => file.write(saved));
    const rpc = { readRpc: denied, chain: denied, broadcast: denied, observe: denied, observeRepairPredecessor: denied };
    const advance = async () => {
      await verifyPoolConfigPredecessor({ journalDirectory: directory, registrationJournalFile: join(directory, "transfer-mint-authority.json") }, c, { sdk: config, rpc, registrationSdk: borrowed, registrationRpc });
      preparation++; return config.build(c, latest);
    };
    await write(record); const next = await advance(); assert.equal(next.envelope.operation, "init-chain-remote-config"); assert.equal(preparation, 1); assert.ok(inspectCalls >= 2); assert.equal(stateReads, 1);
    for (const bad of [{ ...record, phase: "submitted" as const }, { ...record, messageBase64: "dGFtcGVy" },
      { ...record, signed: { ...signed, signature: "2".repeat(88) } }]) { await write(bad); await assert.rejects(advance()); assert.equal(preparation, 1); }
    await write(record); finality = "confirmed"; await assert.rejects(advance()); assert.equal(preparation, 1);
    finality = "finalized"; unknown = true; await assert.rejects(advance()); assert.equal(preparation, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Host initialization is inert and signing cannot precede its same-attempt open", async () => {
  const keys = { testOnly: true, payerFile: "/never-read/private-payer", mintFile: "/never-read/private-mint" } as const;
  for (const io of [createMintOperatorIO(keys, async () => { throw new Error("fetch sentinel"); }),
    createPoolInitOperatorIO(keys, async () => { throw new Error("fetch sentinel"); }),
    createRegistrationOperatorIO(keys, async () => { throw new Error("fetch sentinel"); }),
    createPoolConfigOperatorIO(keys, async () => { throw new Error("fetch sentinel"); })]) { assert.equal(typeof io.openSdk, "function"); }
  const io = createMintOperatorIO(keys, async () => { throw new Error("fetch sentinel"); });
  await assert.rejects(io.signPrepared!(createMintSdk(native).build(expected, latest), expected), /attempt missing/);
  assert.throws(() => createMintOperatorIO({ ...keys, mintFile: "" }, async () => new Response()), /reference/);
});

test("HTTP body, failed response cancellation and independent sign work all drain before one owning destroy; timeout preserves debt", async () => {
  const body = deferred<void>(); let disposed = 0;
  const life = setupLifetime(async () => new Response(new ReadableStream<Uint8Array>({ async start(controller) {
    await body.promise; controller.enqueue(Buffer.from('{"jsonrpc":"2.0","id":1,"result":null}')); controller.close();
  } })), 5);
  const read = life.fetcher("https://api.devnet.solana.com", { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' });
  await new Promise<void>(_resolve => { setImmediate(_resolve); });
  const closing = life.close(async () => { disposed++; }); assert.equal(life.close(async () => { disposed++; }), closing);
  await assert.rejects(closing, /cleanup debt/); assert.equal(disposed, 0);
  body.complete(); await read; await new Promise<void>(_resolve => { setImmediate(_resolve); }); assert.equal(disposed, 1);
  await assert.rejects(life.track(async () => null), /closing/);
  const sign = deferred<SignedSolanaTransaction>(), core = createMintSdk(native); let nativeClosed = 0;
  const owner = createSetupSigning({ ...core, sign: () => sign.promise }, () => {}, () => { nativeClosed++; });
  const prepared = owner.build(expected, latest), signing = owner.acquireSigner({ testOnly: true, payerFile: "never", mintFile: "never" })(prepared, expected);
  const draining = owner.destroy(); assert.equal(nativeClosed, 0);
  sign.complete(publicSigned(prepared, true)); await assert.rejects(signing, /signing failed/); await draining; assert.equal(nativeClosed, 1);
  const canceled = deferred<void>(); let cancelDone = false, failedClosed = false;
  const failedLife = setupLifetime(async () => new Response(new ReadableStream({ async cancel() { await canceled.promise; cancelDone = true; } }), { status: 500 }));
  const failed = failedLife.fetcher("https://api.devnet.solana.com", { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' });
  await new Promise<void>(_resolve => { setImmediate(_resolve); });
  const failedClose = failedLife.close(async () => { assert.ok(cancelDone); failedClosed = true; });
  assert.equal(failedClosed, false); canceled.complete(); await assert.rejects(failed, /unavailable/); await failedClose; assert.ok(failedClosed);
});

test("finite RPC account guard preserves empty bytes/null/large rent sentinel and rejects malformed JSON rather than asserting its type", () => {
  const raw = { owner: expected.payer, executable: false, lamports: 1, rentEpoch: 18446744073709551616, data: ["", "base64"] };
  assert.deepEqual(parseSolanaRpcAccount(raw), raw); assert.equal(parseSolanaRpcAccount(null), null);
  for (const value of [undefined, [], {}, { ...raw, lamports: 1.5 }, { ...raw, lamports: -1 }, { ...raw, owner: 1 },
    { ...raw, executable: "false" }, { ...raw, data: ["YQ", "base64"] }, { ...raw, data: ["", "base64", "extra"] }, { ...raw, rentEpoch: Infinity }]) { assert.throws(() => parseSolanaRpcAccount(value)); }
});

// Never invoked. Removing an enforced restriction makes an expect-error unused and the strict compiler fail.
function declarationContracts(sdk: UnsignedMintSdk, borrowed: RegistrationPredecessorVerifier,
  predecessor: Parameters<typeof verifyPoolConfigPredecessor>, prepared: PreparedTransaction,
  selections: { explicit: ExplicitTestSdkSelection; unrefined: TestSdkSelection }) {
  const { explicit, unrefined } = selections;
  createSolanaRegistrationRpc(() => "", borrowed);
  verifyPoolConfigPredecessor(predecessor[0], predecessor[1], { ...predecessor[2], registrationSdk: borrowed });
  // @ts-expect-error unsigned SDK has no signing authority
  sdk.sign(prepared, expected, { testOnly: true, payerFile: "never" });
  // @ts-expect-error borrowed inspector has no disposer
  borrowed.destroy();
  // @ts-expect-error borrowed inspector has no signer acquisition
  borrowed.acquireSigner({ testOnly: true, payerFile: "never" });
  // @ts-expect-error mint Host requires both key references
  createMintOperatorIO({ testOnly: true, payerFile: "never" }, fetch);
  // @ts-expect-error a JSON value cannot be a transport function
  createPoolInitOperatorIO({ testOnly: true, payerFile: "never" }, "fetch");
  // @ts-expect-error base-unit amounts never use JS number
  const wrongAmount: SolanaMintExpectation = { ...expected, rentLamports: 1461600 };
  // @ts-expect-error selectors remain decimal strings
  const wrongSelector: ExplicitTestSdkSelection = { ...explicit, fixture: { ...explicit.fixture, forwardSelector: 16000000000000000 } };
  // @ts-expect-error saved authenticated validity remains a string
  const wrongValidity: SignedSolanaTransaction = { bytesBase64: "", signature: "", blockhash: "", lastValidBlockHeight: 150 };
  // @ts-expect-error result status is the checked application outcome, never a journal phase
  const wrongResult: MintResult = { status: "signed", reason: "", signature: "" };
  createSolanaMintSdk("never", explicit).then(view => {
    // @ts-expect-error actual TEST overload is unsigned
    view.sign(prepared, expected, { testOnly: true, payerFile: "never" });
    // @ts-expect-error provider constructors do not escape
    view.Keypair.fromSecretKey(new Uint8Array(64));
    // @ts-expect-error no raw provider on worker view
    const hiddenProvider = view.native;
    return hiddenProvider;
  });
  createSolanaMintSdk("never", unrefined).then(view => {
    // @ts-expect-error an unrefined profile cannot be cast to a legacy signer
    view.sign(prepared, expected, { testOnly: true, payerFile: "never", mintFile: "never" });
    return null;
  });
  createSolanaMintOperatorAttempt("never", explicit).then(attempt => {
    // @ts-expect-error trusted attempt is not a second owning disposer
    attempt.destroy();
    // @ts-expect-error both mint keys are mandatory at private acquisition
    attempt.acquireSigner({ testOnly: true, payerFile: "never" });
    return null;
  });
  const { derive, inspectSigned, snapshotAddresses, decodeRegistry, verifySnapshot } = borrowed;
  // @ts-expect-error derive is mandatory
  const a: RegistrationPredecessorVerifier = { inspectSigned, snapshotAddresses, decodeRegistry, verifySnapshot };
  // @ts-expect-error inspectSigned is mandatory
  const b: RegistrationPredecessorVerifier = { derive, snapshotAddresses, decodeRegistry, verifySnapshot };
  // @ts-expect-error snapshotAddresses is mandatory
  const c: RegistrationPredecessorVerifier = { derive, inspectSigned, decodeRegistry, verifySnapshot };
  // @ts-expect-error decodeRegistry is mandatory
  const d: RegistrationPredecessorVerifier = { derive, inspectSigned, snapshotAddresses, verifySnapshot };
  // @ts-expect-error verifySnapshot is mandatory
  const e: RegistrationPredecessorVerifier = { derive, inspectSigned, snapshotAddresses, decodeRegistry };
  // @ts-expect-error excess signing authority is rejected on the public borrowed contract
  const f: RegistrationPredecessorVerifier = { ...borrowed, sign: async () => null };
  return [a, b, c, d, e, f, wrongAmount, wrongSelector, wrongValidity, wrongResult];
}
void declarationContracts;
