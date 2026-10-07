// @ts-check
import { REPLACEMENT, selectedFixture, validateReplacementFixture } from './replacement-fixture.ts';
/** @typedef {import('./replacement-fixture.ts').ReplacementFixture} ReplacementFixture */
/** @typedef {typeof REPLACEMENT.recipient | typeof FORWARD_RECIPIENT_B} ReplacementForwardRecipient */
/** @typedef {import('./replacement-fixture.ts').FixtureSelection & {
 * testOnly: boolean, signer: { testOnly: boolean }, recipient?: unknown,
 * approvalNonce: string, sendNonce: string, approvalJournal: string, sendJournal: string
 * }} ForwardSettings */
/** Feature-local fixed testnet lane, independently checked before the existing signer. */
export const FORWARD = Object.freeze({ token: '0xbee91ba3ca94dd7c639ee6c1b1c2fc1a1996cdc9',
  pool: '0x24508e2eb3bedc086318abc054153fd83823a4e2', administrator: '0x275ee728c49100b56d4aa37c00e2dc8ffc5e5df6',
  router: '0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59', selector: 16423721717087811551n,
  recipient: '8T13W72sSEKmBpEv1FpUM7nJRatnChEfPSjkbSpdUn9t', amount: 1000000000n });
/** Receive-only second fixture; default A remains byte-for-byte compatible with old journals. */
export const FORWARD_RECIPIENT_B = 'QBqP2WraLUKU1G6tohJusxQ7iG15utpXLVZvvks3sNV';
export const FORWARD_RECIPIENT_B_ATA = '2HGSh7v8thLVyxVSizQtvicsfKFrbYeL2sTSGjWzbCDE';
/** @param {ReplacementFixture=} fixture @returns {import('./replacement-fixture.ts').ForwardRoute} */
export function forwardRoute(fixture) {
  if (fixture === undefined) { return FORWARD; }
  const f = validateReplacementFixture(fixture);
  return Object.freeze({ ...FORWARD, token: f.token, pool: f.pool, administrator: f.administrator,
    recipient: f.recipient, amount: BigInt(f.amount) });
}
/** @overload @param {unknown} recipient @param {ReplacementFixture} fixture @returns {ReplacementForwardRecipient} */
/** @overload @param {unknown=} recipient @param {ReplacementFixture=} fixture @returns {string} */
/** @param {unknown=} recipient @param {ReplacementFixture=} fixture */
export function forwardRecipient(recipient, fixture) {
  if (fixture !== undefined) {
    const route = forwardRoute(fixture);
    if (recipient === FORWARD_RECIPIENT_B) { return recipient; }
    if (recipient !== undefined && recipient !== route.recipient) { throw new Error('Wrong replacement forward recipient'); }
    return REPLACEMENT.recipient;
  }
  if (recipient === undefined) { recipient = FORWARD.recipient; }
  if (recipient !== FORWARD.recipient && recipient !== FORWARD_RECIPIENT_B) { throw new Error('Only fixed forward recipients A or B are allowed'); }
  return recipient;
}
/** @param {ForwardSettings} settings */
export function forwardTarget(settings) {
  const fixture = selectedFixture(settings), route = forwardRoute(fixture);
  forwardRecipient(settings.recipient, fixture);
  if (settings.testOnly !== true || settings.signer.testOnly !== true ||
    !/^(0|[1-9][0-9]*)$/.test(settings.approvalNonce) || !/^(0|[1-9][0-9]*)$/.test(settings.sendNonce) ||
    BigInt(settings.sendNonce) !== BigInt(settings.approvalNonce) + 1n ||
    settings.approvalJournal === settings.sendJournal || !settings.approvalJournal || !settings.sendJournal) {
    throw new Error('Fixed distinct journals and consecutive nonces required');
  }
  return { testOnly: true, token: route.token, pool: route.pool, administrator: route.administrator,
    ...(fixture ? { fixture } : {}) };
}
/** @param {bigint} value @param {import('./replacement-fixture.ts').ForwardRoute} route */
export function boundedAllowance(value, route = FORWARD) {
  if (typeof value !== 'bigint' || value < 0n || value > route.amount) { throw new Error('Unbounded existing router allowance'); }
  return value;
}
/** @returns {import("./evm-intent.ts").SepoliaIntentInput}
 * @param {{to: string, data: string, value?: bigint|string}} tx @param {string} nonce @param {import('./replacement-fixture.ts').ForwardRoute} route */
export function forwardIntent(tx, nonce, route = FORWARD) {
  return { chainId: '11155111', kind: 'call', from: route.administrator, to: tx.to,
    value: BigInt(tx.value ?? 0n).toString(), data: tx.data, nonce };
}
