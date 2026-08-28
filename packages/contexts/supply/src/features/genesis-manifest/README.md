# Genesis manifest feature

This package compiles only the committed `local-fixture` / `test-only` source. It does not contain a production source schema, production compile command, approval envelope, deployment logic, wallet access, or public-network access.

The domain normalizes canonical decimal strings, allocation IDs, recipients and exact sums. The YAML/filesystem/ABI implementations are adapters. `GENESIS_ALLOCATION_HASH` is an integrity commitment to the actual allocations, not evidence that tokenomics were approved.

The package exports only `@agent-teams/supply/genesis-manifest`. Successful compiler output is content-addressed under the ignored `.local/genesis/` directory and is usable only when its adjacent `READY` marker matches both source and artifact digests.

Artifact I/O rejects linked source and artifact files, validates runtime manifest bytes before deriving a path, checks the output root after creation, writes with exclusive temporary files, fsyncs, and publishes `READY` last. These checks are fail-closed against accidental or pre-existing link substitution; Node filesystem primitives do not provide a claim of protection against an adversarial same-user process racing path components between syscalls.
