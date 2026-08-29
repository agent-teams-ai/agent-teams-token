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
`--foundry-ignore-compile`. Exit classes are `0` clean, `20` policy findings,
`30` tool failure, `40` malformed/incomplete analysis, and `50` environment
failure. The composition boundary always tries to retain a sanitised failure
envelope; raw Slither/build output stays in an owned temporary directory.

Suppression entries are intentionally empty initially. A waiver must reproduce
the exact versioned finding fingerprint and all tuple fields, include an owner,
reason, review/expiry dates, and regression evidence. Duplicate, broad,
expired, multiply matched, or unused entries fail closed.
