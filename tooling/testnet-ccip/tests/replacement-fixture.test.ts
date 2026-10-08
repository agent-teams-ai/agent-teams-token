import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { replacementFixture, validateReplacementFixture, selectedFixture, fixtureNamespace, REPLACEMENT } from '../src/domain/replacement-fixture.ts';
import { bindFixture } from '../src/adapters/fixture-binding.ts';
import { executeSolanaManualRecovery } from '../src/composition/solana-manual-execution.mjs';
import { forwardRoute, forwardIntent, forwardRecipient, FORWARD } from '../src/domain/evm-forward.mjs';
import { createForwardDecoder } from '../src/adapters/evm-forward-sdk.mjs';
import { transferEvmForward } from '../src/composition/transfer-evm-forward.mjs';
import { reverseRoute, reverseInstructions, deriveReverseAccounts, reverseContract, REVERSE } from '../src/domain/solana-reverse.mjs';
import { createReverseTransactionSdk, createSolanaReverseSdk, type Candidate, type ReverseExpectation } from '../src/adapters/solana-reverse-sdk.mjs';
import { createReverseState } from '../src/adapters/solana-reverse-state.mjs';
import { loadSolanaProvider } from '../src/adapters/solana-transaction-sdk.mjs';
import { createMintSdk } from '../src/adapters/solana-sdk.mjs';
import { testTokenConstructor } from '../src/composition/deploy-token.ts';
import { lockReleaseConstructor } from '../src/domain/evm-pool.ts';
import { createPoolInitSdk } from '../src/adapters/solana-pool-init-sdk.mjs';
import { createRegistrationSdk } from '../src/adapters/solana-registration-sdk.mjs';
import { createPoolConfigSdk } from '../src/adapters/solana-pool-config-sdk.mjs';
import { remoteConfigCalldata, solanaRemote, nextRemoteConfigStep, SOLANA_REMOTE } from '../src/domain/evm-remote-config.ts';
import type { RemoteSnapshot } from '../src/domain/evm-remote-config.ts';
import { poolConfigInstructions, altAddresses, SEPOLIA_SELECTOR, ALT_PROGRAM, FEE_QUOTER_PROGRAM } from '../src/domain/solana-pool-config.ts';
import type { SolanaPoolConfigExpectation } from '../src/domain/solana-pool-config.ts';
import { solanaPublicKeyBytes, SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM } from '../src/domain/solana-mint.ts';
import { BURNMINT_PROGRAM, POOL_GLOBAL } from '../src/domain/solana-pool-init.ts';
import { ROUTER_PROGRAM } from '../src/domain/solana-registration.ts';
import { unsignedSvmPrimitives } from '../src/adapters/dev-provider-primitives.mjs';
import { verifySvmWirePacket } from '../src/adapters/dev-svm-call-plan.mjs';
import { matchRequest } from '../src/domain/transfer-status.mjs';
import { evmEffect, solanaEffect, authenticatedSolanaEffect, type NativeStatusLane, type InvocationLog, type ParsedInstruction } from '../src/adapters/transfer-status-native.mjs';
import { validateSepoliaIntent } from '../src/domain/evm-intent.ts';
import type { NativeProvider } from '../src/adapters/solana-transaction-sdk.mjs';
import type { CastSignerConfig } from '../src/adapters/evm-cast.ts';
import type { StatusRequest } from '../src/domain/transfer-status.mjs';
import { forwardJournalBinding, type BoundForwardJournalRecord } from '../src/adapters/evm-forward-journal.ts';
import { createJournalFile } from '../src/adapters/evm-journal-file.ts';
import { runSolanaTransactionJournal } from '../src/application/solana-transaction-journal.ts';
import { allowlistedChildEnvironment } from '../../../scripts/execution-environment/toolchain-environment.mjs';

// Synthetic codec addresses only: these are deliberately never advertised as deployments.
const fixture = replacementFixture('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222');
const selection = { testOnly: true as const, fixture, fixtureIdentity: fixture.identity };
const signer: CastSignerConfig = { testOnly: true, executable: '/unused', executableSha256: '00'.repeat(32), keystore: '/unused',
  passwordFile: '/unused', gasLimit: '21000', maxFeePerGas: '100', maxPriorityFeePerGas: '1' };
const namespace = fixtureNamespace(fixture);
const root = resolve('.local', namespace);
const topic = (address: string) => '0x' + address.slice(2).padStart(64, '0');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

