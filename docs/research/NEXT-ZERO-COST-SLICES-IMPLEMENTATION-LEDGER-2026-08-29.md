# AGTMAI zero-cost slices: implementation ledger

Status: Barriers 0, 0.5 and 1 closed. Barrier 2 implementation and two review
remediation cycles are integrated. The latest P1 corrections are locally green;
a new exact-head CI run and independent four-plus-one re-review remain
mandatory, 2026-08-29.

This ledger is append-only evidence for
[`NEXT_ZERO_COST_SLICES_PLAN.md`](../NEXT_ZERO_COST_SLICES_PLAN.md). A changed
candidate SHA invalidates every earlier CI or review result unless the plan
explicitly says otherwise.

## Barrier 0 - reviewed plan

- reviewed plan and accepted-critique base: `3fc2a2f0fc1efe34a7eada21bef0d14fa924e15a`;
- four independent hosted plan critics completed with `gpt-5.6-sol`, `xhigh`,
  read-only and no fast mode;
- accepted, rejected and deferred findings are recorded in
  [`NEXT-ZERO-COST-SLICES-PLAN-CRITIQUE-2026-08-29.md`](NEXT-ZERO-COST-SLICES-PLAN-CRITIQUE-2026-08-29.md);
- the owner's instruction to implement the plan end to end is the explicit
  implementation approval;
- tokenomics, governance, vesting, public-network deployment and liquidity
  remain outside this execution.

## Barrier 0.5 - pinned prerequisite evidence

### Agave and SPL

- upstream release: `anza-xyz/agave` `v4.2.1`, published 2026-08-13;
- macOS arm64 archive SHA-256:
  `9fb744917877acc68ae2421aef8d7f44f0d5eb16428e9d3db2c98b1ae61fd239`;
- Linux x64 archive SHA-256:
  `7f35f92c15861263bc540c001466678d2da228149a107b51d5b65ce497603074`;
- both platforms report Solana CLI, keygen and validator `4.2.1`, and SPL token
  CLI `5.6.1`;
- every required inner executable has a platform-specific SHA-256 in
  `tooling/toolchain.lock.json` and is verified after extraction;
- real macOS arm64 cold fetch, install and verify completed from the pinned
  archive; the Linux binaries were extracted, hash-verified and version-checked
  in an isolated `linux/amd64` container;
- toolchain contract tests cover the Solana-only scope and reject a tampered
  inner binary.

### Slither compatibility amendment

- official image: Trail of Bits Ethereum Security Toolbox
  `nightly-20260824`;
- `linux/amd64` manifest digest:
  `sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0`;
- multi-platform index digest:
  `sha256:10c058d04f18a572f003e786ecf4e7f396a64137b2d6a9484fff2996621535a8`;
- OCI source revision: `8cad443280f7eeb5920a901b5f58f5a91872d9aa`;
- image tools: Slither `0.11.6`, crytic-compile `0.4.2`, solc `0.8.36`, embedded
  Forge `1.7.1`;
- confirmed plan defect: embedded Forge does not equal the project's pinned
  Forge `1.8.0`;
- accepted amendment: keep the official image unchanged, checksum-verify and
  mount the project's official Forge `1.8.0` and solc
  `0.8.36+commit.8a079791` Linux binaries read-only, force their exact paths,
  and verify all version outputs before analysis;
- compatibility proof: exact Forge prebuild with tests and scripts skipped,
  followed by Slither `--foundry-ignore-compile`, analysed ten production
  contracts. Slither JSON reported `success=true`; policy findings remain
  distinct from environment or execution failure;
- correction: the initial manual note counted `102` detectors. A clean read from
  exact image digest `sha256:9c5836...82d0` reports `101` unique detector IDs.
  The `102` count is superseded and cannot be used as acceptance evidence;
- W3 must reproduce this tuple and enforce the production-source closure. The
  manual preflight is not final security-gate evidence.

### Architecture and local checks

- all three feature roots are governed by Foundation;
- each root uses `domain -> application -> adapters -> composition` dependency
  direction. The prerequisite defined the exact edges, while W1 integration
  exposed that empty entrypoint declarations did not authorize any real
  cross-layer import. Commit `6f55d10` adds explicit Solana entrypoints and
  builtins; Foundation full coverage then passes with zero diagnostics;
