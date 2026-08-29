# Unsigned local deployment planner

This feature creates a deterministic stable plan and a separate volatile fee
quote for an exact AGTMAIToken creation input on loopback Anvil (`31337`). All
gas, fee and cap values are canonical decimal strings converted to `bigint`.

The committed `trust-roots.v1.json` is test-only and explicitly disallows
mainnet and production approval. The builder cannot promote its own output.
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
