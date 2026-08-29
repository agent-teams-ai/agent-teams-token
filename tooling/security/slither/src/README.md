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
canonicalized and must resolve to an absolute executable regular file; no PATH
lookup or fallback occurs. The official toolbox image must already be present by its manifest digest. The
runner never pulls, uses a public network, or falls back to host tools. It
copies the pinned production closure into fresh container tmpfs, prebuilds with
the project Forge while skipping tests and scripts, then invokes Slither with
`--foundry-ignore-compile`. A second pinned Slither object-model pass supplies
the analyzed contract/source inventory; Forge build labels are never reported
as analyzed targets. Every gate also runs `tests/fixtures/Vulnerable.sol`
through the same hardened image and requires policy exit `20`.

The exact raw Slither status/JSON matrix is:

- status `0`, `success=true`, no analysis errors: complete analysis, then policy;
- status `255`, `success=false`, at least one analysis error: tool failure;
- every other combination, including signal-derived `137`/`143`, is malformed
  output and fails with gate exit `40`.

Gate exit classes are `0` clean, `20` policy findings,
`30` tool failure, `40` malformed/incomplete analysis, and `50` environment
failure. The composition boundary always tries to retain a sanitised failure
envelope; raw Slither/build output stays in an owned temporary directory.

Immediately before artifact upload, CI must independently reopen the finalized
bundle and validate its exact variant, schema, internal counts, READY marker,
and candidate binding. The integrator-owned upload step should be preceded by:

```text
SLITHER_REPOSITORY_ROOT="$GITHUB_WORKSPACE" \
SLITHER_CANDIDATE_SHA="$GITHUB_SHA" \
SLITHER_EVIDENCE_DIRECTORY="/tmp/slither-evidence-$GITHUB_SHA" \
node tooling/security/slither/src/composition/validate-evidence.ts
```

The validator accepts exactly one of the analysis, output-failure, or
environment-failure variants and rejects extra files, symlinks, nonempty READY
markers, schema-invalid content, inconsistent result semantics, and a SHA that
does not match the upload candidate. This is deliberately a separate process
from evidence creation so CI upload does not trust the producer's validation.

Suppression entries are intentionally empty initially. A waiver must reproduce
the exact versioned finding fingerprint and all tuple fields, include an owner,
reason, review/expiry dates, and regression evidence. Duplicate, broad,
expired, multiply matched, or unused entries fail closed.

Separately, every visible Low/Informational/Optimization fingerprint must have
exactly one current entry in `triage.v1.json` with owner, disposition, rationale
and UTC review date. Missing, duplicate, malformed, or stale triage makes the
otherwise nonblocking result an output failure.
