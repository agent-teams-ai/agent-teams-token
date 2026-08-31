# Slice rollback proof

Status: AMEND remediation implementation for the three local/test-only
zero-cost slices. The rollback runner, bounded identity-safe cleanup, Linux
runtime binding, complete-history verifier and exact-head CI wiring are now
integrated in the candidate source. Hosted CI has not executed that candidate,
and this document does not record a successful full proof, CI result,
acceptance, audit or public-network authorization. Published history is not
rewritten or relabelled. The manifests are proposed removal authority for its
mixed integration commits and become operational only after the exact
clean-candidate full proof passes.

The proxy-disabled adapter transport and its Foundation dependency declarations
remain owned by the coordinated external transport lanes. This patch neither
changes nor pre-approves those still-changing feature/global-manifest bytes and
does not close the direct-HTTP P1.

## Local-only threat model and evidence limits

This proof is limited to an isolated local or CI host, a clean exact commit and
zero-cost test identities. Network access, public RPC, Devnet and Mainnet are
disabled; no real secret, key, signer, asset or transaction is in scope. The
operating-system kernel, local filesystem descriptor semantics, fixed runtime,
system Git, the executing process and its held descriptor table are trusted.
Repository bytes, manifests, cache contents,
command output and every pathname after its descriptor is opened are untrusted
until the corresponding identity, schema, provenance and digest checks pass.

In scope are malformed or over-broad manifest inputs, symlinks, mount/device
crossings and concurrent rename/replacement of an allowlisted temporary parent,
child or final directory before atomic quarantine or before a final identity
revalidation. Deterministic same-account substitutions at each instrumented
boundary must preserve the replacement and fail closed. After quarantine, an
unprivileged different-UID peer without discretionary-access-control bypass
cannot traverse its mode-`0700` directory. A continuously scheduled same-UID
peer that can replace an entry in the micro-window between the final
`lstat`/`fstat` comparison and the immediately following Node `unlink`/`rmdir`
syscall, or inject a quarantine destination between the final absence check and
the immediately following Node `rename` syscall, is out of scope; Node exposes
neither a conditional identity-bound unlink nor a no-replace rename primitive.
A root, capability-bearing or otherwise OS-privileged peer that can
bypass mode `0700` is likewise out of scope, as is an attacker that controls the
kernel or running process, can alter its memory or held descriptors (for
example through debugging/injection), or can replace the trusted runtime or
repository object database. Consequently this proof is not evidence against
same-UID final-syscall races or privileged local peers. `SIGKILL`, host failure,
disk failure and resource exhaustion may leave residue for a separately
authorized local cleanup; they never authorize broader deletion.

The current candidate records an integrated remediation implementation, not a
passed full proof. Even a future passing proof establishes only byte/status
rollback equivalence for the final integrated local candidate. It is not an
audit, production readiness, Devnet readiness, Mainnet readiness,
public-network evidence or permission to use a real key, asset, signer or
transaction.

Each version-1 manifest lists every file introduced below one worker-owned root,
the Barrier 0.5 prerequisite stub to restore, every shared path changed by that
slice's wiring, and the exact SHA-256 transition for each shared reversal. The
baseline is `b7a868f85d89c4bb7a9aeed1d854a5f949306a45`. A valid manifest set has
exactly the three known slice IDs, non-overlapping normalized exact paths,
complete shared reversals, and for every removed slice the unique exact
two-slice survivor complement. Missing, unknown, self-referencing or duplicate
survivor gates fail validation.

Final-manifest state at this documentation edit:
`REHASHED_WORKTREE_VALIDATED_PENDING_EXACT_HEAD_FULL_PROOF`. After the feature
and CI bytes were fixed, the final integrator regenerated every declared shared
before/after transition and retained-path fingerprint. Exact current-byte
coverage and production apply regressions pass. No commit was authorized here,
so clean exact-head `--validate-only` remains pending. This is not a full
rollback proof or hosted CI result. A later integration change invalidates it
and must return it to pending rather than preserving a stale success claim.

## Candidate and disposable checkouts

A validation, preparation or full run requires a clean candidate `HEAD`; an
explicit `--expected-sha`, when supplied (and always in CI), must equal it.
Staged changes, unstaged changes and non-ignored untracked files are refused;
the runner never turns a dirty diff into candidate input. It builds a
detached, no-hardlink disposable checkout from that commit and records a
canonical inventory containing every tracked path, file mode, object identity
and byte digest. The materialized checkout must match that inventory before any
slice is removed. Before a preparation or proof result can pass, the source
candidate is checked again for the same clean `HEAD` and complete inventory.

