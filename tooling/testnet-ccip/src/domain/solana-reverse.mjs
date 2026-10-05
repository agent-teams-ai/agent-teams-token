import { validateReplacementFixture } from './replacement-fixture.ts';
import { createHash } from 'node:crypto';
import { ROUTER_PROGRAM } from './solana-registration.ts';
import { BURNMINT_PROGRAM } from './solana-pool-init.ts';
import { SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM, solanaPublicKeyBytes } from './solana-mint.ts';
import { SEPOLIA_SELECTOR, FEE_QUOTER_PROGRAM, altAddresses, u64 } from './solana-pool-config.ts';
export const REVERSE = Object.freeze({ payer: '8T13W72sSEKmBpEv1FpUM7nJRatnChEfPSjkbSpdUn9t',
  mint: '13Q74er9thh3my9oACjChDhtn4znJibWBp1u8q1rAYau',
  recipient: '0x275ee728c49100b56d4aa37c00e2dc8ffc5e5df6', amount: 1000000000n,
  rmn: 'RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7', nativeMint: 'So11111111111111111111111111111111111111112' });
export function reverseRoute(fixture) {
  if (fixture === undefined) { return REVERSE; }
  const f = validateReplacementFixture(fixture);
  return Object.freeze({ ...REVERSE, payer: f.payer, mint: f.mint, recipient: f.administrator,
    amount: BigInt(f.amount), selector: f.reverseSelector });
}
const expectedRoute = e => reverseRoute(e.fixture);
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const bytes = b => Buffer.concat([u32(b.length), b]);
const meta = (address, isWritable = false, isSigner = false) => ({ address, isWritable, isSigner });
const reverseSelector = route => {
  const selector = route.selector ?? SEPOLIA_SELECTOR;
  if ((typeof selector !== 'bigint' && (typeof selector !== 'string' || !/^[1-9][0-9]*$/.test(selector))) ||
      String(selector).length > 20 || BigInt(selector) !== BigInt(SEPOLIA_SELECTOR)) {
    throw new Error('Wrong selected reverse selector');
  }
  return selector;
};
function validateReverseRoute(route) {
  reverseSelector(route);
  if (route.rmn !== REVERSE.rmn || route.nativeMint !== REVERSE.nativeMint ||
      (typeof route.amount !== 'bigint' && (typeof route.amount !== 'string' || !/^[1-9][0-9]*$/.test(route.amount))) ||
      BigInt(route.amount) <= 0n || BigInt(route.amount) > (1n << 64n) - 1n ||
      typeof route.recipient !== 'string' || !/^0x[0-9a-f]{40}$/.test(route.recipient) || /^0x0{40}$/.test(route.recipient)) {
    throw new Error('Wrong selected reverse route');
  }
  solanaPublicKeyBytes(route.payer); solanaPublicKeyBytes(route.mint);
}
function validateReverseInputs(e, route) {
  const fixedFixture = route === REVERSE || e.fixture !== undefined;
  if (e.testOnly !== true || e.cluster !== 'solana-devnet' || e.payer !== route.payer || e.mint !== route.mint ||
    typeof e.approval !== 'boolean' || route !== REVERSE &&
    ([e.quotedFee, e.sourceLamports].some(n => typeof n !== 'bigint' && typeof n !== 'string' || String(n).length > 20)) ||
    !/^[1-9][0-9]*$/.test(e.quotedFee) || BigInt(e.quotedFee) > 100000000n || !/^[1-9][0-9]*$/.test(e.sourceLamports) || BigInt(e.sourceLamports) > (fixedFixture ? 10000000000n : (1n << 64n) - 1n)) {
    throw new Error('Wrong fixed reverse scope/quote');
  }
}
// Explicit DEV routes do not change historical default callers.
export function reverseInstructions(e, route = expectedRoute(e)) {
  validateReverseRoute(route); validateReverseInputs(e, route);
  if (e.fixture !== undefined) {
    const selected = expectedRoute(e), fixture = validateReplacementFixture(e.fixture);
    if (['payer', 'mint', 'recipient', 'amount'].some(k => String(route[k]) !== String(selected[k])) || e.pool !== fixture.solanaPool) {
      throw new Error('Conflicting replacement reverse route');
    }
  }
  const all = altAddresses(e);
  const accounts = [meta(e.routerConfig), meta(e.destChain, true), meta(e.nonce, true), meta(e.payer, true, true),
    meta(SYSTEM_PROGRAM), meta(SPL_TOKEN_PROGRAM), meta(route.nativeMint), meta(SYSTEM_PROGRAM, true),
    meta(e.feeReceiver, true), meta(e.spender), meta(FEE_QUOTER_PROGRAM), meta(e.feeConfig), meta(e.feeDest),
    meta(e.nativeFeeConfig), meta(e.linkFeeConfig), meta(route.rmn), meta(e.curses), meta(e.rmnConfig),
    meta(e.sourceAta, true), meta(e.perTokenConfig), meta(e.chain, true),
    ...all.map((a, i) => meta(a, [3, 4, 7].includes(i)))];
  const extra = Buffer.concat([Buffer.from('181dcf10', 'hex'), Buffer.alloc(16), Buffer.from([1])]);
  // CCIP EVM recipient is ABI32 inside a Borsh Vec; remote source pool stays raw20.
  const data = Buffer.concat([createHash('sha256').update('global:ccip_send').digest().subarray(0, 8),
    u64(SEPOLIA_SELECTOR), bytes(Buffer.from(route.recipient.slice(2).padStart(64, '0'), 'hex')), bytes(Buffer.alloc(0)),
    u32(1), solanaPublicKeyBytes(e.mint), u64(route.amount), solanaPublicKeyBytes(SYSTEM_PROGRAM), bytes(extra), bytes(Buffer.from([0]))]);
  const send = { programId: ROUTER_PROGRAM, accounts, dataBase64: data.toString('base64') };
  const approval = { programId: SPL_TOKEN_PROGRAM,
    accounts: [meta(e.sourceAta, true), meta(e.spender), meta(e.payer, false, true)],
    dataBase64: Buffer.concat([Buffer.from([4]), u64(route.amount)]).toString('base64') };
  return e.approval ? [approval, send] : [send];
}
export function verifyReverseIntent(intent, expected) {
  const route = expectedRoute(expected), instructions = reverseInstructions(expected, route);
  if (intent.feePayer !== route.payer || JSON.stringify(intent.instructions) !== JSON.stringify(instructions)) {
    throw new Error('Unexpected reverse instruction, account privilege or payload');
  }
  return { ...expected, schema: 'agtmai-solana-reverse-v1', instructions };
}
export function reverseContract(expected) {
  return { schema: 'agtmai-solana-reverse-journal-v1', label: 'Solana reverse', successReason: 'finalized-source-receipt-only',
    verify: (intent, e) => verifyReverseIntent(intent, e),
    canonical: (intent, e) => {
      const verified = verifyReverseIntent({ feePayer: intent.payer, instructions: intent.instructions }, e);
      if (JSON.stringify(intent) !== JSON.stringify(verified)) { throw new Error('Stored reverse envelope mismatch'); }
      return JSON.stringify(verified);
    },
    stateMatches: state => state?.sourceReceiptVerified === true && expected.payer === expectedRoute(expected).payer,
  };
}
/** @param {import('./replacement-fixture.ts').ReverseRoute} route */
export function deriveReverseAccounts(provider, pool, linkMint, route = REVERSE) {
  const selected = route !== REVERSE;
  const pda = selected && typeof provider.derivePda === 'function' ? (program, ...seeds) => provider.derivePda(program,
    seeds.map(s => (typeof s === 'string' ? Buffer.from(s) : s).toString('hex'))) :
    (program, ...seeds) => provider.web3.PublicKey.findProgramAddressSync(
      seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), new provider.web3.PublicKey(program))[0].toBase58();
  const ata = selected && typeof provider.deriveAta === 'function' ? (mint, owner, offCurve = false) => provider.deriveAta(mint, owner, offCurve) :
    (mint, owner, offCurve = false) => provider.spl.getAssociatedTokenAddressSync(
      new provider.web3.PublicKey(mint), new provider.web3.PublicKey(owner), offCurve).toBase58();
  validateReverseRoute(route);
  if (route.rmn !== REVERSE.rmn || route.nativeMint !== REVERSE.nativeMint) {
    throw new Error('Wrong selected derivation route');
  }
  const selector = u64(SEPOLIA_SELECTOR), mint = solanaPublicKeyBytes(route.mint);
  const spender = pda(ROUTER_PROGRAM, 'fee_billing_signer');
  return { ...pool, ...(selected ? {
    routerConfig: pda(ROUTER_PROGRAM, 'config'),
    pool: pda(BURNMINT_PROGRAM, 'ccip_tokenpool_config', mint),
    signer: pda(BURNMINT_PROGRAM, 'ccip_tokenpool_signer', mint),
    ata: ata(route.mint, pda(BURNMINT_PROGRAM, 'ccip_tokenpool_signer', mint), true),
    registry: pda(ROUTER_PROGRAM, 'token_admin_registry', mint),
    chain: pda(BURNMINT_PROGRAM, 'ccip_tokenpool_chainconfig', selector, mint),
    feeTokenConfig: pda(FEE_QUOTER_PROGRAM, 'fee_billing_token_config', mint),
    routerPoolSigner: pda(ROUTER_PROGRAM, 'external_token_pools_signer', solanaPublicKeyBytes(BURNMINT_PROGRAM)),
  } : {}), payer: route.payer, mint: route.mint, linkMint,
    sourceAta: ata(route.mint, route.payer), spender,
    destChain: pda(ROUTER_PROGRAM, 'dest_chain_state', selector), nonce: pda(ROUTER_PROGRAM, 'nonce', selector, solanaPublicKeyBytes(route.payer)),
    feeReceiver: ata(route.nativeMint, spender, true),
    feeConfig: pda(FEE_QUOTER_PROGRAM, 'config'), feeDest: pda(FEE_QUOTER_PROGRAM, 'dest_chain', selector),
    nativeFeeConfig: pda(FEE_QUOTER_PROGRAM, 'fee_billing_token_config', solanaPublicKeyBytes(route.nativeMint)),
    linkFeeConfig: pda(FEE_QUOTER_PROGRAM, 'fee_billing_token_config', solanaPublicKeyBytes(linkMint)),
    perTokenConfig: pda(FEE_QUOTER_PROGRAM, 'per_chain_per_token_config', selector, mint),
    curses: pda(route.rmn, 'curses'), rmnConfig: pda(route.rmn, 'config') };
}
export { BURNMINT_PROGRAM };
