# Project status

Last updated: 2026-08-27.

## Proven locally

- Monorepo dependency installation is reproducible from the lockfile.
- TypeScript 7 typecheck, lint and domain tests pass.
- Supply reconciliation covers quiescent and both in-flight bridge directions.
- Public networks are disabled by default.
- Tool and container versions are exact pins with checksum or digest evidence.
- The containerized Anvil RPC responds on host port `8545` with chain ID 31337.
- Native Agave validator RPC responds on host port `8899` with version 4.2.1.

## Designed, not implemented

- Ethereum fixed-supply token, vesting and treasury contracts.
- Chainlink CCIP Ethereum and Solana pool configuration.
- Event-sourced cross-chain monitor and public transparency dashboard.
- Airdrop, liquidity and governance execution.

## Not proven locally

- Real CCIP offchain delivery between Ethereum and Solana. This requires an
  approved Sepolia-to-Solana Devnet test and must not be simulated as evidence.
- Mainnet addresses, signers, legal classification, audits or launch readiness.

No production token, sale, liquidity pool or official airdrop exists.
