import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FORWARD, boundedAllowance, forwardRecipient } from '../domain/evm-forward.mjs';
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const ZERO = '0x' + '00'.repeat(20);
const ABI = ['function approve(address spender,uint256 amount)',
  'function ccipSend(uint64 destinationChainSelector,(bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs) message) payable returns(bytes32)'];
/** Independent ABI authority, deliberately does not use SDK encoders or interfaces. */
export function createForwardDecoder(ethers, recipientValue) {
  const tokenReceiver = forwardRecipient(recipientValue);
  const iface = new ethers.Interface(ABI), coder = ethers.AbiCoder.defaultAbiCoder();
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let recipient = 0n;
  for (const char of tokenReceiver) { recipient = recipient * 58n + BigInt(alphabet.indexOf(char)); }
  const extra = '0x1f3b3aba' + coder.encode(['tuple(uint32,uint64,bool,bytes32,bytes32[])'],
    [[0n, 0n, true, '0x' + recipient.toString(16).padStart(64, '0'), []]]).slice(2);
  const expected = { approval: iface.encodeFunctionData('approve', [FORWARD.router, FORWARD.amount]),
    send: iface.encodeFunctionData('ccipSend', [FORWARD.selector,
      ['0x' + '00'.repeat(32), '0x', [[FORWARD.token, FORWARD.amount]], ZERO, extra]]) };
  return (tx, step, fee) => {
    const to = step === 'approval' ? FORWARD.token : FORWARD.router;
    if (!tx || Object.keys(tx).some(k => !['to','from','data','value'].includes(k)) ||
      tx.from?.toLowerCase() !== FORWARD.administrator || tx.to?.toLowerCase() !== to ||
      BigInt(tx.value ?? 0n) !== (step === 'approval' ? 0n : fee) ||
      typeof tx.data !== 'string' || tx.data.toLowerCase() !== expected[step]?.toLowerCase()) {
      throw new Error('Unexpected decoded forward operation');
    }
    const decoded = iface.parseTransaction({ data: tx.data, value: tx.value ?? 0n });
    if (decoded?.name !== (step === 'approval' ? 'approve' : 'ccipSend')) { throw new Error('Wrong operation selector'); }
    return tx;
  };
}
export async function createEvmForwardSdk(directory, recipientValue) {
  const recipient = forwardRecipient(recipientValue);
  const hashes = { 'package.json': '8cf7da517123c8be46f0a5fa14ef67904bf45bf4cfb972fc2c54be4b91cb56fb',
    'package-lock.json': '1477c1d04940f9556ff87eaf82de6f0f2eaa6f3585deea0f09bfdab8fba7f50f' };
  for (const [file, hash] of Object.entries(hashes)) {
    if (createHash('sha256').update(await readFile(resolve(directory, file))).digest('hex') !== hash) {
      throw new Error('Unreviewed CCIP provider installation');
    }
  }
  const require = createRequire(resolve(directory, 'package.json'));
  const sdkEntry = require.resolve('@chainlink/ccip-sdk');
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const sdkRequire = createRequire(sdkEntry);
  const ethers = await import(pathToFileURL(sdkRequire.resolve('ethers')).href);
  if (ethers.version !== '6.17.0') { throw new Error('Wrong independent ABI dependency version'); }
  const verify = createForwardDecoder(ethers, recipient);
  const rpc = new ethers.JsonRpcProvider(RPC);
  const chain = await sdk.EVMChain.fromUrl(RPC);
  const token = new ethers.Contract(FORWARD.token, ['function allowance(address,address) view returns(uint256)'], rpc);
  return { verify,
    async allowance() {
      if (BigInt(await rpc.send('eth_chainId', [])) !== 11155111n) { throw new Error('Wrong forward source chain'); }
      return boundedAllowance(await token.allowance(FORWARD.administrator, FORWARD.router));
    },
    async prepare() {
      if (BigInt(await rpc.send('eth_chainId', [])) !== 11155111n) { throw new Error('Wrong forward source chain'); }
      const opts = { sender: FORWARD.administrator, router: FORWARD.router, destChainSelector: FORWARD.selector,
        approveMax: false, message: { receiver: '11111111111111111111111111111111', data: '0x',
          tokenAmounts: [{ token: FORWARD.token, amount: FORWARD.amount }], feeToken: ZERO,
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
    async destroy() { await chain.destroy(); rpc.destroy(); },
  };
}
