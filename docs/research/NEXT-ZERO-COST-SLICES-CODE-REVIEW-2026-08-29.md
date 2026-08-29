# Zero-cost slices implementation review ledger - 2026-08-29

## Frozen candidate and custody

Four independent specialist critics reviewed exact clean commit
`881f1bed74692cd70986240cbba076500ab401e9` with `gpt-5.6-sol`, `xhigh`
reasoning and the default service tier. A fifth holistic critic started only
after the four result files were frozen and hashed. The review worktrees stayed
detached and clean; the critics made no product edits.

Exact-head GitHub Actions run
[`33242942132`](https://github.com/agent-teams-ai/agent-teams-token/actions/runs/33242942132)
passed all six jobs: Solidity, Foundation and TypeScript, local Solana E2E,
Solidity security, local EVM E2E and deployment-plan E2E. A green run is useful
execution evidence, but it does not override defects that its tests did not
detect.

| Review | Job | Frozen result SHA-256 |
| --- | --- | --- |
| Architecture/Foundation | `agtmai-review881-architecture-r2` | `0be0c0ea8da3d1390bdc1fd524bc812ad399190831fe122cbdc1f1a480ae3820` |
| Deployment plan | `agtmai-review881-deployment-r2` | `c2cb46dc1cce3a555d42150e5df5f9fa7416e3839a3ac7745004aad9b347e446` |
| Slither/security | `agtmai-review881-slither-r2` | `e587bd1fd142ee9fd96a7530b6c9dcf46e7c792364a1a27895d4d55cf6eb64ce` |
| Solana lifecycle | `agtmai-review881-solana-r2` | `83243f3da08b63d70c4ec0782682c93eb256bd33d9f3f17e5b4166813abce852` |
| Holistic adjudication | `agtmai-review881-holistic-r1` | consumed the four immutable inputs above |

## Holistic verdict

`AMEND`: no P0 remained, but thirteen deduplicated P1 root causes block
acceptance.

### Deployment plan

1. Builder and verifier trusted the same encoded artifact, so a coherent
   encoder defect could verify itself.
2. A published bundle was verified offline without re-reading the RPC facts.
3. Output publication checked a directory handle but reopened the leaf through
   a pathname, leaving a check/open substitution race.
4. Standalone verification accepted caller-supplied roots without the builder's
   strict local-only policy.
5. Bundle parsing used a permissive JSON cast instead of duplicate-key,
   exact-key, schema and semantic validation.

The accepted P2 extensions are explicit `uint256` bounds and exact one-block
fee-history/base-fee consistency.

### Solana lifecycle

6. The advertised schema permitted six transactions while the lifecycle
   produced and required seven, and publication did not validate the serialized
   report before `READY`.
7. Transaction kinds were caller labels rather than independently decoded
   instruction, account, signer and failure-index facts.
8. Parent `SIGKILL` recovery could delete run state without first identifying,
   terminating and awaiting the orphan validator.
9. Port reservations were process-local and released before validator binding,
   so separate fixture processes could collide.

The accepted P2 extension moves RPC transport parsing out of the domain layer.

### Slither gate

10. Local evidence was bound to `HEAD`, but not to a clean worktree before
    inputs and again before `READY`.
11. A new tracked standalone production Solidity source could bypass the
    hard-coded analyzed closure.
12. The analyzed-target claim came from Forge metadata, while the vulnerable
    fixture test fabricated Slither JSON instead of exercising the pinned
    container.
13. JSON declaring success could be accepted with abnormal process statuses,
    including signal-derived exits.

The accepted P2 extensions validate every evidence variant against its schema,
record fingerprint-level triage for the eleven current informational findings,
and move gate orchestration into the application layer.

## Remediation and mandatory recheck

Three isolated implementation workers own non-overlapping paths:

| Lane | Worker | Ownership |
| --- | --- | --- |
| Deployment | `agtmai-remed881-deployment-r1` | `tooling/deployment-plan/**` |
| Solana | `agtmai-remed881-solana-r1` | `tooling/local-solana/**`, `scripts/solana/local-fixture.ts` |
| Slither | `agtmai-remed881-slither-r1` | `tooling/security/slither/**` |

Each lane must add fault-injection or real-runtime regressions for its assigned
root causes and commit from the same base. Integration requires all pinned local
gates, real Agave, real Anvil and the pinned Slither container, followed by one
new exact-SHA six-job GitHub run. Four fresh specialist reviews then run on that
same SHA; only after their immutable results are frozen may a new holistic
critic adjudicate them. Any remaining P0 or P1 starts another remediation and
review cycle.

This review is engineering evidence, not a security audit or permission for a
public-network deployment.

## Remediation checkpoint

All thirteen accepted P1 root causes have an integrated implementation and
regression evidence on local candidate
`4905d3ff63dfeb944707cc620a94e9a40cb019fe`. The resulting change from the
first reviewed candidate is 14 commits and approximately 3,612 insertions plus
688 deletions across implementation, tests, CI evidence validation and review
records.

The complete local `pnpm check` passes from the checksum-pinned project
toolchain. In particular, real Agave proves the seven-step zero-supply
lifecycle and two parallel fixture processes, real loopback Anvil proves the
unsigned deployment estimator, and Slither evidence tests prove exact-SHA,
clean-tree, schema and outcome binding. The 11 informational Slither findings
remain visible and are individually triaged; the suppression ledger remains
empty.

This checkpoint does not change the original `AMEND` verdict. The documentation
commit creates a new candidate SHA, so four fresh `gpt-5.6-sol` `xhigh`
specialist reviews and a later holistic adjudication must examine that exact
clean SHA after its six-job GitHub Actions run. Only a result with no P0/P1 can
replace the original verdict.

## First post-remediation CI finding

Run
[`33252045534`](https://github.com/agent-teams-ai/agent-teams-token/actions/runs/33252045534)
reviewed exact commit `d7c50a158228afcca30f2f42d22c19b853442b43` and passed five of six
required jobs. The Slither job failed closed and uploaded a validated failure
bundle. Exact-image diagnosis showed a real acceptance defect: Slither `0.11.6`
returns `255` for a completed pedantic analysis containing findings, even when
its JSON says `success=true` and contains no analysis error.

The focused corrections are `7e7f330`, `0e81e87` and `7915bc6`. They explicitly
pin the supported `--fail-pedantic` behavior and exhaustively test 7,224
combinations of JSON success, errors, finding counts and process statuses.
Lower-impact findings still flow to visible per-fingerprint triage; High and
Medium findings still block; tool errors and all unrecognized outcomes still
fail closed.

Candidate `7915bc6b7294e3551f70e2be3e163a6d059698b0` passed strict lint,
TypeScript 7, 58/58 Slither tests and the real pinned Linux image with 101
detectors, 11 visible informational findings, 0 blocking findings and 0
suppressions. Its independently validated `evidence.json` SHA-256 is
`cd492a5550721264ff0408641c09dc82eb6bf29bad4adcba86d80982882db9b5`.
Complete `pnpm check` and the separately enabled real Anvil test also passed.
This remains a remediation checkpoint, not a replacement review verdict: the
documentation commit requires exact-head CI and fresh four-plus-one review
evidence.

## First fresh specialist review of the corrected E2E candidate

Exact-head GitHub Actions run
[`33254830057`](https://github.com/agent-teams-ai/agent-teams-token/actions/runs/33254830057)
passed all six jobs at
`405fe8ef69177fb0e9cd2897d5c97d548f444743`. Four independent read-only
`gpt-5.6-sol` `xhigh` specialists then reviewed that same clean SHA. Their
frozen result hashes are:

| Review | Job | Frozen result SHA-256 |
| --- | --- | --- |
| Architecture/Foundation | `agtmai-review405-architecture-r2` | `f4ef2bd8709e54b68fe1182cc4f431158957270787121f19ced65205ec2c0037` |
| Deployment plan and local EVM | `agtmai-review405-deployment-r2` | `505907c505603a7ba9bc3cee174a067c7b1b80c3cda2ec6c6ad40f4c7708fe4b` |
| Slither/security | `agtmai-review405-slither-r2` | `54bcfd9b614aa0e08b5133b6209ce407d8d429daad87531a11e7fd2fa91503c6` |
| Solana lifecycle | `agtmai-review405-solana-r2` | `dbf706b82ebf9f490da1eea184c164079668415724865c12bd82dc2fb9c2aa0c` |

The specialists found no P0 and four blocking P1 root causes:

1. the local-EVM verifier did not independently derive the direct CREATE
   address from the transaction sender and nonce;
2. the unsigned deployment identity omitted the sender nonce and expected
   CREATE address, while freshness used a frozen caller-controlled time;
3. Solana evidence did not require zero supply immediately before minting, and
   stale-run reclamation could confuse PID reuse with the original parent;
4. malformed Slither error fields or prefix-valid exit files could be accepted
   as clean.

The architecture specialist retracted its initial concern about retaining a
complete READY bundle after post-publication RPC drift: READY means immutable
bundle completeness, while current RPC validity is a separate mandatory check.
This contract is now explicit in the deployment-plan README.

Commits `031a4f0`, `f9bd48c`, `e1a4ec4`, `c429c0e` and `0cf6415` remediate the
four P1 roots. The final Slither correction is intentionally split: strict
shape validation remains fail-closed, while the canonical Slither `0.11.6`
success representation `error: null` and `results.errors: null` is accepted.
The exact pinned Linux image passes with 101 detectors, 11 visible
informational findings, 0 blocking findings and 0 suppressions. Its independently
validated local `evidence.json` SHA-256 is
`d452483fba00fb6c4494610dc42ffae22be6dce862a49af5dacda44f685be829`.

This is another remediation checkpoint, not final acceptance. The amended
documentation creates a new exact SHA. A replacement six-job CI run, four fresh
specialist reviews and one later holistic adjudication with no P0/P1 are still
mandatory.

## Final exact-SHA specialist and holistic acceptance

Immutable code candidate
`4037e4b52ad4d8a1180ee8c7bf771de0d88f0819` passed the complete local gate,
real Agave and Anvil E2E, the pinned Slither container and all six GitHub Actions
jobs in run
[`33258983415`](https://github.com/agent-teams-ai/agent-teams-token/actions/runs/33258983415).
The independently validated CI Slither evidence SHA-256 is
`df55aec680290d6d8b3513fc38dc3c75775fc96d5b1a0912303f992c69579dec`.

Four fresh specialists inspected separate clean detached worktrees of that
exact SHA. Their outputs were frozen before the holistic review started:

| Review | Job | Frozen result SHA-256 | Verdict |
| --- | --- | --- | --- |
| Architecture/Foundation | `agtmai-review403-new-architecture-r1` | `7eafebd87a9faf1081cd96755aa381382dfe8fee06075647e50c07c9143f06dd` | `ACCEPT`, no P0/P1 |
| Deployment plan and local EVM | `agtmai-review403-new-deployment-r1` | `56685369ac88e298bba5c122a06733a7e1b628f89fa14107b941675300b2b042` | no P0/P1; P2/P3 follow-ups |
| Slither/security | `agtmai-review403-new-slither-r1` | `eb001edee443f76a5e9a3a80045596d5533714e10dbc6f4900a05201d0f4ae0f` | `ACCEPT`, no P0/P1 |
| Solana lifecycle | `agtmai-review403-new-solana-r1` | `118b97f2eefbfd7a5ba6a29a8533cc06bcf24347b2ec67281a9e0049730f4d62` | `ACCEPT`, no P0/P1 |

The later `agtmai-review403-new-holistic-r1` job verified all four hashes,
deduplicated their findings, rechecked every prior P1 correction and returned
`ACCEPT` with no P0/P1 on the same exact SHA. Its immutable result SHA-256 is
`63ac52096a6875a68fc47f1eebcb9303396c2203e461a93dcd6499234a499cb2`.

The holistic scores are correctness 8.8/10, security 9.0/10, architecture
8.8/10, tests/evidence 9.2/10, maintainability 8.5/10 and MVP fitness 9.7/10.
No retained P2/P3 was upgraded to a completion blocker.

### Accepted non-blocking hardening queue

The nine P2 roots are Foundation changed-scan routing; unambiguous cross-tool
creation-input hashing; authenticated local-EVM orphan cleanup; owned Anvil
ports in the deployment integration test; derived Slither severities, counts
and human summary; documented macOS Docker image preparation; fail-closed
Solana live-lease handling; observation-to-report publication binding; and
sanitized post-mutation Solana failure evidence.

The six P3 roots are power-loss directory durability; complete compiler-input
identity; strict no-skip real Solana CI; removal of the application-layer
ambient-environment fallback; distinct Slither failure categories; and one
authoritative Slither CI definition. The alleged adapter-owned Slither policy
orchestration finding was rejected after independent boundary inspection.

Barrier 3 is closed for this frozen local/test-only code candidate. This review
is engineering evidence, not a security audit, tokenomics approval or permission
to deploy, sign, broadcast, create liquidity or use a public network.
