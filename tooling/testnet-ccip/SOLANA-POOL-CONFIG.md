# Test-only Solana pool configuration

The bounded `src/composition/configure-solana-pool.mjs` entrypoint performs one
explicit operation per invocation:

1. `init-chain-remote-config`: selector `16015286601757825753`, zero remote pools,
   token `0xbee91ba3ca94dd7c639ee6c1b1c2fc1a1996cdc9`, nine decimals.
2. `append-remote-pool-addresses`: exactly one raw 20-byte address for
   EVM pool `0x24508e2eb3bedc086318abc054153fd83823a4e2`.
3. `set-chain-rate-limit`: inbound and outbound enabled, capacity `10000000000`,
   rate `1000000000` in local base units.
4. `create-lookup-table`: one atomic create+extend transaction with the canonical
   ten addresses. Its PDA binds payer and the explicitly persisted recent slot.
5. `set-pool`: exact finalized ALT and writable indexes `[3,4,7]`.

Explicit repair, outside the fresh setup sequence: `repair-remote-pool-encoding`
uses official `edit_chain_remote_config` to replace the known legacy padded32
pool with raw20, preserving ABI32 remote token and nine decimals. It requires
`expected.recentSlot` from the existing finalized set-pool checkpoint plus
`expected.repairRateLimitsBase64`: the exact 66 serialized bucket bytes read
from the legacy chain account at offsets85..151. Both enabled configurations,
counters and timestamps must match those persisted bytes before and after.
The mint must still have zero supply and its existing authority; the registry
and existing ALT remain attached and checked. No pending token is minted here.
The repair has its own `repair-remote-pool-encoding.json` durable journal.
Legacy append32/config journals remain historical evidence: no overwrite,
replacement or replay. The new append20 allowlist deliberately rejects old
append32 signed bytes. Repair independently reconciles the exact historical
set-pool transaction and verifies the current legacy repair prerequisite.

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
proof. The fixtures compare all six messages to the official pinned builders,
including both ALT instructions, and reject malformed variable layouts/rates.
Provider source: BS58 generator commit `4c8d008a0990f1135da1e2b8bf511edba94904de`;
Solana onchain layout/rate/registry reference commit
`c73892d4d33926195eee87b77013883e650a833c`. No provider execute mode is used.

## Chain account allocation

Pinned Rust `base-token-pool/src/common.rs` uses `#[max_len(64)]` for
`RemoteAddress.address`. Accordingly `ChainConfig::INIT_SPACE` allocates
147 bytes for an empty pool vector, although its EVM32 token payload serializes
to115 bytes. Appending one raw20 pool allocates171 bytes and serializes139.
Fresh allocation has32 zero trailing bytes. Official edit shrinks the previous
183-byte padded32 account with realloc::zero=false, leaving the exact observed
32-byte residual `0200000000ca9a3b000000000000000000000000000000000000000000000000`.
The decoder accepts only zero or that proven residual; repair specifically
requires the residual after and zero slack on the exact legacy183 account before.
It never accepts arbitrary slack or compact serialized-only accounts.

Public evidence: init slot494854806; repair read-only simulation slot494886698,
after-account SHA256 `05193b6432a06f85dc5aba6dd62f747a920f9c74cd241460a17c3c674eec78ce`.
The actual source-pool CPI uses20 bytes and failed against the32-byte stored
value with InvalidSourcePoolAddress6007. Simulation is not onchain finality.
Do not resend the existing finalized source transfer while repairing its destination.
