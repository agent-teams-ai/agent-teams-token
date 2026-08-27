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

Adopt two bounded contexts:

1. `Token Control`: genesis manifest, allocation and release policy, governance
   activation, unlock policy, liquidity policy and bridge administration policy.
2. `Cross-chain Accounting`: finalized transfer provenance, settlement ledger,
   supply reconciliation and incident classification.

Supply, Distribution, Treasury and Launch Liquidity are feature capabilities of
Token Control. Transparency is a query/application edge. Cross-chain Transport
is consumer-owned provider integration, not a domain context.

Every production artifact belongs to `src/features/<feature>/`. Feature layers
exist only when they contain real behavior. Broad `domain`, `shared`, `common`,
`utils`, `services` and `infrastructure` packages are prohibited. Applications
remain thin composition roots; provider adapters stay with the use case that
owns their policy until a second real consumer proves reusable semantics.

The rule is enforced mechanically through a package catalog, default-deny source
dependency policy, a local topology validator with negative fixtures, package
exports/scripts and package-consumer tests. Engineering Foundation validates the
package boundary and repository gates; it is exact dev-only and never imported
by production code.

## Consequences

No package is created per contract, endpoint or provider. Directories are added
with their first vertical slice. `packages/domain` is removed atomically with the
first Cross-chain Accounting slice after this ADR is accepted and the topology
gates are present.

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
no package migration begins.
