// @ts-check
import { selectedFixture } from '../domain/replacement-fixture.ts';
import { selectTestSdk, TEST_SDK_PROFILE } from '../adapters/test-sdk-policy.ts';
import { createTestSdkStatus, statusChainView } from '../adapters/test-sdk-status.ts';
import { bindFixture } from '../adapters/fixture-binding.ts';
import { selectSepoliaRpc, selectSolanaRpc, createSdkTestFetch } from '../adapters/test-rpc.ts';
import { format } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeStatus, refreshSnapshotFreshness } from '../adapters/transfer-status-native.mjs';
import { ROUTER_PROGRAM } from '../domain/solana-registration.ts';
import { BURNMINT_PROGRAM } from '../domain/solana-pool-init.ts';
import { forwardRoute, FORWARD_RECIPIENT_B, FORWARD_RECIPIENT_B_ATA } from '../domain/evm-forward.mjs';
import { reverseRoute } from '../domain/solana-reverse.mjs';
import { inspectTransfer, accountTransfers, validateStatusTransfers } from '../domain/transfer-status.mjs';
/** @typedef {import('../domain/transfer-status.mjs').StatusTransferReport} StatusTransferReport */
/** @typedef {import('../domain/transfer-status.mjs').StatusTransferInput} StatusTransferInput */
/** @typedef {import('../adapters/test-sdk-policy.ts').TestSdkSelection & {testOnly: boolean,
 * sdkDirectory: string, sepoliaRpc?: string, solanaRpc?: string,
 * transfers: readonly StatusTransferInput[], completeFixtureInventory?: boolean,
 * replayWait?: import('../adapters/transfer-status-native.mjs').StatusWait}} StatusSettings */
/** SDK 1.13.0 ChainContext/WithLogger; stdout belongs exclusively to report JSON. */
/** @param {(text: string) => unknown} [write] @returns {import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/types.js').Logger} */
export function statusLogger(write = text => process.stderr.write(text)) {
  /** @param {unknown[]} args */
  const log = (...args) => { write(format(...args) + '\n'); };
  return { debug: log, info: log, warn: log, error: log };
}
/** SDK 1.13.0 compares EVM log addresses strictly; keep normalization at this boundary. */
/** @template T @param {import('../domain/transfer-status.mjs').StatusChainPort & {destroy: () => T}} chain @param {(address: string) => string} getAddress */
export function evmStatusChain(chain, getAddress) {
  /** @type {import('../domain/transfer-status.mjs').StatusChainPort & {destroy: () => T}} */
  const view = {
    getMessagesInTx: hash => chain.getMessagesInTx(hash),
    getExecutionReceiptInTx: (hash, filters) => chain.getExecutionReceiptInTx(hash,
      { ...filters, offRamp: getAddress(filters.offRamp) }),
    destroy: () => chain.destroy(),
  };
  return view;
}
/** One-shot read-only CLI. Input contains public hashes and endpoints only. */
/** @param {unknown} value */
const stringify = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
/** @param {() => Promise<{ transfers: readonly import('../domain/transfer-status.mjs').StatusTransferReport[], snapshot: import('../domain/transfer-status.mjs').StatusSnapshot }>} collect
 * @param {() => Promise<unknown>} cleanup @param {boolean} completeInventory
 * @param {() => number} [now=Date.now] @param {import('../domain/replacement-fixture.ts').ReplacementFixture} [fixture] */
