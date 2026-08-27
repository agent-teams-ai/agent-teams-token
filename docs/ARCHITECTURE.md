# Architecture

Status: working baseline, 2026-08-27.

## Product boundary

Ethereum is the canonical chain. The fixed supply is minted once into named
onchain allocation contracts. Solana holds only a 1:1 CCIP representation; it
is never an independent source of supply.

```text
Ethereum ERC-20 -> allocation contracts / treasury
        |
        +-> CCIP LockRelease pool -> CCIP -> Solana BurnMint pool -> SPL mint
                                      |
                                      +-> event-sourced supply monitor
```

## Languages

- Solidity `0.8.24` + Foundry for the immutable ERC-20, vesting and Ethereum
  integration tests.
- TypeScript `7.0.2` for domain rules, deployment tooling, Solana instructions,
  monitoring, configuration and the future transparency UI.
- Shell only for the small project-local bootstrap entrypoint.
- No custom Rust or Anchor program in the MVP. The audited Chainlink SVM
  programs provide the Solana token-pool behavior.

## Boundaries

- `packages/domain`: pure bigint supply and tokenomics rules. No RPC dependency.
- `contracts/evm`: fixed-supply token, allocation contracts and CCIP pool setup.
- `packages/chainlink-adapter`: pinned CCIP SDK integration.
- `packages/solana-adapter`: typed Solana instructions and account validation.
- `apps/monitor`: event ingestion, pending-transfer state and reconciliation.
- `apps/transparency`: public allocations, unlocks, transfers and supply status.
- `scripts`: repeatable deployment and verification orchestration.

Directories are introduced with their first vertical slice, not pre-created as
empty architecture.

## Local truth versus network truth

Native Foundry and Agave provide the fast macOS arm64 loop. Linux containers
are the reproducible CI environment. Local CCIP mocks prove application logic,
but cannot prove the offchain Ethereum-to-Solana delivery path. That evidence
must come from a separately approved Sepolia-to-Solana Devnet E2E run.

No public-network command is enabled by the default environment. Mainnet
deployment and Safe/Squads signatures always remain human actions.

