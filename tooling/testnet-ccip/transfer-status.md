# Fixed AGTMAI testnet status

Read-only, one-shot command (Node 24.18.0):

```sh
node tooling/testnet-ccip/src/composition/transfer-status.mjs /absolute/public-status-settings.json
```

Public settings:

```json
{
  "testOnly": true,
  "sdkDirectory": "/var/data/agtmai-goal-20260905-01a07193/product-provider-tools/ccip-sdk-1.13.0",
  "completeFixtureInventory": false,
  "transfers": [
    {"direction": "ethereum-to-solana", "sourceHash": "REPLACE_WITH_REAL_SOURCE_TRANSACTION_HASH"}
  ]
}
```

For the return trip append `solana-to-ethereum` with its real source signature. At most two fixture sends are accepted. Optional `sepoliaRpc` and `solanaRpc` select native read endpoints; observed chain identity remains fixed. No wallets, secrets, signing, execution or broadcasting are used. No replacement/retry is authorized by any output.

CCIP metadata discovers destination receipt hashes only. Settlement requires successful finalized native transactions, exact decoded unique message identity and successful destination execution, plus actual token lock/mint/burn/release effects. Missing evidence stays unknown or pending. Manual execution preserves pending supply. Repeated invocations recover from public source transaction identity without erasing earlier journal entries; command never writes the submission journal.

Conservation reuses existing domain reconciliation with immutable Ethereum supply 100 AGTMAI, locked pool balance and finalized Solana mint supply. Snapshot is bracketed by repeated message observations and stable Solana supply; Ethereum reads bind a canonical block hash. Normal finalized head advancement is allowed. `completeFixtureInventory: true` is an explicit operator assertion that the list contains every fixture transfer; default accounting remains unknown. It is not discovery of all historical token movements. Unknown, incoherent or stale observations cannot report exact backing. Exit 0 requires exact accounting; 2 means a non-exact report; 1 means unavailable input/RPC/provider.
