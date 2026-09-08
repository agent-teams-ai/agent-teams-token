/** Feature-local fixed testnet lane, independently checked before the existing signer. */
export const FORWARD = Object.freeze({ token: '0xbee91ba3ca94dd7c639ee6c1b1c2fc1a1996cdc9',
  pool: '0x24508e2eb3bedc086318abc054153fd83823a4e2', administrator: '0x275ee728c49100b56d4aa37c00e2dc8ffc5e5df6',
  router: '0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59', selector: 16423721717087811551n,
  recipient: '8T13W72sSEKmBpEv1FpUM7nJRatnChEfPSjkbSpdUn9t', amount: 1000000000n });
export function forwardTarget(settings) {
  if (settings.testOnly !== true || settings.signer.testOnly !== true ||
    !/^(0|[1-9][0-9]*)$/.test(settings.approvalNonce) || !/^(0|[1-9][0-9]*)$/.test(settings.sendNonce) ||
    BigInt(settings.sendNonce) !== BigInt(settings.approvalNonce) + 1n ||
    settings.approvalJournal === settings.sendJournal || !settings.approvalJournal || !settings.sendJournal) {
    throw new Error('Fixed distinct journals and consecutive nonces required');
  }
  return { testOnly: true, token: FORWARD.token, pool: FORWARD.pool, administrator: FORWARD.administrator };
}
export function boundedAllowance(value) {
  if (typeof value !== 'bigint' || value < 0n || value > FORWARD.amount) { throw new Error('Unbounded existing router allowance'); }
  return value;
}
export function forwardIntent(tx, nonce) {
  return { chainId: '11155111', kind: 'call', from: FORWARD.administrator, to: tx.to,
    value: BigInt(tx.value ?? 0n).toString(), data: tx.data, nonce };
}
