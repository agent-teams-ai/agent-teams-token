# Genesis Core implementation review ledger - 2026-08-28

## Scope and custody

Five independent read-only hosted critics reviewed exact clean commit
`9d50b04d6635474b2c65425570ae99fa971e1e3e`. Every review used
`gpt-5.6-sol`, `xhigh` reasoning and the fast service tier with network access
disabled. Review worktrees stayed clean. The findings are evidence-guided
engineering review, not a security audit or production approval.

| Focus | Job | Initial verdict |
| --- | --- | --- |
| Solidity and asset security | `agtmai-code-audit-solidity-20260828-r3` | REJECT |
| Manifest and canonicalization | `agtmai-code-audit-manifest-20260828-r3` | AMEND |
| Local EVM and verifier | `agtmai-code-audit-local-evm-20260828-r3` | REJECT |
| Architecture and Foundation | `agtmai-code-audit-architecture-20260828-r3` | AMEND |
| CI, toolchain and MVP gates | `agtmai-code-audit-ci-20260828-r3` | AMEND |

## Accepted findings and repairs

| Severity | Finding | Resolution |
| --- | --- | --- |
| P0 | Redirects could escape the loopback-only RPC check. | Redirects and changed final URLs are rejected before a second request; regression tests added in `dabd567`. |
| P0 | A deployment transaction was not independently bound to exact approved creation bytecode and constructor words. | Creation input is reconstructed byte-for-byte from approved build-info, artifact and manifest; unrelated initcode, trailing bytes and every word mutation fail in `dabd567`. |
| P1 | Symlinked paths could be followed or chmodded before validation. | Directory components and files are opened and checked without following links; substitution and permission regressions landed in `dabd567`. |
| P1 | Public compiler entrypoints could bypass strict source parsing; unsafe proposal numbers could round. | The compiler accepts only typed, internally branded values and declared integers are checked before conversion in `2640ca2`. |
| P1 | The root gate omitted vectors, verifier, toolchain and workflow tests. | `pnpm check` now includes the full fast project graph and all seven focused local-EVM suites in `3826166`. |
| P1 | Production TypeScript inherited test-only builtins; changed-scan paths missed nested manifests. | Production builtins are empty, tests use a separate config, and nested package/config roots are full-scan inputs in `891e25b`. |
| P1 | Malformed verifier inputs could escape the structured redacted error contract. | All file/parse failures now return one stable redacted failure; regressions landed in `dabd567`. |
| P1 | Local builds could bypass the checksum-pinned solc. | The runner resolves the platform-specific verified binary and passes it explicitly to Forge in `dabd567`. |
| P1 | pnpm was version-pinned but not checksum-provisioned; offline behavior and lock settings were incomplete. | pnpm 11.24.0 is SHA-256 pinned, atomically installed and executed by pinned Node, with cold-cache and tamper tests in `3826166`. |
| P1 | CI lacked deterministic dependency, secret and license policy. | Frozen advisory, lock-integrity, tracked-secret and explicit license checks plus negative fixtures landed in `3826166`. |
| P1 | CI did not prove exact clean head before and after gates. | Every job asserts `HEAD == GITHUB_SHA`, clean tracked/index/untracked state, and workflow-dispatch records exact-SHA metadata in `3826166`. |
| P1 | macOS/Zsh coverage and the Rosetta solc prerequisite were not explicit. | Darwin requires Zsh in its portability test; Linux absence is reported honestly; the checksum lock records the Rosetta prerequisite in `3826166`. |
| P2 | Compose did not prove non-root execution. | The digest-pinned local Anvil service now uses explicit UID/GID `10001:10001`, read-only FS and `no-new-privileges` in `3826166`. |
| P1 | Tracked evidence claimed raw Forge build-info was reproducible across clean builds. | The unstable raw digest claim was removed. Each run still content-binds its exact build-info bytes; reproducibility is claimed only for normalized evidence. |

## Explicitly deferred P2 limitations

- One structural manifest error can suppress independent semantic diagnostics.
  This is fail-closed and affects diagnostics quality, not accepted output.
- Committed manual gas/size measurements can become stale while threshold tests
  remain green. Exact CI gas/size output is authoritative for this local slice.
- The valueless, run-scoped Anvil signing key is passed to Cast in process
  arguments. It is never a production key, and every run uses a private
  mode-0700 directory and deletes its state.

These limitations do not widen authority, enable public-network use or weaken
the fixed-supply contract. They remain visible backlog for the next relevant
slice rather than being hidden behind an audit claim.

## Verification state before final exact-head gate

- macOS arm64 `pnpm check`: passed.
- Pinned toolchain offline verification and Core doctor: passed.
- Focused local-EVM tests: 24 passed.
- Isolated integration scenarios: 3 passed, including repeated and parallel runs.
- One direct local deploy plus independent verifier: passed.
- Final Linux GitHub Actions and final exact-head hosted re-review: pending at
  the time of this document commit; only their exact-SHA results may close
  Barrier 2.
