---
id: ADR-0001
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0001: Hybrid native macOS and Linux CI toolchain

Status: Accepted

Date: 2026-08-27

Decision owner: Product owner

## Context

The project needs fast Apple Silicon feedback and an independent reproducible
Linux environment without paying public-network gas for routine development.

## Decision

Use checksum-pinned native arm64 Node, Foundry and Agave for the local loop. Use
digest-pinned Linux containers and GitHub Actions for parity checks. Public
networks remain disabled by default. Local mock success is never reported as
proof of real CCIP delivery.

## Consequences

Local unit, fuzz, invariant and integration tests use valueless accounts. A real
Ethereum-to-Solana CCIP proof still requires an explicitly approved public
testnet round trip.

## Rejected alternatives

- Container-only local development, because feedback and Apple Silicon tooling
  are slower and harder to debug.
- Native-only development, because it lacks an independent Linux parity check.
