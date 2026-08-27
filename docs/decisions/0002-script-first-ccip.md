---
id: ADR-0002
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0002: Script-first CCIP integration

Status: Accepted

Date: 2026-08-27

Decision owner: Product owner

## Context

Chainlink UI coverage for an Ethereum-to-Solana token flow can change and does
not replace a reproducible deployment record.

## Decision

Deployment manifests and repository scripts are the source of truth. Token
Manager may assist supported steps but is not assumed to provide a complete
cross-family wizard. Every public-network action must be deterministic,
resumable and independently verified against the current official Chainlink
directory before signatures are requested.

## Consequences

The project retains a reviewable, machine-readable path even when a vendor UI
changes. UI exploration is a capability check, not the production deployment
mechanism.

## Rejected alternatives

- UI-only deployment, because it cannot provide stable replay and review
  evidence.
- A custom bridge or relayer, because it introduces a security system outside
  the project's core product.
