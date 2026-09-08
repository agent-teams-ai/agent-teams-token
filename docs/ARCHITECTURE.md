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

## Executable domain dependency gate

Source Dependencies v2 is explicitly activated by `foundation.config.yaml` and
`architecture/foundation/source-dependencies.yaml`. It enforces the existing
pure domain boundary: `supply.ts` is runtime source with no allowed imports;
`supply.test.ts` is development source allowed to import the domain entrypoint
and only `node:assert/strict` and `node:test`. These technical policy IDs do not
introduce new business boundaries. Source and test files remain in place.

The selected universe is JavaScript/TypeScript source in packages under
`packages`, currently `packages/domain/package.json` and its two source files.
New source inside that package (including outside `src`) must be classified;
a new direct-child package must be covered even when excluded by workspace
globs. A future materialized `apps/*` workspace package fails until explicitly
adopted. Discovery excludes package `dist`, `coverage`, `.git`, and
`node_modules`. Root scripts/tests, Solidity and network data are outside this
source graph. This static import policy does not prove absence of network
globals or qualify real CCIP delivery.

`pnpm check` now requires development-only placement, registry provenance,
full configured Foundation execution, disposable-fixture Foundation regressions,
and the complete existing Docs/lint/typecheck/test suffix. No capability
selector or successful skip substitutes for full execution. Focused tests use
the installed public CLI and inspect mutated fixture source without executing
it. Removing/replacing the capability or narrowing the policy fails the
consumer contract even if a different capability would pass.

CI job `check` runs on pull requests, merge groups and main pushes. Hosted
protection must require its success and the independent managed Documentation
Protocol status at the candidate SHA, rejecting skipped or missing evidence.
Workflow routing alone does not prove those protections. Portable Docs,
Foundation source checks, package assertions and trusted managed qualification
remain separate gates. Borrowing an archive installation for focused tests does
not authenticate this consumer's lock or establish full `pnpm check` success.
Historical profiles, scenarios, receipts and ADRs remain unchanged; managed
profile/cohort/state/receipt cutover and hosted evidence belong to the managed
controller and coordinator.

## Local truth versus network truth

Native Foundry and Agave provide the fast macOS arm64 loop. Linux containers
are the reproducible CI environment. Local CCIP mocks prove application logic,
but cannot prove the offchain Ethereum-to-Solana delivery path. That evidence
must come from a separately approved Sepolia-to-Solana Devnet E2E run.

No public-network command is enabled by the default environment. Mainnet
deployment and Safe/Squads signatures always remain human actions.

