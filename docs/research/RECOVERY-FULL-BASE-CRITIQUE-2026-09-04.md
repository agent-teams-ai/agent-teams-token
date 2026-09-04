# Full recovery base critique

Repository links below locate the cited files; line numbers refer to the
historical review checkpoint, not necessarily their current contents.

Source-bound independent review120, not current acceptance. The reviewer could
not inspect archive499 and wrapper430. Its suggestion that those overlays may
close post-backup transaction errors is unproven; their prior acceptance was
only for archive input identity and stock macOS Bash compatibility. R7 must
be inspected and verified separately; do not treat this inference as closure.

## FINAL 1 FOR /var/data/agtmai-r212-recovery-base120-workspace
## Verdict

**AMEND** — bounded full-base review of exact SHA `47fe823a944292784868a3f80bb790cdbbd242f0`, covering `f2d7ab918^..47fe823` and the recovery-facing bootstrap/toolchain dependencies. This is not an integration, merge, hosted-proof, or root-completion acceptance.

### P0

None found.

### P1

1. **Production finalization masks the original proof failure when workspace descriptor close also fails.**

   [gate-execution.mjs:401](../../scripts/rollback/slices/gate-execution.mjs) preserves primary and cleanup failures until the unconditional close at line 445. If [closeRollbackWorkspaceHandle:205](../../scripts/rollback/slices/workspace-handle.mjs) throws, that exception escapes the `finally`, discarding both recorded failures.

   Disposable production-boundary reproducer, using the existing uncertain-close seam:

   ```json
   {"observed":{"name":"AggregateError","message":"ROLLBACK_REMOVAL_WORKSPACE_CLOSE_FAILED","errors":["injected uncertain close"]},"primaryVisible":false,"closeCalls":4,"reused":24}
   ```

   The reused descriptor remained open, so the lower-level no-retry behavior is correct; the bug is caller-level masking. Recovery-finalization owner should catch this close result and aggregate it after the primary and cleanup failures in deterministic order, with an actual `finalizeRollbackTemporaryParent` regression.

2. **The evidence bundle has no retained filesystem custody and follows a foreign successor.**

   [createEvidenceDirectory:285](../../scripts/rollback/runtime/evidence.mjs) returns only a pathname. Recorder writes at [evidence.mjs:216](../../scripts/rollback/runtime/evidence.mjs), seal/READY publication at [evidence.mjs:242](../../scripts/rollback/runtime/evidence.mjs), and validation at [cli.mjs:462](../../scripts/rollback/slices/cli.mjs) all reuse that unheld pathname.

   Actual disposable substitution result:

   ```json
   {"heldStatus":"running","successorStatus":"passed"}
   ```

   Renaming the original evidence directory and creating an equal-path successor caused finalization to write into the successor. `flush()` can also overwrite a successor’s existing `diagnostics.json`. This is a deterministic long-lived custody gap, not the excluded same-UID last-syscall residual.

   Evidence/publication owner should retain parent and directory custody through post-READY validation, revalidate before every path mutation, and preserve rather than write into any successor. Existing portable custody primitives are sufficient; no speculative native platform is required.

3. **Evidence command-log descriptor acquisition leaks and its raw teardown can mask primary failures.**

   [EvidenceRecorder.run:89](../../scripts/rollback/runtime/evidence.mjs) opens stdout and stderr before entering the protected region; `trustedChildInvocation` is also outside it. A failed second open leaks stdout. Its `finally` closes stdout before stderr, so an uncertain first close skips the second and masks command failure.

   Actual disposable reproducer pre-created only the stderr destination:

   ```json
   {"errorCode":"EEXIST","leaked":[{"fd":"20","target":".../001-g-i.stdout.log"}]}
   ```

   Descriptor-finalization owner should use staged acquisition, terminal disarm, attempt-all closure, and primary-first aggregation. Add partial-open, invocation-failure, first-close-EINTR, and second-close-EINTR regressions.

4. **The adopted descriptor-finalization discipline does not cover several production recovery paths.**

   The clearest unsafe ownership transfer is [node-runtime.mjs:341](../../scripts/rollback/runtime/node-runtime.mjs): line 363 closes the predecessor before assigning `directory = next`; an uncertain close throws, the successor is lost, and line 377 retries the stale descriptor number. Top-level cleanup at [node-runtime.mjs:87](../../scripts/rollback/runtime/node-runtime.mjs) similarly lets the first close suppress later closes, prepared-payload cleanup, and the primary error.

   The same incomplete migration exists in:

   - [common.mjs:61](../../scripts/rollback/runtime/common.mjs): `fstat`, `realpath`, or registration failure can leak the opened descriptor.
   - [directory-shape.mjs:92](../../scripts/rollback/runtime/directory-shape.mjs): raw sequential closes can mask validation failures or skip remaining descriptors.
   - [gate-contract.mjs:345](../../scripts/rollback/slices/gate-contract.mjs): staged-file raw closure can replace a Git/staging primary failure.

   Existing close-fault regressions cover custody, cleanup, shared paths and removal, but not these production consumers. Runtime/custody owner should migrate them to the common terminal close collector and add actual consumer-level regressions.