The proof copies only checksum-verified pinned tool archives from the prepared
source cache. Bootstrap installation and verification in each disposable
checkout are offline. Workspace dependencies are established with
`pnpm install --frozen-lockfile --offline`, so package-scoped pnpm links are
recreated rather than approximated with one root `node_modules` symlink. A cache
miss, incomplete workspace link graph, missing pinned binary or absent preloaded
Slither image fails clearly; the proof never fetches a fallback.

After applying one manifest, the runner verifies the complete resulting
inventory, commits the synthetic removal tree inside the disposable repository,
and runs against that clean synthetic identity. The source candidate SHA and
synthetic tree/commit identities remain separate evidence fields.

## Modes and evidence

The modes have deliberately different evidentiary meaning:

- `--preflight-only` binds a clean exact candidate, proves complete baseline
  history, verifies the pinned Linux Node runtime, every required offline
  archive and installed executable, the frozen pnpm store and workspace links,
  plus the cached Slither image through a non-pulling Docker inspection, and
  rechecks candidate identity. It consumes no rollback manifest, materializes
  nothing, runs no quality gate and is environment evidence only.
- `--validate-only` checks the clean candidate binding, manifest schema,
  ownership, exact survivor complements, path safety and Git coverage. It does
  not prepare a removed tree or execute any survival gate.
- `--print-hashes=<slice>` is a non-evidentiary final-integrator maintenance
  command. It requires a clean exact candidate and schema-valid manifest, then
  calculates proposed shared reverse hashes in an identity-bound disposable
  checkout without trusting the stale declared digests. Its output must be
  reviewed and incorporated only after all feature and CI bytes are final; it
  does not validate or prove the manifest.
- `--prepare-only` additionally materializes and inventories every disposable
  checkout, installs dependencies offline, applies each removal and verifies the
  synthetic tree. It executes no proof gates and is preparation evidence only.
- the default full mode performs validation and preparation, then executes every
  required gate for all three removal cases. Only a passing full mode is an
  actual rollback proof.

Manifest-consuming validation, preparation and full-proof modes fail closed on
any stale declared transition or retained fingerprint. The accepted recovery
review changed workflow, routing, toolchain and evidence bytes. Their final
shared/retained transitions are now
`REHASHED_WORKTREE_VALIDATED_PENDING_EXACT_HEAD_FULL_PROOF`: exact current-byte
coverage and production apply regressions pass, while clean exact-head
`--validate-only` awaits the externally created candidate commit. Global proof
completion also remains pending.
Environment-only preflight remains separate and is never a successful
validation, preparation or rollback proof.

Pass an evidence directory explicitly for an auditable run:

```text
pnpm rollback:prove -- --expected-sha="$(git rev-parse HEAD)" \
  --evidence-dir="/private/rollback-proof-$(git rev-parse HEAD)"
```

The evidence directory separates volatile diagnostics from proof. Commands,
timestamps, durations, paths, stage status, stdout and stderr stay in
`diagnostics.json` and diagnostic subdirectories. A successful full run creates
a closed-schema canonical `statement.json` containing only deterministic proof
facts, binds it and the committed schema in `seal.json`, and uses the canonical
statement SHA-256 as the proof digest. The independent validator requires the
exact baseline, slices, gate lists, artifact paths/content and candidate SHA.
Only after that validation and candidate-inventory revalidation does the runner
publish `READY` last; it validates the READY bundle again without writing to it.
Failed runs retain diagnostics but are never labelled or uploaded as verified
proof. Missing or duplicate required gates, failed commands, and a skipped
required real survivor make the proof fail.

## Full gate contract

Before the first command recorded with `phase: "gate"`, one repository-wide
preflight validates complete baseline history and exact-head identity, the
immutable Linux Node archive and separately pinned inner executable digest,
install provenance, loaded-image identity, the frozen workspace store and link
graph, the absolute Docker executable and the already-present Slither image's
exact digest, `linux/amd64` platform and revision. For Foundry and pnpm, the
repository lock's archive SHA-256 is the immutable byte authority: verification
re-extracts expected payloads from the already-open verified archive descriptor
and compares installed bytes directly with them. Solc is copied from its
descriptor-opened executable archive, whose archive digest is also its payload
digest. Mutable `.agtmai-toolchain-install.json` records are checked but never
authorize installed bytes. The lock does not claim separately sourced Foundry
or pnpm inner-file digests. If a pinned archive is absent, verification reports
`TOOLCHAIN_PINNED_PAYLOAD_AUTHORITY_UNAVAILABLE` instead of trusting the local
installation. This preflight does not pull or run a quality gate. A missing or
invalid cache class fails with zero gate command records; validating Docker or
the image after another gate ran is invalid evidence.

Every removal case runs genuine Genesis Core and Foundation assertions, lint,
full TypeScript checking and build/tests, Genesis vector and local-EVM gates,
Foundry formatting/build plus unit/fuzz and invariant suites, and the two exact
surviving slice gates. Survivor gates are strict:

