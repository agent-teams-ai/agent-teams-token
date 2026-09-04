# Recovery finalization correction

Candidate: `aeb721dba1f48b5fd630a2ae50e4adfed6e1fa42`.
Parent: `47fe823a944292784868a3f80bb790cdbbd242f0`.
Local worktree: `/tmp/agtmai-custody-76c-mac`.
This is a bounded main-agent correction, not acceptance of the full recovery
base, local E2E program, production deployment or tokenomics.

## Scope and behavior

Addresses review120 P1 group 1: `finalizeRollbackTemporaryParent` no longer
lets workspace close overwrite earlier proof and cleanup errors. Its existing
return contract stays unchanged. A terminal close failure is reported through
`cleanupFailure`; primary failure remains first, then cleanup, then close.
The two existing production consumers already propagate this ordering.
Close failure after successful removal keeps the completed removal facts but
sets cleanup status to failed. The implementation never retries a descriptor
number whose real close has consumed it.

Four production-finalizer scenarios cover proof failure, cleanup failure,
both failures, and successful removal followed by uncertain close. The shared
fault fixture can target an actual owned descriptor rather than an ordinal;
it performs the real close, reuses that exact number for `/dev/null`, then throws
EINTR. Tests prove remaining descriptors close once and the reused one survives.

Also corrects two review120 P2 documentation/test issues:

- Darwin's regression invokes `assertSupportedRuntimePlatform` instead of
  searching the former source file for an error literal. Runtime binding stays
  unavailable and fail-closed; no authority check is removed.
- The existing complete Linux gate is accurately documented as
  `pnpm check:linux` (preflight, root check, full proof), not `pnpm check` alone.
  No command, CI workflow, manifest hash or production runtime behavior changes.

The change is 197 insertions/17 deletions across 9 files, including 143 lines
of new tests. Production finalizer module is 460 lines. No library added and
no Foundation limit disabled; the correction preserves existing boundaries.

## Verification so far

- New regression before source fix: 0/4 passed, all reproduced masking.
- Fixed temporary/descriptor/production finalization: 18/18, zero skips.
- Broader actual Mac custody/removal/cleanup/finalization: 67/67, zero skips,
  5.72 seconds, using the pinned Node24.20.0 and a fresh canonical private TMPDIR.
- Darwin authority regression: 1/1, zero skips.
- Scoped oxlint and `git diff --check`: pass.
- An initial whole Mac structural run: 36 passed, 77 failed, 8 skipped,
  121 total, 133.97 seconds. This was NOT accepted. The launch used a noncanonical
  `/tmp/...` TMPDIR; many custody tests correctly rejected its `/private/tmp/...`
  resolution. History tests also assume Linux `/usr/bin/bash`. No guard was
  weakened. The 67-test rerun above used the correct canonical path and pins.
- `--validate-only` from the linked Mac worktree was rejected because the common
  Git directory contains forbidden `info/refs`. That shared metadata was not
  deleted or changed. A fresh exact-SHA standalone clone is used for Linux.

## Exact Linux verification transport

Bundle `/tmp/agtmai-custody127-candidate.bundle` requires the exact parent above;
SHA256 `fff833075399f197723e0d703f52c6cb2abbc5e04af14418edf75fe2689f3eed`.
It was verified locally and on the old host before checkout. No dirty worktree
was transported as source authority.

Old host machine-id `be0aad971ea647fab370acd110b469b7` verified; 11GiB disk and
approximately 11.2GiB MemAvailable with 3.5GiB swap free. The ordinary test
script is `/var/data/agtmai-verify-custody127-linux.sh`, copied from its local
`/tmp` counterpart. This is not a subscription/model worker and consumes no
account quota. It creates only a new disposable test clone and fixtures.

Test root `/var/data/agtmai-custody127-linux.dNOAwL`, source at exact candidate.
Pinned Node from the existing105 tool cache is verified before execution:
SHA256 `89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7`.
No tools installed, no auth read/changed, no public RPC or keys used.
Exact-head `--validate-only` passed. Full Linux structural suite: **121/121**,
zero failures/skips, 255.06 seconds, exit 0. Source remained clean afterward.
Local evidence copies are under `.tools/hosted-evidence/2026-09-04/`:

- `custody127-linux-validate.log`, SHA256
  `8f63ad285b7404325d9b825062a5cfeac1b02d4b8ce056da63163aff89fcf982`.
- `custody127-linux-rollback-proof.log`, SHA256
  `465cd6d1abf2ffbb977c4abaa5a04e73bbc7d89c9c80c8e892783280287edcab`.

This fixes the test environment, not the Git or filesystem authority guards:
fresh canonical TMPDIR, standalone exact-head clone and pinned Node were used.
No full cached rollback scenario, public chain or root/CI acceptance is claimed.

Independent xhigh review is still required when hosted capacity returns.
Other120 P1 groups, R3-R8, installation transaction, actual runtime integration
and complete exact-head root/CI remain open. Existing499/430 or narrow118
acceptances must not be extended to this entire base.