5. **Proof ownership begins before the finalization boundary.**

   [proveSlice:46](../../scripts/rollback/slices/proof-slice.mjs) calls `createSliceContext` before its `try`. That constructor creates a temporary parent and cleanup handle, then performs directory creation, workspace acquisition, assertion and evidence update at [proof-slice.mjs:78](../../scripts/rollback/slices/proof-slice.mjs). Any later acquisition failure escapes without `finalizeSlice`, leaving the cleanup/workspace ownership and temporary tree unfinalized.

   [manifest-proof.mjs:38](../../scripts/rollback/slices/manifest-proof.mjs) has the equivalent gap: workspace creation occurs before its protected block.

   Proof-lifecycle owner should make construction a transaction with explicit partial state, close/abandon every acquired owner on failure, and test failure after each acquisition boundary.

### Known accepted overlay still required

This is not a new reviewer120 finding: the current SHA retains the separately accepted archive/Bash lane and its commits are absent from this object database.

In particular, [toolchain-installation.mjs:268](../../scripts/toolchain-installation.mjs) publishes the new destination before wrapper creation and backup cleanup. A subsequent failure reaches line 280, but restoration is conditional on the destination being absent. The new installation therefore remains live while the old installation is stranded in backup; Node/pnpm may be a mixed destination/wrapper installation and retry observes changed state.

The accepted overlays `49924acf8a836e529e0db309121b8a563e572b20` and `430b0b52` must be integrated and verified against this exact transaction. Neither object is locally available, so I cannot confirm their contents or closure.

### P2

- **Foundation boundaries fail the requested limits.** Exact `wc -l` results are:

  - `cleanup.mjs`: 522
  - `custody.mjs`: 505
  - `node-runtime.mjs`: 509
  - `cli.mjs`: 510
  - `removal-quarantine.mjs`: 503
  - `scripts/tests/toolchain.test.mjs`: 521

  `cleanupIdentityBoundDirectory` spans lines 211–364, or 154 physical lines. Three functions conceal more than five logical parameters behind rest arrays: [gate-contract.mjs:253](../../scripts/rollback/slices/gate-contract.mjs), [gate-execution.mjs:27](../../scripts/rollback/slices/gate-execution.mjs), and [shared-file-operations.mjs:147](../../scripts/rollback/slices/shared-file-operations.mjs). Architecture/Foundation owner should split by ownership responsibility and use named context objects, not compression.

- **The documented root gate differs from the executable root gate.** [package.json:50](../../package.json) makes `pnpm check` run only `rollback:test`; preflight/full proof are exclusive to `check:linux` on line 51. That contradicts [NEXT_ZERO_COST_SLICES_PLAN.md:696](../NEXT_ZERO_COST_SLICES_PLAN.md) and [architecture/rollback/README.md:243](../../architecture/rollback/README.md). CI correctly calls `check:linux`, but the AGENTS handoff command does not. Plan/CI owner must immediately reconcile the confirmed plan error and choose one canonical command without introducing recursive proof execution.

- **The Darwin fail-closed regression is stale.** [proof-runtime.mjs:97](../../scripts/rollback/test-support/proof-runtime.mjs) searches `node-runtime.mjs` for the Darwin error literal after that behavior moved to [node-runtime-authority.mjs:4](../../scripts/rollback/runtime/node-runtime-authority.mjs). The behavior remains correctly fail-closed; update the test to exercise the authority function without bypassing loaded-image binding.

### P3

None.

## Accepted invariants

Subject to the amendments above, I accept these bounded properties at the exact SHA:

- All three manifest schemas, ownership sets, exact complements and current hashes validate.
- Exact-head and complete-history checks precede candidate materialization; byte inventory and final candidate revalidation are present.
- Ancestor sibling churn is correctly accepted while target/ancestor replacement remains rejected.
- Shared-path, removal and cleanup custody retains descriptors, attempts all adopted descriptor closes and preserves primary errors in the already-covered paths.
- Removal and cleanup use bounded atomic quarantine; late children, additions, destination injection and substituted identities fail closed and preserve evidence/quarantine.
- Unknown successors are not deleted by those quarantine/cleanup paths.
- The continuously scheduled same-UID peer between the final validation and separate POSIX syscall remains explicitly out of scope and is not reported as a bug.
- Slice ordering covers captured pre-state, candidate application, production rollback, exact status/tree/inventory equivalence, survivor gates and final cleanup.
- Darwin loaded-image binding remains unavailable and fails closed with `ROLLBACK_RUNTIME_LOADED_IMAGE_BINDING_UNAVAILABLE`; it was not bypassed.

## Verification

Using only the specified pinned Node:

- `--validate-only --expected-sha=47fe823a944292784868a3f80bb790cdbbd242f0`: **PASS**, including all three manifest hashes and coverage.
- `node --test scripts/tests/rollback-proof.test.mjs`: **103 passed, 14 failed, 0 skipped, 117 total**. Thirteen failures were caused by the pre-existing root-owned `/tmp/.git`, which made temporary Git fixtures fail closed with `TOOLCHAIN_GIT_LOCAL_CONFIG_UNAVAILABLE`. The remaining failure is the stale Darwin source-location assertion above.
- Two focused disposable production fault probes reproduced the finalizer masking, evidence-directory successor adoption, and partial-open FD leak.
- Full cached rollback proof and `pnpm check` were not run; no bwrap, network, install, auth/runtime change, real project, or key was used.
- Worktree remained clean.

Separately open and not claimed fixed: pnpm-store/input authority R3/R4/R5, actual-Darwin loaded-image binding, exact integration against unavailable `31e909f72d5470613d8875ed9266adb482ddff85`, and hosted exact-SHA full proof.
