# Agent Teams Token

Monorepo for the Agent Teams AI community token, its Ethereum and Solana
integration, governance, supply accounting, transparency UI, and operational
tooling.

> No production token has been deployed. No contract address, pool, sale, or
> airdrop announced from this repository is official until it appears in a
> signed release and the public deployment manifest.

## Stack

- Solidity + Foundry for the immutable Ethereum token, vesting, and CCIP pool
  verification.
- TypeScript 7 for Solana instructions, CCIP tooling, configuration, monitor,
  web application, and cross-chain test harness.
- Engineering Foundation 0.20.0 for dev-only dependency, architecture,
  documentation, ADR, suppression and quality-gate policy.
- Agave local validator and LiteSVM for local Solana testing.
- Docker only for Linux CI parity and supporting services.
- No custom Rust program in the MVP.

## Local workflow

```bash
./dev bootstrap
./dev doctor
pnpm check:fast
pnpm check
docker compose up -d anvil
```

All local accounts use valueless test assets. Public testnet and mainnet access
remain disabled until their explicit gates are implemented.

## Project state

- [Living implementation plan](docs/PLAN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Tokenomics proposal](docs/TOKENOMICS.md)
- [Transparent release contract proposal](docs/CONTRACTS.md)
- [Decision register](docs/DECISIONS.md)
- [Token naming research](docs/NAMING.md)
- [Tokenomics evidence review](docs/research/TOKENOMICS-REVIEW-2026-08-27.md)
- [Six-critic adversarial review](docs/research/CRITIQUE-ROUND-2026-08-27.md)
- [Nine-review contract design synthesis](docs/research/CONTRACT-DESIGN-REVIEW-2026-08-27.md)
- [Engineering baseline research](docs/research/ENGINEERING-BASELINE-2026-08-27.md)
- [Open product decisions](docs/OPEN_QUESTIONS.md)
- [Non-negotiable mistakes and invariants](docs/NON_NEGOTIABLES.md)
- [Current status](docs/STATUS.md)
- [Genesis Core implementation review ledger](docs/research/GENESIS-CORE-CODE-REVIEW-2026-08-28.md)

Documentation navigation: [documentation index](docs/README.md) and
[architecture decision index](docs/decisions/README.md).
