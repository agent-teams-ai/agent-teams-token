# Slither125 recovered proposal: not applied

The complete proposal against `e9292d1a0a1893da74ec362ac238b5a1b085bd8d`
is retained in `.tools/hosted-evidence/2026-09-04/recovered-125-final.md`.
This is a main-agent source review, not a worker acceptance or test result.
Worker125 stopped on quota; its terminal result omitted this earlier full final.

## Confirmed source defects in the proposal

1. `ownedEntries` is declared inside the `try` of
   `ExclusiveDirectoryPublication.publishNoReplace`, but used from its `catch`.
   It is out of scope there. A direct application cannot typecheck; move its
   ownership state outside the protected region before using the proposal.
2. `writeCreatedExclusive` has identical recovery branches for `captured` true
   and false. `destinationCaptured` is assigned but not read in the copy helper.
   These are unfinished implementation details, not useful ownership states.
3. `recoverCreatedPublicationEntry` discards repeated descriptor-stat failures.
   If READY was created but no identity could be captured, cleanup cannot
   authorize its removal. The current proposal can leave that unknown entry
   while returning an ordinary publication failure. Require explicit uncertainty
   and prove that no clean accepted bundle is produced; do not invent ownership
   from the pathname or delete an unknown successor.
4. The optional staging-ownership fallback adopts current directory entries.
   Confirm every production caller forwards the captured generation. Do not
   silently widen the production ownership contract to accommodate a test fake.
5. Moving all staging disposal before destination READY is useful, but the
   large addition requires a cohesive module split before Foundation's 500-line
   bound. Do not compress the code or disable the limit.

## Tests the next implementation must genuinely prove

- Test both initial and repeated descriptor-stat failures, including READY.
- Inject chmod/stat failure before and after the real operation. Prefer targeting
  the actual captured handle instead of fragile global ordinal call numbers.
- A close must consume the actual descriptor before throwing; no close retry or
  subsequent stat/read/unlink may use that descriptor number.
- Check output and staging directories with `lstat`/`readdir`, not just a rejected
  `readFile(directory)`, which also rejects for an existing nonempty directory.
  In particular verify READY absence or explicitly rejected uncertain state.
- Preserve foreign roots/children and retain existing cancellation, late-fault,
  byte-identity and failure-evidence tests. Keep the documented final separate
  POSIX syscall same-UID race limitation explicit; no speculative native system.

No portion of this proposal is integrated. Main is completing the independently
bounded recovery finalizer correction while hosted quota is unavailable.
