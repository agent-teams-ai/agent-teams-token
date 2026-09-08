# Fixed AGTMAI testnet operator runbook

This runbook covers the existing TEST fixture under the
[active plan](../../docs/PLAN.md): 100 AGTMAI, nine decimals, Ethereum
LockRelease and the official Solana BurnMint pool. It is not a fresh-address
deployment wizard or production launch. The only transfer sequence is 1 AGTMAI
E->A, A->E, E->B; B is receive-only.

Use pinned Node 24.20.0 from the repository root. Every command below accepts
exactly one JSON settings path, with no additional CLI flags. Signing commands
require the existing private TEST settings and durable journals. Recover those
checkpoints before running anything: missing journals are not permission to
recreate already deployed contracts or repeat transfers. Never put key material
or private settings in this document.

## Public transfer ledger

[Recorded native status, balances and ATA provenance](../../docs/reports/AGTMAI-TESTNET-E2E-2026-09-08.json) preserve the exact observed checkpoint.

Product testnet acceptance is complete. PUBLIC
`product-final-three-message-proof-success.json` records all three 1 AGTMAI
messages settled at `2026-09-08T05:04:14.470Z`, through the normal native status
CLI. Coherent fresh accounting: F=100, L=1, S=1, pending=0, backing surplus=0;
Ethereum height 11658930, Solana slot 494943575. The earlier
`product-roundtrip-finalized-native-proof.json` snapshot at
`2026-09-08T04:06:35.696Z` (F=100, L=0, S=0, pending=0; Ethereum 11658652,
Solana 494922690) records the first round trip before E->B.

| Leg | Public source / message / destination identities | Evidence |
| --- | --- | --- |
| E->A | Source `0x9d2e2a7503c12a08c5e57317470fdc7ed8f1f82575c9c695de58c6cc36ea50fa`; message `0x9aa9c02072640c7926c740f15282c004f8748789c94462d2cc84338458a60dd4`; destination `4apQ7wSFwRSRtbMRdmEPe9eko6VawQrJnktmStGe8qsAGpQcEWevGy8W9dNAao4SkGPcdPW8Y9wgpZVh8Q4rKcEk` | Finalized lock at Sepolia 11658108 and mint at Devnet slot 494905812; original message manually executed. |
| A->E | Source `5FhfyCdtWEt2kdTG139DRxd2MW6DRxSUSCrD42dd3GTbZWAuorJuWG3WSooRhuHFfr3s5D5d23b7D3A7NtevakAP`; message `0xc9a6a702960bd6b44f9c06b17298f7ad2d8869a7d6b03fa25a42257c95d14f3a`; destination `0x375a00cef1637801fd1c11926f9c32c2a1853ee6386b06d078c77253f7ed4886` | Finalized pool burn at Devnet slot 494910753 and Ethereum release at 11658569; API still HTTP 404, discovery UNKNOWN, settlement proven natively. |
| E->B | Source `0x8b3891c0d263df5634f760f74ed538abfcb75e48b6d808e8d2d77cc94367fde1`; message `0x654d44e9aa25e2d9048c614de7398caa22eddf4006ae66e1a13483d36ce057a6`; sequence 11208; destination `3Gc1mJJo8wMqZCZq2ei1E9vphBzh7w8XA3EW1JPD1C33AhWTkuNJgcKjuwxE1igMfRXt1SEM3hdWoizVA4Lt72jc` | Finalized lock at exact Sepolia block 11658811 and mint at Devnet slot 494936383; official automatic Execute. |

Historical initial `InvalidSourcePoolAddress` was repaired by official edit
`N2Ch32vM2j5ATjUTdSTa8JtRGuZX3sv47dz8MLfAwodV8bgPXrzGnikUCQ92S8SmhFUJyEvfpU1xJPsmECx75qJ`.
The E->A destination signature above executed the original message; there was
no replacement source transfer. PUBLIC `product-b-pre-send-proof.json` at
`2026-09-08T04:08:07.493Z` records B ATA absent at slot 494923246, E=100,
A=0 and allowance=0, before approval. B approval nonce 8
`0x0f243ad3e73968a0825b3bb78cab620f2b300f8797ea48398bb3247d0813a94e`
and send nonce 9 succeeded in their source journals. All three inventory entries
are complete. Preserve journals and never rerun these source transfers.

