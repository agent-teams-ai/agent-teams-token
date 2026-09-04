# Project status

Last reconciled: 2026-09-04. Earlier evidence below retains its original scope;
it must not be read as a current exact-head full-gate pass.

## Current execution checkpoint

Latest update at 12:42 UTC supersedes the earlier snapshots below:
toolchain checkpoint has independent ACCEPT and is integrated as `caedc5d6`.
Solc checkpoint `7926ace` passes all 7 actual Mac runner integration tests;
deployment checkpoint `d1bd4d95` passes 125 actual Mac tests including real
Anvil, with 3 Linux-only skips. Both await running independent fast reviews.
Recovery70 ended incomplete on process/namespace EAGAIN; its partial is
preserved and a fresh filesystem writer75 is active. Pinned-pnpm spike74 is
running independently. New jobs use priority/fast; implementation medium,
review xhigh. Full-plan acceptance remains open, not production clearance.

12:44 UTC: solc review73 found one new P2 in exposed error-cause stderr;
the two earlier P2s are closed. Dedicated fast writer77 is fixing only redaction
and its regressions before integration. No real key leak was observed.

Update at 12:05 UTC: `account-m` (`tv goog five`) passed a fresh live check.
Four new isolated hosted writers reached model execution: deployment-closure67,
toolchain-lint68, solc-p2-closure69 and recovery-custody70. All use medium,
no fast, network disabled; old partial workspaces remain untouched. The quota
snapshot below is historical. No new writer result has been accepted yet.

Update at 12:18 UTC: all four writers are active; toolchain68 resumed its
inspected partial changes after an intentional guidance interruption. A fifth
read-only xhigh planner is comparing minimal authenticated dependency-cache
designs for the next recovery checkpoint. Main is unchanged at `370c3aac`.

- Code candidate: `caedc5d6c055a769a686385ec1e61c93e44b1cfb`, in the isolated
  `/tmp/agtmai-r212-integration2` worktree. The user's original worktree is untouched.
- Native provenance remediation is integrated, but Foundation, TypeScript and
  lint are not green. Its remaining defects must be fixed before acceptance.
- The Darwin test portability fix is integrated and verified on actual macOS:
  focused native-helper tests: 17 passed, 0 failed, 3 Linux-only skips;
  deployment-plan suite: 120 passed, 0 failed, 4 skips, including the separate
  real-Anvil opt-in test. This is not a full E2E acceptance claim.
- The separately enabled real-Anvil suite fails: 2 passed, 1 failed, 0 skipped.
  The new shared JSON parser incorrectly applies the 64 KiB policy-file bound
  to real Forge build-info. A current valid build-info is 1,366,773 bytes and
  contains a 33,914-byte string, exceeding both the byte and string bounds.
- Local-EVM source review: AMEND, no P0/P1, two open P2 findings.
- Separate recovery source review: REJECT, seven P1 plus P2/P3 findings;
  portable filesystem custody and archive/package execution authority remain unproven.
- Four hosted writer attempts ended partial after quota exhaustion. Their dirty
  workspaces/patches remain isolated and are not accepted code. No r212 worker
  was alive at the 11:25 UTC reconciliation.
- Earlier hosted pool snapshot: no eligible account in the 25-slot registry.
  Those checks confirmed quota exhaustion for l/v/w/y/t and reconnect-required a/g;
  fresh account-m availability now supersedes that snapshot.
  Do not retry these before new capacity/auth evidence; no safety bypass.
- Full exact-head CI, independent final reviews and safe main reconciliation
  remain outstanding. No Mainnet or production clearance is implied.

See [the reconciliation ledger](research/E2E-RECONCILIATION-2026-09-04.md)
for exact source commits, remaining work and the safe continuation contract.

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
  parallel runs remain isolated and no key material is retained. The verifier
  also proves zero supply immediately before minting, and stale-run leases bind
  PID plus process-start identity. All 42 applicable tests pass locally at real
  asset cost `$0`.
- The unsigned Ethereum deployment planner now binds the exact creation input,
  immutable test-only trust roots, buffer, fee-history/block facts and strict
  `blockTimestamp <= observedAt <= now < expiresAt` ordering. Its READY-last
  output uses an exclusive owned `0700` directory and rejects symlink,
  replacement and pre-existing-target attacks. Sender nonce, deterministic
  CREATE address, observation block and repeated trusted-clock checks are part
  of the reviewed identity. All 42 applicable tests plus the real loopback
  Anvil test pass; there is no signer or broadcast capability.
- The pinned Slither gate now runs the real Trail of Bits image digest as its
  immutable non-root user, mounts checksum-pinned Forge 1.8.0 and solc 0.8.36,
  analyses the six-file production closure with all 101 expected detectors and
  emits READY-last evidence. The real container reports 11 visible
  informational findings and zero blocking findings; all 61 unit/contract
  tests pass, including hostile serialized-output cases. This is
  static-analysis evidence, not an audit.
- Engineering Foundation 0.20.0 governs all three new feature roots with exact
  entrypoints and `domain -> application -> adapters -> composition` edges;
  the full gate reports zero diagnostics. Changed-only routing for non-TypeScript
  files in those roots remains a recorded P2 follow-up and is not represented as
  complete Foundation coverage.
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
- Frozen zero-cost-slices code candidate
  `4037e4b52ad4d8a1180ee8c7bf771de0d88f0819` passed all six GitHub Actions
  jobs in run `33258983415`, the complete local gate, real Agave and Anvil E2E,
  and the pinned Slither container. Four independent specialist reviews and a
  later holistic `gpt-5.6-sol xhigh` adjudication inspected clean detached
  checkouts of that exact SHA. The holistic verdict is `ACCEPT` with no P0/P1;
  its immutable result SHA-256 is
  `63ac52096a6875a68fc47f1eebcb9303396c2203e461a93dcd6499234a499cb2`.
  Barrier 3 is closed for this code candidate. This is local/test-only
  engineering evidence, not an audit or public-deployment approval.

## In progress

- All nine retained P2 and six P3 zero-cost-slice findings now have a locally
  green remediation candidate. It adds Foundation full-scan routing, decoded-
  byte creation-input hashing, authenticated local-EVM orphan recovery, owned
  dynamic Anvil ports, durable deployment publication, full compiler-input
  identity, independently derived Slither evidence, fail-closed Solana lease
  and publication binding, sanitized post-mutation failure evidence, strict
  real-Solana CI and one canonical Slither job. The remaining acceptance work is
  a clean exact-SHA GitHub run plus repeated specialist and holistic reviews of
  that same SHA. This still grants no permission for public deployment.
- Ethereum Mainnet deployment remains a mandatory owner TODO. Exact final
  constructor gas, every additional contract, live fees, total-cost guard and
  unsigned-plan review must be completed before any public broadcast. The
  current cheap local core estimate is not a whole-launch estimate.
- The three zero-cost follow-up slices (local SPL fixture, unsigned Ethereum
  deployment-cost plan and Slither/Linux security evidence) are implemented and
  accepted for local/test-only use. Their P2/P3 remediation is locally green but
  awaits exact-SHA external acceptance; public-chain work remains separately
  gated.

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
