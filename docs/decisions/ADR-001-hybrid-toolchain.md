# ADR-001: Hybrid native macOS and Linux CI toolchain

Status: accepted on 2026-08-27.

Use pinned native arm64 Node, Foundry and Agave for the local development loop.
Use digest-pinned Linux containers and GitHub Actions for reproducible CI.

This keeps local feedback fast while preserving an independent Linux parity
check. Public networks remain disabled by default. Local mock success is never
reported as proof of real CCIP delivery.

