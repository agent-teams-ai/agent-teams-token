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

## Adopted feature-module standard

The repository adopts the accepted Agent Teams Orchestrator
`docs/architecture/feature-module-standard.md` as its source-layout standard.
Production behavior is owned by a real capability under
`src/features/<feature>/`; layers are created only when they contain behavior.
Broad `domain`, `shared`, `common`, `utils`, `services` and `infrastructure`
packages or directories are prohibited.

The current bootstrap `packages/domain/src/supply.ts` predates this adoption and
is intentionally not treated as the target architecture. Before adding the next
production slice it moves, with its tests, into the feature-owned boundary below.
No contract implementation starts on the old generic package topology.

```text
packages/
  contexts/
    token-control/
      src/features/
        genesis-manifest/
        release-policy/
        unlock-calendar/
    cross-chain-accounting/
      src/features/
        supply-reconciliation/
        transfer-ledger/

contracts/evm/
  src/features/
    token-genesis/
    community-governance-reserve/
    community-distributions/
    contributor-grants/
    operations-budget/
    ecosystem-grants/
    launch-liquidity/
    ccip-pool/                 # only after the protocol-line ADR
  test/features/

apps/
  monitor/                     # thin composition root
  transparency/                # thin composition root
```

`Token Control` is the initial bounded context. Supply, Distribution, Treasury
and Launch Liquidity are its feature capabilities until distinct language,
lifecycle and ownership prove that another hard package boundary is warranted.
`Cross-chain Accounting` is separate because finalized-event reconciliation and
incident classification have different invariants and lifecycle. We do not create
one package per contract or speculative empty layer.

Provider code remains inside the feature-owned outbound adapter that uses it.
There is no generic `chainlink-adapter` or `solana-adapter` package until a second
real context proves independent reuse. Executable applications contain wiring and
delivery only; business policy remains in a context feature.

Feature public entrypoints are narrow. Cross-feature or cross-package imports use
only declared entrypoints and the Foundation source-dependency policy. Unit tests
are colocated; contract/integration/adapter tests live under
`tests/features/<feature>/`; package-consumer tests live under `tests/package/`.

## Boundaries

Dependency direction is `domain <- application <- adapters <- composition`.
Domain code cannot read clocks, randomness, environment, filesystems, RPC or
wallets directly. These effects enter through narrow ports. Ethereum and Solana
stay explicit adapters; a universal chain abstraction is prohibited until two
real consumers prove identical invariants and failure semantics.

- `token-control/genesis-manifest`: strict proposal decoder and canonical
  accepted-manifest compiler. Production output rejects floats, calendar-month
  templates and any status other than `accepted`.
- `token-control/release-policy`: pure allocation, commitment-cap and recipient
  policy with no chain dependency.
- `cross-chain-accounting/supply-reconciliation`: pure bigint supply rules.
- feature-owned outbound adapters: pinned CCIP SDK, Ethereum RPC and typed Solana
  instruction/account validation only where their use case needs them.
- `contracts/evm/src/features`: fixed-supply token and separate allocation
  contracts following the same capability ownership.
- `apps/monitor` and `apps/transparency`: thin composition roots.
- `scripts`: thin repeatable entrypoints into application use cases, not a home
  for business rules.

Engineering Foundation `0.19.0` validates real source edges, dependency
declarations, documentation links, ADR lifecycle, suppressions and quality gates.
It is an exact dev dependency and is never imported by production code. Its
scaffolding and public-API capabilities are enabled only with their first real
consumer, not with fabricated empty evidence.

Directories are introduced with their first vertical slice, not pre-created as
empty architecture.

The detailed release-contract proposal and the limits of what code can prove are
recorded in [CONTRACTS.md](CONTRACTS.md).

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