- negative tests reject an adapter dependency from domain, a missing domain
  edge, an absent governed root and an incomplete policy fixture;
- prerequisite targeted result: 20 tests passed, zero failed; targeted
  `oxlint --deny-warnings` passed; `git diff --check` passed;
- the first full gate caught pnpm rewriting `autoInstallPeers` to `true` while
  refreshing lock metadata after a root script change. No dependency changed;
  diagnosis showed that the command had used the global Corepack shim instead
  of the verified project environment. The lock setting was restored to the
  repository's fail-closed `false` policy; every authoritative rerun sources
  `scripts/env.sh` and therefore uses the checksum-pinned project toolchain;
- full gate passed with the checksum-pinned project Node/pnpm/Foundry/solc,
  Foundation full coverage, lint, TypeScript, unit suites, Linux parity, Compose
  validation, Genesis vector, security checks and local-EVM adversarial tests;
- final prerequisite commit SHA:
  `b7a868f85d89c4bb7a9aeed1d854a5f949306a45`.

## Hosted implementation jobs

All jobs must start from the same prerequisite SHA and use `gpt-5.6-sol`,
reasoning `medium`, no fast mode, separate jobs and isolated worktrees.

| Job | Branch | Owned path | Base | Commit | Result |
| --- | --- | --- | --- | --- | --- |
| W1 Solana | `feat/local-solana-fixture` | `tooling/local-solana/**` | `b7a868f` | `4ce469a`, hardened by `104f5cc` | integrated; 23/23 including real and parallel Agave |
| W2 deploy plan | `feat/deployment-cost-plan` | `tooling/deployment-plan/**` | `b7a868f` | `9bba062`, hardened by `66dcd22` | integrated; 24/24 including fresh Forge/real Anvil and adversarial output-path tests |
| W3 Slither | `ci/slither-security-gate` | `tooling/security/slither/**` | `b7a868f` | `d55f2ac`, hardened by `dda858c` | integrated; 41/41 plus real pinned-image run, 101 detectors, zero blocking findings |

The first hosted W2 remediation fixed compiler evidence and strict lint, but
integrator review found three additional P1 gaps: the gas buffer/expiry were not
fully trust-root-bound, independent RPC verification omitted quoted base fee and
block facts, and output-directory ownership/substitution was not fail-closed.
Commit `66dcd22` closes those gaps with regression tests. The first hosted W3
remediation passed unit tests but failed against the real pinned image because
it required a nonexistent image `PYTHONPATH`; subsequent real-container checks
also exposed the wrong numeric user and missing Foundry output-directory flags.
Commit `dda858c` closes all three runtime gaps and proves the complete container
path. Green unit tests alone were deliberately not accepted as E2E evidence.

## Integration and exact-SHA evidence

- prerequisite SHA: `b7a868f85d89c4bb7a9aeed1d854a5f949306a45`;
- W1 feature commits: `4ce469a`, `104f5cc`; root-wiring commit: `6f55d10`;
- W2 feature commits: `9bba062`, `66dcd22`;
- W3 feature commits: `d55f2ac`, `dda858c`;
- shared root/Foundation/CI wiring commit: `fc834c5`;
- first reviewed candidate SHA:
  `881f1bed74692cd70986240cbba076500ab401e9`;
- targeted local evidence: Foundation full coverage with zero diagnostics;
  deployment plan 24/24 with real Anvil; Slither 41/41 plus real pinned-image
  clean policy result with 101 detectors and 11 visible informational findings;
- local full gate: passed on the first reviewed candidate, including real Agave,
  real Anvil and the exact pinned Slither container;