// Catches mutable or unrecognized identity admission and side effects before route binding.
test('immutable authenticated selection rejects changed identities and legacy journal aliases before provider/journal access', async () => {
  assert.ok(Object.isFrozen(fixture));
  assert.equal(fixture.administrator, REPLACEMENT.administrator);
  assert.deepEqual(validateReplacementFixture(JSON.parse(JSON.stringify(fixture))), fixture);
  assert.equal(selectedFixture({}), undefined);
  for (const key of Object.keys(fixture) as (keyof typeof fixture)[]) {
    assert.throws(() => validateReplacementFixture({ ...fixture, [key]: 'mutated' }));
  }
  for (const invalid of [null, {}, { ...fixture, extra: true }]) { assert.throws(() => validateReplacementFixture(invalid)); }
  for (const address of ['', '0x0', SYSTEM_PROGRAM, '0x' + '00'.repeat(20), FORWARD.token]) {
    assert.throws(() => replacementFixture(address, fixture.pool));
  }
  assert.throws(() => bindFixture({ ...selection, fixtureIdentity: '0'.repeat(64) }), /identity/);
  assert.throws(() => bindFixture({ ...selection, chainId: '1' }), /chain/);
  assert.throws(() => bindFixture({ ...selection, expected: { testOnly: true, cluster: 'solana-devnet', payer: REVERSE.payer, mint: fixture.mint } }), /authority/);
  assert.throws(() => bindFixture(selection, ['/tmp/old-agtmai/send.json']), /legacy reuse/);
  await assert.rejects(transferEvmForward({ ...selection, providerDirectory: '/unused', signer, approvalNonce: '7', sendNonce: '8',
    approvalJournal: '/tmp/legacy/approval', sendJournal: '/tmp/legacy/send' }, {
    sdk: async () => { throw new Error('provider must not load'); },
    snapshot: async () => { throw new Error('no snapshot'); }, read: async () => { throw new Error('no read'); },
    execute: async () => { throw new Error('no execute'); }, exclusive: async () => { throw new Error('no lock'); },
  }), /legacy reuse/);
  await assert.rejects(executeSolanaManualRecovery({ ...selection, journalFile: join(root, 'manual'), maxNativeBalanceLamports: '1000000' }), /fresh message-specific/);
  const directory = await mkdtemp(join(tmpdir(), 'replacement-binding-'));
  try {
    await symlink(directory, join(directory, namespace));
    assert.throws(() => bindFixture(selection, [join(directory, namespace, 'send')]), /symlink/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Frozen SHA oracles were obtained by executing the unchanged exact-base serializers.
// Catches accidental schema, property order, discriminator or historical calldata drift.
test('historical reverse journal and remote configuration bytes remain exactly compatible', () => {
  const expected = { testOnly: true, cluster: 'solana-devnet', payer: REVERSE.payer, mint: REVERSE.mint,
    ...Object.fromEntries(['pool','chain','signer','ata','registry','routerConfig','feeTokenConfig','routerPoolSigner','alt','sourceAta',
      'destChain','nonce','feeReceiver','spender','feeConfig','feeDest','nativeFeeConfig','linkFeeConfig','curses','rmnConfig','perTokenConfig','linkMint'].map(k => [k,REVERSE.payer])),
    approval: true, quotedFee: '5', sourceLamports: '1000000' };
  const contract = reverseContract(expected), envelope = contract.verify({ feePayer: REVERSE.payer, instructions: reverseInstructions(expected) }, expected);
  assert.equal(hash(contract.canonical(envelope, expected)), '11a9c73f861b91d20d4551a9c97a4d6f7436051a4596cffa5255a2d25f2fcf63');
  assert.equal(hash(remoteConfigCalldata()), 'a769760f6e9fe6fca3f00e69f7c05dbe8ad4b0e03a72c4cf4327b1c15bf91450');
});

const codecDirectory = allowlistedChildEnvironment().AGTMAI_REPLACEMENT_CODEC_DIRECTORY;
const requireCodec = codecDirectory ? createRequire(resolve(codecDirectory, 'package.json')) : undefined;
function codecs(): NativeProvider {
  assert.ok(codecDirectory && requireCodec, 'Set AGTMAI_REPLACEMENT_CODEC_DIRECTORY to the explicit public codec installation');
  for (const [name, version] of [['@solana/web3.js', '1.98.4'], ['@solana/spl-token', '0.4.14'], ['ethers', '6.17.0'], ['@chainlink/ccip-sdk', '1.13.0']] as const) {
    assert.equal((JSON.parse(readFileSync(resolve(codecDirectory!, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version, version);
  }
  const web3: NativeProvider['web3'] = requireCodec('@solana/web3.js');
  const spl: NativeProvider['spl'] = requireCodec('@solana/spl-token');
  const bs58: { default: NativeProvider['bs58'] } = createRequire(requireCodec.resolve('@chainlink/ccip-sdk'))('bs58');
  return { web3, spl, bs58: bs58.default };
}
function setup(provider: ReturnType<typeof codecs>, selected = true) {
  const pool = createPoolInitSdk(provider), registration = createRegistrationSdk(provider, pool);
  const config = createPoolConfigSdk(provider, registration, pool);
  const expected: SolanaPoolConfigExpectation = config.derive({ testOnly: true, cluster: 'solana-devnet', operation: 'set-pool',
    payer: selected ? fixture.payer : REVERSE.payer, mint: selected ? fixture.mint : REVERSE.mint,
    pool: selected ? fixture.solanaPool : provider.web3.PublicKey.findProgramAddressSync([Buffer.from('ccip_tokenpool_config'), solanaPublicKeyBytes(REVERSE.mint)], new provider.web3.PublicKey(BURNMINT_PROGRAM))[0].toBase58(),
    recentSlot: '1', ...(selected ? { fixture } : {}) });
  const route = reverseRoute(selected ? fixture : undefined);
  const e: ReverseExpectation = { ...deriveReverseAccounts(provider, expected, REVERSE.nativeMint, route), approval: true, quotedFee: '5', sourceLamports: '1000000' };
  assert.ok(e.alt && e.recentSlot);
  return { pool, registration, config, e: { ...e, alt: e.alt, recentSlot: e.recentSlot }, route };
}
function remoteSnapshot(): RemoteSnapshot {
  const remote = solanaRemote(fixture), rate = { enabled: true, capacity: remote.capacity, rate: remote.rate };
  return { registration: { chainId: '11155111', finalizedBlockHash: '0x' + 'ab'.repeat(32), token: fixture.token, tokenAdmin: fixture.administrator,
    administrator: fixture.administrator, pendingAdministrator: '0x' + '00'.repeat(20), tokenPool: fixture.pool, poolToken: fixture.token, poolOwner: fixture.administrator },
    supported: true, pools: [remote.pool], token: remote.token, inbound: rate, outbound: rate };
}
// Catches one-way rebinding: EVM ABI, raw Solana reciprocal peers, authority and loader PDA/ATA capabilities all agree.
test('replacement reciprocal setup and forward ABI use actual actor/mint/recipient with unchanged protocol pins', { skip: !codecDirectory }, async () => {
  const provider = codecs();
  const { Interface, AbiCoder }: typeof import('../../../.local/INPUT/provider/node_modules/ethers/lib.esm/abi/index.js') = requireCodec!('ethers');
  const { pool, config, e } = setup(provider);
  assert.equal(e.pool, fixture.solanaPool, 'Pinned web3 PDA derivation must match selected pool');
  assert.equal(e.sourceAta, provider.spl.getAssociatedTokenAddressSync(new provider.web3.PublicKey(fixture.mint), new provider.web3.PublicKey(fixture.payer)).toBase58());
  const target = { ...selection, token: fixture.token, pool: fixture.pool, administrator: fixture.administrator };
  assert.equal(nextRemoteConfigStep(remoteSnapshot(), target), 'complete');
  for (const changed of [{ ...remoteSnapshot(), pools: [SOLANA_REMOTE.pool] }, { ...remoteSnapshot(), token: SOLANA_REMOTE.token },
    { ...remoteSnapshot(), registration: { ...remoteSnapshot().registration, poolOwner: FORWARD.administrator } },
    { ...remoteSnapshot(), registration: { ...remoteSnapshot().registration, chainId: '1' } }]) {
    assert.throws(() => nextRemoteConfigStep(changed as RemoteSnapshot, target));
  }
  const remoteAbi = new Interface(['function applyChainUpdates(uint64[] removes,(uint64 selector,bytes[] pools,bytes token,(bool enabled,uint128 capacity,uint128 rate) outbound,(bool enabled,uint128 capacity,uint128 rate) inbound)[] adds)']);
  const call = remoteAbi.decodeFunctionData('applyChainUpdates', remoteConfigCalldata(fixture));
  assert.equal(call.adds[0].selector, 16423721717087811551n);
  assert.equal(call.adds[0].pools[0], '0x' + solanaPublicKeyBytes(fixture.solanaPool).toString('hex'));
  assert.equal(call.adds[0].token, '0x' + solanaPublicKeyBytes(fixture.mint).toString('hex'));
  for (const operation of ['init-chain-remote-config', 'append-remote-pool-addresses'] as const) {
    const input = config.derive({ ...e, operation, recentSlot: null });
    const first = poolConfigInstructions(input)[0]; assert.ok(first);
    const data = Buffer.from(first.dataBase64, 'base64');
    assert.equal(data.readBigUInt64LE(8).toString(), SEPOLIA_SELECTOR);
    if (operation === 'init-chain-remote-config') { assert.equal(data.subarray(56, 88).toString('hex'), fixture.token.slice(2).padStart(64, '0')); }
    else { assert.equal(data.readUInt32LE(48), 1); assert.equal(data.readUInt32LE(52), 20); assert.equal(data.subarray(56).toString('hex'), fixture.pool.slice(2)); }
    const payer = first.accounts[2]; assert.ok(payer); assert.equal(payer.address, fixture.payer);
  }
  const route = forwardRoute(fixture), coder = AbiCoder.defaultAbiCoder();
  const [supply, allocations, admin] = coder.decode(['uint256', 'tuple(bytes32 bucket,address recipient,uint256 amount)[]', 'address'], testTokenConstructor(fixture.administrator));
  assert.equal(supply, 100000000000n); assert.equal(allocations.length, 1); assert.equal(allocations[0].amount, supply);
  assert.equal(allocations[0].recipient.toLowerCase(), fixture.administrator); assert.equal(admin.toLowerCase(), fixture.administrator);
  const poolArgs = coder.decode(['address', 'uint8', 'address[]', 'address', 'address'], lockReleaseConstructor(fixture.token));
  assert.equal(poolArgs[0].toLowerCase(), fixture.token); assert.equal(poolArgs[1], 9n); assert.equal(poolArgs[2].length, 0);
  assert.equal(poolArgs[3].toLowerCase(), '0xba3f6251de62ded61ff98590cb2fdf6871fbb991'); assert.equal(poolArgs[4].toLowerCase(), route.router);
  const latest = { blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: '100' };
  const mint = createMintSdk(provider).build({ testOnly: true, cluster: 'solana-devnet', payer: fixture.payer, mint: fixture.mint, rentLamports: '1000000' }, latest);
  assert.equal(mint.envelope.decimals, 9); assert.equal(mint.envelope.initialSupply, '0'); assert.equal(mint.envelope.freezeAuthority, null);
  const initialized = pool.build({ testOnly: true, cluster: 'solana-devnet', payer: fixture.payer, mint: fixture.mint, pool: fixture.solanaPool, fixture }, latest);
  assert.equal(initialized.envelope.pool, fixture.solanaPool); assert.equal(initialized.envelope.fixture?.identity, fixture.identity);

  const iface = new Interface(['function approve(address,uint256)', 'function ccipSend(uint64,(bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs)) payable returns(bytes32)']);
  const extra = '0x1f3b3aba' + coder.encode(['tuple(uint32,uint64,bool,bytes32,bytes32[])'], [[0n, 0n, true, '0x' + solanaPublicKeyBytes(fixture.payer).toString('hex'), []]]).slice(2);
  const send = { from: fixture.administrator, to: route.router, value: 5n,
    data: iface.encodeFunctionData('ccipSend', [route.selector, ['0x' + '00'.repeat(32), '0x', [[fixture.token, 1000000000n]], '0x' + '00'.repeat(20), extra]]) };
  const verify = createForwardDecoder({ Interface, AbiCoder }, fixture.payer, fixture);
  verify(send, 'send', 5n);
  verify({ ...send, to: fixture.token, value: 0n, data: iface.encodeFunctionData('approve', [route.router, 1000000000n]) }, 'approval', 0n);
  for (const changed of [{ ...send, from: FORWARD.administrator }, { ...send, value: 6n }, { ...send, to: fixture.pool }]) {
    assert.throws(() => verify(changed, 'send', 5n));
  }
  assert.throws(() => createForwardDecoder({ Interface, AbiCoder }, FORWARD.recipient, fixture));
  const executed: unknown[] = [], journal = join(root, 'send');
  const intent = forwardIntent(send, '8', route);
  const settings = { ...selection, providerDirectory: '/unused', signer, approvalNonce: '7', sendNonce: '8', approvalJournal: join(root, 'approve'), sendJournal: journal };
  const stored: BoundForwardJournalRecord = { schema: 'agtmai-evm-journal-v1', phase: 'submitting', intent: validateSepoliaIntent(intent, intent),
    signed: { bytes: '0x0102', hash: '0x' + 'ab'.repeat(32) },
    forwardBinding: forwardJournalBinding(fixture, forwardRecipient(undefined, fixture), settings), forwardStep: 'send' };
  const ports = { sdk: async () => ({ verify, destroy: async () => {}, allowance: async () => { throw new Error('No fresh allowance on uncertain send'); }, prepare: async () => { throw new Error('No fresh quote'); } }),
    snapshot: async () => { throw new Error('No progressed prerequisites'); }, exclusive: async <T>(_file: string, work: () => Promise<T>) => work(),
    read: async (file: string) => file === journal ? stored : null,
    io: { journal: createJournalFile, signer: () => ({ sign: async () => assert.fail('No signing in fixture control'),
      inspectSigned: async () => ({ ...stored.intent, hash: stored.signed.hash }) }) },
    execute: async (saved: unknown) => { executed.push(saved); return { status: 'unresolved', reason: 'uncertain', transactionHash: '0x' + 'ab'.repeat(32) }; } };
  await transferEvmForward(settings, ports);
  assert.deepEqual(executed, [intent]);
  const actualSdk = { verify, destroy: async () => {}, allowance: async () => 0n,
    prepare: async () => ({ fee: 5n, send, approval: { from: fixture.administrator, to: fixture.token, value: 0n,
      data: iface.encodeFunctionData('approve', [route.router, 1000000000n]) } }) };
  const fresh = { ...ports, sdk: async () => actualSdk, read: async () => null, snapshot: async () => remoteSnapshot() };
  executed.length = 0;
  assert.equal((await transferEvmForward(settings, fresh)).step, 'approval');
  assert.equal(executed.length, 1);
  executed.length = 0;
  await assert.rejects(transferEvmForward(settings, { ...fresh, snapshot: async () => ({ ...remoteSnapshot(), pools: [SOLANA_REMOTE.pool] }) }), /Conflicting/);
  assert.equal(executed.length, 0);
  const wrongRecipient = send.data.replace(solanaPublicKeyBytes(fixture.payer).toString('hex'), solanaPublicKeyBytes(REVERSE.payer).toString('hex'));
  const changed = { ...stored, intent: validateSepoliaIntent({ ...intent, data: wrongRecipient }, { ...intent, data: wrongRecipient }) };
  await assert.rejects(transferEvmForward(settings, { ...fresh, read: async (file: string) => file === journal ? changed : null }), /decoded forward/);
  assert.equal(executed.length, 0, 'Stored send must bind before an approval can execute');

});

// Catches compiler self-verification: actual v0 bytes are checked by the independent existing raw oracle and official Borsh IDL.
test('replacement raw wire rejects receiver/amount/global signer/writable/ALT mutations; legacy payload stays exact', { skip: !codecDirectory }, async () => {
  const provider = codecs(), { e, route } = setup(provider), { PublicKey, TransactionInstruction, AddressLookupTableAccount, VersionedTransaction } = provider.web3;
  const sdk = createReverseTransactionSdk(provider, (expected: ReverseExpectation) => assert.deepEqual(expected, e));
  const instructions = reverseInstructions(e);
  const sdkRequire = createRequire(requireCodec!.resolve('@chainlink/ccip-sdk'));
  const anchor: typeof import('../../../.local/INPUT/provider/node_modules/@coral-xyz/anchor/dist/cjs/index.js') = sdkRequire('@coral-xyz/anchor');
  const { BorshInstructionCoder } = anchor; const BN: typeof anchor.BN = sdkRequire('bn.js');
  const official: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/extra-args.js') = await import(pathToFileURL(resolve(codecDirectory!, 'node_modules/@chainlink/ccip-sdk/dist/solana/extra-args.js')).href);
  const { IDL }: typeof import('../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js') = await import(pathToFileURL(resolve(codecDirectory!, 'node_modules/@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js')).href);
  const raw = new BorshInstructionCoder(IDL).encode('ccipSend', { destChainSelector: new BN(SEPOLIA_SELECTOR), message: {
    receiver: Buffer.from(fixture.administrator.slice(2).padStart(64, '0'), 'hex'), data: Buffer.alloc(0), tokenAmounts: [{ token: new PublicKey(fixture.mint), amount: new BN('1000000000') }],
    feeToken: new PublicKey(SYSTEM_PROGRAM), extraArgs: Buffer.from(official.encodeSolanaExtraArgs({ gasLimit: 0n, allowOutOfOrderExecution: true }).slice(2), 'hex') }, tokenIndexes: Buffer.from([0]) });
  const main = instructions[1]; assert.ok(main); assert.deepEqual(Buffer.from(main.dataBase64, 'base64'), raw);
  const candidate: Candidate = { family: 'SVM', mainIndex: 1, instructions: instructions.map(ix => new TransactionInstruction({ programId: new PublicKey(ix.programId),
    data: Buffer.from(ix.dataBase64, 'base64'), keys: ix.accounts.map(a => ({ pubkey: new PublicKey(a.address), isSigner: a.isSigner, isWritable: a.isWritable })) })),
    lookupTables: [new AddressLookupTableAccount({ key: new PublicKey(e.alt), state: { deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: Number(e.recentSlot), lastExtendedSlotStartIndex: 0, authority: new PublicKey(e.payer), addresses: altAddresses(e).map(a => new PublicKey(a)) } })] };
  // Independently selected synthetic finalized unit snapshot, never public-chain evidence.
  const snapshot = { slot: (BigInt(e.recentSlot) + 1n).toString(), lookupTable: new AddressLookupTableAccount({ key: new PublicKey(e.alt), state: {
    deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: Number(e.recentSlot), lastExtendedSlotStartIndex: 0,
    authority: new PublicKey(e.payer), addresses: altAddresses(e).map(a => new PublicKey(a)) } }) };
  const built = sdk.build(candidate, e, { blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: '100' }, snapshot);
  const tableBytes = Buffer.alloc(376); tableBytes.writeUInt32LE(1); tableBytes.writeBigUInt64LE((1n << 64n) - 1n, 4); tableBytes[21] = 1; solanaPublicKeyBytes(e.payer).copy(tableBytes, 22);
  altAddresses(e).forEach((address, index) => solanaPublicKeyBytes(address).copy(tableBytes, 56 + index * 32));
  const table = { key: e.alt, dataBase64: tableBytes.toString('base64') };
  const verify = (bytesBase64: string, lookup = table) => verifySvmWirePacket(unsignedSvmPrimitives(provider.web3), { ...route, selector: SEPOLIA_SELECTOR }, e, { ...built, bytesBase64, instructions }, lookup);
  verify(built.bytesBase64);
  assert.ok(Buffer.from(built.bytesBase64, 'base64').length <= 1232);
  for (const mutate of [
    (tx: ReturnType<typeof VersionedTransaction.deserialize>) => { const ix = tx.message.compiledInstructions[1]; assert.ok(ix); const byte = ix.data[51]; assert.ok(byte !== undefined); ix.data[51] = byte ^ 1; },
    (tx: ReturnType<typeof VersionedTransaction.deserialize>) => { const ix = tx.message.compiledInstructions[1]; assert.ok(ix); const byte = ix.data[92]; assert.ok(byte !== undefined); ix.data[92] = byte ^ 1; },
    (tx: ReturnType<typeof VersionedTransaction.deserialize>) => { tx.message.header.numRequiredSignatures = 2; },
    (tx: ReturnType<typeof VersionedTransaction.deserialize>) => { tx.message.header.numReadonlyUnsignedAccounts--; },
    (tx: ReturnType<typeof VersionedTransaction.deserialize>) => { const lookup = tx.message.addressTableLookups[0]; assert.ok(lookup); lookup.writableIndexes[0] = 2; },
  ]) {
    const tx = VersionedTransaction.deserialize(Buffer.from(built.bytesBase64, 'base64')); mutate(tx);
    assert.throws(() => verify(Buffer.from(tx.serialize()).toString('base64')));
  }
  const wrongTable = Buffer.from(tableBytes); solanaPublicKeyBytes(e.payer).copy(wrongTable, 56 + 3 * 32);
  assert.throws(() => verify(built.bytesBase64, { ...table, dataBase64: wrongTable.toString('base64') }));
  const candidateTable = candidate.lookupTables?.[0]; assert.ok(candidateTable); candidateTable.state.addresses[7] = new PublicKey(REVERSE.mint);
  assert.throws(() => sdk.build(candidate, e, { blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: '100' }, snapshot), /ALT/);
  const legacy = setup(provider, false).e;
  const captured = '6cd886bff9ea2154d91ad9c94fba41de20000000000000000000000000000000275ee728c49100b56d4aa37c00e2dc8ffc5e5df60000000001000000009d49372ba9140a49e384e7a023a8f5273e7b1b9f87033ceb5ce59c116e900200ca9a3b00000000000000000000000000000000000000000000000000000000000000000000000015000000181dcf1000000000000000000000000000000000010100000000';
  assert.equal(Buffer.from(reverseInstructions(legacy).at(-1)!.dataBase64, 'base64').toString('hex'), captured);
  const envelope = reverseContract(legacy).verify({ feePayer: legacy.payer, instructions: reverseInstructions(legacy) }, legacy);
  assert.equal(reverseContract(legacy).canonical(envelope, legacy), JSON.stringify(envelope));
  assert.equal(Object.hasOwn(envelope, 'fixture'), false);
  const expected = { ...e, testOnly: true as const, cluster: 'solana-devnet' as const };
  const stored = { schema: 'agtmai-solana-reverse-journal-v1', phase: 'submitting' as const,
    intent: reverseContract(expected).verify({ feePayer: expected.payer, instructions }, expected), messageBase64: built.messageBase64,
    signed: { bytesBase64: built.bytesBase64, signature: '1'.repeat(88), blockhash: SYSTEM_PROGRAM, lastValidBlockHeight: '100' } };
  // Journal recovery uses real verified raw message, but a synthetic signature/observation (no signing).
  let writes = 0;
  const ports = { exclusive: async <T>(work: () => Promise<T>) => work(), read: async () => stored, write: async () => { writes++; },
    sign: async () => { throw new Error('uncertain send cannot be signed again'); }, broadcast: async () => { throw new Error('uncertain send cannot be resent'); },
    inspectSigned: async () => ({ signature: stored.signed.signature, blockhash: SYSTEM_PROGRAM, messageBase64: built.messageBase64, intent: { feePayer: expected.payer, instructions } }),
    observe: async () => ({ kind: 'expired' as const }) };
  assert.equal((await runSolanaTransactionJournal(expected, ports, reverseContract(expected))).status, 'unresolved');
  assert.equal(writes, 0);
  const settled = await runSolanaTransactionJournal(expected, { ...ports,
    observe: async () => ({ kind: 'finalized' as const, signature: stored.signed.signature, messageBase64: built.messageBase64,
      slot: '99', err: null, state: { sourceReceiptVerified: true } }) }, reverseContract(expected));
  assert.equal(settled.status, 'succeeded'); assert.equal(settled.reason, 'finalized-source-receipt-only');
  assert.equal(writes, 1);

  await assert.rejects(runSolanaTransactionJournal({ ...expected, fixture: { ...fixture, identity: '0'.repeat(64) } }, ports, reverseContract(expected)));
});

interface Capture { dataBase64: string; owner: string }
interface RawAccount { data: [string, 'base64']; owner: string; executable: false; lamports: number }
// Captured layouts are retained; substitutions below are explicitly synthetic public identities.
async function replacementState(e: ReturnType<typeof setup>['e']) {
  const golden = JSON.parse(await readFile(new URL('./fixtures/dev-svm-call-plan-goldens.json', import.meta.url), 'utf8')) as { facts: { state: Record<string, Capture> } };
  const state = Object.fromEntries(Object.entries(golden.facts.state).map(([name, value]) => [name, Buffer.from(value.dataBase64, 'base64')]));
  const bytes = (name: string) => { const value = state[name]; assert.ok(value); return value; };
  const key = (name: string, offset: number, address: string) => solanaPublicKeyBytes(address).copy(bytes(name), offset);
  key('mint', 4, e.signer); bytes('mint').writeBigUInt64LE(1000000000n, 36);
  bytes('sourceAta').writeBigUInt64LE(1000000000n, 64); key('sourceAta', 0, e.mint); key('sourceAta', 32, e.payer); bytes('sourceAta').fill(0, 72, 108); bytes('sourceAta').fill(0, 121, 129);
  bytes('poolAta').writeBigUInt64LE(0n, 64); key('poolAta', 0, e.mint); key('poolAta', 32, e.signer);
  for (const [offset, address] of [[41, e.mint], [74, e.signer], [106, e.ata], [138, e.payer], [202, e.payer], [234, e.routerPoolSigner]] as const) { key('pool', offset, address); }
  key('routerConfig', 146, e.linkMint);
  key('registry', 9, e.payer); key('registry', 73, e.alt); key('registry', 137, e.mint);
  Buffer.from(fixture.pool.slice(2), 'hex').copy(bytes('chain'), 16); Buffer.from(fixture.token.slice(2).padStart(64, '0'), 'hex').copy(bytes('chain'), 40);
  key('alt', 22, e.payer); altAddresses(e).forEach((address, index) => key('alt', 56 + index * 32, address)); bytes('alt').writeBigUInt64LE(1n, 12);
  const result = Object.fromEntries(Object.entries(state).map(([name, data]) => [name, { data: [data.toString('base64'), 'base64'] as [string, 'base64'], owner: (() => { const captured = golden.facts.state[name]; assert.ok(captured); return captured.owner; })(), executable: false as const, lamports: 1000000 }]));
  const global = Buffer.alloc(74); createHash('sha256').update('account:PoolConfig').digest().copy(global, 0, 0, 8); global[8] = global[9] = 1;
  solanaPublicKeyBytes(ROUTER_PROGRAM).copy(global, 10); solanaPublicKeyBytes(REVERSE.rmn).copy(global, 42);
  result.global = { data: [global.toString('base64'), 'base64'], owner: BURNMINT_PROGRAM, executable: false, lamports: 1000000 };
  const raw = (name: string): RawAccount => { const value = result[name]; assert.ok(value); return value; };
  return { mint: raw('mint'), sourceAta: raw('sourceAta'), poolAta: raw('poolAta'), pool: raw('pool'),
    routerConfig: raw('routerConfig'), registry: raw('registry'), chain: raw('chain'), alt: raw('alt'), global: raw('global') };
}
// Catches stale peers or ALT authority that a correctly encoded send cannot detect.
test('replacement readiness verifies captured raw state, reciprocal peers, mint/pool authority and active ALT contents', { skip: !codecDirectory }, async () => {
  const provider = codecs(), { e, pool, config } = setup(provider), records = await replacementState(e);
  const state = createReverseState(provider, pool, fixture);
  const addresses: Record<string, string> = { [e.mint]: 'mint', [e.sourceAta]: 'sourceAta', [e.pool]: 'pool', [e.ata]: 'poolAta',
    [e.registry]: 'registry', [e.chain]: 'chain', [e.alt]: 'alt', [e.routerConfig]: 'routerConfig', [POOL_GLOBAL]: 'global' };
  const rpc = async (_method: string, params: unknown[]) => ({ context: { slot: 100 }, value: (params[0] as string[]).map(address => {
    if (address === e.payer) { return { owner: SYSTEM_PROGRAM, executable: false, lamports: 1000000 }; }
    const name = addresses[address]; assert.ok(name && Object.hasOwn(records, name));
    return Reflect.get(records, name);
  }) });
  assert.equal(await state.config(rpc, e.routerConfig), e.linkMint);
  assert.equal((await state.before(rpc, e, '1000000')).approval, true);
  // Setup uses zero SPL issuance until a verified forward message; reuse the same state verifier.
  const zeroMint = structuredClone(records.mint), mintBytes = Buffer.from(zeroMint.data[0], 'base64'); mintBytes.writeBigUInt64LE(0n, 36); zeroMint.data[0] = mintBytes.toString('base64');
  config.verifySnapshot([zeroMint, records.pool, records.poolAta, records.registry, records.global, records.routerConfig, records.chain, records.alt], e, 'after', 100, 99);
  for (const [name, offset] of [['chain', 16], ['chain', 40], ['mint', 4], ['pool', 138], ['registry', 9], ['alt', 22], ['alt', 56 + 7 * 32]] as const) {
    const original = records[name].data[0], changed = Buffer.from(original, 'base64'); const byte = changed[offset]; assert.ok(byte !== undefined); changed[offset] = byte ^ 1; records[name].data[0] = changed.toString('base64');
    await assert.rejects(state.before(rpc, e, '1000000'));
    records[name].data[0] = original;
  }
  for (const ceiling of ['100000001', '0']) { assert.throws(() => reverseInstructions({ ...e, quotedFee: ceiling })); }
  assert.throws(() => reverseInstructions({ ...e, sourceLamports: '10000000001' }));
  assert.equal(ALT_PROGRAM, records.alt.owner); assert.equal(Buffer.from(records.routerConfig.data[0], 'base64').subarray(82, 114).toString('hex'), solanaPublicKeyBytes(FEE_QUOTER_PROGRAM).toString('hex'));
  assert.equal(records.mint.owner, SPL_TOKEN_PROGRAM);
});

// Catches status/effect adapters that still identify the old token, pool, payer or recipient.
test('replacement status matches both lanes and native ERC20/SPL effects while rejecting the historical lane', { skip: !codecDirectory }, async () => {
  const provider = codecs(), { e } = setup(provider), transactionHash = '0x' + 'ab'.repeat(32);
  for (const forward of [true, false]) {
    const source = forward ? 16015286601757825753n : 16423721717087811551n, dest = forward ? 16423721717087811551n : 16015286601757825753n;
    const request: StatusRequest = { tx: { hash: transactionHash },
      log: { transactionHash, index: 0, address: forward ? FORWARD.router : ROUTER_PROGRAM, data: '0x', topics: [] },
      lane: { sourceChainSelector: source, destChainSelector: dest, onRamp: forward ? FORWARD.router : ROUTER_PROGRAM },
      message: { sourceChainSelector: source, destChainSelector: dest, sender: forward ? fixture.administrator : fixture.payer,
        receiver: forward ? SYSTEM_PROGRAM : fixture.administrator, tokenReceiver: fixture.payer, sequenceNumber: 1n, data: '0x', messageId: '0x' + 'cd'.repeat(32),
        tokenAmounts: [{ amount: 1000000000n, sourcePoolAddress: forward ? fixture.pool : fixture.solanaPool, destTokenAddress: forward ? fixture.mint : fixture.token }] } };
    const direction = forward ? 'ethereum-to-solana' : 'solana-to-ethereum';
    assert.equal(matchRequest(request, direction, transactionHash, undefined, fixture), true);
    const tokenAmount = request.message.tokenAmounts[0]; assert.ok(tokenAmount);
    assert.equal(matchRequest({ ...request, message: { ...request.message, tokenAmounts: [{ ...tokenAmount, sourcePoolAddress: FORWARD.pool }] } }, direction, transactionHash, undefined, fixture), false);
    assert.equal(matchRequest(request, direction, transactionHash), false);
    assert.equal(matchRequest({ ...request, message: { ...request.message, receiver: FORWARD.administrator } }, direction, transactionHash, undefined, fixture), false);
    const log = { address: fixture.token, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      topic(forward ? fixture.administrator : fixture.pool), topic(forward ? fixture.pool : fixture.administrator)], data: '0x' + (1000000000n).toString(16).padStart(64, '0'), logIndex: '0x0' };
    assert.equal(evmEffect({ logs: [log] }, forward ? 'lock' : 'release', fixture), 0);
    assert.throws(() => evmEffect({ logs: [log] }, forward ? 'lock' : 'release'));
  }
  const captured = await readFile(new URL('./fixtures/reverse-native-burn.json', import.meta.url), 'utf8');
  const old = setup(provider, false).e;
  let rebound = captured;
  for (const [before, after] of [[REVERSE.payer, e.payer], [REVERSE.mint, e.mint], [old.sourceAta, e.sourceAta], [old.ata, e.ata], [old.signer, e.signer]] as const) { rebound = rebound.replaceAll(before, after); }
  // SYNTHETIC ownership unit: the historical projection omits logs and pool CPI frames.
  // Complete this in-memory test input only; these additions are not native capture evidence.
  const tx = JSON.parse(rebound).tx;
  const lane: NativeStatusLane = { fixture, recipientAtas: { [fixture.payer]: e.sourceAta },
    solanaPoolAta: e.ata, solanaSigner: e.signer, solanaSpender: e.spender };
  const inner: ParsedInstruction[] = tx.meta.innerInstructions[0].instructions;
  const transfer = inner[0], burn = inner[1]; assert.ok(transfer && burn);
  transfer.stackHeight = 2; burn.stackHeight = 3;
  inner.splice(1, 0, { programId: BURNMINT_PROGRAM, stackHeight: 2 });
  // Marker only: the helper consumes assumed event metadata; no official SDK decode is claimed.
  const event: InvocationLog = { transactionHash: 'synthetic-codec-burn', index: 9, address: ROUTER_PROGRAM,
    type: 'data', level: 1, data: 'AA==', topics: [] };
  tx.meta.logMessages = [
    'Program ' + SPL_TOKEN_PROGRAM + ' invoke [1]', 'Program ' + SPL_TOKEN_PROGRAM + ' success',
    'Program ' + ROUTER_PROGRAM + ' invoke [1]',
    'Program ' + SPL_TOKEN_PROGRAM + ' invoke [2]', 'Program ' + SPL_TOKEN_PROGRAM + ' success',
    'Program ' + BURNMINT_PROGRAM + ' invoke [2]',
    'Program ' + SPL_TOKEN_PROGRAM + ' invoke [3]', 'Program ' + SPL_TOKEN_PROGRAM + ' success',
    'Program ' + BURNMINT_PROGRAM + ' success', 'Program data: ' + event.data,
    'Program ' + ROUTER_PROGRAM + ' success',
  ];
  assert.throws(() => solanaEffect(tx, 'burn', fixture.payer, e.sourceAta, lane), /Missing authenticated Solana invocation event/);
  assert.equal(authenticatedSolanaEffect(tx, 'burn', fixture.payer, e.sourceAta, { lane, event }), 4);
  assert.throws(() => authenticatedSolanaEffect(tx, 'burn', FORWARD.recipient, e.sourceAta, { lane, event }));
  tx.meta.postTokenBalances[0].uiTokenAmount.amount = '1';
  assert.throws(() => authenticatedSolanaEffect(tx, 'burn', fixture.payer, e.sourceAta, { lane, event }));
});

// Explicitly separates codec evidence from authenticated loader admission; no test loads keys or sends RPC.
test('replacement pinned SDK loaders fail closed on a codec-only installation', { skip: !codecDirectory }, async () => {
  assert.ok(codecDirectory);
  await assert.rejects(loadSolanaProvider(codecDirectory), /provider pin mismatch/);
  await assert.rejects(createSolanaReverseSdk({ ...selection, journalFile: join(root, 'reverse'), providerDirectory: codecDirectory,
    ccipProviderDirectory: codecDirectory, recentSlot: '1' }), /provider pin mismatch/);
});
