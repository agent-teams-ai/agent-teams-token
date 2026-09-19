---
id: ADR-0007
type: adr
status: proposed
owner: architecture
summary: Defines the qualified EVM and Solana protocol identities, layouts, authority model and backing semantics required before any mainnet readiness claim.
---

# ADR-0007: Mainnet protocol line for AGTMAI readiness

## Context

The readiness evaluator must identify the exact CCIP protocol line before it
interprets authorities, pool accounts, remote token bytes, or backing. Testnet
success and mocked delivery do not establish mainnet compatibility.

## Decision

For the mainnet-dry-run profile, readiness is qualified only against the
reviewed official Chainlink CCIP CCT line whose EVM side uses the deployed
AGTMAI LockRelease pool and whose Solana side uses the standard SPL Token
BurnMint pool. EVM remote token values use ABI32 encoding and remote pool
values use raw20 encoding. Solana TokenAdminRegistry v2 is 170 bytes and its
final `supports_auto_derivation` byte is checked explicitly.

The configured Ethereum pool is the canonical backing holder. Fixed Ethereum
issuance remains unchanged; Solana supply and finalized cross-chain pending
effects are reconciled against that holder. Pool owner, router/RMN bindings,
registry and limiter administration, rebalancer or withdrawal powers, Solana
pool administration, and ProgramData upgrade authority remain explicit
capability records. Any unresolved identity, layout, authority, or protocol
artifact makes readiness unsuccessful.

This ADR is proposed until independently reviewed artifact and deployment
evidence are supplied. It authorizes no deployment, signing, repair, or
broadcast.

## Consequences

Readiness reports can distinguish an unqualified protocol from an absent
deployment and from an authority or backing discrepancy. Protocol upgrades
require a new ADR or an explicit superseding decision and a new pinned
snapshot. Testnet fixtures remain separate evidence.

## Rejected alternatives

CCIP 2.0.0 and tutorial mintable tokens are rejected because their custody and
authority models differ from AGTMAI's existing LockRelease and SPL BurnMint
representation. Generic bridge adapters and inferred account layouts are also
rejected.
