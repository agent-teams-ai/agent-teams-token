# Pinned runtime ownership correction

Candidate `d9b237fc3d54b37392c1653fc6c1c8ac5e84a489`.
Parent `04d0e6400cac74789ba8cd5a02f088133cb3521e`.
Local worktree `/tmp/agtmai-custody-76c-mac`, tracked clean except the known
untracked development node_modules symlink. No source overlay integrated.
Main implementation while hosted subscription capacity remains unavailable.
Independent acceptance of this candidate and the full recovery base is pending.

## Changes and boundaries

Addresses review120 P1 group4's remaining Node consumers. Root/directory/file
acquisition failures now use terminal disarm, custody deregistration and
primary-first aggregation. Directory traversal adopts its successor before
attempting predecessor close. The result file remains owned until parent close
succeeds, so a failure in finalization cannot strand a returned-but-undelivered
file descriptor.

Lock, archive, provenance, loaded-image and final-executable read/validation
consumers use the existing custody helper. Top-level proof finalization attempts
the executable, root and prepared-payload cleanup even after an earlier failure.
Result shape and every platform, identity, hash, archive/provenance, size and
mode check remain unchanged. No uncertain descriptor number is retried.

The prior509-line module was split by responsibility: runtime proof orchestration
309 lines, internal file-authority helpers214 lines. Four helpers are internal
module exports, not a new external API or runtime mode. Before behavior changes,
the moved function bodies were verified byte-identical to their parent bodies
after stripping the added export keywords. This made the pre-fix regression
run a test of the original behavior, not an independently rewritten reference.

Eight files,+486/-243 including the movement,217 new runtime test/probe lines
and one requested-path observation field in the shared test helper. PLAN now
states the lifecycle contract. No dependencies or larger Foundation limits.
SOLID influenced only the cohesive file/proof split and reuse of existing
ownership helpers; no general lifecycle framework or platform bypass added.

## Local evidence

- Mechanically extracted original behavior plus11 regressions: **0/11**.
  Failures cover root/duplicate/next/file stat, predecessor close, result-file
  transfer, reads, multiple finalizers, unsafe/missing entries and successful
  release of stale registry records. Failed log retained.
- Corrected portable file helpers: **11/11**, zero skips,0.41s.
- Mac broader descriptor/consumer/runtime/custody/cleanup/removal set:
  **120/120**, zero skips,8.89s.
- Actual Darwin fail-closed regression: **1/1**, zero skips,1.23s. This does
  NOT claim a functioning Darwin loaded-image proof; rejection remains required.
- Syntax check, scoped oxlint and diff checks pass. The Git lock probe succeeded
  without changing history before the source checkpoint was committed.

Logs copied to `.tools/hosted-evidence/2026-09-04/`:

| File | SHA256 |
|---|---|
| custody132-mac-before.log | `01089fda765847d642a82031e9cdc4e4d6adb6e6f292e93642851101e8d67cb7` |
| custody132-mac-focused.log | `6a3fef1904d9b7604d386913377631a748ec8402042c9a391af7ce48692f1c53` |
| custody132-mac-broader.log | `0cdff718a8686c198ffe8ee3dbcf6f802645921d5831192b17c687fca1bbe601` |
| custody132-darwin-gate.log | `970db4a40d416d16ce85e7bd88e2ffce9d018e8b7b698fa1328fd31144007d98` |

## Linux qualification

Ordinary verifier132 is NOT a subscription/model worker or registry job.
Standalone clone `/var/data/agtmai-custody132-linux.hjsmqp/source` at exactd9b237.
Bundle `/tmp/agtmai-custody132-candidate.bundle` locally and under `/var/data`
remotely requires04d0e640; SHA256
`ee858dd4296a40b5f6bf8cca6eea45cfa8a764934c6f74e0f7949f48f8c052d0`.
Script `/var/data/agtmai-verify-custody132-linux.sh` matches the local `/tmp` copy.
Machine-id `be0aad971ea647fab370acd110b469b7` verified. Before launch:5.6GiB free
disk,12087MiB available RAM,4169MiB swap free; IO avg10 some1.71/full1.45.
Only one verifier admitted and the5GB admission guard unchanged. Existing Node
reused with SHA256
`89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7`.

Exact-head validation passed. Full structural suite: **175/175**, zero failures
or skips,286.33s,exit0; source stayed clean. It includes one new public-runtime
integration test containing seven fault scenarios. It
reuses one real pinned installation, invokes actual `assertPinnedNodeRuntime`,
and checks both descriptor finalization and removal of its prepared payload.
The scenarios cover root/binary close, primary proof failure plus either close,
archive/provenance read plus close, and loaded-image stat plus close. A finished
worker or a green portable helper test does not substitute for this result.
All seven fault scenarios completed successfully. No current test session remains
running. Local evidence copies under `.tools/hosted-evidence/2026-09-04/`:

- `custody132-linux-validate.log`, SHA256
  `2b3e94e69e60efed2697f3dde6cbc91b36ceb6c6182ba96c170738904552e124`.
- `custody132-linux-rollback-proof.log`, SHA256
  `b12284ebbf71d3b7f188135c51cdbe657282b213e07af517ab480ddcb025345f`.

This validates actual Linux runtime behavior and the structural regression set,
not the full cached rollback/root/CI gate. Disk was5.4GiB free after completion;
no source, job, evidence or tool cache was deleted to achieve this result.

## Remaining work

No claim of full recovery, root/CI, cached rollback or whole E2E acceptance.
Review120 groups2 and5, other architecture findings, R3-R8, actual Slither/Solana
qualification, semantic upstream reconciliation and final independent reviews
remain in scope. Hosted125/126 are still quota blocked; the17:22 read-only
run-watch had zero running/alive,57 completed,two capacity-blocked jobs.
No auth, capacity, quarantine, sandbox, public-chain, signing or spending change.

Source inspection also found a related follow-up risk outside this patch:
`prepareVerifiedPayload` constructs cleanup ownership before its protected block
and returns a payload before its raw verified-archive close in `finally`.
A failed close at that boundary could prevent transfer of the prepared payload.
Reproduce this caller-boundary case before changing it; the Node finalizer cannot
recover ownership it never received. Do not mark that archive/partial-construction
work closed by this candidate or by previously accepted archive499/wrapper430.
