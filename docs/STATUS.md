# Project status

Last updated: 2026-08-28.

Approved product identity: `Agent Teams AI`, symbol `AGTMAI`. Formal pre-launch
clearance remains required.

Liquidity direction: trading is required, founder total cash contribution is
capped at `$100`, and community liquidity must be added directly by its owners.
The first pool is explicitly experimental and highly volatile, not depth or
valuation evidence.

Tokenomics working baseline, still under discussion: `45/25/15/8/6/1` for the
community-governance reserve, distributions, all contributors, operations,
ecosystem grants and liquidity. Founder is capped at 3% inside contributors.

## Proven locally

- Monorepo dependency installation is reproducible from the lockfile.
- TypeScript 7 typecheck, lint and domain tests pass.
- The pure supply projection covers quiescent and both in-flight bridge
  directions; it is not yet a finalized event-ledger source of truth.
- Public networks are disabled by default.
- Node 24.20.0, pnpm 11.24.0, Foundry 1.8.0 and solc 0.8.36 are pinned by
  platform-specific checksums for macOS arm64 and Linux x64. Fetch, offline
  install, tamper recovery and fail-closed verification are implemented.
- Foundry 1.8.0 native and containerized Anvil are verified on chain ID 31337.
- Engineering Foundation 0.20.0 is installed dev-only; applicable architecture,
  dependency, documentation, ADR, suppression and quality-gate policies pass
  static validation.
- The containerized Anvil RPC responds on host port `8545` with chain ID 31337.
- Native Agave validator RPC responds on host port `8899` with version 4.2.1.
- Local, Sepolia and Solana Devnet testing has a `$0` real-asset budget; fake
  USDC and faucet test tokens are never purchased.
- Confirmed historical and design anti-patterns are frozen in
  `docs/NON_NEGOTIABLES.md` as an implementation/review contract.
- Six independent critics returned `AMEND`, not `REJECT`; accepted amendments
  and deliberately unresolved choices are recorded in
  `docs/research/CRITIQUE-ROUND-2026-08-27.md`.
- Four contract designers and five independent critics reviewed the release,
  governance, liquidity, security, economics and architecture proposal. The
  synthesis is recorded in
  `docs/research/CONTRACT-DESIGN-REVIEW-2026-08-27.md`; those earlier reviews
  used the disclosed local read-only fallback, and no contract code started.
- Five additional independent read-only reviews ran on production hosted
  subscription runtime against exact commit `853a14a` using `gpt-5.6-sol`,
  `xhigh` reasoning and fast service tier. Their accepted findings narrowed the
  executable first slice and are recorded in
  [`GENESIS-CORE-PLAN-CRITIQUE-2026-08-28.md`](research/GENESIS-CORE-PLAN-CRITIQUE-2026-08-28.md).
- Strict proposal/local-fixture separation, canonical manifest compiler,
  content-addressed READY-last artifact store and shared ABI/hash vector are
  implemented. Exact commit `d88edb4ffb2f7d3bfd7552b375bc5850cef5b835`
  passes Foundation 0.20, lint, TypeScript, 5 supply-domain tests and 30
  manifest tests on macOS arm64 and Linux Node 24.20.0.
- Immutable local-candidate `AGTMAIToken` is implemented without external
  mint/admin/proxy/pause/tax/blacklist paths. The code-identical Barrier 1
  commit passes 19 Foundry tests, including 10,000-run fuzzing and 65,536
  invariant calls, on macOS arm64 and Linux. This is local evidence, not an
  audit or production deployment approval.
- The local Anvil runner rebuilds with the pinned solc, deploys only to chain
  ID 31337, and is independently verified against trusted manifest, artifact,
  build-info, constructor input, runtime code, state and balances. Redirect,
  symlink, forged-evidence, parallel-run and interrupted-cleanup regressions pass.
- The current macOS arm64 full gate passes Foundation 0.20, lint, TypeScript,
  package tests, Linux-definition parity, canonical vectors, deterministic
  dependency/secret/license policy, 28 local-EVM tests and 3 isolated integration
  scenarios. No public RPC, real secret, real asset or paid gas was used.
- Five exact-SHA implementation critics and their remediation ledger are recorded
  in [`GENESIS-CORE-CODE-REVIEW-2026-08-28.md`](research/GENESIS-CORE-CODE-REVIEW-2026-08-28.md).
- The first final review of exact SHA `ec735a6` accepted Solidity and the
  holistic slice, and returned six blocking P1 findings across CI, manifest and
  local EVM. Commit `416ca13` closes all six with regression tests; same-SHA
  affected and holistic re-review is still required before Barrier 2.

## In progress

- Final Barrier 2 is pending only the remote three-job GitHub Actions run and
  affected plus holistic hosted re-review on the same final exact commit SHA.
  Concrete run ID, SHA and conclusions belong to the immutable workflow summary
  and final handoff; a local workflow-definition check is not called remote CI.

## Designed, not implemented

- Vesting, local SPL and mocked cross-chain accounting remain later independent
  slices. Production manifest approval is intentionally not simulated by a
  self-declared status or integrity hash.
- Feature-module standard from Agent Teams Orchestrator is adopted. The proposed
  two-context topology is recorded in ADR-0004 and awaits explicit acceptance.
  The local Genesis Core plan uses accepted ADR-0003 for the new manifest
  feature but leaves the generic bootstrap unchanged until ADR-0004 is accepted
  or rejected, avoiding a temporary double migration.
- Purpose-specific release/vesting vault proposal, rolling commitments and global
  liquidization budget; governance-reserve activation remains an explicit open
  decision and ABI blocker.
- Production genesis wiring, vesting and treasury contracts.
- Chainlink CCIP Ethereum and Solana pool configuration.
- CCIP EVM `1.6.4` versus `2.0.0` compatibility ADR and canonical backing-holder
  model for the live SVM `1.6.3` lane.
- Production tokenomics approval envelope/compiler; the implemented local
  fixture manifest/hash is deliberately test-only and cannot approve launch.
- Event-sourced cross-chain monitor and public transparency dashboard.
- Airdrop, liquidity and governance execution.
- Legal entity, launch jurisdictions, live utility and final tokenomics approval.

## Not proven locally

- Real CCIP offchain delivery between Ethereum and Solana. This requires an
  approved Sepolia-to-Solana Devnet test and must not be simulated as evidence.
- Mainnet addresses, signers, legal classification, audits or launch readiness.

No production token, sale, liquidity pool or official airdrop exists.
