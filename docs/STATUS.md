# Project status

Last updated: 2026-08-29.

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
- The local Solana fixture now completes a real classic SPL Token lifecycle on
  checksum-pinned Agave 4.2.1: supply `0 -> 1,000 -> 0`, freeze authority is
  irreversibly removed for the fixture, signed restore/freeze attempts fail,
  parallel runs remain isolated and no key material is retained. All 23 tests
  pass locally at real asset cost `$0`.
- The unsigned Ethereum deployment planner now binds the exact creation input,
  immutable test-only trust roots, buffer, fee-history/block facts and strict
  `blockTimestamp <= observedAt <= now < expiresAt` ordering. Its READY-last
  output uses an exclusive owned `0700` directory and rejects symlink,
  replacement and pre-existing-target attacks. All 24 tests pass, including a
  fresh Forge build and real loopback Anvil estimate; there is no signer or
  broadcast capability.
- The pinned Slither gate now runs the real Trail of Bits image digest as its
  immutable non-root user, mounts checksum-pinned Forge 1.8.0 and solc 0.8.36,
  analyses the six-file production closure with all 101 expected detectors and
  emits READY-last evidence. The real container reports 11 visible
  informational findings and zero blocking findings; all 41 unit/contract
  tests pass. This is static-analysis evidence, not an audit.
- Engineering Foundation 0.20.0 governs all three new feature roots with exact
  entrypoints and `domain -> application -> adapters -> composition` edges;
  full coverage currently reports zero diagnostics.
- Five exact-SHA implementation critics and their remediation ledger are recorded
  in [`GENESIS-CORE-CODE-REVIEW-2026-08-28.md`](research/GENESIS-CORE-CODE-REVIEW-2026-08-28.md).
- The first final review of exact SHA `ec735a6` accepted Solidity and the
  holistic slice, and returned six blocking P1 findings across CI, manifest and
  local EVM. Commit `416ca13` closes all six with regression tests.
- Frozen code candidate `816bb10dc305741cb3ce7b0d5603aa6828c44732`
  passed all three Linux GitHub Actions jobs in run `33192539415`: Solidity,
  Foundation/TypeScript and isolated local-EVM E2E. Three affected exact-head
  hosted reviews returned `ACCEPT` with no findings. The holistic review found
  no code defect and requested only that this completed evidence replace the
  stale pending text in the review ledger.
- Barrier 2 is closed for the frozen code candidate. The evidence-recording
  documentation commit does not change product code and must independently
  retain green exact-head CI before merge.

## In progress

- The three local zero-cost slices were explicitly owner-approved for E2E
  implementation on 2026-08-29. Barriers 0, 0.5 and targeted implementation are
  closed. Solana, the deployment planner and Slither were integrated locally;
  exact SHA `881f1bed74692cd70986240cbba076500ab401e9` passed the full local gate
  and all six jobs in GitHub Actions run `33242942132`. Four specialist critics
  and one subsequent holistic critic nevertheless confirmed thirteen P1
  code/evidence defects, so that green candidate is not accepted. Three isolated
  remediation jobs are active; a new full local gate, exact-head CI, four fresh
  specialist reviews and a subsequent holistic review remain mandatory. The
  complete ledger is in
  `docs/research/NEXT-ZERO-COST-SLICES-CODE-REVIEW-2026-08-29.md`. These slices
  do not depend on unresolved tokenomics, vesting, governance, CCIP or liquidity
  decisions.
- Ethereum Mainnet deployment remains a mandatory owner TODO. Exact final
  constructor gas, every additional contract, live fees, total-cost guard and
  unsigned-plan review must be completed before any public broadcast. The
  current cheap local core estimate is not a whole-launch estimate.
- The three zero-cost follow-up slices (local SPL fixture, unsigned Ethereum
  deployment-cost plan and Slither/Linux security evidence) have an amended
  executable plan in `docs/NEXT_ZERO_COST_SLICES_PLAN.md`. Four independent
  hosted `gpt-5.6-sol xhigh` critics reviewed exact draft SHA `1cd5515` without
  fast mode; all returned AMEND, none found P0, and accepted P1/P2 are recorded
  in `docs/research/NEXT-ZERO-COST-SLICES-PLAN-CRITIQUE-2026-08-29.md` and folded
  into the plan. Initial implementation is complete, but review remediation and
  replacement exact-SHA evidence collection are in progress.

## Designed, not implemented

- Vesting and mocked cross-chain accounting remain later independent slices.
  The implemented local SPL fixture is test-only and proves neither production
  mint authority nor CCIP. Production manifest approval is intentionally not
  simulated by a self-declared status or integrity hash.
- Feature-module standard from Agent Teams Orchestrator is adopted. The proposed
  two-context topology is recorded in the independently reviewed and amended
  ADR-0004 and awaits explicit product-owner acceptance. Acceptance records the
  target only; package migration remains a later separately gated change.
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
