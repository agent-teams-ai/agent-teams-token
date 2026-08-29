# AGTMAI zero-cost slices: implementation ledger

Status: Barrier 0 closed; Barrier 0.5 complete locally; prerequisite candidate
awaiting its immutable commit SHA, 2026-08-29.

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
  contracts with all 102 detectors. Slither JSON reported `success=true`;
  policy findings remain distinct from environment or execution failure;
- W3 must reproduce this tuple and enforce the production-source closure. The
  manual preflight is not final security-gate evidence.

### Architecture and local checks

- all three feature roots are governed by Foundation;
- each root uses `domain -> application -> adapters -> composition` dependency
  direction, with exact allowlists;
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
- final prerequisite commit SHA: pending.

## Hosted implementation jobs

All jobs must start from the same prerequisite SHA and use `gpt-5.6-sol`,
reasoning `medium`, no fast mode, separate jobs and isolated worktrees.

| Job | Branch | Owned path | Base | Commit | Result |
| --- | --- | --- | --- | --- | --- |
| W1 Solana | `feat/local-solana-fixture` | `tooling/local-solana/**` | pending | pending | pending |
| W2 deploy plan | `feat/deployment-cost-plan` | `tooling/deployment-plan/**` | pending | pending | pending |
| W3 Slither | `ci/slither-security-gate` | `tooling/security/slither/**` | pending | pending | pending |

## Integration and exact-SHA evidence

- prerequisite SHA: pending;
- W1 feature and root-wiring commits: pending;
- W2 feature and root-wiring commits: pending;
- W3 feature and CI-wiring commits: pending;
- integrated candidate SHA: pending;
- local full gate: pending;
- GitHub workflow/run/attempt/head/jobs evidence: pending.

## Independent hosted review

Four parallel specialist reviews must finish before the findings ledger is
frozen. A fifth independent holistic reviewer starts only afterwards. P0/P1
block completion, and every changed SHA requires fresh affected and holistic
review evidence.

| Review | Reviewer job | Reviewed SHA | Verdict | Findings |
| --- | --- | --- | --- | --- |
| Solana/SPL lifecycle | pending | pending | pending | pending |
| Deployment-plan safety | pending | pending | pending | pending |
| Slither/supply chain/CI | pending | pending | pending | pending |
| Architecture/Foundation/MVP | pending | pending | pending | pending |
| Holistic plan/evidence | pending | pending | pending | pending |

## Model-split delivery metrics

- time from W1/W2/W3 dispatch to first working patch: pending;
- targeted tests passing on first submitted worker commit: pending;
- review defects by severity: pending;
- remediation iterations to stable exact SHA: pending.
