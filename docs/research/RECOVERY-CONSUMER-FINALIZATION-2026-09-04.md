# Recovery shape and staging finalization

Candidate `04d0e6400cac74789ba8cd5a02f088133cb3521e`.
Parent `a7add0d9c546e91b8e1bc62e8857f0435852fd1e`.
Isolated worktree `/tmp/agtmai-custody-76c-mac`, tracked clean; known development
node_modules symlink remains untracked. Accepted integration source is unchanged.
This main-agent correction addresses two consumers from review120 P1 group4,
not the whole group or the full original E2E program. Independent review pending.

## Corrected ownership boundaries

- Directory-shape root, nested directories, regular files and final identity
  checks reuse the existing `useCustodyDescriptor`/`retainCustodyDescriptor`
  contracts. Failure keeps the primary cause, attempts all acquired closes and
  forgets registry entries. No close retry on a potentially reused FD number.
- Traversal adopts a successor before closing its predecessor. A predecessor
  close error therefore unwinds the successor, not the already-consumed number.
  Initial post-open stat and next-directory validation are both protected.
- Directory iterator read failure remains first when its terminal close also
  fails. The opaque iterator receives one close attempt, with no retry.
- Staging acquisition preserves stat/read failures across close failure.
  Returned staging ownership disarms the FD before close. Hash/index/identity
  failures remain first when terminal close fails. Existing held-byte staging,
  no-filter hashing, identity checks and successful result shapes are unchanged.

Six files,+375/-57, including309 new test/fixture lines. Production shape module
shrinks332->323 lines; gate-contract grows455->465. No dependency, new generic
resource framework, disabled lint rule or increased Foundation limit.
`docs/PLAN.md` records these requirements immediately. Node-runtime raw close
sites remain open, as do the broader architecture findings from120.

## Regressions and verification

The test observer reaches both legacy raw fs closes and the existing managed
close seam, so the before/after result is not caused merely by moving to a new
mock hook. Faults perform real close, reuse the exact FD for `/dev/null`, then
throw EINTR. Tests check every observed owner closes once, registry membership
is gone, and the reused descriptor survives. Only disposable test directories
and FDs are used; no real user project is a runtime fixture.

- Before production fix, exact parent plus new16 regressions: **0/16**, all
  reproduced failure. Saved without overwriting the failed result.
- First production patch: **16/16**, zero skips,1.70s.
- Added two success cases and iterator-owner assertions: Mac broader consumer,
  acquisition, finalization, cleanup, custody and removal set **109/109**,
  zero skips,62.24s. Successful shape counts/content and exact staging calls
  stay unchanged; all success-path descriptors close and unregister.
- Lint found one test object property `arguments_` violating the naming rule;
  renamed it `commandArguments`, no production change. Final changed test
  file **18/18**, zero skips,5.81s. Scoped oxlint and diff checks pass.
- Linux ordinary verifier131 completed: **163/163** full structural tests,
  zero failures/skips,221.24s,exit0; exact-head validation passed and source
  remained clean. It is a test process, NOT a subscription/model worker.

Mac logs copied into `.tools/hosted-evidence/2026-09-04/`:

| File | SHA256 |
|---|---|
| custody131-mac-before.log | `cca8d6b0e3bb2386f73cd27bf671e85b8f5b8bc0730f65383823e17041851969` |
| custody131-mac-first-fixed.log | `99a718859aff73729ee521b5e20e6de5e7fe7a3e90fa52d4a0e293cbeba32f80` |
| custody131-mac-broader.log | `bc0913d42ea87dcbe0e9a04ac41067aea6348cd1fa2ce55bb021aa3beec4674d` |
| custody131-mac-final.log | `5eab4f50a7721a70e523d018e95f63b393f083b3c5c5a940ba526cd9fbf2b247` |

## Linux transport

Source `/var/data/agtmai-custody131-linux.0EXee0/source`, standalone clone from
exact a7add plus verified bundle. Bundle `/tmp/agtmai-custody131-candidate.bundle`
locally and `/var/data/agtmai-custody131-candidate.bundle` remotely; SHA256
`7023ccdaac322ce11d50116a7c819c41064077bbdffb5a46a409f566749f6121`.
Script `/var/data/agtmai-verify-custody131-linux.sh` mirrors local `/tmp` script.
Machine-id `be0aad971ea647fab370acd110b469b7` verified. Latest preflight:7.3GiB
disk free,11715MiB available RAM,3816MiB swap free; IO avg10 some19.38/full12.02.
One structural verifier admitted; no parallel heavy job. Existing5GB guard
retained. Existing pinned Linux Node reused, SHA256
`89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7`.
No dependencies installed, auth read/changed, quarantine altered or guard bypassed.
Exact-head `--validate-only` passed, followed by163/163 structural tests.
Local evidence copies under `.tools/hosted-evidence/2026-09-04/`:

- `custody131-linux-validate.log`, SHA256
  `12e5c2ddece7d03f1f258293fb6f430a36cf28f78bd266776de658d3ea4b1ba5`.
- `custody131-linux-rollback-proof.log`, SHA256
  `d28be8865d3edb87e21bf4350f32feadfe7aa2b914284f64ac0c968e83c27b41`.

No current test session remains running. These structural results do not prove
the complete cached rollback/root/CI program or independently accept the base.

## Next bounded runtime work, not yet implemented

Read-only inspection confirms the remaining120 group4 ownership work in
`runtime/node-runtime.mjs`. It must preserve the platform gate and authority
checks, not weaken them for Mac tests:

1. Open-root, open-directory and open-file validation failures need terminal
   close aggregation and directory deregistration.
2. `openRuntimeRegularFile` needs successor-before-predecessor transfer. Also
   retain the opened result file until parent finalization succeeds: its current
   return-before-finally structure can leak that result when parent close fails.
3. Lock/archive/provenance/loaded-image/final-executable consumers need primary
   preservation. Top-level finalization must attempt executable, root and
   prepared-payload cleanup even when an earlier close fails.
4. The current509-line module already exceeds the Foundation limit. A cohesive
   internal file-authority module can own traversal/validation/read helpers,
   leaving platform/runtime proof orchestration separate. Do not compress code
   or hide parameters to satisfy a limit. Preserve every existing validation.
5. Reuse the new real-close observer for portable helper tests. Top-level runtime
   qualification still needs actual pinned Linux execution; do not bypass
   Darwin loaded-image rejection to manufacture a passing proof.

Also still open:120 group2 evidence directory custody, group5 partial proof
construction, R3-R8, Slither/Solana actual qualification, upstream semantic merge
and complete exact-head root/CI with independent specialist and holistic reviews.
No full cached rollback/E2E/production acceptance is claimed by this report.
