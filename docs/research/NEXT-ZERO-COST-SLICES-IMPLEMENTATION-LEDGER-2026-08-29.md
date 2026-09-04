# AGTMAI zero-cost slices: implementation ledger

Status: Barriers 0 through 3 are closed for immutable local/test-only code
candidate `4037e4b52ad4d8a1180ee8c7bf771de0d88f0819`. Exact-head CI, four
specialist reviews and the later holistic adjudication completed with no P0/P1,
2026-08-29. Retained P2/P3 hardening remains explicitly tracked and does not
authorize a public deployment.

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

These commits changed the reviewed SHA and therefore required the final
exact-head evidence recorded below.

## Final exact-SHA acceptance

Frozen code candidate
`4037e4b52ad4d8a1180ee8c7bf771de0d88f0819` passed the complete local
`pnpm check`, the separately enabled real deployment-plan Anvil test 1/1, the
isolated local-EVM integration suite 3/3, all 42 applicable Agave tests and the
real pinned Slither Linux-image gate. No public RPC, asset, signer, secret or
paid gas was used.

GitHub Actions run
[`33258983415`](https://github.com/agent-teams-ai/agent-teams-token/actions/runs/33258983415)
passed all six required jobs at that exact SHA. The independently downloaded
and validated CI Slither `evidence.json` SHA-256 is
`df55aec680290d6d8b3513fc38dc3c75775fc96d5b1a0912303f992c69579dec`.

Four parallel read-only hosted specialists reviewed clean detached checkouts
with `gpt-5.6-sol`, `xhigh`, default service tier and no fast mode. Their result
files were frozen before the separate holistic reviewer started:

| Review | Job | Frozen result SHA-256 | P0/P1 |
| --- | --- | --- | --- |
| Architecture/Foundation | `agtmai-review403-new-architecture-r1` | `7eafebd87a9faf1081cd96755aa381382dfe8fee06075647e50c07c9143f06dd` | none |
| Deployment plan and local EVM | `agtmai-review403-new-deployment-r1` | `56685369ac88e298bba5c122a06733a7e1b628f89fa14107b941675300b2b042` | none |
| Slither/security | `agtmai-review403-new-slither-r1` | `eb001edee443f76a5e9a3a80045596d5533714e10dbc6f4900a05201d0f4ae0f` | none |
| Solana lifecycle | `agtmai-review403-new-solana-r1` | `118b97f2eefbfd7a5ba6a29a8533cc06bcf24347b2ec67281a9e0049730f4d62` | none |

The later holistic job `agtmai-review403-new-holistic-r1` verified those four
hashes, independently inspected the same clean SHA and returned `ACCEPT` with
no P0/P1. Its immutable result SHA-256 is
`63ac52096a6875a68fc47f1eebcb9303396c2203e461a93dcd6499234a499cb2`.
Barrier 3 is closed for the frozen code candidate.

The accepted result retains nine P2 and six P3 hardening items. They include
Foundation changed-scan routing for non-TypeScript tooling changes,
cross-tool creation-input hash semantics, authenticated local-EVM orphan
cleanup, deployment-test port ownership, derived Slither evidence/summary
validation, macOS image preparation, fail-closed Solana lease/publication
binding and sanitized post-mutation failure evidence. The complete adjudication
and smallest regressions are recorded in the code-review ledger. These are not
silently represented as finished and must be considered before production use.

## Post-review P2/P3 remediation candidate

The nine P2 and six P3 roots retained by the accepted `4037e4b` review have all
been implemented in a new local candidate. The detailed one-to-one mapping is
recorded in `NEXT-ZERO-COST-SLICES-CODE-REVIEW-2026-08-29.md`. Local evidence
includes the complete root gate, 36 local-EVM unit/adversarial tests, four real
local-EVM lifecycle/interruption tests, 47 deployment-plan tests with real
Anvil, 46 passing local-Solana tests including the real lifecycle, and 64
Slither policy, schema, evidence and failure-taxonomy tests. The real pinned Slither container,
new exact-SHA GitHub jobs and replacement hosted reviews remain pending until
the candidate is frozen as a clean commit.

During final local E2E, two additional integration defects were found and fixed:
stale-run discovery now accepts the mixed-case random suffix emitted by macOS
`mkdtemp`, and the complete compiler-input trust root is derived from the real
pinned Forge build rather than a reduced test fixture. Both are protected by
the corresponding real integration paths.

This ledger entry is local engineering evidence only. It is not a security
audit, Mainnet approval, tokenomics decision or permission to sign/broadcast.

## Model-split delivery metrics

- time from the final lint-worker dispatches to reviewed patches: approximately
  11-13 minutes per lane;
- targeted tests passing on the accepted final worker commits: deployment,
  Solana and Slither all passed; native Solana was independently rerun by the
  integrator;
- review defects by severity: first holistic round found `0` P0 and `13`
  deduplicated P1 root causes, plus visible P2/P3 follow-ups;
- remediation iterations to a locally stable candidate: two specialist review
  rounds followed by focused remediation and real-runtime follow-ups; the final
  exact-SHA four-plus-one review returned `ACCEPT` with no P0/P1.

## Superseding correction — rollback provenance and current AMEND state

This appended correction supersedes the historical commit-DAG and per-slice
commit-group claims above without deleting, relabelling or rewriting them. The
published integration history does not contain three independently revertible
conventional commit groups. Published `4ce469a` is a direct child of prerequisite
`b7a868f`, but `9bba062` follows integrated Solana wiring `6f55d10`, `d55f2ac`
follows `9bba062`, `66dcd22` follows that integrated Slither change and
`dda858c` follows `66dcd22`. Commit `fc834c5` mixes deployment-plan and Slither
wiring, while later `e746ffa` changes all three slices.

Published commit ancestry is not original-worker provenance. No retained
isolated handoff identity is available for any of the three workers, so the
explicit provenance field below is `unavailable` for every row. A published
integrated commit must never be substituted into that field.

| Job | Historical branch | Owned path | Recorded brief base | Original isolated worker identity | Published integrated identities |
| --- | --- | --- | --- | --- | --- |
| W1 Solana | `feat/local-solana-fixture` | `tooling/local-solana/**` | `b7a868f` | `unavailable` | `4ce469a`, `104f5cc`; root wiring `6f55d10` |
| W2 deploy plan | `feat/deployment-cost-plan` | `tooling/deployment-plan/**` | `b7a868f` | `unavailable` | `9bba062`, `66dcd22`; mixed wiring `fc834c5` |
| W3 Slither | `ci/slither-security-gate` | `tooling/security/slither/**` | `b7a868f` | `unavailable` | `d55f2ac`, `dda858c`; mixed wiring `fc834c5` |

The R7 delivery review verdict is `AMEND`, not acceptance. Per-slice rollback
manifests and an executable proof are being remediated, but preparation or
structural validation alone is not an exact/full rollback proof. Acceptance
requires a clean exact candidate `HEAD`, a byte-complete tracked inventory and
hash, reproducible offline workspace dependencies, exact survivor complements,
genuine Genesis Core, Foundation, lint, typecheck, build and Foundry gates, two
strict real survivor gates with retained machine-readable command evidence, and
identity-bound cleanup that cannot recursively delete a substituted path. The
authoritative exact-SHA CI proof and fresh independent reviews remain pending.

The three rollback manifests deliberately keep their candidate-local
fingerprints while the feature lanes are still changing. In particular, every
`architecture/foundation/source-dependencies.yaml` reverse transition is known
stale after unrelated transport-manifest preparation was removed. Every
manifest-consuming validation, preparation or full-proof mode must stop as
`ROLLBACK_INTEGRATOR_REHASH_REQUIRED` before destructive work or gates. The
non-pulling environment-only preflight remains available and is not rollback
evidence. After the local-Solana, deployment-plan, Slither and external CI bytes
are final, the final integrator must regenerate each exact owned-path inventory,
all declared shared before/after transitions (workflow, Foundation, package,
workflow test, toolchain and slice entrypoint/stub paths) and retained-path
fingerprints. This is a pending integration requirement, not proven evidence.

The proxy-disabled local-Solana, deployment-plan and local-EVM transports and
their Foundation dependency declarations belong to coordinated external lanes
and remain pending. This rollback patch neither changes nor pre-approves those
still-changing feature/global-manifest bytes and does not close the direct-HTTP
P1. This correction is local engineering state only; it is not an audit,
production, Devnet or Mainnet readiness, or permission to sign or broadcast.

## Implementation update — integrated remediation, evidence still pending

This append-only update leaves every historical and superseding entry above
unchanged. The R7 delivery verdict remains `AMEND`, not acceptance. The current
candidate now integrates the concrete rollback remediation: exact owned/shared
manifest transformations, disposable complete-inventory materialization,
per-slice apply -> production rollback -> byte/status/inventory equivalence,
strict survivor gate coverage, forbidden-residue checks and retained
machine-readable command/stage evidence.

Production cleanup is descriptor-anchored and atomically quarantines only exact
allowlisted `checkout`/`gate-tmp` entries beneath private mode-`0700` parents. It
is bounded by entry count, depth and relative-path bytes, does not follow
symlinks, and does not authorize deletion from a pathname or prefix alone.
Adversarial boundary tests substitute children and final directories on the
real cleanup path; the foreign identity is preserved and cleanup fails closed.
The explicitly local/test-only model still excludes a continuously scheduled
same-UID peer in the micro-window between the last identity comparison and the
separate Node `rename`/`unlink`/`rmdir` syscall, as well as privileged peers,
kernel/process compromise, crash and resource-exhaustion guarantees.

No native cleanup helper is shipped. On Linux x64 the production runner now
requires checksum-pinned Node `24.20.0`, archive SHA-256
`2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2`
and independently pinned inner `bin/node` SHA-256
`89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7`.
It descriptor-verifies the lock, archive, binary and canonical provenance,
requires exact `process.execPath`/realpath, and binds `/proc/self/exe` to the same
loaded file identity and digest. Darwin arm64 fails closed because an equivalent
loaded-image binding is unavailable.

The existing `foundation-and-typescript` workflow job now contains the actual
exact-head/full-history integration. Its checkout uses explicit `github.sha`,
`fetch-depth: 0` and no persisted credentials. The verifier rejects shallow or
partial history, replacement refs, grafts, environment-provided alternates and
`.git/objects/info/alternates`; proves the pinned baseline ancestry and complete
reachable objects with replacements disabled; and runs both before gates and
under `if: always()` afterward. The first check also binds every tracked mode,
type and byte before Core/Solana bootstrap, frozen workspace install, Slither
image preload or the concrete non-pulling rollback preflight; the inventory is
revalidated afterward. Verified proof is uploaded only after independent
validation, while failure output is a separately named diagnostics artifact. The wiring is
integrated in source, but hosted execution at the final exact head remains
pending and no new CI success is recorded here.

Root and full-proof preflight now verifies the pinned runtime and every required
repository-pinned archive. Foundry/pnpm installed expected files are compared
with payloads re-derived from the verified open archive descriptor; solc is
copied from its descriptor-opened executable archive. Mutable provenance is
checked but cannot authorize bytes, missing archive authority is reported
explicitly and no separate Foundry/pnpm inner-file digest is claimed. It also
verifies the pnpm store and complete workspace links, absolute Docker client and
cached Slither image digest/platform/revision before
any dependent gate. This host lacks the complete offline
Foundry/solc/pnpm/Agave archive set and cached Docker image, so it must stop with
zero dependent gates and cannot produce full local proof evidence.

Recovery evidence now separates volatile diagnostics from a strict closed-
schema deterministic statement, canonical proof digest and seal. The
independent validator enforces exact baseline/slice/gate completeness and
referenced artifact bytes before READY-last publication; CI validates again
before a proof-labelled upload. Rollback architecture, scripts, history verifier
and every rollback test are mandatory full-scan routes with negative coverage.

These accepted recovery-review changes invalidated the prior manifest hashes.
Final shared/retained transitions were regenerated from exact current worktree
bytes. Current-byte coverage and production apply regressions pass as
`REHASHED_WORKTREE_VALIDATED_PENDING_EXACT_HEAD_FULL_PROOF`; clean exact-head
validation awaits the externally created candidate commit, so no stale or
uncommitted-head result is claimed. The proxy-disabled transports and Foundation dependency
declarations stay with their coordinated external lanes and the direct-HTTP P1
remains open. This update uses no network or public chain and is not an audit,
production, Devnet or Mainnet readiness, or permission to use a real identity,
sign or broadcast.

## Semantic rollback repair at c8d5d35a — NOT FULLY ACCEPTED

This rollback-only update starts from exact checkpoint
`c8d5d35a412ac85a69185201540ceab227a87148`, tree
`5b7f8227e3ccb199eb5da192bf14fadb42a46739`. It supersedes the older rollback
hash-maintenance status, without changing historical acceptance or provenance.
The manifests now enumerate the integrated deployment-plan and Slither additions
and bind the checkpoint's workflow, Foundation, package, workflow-test and
toolchain bytes. Reverse digests were calculated by applying the production
transformation in disposable checkouts; retained fingerprints use exact source
bytes. No hash assertion, ownership check or survivor requirement is removed.

Canonical temporary fixture paths preserve strict binary-path checks on Darwin.
The CLI regression requires clean committed validation before deliberately
committing drift, then requires rejection before materialization. Unpinned hash
maintenance checks the precise platform/version/path rejection; Darwin loaded
image binding still fails closed. Default preflight options now reach runtime
verification, with a regression requiring failure before any gate when the
runtime lock is absent.

Status remains R7 AMEND, not acceptance. Structural regressions are not a full
rollback proof. The source integration commit, pinned offline environment,
exact-head full local/hosted gates and independent acceptance remain pending.
This repair does not close the direct-HTTP finding or approve the proxy-disabled
transports and Foundation dependency declarations owned by coordinated external
lanes. No public RPC, wallet, secret or deployment is involved.
