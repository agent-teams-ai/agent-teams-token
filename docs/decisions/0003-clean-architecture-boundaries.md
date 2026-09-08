---
id: ADR-0003
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0003: Clean Architecture boundaries

Status: Accepted

Date: 2026-08-27

Decision owner: Product owner

## Context

The product spans immutable Solidity, Solana tooling, cross-chain operations,
governance and reporting. A universal chain abstraction would hide different
security semantics, while uncontrolled scripts would mix policy with RPC and
wallet effects.

## Decision

Use Clean Architecture, SOLID, DDD and DRY as enforceable design constraints:

1. Dependency direction is `domain <- application <- adapters <- composition`.
2. Bounded contexts are Supply, Distribution, Treasury, Cross-chain Transport,
   Transparency and Launch Liquidity.
3. Domain code has no ambient clock, randomness, environment, RPC or filesystem.
   These enter through narrow capability ports.
4. Ethereum and Solana adapters remain explicit. Shared ports express product
   capabilities such as reading canonical supply or submitting a transfer, not
   a lowest-common-denominator chain client.
5. Value objects represent token amounts, allocation IDs, schedules, chain
   selectors and message IDs. Floating point is prohibited for token amounts.
6. A shared abstraction is extracted only after two real consumers prove the
   same invariant. Similar-looking EVM and Solana code may remain duplicated
   when their failure semantics differ.
7. Engineering Foundation validates declared source edges, dependency policy,
   documentation references, ADRs, suppressions and portable quality gates. It
   is an exact dev dependency and cannot be imported by production code.

## Consequences

Adapters can change without moving economic policy into deployment scripts.
Adding a new network requires a new adapter and explicit threat review, not a
generic `Chain` switch inside the domain.

## Rejected alternatives

- One package containing all scripts and business rules.
- A universal cross-chain SDK wrapper before a second production consumer.
- Framework-defined domain models coupled to viem, ethers or Solana clients.
