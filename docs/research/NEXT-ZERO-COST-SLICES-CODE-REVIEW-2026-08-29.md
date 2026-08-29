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
