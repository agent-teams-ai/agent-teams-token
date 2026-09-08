import { createHash } from 'node:crypto';
import { ROUTER_PROGRAM } from './solana-registration.ts';
import { BURNMINT_PROGRAM } from './solana-pool-init.ts';
import { SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM, solanaPublicKeyBytes } from './solana-mint.ts';
import { SEPOLIA_SELECTOR, FEE_QUOTER_PROGRAM, altAddresses, u64 } from './solana-pool-config.ts';
export const REVERSE = Object.freeze({ payer: '8T13W72sSEKmBpEv1FpUM7nJRatnChEfPSjkbSpdUn9t',
  mint: '13Q74er9thh3my9oACjChDhtn4znJibWBp1u8q1rAYau',
  recipient: '0x275ee728c49100b56d4aa37c00e2dc8ffc5e5df6', amount: 1000000000n,
  rmn: 'RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7', nativeMint: 'So11111111111111111111111111111111111111112' });
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const bytes = b => Buffer.concat([u32(b.length), b]);
const meta = (address, isWritable = false, isSigner = false) => ({ address, isWritable, isSigner });
export function reverseInstructions(e) {
  if (e.testOnly !== true || e.cluster !== 'solana-devnet' || e.payer !== REVERSE.payer || e.mint !== REVERSE.mint ||
    typeof e.approval !== 'boolean' || !/^[1-9][0-9]*$/.test(e.quotedFee) || BigInt(e.quotedFee) > 100000000n || !/^[1-9][0-9]*$/.test(e.sourceLamports) || BigInt(e.sourceLamports) > 10000000000n) {
    throw new Error('Wrong fixed reverse scope/quote');
  }
  const all = altAddresses(e);
  const accounts = [meta(e.routerConfig), meta(e.destChain, true), meta(e.nonce, true), meta(e.payer, true, true),
    meta(SYSTEM_PROGRAM), meta(SPL_TOKEN_PROGRAM), meta(REVERSE.nativeMint), meta(SYSTEM_PROGRAM, true),
    meta(e.feeReceiver, true), meta(e.spender), meta(FEE_QUOTER_PROGRAM), meta(e.feeConfig), meta(e.feeDest),
    meta(e.nativeFeeConfig), meta(e.linkFeeConfig), meta(REVERSE.rmn), meta(e.curses), meta(e.rmnConfig),
    meta(e.sourceAta, true), meta(e.perTokenConfig), meta(e.chain, true),
    ...all.map((a, i) => meta(a, [3, 4, 7].includes(i)))];
  const extra = Buffer.concat([Buffer.from('181dcf10', 'hex'), Buffer.alloc(16), Buffer.from([1])]);
  const data = Buffer.concat([createHash('sha256').update('global:ccip_send').digest().subarray(0, 8),
    u64(SEPOLIA_SELECTOR), bytes(Buffer.from(REVERSE.recipient.slice(2), 'hex')), bytes(Buffer.alloc(0)),
    u32(1), solanaPublicKeyBytes(e.mint), u64(REVERSE.amount), solanaPublicKeyBytes(SYSTEM_PROGRAM), bytes(extra), bytes(Buffer.from([0]))]);
  const send = { programId: ROUTER_PROGRAM, accounts, dataBase64: data.toString('base64') };
  const approval = { programId: SPL_TOKEN_PROGRAM,
    accounts: [meta(e.sourceAta, true), meta(e.spender), meta(e.payer, false, true)],
    dataBase64: Buffer.concat([Buffer.from([4]), u64(REVERSE.amount)]).toString('base64') };
  return e.approval ? [approval, send] : [send];
}
export function verifyReverseIntent(intent, expected) {
  const instructions = reverseInstructions(expected);
  if (intent.feePayer !== REVERSE.payer || JSON.stringify(intent.instructions) !== JSON.stringify(instructions)) {
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
    stateMatches: state => state?.sourceReceiptVerified === true && expected.payer === REVERSE.payer,
  };
}
export function deriveReverseAccounts(provider, pool, linkMint) {
  const { PublicKey } = provider.web3, { getAssociatedTokenAddressSync } = provider.spl;
  const key = a => new PublicKey(a), pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), key(program))[0].toBase58();
  const selector = u64(SEPOLIA_SELECTOR), mint = key(REVERSE.mint).toBuffer();
  const spender = pda(ROUTER_PROGRAM, 'fee_billing_signer');
  return { ...pool, payer: REVERSE.payer, mint: REVERSE.mint, linkMint,
    sourceAta: getAssociatedTokenAddressSync(key(REVERSE.mint), key(REVERSE.payer)).toBase58(), spender,
    destChain: pda(ROUTER_PROGRAM, 'dest_chain_state', selector), nonce: pda(ROUTER_PROGRAM, 'nonce', selector, key(REVERSE.payer).toBuffer()),
    feeReceiver: getAssociatedTokenAddressSync(key(REVERSE.nativeMint), key(spender), true).toBase58(),
    feeConfig: pda(FEE_QUOTER_PROGRAM, 'config'), feeDest: pda(FEE_QUOTER_PROGRAM, 'dest_chain', selector),
    nativeFeeConfig: pda(FEE_QUOTER_PROGRAM, 'fee_billing_token_config', key(REVERSE.nativeMint).toBuffer()),
    linkFeeConfig: pda(FEE_QUOTER_PROGRAM, 'fee_billing_token_config', key(linkMint).toBuffer()),
    perTokenConfig: pda(FEE_QUOTER_PROGRAM, 'per_chain_per_token_config', selector, mint),
    curses: pda(REVERSE.rmn, 'curses'), rmnConfig: pda(REVERSE.rmn, 'config') };
}
export { BURNMINT_PROGRAM };
