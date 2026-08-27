# ADR-002: Script-first CCIP integration

Status: accepted on 2026-08-27.

Deployment manifests and repository scripts are the source of truth for the
Ethereum-to-Solana lane. Chainlink Token Manager may assist supported steps but
is not assumed to provide a complete cross-family wizard.

Every public-network action must be deterministic, resumable and independently
verified against the official Chainlink directory before signatures are
requested.

