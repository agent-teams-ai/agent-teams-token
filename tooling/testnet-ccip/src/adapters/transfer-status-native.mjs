import { createHash } from 'node:crypto';
import { ROUTER_PROGRAM } from '../domain/solana-registration.ts';
import { createSepoliaRpc } from './evm-rpc.ts';
import { FORWARD, forwardRecipient } from '../domain/evm-forward.mjs';
import { REVERSE } from '../domain/solana-reverse.mjs';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topic = address => '0x' + address.slice(2).padStart(64, '0');
export function jsonRpc(endpoint, fetcher = fetch) {
  let id = 0;
  const url = new URL(endpoint);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {throw new Error('Invalid RPC URL');}
  return async (method, params) => {
    const requestId = ++id;
    const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.timeout(20_000), redirect: 'error' });
    const body = await response.json();
    if (!response.ok || body.id !== requestId || body.jsonrpc !== '2.0' || body.error || !('result' in body)) {throw new Error('Invalid native RPC response');}
    return body.result;
  };
}
export function evmEffect(receipt, kind) {
  const from = kind === 'lock' ? FORWARD.administrator : FORWARD.pool;
  const to = kind === 'lock' ? FORWARD.pool : FORWARD.administrator;
  const logs = receipt.logs.filter(log => log.address.toLowerCase() === FORWARD.token &&
    log.topics?.length === 3 && log.topics[0].toLowerCase() === TRANSFER &&
    log.topics[1].toLowerCase() === topic(from) && log.topics[2].toLowerCase() === topic(to) &&
    BigInt(log.data) === FORWARD.amount && !log.removed);
  if (logs.length !== 1) {throw new Error('Exact unique ERC20 effect missing');}
  return Number(BigInt(logs[0].logIndex));
}
/** Parsed instructions are native RPC decoding of actual transaction bytes, not CCIP metadata. */
export function solanaEffect(tx, kind, recipient = FORWARD.recipient, expectedAta) {
  const owner = forwardRecipient(recipient);
  if (kind === 'burn' && owner !== FORWARD.recipient) { throw new Error('B reverse is not supported'); }
  const instructions = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap(group => group.instructions)];
  const matches = instructions.map((ix, index) => ({ ix, index })).filter(({ ix }) => {
    const parsed = ix.parsed, info = parsed?.info;
    return ix.programId === TOKEN && (kind === 'mint' ? ['mintTo', 'mintToChecked'] : ['burn', 'burnChecked']).includes(parsed?.type) &&
      info.mint === REVERSE.mint && BigInt(info.amount ?? info.tokenAmount?.amount ?? -1) === REVERSE.amount;
  });
  if (matches.length !== 1) {throw new Error('Exact unique SPL mint/burn instruction missing');}
  const { ix, index } = matches[0], account = ix.parsed.info.account;
  if (expectedAta !== undefined && account !== expectedAta) { throw new Error('Wrong canonical recipient ATA'); }
  const keys = tx.transaction.message.accountKeys.map(key => typeof key === 'string' ? key : key.pubkey);
  const accountIndex = keys.indexOf(account);
  const balance = values => values.filter(value => value.accountIndex === accountIndex && value.mint === REVERSE.mint && value.owner === owner && value.programId === TOKEN);
  const before = balance(tx.meta.preTokenBalances ?? []), after = balance(tx.meta.postTokenBalances ?? []);
  if (accountIndex < 0 || after.length !== 1 || before.length > 1 || (kind === 'burn' && before.length !== 1)) {throw new Error('Missing exact SPL account ownership');}
  const delta = BigInt(after[0].uiTokenAmount.amount) - BigInt(before[0]?.uiTokenAmount.amount ?? 0);
  if (delta !== (kind === 'mint' ? REVERSE.amount : -REVERSE.amount)) {throw new Error('SPL token effect does not reconcile');}
  return index;
}
function verifyMint(mintAccount, mint, lane) {
      if (mintAccount?.value?.owner !== TOKEN || mint?.type !== 'mint' || mint.info.decimals !== 9 || mint.info.isInitialized !== true || mint.info.freezeAuthority !== null || !lane.solanaSigner || mint.info.mintAuthority !== lane.solanaSigner) {throw new Error('Unexpected mint identity/state');}
}
export function createNativeStatus(sepolia, solana, lane = {}, fetcher = fetch) {
  const evm = jsonRpc(sepolia, fetcher), svm = jsonRpc(solana, fetcher), observer = createSepoliaRpc(sepolia, fetcher);
  return {
    lane,
    async authorizeOffRamp(chain, offRamp, selector) {
      if (chain === 'ethereum') {
        const result = await evm('eth_call', [{ to: FORWARD.router, data: lane.isOffRampData(selector, offRamp) }, 'finalized']);
        if (BigInt(result) !== 1n) { throw new Error('Unauthorized EVM offRamp'); }
      } else {
        const address = lane.allowedOffRamp(selector, offRamp);
        const marker = await svm('getAccountInfo', [address, { commitment: 'finalized', encoding: 'base64' }]);
        const program = await svm('getAccountInfo', [offRamp, { commitment: 'finalized', encoding: 'base64' }]);
        const bytes = Buffer.from(marker?.value?.data?.[0] ?? '', 'base64');
        if (marker?.value?.owner !== ROUTER_PROGRAM || marker.value.executable !== false ||
          !bytes.equals(createHash('sha256').update('account:AllowedOfframp').digest().subarray(0, 8)) || program?.value?.executable !== true) { throw new Error('Unauthorized Solana offRamp'); }
      }
    },
    async ethereum(hash, kind) {
      const observation = await observer.observe(hash);
      if (!observation.finalizedBlock || observation.receipt?.status !== 1) {throw new Error('Ethereum transaction not successful finalized');}
      const receipt = await evm('eth_getTransactionReceipt', [hash]);
      if (receipt.blockHash !== observation.receipt.blockHash || receipt.transactionHash !== hash || BigInt(receipt.status) !== 1n) {throw new Error('Receipt changed');}
      return { transaction: observation.transaction, logs: receipt.logs, eventIndex: evmEffect(receipt, kind), blockHash: receipt.blockHash, blockHeight: BigInt(receipt.blockNumber) };
    },
    async solana(hash, kind, recipient = FORWARD.recipient) {
      if (await svm('getGenesisHash', []) !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') {throw new Error('Wrong Solana cluster');}
      const tx = await svm('getTransaction', [hash, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      const statuses = await svm('getSignatureStatuses', [[hash], { searchTransactionHistory: true }]);
      const status = statuses?.value?.[0];
      if (!tx || tx.meta?.err !== null || status?.err !== null || status?.confirmationStatus !== 'finalized' || status.slot !== tx.slot || tx.transaction.signatures[0] !== hash) {throw new Error('Solana transaction not successful finalized');}
      const block = await svm('getBlock', [tx.slot, { commitment: 'finalized', transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0 }]);
      if (!block?.signatures?.includes(hash)) {throw new Error('Solana canonical block does not contain transaction');}
      return { transaction: tx.transaction, programLogs: tx.meta.logMessages, eventIndex: solanaEffect(tx, kind, recipient, lane.recipientAtas?.[recipient]), blockHash: block.blockhash, blockHeight: BigInt(tx.slot) };
    },
    async snapshot() {
      if (BigInt(await evm('eth_chainId', [])) !== 11155111n || await svm('getGenesisHash', []) !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') {throw new Error('Wrong accounting chains');}
      const block = await evm('eth_getBlockByNumber', ['finalized', false]);
      const slot = await svm('getSlot', [{ commitment: 'finalized' }]);
      const call = data => evm('eth_call', [{ to: FORWARD.token, data }, { blockHash: block.hash, requireCanonical: true }]);
      const total = BigInt(await call('0x18160ddd'));
      const locked = BigInt(await call('0x70a08231' + FORWARD.pool.slice(2).padStart(64, '0')));
      const mintAccount = await svm('getAccountInfo', [REVERSE.mint, { commitment: 'finalized', encoding: 'jsonParsed', minContextSlot: slot }]);
      const mint = mintAccount?.value?.data?.parsed;
      verifyMint(mintAccount, mint, lane);
      const supply = await svm('getTokenSupply', [REVERSE.mint, { commitment: 'finalized', minContextSlot: slot }]);
      const end = await evm('eth_getBlockByNumber', [block.number, false]);
      const endSupply = await svm('getTokenSupply', [REVERSE.mint, { commitment: 'finalized', minContextSlot: supply.context.slot }]);
      if (total !== 100_000_000_000n || supply.value.decimals !== 9) {throw new Error('Immutable supply/decimals mismatch');}
      return { fixedSupply: total, lockedOnEthereum: locked, supplyOnSolana: BigInt(supply.value.amount),
        ethereumBlock: block.hash, ethereumHeight: BigInt(block.number), solanaSlot: supply.context.slot, coherent: end.hash === block.hash && supply.context.slot >= slot && endSupply.context.slot >= supply.context.slot && endSupply.value.amount === supply.value.amount, observedAt: new Date().toISOString() };
    },
  };
}
