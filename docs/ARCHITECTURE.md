# Architecture

Status: working baseline, 2026-08-27.

## Product boundary

Ethereum is the canonical chain. The fixed supply is minted once into named
onchain allocation contracts. Solana holds only a 1:1 CCIP representation; it
is never an independent source of supply.

```text
accepted config -> canonical manifest/hash -> Ethereum ERC-20 + policy vaults
        |
        +-> CCIP version-specific backing holder/pool -> CCIP -> Solana BurnMint pool -> SPL mint
                                      |
                                      +-> event-sourced supply monitor
```

## Languages

- Solidity `0.8.36` is the current compiler candidate; it becomes an exact pin
  only after the first OpenZeppelin/Chainlink compatibility spike. Foundry 1.8.0
  runs the immutable ERC-20, vesting and Ethereum integration tests.
- TypeScript `7.0.2` for domain rules, deployment tooling, Solana instructions,
  monitoring, configuration and the future transparency UI.
- Shell only for the small project-local bootstrap entrypoint.
- No custom Rust or Anchor program in the MVP. The audited Chainlink SVM
  programs provide the Solana token-pool behavior.

## Boundaries

Dependency direction is `domain <- application <- adapters <- composition`.
Domain code cannot read clocks, randomness, environment, filesystems, RPC or
wallets directly. These effects enter through narrow ports. Ethereum and Solana
stay explicit adapters; a universal chain abstraction is prohibited until two
real consumers prove identical invariants and failure semantics.

- `packages/domain`: pure bigint supply and tokenomics rules. No RPC dependency.
- `packages/tokenomics-config`: strict proposal decoder and canonical accepted
  genesis-manifest compiler; production output rejects floats, calendar-month
  templates and any status other than `accepted`.
- `contracts/evm`: fixed-supply token, allocation contracts and CCIP pool setup.
- `packages/chainlink-adapter`: pinned CCIP SDK integration.
- `packages/solana-adapter`: typed Solana instructions and account validation.
- `apps/monitor`: event ingestion, pending-transfer state and reconciliation.
- `apps/transparency`: public allocations, unlocks, transfers and supply status.
- `scripts`: repeatable deployment and verification orchestration.

Bounded contexts are Supply, Distribution, Treasury, Cross-chain Transport,
Transparency and Launch Liquidity. Foundation validates real source edges. It
is an exact dev dependency and is never imported by production code.

Directories are introduced with their first vertical slice, not pre-created as
empty architecture.

CCIP adapter and monitor implementation wait for an ADR that executes the EVM
`1.6.4` versus `2.0.0` compatibility spike against the live SVM `1.6.3` lane.
The selected protocol line defines the canonical backing holder, registration
encoding and verifier interface; no adapter infers these from package `latest`.

## Local truth versus network truth

Native Foundry and Agave provide the fast macOS arm64 loop. Linux containers
are the reproducible CI environment. Local CCIP mocks prove application logic,
but cannot prove the offchain Ethereum-to-Solana delivery path. That evidence
must come from a separately approved Sepolia-to-Solana Devnet E2E run.

No public-network command is enabled by the default environment. Mainnet
deployment and Safe/Squads signatures always remain human actions.
