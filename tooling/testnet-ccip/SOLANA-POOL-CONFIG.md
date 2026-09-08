# Test-only Solana pool configuration

The bounded `src/composition/configure-solana-pool.mjs` entrypoint performs one
explicit operation per invocation:

1. `init-chain-remote-config`: selector `16015286601757825753`, zero remote pools,
   token `0xbee91ba3ca94dd7c639ee6c1b1c2fc1a1996cdc9`, nine decimals.
2. `append-remote-pool-addresses`: exactly one 32-byte left-padded address for
   EVM pool `0x24508e2eb3bedc086318abc054153fd83823a4e2`.
3. `set-chain-rate-limit`: inbound and outbound enabled, capacity `10000000000`,
   rate `1000000000` in local base units.
4. `create-lookup-table`: one atomic create+extend transaction with the canonical
   ten addresses. Its PDA binds payer and the explicitly persisted recent slot.
5. `set-pool`: exact finalized ALT and writable indexes `[3,4,7]`.

Settings contain `testOnly: true`, `providerDirectory`, `payerFile`, dedicated
`journalDirectory`, `registrationJournalFile`, and `expected: { testOnly: true,
cluster: "solana-devnet", payer, mint, pool, operation }`. The first operation
requires the existing successful `transfer-mint-authority` registration journal.
Each later operation requires a successful, freshly re-observed predecessor.
All journals remain distinct `<operation>.json` files. Unknown, expired,
unreadable or failed predecessors do not permit a new signature.

For create-lookup-table, first persist a freshly read finalized `recentSlot` as
a decimal string in `expected`. Reuse exactly that value for all reconciliations
and for set-pool. The other three operations omit recentSlot. Do not change it
to replace an expired/uncertain signed transaction. ALT creation rejects an
existing account or a recent slot outside the observed 512-slot horizon.

Every signature follows a coherent finalized snapshot of mint, pool, ATA,
registry, global config, router config, remote chain, and ALT when applicable.
The mint remains supply zero, freeze None, and controlled by the pool signer.
The registry must be the official 170-byte version2 layout with accepted payer
administrator. Manual ALT mode keeps supports_auto_derivation false, including
after set-pool; the separate automatic-derivation setter is never called.

ALT verification rejects extra/reordered addresses, wrong authority, frozen or
deactivated metadata, and unexpected last-extension state. Set-pool requires a
finalized bank later than extension before signing and an actual finalized
transaction slot later than extension afterward. There is no blind cooldown.
Raw signed messages use the shared signature verifier and single-transaction
journal, with exact program/account/data allowlists and no uncertain resend.

Native tests use disposable deterministic identities without network effects:

```sh
AGTMAI_TEST_SOLANA_PROVIDER=/absolute/pinned-provider \
  node --test tooling/testnet-ccip/tests/solana-pool-config-sdk.test.mjs
node --test tooling/testnet-ccip/tests/solana-pool-config.test.ts \
  tooling/testnet-ccip/tests/solana-pool-config-composition.test.mjs
```

Native validation must run with the provider present; a skipped test is not
proof. The fixtures compare all five messages to the official pinned builders,
including both ALT instructions, and reject malformed variable layouts/rates.
Provider source: BS58 generator commit `4c8d008a0990f1135da1e2b8bf511edba94904de`;
Solana onchain layout/rate/registry reference commit
`c73892d4d33926195eee87b77013883e650a833c`. No provider execute mode is used.
