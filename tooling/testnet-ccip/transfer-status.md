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

## Transfer sequence

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

For the return trip append `solana-to-ethereum` with its real source signature. At most three distinct fixture entries are accepted: E->A, A->E and E->B. Omitted `recipient` preserves historical A interpretation. For E->B set `recipient` to `QBqP2WraLUKU1G6tohJusxQ7iG15utpXLVZvvks3sNV` on that forward entry. Only these two fixed public keys are accepted; B reverse and duplicate fixture entries/source hashes are rejected. Native mint proof binds the selected wallet owner and independently derived canonical ATA (B: `2HGSh7v8thLVyxVSizQtvicsfKFrbYeL2sTSGjWzbCDE`). Optional `sepoliaRpc` and `solanaRpc` select native read endpoints; observed chain identity remains fixed. No wallets, secrets, signing, execution or broadcasting are used. No replacement/retry is authorized by any output.

CCIP metadata discovers destination receipt hashes only. Settlement requires successful finalized native transactions, exact decoded unique message identity and successful destination execution, plus actual token lock/mint/burn/release effects. Missing evidence stays unknown or pending. Manual execution preserves pending supply. Repeated invocations recover from public source transaction identity without erasing earlier journal entries; command never writes the submission journal.

Conservation reuses existing domain reconciliation with immutable Ethereum supply 100 AGTMAI, locked pool balance and finalized Solana mint supply. Snapshot is bracketed by repeated message observations and stable Solana supply; Ethereum reads bind a canonical block hash. Normal finalized head advancement is allowed. `completeFixtureInventory: true` is an explicit operator assertion that the list contains every fixture transfer; default accounting remains unknown. It is not discovery of all historical token movements. Unknown, incoherent or stale observations cannot report exact backing. Exit 0 requires exact accounting; 2 means a non-exact report; 1 means unavailable input/RPC/provider.

After all three real messages settle, expected conservation is Ethereum fixed100 AGTMAI, locked1, Solana supply1, pending0. Root delivery evidence must additionally prove Ethereum wallet99, A0, B1 and actual official ATA creation provenance; status settlement alone does not prove who created or funded the ATA. B is receive-only.


## Acceptance and remaining evidence

Keep all three source identities in the status settings once submitted. Set
`completeFixtureInventory: true` only after checking that this is the complete
fixture history. Do not remove a pending transfer to obtain an exact report.
Acceptance requires all three destinations settled and independently verified
final balances: E=99, A=0, B=1 AGTMAI, Ethereum supply=100, locked=Solana supply=1,
pending=0. Retain actual official ATA creation provenance as well as balances.
A negative `eth_call` against the actual pool proves that rejection only; it is
not a router-level E2E negative test.

Recorded checkpoint at `2026-09-08T02:17:11Z`, not a live success claim:
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