PUBLIC `product-final-balances-and-b-ata-proof.json`, observed at
`2026-09-08T05:04:59.366Z`, records:

- B ATA still absent at `2026-09-08T04:24:27.571Z`, slot 494929164.
- Separate ATA creation transaction
  `3LgX6equruDuoeK5Ej94iZvMotFa821jk8uFXtTBt51jwVyJtZf439rmxzpJz624zhzgV7XuJrjwDXMY6YMdKnT8`,
  slot 494936340, invokes the standard Associated Token Program
  `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` at stack height 1.
  Payer `3av6U8FGbv4W3ib6XGKaPxuKR96BsqXAo2FVhsTnwow6` is the same signer
  as the later official OffRamp Execute. Creation fee: 5009 lamports;
  rent: 1488440 lamports. OffRamp CPI itself did not create the ATA.
- Execution at slot 494936383 costs 5147 lamports. The recorded EVM message
  fee is 241528998328777 wei.
- Ethereum wallet: 99000000000 base units (99 AGTMAI), at block hash
  `0xc2ffa4d1e693872fb67b4090bb0d4a3c6fe351246155a596a85d0ae5250277a8`.
  Solana slot 494943844: A=0, B=1000000000 base units (1 AGTMAI),
  mint supply=1000000000 base units, B native balance=0 lamports.
  B was not funded and signed neither transaction.

## Recorded fees and authorities

The linked JSON ledger includes `feeAndAuthorityEvidence`, with receipt hashes,
gas arithmetic, exact Solana execution signatures and historical mint/burn
instructions. Ethereum receipts were reread against canonical finalized blocks
on 8 September 2026. Amounts below are integer base units, not fiat estimates.

| Leg | Source network fee | Source native CCIP payment | Destination network fee |
| --- | --- | --- | --- |
| E->A | 282100008335030 wei | 240030429000119 wei transaction value | 5000 lamports |
| A->E | 5000 lamports | 10571890 lamports transferred to fee billing account | 168974886117000 wei |
| E->B | 292246363141405 wei | 241528998328777 wei transaction value | 5147 lamports |

Destination fees can be paid by the executor. These rows exclude setup,
approvals, failed recovery attempts and rent, so they are not an all-in cost.
B ATA rent/creation fees remain listed above. The reverse transaction also
creates its nonce account with 777240 lamports rent, separate from its fees.

A later finalized authority observation records the same Ethereum test admin
as `getCCIPAdmin()` and pool `owner()`, and the pool's exact token address.
Solana mint authority is `8NGr2WFh3JrC1UzmB3iifESF7W5wf3CBPWguJayuXmkX`,
freeze authority is null, decimals are 9, and supply is 1000000000 base units.
Historical mint/burn instructions and this post-settlement account read are
separate evidence; the later read does not invent a historical before-state.

## Fixture and prerequisites

| Identity | Fixed public value |
| --- | --- |
| Ethereum administrator E | `0x275ee728c49100b56d4aa37c00e2dc8ffc5e5df6` |
| Sepolia token | `0xbee91ba3ca94dd7c639ee6c1b1c2fc1a1996cdc9` |
| Sepolia pool | `0x24508e2eb3bedc086318abc054153fd83823a4e2` |
| Devnet mint | `13Q74er9thh3my9oACjChDhtn4znJibWBp1u8q1rAYau` |
| Solana recipient A | `8T13W72sSEKmBpEv1FpUM7nJRatnChEfPSjkbSpdUn9t` |
| Solana recipient B | `QBqP2WraLUKU1G6tohJusxQ7iG15utpXLVZvvks3sNV` |

