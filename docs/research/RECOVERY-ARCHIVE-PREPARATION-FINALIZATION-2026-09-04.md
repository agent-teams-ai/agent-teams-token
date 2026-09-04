# Prepared archive finalization correction

Candidate `a7ed090094776e15136b97f7b5bb61cc91012475`, parent
`d9b237fc3d54b37392c1653fc6c1c8ac5e84a489`, in the isolated recovery
worktree. It is not accepted or integrated into the source candidate. Hosted
review is pending because registered subscription capacity remains exhausted.

## Confirmed defect and correction

The pre-fix implementation returned a prepared payload before the verified
archive descriptor was closed in `finally`. A close failure therefore prevented
the caller from receiving cleanup ownership, left `.install-part-*` behind and
could mask a preceding verification/copy/cleanup failure. Target-file copy used
the same masking raw-finally pattern. A cleanup-snapshot refresh failure could
also retain open descriptors. Initial regression evidence was **1/7 pass**;
the archive-close assertion directly observed the abandoned stage.

The bounded correction now disarms and closes the archive before transferring
the prepared result. Any failure enters one terminal finalizer which attempts
identity-bound cleanup, preserves the primary failure first, retains close and
cleanup failures, and releases a cleanup handle even when a snapshot refresh
fails. An uncertain tree is preserved instead of being adopted by pathname.
If cleanup custody cannot be constructed, the exact stage path is reported and
already acquired descriptors are released; that unowned path is deliberately
not recursively deleted. Copy-target finalization uses the existing custody
boundary. No archive identity/hash, extraction, inventory, platform or expected
file check was weakened.

The source module remains 370 lines and the new focused test module 175 lines.
SOLID affected only the small terminal-finalizer and cleanup-constructor helpers;
no generic lifecycle framework was added. Six files changed, +251/-29 including
175 focused test lines and the immediate PLAN correction. No dependencies.

## Local evidence

- focused finalization and success paths: **9/9**, zero skips;
- broader cleanup, descriptor, runtime and removal set: **129/129**, zero skips;
- syntax, scoped oxlint and diff checks pass;
- two nearby toolchain regression selections pass. The third pre-existing
  atomic-installation test fails on macOS with an empty pnpm version. The exact
  parent SHA reproduces the same failure, so it is not attributed to this diff.
- Git lock probe succeeded before the conventional checkpoint commit.

Evidence under `.tools/hosted-evidence/2026-09-04/`:

| File | SHA256 |
|---|---|
| custody133-mac-before.log | `0341a95b803e4ae25e9fec99df37022f759b4b9bba21b977617585875c4312dc` |
| custody133-mac-before-stage.log | `1487dde6e4563ad78ca1113de0890a5b501b4c236512827fab03b6479082a1b6` |
| custody133-mac-focused-final.log | `3f5146f650b35afbeb6b7208b73ca5869ef1210fbf3c6de00a4b94963f99893e` |
| custody133-mac-broader-final.log | `4780b1ebe35eab95eba0e99cad6eb4fae950f66f287dc185bb0879f4d627fdcb` |
| custody133-mac-toolchain-regression.log | `a562b6d8ea9d528813efc3dfd1262cfe1d2369858d105f1981435b9b648ff4f7` |
| custody133-mac-toolchain-baseline.log | `6f0ed6dd23d251d73b57e41270c5af15a4d035829b3f35ae2a291ee361a7f8c9` |

## Linux and remaining scope

The verified transport bundle requires the parent and has SHA256
`2f100fd6bde60f6b36e0494a0962c620a16f86fd82db980902cac6ea1c648749`.
It was copied and re-hashed on the correct oldhost. Linux verifier133 was not
started: free disk had fallen to3759MiB and IO pressure avg10 was30.16/26.43,
below the unchanged5GiB admission rule. The pressure comes alongside active
unrelated hosted work; no foreign workspace was deleted. The current base
clone, pinned Node and bundle are retained for a later bounded run.

This checkpoint closes only the reproduced prepared-archive return/finalizer
defect. It does not accept the unreviewed full recovery base or prove R3-R8,
post-publication R7 installation rollback, evidence-directory custody, partial
proof construction, actual Darwin recovery, exact-head root/CI, Slither/Solana
qualification or final reviews.