- exact-head GitHub Actions run
  [`33242942132`](https://github.com/agent-teams-ai/agent-teams-token/actions/runs/33242942132),
  workflow `CI`, event `workflow_dispatch`, attempt `1`, head
  `881f1bed74692cd70986240cbba076500ab401e9`: all six required jobs passed;
- the green execution evidence did not detect thirteen P1 code/evidence defects
  accepted by the independent review. It is superseded for final acceptance;
  remediation requires a new candidate and complete exact-SHA gate.

## Independent hosted review

Four parallel specialist reviews must finish before the findings ledger is
frozen. A fifth independent holistic reviewer starts only afterwards. P0/P1
block completion, and every changed SHA requires fresh affected and holistic
review evidence.

| Review | Reviewer job | Reviewed SHA | Verdict | Findings |
| --- | --- | --- | --- | --- |
| Solana/SPL lifecycle | `agtmai-review881-solana-r2` | `881f1be` | AMEND | schema, semantic decoding, SIGKILL ownership and cross-process ports |
| Deployment-plan safety | `agtmai-review881-deployment-r2` | `881f1be` | AMEND | verifier independence, publication, filesystem, roots and strict parsing |
| Slither/supply chain/CI | `agtmai-review881-slither-r2` | `881f1be` | AMEND | clean-tree binding, complete targets, real fixture and exit matrix |
| Architecture/Foundation/MVP | `agtmai-review881-architecture-r2` | `881f1be` | AMEND | confirmed cross-lane findings and two layer-boundary P2s |
| Holistic plan/evidence | `agtmai-review881-holistic-r1` | `881f1be` | AMEND | no P0; thirteen deduplicated P1 root causes |

The immutable input hashes, complete adjudication and mandatory recheck are in
[`NEXT-ZERO-COST-SLICES-CODE-REVIEW-2026-08-29.md`](NEXT-ZERO-COST-SLICES-CODE-REVIEW-2026-08-29.md).

## Review remediation and local recheck

All remediation jobs start from `881f1be`, use `gpt-5.6-sol` with `medium`
reasoning and the default service tier, and own non-overlapping paths.

The initial hosted remediation lanes were supplemented by narrowly scoped
follow-up workers and integrator fixes whenever real-runtime or repository-wide
checks exposed a gap. No public network or paid RPC was used.

| Lane | Integrated commits | Local result |
| --- | --- | --- |
| Deployment | `fa3417f`, `d9f5fdc` | strict independent RPC and input verification, race-resistant publication; 34/34 unit/adversarial tests plus 1/1 real loopback Anvil |
| Solana | `fb05b96`, `87fc105`, `2dbfc0c`, `7b0227e`, `dc56d4d` | real Agave lifecycle and parallel-process E2E: 37 passed, 0 failed, 1 Darwin-inapplicable Linux procfs test skipped |
| Slither | `d029c00`, `a5978ad`, `3a887a8`, `b6f3636`, `4905d3f` | exact clean-tree execution/evidence binding, complete source closure, 11 visible findings triaged without suppressions; 57/57 tests |

The Solana real-runtime recheck found and fixed one additional integration bug:
the mint address was also the fixture freeze-authority address, and the custom
message compiler emitted it twice, causing Agave `AccountLoadedTwice`. Commit
`7b0227e` now deduplicates account keys, merges signer/writable roles and keeps
canonical key ordering; a focused regression test and the full native lifecycle
prove the fix.

Local candidate `4905d3ff63dfeb944707cc620a94e9a40cb019fe` passed the complete
`pnpm check` through the checksum-pinned project environment. This includes
Engineering Foundation `0.20.0` full coverage with zero diagnostics, strict
lint with zero warnings, TypeScript 7, domain and supply tests, Linux-parity and
workflow tests, Genesis vector, security scan, 28/28 local-EVM adversarial
tests, the real local Solana lifecycle and parallel fixture, deployment-plan
tests, and 57/57 Slither evidence/policy tests. The separately enabled real
deployment-plan Anvil test also passed 1/1.

This local SHA is evidence only, not the final frozen candidate. Updating this
ledger changes `HEAD`; acceptance still requires a clean documentation commit,
one new exact-head six-job CI run, four fresh specialist reviews and a subsequent
holistic adjudication with no P0/P1 findings.

### Exact-head CI correction

Exact-head GitHub Actions run
[`33252045534`](https://github.com/agent-teams-ai/agent-teams-token/actions/runs/33252045534)
at `d7c50a158228afcca30f2f42d22c19b853442b43` passed Solidity, Foundation and
TypeScript, local Solana E2E, local EVM E2E and deployment-plan E2E. Only the
Slither job failed with a finalized, schema-valid `output-failure` artifact and
`SLITHER_EXIT_INVALID`; the failed evidence was uploaded rather than hidden.

Reproduction in the exact pinned Linux image established that Slither `0.11.6`
under pedantic finding policy returns shell status `255` with `success=true`,
no analysis errors and non-empty findings. The earlier matrix incorrectly
treated this documented finding outcome as a tool crash. Commit `7e7f330`
passes `--fail-on pedantic` explicitly, accepts only the exact finding-aware
status matrix and keeps every unknown/signal-derived combination fail-closed.
coverage. Strict lint, TypeScript 7 and all 58 Slither tests pass locally. A
real-image check then found that Slither `0.11.6` spells the explicit option
`--fail-pedantic`, not `--fail-on pedantic`; commit `7915bc6` corrects every
invocation and pins the supported spelling in contract tests.

Candidate `7915bc6b7294e3551f70e2be3e163a6d059698b0` passed the real pinned
Linux container gate: 101 detectors, 8 observed targets, 11 visible
informational findings, 0 blocking findings and 0 suppressions. The finalized
evidence bundle validated independently; `evidence.json` SHA-256 is
`cd492a5550721264ff0408641c09dc82eb6bf29bad4adcba86d80982882db9b5`.
The same candidate passed complete `pnpm check`, including real Agave and two
parallel fixture processes, plus the separately enabled real loopback Anvil
test 1/1. Updating this ledger creates the final documentation candidate, so
one exact-SHA local recheck and replacement CI/review evidence remain required;
run `33252045534` is superseded and is not success evidence.

### First fresh specialist review and second remediation cycle

Exact-head run
[`33254830057`](https://github.com/agent-teams-ai/agent-teams-token/actions/runs/33254830057)
passed all six jobs at
`405fe8ef69177fb0e9cd2897d5c97d548f444743`. Four parallel read-only hosted
specialists reviewed that exact clean SHA with `gpt-5.6-sol`, `xhigh` and no
fast mode. No P0 was reported; the blocking findings and integrated corrections
are:

| Lane | Reviewer | Integrated correction | Result |
| --- | --- | --- | --- |
| Local EVM | `agtmai-review405-deployment-r2` | `031a4f0` | strict nonce parsing and independent RLP/Keccak CREATE-address binding; 3/3 real isolated Anvil scenarios pass |
| Solana | `agtmai-review405-solana-r2` | `f9bd48c` | zero pre-mint supply and process-start-bound parent leases; 42 applicable tests pass, including both real fixture E2Es |
| Slither | `agtmai-review405-slither-r2` | `e1a4ec4`, `0cf6415` | exact exit-file grammar and strict error shapes, compatible with canonical `null`; 61/61 tests and the pinned real image pass |
| Deployment | `agtmai-review405-deployment-r2`, confirmed by architecture review | `c429c0e` | trusted repeated clock reads plus sender nonce, CREATE address and observed-block identity; 42/42 applicable tests and 1/1 real Anvil pass |

The four immutable specialist result hashes and finding details are recorded in
[`NEXT-ZERO-COST-SLICES-CODE-REVIEW-2026-08-29.md`](NEXT-ZERO-COST-SLICES-CODE-REVIEW-2026-08-29.md).
The pinned real Slither run after the compatibility correction produced a valid
clean evidence bundle with SHA-256
`d452483fba00fb6c4494610dc42ffae22be6dce862a49af5dacda44f685be829`.
No public RPC, asset, secret or paid gas was used.

These commits change the reviewed SHA. They therefore require one final clean
`pnpm check`, a replacement exact-head six-job CI run, four fresh specialist
reviews and a subsequent holistic adjudication before Barrier 3 can close.

## Model-split delivery metrics

- time from the final lint-worker dispatches to reviewed patches: approximately
  11-13 minutes per lane;
- targeted tests passing on the accepted final worker commits: deployment,
  Solana and Slither all passed; native Solana was independently rerun by the
  integrator;
- review defects by severity: first holistic round found `0` P0 and `13`
  deduplicated P1 root causes, plus visible P2/P3 follow-ups;
- remediation iterations to a locally stable candidate: one specialist review
  round followed by focused remediation and real-runtime follow-ups; final
  exact-SHA re-review remains pending.