Use the reviewed generator/provider and CCIP SDK 1.13.0 installations; adapters
verify their pinned files. An arbitrary install of the same version is not
equivalent to the reviewed lockfile. Provider provenance and native verification
are described in [registration](SOLANA-REGISTRATION.md),
[pool configuration](SOLANA-POOL-CONFIG.md) and [reverse transfer](SOLANA-REVERSE.md).
Only faucet-funded TEST identities are in scope.

The EVM `signer` object contains `testOnly: true`, absolute `executable`,
`keystore`, `passwordFile`, `executableSha256`, and decimal strings `gasLimit`,
`maxFeePerGas`, `maxPriorityFeePerGas`. Keep its original values when resuming
a signed transaction. The cast adapter checks its executable hash, Sepolia
chain identity and transaction envelope. Never guess nonces from this runbook;
retain original nonces in existing settings.

## Ordered setup checkpoints

The following lists the existing entrypoints and required settings for recovering
the fixture setup. Run only the selected checkpoint with its original settings,
then inspect its result before advancing. Do not execute the entire list as a
script. Solana setup requires zero mint supply and therefore cannot simply be
replayed after a forward transfer.

| Order | Command from repository root | Required JSON settings |
| --- | --- | --- |
| 1. Ethereum token | `node tooling/testnet-ccip/src/composition/deploy-token.ts /absolute/private/token-settings.json` | `testOnly`, `administrator`, `nonce`, `artifactFile`, `artifactSha256`, `journalFile`, `signer` |
| 2. Ethereum pool | `node tooling/testnet-ccip/src/composition/deploy-pool.ts /absolute/private/pool-settings.json` | `testOnly`, `tokenSettingsFile` referencing step 1, `artifactFile`, `journalFile`, `nonce`, `signer` |
| 3. Ethereum registry | `node tooling/testnet-ccip/src/composition/register-token.ts /absolute/private/registry-settings.json` | `testOnly`, `token`, `pool`, `administrator`, `signer`; `tokenDeployment` and `poolDeployment`, each with original `journalFile` and full `intent`; `steps` keyed by `register-admin`, `accept-admin`, `set-pool`, each with distinct `journalFile` and `nonce` |
| 4. Solana mint | `node tooling/testnet-ccip/src/composition/create-solana-mint.mjs /absolute/private/mint-settings.json` | `testOnly`, `providerDirectory`, `payerFile`, `mintFile`, `journalFile`; `expected` containing `testOnly`, `cluster: "solana-devnet"`, `payer`, `mint`, `rentLamports` |
| 5. Solana pool | `node tooling/testnet-ccip/src/composition/initialize-solana-pool.mjs /absolute/private/solana-pool-settings.json` | `testOnly`, `providerDirectory`, `payerFile`, `journalFile`; `expected` containing `testOnly`, `cluster: "solana-devnet"`, `payer`, `mint`, `pool` |
| 6. Solana registry | `node tooling/testnet-ccip/src/composition/register-solana-pool.mjs /absolute/private/solana-registration-settings.json` | Settings and four ordered `expected.operation` values in [registration checkpoints](SOLANA-REGISTRATION.md) |
| 7. Solana remote/ALT | `node tooling/testnet-ccip/src/composition/configure-solana-pool.mjs /absolute/private/solana-config-settings.json` | Settings and five ordered operations in [pool configuration](SOLANA-POOL-CONFIG.md); retain the original `expected.recentSlot` for ALT operations |
| 8. Ethereum remote | `node tooling/testnet-ccip/src/composition/configure-evm-remote.ts /absolute/private/ethereum-remote-settings.json` | `testOnly`, `token`, `pool`, `administrator`, `signer`, `journalFile`, `nonce` |

All `testOnly` fields above are `true`; quantities/nonces are decimal strings.
Ethereum registration advances one bounded step per invocation and reconciles
previous journals. Solana registration/configuration selects one explicit
operation per invocation; do not advance until its predecessor is successfully
finalized and freshly readable. Existing pool addresses, remote peers, mint
authority and ALT must match before a transfer can sign.

## Completed transfer sequence (historical procedure)

The recorded sequence below is complete; do not rerun its source operations.

