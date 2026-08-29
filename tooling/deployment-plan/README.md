# Unsigned local deployment planner

This feature creates a deterministic stable plan and a separate volatile fee
quote for an exact AGTMAIToken creation input on loopback Anvil (`31337`). All
gas, fee and cap values are canonical decimal strings converted to `bigint`.

The committed `trust-roots.v1.json` is test-only and explicitly disallows
mainnet and production approval. The builder cannot promote its own output.
The `buildInfoSolcVersion` trust root binds Forge build-info's actual
`solcVersion` field exactly as `0.8.36`. Forge 1.8.0 emits both `solcVersion`
and `solcLongVersion` as that short value, so this feature does not claim that
build-info proves the `+commit.8a079791` suffix. The separately pinned and
checksum-verified Forge/solc toolchain boundary enforces that long compiler
identity before a fresh build is admitted.
The RPC port has four read-only methods, rejects redirects and final-URL
changes, and cannot accept public hosts. There is deliberately no wallet,
signer, key, raw-transaction, deploy, transaction-send, or broadcast surface.

Bundles contain `deployment-plan.v1.json`, `fee-quote.v1.json`, then `READY`.
The independent verifier recomputes identity, fee math, cap and freshness and
checks READY digests using no-follow file reads. A quote is expired when
`now >= expiresAt`; failed cap or validation checks occur before publication.

Root command and TypeScript-project wiring are integrator-owned and therefore
must be added separately. Tests can be run directly after the root build with:

`node --test tooling/deployment-plan/tests/*.test.ts`

The real integration test is enabled only when all three test-only tool paths
are supplied: `AGTMAI_ANVIL_BINARY`, `AGTMAI_FORGE_BINARY`, and
`AGTMAI_SOLC_BINARY`. It performs a fresh isolated Forge build and feeds the
resulting artifact and build-info into the actual unsigned planner. Supplying
only a subset is a configuration failure, not a skip.
