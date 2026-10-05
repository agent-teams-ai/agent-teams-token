// @ts-check
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { forwardRoute, boundedAllowance, forwardRecipient } from '../domain/evm-forward.mjs';
import { selectSepoliaRpc, createSdkTestFetch } from './test-rpc.ts';
import { selectTestSdk, TEST_SDK_PROFILE } from './test-sdk-policy.ts';
import { createTestSdkForward } from './test-sdk-forward.ts';
const ZERO = '0x' + '00'.repeat(20);
const ABI = ['function approve(address spender,uint256 amount)',
  'function ccipSend(uint64 destinationChainSelector,(bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs) message) payable returns(bytes32)'];
/** @param {unknown} candidate */
function forwardTransactionRecord(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { throw new Error('Unexpected decoded forward operation'); }
  const tx = /** @type {Record<string, unknown>} */ (candidate), value = tx.value;
  if ((value !== undefined && typeof value !== 'string' && typeof value !== 'bigint' && typeof value !== 'number') ||
    typeof tx.from !== 'string' || typeof tx.to !== 'string') { throw new Error('Unexpected decoded forward operation'); }
  if (Object.keys(tx).some(k => !['to', 'from', 'data', 'value'].includes(k))) { throw new Error('Unexpected decoded forward operation'); }
  return { from: tx.from, to: tx.to, data: tx.data, value };
}
/** Independent ABI authority, deliberately does not use SDK encoders or interfaces.
 * @param {Pick<typeof import('../../../../.local/INPUT/provider/node_modules/ethers/lib.esm/abi/index.js'), 'Interface'|'AbiCoder'>} ethers
 * @param {string} [recipientValue]
 * @param {import('../domain/replacement-fixture.ts').ReplacementFixture} [fixture]
 * @returns {(tx: unknown, step: 'send'|'approval', fee: bigint) => unknown}
 */
export function createForwardDecoder(ethers, recipientValue, fixture) {
  const route = forwardRoute(fixture), tokenReceiver = forwardRecipient(recipientValue, fixture);
  const iface = new ethers.Interface(ABI), coder = ethers.AbiCoder.defaultAbiCoder();
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let recipient = 0n;
  for (const char of tokenReceiver) { recipient = recipient * 58n + BigInt(alphabet.indexOf(char)); }
  const extra = '0x1f3b3aba' + coder.encode(['tuple(uint32,uint64,bool,bytes32,bytes32[])'],
    [[0n, 0n, true, '0x' + recipient.toString(16).padStart(64, '0'), []]]).slice(2);
  const expected = { approval: iface.encodeFunctionData('approve', [route.router, route.amount]),
    send: iface.encodeFunctionData('ccipSend', [route.selector,
      ['0x' + '00'.repeat(32), '0x', [[route.token, route.amount]], ZERO, extra]]) };
  return (candidate, step, fee) => {
    const tx = forwardTransactionRecord(candidate), value = tx.value;
    const to = step === 'approval' ? route.token : route.router;
    if (tx.from.toLowerCase() !== route.administrator || tx.to.toLowerCase() !== to ||
      BigInt(value ?? 0n) !== (step === 'approval' ? 0n : fee) ||
      typeof tx.data !== 'string' || tx.data.toLowerCase() !== expected[step]?.toLowerCase()) {
      throw new Error('Unexpected decoded forward operation');
    }
    const decoded = iface.parseTransaction({ data: tx.data, value: value ?? 0n });
    if (decoded?.name !== (step === 'approval' ? 'approve' : 'ccipSend')) { throw new Error('Wrong operation selector'); }
    return candidate;
  };
}
/** Selection rejects synchronously before the first provider read.
 * @param {string} directory @param {string|undefined} recipientValue
 * @param {import('../domain/replacement-fixture.ts').ReplacementFixture|undefined} fixture
 * @param {string} endpoint
 * @param {import('./test-sdk-policy.ts').TestSdkForwardSelection} selection
 */