- local Solana sets `AGTMAI_SOLANA_REAL_TESTS_REQUIRED=1` and requires every
  checksum-pinned Agave/SPL binary and the real lifecycle;
- deployment-plan supplies the exact pinned Anvil, Forge and solc paths and
  requires the real loopback Anvil test;
- Slither runs the actual policy analyzer with the preloaded pinned
  `linux/amd64` image manifest, then validates its finalized evidence. Its unit
  tests alone are not a survivor proof.

No real Solana, Anvil or Slither survivor may silently skip because a binary,
analyzer, image or environment value is unavailable.

## Cleanup safety

Every run uses private mode-`0700` temporary parents and records their original
filesystem identities. Cleanup stays in the production runner and holds parent,
target and directory/file descriptors. At each named boundary it atomically
moves the object currently bound to that name into a private quarantine, then
refuses deletion unless the moved identity matches the held descriptor for a
directory or file, or the captured `lstat` identity for a symlink. It repeats
that comparison immediately before the separate Node `unlink` or `rmdir`
syscall and rejects an occupied quarantine destination immediately before each
separate Node `rename`; the same-UID gaps between each check and syscall are the
explicit exclusions above. Traversal is descriptor-anchored, sorted and bounded
by exact target and top-level allowlists, entry count, depth and relative-byte
limits; symlinks are staged and unlinked as link objects, never traversed.
Cleanup does not authorize recursive deletion merely from a resolved pathname,
parent name or prefix. No custom native cleanup helper, source or binary
remains. The only permitted production runtime on Linux x64 is Node `24.20.0`
from the checksum-verified archive. The lock also pins the archive's inner
`bin/node` SHA-256
`89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7`.
The runner descriptor-opens and verifies the lock, archive, installed binary and
canonical install provenance; requires exact `process.execPath` and realpath;
then binds the loaded process image through `/proc/self/exe` to the same file
identity and digest. A coherent forged binary/provenance pair therefore cannot
replace the independently pinned inner digest. Darwin arm64 fails closed because
the runner cannot independently bind its loaded image there. The fixed Linux
runtime is part of the trusted local boundary only after these checks; hostile
replacement after binding is out of scope. If an in-scope parent or checkout
replacement is detected or cannot be revalidated, cleanup reports the preserved
quarantine and fails closed. Cleanup failures are retained beside the primary
proof result rather than hiding it.

The rollback transformation itself also never directly unlinks a declared
owned file or `rmdir`s a derived empty directory. It opens the original object,
atomically stages it into a held mode-`0700` `gate-tmp` quarantine, revalidates
the moved identity against the held descriptor, and reports the sorted logical
paths. Those quarantines stay outside the checkout until the final
identity-bound temporary-parent cleanup. An in-scope substituted file or
directory is preserved and fails the slice before any proof gate.

## Local structural checks and external CI

The structural regression suite is not a substitute for the full proof:

```text
node scripts/rollback/prove-slices.mjs --validate-only \
  --expected-sha="$(git rev-parse HEAD)"
node --test scripts/tests/rollback-proof.test.mjs
```

Root `pnpm check` includes the rollback proof. Consequently any job that keeps
calling root `pnpm check` must also provide the pinned core and Solana caches,
the frozen workspace store and the preloaded pinned Slither image; omitting
those prerequisites is a hard failure, not permission to skip the proof.

The exact-head/full-history integration is present in the existing
`foundation-and-typescript` job and recorded as
`integrated-pending-execution` in `ci-wiring-request.v1.json`. Checkout is bound
to explicit `github.sha` with `fetch-depth: 0` and no persisted credentials. The
history verifier rejects shallow and partial clones, replacement refs, legacy
grafts, the `GIT_ALTERNATE_OBJECT_DIRECTORIES` environment channel and
`.git/objects/info/alternates`; it proves exact `HEAD == GITHUB_SHA`, pinned
baseline ancestry and complete reachable objects with replacement processing
disabled. CI then installs and verifies pinned Core and Solana prerequisites,
the frozen workspace and preloaded Slither image, runs the non-pulling
`--preflight-only` command before root gates, runs `pnpm check`, and reasserts
complete history/clean head under `if: always()`. It validates a sealed proof
and revalidates candidate inventory before the success-only proof upload;
failure output uses a separately named diagnostic upload.

Hosted CI has not executed these bytes, so there is no exact-head hosted result
to claim. The current host also lacks the complete offline Foundry, solc, pnpm
and Agave archive cache set and cached Slither Docker image; consequently the
repository-wide preflight fails before dependent gates and a full local proof
cannot be claimed here. Final manifest state is
`REHASHED_WORKTREE_VALIDATED_PENDING_EXACT_HEAD_FULL_PROOF`; any later
integration must invalidate it back to pending. Until a
clean full proof and green exact-SHA hosted run exist, the rollback delivery
remains unaccepted.
