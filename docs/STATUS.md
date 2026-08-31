# Project status

Last updated: 2026-08-30.

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

- The earlier remediation of nine retained P2 and six P3 zero-cost-slice
  findings has local evidence for Foundation full-scan routing, decoded-byte
  creation-input hashing, authenticated local-EVM recovery, owned Anvil ports,
  durable deployment publication, compiler-input identity, independent Slither
  evidence and fail-closed Solana evidence. R7 nevertheless returned `AMEND` on
  the current rollback delivery. Published history mixes slices and original
  isolated worker identities are `unavailable`. The remediation implementation
  is now integrated: each manifest application is followed by production-path
  rollback, exact tracked-byte/status/inventory comparison, strict survivor
  gates and a forbidden-residue check. Cleanup is descriptor-anchored,
  quarantined, exact-target allowlisted and bounded by entry/depth/path limits;
  symlinks are unlinked as link objects and deterministic child/final-directory
  substitution preserves the foreign identity and fails closed. Structural
  validation or preparation alone is still not the required exact/full proof.
- The accepted recovery review found five additional proof defects. Current
  remediation captures the byte-complete candidate immediately after
  exact-head/full-history validation and before checkout bootstrap/cache/
  workspace execution, then revalidates it afterward. Foundry and pnpm
  installations are compared against payloads freshly derived from the
  descriptor-opened repository-hash-pinned archives; solc is compared with its
  descriptor-opened executable archive. Mutable install provenance is not byte
  authority, no new inner digest was invented, and absent archive authority is
  reported explicitly. Recovery evidence now has a strict closed schema,
  independent exact-gate/artifact validation, deterministic canonical proof
  digest outside volatile telemetry and validated READY-last publication. CI
  uploads verified proof only after success and labels failure output as
  diagnostics. Every rollback architecture/script/history/test surface is
  mandatory Foundation full-scan routed with negative coverage.
- Final rollback-manifest shared/retained transitions were regenerated from the
  exact current worktree bytes. Current-byte coverage and production apply
  regressions pass as
  `REHASHED_WORKTREE_VALIDATED_PENDING_EXACT_HEAD_FULL_PROOF`; the earlier
  structural result remains invalid and must not be cited. Clean exact-head
  `--validate-only` awaits an externally created candidate commit because this
  remediation is explicitly no-commit. The current host lacks the complete offline Foundry, solc, pnpm and
  Agave archive cache set and cached Slither Docker image, so preflight stops
  before dependent gates and no full local proof is claimed.
- The rollback threat model is isolated local/CI execution at an exact commit
  with zero-cost identities; network access, public RPC and real secrets/assets
  are disabled. Kernel/filesystem descriptor semantics, fixed runtime,
  repository object database, the executing process and held descriptors are
  trusted; manifests, caches, command output and pathnames are
  untrusted. Symlink, mount and parent/child/final-name substitution before
  atomic quarantine or final identity revalidation are in scope and preserve a
  foreign identity. A continuously scheduled same-UID peer racing the separate
  final Node identity-check and unlink/rmdir syscalls, or the destination-
  absence check and following rename syscall, is explicitly out of scope, as is
  a root, capability-bearing or otherwise OS-privileged peer able
  to bypass mode `0700`, kernel or process-memory/descriptor compromise, and
  hostile runtime replacement. This proof is therefore not evidence against
  same-UID final-syscall races or privileged local peers; crash or `SIGKILL` may
  leave owned residue but never broadens cleanup.
- No custom cleanup helper remains. Linux x64 runtime provenance is now bound to
  the checksum-pinned Node `24.20.0` archive, independently pinned inner
  `bin/node` SHA-256, canonical install record, exact `process.execPath` and the
  loaded `/proc/self/exe` file identity/digest. Coherent binary/provenance
  substitution therefore fails the immutable inner hash. Darwin arm64 fails
  closed because an equivalent loaded-image binding is unavailable. The fixed
  Linux runtime is trusted only after these checks; later hostile replacement
  remains out of scope. This work is not an audit or production,
  Devnet or Mainnet readiness.
- Exact-head/full-history wiring is integrated into the existing
  `foundation-and-typescript` CI job. It checks out explicit `github.sha` with
  full history, rejects shallow/partial history, replacement refs, grafts and
  both environment/file object alternates, verifies pinned-baseline ancestry,
  captures complete tracked bytes before provisioning, runs non-pulling
  cache/tool preflight before root gates, reasserts history/clean identity, and
  uploads a verified proof only after independent validation; failures upload a
  separately named diagnostic subset.
  Hosted execution for these exact bytes remains pending, so no new CI success
  is claimed.
- Ethereum Mainnet deployment remains a mandatory owner TODO. Exact final
  constructor gas, every additional contract, live fees, total-cost guard and
  unsigned-plan review must be completed before any public broadcast. The
  current cheap local core estimate is not a whole-launch estimate.
- The three zero-cost follow-up slices (local SPL fixture, unsigned Ethereum
  deployment-cost plan and Slither/Linux security evidence) are implemented and
  historically accepted for local/test-only use at `4037e4b`; the current
  rollback patch is not accepted. The proxy-disabled local-Solana,
  deployment-plan and local-EVM adapters and their Foundation dependency
  declarations belong to coordinated external lanes, remain pending and are
  neither changed nor pre-approved here; the direct-HTTP P1 stays open. They are
  followed by authoritative exact-SHA CI and fresh specialist/holistic review.
  CI source integration is present but its hosted result remains pending, and
  public-chain work remains separately gated.

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