export function createEvmForwardSdk(directory, recipientValue, fixture, endpoint = selectSepoliaRpc({}), selection = {}) {
  const selected = selectTestSdk(selection, directory, fixture);
  if (selected) {
    const replayFetch = selection.replayFetch;
    if (!replayFetch) { throw new Error('Explicit TEST replay transport required'); }
    return createTestSdkForward({ directory, recipientValue, fixture: selected.fixture, endpoint, replayFetch, createDecoder: createForwardDecoder,
      selection: { providerProfile: TEST_SDK_PROFILE, testOnly: true, fixture: selected.fixture,
        fixtureIdentity: selected.fixture.identity, providerArchives: selected.archives } });
  }
  return legacyEvmForwardSdk(directory, recipientValue, fixture, endpoint);
}
/** @param {string} directory @param {string|undefined} recipientValue
 * @param {import('../domain/replacement-fixture.ts').ReplacementFixture|undefined} fixture @param {string} endpoint */
async function legacyEvmForwardSdk(directory, recipientValue, fixture, endpoint) {
  const rpcUrl = selectSepoliaRpc({ sepoliaRpc: endpoint });
  const route = forwardRoute(fixture), recipient = forwardRecipient(recipientValue, fixture);
  const hashes = { 'package.json': '8cf7da517123c8be46f0a5fa14ef67904bf45bf4cfb972fc2c54be4b91cb56fb',
    'package-lock.json': '1477c1d04940f9556ff87eaf82de6f0f2eaa6f3585deea0f09bfdab8fba7f50f' };
  for (const [file, hash] of Object.entries(hashes)) {
    if (createHash('sha256').update(await readFile(resolve(directory, file))).digest('hex') !== hash) {
      throw new Error('Unreviewed CCIP provider installation');
    }
  }
  const require = createRequire(resolve(directory, 'package.json'));
  const sdkEntry = require.resolve('@chainlink/ccip-sdk');
  /** @type {typeof import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/index.js')} */
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const sdkRequire = createRequire(sdkEntry);
  /** @type {typeof import('../../../../.local/INPUT/provider/node_modules/ethers/lib.esm/index.js')} */
  const ethers = await import(pathToFileURL(sdkRequire.resolve('ethers')).href);
  if (ethers.version !== '6.17.0') { throw new Error('Wrong independent ABI dependency version'); }
  const verify = createForwardDecoder(ethers, recipient, fixture);
  const chain = await sdk.EVMChain.fromUrl(rpcUrl, { fetch: createSdkTestFetch(rpcUrl) });
  const rpc = chain.provider;
  const token = new ethers.Contract(route.token, ['function allowance(address,address) view returns(uint256)'], rpc);
  return { verify,
    async allowance() {
      if (BigInt(await rpc.send('eth_chainId', [])) !== 11155111n) { throw new Error('Wrong forward source chain'); }
      return boundedAllowance(await token.getFunction('allowance')(route.administrator, route.router), route);
    },
    async prepare() {
      if (BigInt(await rpc.send('eth_chainId', [])) !== 11155111n) { throw new Error('Wrong forward source chain'); }
      /** @type {Parameters<import('../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/index.js').EVMChain['generateUnsignedSendMessage']>[0]} */
      const opts = { sender: route.administrator, router: route.router, destChainSelector: route.selector,
        approveMax: false, message: { receiver: '11111111111111111111111111111111', data: '0x',
          tokenAmounts: [{ token: route.token, amount: route.amount }], feeToken: ZERO,
          extraArgs: { computeUnits: 0n, accountIsWritableBitmap: 0n, allowOutOfOrderExecution: true,
            tokenReceiver: recipient, accounts: [] } } };
      const fee = await chain.getFee(opts);
      if (typeof fee !== 'bigint' || fee <= 0n || fee > 10000000000000000n) { throw new Error('Native fee outside testnet bound'); }
      const candidate = await chain.generateUnsignedSendMessage({ ...opts, message: { ...opts.message, fee } });
      if (candidate.family !== 'EVM' || ![1,2].includes(candidate.transactions.length)) { throw new Error('Unexpected SDK operations'); }
      const send = candidate.transactions.at(-1), approval = candidate.transactions.length === 2 ? candidate.transactions[0] : null;
      verify(send, 'send', fee);
      if (approval) { verify(approval, 'approval', 0n); }
      return { fee, send, approval };
    },
    async destroy() { await chain.destroy(); },
  };
}