1. **E->A:** run the forward command below with `testOnly: true`,
   `providerDirectory` pointing to the reviewed CCIP SDK, `signer`, distinct
   `approvalJournal`/`sendJournal`, and decimal `approvalNonce`/`sendNonce`
   with `sendNonce = approvalNonce + 1`. Omit `recipient` for A or set its
   fixed public key explicitly. It handles at most one approval/send checkpoint
   per invocation; inspect `step`, `status`, `reason`, `transactionHash`.
   Reinvoke unchanged settings to reconcile and advance after finalized approval.
2. **A->E:** only after status proves the first destination delivery, follow
   [the reverse runbook](SOLANA-REVERSE.md). Its exact settings include
   `providerDirectory`, `ccipProviderDirectory`, retained ALT `recentSlot`,
   `payerFile`, dedicated `journalFile`, `testOnly: true` and decimal
   `maxNativeBalanceLamports`. It requires A balance and mint supply both 1 AGTMAI.
   Wait for proven Sepolia destination release before proceeding.
3. **E->B:** use the same forward entrypoint with B as `recipient`, new dedicated
   approval/send journals and the next verified consecutive nonce pair. Retain
   all E->A and reverse journals. Do not reuse or edit an earlier send intent.
   No B signer or reverse transfer is needed.

```sh
node tooling/testnet-ccip/src/composition/transfer-evm-forward.mjs /absolute/private/forward-settings.json
node tooling/testnet-ccip/src/composition/solana-reverse-transfer.mjs /absolute/private/reverse-settings.json
```

These are individual signing entrypoints, not a batch script. Each sends exactly
1 AGTMAI. Source success alone never authorizes the next transfer: use the
read-only command below for destination evidence.

## Read-only status and resumption

Read-only, one-shot command (Node 24.20.0):

```sh
node tooling/testnet-ccip/src/composition/transfer-status.mjs /absolute/public-status-settings.json
```

Public settings:

```json
{
  "testOnly": true,
  "sdkDirectory": "/absolute/reviewed/ccip-sdk-1.13.0",
  "completeFixtureInventory": false,
  "transfers": [
    {"direction": "ethereum-to-solana", "sourceHash": "REPLACE_WITH_REAL_SOURCE_TRANSACTION_HASH"}
  ]
}
```

For the return trip append `solana-to-ethereum` with its real source signature. At most three distinct fixture entries are accepted: E->A, A->E and E->B. Omitted `recipient` preserves historical A interpretation. For E->B set `recipient` to `QBqP2WraLUKU1G6tohJusxQ7iG15utpXLVZvvks3sNV` on that forward entry. Only these two fixed public keys are accepted; B reverse and duplicate fixture entries/source hashes are rejected. Native mint proof binds the selected wallet owner and independently derived canonical ATA (B: `2HGSh7v8thLVyxVSizQtvicsfKFrbYeL2sTSGjWzbCDE`). Optional `sepoliaRpc` and `solanaRpc` select native read endpoints; observed chain identity remains fixed. No wallets, secrets, signing, execution or broadcasting are used. No replacement or write retry is authorized by any output.

CCIP metadata discovers destination receipt hashes only. The optional
per-transfer `destinationReceipt` is an **UNTRUSTED discovery hint**; receipt discovery retains full native/SDK authentication,
finality, token effects and exact message binding. For the recorded reverse leg:

```json
{
  "destinationReceipt": {
    "transactionHash": "0x375a00cef1637801fd1c11926f9c32c2a1853ee6386b06d078c77253f7ed4886",
    "offRamp": "0x0820f975ce90EE5c508657F0C58b71D1fcc85cE0"
  }
}
```

This field belongs on the `solana-to-ethereum` transfer entry. Reverse API HTTP
404 remains discovery UNKNOWN; a hint or API result cannot establish settlement.

Settlement requires successful finalized native transactions, exact decoded unique message identity and successful destination execution, plus actual token lock/mint/burn/release effects. Missing evidence stays unknown or pending. Manual execution preserves pending supply. Repeated invocations recover from public source transaction identity without erasing earlier journal entries; command never writes the submission journal.

