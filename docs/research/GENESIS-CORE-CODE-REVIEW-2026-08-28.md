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
- Supply tests still use the package-level `tests/` topology rather than the
  newer feature-local test topology. This does not alter runtime boundaries;
  migration is deferred until the next real supply feature changes that area.

These limitations do not widen authority, enable public-network use or weaken
the fixed-supply contract. They remain visible backlog for the next relevant
slice rather than being hidden behind an audit claim.

## First final exact-SHA review and remediation

Five fresh read-only hosted critics reviewed clean exact commit
`ec735a6c21ce6a2d7fdf882b53bf5d17a60530db` in independent clones with the
same `gpt-5.6-sol`, `xhigh`, fast and network-disabled profile.

| Focus | Job | Verdict | Blocking result |
| --- | --- | --- | --- |
| Solidity | `agtmai-final-review-solidity-ec735a6-r1` | ACCEPT | None |
| Manifest | `agtmai-final-review-manifest-ec735a6-r1` | AMEND | Compiler accepted a structurally forged internal value without an opaque parser proof. |
| Local EVM | `agtmai-final-review-local-evm-ec735a6-r1` | AMEND | Unvalidated failed evidence, platform-specific normalized hashes, cold mkdir races and non-shared concurrent cleanup. |
| CI/security | `agtmai-final-review-ci-ec735a6-r1` | AMEND | EVM key assignments escaped the tracked-secret scan. |
| Holistic | `agtmai-final-review-holistic-ec735a6-r1` | ACCEPT | No P0/P1; one test-topology P2 added above. |

The CI critic also identified incomplete vendored OpenZeppelin license closure
as P2. Commit `416ca13` resolves every accepted P1 and this vendor-policy P2:

- only the strict parser can create the opaque compiler input;
- failed reports replace unvalidated tools, digests, addresses and run IDs with
  stable redacted values;
- normalized tool identities omit the Linux/macOS solc suffix;
- cold concurrent directory creation reopens and validates the winning entry;
- all concurrent Anvil stop callers share the same cleanup promise;
- tracked EVM key assignments and the exact vendored dependency/license/file
  closure are security-gated.

Regression coverage includes a compile-time assignability proof, Linux versus
macOS evidence equality, secret sentinels in JSON/Markdown, 16 cold concurrent
directory creators, forced concurrent Anvil termination, key-scan positives and
vendor checksum/SPDX/identity failures.

## Final exact-head gate

- macOS arm64 `pnpm check`: passed.
- Pinned toolchain offline verification and Core doctor: passed.
- Focused local-EVM tests: 28 passed.
- Isolated integration scenarios: 3 passed, including repeated and parallel runs.
- One direct local deploy plus independent verifier: passed.
- Remediation commit: `416ca137af3ce54d73af74a0add046b718bf6334`.
- Frozen code candidate: `816bb10dc305741cb3ce7b0d5603aa6828c44732`.
- Linux GitHub Actions run `33192539415`: passed on that exact SHA. Its
  `solidity`, `foundation-and-typescript` and `local-evm-e2e` jobs all completed
  successfully and preserved a clean checkout.

Four fresh read-only hosted critics then reviewed the same clean exact SHA with
`gpt-5.6-sol`, `xhigh` reasoning, fast service tier and no product edits:

| Focus | Job | Verdict | Result |
| --- | --- | --- | --- |
| Manifest/compiler | `agtmai-r17x-review-manifest` | ACCEPT | No findings. |
| Local EVM/verifier | `agtmai-r17x-review-local-evm` | ACCEPT | No findings. |
| CI/security/vendor | `agtmai-r17x-review-ci` | ACCEPT | No findings. |
| Holistic plan compliance | `agtmai-r17x-review-holistic` | AMEND | No code defect; this ledger still described the already completed same-SHA CI and re-review as pending. |

This evidence-only documentation update resolves the holistic finding without
changing the frozen candidate. Barrier 2 is closed for `816bb10`; any later
documentation-only head still runs exact-head CI before merge so evidence edits
cannot silently break repository gates.
