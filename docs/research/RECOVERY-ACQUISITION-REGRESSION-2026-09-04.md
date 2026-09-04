# Recovery command-log and directory-acquisition corrections

Candidate: `a7add0d9c546e91b8e1bc62e8857f0435852fd1e`.
Base for these changes: `aeb721dba1f48b5fd630a2ae50e4adfed6e1fa42`.
Worktree: `/tmp/agtmai-custody-76c-mac`.
Main-agent implementation while hosted subscription capacity is unavailable.
This is a bounded candidate, not acceptance of the full recovery base or E2E.

## Source checkpoints and scope

1. `644476bbd82f946a566cf94ee70c9b3c04cf6b0c`: command-log ownership,
   review120 P1 group3. Opening stdout, stderr and resolving the child invocation
   now happen within one protected ownership region. Every acquired descriptor
   receives one terminal close attempt, including partial acquisition failure.
   Local owners are disarmed before close; an uncertain close is never retried.
   Primary command/setup failure remains first, then close and reporting
   failures. Exit0 followed by failed close cannot produce a passed entry.
   Successful return shape is unchanged. Evidence-directory custody is NOT
   solved by this patch and remains review120 group2.
2. `9800ba91046f9ea03c23a49bb02da138146efe38`: common directory acquisition,
   one part of review120 P1 group4. Failures from stat, realpath or registration
   release the just-opened descriptor through the existing custody finalizer.
   Ownership transfers only after registration succeeds. An uncertain close
   preserves the acquisition failure and does not reuse the descriptor number.
3. `a7add0d9c546e91b8e1bc62e8857f0435852fd1e`: test-only portability correction.
   The test now calls `assertCustodyDescriptor` to check registry membership.
   `custodyDescriptorDirectory` only constructs a `/proc/self/fd` path on Linux,
   so expecting it to reject deregistration was an invalid cross-platform test.
   No production guard or Linux semantics changed in this correction.

Combined delta: six files, +526/-56. It includes 411 new test lines and two
explicit invariants in `docs/PLAN.md`. Production modules remain below the
Foundation 500-line limit; no lint/complexity limit was disabled. A small
private command-log close collector reuses the existing finalization contract,
without introducing a general resource-management framework or dependencies.

## Regressions and observed results

- Command tests before fix: 2/11 passed, nine failures reproduced leaks or
  masking. First fixed run was 6/11 because the test observer also counted
  readFileSync's later reopen; it was corrected to observe only O_CREAT opens.
  Two additional spawn/read failure cases brought the new suite to 13 tests.
- Mac command/descriptor/production/temporary finalization: 31/31, zero skips.
  Existing forced-analyzer and filtered-offline-environment checks: 2/2.
- Exact644476 Linux: validation passed; full structural suite 134/134,
  zero failures/skips, 210.58 seconds. This is not the full cached rollback gate.
- Directory tests before fix: 1/11 passed, ten failures reproduced leaked FDs.
  Fixed Mac directory suite: 11/11. Broader Mac custody/cleanup/finalization
  set at9800: 91/91, zero skips, 8.91 seconds.
- Exact9800 first Linux focused run: 81/91 passed, ten failed, zero skips.
  All ten failures were the invalid platform-dependent registry assertion
  described above. This failed log is preserved, not replaced by the rerun.
- Exacta7add Linux: validation passed; corrected focused set 91/91,
  zero failures/skips, 0.99 seconds, exit0, source clean afterward.
- Exacta7add Mac: the same focused set 91/91, zero failures/skips,
  7.53 seconds, exit0, fresh canonical `/private/tmp` fixtures.
- Scoped oxlint and `git diff --check aeb721d..HEAD`: pass on exacta7add.

The tests include actual close followed by EINTR and immediate descriptor-number
reuse, not just a mock that throws before close. They assert that all remaining
owned descriptors close, deregistration is complete, the reused descriptor
survives, and primary/secondary failures remain distinguishable.

## Exact transport and evidence

Ordinary Linux verifiers128-130 are shell/test processes, NOT hosted model jobs.
They do not occupy subscription-runtime registry numbers. Next free model-job
number remains127. Each verifier uses a new standalone clone from the exact
previous checkpoint plus a verified Git bundle, never a dirty worktree copy.

Oldhost machine-id: `be0aad971ea647fab370acd110b469b7`.
Before130: 9.2GiB disk available, approximately11.9GiB available memory,
4009MiB swap free; IO pressure avg10 some1.78/full1.75. The existing5GB disk
guard and memory guard stayed enabled. No new Node copy or dependencies added.
Pinned Linux Node SHA256:
`89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7`.

| Verifier | Exact source root | Bundle SHA256 |
|---|---|---|
| 128 | `/var/data/agtmai-custody128-linux.eyhAN2/source` | `44c5a28693a6c4f4b903f337ce96b4be0bfb28c605ed81377f23341a65b96d10` |
| 129 | `/var/data/agtmai-custody129-linux.RYNHqg/source` | `990dd9412b4e51bec1e402fb20751a437aabd6c2985a39ff7c179265eaa84ab0` |
| 130 | `/var/data/agtmai-custody130-linux.kGWxA2/source` | `eaa15f0d4363f76509d65908283b85398acc79a20b0a0368a0623e79c057d47f` |

Bundles named `/tmp/agtmai-custodyNNN-candidate.bundle` locally and under
`/var/data` remotely require respectively aeb721,644476,9800. Scripts are
`agtmai-verify-custodyNNN-linux.sh` in those same directories.
Local evidence copies are under `.tools/hosted-evidence/2026-09-04/`:

| File | SHA256 |
|---|---|
| custody128-linux-validate.log | `f43be79160bfff7ccb4de2989e0a6f6474d4ca35175f7b65b0a796ebed3def34` |
| custody128-linux-rollback-proof.log | `48a27e1b9d821085b795480d5b92f60c32b6bdc78f43ecccfaf7f9ee9f14c37a` |
| custody129-linux-validate.log | `0bcda94f076279da3a2e2b5838f717519393373d35537d24446a3a835de78066` |
| custody129-linux-focused-proof.log | `26861f862bbf007fc3496801b4248488f817991ff34a874a19ff4b6992410f4f` |
| custody130-linux-validate.log | `b71afc1610c49f3a21e0ba6d0cc2008e602ecf254eb1d7fbeaf4f97d2145a5ec` |
| custody130-linux-focused-proof.log | `a57ef0a09600efd33e105561dbdb860fc44c28b44aeb05fff32d96537b8cbbbd` |
| custody130-mac-focused-proof.log | `f6ac6e2807194b9e4383c674f6fe540aedff98c48925906d9ec98fe50da6793a` |

## Remaining acceptance work

Independent xhigh review is still pending; quota failure is not acceptance.
Review120 group2 evidence-directory custody, remaining group4 raw-close sites
in node-runtime/directory-shape/gate-contract, group5 partial context/proof
construction, and architecture findings remain open. Group1 is candidate-fixed
by aeb721 and group3 by644476, not yet integrated into accepted source.

R3-R8, post-publication installation transaction, real current Solana/Agave,
Slither Docker/cgroup qualification, semantic main reconciliation, full root/CI
and specialist/holistic review remain part of the original plan. Passing
structural tests must not be presented as completing those requirements.
No public chain, real key, tokenomics, vesting, spending, auth mutation,
account cycling, browser opening or source/evidence deletion occurred.