Conservation reuses existing domain reconciliation with immutable Ethereum supply 100 AGTMAI, locked pool balance and finalized Solana mint supply. Snapshot is bracketed by repeated message observations and stable Solana supply; Ethereum reads bind a canonical block hash. Normal finalized head advancement is allowed. `completeFixtureInventory: true` is an explicit operator assertion that the list contains every fixture transfer; default accounting remains unknown. It is not discovery of all historical token movements. Unknown, incoherent or stale observations cannot report exact backing. Exit 0 requires exact accounting; 2 means a non-exact report; 1 means unavailable input/RPC/provider.

Freshness is mandatory: Ethereum snapshot age <=1800 seconds and both Solana
observations <=300 seconds. Missing, future, invalid or stale timestamps prevent
exact accounting. The final proof records ages 878.4700000286102 seconds for
Ethereum and 6.4700000286102295 seconds for both Solana observations.
P2 correction `1f44039` received independent ACCEPT. A real full-status request
hit Solana RPC HTTP 429 with Retry-After 10; `d06f816` allows exactly one retry
with a maximum 10-second delay, only for allowlisted read-only methods. There
are no write retries. SDK already filters InProgress. The normal full native
status CLI now succeeds for all three messages; reverse API discovery remains
UNKNOWN while authenticated native settlement is proven.

## Acceptance and remaining evidence

The complete three-message inventory and independently verified balances above
satisfy product testnet acceptance: E=99, A=0, B=1 AGTMAI, fixed supply=100,
locked=Solana supply=1, pending=0, backing surplus=0. Keep all three identities
in status settings with `completeFixtureInventory: true`; never omit a transfer
to obtain an exact report. B remains receive-only. The negative rate-limit
`eth_call` against the deployed pool proves simulation rejection only, not a
broadcast router rejection. This remains a 100 AGTMAI test fixture, with no
production launch or mainnet authorization and no expansion of MVP scope.

31 status/RPC tests passed. On `3fd2fd3`, the default suite passed 171 tests
with 0 skips, lint had 0 diagnostics and typecheck passed. Main `370c` is
integrated in `255138f`; burn review `8e` is ACCEPT and independent artifact
approval is ACCEPT_REFRESH. Pin refresh `e403d49` passed 141 local-EVM and
7 native checks. Full `pnpm check` passed on `ab69885`, including 416 rollback
tests with 1 skip. The subsequent sealed proof failed only on forge fmt for two
test statements, fixed in `c370232`; its rerun remains pending. Final delivery
qualification still requires release evidence for final-head Linux/CI, sealed
rollback and final review. Historical full `75418030` and `ab69885` results
qualify their respective SHAs only; no final-head green result is inferred.

Historical pre-repair checkpoint at `2026-09-08T02:17:11Z`, superseded by the ledger above:
E->A source transaction
`0x9d2e2a7503c12a08c5e57317470fdc7ed8f1f82575c9c695de58c6cc36ea50fa`
reached `SOURCE_FINALIZED`, with native lock of 1 AGTMAI verified. Message
`0x9aa9c02072640c7926c740f15282c004f8748789c94462d2cc84338458a60dd4`
had no destination receipt: Solana supply=0, pending=1 and adjusted supply=100
AGTMAI, with exact accounting. Refresh native evidence before advancing; exact
pending accounting does not establish destination delivery or a completed round trip.

For any unresolved submission, retain its original settings and journal and
reinvoke that same operation to observe the original hash/signature. Never
delete journals, change a nonce/blockhash/recentSlot, or create a replacement
to bypass uncertainty or expiry. Status is read-only and grants no retry or
manual-execution authorization.

Reproducibility boundary: the commands require the retained private TEST
settings/journals, verified artifacts and exact reviewed provider installations.
This runbook supplies no secrets or provisioning command. The current transfer
consumers bind these existing public addresses; deploying a different token or
mint does not create a compatible fixture. If original evidence or dependencies
are unavailable, report that specific missing checkpoint and stop that operation.
