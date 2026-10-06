# First bounded AGTMAI reverse transfer

Phase2 adds an explicit `agtmai-test-sdk-execution-v1` adapter branch for offline
unsigned work. It uses the admitted public `SolanaChain` entry, injected TEST
transport, actual fee/derivation simulations and SDK-discovered lookup tables.
Its worker view exposes preparation and inspection without signing. Admission
retains the exact legacy pins and separately authenticates SPL 0.4.15; the
SPL 0.4.14 codec installation remains a distinct input.

The TEST view accepts only the actual candidate returned by its admitted SDK
client and the exact fee quoted for that candidate. A copied or hand-written
candidate and a different retained quote fail before compilation.
Finalized state reads share the client's operation ownership: destruction
waits for an outstanding read before releasing admission, and rejects its result.

`build(candidate, expected, latest, finalizedLookup)` now compiles the supplied
candidate instructions and lookup tables. `finalizedLookup` contains the
independently selected native lookup account and finalized slot as a decimal
string. It must agree on authority, deactivation, extension and address order.
Missing snapshot input fails closed. Expected reconstruction serves only the
independent message/wire comparison. `inspectSigned` also takes this snapshot
and verifies externally supplied public signatures with native Ed25519.

The `svm` native runner phase has dedicated fresh processes for constructors,
fresh operations, reverse approval/no-approval and compiler/ALT/wire regressions.
Controlled replies are unit evidence. Genuine replay requires a hash-bound
`agtmai-test-sdk-svm-captures-v1` index with `approval` and `exact` cases, POST
request/response rows and independent expectation files. Each expectation binds
`observation` (recentSlot/linkMint/quotedFee/sourceLamports), `finalizedLookup`
(slot/key/dataBase64), `unsignedPacket` (blockhash/lastValidBlockHeight/bytesBase64/
messageBase64) and an externally supplied `publicSignedPacket`. Missing captures
fail qualification. The root supplied a pinned public runtime and a private
copy of public dependencies for offline units. Genuine captures remain absent;
these units do not qualify public execution or immutable runtime custody.

The existing legacy composition retains each observed finalized slot and passes
the repeated prerequisite read's native lookup account into preparation and
signing. Journal inspection independently reads only the selected ALT at finalized
commitment, so progressed source balances do not require a new preparation.
Failed or closed reads refuse inspection; recovery never requotes or replaces
the stored transaction. Native signature verification remains mandatory.

Controlled replay dispatches actual router instruction discriminators and
derivation stages, including SDK 1.13's Anchor view return log. Every successful
native child requires zero attempted network, signing and unguarded loads;
a caught network denial still fails and retains its attempted effect count.

Phase3's seven explicit entrypoint selections and status wiring remain pending.
The operator CLI below does not yet select the TEST branch.
Fresh public E→A→E plus E→B settlement
and exact accounting remain unproven. This checkpoint authorizes no signing,
broadcast, journal replacement or Mainnet release.

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
node --test tooling/testnet-ccip/tests/solana-reverse-sdk.test.mts
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
