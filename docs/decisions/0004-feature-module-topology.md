---
id: ADR-0004
status: proposed
supersedes: []
superseded_by: []
---

# ADR-0004: Feature-module topology and bounded contexts

Status: Proposed

Date: 2026-08-27

Decision owner: Product owner

## Context

ADR-0003 accepted Clean Architecture and named six bounded contexts. If this
proposal is accepted, it will supersede ADR-0003 through one atomic lifecycle
update. Adopting the Agent Teams Orchestrator feature-module standard exposed
that four of those
names are capabilities or integration roles, not independently justified domain
packages. Editing the accepted ADR would destroy its audit trail.

## Proposed decision

If accepted, this ADR preserves ADR-0003 decisions 1 and 3-7 unchanged:
dependency direction, no ambient domain effects, explicit EVM/Solana adapters,
value objects and integer amounts, semantic DRY after a second consumer, and
Engineering Foundation as dev-only enforcement. It replaces only ADR-0003
decision 2, the bounded-context topology. Superseding ADR-0003 therefore means
consolidating its surviving constraints here, not silently discarding them.

Adopt two bounded contexts. These names describe product responsibility, not
deployable bridge components:

1. `Token Control`: genesis manifest, allocation and release policy, governance
   activation, unlock policy, liquidity policy, cross-chain transfer intent and
   budget, allowed asset/lane/destination, and bridge-administration approval.
   It does not determine finality, submit transactions or reconcile settlement.
2. `Cross-chain Accounting`: immutable transfer identity, evidence ledger,
   idempotency and duplicate/conflict detection, finality and reorg-aware state
   transitions, coherent cursors/watermarks, supply reconciliation and incident
   classification. Aggregate supply counters are derived projections, never the
   source of truth. This context cannot approve or submit transfers, mint, burn
   or release tokens, or administer a bridge.

Supply, Distribution, Treasury and Launch Liquidity are feature capabilities of
Token Control. Transparency is a query/application edge. Cross-chain Transport
is consumer-owned provider integration, not a domain context.

Production behavior belongs to `src/features/<feature>/`. Thin package metadata,
configuration, schemas, ABI declarations and composition roots may stay at their
conventional package locations. Feature layers exist only when they contain real
behavior. Repository-wide catch-all `domain`, `shared`, `common`, `utils`,
`services` and `infrastructure` packages are prohibited. Applications remain
thin composition roots.

The handoff from Token Control to Cross-chain Accounting is an immutable,
versioned transfer-intent artifact containing at least: intent ID/nonce,
allocation, amount, direction, source and destination asset/accounts, allowed
lane/configuration digest, approving controller and expiry. Application code
orchestrates the handoff through narrow public ports. Provider adapters only
encode, submit and observe chain operations; they do not own economic policy,
finality rules, duplicate handling or settlement state transitions.

Neither bounded context implements or replaces the Chainlink bridge, relayer,
token pool or Solana program. Those remain external provider infrastructure.

Package boundaries are enforced through a catalog, default-deny source policy,
exports and package-consumer tests. A narrow repository-specific topology
validator with negative fixtures covers feature-layout rules not supplied by
Engineering Foundation. Foundation validates its supported repository gates; it
is exact dev-only and never imported by production code.

## Consequences

No package is created per contract, endpoint or provider. Directories are added
with their first vertical slice. Accepting this ADR records the target topology;
it does not trigger an immediate package move. After the current Genesis Core
barrier, `packages/domain` is removed once, together with the first real slice
and the topology gates. Before that move, the manifest artifact schema/version
and digest identity are preserved or explicitly versioned so a package rename
cannot silently change a previously produced artifact.

## Rejected alternatives

- Keep six package-level contexts without independent language/lifecycle
  evidence; this creates ceremonial boundaries.
- Put all code into one generic domain package; this hides ownership and permits
  deep imports.
- Create generic Chainlink, EVM or Solana packages before two real consumers
  share the same invariant and failure semantics.

## Acceptance gate

This ADR remains proposed until the product owner approves replacing the six
contexts in ADR-0003. Until then ADR-0003 remains the accepted architecture and
no package migration begins. Acceptance is one atomic lifecycle update:
ADR-0004 becomes accepted, ADR-0003 gains `superseded_by: [ADR-0004]`, the index
moves both entries, and the immutable accepted-decision registry is regenerated.
The later code migration has its own implementation gate and review.
