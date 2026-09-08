# Test-only Solana registration checkpoints

`src/composition/register-solana-pool.mjs` executes one explicitly selected Devnet
operation per invocation, after finalized account and predecessor journal checks:

1. `create-token-account`
2. `owner-propose-administrator`
3. `accept-admin-role`
4. `transfer-mint-authority`

Private test settings contain `testOnly: true`, `providerDirectory`, `payerFile`,
`journalDirectory`, and `expected: { testOnly: true, cluster: "solana-devnet",
payer, mint, pool, operation }`. The directory is dedicated to this mint/run;
each operation gets `<operation>.json`. Reusing a directory with another identity
fails closed. PDAs are derived and checked against actual signed instructions.

The initialized mint/pool must already be finalized. Fresh mint supply remains
zero, decimals nine, freeze authority None. A coherent finalized six-account
snapshot checks mint, pool, ATA, registry, global config, and router config.
The immediately preceding registration journal must be succeeded and readable
with exact finalized transaction evidence before the next transaction is signed.
Registry acceptance must precede mint-authority transfer to the pool signer.

Signed bytes, signature, blockhash and validity height persist before broadcast.
Only an original `signed` record with double-checked absence may submit once.
Submission uncertainty or expiry never permits resend, replacement or journal
deletion. Reinvoke the same operation to reconcile its original signature. A
finalized error is failed; inaccessible or conflicting evidence is unresolved,
including when a previously terminal record becomes unreadable. CLI output
includes operation, status, durable phase, reason, and signature.

The transaction journal, signature verifier and Devnet RPC observer are shared
feature-local helpers with pool initialization. They do not add a composition
node or a generic orchestration platform. Existing pool journal schemas remain
unchanged. No generator execute mode or real-project runtime is used.

Native SDK proof uses the pinned official provider directory with frozen lockfile:

```sh
AGTMAI_TEST_SOLANA_PROVIDER=/absolute/test-provider \
  node --test tooling/testnet-ccip/tests/solana-pool-init-sdk.test.mjs \
  tooling/testnet-ccip/tests/solana-registration-sdk.test.mjs
```

These tests use disposable deterministic identities and do not submit anything.
They compare transaction bytes against the official router/SPL builders and test
signature, account privilege, layout and phase rejection. An unset provider skips
these two optional test files and does not constitute native validation evidence.
The local composition journal regression is included in `test:testnet-ccip`.
