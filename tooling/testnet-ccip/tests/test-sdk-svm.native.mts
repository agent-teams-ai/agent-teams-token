import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openTestSdk, readTestSdkBytes } from '../src/adapters/test-sdk-admission.ts';
import { TEST_SDK_PROFILE } from '../src/adapters/test-sdk-policy.ts';
import { createSolanaMintSdk } from '../src/adapters/solana-sdk.mjs';
import { createSolanaPoolInitSdk, createPoolInitSdk } from '../src/adapters/solana-pool-init-sdk.mjs';
import { createSolanaRegistrationSdk, createRegistrationSdk } from '../src/adapters/solana-registration-sdk.mjs';
import { createSolanaPoolConfigSdk, createPoolConfigSdk } from '../src/adapters/solana-pool-config-sdk.mjs';
import { createSolanaReverseSdk, createReverseTransactionSdk, type ReverseExpectation, type Candidate } from '../src/adapters/solana-reverse-sdk.mjs';
import { deriveReverseAccounts, reverseRoute, reverseInstructions } from '../src/domain/solana-reverse.mjs';
import { DEFAULT_SOLANA_RPC } from '../src/adapters/test-rpc.ts';
import { BURNMINT_PROGRAM, POOL_GLOBAL } from '../src/domain/solana-pool-init.ts';
import { ROUTER_PROGRAM, REGISTRATION_OPERATIONS } from '../src/domain/solana-registration.ts';
import { POOL_CONFIG_OPERATIONS, FEE_QUOTER_PROGRAM } from '../src/domain/solana-pool-config.ts';
import { SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM, solanaPublicKeyBytes } from '../src/domain/solana-mint.ts';
import type { ReplacementFixture } from '../src/domain/replacement-fixture.ts';
interface SvmInputs { readonly root: string; readonly archives: string; readonly captures: string; readonly fixture: ReplacementFixture }
let signingEffects = 0;
export const svmSigningEffects = (): number => signingEffects;
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, unknown> { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; }
function readJson(path: string): Record<string, unknown> { return object(JSON.parse(readTestSdkBytes(path).toString()) as unknown); }
const selectionFor = ({fixture, archives}: SvmInputs) => ({ providerProfile: TEST_SDK_PROFILE, testOnly: true, fixture, fixtureIdentity: fixture.identity, providerArchives: archives }) as const;
function safeFile(directory: string, name: unknown, sha: unknown): Buffer {
  assert.equal(typeof name, "string"); assert.match(String(name), /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/); assert.ok(!String(name).includes(".."));
  assert.equal(typeof sha, "string"); assert.match(String(sha), /^[a-f0-9]{64}$/);
  const bytes = readTestSdkBytes(join(directory, String(name))); assert.equal(digest(bytes), sha); return bytes;
}
interface CaptureRow { url: string; request: unknown; response: unknown; status: number; headers: Record<string, string>; redirected: boolean }
function replayRows(index: Record<string, unknown>, captures: string, endpoint: string): CaptureRow[] {
  assert.ok(Array.isArray(index.rows) && index.rows.length > 0);
  return index.rows.map((value: unknown) => {
    const r = object(value); assert.equal(r.url, endpoint); assert.equal(r.method, "POST"); assert.ok(typeof r.status === "number" && r.status >= 200 && r.status <= 599);
    assert.equal(typeof r.redirected, "boolean"); const headers: Record<string, string> = {};
    for (const [key, headerValue] of Object.entries(object(r.responseHeaders))) { assert.equal(typeof headerValue, "string"); headers[key] = String(headerValue); }
    return { url: endpoint, request: JSON.parse(safeFile(captures, r.requestFile, r.requestSha256).toString()) as unknown,
      response: JSON.parse(safeFile(captures, r.responseFile, r.responseSha256).toString()) as unknown, status: r.status, headers, redirected: r.redirected === true };
  });
}
const uint32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const uint64 = (n: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const borshString = (s: string): Buffer => Buffer.concat([uint32(Buffer.byteLength(s)), Buffer.from(s)]);
const discriminator = (scope: string, name: string): Buffer => createHash('sha256').update(scope + ':' + name).digest().subarray(0, 8);
const account = (bytes: Buffer, owner: string) => ({ data: [bytes.toString('base64'), 'base64'], executable: false, owner, lamports: 1461600, rentEpoch: 0 });
function signingSentinels(web3: import('../src/adapters/test-sdk-admission.ts').NativeSolanaProvider['web3']): void {
  const denied = (): never => { signingEffects++; throw new Error('Native TEST signing sentinel'); };
  web3.Transaction.prototype.sign = denied; web3.Transaction.prototype.partialSign = denied;
  web3.VersionedTransaction.prototype.sign = denied; web3.Keypair.fromSecretKey = denied;
}
export async function svmFactoryUnit(name: string, inputs: SvmInputs) {
  const {root, fixture} = inputs, selection = selectionFor(inputs);
  assert.ok(fixture);
  const input = { fixture, testOnly: true, cluster: 'solana-devnet', payer: fixture.payer, mint: fixture.mint, pool: fixture.solanaPool } as const;
  const latest = { blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: '100' };
  if (name === 'svm-mint-unit') {
    const client = await createSolanaMintSdk(root, selection);
    assert.ok('destroy' in client, 'Explicit TEST view must own its lifetime');
    try {
      assert.equal('sign' in client, false);
      const e = { testOnly: true, cluster: 'solana-devnet', payer: fixture.payer, mint: fixture.mint, rentLamports: '1461600' } as const;
      const built = client.build(e, latest), [create, initialize] = built.intent.instructions;
      assert.ok(create && initialize); assert.equal(create.programId, SYSTEM_PROGRAM); assert.equal(initialize.programId, SPL_TOKEN_PROGRAM);
      const expectedCreate = Buffer.concat([uint32(0), uint64(1461600n), uint64(82n), solanaPublicKeyBytes(SPL_TOKEN_PROGRAM)]);
      assert.equal(create.dataBase64, expectedCreate.toString('base64'));
      assert.equal(initialize.dataBase64, Buffer.concat([Buffer.from([20, 9]), solanaPublicKeyBytes(fixture.payer), Buffer.from([0])]).toString('base64'));
      assert.throws(() => client.inspectSigned(built.bytesBase64, e), /signature/);
    } finally { await client.destroy(); }
  } else if (name === 'svm-pool-unit') {
    const client = await createSolanaPoolInitSdk(root, selection);
    assert.ok('destroy' in client, 'Explicit TEST view must own its lifetime');
    try {
      assert.equal('sign' in client, false); const built = client.build(input, latest), ix = built.intent.instructions[0]; assert.ok(ix);
      assert.equal(ix.dataBase64, Buffer.from('afaf6d1f0d989bed', 'hex').toString('base64'));
      assert.deepEqual(ix.accounts.map(a => a.address), [fixture.solanaPool, fixture.mint, fixture.payer, SYSTEM_PROGRAM,
        BURNMINT_PROGRAM, '4sVSCJqG9ZKEvnpN38qTzb7Kc8QdHakBgB87HN3FYRaz', POOL_GLOBAL]);
      const global = Buffer.concat([discriminator('account', 'PoolConfig'), Buffer.from([1, 1]), solanaPublicKeyBytes(ROUTER_PROGRAM), solanaPublicKeyBytes('RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7')]);
      client.verifyGlobal(global.toString('base64')); global[9] = 0;
      assert.throws(() => client.verifyGlobal(global.toString('base64')), /global configuration/);
    } finally { await client.destroy(); }
  } else if (name === 'svm-registration-unit') {
    const client = await createSolanaRegistrationSdk(root, selection);
    assert.ok('destroy' in client, 'Explicit TEST view must own its lifetime');
    try {
      assert.equal('sign' in client, false);
      for (const operation of REGISTRATION_OPERATIONS) {
        const e = client.derive({ ...input, operation });
        const built: import('../src/adapters/solana-transaction-sdk.mjs').PreparedTransaction & { intent: import('../src/domain/solana-mint.ts').SolanaMintIntent; envelope: import('../src/domain/solana-registration.ts').SolanaRegistrationEnvelope } = client.build(e, latest);
        const ix = built.intent.instructions[0]; assert.ok(ix);
        const bytes: Buffer = operation === 'create-token-account' ? Buffer.from([1]) : operation === 'transfer-mint-authority' ?
          Buffer.concat([Buffer.from([6, 0, 1]), solanaPublicKeyBytes(e.signer)]) : operation === 'owner-propose-administrator' ?
          Buffer.concat([discriminator('global', 'owner_propose_administrator'), solanaPublicKeyBytes(fixture.payer)]) : discriminator('global', 'accept_admin_role_token_admin_registry');
        assert.equal(ix.dataBase64, bytes.toString('base64')); assert.throws(() => client.inspectSigned(built.bytesBase64, e), /signature/);
      }
      const e = client.derive({ ...input, operation: 'create-token-account' });
      assert.throws(() => client.verifySnapshot([], e, 'before'), /Incomplete/);
    } finally { await client.destroy(); }
  } else {
    const client = await createSolanaPoolConfigSdk(root, selection);
    assert.ok('destroy' in client, 'Explicit TEST view must own its lifetime');
    try {
      assert.equal('sign' in client, false); assert.ok('registrationVerifier' in client); assert.equal('destroy' in client.registrationVerifier, false);
      for (const operation of POOL_CONFIG_OPERATIONS) {
        const rates = Buffer.concat([uint64(0n), uint64(0n), Buffer.from([1]), uint64(10000000000n), uint64(1000000000n)]);
        const e = client.derive({ ...input, operation, ...(['create-lookup-table', 'set-pool', 'repair-remote-pool-encoding'].includes(operation) ? { recentSlot: '10' } : {}),
          ...(operation === 'repair-remote-pool-encoding' ? { repairRateLimitsBase64: Buffer.concat([rates, rates]).toString('base64') } : {}) });
        const built: import('../src/adapters/solana-transaction-sdk.mjs').PreparedTransaction & { intent: import('../src/domain/solana-mint.ts').SolanaMintIntent; envelope: import('../src/domain/solana-pool-config.ts').SolanaPoolConfigEnvelope } = client.build(e, latest);
        const ix = built.intent.instructions[0]; assert.ok(ix);
        const data: Buffer = Buffer.from(ix.dataBase64, 'base64');
        if (operation === 'append-remote-pool-addresses') {
          assert.equal(data.readUInt32LE(48), 1); assert.equal(data.readUInt32LE(52), 20); assert.equal(data.subarray(56).toString('hex'), fixture.pool.slice(2));
        } else if (operation === 'init-chain-remote-config') {
          assert.equal(data.readUInt32LE(48), 0); assert.equal(data.readUInt32LE(52), 32); assert.equal(data.subarray(56, 88).toString('hex'), fixture.token.slice(2).padStart(64, '0')); assert.equal(data[88], 9);
        } else if (operation === 'set-chain-rate-limit') {
          assert.deepEqual(data.subarray(48), Buffer.concat([Buffer.from([1]), uint64(10000000000n), uint64(1000000000n), Buffer.from([1]), uint64(10000000000n), uint64(1000000000n)]));
        } else if (operation === 'set-pool') { assert.deepEqual(data.subarray(8), Buffer.from([3, 0, 0, 0, 3, 4, 7])); }
        else if (operation === 'create-lookup-table') { assert.equal(built.intent.instructions.length, 2); assert.equal(data.readBigUInt64LE(4), 10n); }
        else { assert.equal(data.readUInt32LE(52), 20); assert.equal(data.readUInt32LE(76), 32); }
        assert.throws(() => client.inspectSigned(built.bytesBase64, e), /signature/);
      }
    } finally { await client.destroy(); }
  }
  return { classification: 'controlled-unit-only', scenario: name, spl: 'authenticated-0.4.15', noBorrowedDisposal: true };
}
/** Controlled Borsh/account replies exercise actual SDK simulations and ALT retrieval; never captures. */
export async function svmReverseUnit(name: string, inputs: SvmInputs) {
  const {root, fixture} = inputs, selection = selectionFor(inputs);
  assert.ok(fixture); const exact = name === 'svm-reverse-exact-unit';
  const config = Buffer.alloc(210); discriminator('account', 'Config').copy(config); config[8] = 1; config[9] = 1;
  uint64(BigInt(fixture.forwardSelector)).copy(config, 10); solanaPublicKeyBytes(FEE_QUOTER_PROGRAM).copy(config, 82);
  solanaPublicKeyBytes('RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7').copy(config, 114);
  const linkMint = 'So11111111111111111111111111111111111111112'; solanaPublicKeyBytes(linkMint).copy(config, 146);
  let e: ReverseExpectation | undefined, table: Buffer | undefined, calls = 0, simulations = 0, stages = 0, altReads = 0;
  const replay: typeof fetch = async (_input, init) => {
    const r = object(JSON.parse(String(init?.body)) as unknown); calls++; assert.ok(Array.isArray(r.params)); let result: unknown;
    if (r.method === 'getGenesisHash') { assert.deepEqual(r.params, []); result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'; }
    else {
      assert.ok(e, 'derive must precede generation');
      if (r.method === 'getAccountInfo') {
        const address = r.params[0]; let data: Buffer, owner = SPL_TOKEN_PROGRAM;
        if (address === e.routerConfig) { data = config; owner = ROUTER_PROGRAM; }
        else if (address === e.alt) { assert.ok(table); data = table; owner = 'AddressLookupTab1e1111111111111111111111111'; altReads++; }
        else if (address === fixture.mint) { data = Buffer.alloc(82); data.writeUInt32LE(1); solanaPublicKeyBytes(e.signer).copy(data, 4); uint64(BigInt(fixture.amount)).copy(data, 36); data[44] = 9; data[45] = 1; }
        else { assert.equal(address, e.sourceAta); data = Buffer.alloc(165); solanaPublicKeyBytes(fixture.mint).copy(data); solanaPublicKeyBytes(fixture.payer).copy(data, 32); uint64(BigInt(fixture.amount)).copy(data, 64); data[108] = 1;
          if (exact) { data.writeUInt32LE(1, 72); solanaPublicKeyBytes(e.spender).copy(data, 76); uint64(BigInt(fixture.amount)).copy(data, 121); } }
        result = { context: { slot: 11 }, value: account(data, owner) };
      } else {
        assert.equal(r.method, 'simulateTransaction'); simulations++;
        // Literal 1.6.0 IDL response layout: Vec<Meta>, Vec<Meta>, Vec<Key>, String, String.
        let returned: Buffer;
        if (simulations === 1) { returned = Buffer.concat([uint64(5n), Buffer.alloc(16), solanaPublicKeyBytes(linkMint)]); }
        else {
          const main = [e.routerConfig, e.destChain, e.nonce, e.payer, SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM, linkMint, SYSTEM_PROGRAM,
            e.feeReceiver, e.spender, FEE_QUOTER_PROGRAM, e.feeConfig, e.feeDest, e.nativeFeeConfig, e.linkFeeConfig,
            'RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7', e.curses, e.rmnConfig];
          const remaining = [e.sourceAta, e.perTokenConfig, e.chain, e.alt, e.registry, BURNMINT_PROGRAM, e.pool, e.ata, e.signer, SPL_TOKEN_PROGRAM, e.mint, e.feeTokenConfig, e.routerPoolSigner];
          assert.ok(e.alt); const first = stages++ === 0, keys = first ? main : remaining;
          const metas = keys.map((key, i) => { assert.ok(key); return Buffer.concat([solanaPublicKeyBytes(key), Buffer.from([Number(first && i === 3), Number(first ? [1, 2, 3, 7, 8].includes(i) : [0, 2, 6, 7, 10].includes(i))])]); });
          returned = Buffer.concat([uint32(0), uint32(metas.length), ...metas, uint32(first ? 0 : 1), ...(first ? [] : [solanaPublicKeyBytes(e.alt)]),
            borshString(first ? 'Start' : 'TokenTransferStaticAccounts/0/0'), borshString(first ? 'TokenTransferStaticAccounts/0/0' : '')]);
        }
        result = { context: { slot: 11 }, value: { err: null, logs: [], accounts: null, unitsConsumed: 1000, returnData: { programId: ROUTER_PROGRAM, data: [returned.toString('base64'), 'base64'] } } };
      }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }));
  };
  const client = await createSolanaReverseSdk({ ...selection, providerDirectory: root, ccipProviderDirectory: root, recentSlot: '10', replayFetch: replay });
    assert.ok('destroy' in client, 'Explicit TEST view must own its lifetime');
  try {
    assert.equal('sign' in client, false);
    e = client.derive(linkMint, { approval: !exact, quotedFee: '5', sourceLamports: '1000000' }); assert.ok(e.alt);
    const req = createRequire(join(root, 'package.json'));
    const web3: typeof import('../../../.local/INPUT/provider/node_modules/@solana/web3.js/lib/index.js') = req('@solana/web3.js'); signingSentinels(web3);
    const addresses = [e.alt, e.registry, BURNMINT_PROGRAM, e.pool, e.ata, e.signer, SPL_TOKEN_PROGRAM, e.mint, e.feeTokenConfig, e.routerPoolSigner];
    table = Buffer.alloc(376); table.writeUInt32LE(1); table.writeBigUInt64LE((1n << 64n) - 1n, 4); table.writeBigUInt64LE(10n, 12); table[21] = 1;
    solanaPublicKeyBytes(fixture.payer).copy(table, 22); addresses.forEach((a, i) => solanaPublicKeyBytes(a).copy(table!, 56 + i * 32));
    const snapshot = { slot: '11', lookupTable: new web3.AddressLookupTableAccount({ key: new web3.PublicKey(e.alt), state: web3.AddressLookupTableAccount.deserialize(table) }) };
    const generated = await client.candidate(); assert.equal(generated.fee, '5'); assert.equal(generated.candidate.mainIndex, Number(!exact));
    const expected: ReverseExpectation = e;
    assert.throws(() => client.build(generated.candidate, { ...expected, quotedFee: '6' }, { blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: '100' }, snapshot), /mismatched native SDK candidate quote/);
    assert.throws(() => client.build({ ...generated.candidate }, expected, { blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: '100' }, snapshot), /Missing or mismatched native SDK candidate quote/);
    const built = client.build(generated.candidate, e, { blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: '100' }, snapshot);
    const send = generated.candidate.instructions.at(-1); assert.ok(send);
    const literalSend = Buffer.concat([Buffer.from('6cd886bff9ea2154', 'hex'), uint64(BigInt(fixture.reverseSelector)), uint32(32), Buffer.from(fixture.administrator.slice(2).padStart(64, '0'), 'hex'),
      uint32(0), uint32(1), solanaPublicKeyBytes(fixture.mint), uint64(BigInt(fixture.amount)), solanaPublicKeyBytes(SYSTEM_PROGRAM), uint32(21), Buffer.from('181dcf100000000000000000000000000000000001', 'hex'), uint32(1), Buffer.from([0])]);
    assert.deepEqual(send.data, literalSend); assert.ok(Buffer.from(built.bytesBase64, 'base64').length <= 1232);
    assert.throws(() => client.inspectSigned(built.bytesBase64, e!, snapshot), /Ed25519 signature/);
    assert.equal(stages, 2); assert.equal(altReads, 1); assert.equal(simulations, 3);
    let release: ((value: unknown) => void) | undefined, started: (() => void) | undefined;
    const deferred = new Promise<unknown>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    const pending = client.state.config(async (method, params) => {
      assert.equal(method, 'getMultipleAccounts'); assert.deepEqual(params, [[expected.routerConfig], { encoding: 'base64', commitment: 'finalized' }]);
      assert.ok(started); started(); return deferred;
    }, expected.routerConfig);
    const rejected = assert.rejects(pending, /busy\/destroyed|session destroyed/);
    await entered;
    let closed = false;
    const closing = client.destroy().then(() => { closed = true; return closed; });
    await new Promise<void>(resolve => { setImmediate(resolve); });
    assert.equal(closed, false, 'Admission remains installed until the finalized state read drains');
    assert.ok(release); release({ context: { slot: 11 }, value: [account(config, ROUTER_PROGRAM)] });
    await Promise.all([closing, rejected]);
    return { classification: 'controlled-unit-only', approval: !exact, rpcCalls: calls, nativeSimulations: simulations, nativeAltReads: altReads, quoteBindingDriftCases: 2, finalizedStateDrainWitness: true };
  } finally { await client.destroy(); }
}
export async function svmCompilerUnit(inputs: SvmInputs) {
  const {root, archives, fixture} = inputs;
  assert.ok(fixture); const session = await openTestSdk({ root, archives }); 
  try {
    const native = session.native; signingSentinels(native.web3);
    const pool = createPoolInitSdk(native), registration = createRegistrationSdk(native, pool), configuration = createPoolConfigSdk(native, registration, pool);
    const selectedPool = configuration.derive({ fixture, testOnly: true, cluster: 'solana-devnet', payer: fixture.payer, mint: fixture.mint, pool: fixture.solanaPool, operation: 'set-pool', recentSlot: '10' });
    const e: ReverseExpectation = { ...deriveReverseAccounts(native, selectedPool, 'So11111111111111111111111111111111111111112', reverseRoute(fixture)), fixture, approval: true, quotedFee: '5', sourceLamports: '1000000' };
    assert.ok(e.alt);
    const raw: import('../src/domain/solana-mint.ts').MintInstruction[] = reverseInstructions(e);
    const candidate: Candidate = { family: 'SVM', mainIndex: 1, instructions: raw.map(ix => new native.web3.TransactionInstruction({
      programId: new native.web3.PublicKey(ix.programId), data: Buffer.from(ix.dataBase64, 'base64'),
      keys: ix.accounts.map(a => ({ pubkey: new native.web3.PublicKey(a.address), isSigner: a.isSigner, isWritable: a.isWritable })) })),
      lookupTables: [new native.web3.AddressLookupTableAccount({ key: new native.web3.PublicKey(e.alt), state: { deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 10, lastExtendedSlotStartIndex: 0,
        authority: new native.web3.PublicKey(e.payer), addresses: [e.alt, e.registry, BURNMINT_PROGRAM, e.pool, e.ata, e.signer, SPL_TOKEN_PROGRAM, e.mint, e.feeTokenConfig, e.routerPoolSigner].map(a => new native.web3.PublicKey(a)) } })] };
    const observed = candidate.lookupTables?.[0]; assert.ok(observed);
    const snapshot = { slot: '11', lookupTable: new native.web3.AddressLookupTableAccount({ key: new native.web3.PublicKey(e.alt), state: {
      deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 10, lastExtendedSlotStartIndex: 0, authority: new native.web3.PublicKey(e.payer),
      addresses: [e.alt, e.registry, BURNMINT_PROGRAM, e.pool, e.ata, e.signer, SPL_TOKEN_PROGRAM, e.mint, e.feeTokenConfig, e.routerPoolSigner].map(a => new native.web3.PublicKey(a)),
    } }) };
    const compilerInputs: Candidate['instructions'][] = [];
    class ObservedMessage extends native.web3.TransactionMessage {
      constructor(input: ConstructorParameters<typeof native.web3.TransactionMessage>[0]) { compilerInputs.push(input.instructions); super(input); }
    }
    const sdk = createReverseTransactionSdk({ ...native, web3: { ...native.web3, TransactionMessage: ObservedMessage } }, expected => assert.deepEqual(expected, e));
    const latest = { blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: '100' };
    const built = sdk.build(candidate, e, latest, snapshot);
    assert.throws(() => sdk.inspectSigned(Buffer.alloc(1233).toString('base64'), e, snapshot), /Invalid reverse signed encoding/);
    assert.strictEqual(compilerInputs[0], candidate.instructions, 'Causal regression: first compilation consumes actual candidate instructions');
    assert.notStrictEqual(compilerInputs[1], candidate.instructions, 'Independent reconstruction remains an oracle only');
    for (const drift of [{ authority: new native.web3.PublicKey(e.mint) }, { deactivationSlot: 1n }, { lastExtendedSlot: 9 }, { lastExtendedSlotStartIndex: 1 }, { addresses: observed.state.addresses.toReversed() }]) {
      const wrong = new native.web3.AddressLookupTableAccount({ key: observed.key, state: { ...observed.state, ...drift } });
      assert.throws(() => sdk.build({ ...candidate, lookupTables: [wrong] }, e, latest, snapshot), /differs from independent finalized snapshot/);
    }
    const wrongKey = new native.web3.AddressLookupTableAccount({ key: new native.web3.PublicKey(e.mint), state: observed.state });
    assert.throws(() => sdk.build({ ...candidate, lookupTables: [wrongKey] }, e, latest, snapshot), /differs from independent finalized snapshot/);
    for (const bad of [{ ...candidate, family: 'EVM' }, { ...candidate, mainIndex: undefined }, { ...candidate, lookupTables: undefined }, { ...candidate, instructions: candidate.instructions.toReversed() }]) {
      // Invalid boundary data intentionally remains unknown until the runtime call.
      assert.throws(() => Reflect.apply(sdk.build, undefined, [bad, e, latest, snapshot]), /instruction list|Unexpected reverse instruction/);
    }
    assert.throws(() => Reflect.apply(sdk.build, undefined, [candidate, e, latest]), /snapshot required/);
    for (const invalid of [{ blockhash: 'bad', lastValidBlockHeight: '100' }, { blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: '0' }]) {
      assert.throws(() => sdk.build(candidate, e, invalid, snapshot), /block validity|Invalid public key/);
    }
    for (const mutate of [(tx: InstanceType<typeof native.web3.VersionedTransaction>) => { tx.message.header.numReadonlyUnsignedAccounts++; },
      (tx: InstanceType<typeof native.web3.VersionedTransaction>) => { assert.equal(tx.message.version, 0); if (tx.message.version === 0) { const lookup = tx.message.addressTableLookups[0]; assert.ok(lookup); lookup.writableIndexes[0] = 2; } }]) {
      const tx = native.web3.VersionedTransaction.deserialize(Buffer.from(built.bytesBase64, 'base64')); mutate(tx);
      assert.throws(() => sdk.inspectSigned(Buffer.from(tx.serialize()).toString('base64'), e, snapshot), /global privileges/);
    }
    const result = { classification: 'controlled-unit-only', actualCandidateCompilerWitness: true, altDriftCases: 6, wireDriftCases: 2 };
    session.assertHealthy(); return { ...result, admission: session.evidence };
  } finally { session.close(); }
}
export async function svmCaptured(name: 'approval' | 'exact', inputs: SvmInputs) {
  const {root, fixture, captures} = inputs, selection = selectionFor(inputs);
  assert.ok(fixture); assert.ok(existsSync(join(captures, 'index.json')), 'Missing genuine hash-bound SVM capture index; UNQUALIFIED');
  const manifest = readJson(join(captures, 'index.json')); assert.equal(manifest.schema, 'agtmai-test-sdk-svm-captures-v1'); assert.equal(manifest.fixtureIdentity, fixture.identity);
  const c = object(object(manifest.cases)[name]), rows = replayRows(c, captures, DEFAULT_SOLANA_RPC), expected = object(JSON.parse(safeFile(captures, c.expectedFile, c.expectedSha256).toString()) as unknown);
  const observation = object(expected.observation), lookup = object(expected.finalizedLookup), packet = object(expected.unsignedPacket);
  for (const key of ['recentSlot', 'linkMint', 'quotedFee', 'sourceLamports']) { assert.equal(typeof observation[key], 'string'); }
  for (const key of ['slot', 'key', 'dataBase64']) { assert.equal(typeof lookup[key], 'string'); }
  for (const key of ['blockhash', 'lastValidBlockHeight', 'bytesBase64', 'messageBase64']) { assert.equal(typeof packet[key], 'string'); }
  let cursor = 0;
  const normalize = (body: unknown): unknown => Array.isArray(body) ? body.map(normalize) : { ...object(body), id: null };
  const replay: typeof fetch = async (input, init) => {
    const row = rows[cursor++]; assert.ok(row, 'Missing captured SVM request'); assert.equal(String(input), row.url); assert.equal(init?.method, 'POST');
    const actual: unknown = JSON.parse(String(init?.body)); assert.deepEqual(normalize(actual), normalize(row.request), 'Exact captured SVM request mismatch');
    const requests = (Array.isArray(actual) ? actual : [actual]).map(object), recorded = (Array.isArray(row.request) ? row.request : [row.request]).map(object);
    const rewrite = (reply: unknown): unknown => { const r = object(reply), i = recorded.findIndex(q => q.id === r.id); assert.ok(i >= 0); return { ...r, id: requests[i]?.id }; };
    const body = Array.isArray(row.response) ? row.response.map(rewrite) : rewrite(row.response);
    const response = new Response(JSON.stringify(body), { status: row.status, headers: row.headers }); Object.defineProperty(response, 'redirected', { value: row.redirected }); return response;
  };
  const client = await createSolanaReverseSdk({ ...selection, providerDirectory: root, ccipProviderDirectory: root, recentSlot: String(observation.recentSlot), replayFetch: replay });
    assert.ok('destroy' in client, 'Explicit TEST view must own its lifetime');
  try {
    const req = createRequire(join(root, 'package.json'));
    const web3: typeof import('../../../.local/INPUT/provider/node_modules/@solana/web3.js/lib/index.js') = req('@solana/web3.js'); signingSentinels(web3);
    const e = client.derive(String(observation.linkMint), { approval: name === 'approval', quotedFee: String(observation.quotedFee), sourceLamports: String(observation.sourceLamports) });
    const data = Buffer.from(String(lookup.dataBase64), 'base64'); assert.equal(data.toString('base64'), lookup.dataBase64);
    const snapshot = { slot: String(lookup.slot), lookupTable: new web3.AddressLookupTableAccount({ key: new web3.PublicKey(String(lookup.key)), state: web3.AddressLookupTableAccount.deserialize(data) }) };
    const generated = await client.candidate(); assert.equal(generated.fee, observation.quotedFee);
    const built = client.build(generated.candidate, e, { blockhash: String(packet.blockhash), lastValidBlockHeight: String(packet.lastValidBlockHeight) }, snapshot);
    assert.equal(built.bytesBase64, packet.bytesBase64, 'Independent captured packet bytes'); assert.equal(built.messageBase64, packet.messageBase64);
    const signed = object(expected.publicSignedPacket); assert.equal(typeof signed.bytesBase64, 'string');
    assert.equal(client.inspectSigned(String(signed.bytesBase64), e, snapshot).messageBase64, packet.messageBase64, 'Native Ed25519 verification of externally supplied public packet');
    assert.equal(cursor, rows.length, 'Unused required SVM capture');
    return { indexSha256: digest(readTestSdkBytes(join(captures, 'index.json'))), expectationSha256: c.expectedSha256, case: name, rows: cursor };
  } finally { await client.destroy(); }
}
