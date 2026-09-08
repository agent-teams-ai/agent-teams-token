# First bounded AGTMAI reverse transfer

Feature-local consumer of the reviewed official CCIP SDK 1.13.0. This command sends
exactly 1 AGTMAI (1,000,000,000 base units) from the existing test Solana wallet to
`0x275ee728c49100b56d4aa37c00e2dc8ffc5e5df6` on Sepolia. It requires the finalized
forward transfer first: source ATA amount and Solana mint supply must both equal
1 AGTMAI, pool ATA must be empty, and the established remote peers and pool ALT
must match. This initial consumer intentionally rejects a different balance/supply.

Settings are a private JSON file with `testOnly: true`, the reviewed generator
`providerDirectory`, reviewed `ccipProviderDirectory`, `recentSlot` used when
creating the attached pool ALT, `payerFile` for the existing TEST identity,
`journalFile` in a private owned directory, and decimal `maxNativeBalanceLamports`.
The native exposure setting must be positive and at most 10 SOL; choose the
actual authorized test wallet exposure. Nothing creates or replaces a key.

Run using the repository's pinned Node runtime:

```sh
node tooling/testnet-ccip/src/composition/solana-reverse-transfer.mjs /absolute/private/reverse-settings.json
```

The command independently verifies the finalized SPL delegate (none or the router
fee-billing signer, at most 1 AGTMAI), exact Borsh payload and all 31 account metas,
then validates the SDK's unsigned instructions. Only the bounded approval (if
needed) and ccipSend are permitted. It verifies the ALT's owner, authority, active
state, finalized extension and all 10 addresses against independent derivation.
The v0 message must equal the independently recompiled message including static
keys, signer/writable union and every lookup index. Native Ed25519 verification
runs after signing and on every journal resume.

The quote and initial native balance are retained in the journal. **The native
router fee is recomputed onchain; ccipSend provides no caller max-fee argument.**
The quote is not an onchain spending cap. Native balance exposure is checked
before signing and broadcasting, bounded by the settings and retained initial
balance. Do not fund the payer concurrently with this operation. The payer also
pays the native transaction fee and any router nonce-account rent.

The existing durable Solana journal persists signed bytes before any broadcast.
Run the same settings and journal to reconcile. Submitted, unknown and expired
transactions are never automatically resent or replaced. A source receipt is
reported as `finalized-source-receipt-only`; it does not prove Sepolia execution
or final round-trip accounting. Recover the CCIP message and destination receipt
through the status consumer before calling the round trip complete.

Focused tests:

```sh
node --test tooling/testnet-ccip/tests/solana-reverse.test.mjs
AGTMAI_TEST_SOLANA_PROVIDER=/absolute/reviewed/generator \
AGTMAI_TEST_CCIP_PROVIDER=/absolute/reviewed/ccip-sdk-1.13.0 \
node --test tooling/testnet-ccip/tests/solana-reverse-sdk.test.mjs
```

For a positive native signature test, the root operator may additionally set
`AGTMAI_TEST_SOLANA_PAYER_FILE` to the existing TEST payer file. The native test
uses a fixed expired blockhash/lastValidBlockHeight=100, performs no RPC/broadcast,
and prints no signed bytes, secret material or signature. Without that variable
it proves unsigned/invalid-signature and message-mutation rejection only.

Independent source: official router derivation at
`smartcontractkit/chainlink-ccip@bbab0601244ce58e2ffac0dbc178a80aab1fa4a3`,
`chains/solana/contracts/programs/ccip-router/src/instructions/v1/onramp/derive.rs`;
SDK 1.13.0 `solana/send.js`, `solana/extra-args.js` and its pinned 1.6.0 router IDL.
