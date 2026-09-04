# Recovery evidence and proof-construction correction

Candidate `755e1c1a4dda37aa4de6217ec6d1184d1650ac78`, tree
`7a2733dd204794c8246851abdb9e9f7bbe633537`, in the isolated recovery
worktree. Parent checkpoints are `c90af2ae83240349fc7a416e5b434e9761115792`
and `a7ed090094776e15136b97f7b5bb61cc91012475`. This source is not accepted or
integrated; independent review of the full recovery ancestry remains required.

## Closed bounded findings

Review120 P1 group2 was reproduced before modification: replacing the evidence
root made the held original remain `running` while the foreign successor became
`passed`. Evidence creation now returns retained portable custody over the root
and its ancestors. Recorder writes, command-log creation, diagnostics rename,
statement/seal and READY publication verify before each pathname mutation and
refresh after it. External validation is bracketed by custody checks, and one
terminal lifecycle releases custody after success or preserves primary,
finalization and close failures in deterministic order.

Review120 P1 group5 is handled by one proof-workspace construction transaction.
Both slice proof and reverse-hash proof acquire their temporary parent, cleanup
handle, checkout, quarantine directory, workspace handle and asserted identity
inside the same boundary. Failures finalize every acquired owner. A downstream
recorder/context failure uses the same terminal path. An unheld empty temporary
parent is removed only after exact identity comparison; a substituted path is
preserved and reported.

The two commits change ten files by +539/-101 from `a7ed090`, including 173 new
focused test lines. The main evidence module remains 491 physical lines and the
new proof-workspace module 125 lines. No dependency or public-network behavior
changed.

## Verification

- Focused macOS: evidence/command publication **18/18**; construction and
  adjacent cleanup/finalization **30/30**; static proof ordering **3/3**.
- Fresh standalone macOS clone from the complete-history bundle: selected
  exact-head **46/46**, including the early CLI failure artifact.
- Linux oldhost, machine-id `93732118417e46618cefafc022c8b1db`: verified
  bundle/head/tree, clean source, selected structural **139/139** after minimal
  rerun, plus early CLI failure artifact **1/1**.
- Scoped oxlint, Node syntax checks and `git diff --check`: pass.

The first Linux invocation used absolute test paths from `/root`; 44 tests
passed and one source-reading test correctly failed because its contract uses
the repository cwd. Re-running that file from the exact source gave 10/10. The
broader run then had 138/139 with the sole failure caused by a pre-existing
foreign `/tmp/.git`; rerunning only that seven-test file with a private job
TMPDIR gave 7/7. Neither environmental failure was classified as product green.

| Evidence | SHA256 |
|---|---|
| complete-history candidate bundle | `e6c5cc75dc5efdbe4ed7717da915b8e2e17539a64ae7ee52be364974f0f47538` |
| Linux broader initial log | `b1346e3eb6d99c7313136b9961dbab4be906a2fa34514a0ad5f5f3cf22cb495a` |
| Linux minimal private-TMPDIR rerun | `df2ee8d0f0243235479429212304138b67a97e82f3ced44b097df43711b4d086` |

## Still open

No full cached rollback proof, full root/CI gate, actual current-platform
recovery, R3-R8, Slither/Solana qualification or specialist/holistic review is
claimed. Hosted reviewer127 remains capacity-blocked on `tv goog six` and
reviews only `a7ed090`; a separate independent xhigh review of the exact newer
candidate is still mandatory before integration.
