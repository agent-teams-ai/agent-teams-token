# Toolchain publication transaction

Candidate `f6935e9fb20daf0859795b9eca2153b0aca3e29b`, tree
`5166a7280dd1335e186a9885175c247fc11fdbcd`, in the isolated recovery
worktree. Parent is `755e1c1a4dda37aa4de6217ec6d1184d1650ac78`. This source is
not accepted or integrated; independent review of the full recovery ancestry
remains required.

## Closed bounded finding

R7 was reproduced as a mixed-install failure: after the new payload replaced
the old payload, a wrapper write failure left the new payload beside the old,
tampered wrapper and retained a backup. Publication now owns one transaction
covering the previous payload, previous wrapper, prepared payload, new wrapper
and cleanup handle. Every pre-commit failure either restores the complete old
install or retains an explicit aggregate failure without deleting substituted
objects. Intermediate backup acquisition is itself rollback-safe.

The Node wrapper no longer relies on Bash `[[ -v ]]`, which is unavailable in
the stock macOS Bash 3.2. Its replacement preserves unset, empty and non-empty
allowlisted environment values without admitting arbitrary ambient variables.

The bounded commit changes six files by +453/-103, including 172 lines of new
transaction fault tests. The publication module is 255 physical lines and the
installation module is 324 physical lines.

## Verification

- macOS exact candidate: combined toolchain **39/39** effective unique cases
  after rerunning the one initially blocked by missing ignored tool archives;
  cleanup descriptor/finalizer **18/18**; zero skips.
- Linux oldhost, machine-id `93732118417e46618cefafc022c8b1db`:
  exact bundle/head/tree and clean source; R7 plus cleanup **23/23**, zero skips.
- Scoped oxlint, Node syntax and `git diff --check`: pass.

The macOS rerun used only existing pinned archive bytes from the integration
worktree. No dependency was installed and no network, public RPC, wallet,
signing, gas or public chain was used.

| Evidence | SHA256 |
|---|---|
| complete-history candidate bundle | `d13ce5ca3f9a41c84d635efb7f32f4750eb08149f2648cdd1184474882a55c72` |

## Still open

Hosted reviewer128 is running on `tv goog six` (`account-n`) with exact SHA,
xhigh reasoning and fast service tier. No acceptance is inferred until its
terminal result is inspected and any confirmed finding is remediated. Full
recovery ancestry, R3-R6/R8, full root/CI and final specialist/holistic review
remain mandatory.
