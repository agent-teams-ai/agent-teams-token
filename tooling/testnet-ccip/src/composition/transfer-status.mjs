import { format } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeStatus } from '../adapters/transfer-status-native.mjs';
import { ROUTER_PROGRAM } from '../domain/solana-registration.ts';
import { BURNMINT_PROGRAM } from '../domain/solana-pool-init.ts';
import { FORWARD, FORWARD_RECIPIENT_B, FORWARD_RECIPIENT_B_ATA } from '../domain/evm-forward.mjs';
import { REVERSE } from '../domain/solana-reverse.mjs';
import { inspectTransfer, accountTransfers, validateStatusTransfers } from '../domain/transfer-status.mjs';
/** SDK 1.13.0 ChainContext/WithLogger; stdout belongs exclusively to report JSON. */
export function statusLogger(write = text => process.stderr.write(text)) {
  const log = (...args) => { write(format(...args) + '\n'); };
  return { debug: log, info: log, warn: log, error: log };
}
/** SDK 1.13.0 compares EVM log addresses strictly; keep normalization at this boundary. */
export function evmStatusChain(chain, getAddress) {
  return {
    getMessagesInTx: (...args) => chain.getMessagesInTx(...args),
    getExecutionReceiptInTx: (hash, filters) => chain.getExecutionReceiptInTx(hash,
      { ...filters, offRamp: getAddress(filters.offRamp) }),
    destroy: () => chain.destroy(),
  };
}
/** One-shot read-only CLI. Input contains public hashes and endpoints only. */
const stringify = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
export async function runStatus(settings) {
  if (settings.testOnly !== true) {throw new Error('Bounded fixed test-fixture input required');}
  validateStatusTransfers(settings.transfers);
  const directory = settings.sdkDirectory;
  for (const [file, hash] of Object.entries({ 'package.json': '8cf7da517123c8be46f0a5fa14ef67904bf45bf4cfb972fc2c54be4b91cb56fb',
    'package-lock.json': '1477c1d04940f9556ff87eaf82de6f0f2eaa6f3585deea0f09bfdab8fba7f50f' })) {
    if (createHash('sha256').update(await readFile(resolve(directory, file))).digest('hex') !== hash) {throw new Error('Unreviewed SDK installation');}
  }
  const require = createRequire(resolve(directory, 'package.json'));
  const entry = require.resolve('@chainlink/ccip-sdk');
  const sdk = await import(pathToFileURL(entry).href);
  const sdkRequire = createRequire(entry);
  const { PublicKey } = await import(pathToFileURL(sdkRequire.resolve('@solana/web3.js')).href);
  const { getAssociatedTokenAddressSync } = await import(pathToFileURL(sdkRequire.resolve('@solana/spl-token')).href);
  const recipientAtas = Object.fromEntries([FORWARD.recipient, FORWARD_RECIPIENT_B].map(recipient => [recipient, getAssociatedTokenAddressSync(new PublicKey(REVERSE.mint), new PublicKey(recipient)).toBase58()]));
  if (recipientAtas[FORWARD_RECIPIENT_B] !== FORWARD_RECIPIENT_B_ATA) { throw new Error('Wrong independently derived B ATA'); }
  const derive = seed => PublicKey.findProgramAddressSync([Buffer.from(seed), new PublicKey(REVERSE.mint).toBuffer()], new PublicKey(BURNMINT_PROGRAM))[0].toBase58();
  const solanaSigner = derive('ccip_tokenpool_signer');
  const solanaPoolAta = getAssociatedTokenAddressSync(new PublicKey(REVERSE.mint), new PublicKey(solanaSigner), true).toBase58();
  const solanaSpender = PublicKey.findProgramAddressSync([Buffer.from('fee_billing_signer')], new PublicKey(ROUTER_PROGRAM))[0].toBase58();
  const { Interface, getAddress } = await import(pathToFileURL(sdkRequire.resolve('ethers')).href);
  const routerAbi = new Interface(['function isOffRamp(uint64,address) view returns(bool)']);
  const lane = { recipientAtas, solanaPoolAta, solanaSpender, allowedOffRamp: (selector, offRamp) => { const value = Buffer.alloc(8); value.writeBigUInt64LE(selector); return PublicKey.findProgramAddressSync([Buffer.from('allowed_offramp'), value, new PublicKey(offRamp).toBuffer()], new PublicKey(ROUTER_PROGRAM))[0].toBase58(); },
    isOffRampData: (selector, offRamp) => routerAbi.encodeFunctionData('isOffRamp', [selector, offRamp]), solanaPool: derive('ccip_tokenpool_config'), solanaSigner };
  const sepolia = settings.sepoliaRpc ?? 'https://ethereum-sepolia-rpc.publicnode.com';
  const solana = settings.solanaRpc ?? 'https://api.devnet.solana.com';
  const native = createNativeStatus(sepolia, solana, lane), chains = {};
  try {
    const logger = statusLogger();
    // fromUrl caches API clients by URL without logger context. Own this client explicitly.
    const api = new sdk.CCIPAPIClient(undefined, { logger });
    const context = { logger, apiClient: api };
    chains.ethereum = evmStatusChain(await sdk.EVMChain.fromUrl(sepolia, context), getAddress);
    chains.solana = await sdk.SolanaChain.fromUrl(solana, context);
    const inspect = async () => {
      const results = [];
      for (const transfer of settings.transfers) {
        try { results.push(await inspectTransfer(transfer, chains, native, api, sdk.ExecutionState.Success)); }
        catch { results.push({ ...transfer, status: 'unknown', pendingAmount: null, reason: 'Source finalized message/token identity unproven' }); }
      }
      return results;
    };
    const before = await inspect();
    const snapshot = await native.snapshot();
    const after = await inspect();
    snapshot.coherent &&= stringify(before) === stringify(after);
    return { transfers: after, accounting: accountTransfers(after, snapshot, settings.completeFixtureInventory === true), readOnly: true };
  } finally { await Promise.all(Object.values(chains).map(chain => chain.destroy())); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) {throw new Error('Usage: node transfer-status.mjs public-settings.json');}
    const result = await runStatus(JSON.parse(await readFile(process.argv[2], 'utf8')));
    process.stdout.write(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    if (result.accounting.status !== 'exact') {process.exitCode = 2;}
  } catch (error) { process.stderr.write(`Transfer status unavailable: ${error.message}\n`); process.exitCode = 1; }
}
