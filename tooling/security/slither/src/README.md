# Slither security gate

This feature owns exact-tool execution, finding policy, suppressions, and
sanitised READY-last evidence. It is static analysis, not an audit. Production
code follows `domain <- application <- adapters <- composition`; workflow and
root-package wiring remain integrator-owned.

The runner accepts no floating tool lookup. Its caller supplies checksum-pinned
Linux Forge 1.8.0 and solc 0.8.36 paths through `SLITHER_FORGE_PATH` and
`SLITHER_SOLC_PATH`, plus an exact candidate SHA and a new evidence directory:

```text
SLITHER_REPOSITORY_ROOT="$PWD" \
SLITHER_FORGE_PATH=/absolute/verified/forge \
SLITHER_SOLC_PATH=/absolute/verified/solc \
SLITHER_DOCKER_PATH=/absolute/canonical/docker \
SLITHER_CANDIDATE_SHA=<40-hex-sha> \
SLITHER_EVIDENCE_DIRECTORY=/absolute/new/evidence \
node tooling/security/slither/src/composition/cli.ts
```

The Docker CLI path is an explicit platform composition binding. It is
canonicalized and must resolve to an executable in a root-owned, non-writable
system ancestor chain, using the existing system-tool custody pattern. No PATH
lookup or fallback occurs. The official toolbox image must already be present by its manifest digest. The
runner never pulls, uses a public network, or falls back to host tools. It
acquires Forge, solc and the exact input allowlist from their read-only mounts
into private container tmpfs, hashes the acquired copies against the authenticated
host pins, and only then authorizes analysis. Analysis uses `/work/tools` and
`/work/input`; it never rereads mutable mounts after acquisition. Both create
vectors explicitly use `--pull never`. It prebuilds with
the project Forge while skipping tests and scripts, then invokes Slither with
`--foundry-ignore-compile`. A second pinned Slither object-model pass supplies
the analyzed contract/source inventory; Forge build labels are never reported
as analyzed targets. Every gate also runs `tests/fixtures/Vulnerable.sol`
through the same hardened image and requires policy exit `20`.

Image preparation is the only network-enabled step. It creates an owned
temporary Docker configuration containing only an empty `auths` object, passes
that directory explicitly to Docker and removes it afterward. This prevents a
macOS user-level credential helper from being invoked or copied into evidence;
the analysis runner itself remains pull-disabled and offline.

The exact raw Slither status/JSON matrix is:

- status `0`, `success=true`, no analysis errors, zero findings: complete
  finding-free analysis, then policy;
- status `255`, `success=true`, no analysis errors, one or more findings:
  complete analysis under explicit `--fail-pedantic`, then policy;
- status `255`, `success=false`, at least one analysis error: tool failure;
- every other combination, including analyzer signal-derived `137`/`143`, is
  malformed output and fails with gate exit `40`. Parent interruption is handled
  separately: the first SIGINT/SIGTERM remains sticky at exit `130`/`143`.

Gate exit classes are `0` clean, `20` policy findings,
`30` tool failure, `40` malformed/incomplete analysis, and `50` environment
failure. For non-cancelled failures the composition boundary tries to retain a
sanitised failure envelope; cancellation does not publish a second failure
envelope. Raw Slither/build output stays in an owned temporary directory.

Analysis publication includes canonical sanitized `slither.json`,
`slither-inventory.json`, detector inventory and status inputs plus every
normalized identity/location/hash tuple. Publication is built and independently
validated in disposable staging. It exclusively reserves the destination
directory, copies authenticated files in bounded chunks, then publishes an empty
READY through a hardlink to the staging marker while its descriptor is held.
Removing the staging link leaves READY with a single link; publication does not
use an atomic directory rename. READY remains independently revocable through
staging cleanup and CLI finalization, including cancellation during either phase.
Successful finalization requires completed cleanup. Exact container-ID cleanup
runs independently of cancellation. Foreign substitution or cleanup uncertainty
preserves objects and reports failure; it cannot authorize broader deletion.
This contract does not claim SIGKILL/host-crash recovery or race-free same-UID
final identity-check and filesystem syscalls. See [the plan](../../../../docs/PLAN.md)
and [scoped integration evidence](../../../../docs/STATUS.md).

Immediately before artifact upload, CI independently reopens the finalized
bundle and validates its exact variant, schema, raw inputs, READY marker,
candidate and current GitHub execution identity. The upload step is preceded by:

```text
SLITHER_REPOSITORY_ROOT="$GITHUB_WORKSPACE" \
SLITHER_CANDIDATE_SHA="$GITHUB_SHA" \
SLITHER_EVIDENCE_DIRECTORY="/tmp/slither-evidence-$GITHUB_SHA" \
node tooling/security/slither/src/composition/validate-evidence.ts
```

The validator accepts exactly one of the analysis, tool-failure,
output-failure, or environment-failure variants and rejects extra files,
symlinks, nonempty READY markers, schema-invalid content, inconsistent result
semantics, and a SHA that does not match the upload candidate. For successful
analysis it loads the canonical production manifest, detector inventory,
suppression/triage ledgers and toolchain lock, then independently derives
targets, sources, detectors, normalized fingerprints, per-impact and
blocking/suppressed/visible/triaged counts, closure hash and exact human summary
from the bundled raw inputs. Supplied aggregate fields are never trusted.

Container stages write the exact stable registry stage before each fallible
phase. Compiler-build and artifact-validation failures are incomplete output
(`40`), an analysis-runtime failure is a tool failure (`30`), and
host/preflight failures are environment failures (`50`).
`.github/workflows/ci.yml#solidity-security` is the sole
authoritative CI definition; the feature-owned wiring request points to it and
no duplicate workflow fragment is retained.

Suppression entries are intentionally empty initially. A waiver must reproduce
the exact versioned finding fingerprint and all tuple fields, include an owner,
reason, review/expiry dates, and regression evidence. Duplicate, broad,
expired, multiply matched, or unused entries fail closed.

Separately, every visible Low/Informational/Optimization fingerprint must have
exactly one current entry in `triage.v1.json` with owner, disposition, rationale
and UTC review date. Missing, duplicate, malformed, or stale triage makes the
otherwise nonblocking result an output failure.

Scratch custody retains acquired directory and file descriptors and an inventory
recorded during creation. Cleanup validates identities and exact membership before
restoring directory write permission through held descriptors, then removes only
that inventory. Unknown entries and pathname successors survive with explicit
cleanup failure; primary failures remain first when finalization also fails.
The accepted POSIX race between a final identity check and its syscall remains
outside this guarantee.

Staging validates bundle content and compiler semantics. The independent finalized
validator additionally rejects executable Git configuration through the existing
trusted Git boundary, requires exact clean HEAD, and binds canonical bytes and
schemas actually read to the requested commit's Git objects. Matching supplied
SHA strings alone cannot authorize finalized evidence.