export async function finalizeStatusReport(collect, cleanup, completeInventory, now = Date.now, fixture) {
  let transfers, snapshot;
  try { ({ transfers, snapshot } = await collect()); }
  finally { await cleanup(); }
  // No asynchronous work may follow the final age check on this response path.
  const current = refreshSnapshotFreshness(snapshot, now());
  return { transfers, accounting: accountTransfers(transfers, current, completeInventory, fixture), readOnly: true };
}
/** @param {StatusSettings} settings @param {() => number} [now=Date.now] */
export async function runStatus(settings, now = Date.now) {
  const fixture = selectedFixture(settings);
  const selection = selectTestSdk(settings, settings.sdkDirectory, fixture);
  if (selection) { validateStatusTransfers(settings.transfers, fixture); }
  if (selection && typeof settings.replayFetch !== 'function') { throw new Error('Explicit TEST status replay fetch required'); }
  const sepolia = selectSepoliaRpc(settings), solana = selectSolanaRpc(settings);
  if (settings.testOnly !== true) {throw new Error('Bounded fixed test-fixture input required');}
  if (!selection) { validateStatusTransfers(settings.transfers, fixture); }
  bindFixture(settings);
  if (selection) {
    const fetcher = settings.replayFetch;
    if (!fetcher) { throw new Error('Explicit TEST status replay fetch required'); }
    /** @type {import('../adapters/test-sdk-policy.ts').ExplicitTestSdkSelection} */
    const explicit = { providerProfile: TEST_SDK_PROFILE, testOnly: true, fixture: selection.fixture,
      fixtureIdentity: selection.fixture.identity, providerArchives: selection.archives };
    const ports = await createTestSdkStatus({ directory: settings.sdkDirectory, selection: explicit, sepolia, solana,
      fetcher, now, logger: statusLogger(), ...(settings.replayWait ? { wait: settings.replayWait } : {}) });
    return finalizeStatusReport(() => collectStatus(settings.transfers, ports), ports.destroy, settings.completeFixtureInventory === true, now, fixture);
  }
  const route = forwardRoute(fixture), reverse = reverseRoute(fixture);
  const directory = settings.sdkDirectory;
  for (const [file, hash] of Object.entries({ 'package.json': '8cf7da517123c8be46f0a5fa14ef67904bf45bf4cfb972fc2c54be4b91cb56fb',
    'package-lock.json': '1477c1d04940f9556ff87eaf82de6f0f2eaa6f3585deea0f09bfdab8fba7f50f' })) {
    if (createHash('sha256').update(await readFile(resolve(directory, file))).digest('hex') !== hash) {throw new Error('Unreviewed SDK installation');}
  }
  const require = createRequire(resolve(directory, 'package.json'));
  const entry = require.resolve('@chainlink/ccip-sdk');
  /** @type {typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/index.js')} */
  const sdk = await import(pathToFileURL(entry).href);
  const sdkRequire = createRequire(entry);
  /** @type {typeof import('../../../../.local/INPUT/provider/node_modules/@solana/web3.js/lib/index.js')} */
  const { PublicKey } = await import(pathToFileURL(sdkRequire.resolve('@solana/web3.js')).href);
  /** @type {typeof import('../../../../.local/INPUT/provider/node_modules/@solana/spl-token/lib/types/index.js')} */
  const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import(pathToFileURL(sdkRequire.resolve('@solana/spl-token')).href);
  const recipientAtas = Object.fromEntries([route.recipient, FORWARD_RECIPIENT_B].map(recipient => [recipient,
    getAssociatedTokenAddressSync(new PublicKey(reverse.mint), new PublicKey(recipient), false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()]));
  if (!fixture && recipientAtas[FORWARD_RECIPIENT_B] !== FORWARD_RECIPIENT_B_ATA) { throw new Error('Wrong independently derived B ATA'); }
  /** @param {string} seed */
  const derive = seed => PublicKey.findProgramAddressSync([Buffer.from(seed), new PublicKey(reverse.mint).toBuffer()], new PublicKey(BURNMINT_PROGRAM))[0].toBase58();
  const solanaSigner = derive('ccip_tokenpool_signer');
  const solanaPoolAta = getAssociatedTokenAddressSync(new PublicKey(reverse.mint), new PublicKey(solanaSigner), true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58();
  const solanaSpender = PublicKey.findProgramAddressSync([Buffer.from('fee_billing_signer')], new PublicKey(ROUTER_PROGRAM))[0].toBase58();
  /** @type {typeof import('../../../../.local/INPUT/provider/node_modules/ethers/lib.esm/index.js')} */
  const { Interface, getAddress } = await import(pathToFileURL(sdkRequire.resolve('ethers')).href);
  const routerAbi = new Interface(['function isOffRamp(uint64,address) view returns(bool)']);
  /** @type {import('../adapters/transfer-status-native.mjs').NativeStatusLane} */
  const lane = { ...(fixture ? { fixture } : {}), recipientAtas, solanaPoolAta, solanaSpender, allowedOffRamp: (selector, offRamp) => { const value = Buffer.alloc(8); value.writeBigUInt64LE(selector); return PublicKey.findProgramAddressSync([Buffer.from('allowed_offramp'), value, new PublicKey(offRamp).toBuffer()], new PublicKey(ROUTER_PROGRAM))[0].toBase58(); },
    isOffRampData: (selector, offRamp) => routerAbi.encodeFunctionData('isOffRamp', [selector, offRamp]), solanaPool: derive('ccip_tokenpool_config'), solanaSigner };
  const native = createNativeStatus(sepolia, solana, lane, fetch, now);
  /** @type {(import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/index.js').EVMChain | import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js').SolanaChain)[]} */
  const acquired = [];
  return finalizeStatusReport(async () => {
    const logger = statusLogger();
    // fromUrl caches API clients by URL without logger context. Own this client explicitly.
    const api = new sdk.CCIPAPIClient(undefined, { logger });
    const context = { logger, apiClient: api };
    const ethereum = await sdk.EVMChain.fromUrl(sepolia, { ...context, fetch: createSdkTestFetch(sepolia) });
    acquired.push(ethereum);
    const solanaChain = await sdk.SolanaChain.fromUrl(solana, { ...context, fetch: createSdkTestFetch(solana) });
    acquired.push(solanaChain);
    return collectStatus(settings.transfers, { chains: {
      ethereum: evmStatusChain({ ...statusChainView(ethereum, address => address), destroy: () => ethereum.destroy() }, getAddress),
      solana: statusChainView(solanaChain, address => address) }, native, api, successState: sdk.ExecutionState.Success });
  }, async () => {
    const released = await Promise.allSettled(acquired.map(chain => Promise.resolve().then(() => chain.destroy())));
    const errors = released.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) { throw new AggregateError(errors, 'Legacy status cleanup failed'); }
  }, settings.completeFixtureInventory === true, now, fixture);
}
/** @param {readonly StatusTransferInput[]} transfers @param {import('../adapters/test-sdk-status.ts').StatusPorts} ports */
async function collectStatus(transfers, ports) {
  const inspect = async () => {
    /** @type {StatusTransferReport[]} */
    const results = [];
    for (const transfer of transfers) {
      results.push(await inspectTransfer(transfer, ports.chains, ports.native, ports.api, ports.successState));
    }
    return results;
  };
  const before = await inspect(), snapshot = await ports.native.snapshot(), after = await inspect();
  snapshot.coherent &&= stringify(before) === stringify(after);
  return { transfers: after, snapshot };
}
/** @param {unknown} value @returns {value is StatusSettings} */
function isSettings(value) {
  if (!value || typeof value !== 'object' || !('testOnly' in value) || value.testOnly !== true || !('sdkDirectory' in value) || typeof value.sdkDirectory !== 'string' ||
      !('transfers' in value) || !Array.isArray(value.transfers)) { return false; }
  /** @type {readonly unknown[]} */
  const transfers = value.transfers;
  return transfers.every(transfer => transfer && typeof transfer === 'object' && 'sourceHash' in transfer && typeof transfer.sourceHash === 'string' &&
    'direction' in transfer && (transfer.direction === 'ethereum-to-solana' || transfer.direction === 'solana-to-ethereum'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) {throw new Error('Usage: node transfer-status.mjs public-settings.json');}
    const file = process.argv[2];
    if (!file) { throw new Error('Missing settings path'); }
    /** @type {unknown} */
    const input = JSON.parse(await readFile(file, 'utf8'));
    if (!isSettings(input)) { throw new Error('Invalid public status settings'); }
    const result = await runStatus(input);
    process.stdout.write(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    if (result.accounting.status !== 'exact') {process.exitCode = 2;}
  } catch (error) { process.stderr.write(`Transfer status unavailable: ${error instanceof Error ? error.message : 'Unknown error'}\n`); process.exitCode = 1; }
}
