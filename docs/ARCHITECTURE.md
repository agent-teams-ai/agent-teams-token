# Architecture

Status: working baseline, 2026-08-27.

## Post-custody deployment tooling

The active four-feature extension is described in
[Post-custody operations](architecture/post-custody-operations.md).
The Supply genesis-manifest feature owns one deployment fact model and a pure
`@agent-teams/supply/deployment` entrypoint. Custody execution and read-only
readiness remain separate outer tooling owners. The local Genesis Core format
and historical signed journals retain their existing meanings. Implementation
is in progress; production reserve wiring and mainnet protocol qualification
remain prerequisites.

## Contributor-grant custody

The contributor-grants feature uses one immutable, fully funded `GrantVault`
per grant. The vault owns ERC-20 custody, fixed address authorization and trusted
chain time; unchanged `GrantAccounting` owns schedule validation, vesting
arithmetic, releases and cancellation state. The originating reserve performs
the one-time exact funding pull, the immutable beneficiary claims to itself, and
an immutable controller address intended for a Safe 2-of-3 may cancel only team
grants. See [ADR-0006](decisions/0006-immutable-grant-custody.md).

This boundary has no factory, manager, proxy, governance, reserve-cap ledger or
deployment path. Actual parties, allocation and UTC schedule remain deployment
inputs. The older proposed direct-genesis-mint flow cannot activate a vault whose
funding invariant is an exact reserve debit and requires later production wiring.

## Product boundary

Ethereum is the canonical chain. The fixed supply is minted once into named
onchain allocation contracts. The target normal state is a fully backed 1:1
Solana representation delivered through CCIP; Solana is never an independent
source of supply. This is an architectural invariant, not a claim that the
public cross-chain path has already been implemented or proven.

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
`docs/architecture/feature-module-standard.md` as its source-layout standard,
reviewed at orchestrator commit `81e6946`. This repository keeps its enforcement
local rather than importing application code from the orchestrator.
Production behavior is owned by a real capability under
`src/features/<feature>/`; layers are created only when they contain behavior.
Broad `domain`, `shared`, `common`, `utils`, `services` and `infrastructure`
packages or directories are prohibited.

The current bootstrap `packages/domain/src/supply.ts` predates this adoption and
is not a valid target package. Until proposed ADR-0004 is accepted, the accepted
ADR-0003 remains authoritative. The first local Genesis Core slice adds only the
new `packages/contexts/supply/src/features/genesis-manifest/` feature and leaves
the legacy bootstrap unchanged. Before any package migration, ADR-0004 must be
accepted or rejected: acceptance causes one move into `Token Control` and
`Cross-chain Accounting`; rejection causes one move into ADR-0003 `Supply`.
A temporary double migration is prohibited.

## Proposed bounded-context topology

ADR-0003 currently remains accepted and names six contexts. Independent review
found the following two-context topology cleaner, but changing an accepted ADR
requires [ADR-0004](decisions/0004-feature-module-topology.md) to be explicitly
accepted rather than silently rewriting history.

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
  test/features/
  script/features/

apps/
  monitor/                     # thin composition root
  transparency/                # thin composition root
```

`Token Control` is the initial bounded context. Supply, Distribution, Treasury
and Launch Liquidity are its feature capabilities until distinct language,
lifecycle and ownership prove that another hard package boundary is warranted.
`Cross-chain Accounting` is separate because finalized-event reconciliation and
incident classification have different invariants and lifecycle. Its eventual
ledger owns immutable transfer identity, duplicate/conflict detection,
finality/reorg-aware transitions and coherent cursors. Aggregate supply values
are projections of that ledger. We do not create one package per contract or
speculative empty layer.

Token Control may approve a versioned transfer intent and its economic limits;
Cross-chain Accounting may record and reconcile its evidence. Application code
connects them through narrow public ports. Provider code remains inside the
feature-owned outbound adapter that uses it and only encodes, submits or observes
provider operations. Adapters do not decide budgets, finality, duplicate handling
or settlement policy.
There is no generic `chainlink-adapter` or `solana-adapter` package until a second
real context proves independent reuse. Executable applications contain wiring and
delivery only; business policy remains in a context feature.

Neither context is the bridge: the Chainlink relayer, token pools and Solana
program remain external infrastructure. Cross-chain Accounting cannot mint,
burn, release, submit or administer transfers.

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

- `supply/genesis-manifest`: strict proposal validator plus canonical,
  test-only local-fixture compiler. There is no production manifest schema or
  production compile command in Genesis Core.
- `token-control/release-policy`: designed future capability for pure allocation,
  commitment-cap and recipient policy; it is not implemented in Genesis Core.
- `cross-chain-accounting/supply-reconciliation`: current pure bigint bootstrap;
  its final event-ledger boundary remains a later slice.
- feature-owned outbound adapters: pinned CCIP SDK, Ethereum RPC and typed Solana
  instruction/account validation only where their use case needs them.
- `contracts/evm/src/features`: fixed-supply token and separate allocation
  contracts following the same capability ownership.
- `apps/monitor` and `apps/transparency`: thin composition roots.
- `scripts`: thin repeatable entrypoints into application use cases, not a home
  for business rules.

Engineering Foundation `0.20.0` validates real source edges, dependency
declarations, documentation links, ADR lifecycle, suppressions and quality gates.
It is an exact dev dependency and is never imported by production code. Its
scaffolding and public-API capabilities are enabled only with their first real
consumer, not with fabricated empty evidence.

Directories are introduced with their first vertical slice, not pre-created as
empty architecture.

Before the first package move, enforcement adds a package catalog, default-deny
source policy, token-local topology validator with negative fixtures, nested
workspace/TypeScript discovery, package exports and black-box/declaration/packed-
artifact consumer tests. Foundation supplies the released package-boundary
recipe and repository gates; it does not replace feature-topology validation.

The official CCIP pool is configured by feature-owned scripts after the protocol
ADR. There is no local `ccip-pool` production-contract feature unless the project
later approves a real custom onchain artifact.

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
