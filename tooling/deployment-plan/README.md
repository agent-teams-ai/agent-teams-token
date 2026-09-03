# Unsigned local deployment planner

This feature creates a deterministic stable plan and a separate volatile fee
quote for an exact AGTMAIToken creation input on loopback Anvil (`31337`). All
gas, fee and cap values are canonical decimal strings converted to `bigint`.

The committed `trust-roots.v2.json` is test-only and explicitly disallows
mainnet and production approval. The builder cannot promote its own output.
V2 is the first format whose canonical decimal fields are all required to fit
`uint256`. Legacy V1 files remain only as migration fixtures: every V1 trust
root, plan, quote, and READY marker fails closed with an instruction to
regenerate the complete bundle. V2 also uses a distinct plan-ID domain and
distinct artifact filenames, so V1 bytes cannot be relabelled or cross-swapped.
It also pins independently generated hashes for the exact ABI constructor
arguments and the complete creation input, so a coherent encoder defect cannot
approve different constructor values.
The `buildInfoSolcVersion` trust root binds Forge build-info's actual
`solcVersion` field exactly as `0.8.36`. Forge 1.8.0 emits both `solcVersion`
and `solcLongVersion` as that short value, so this feature does not claim that
build-info proves the `+commit.8a079791` suffix. The separately pinned and
checksum-verified Forge/solc toolchain boundary enforces that long compiler
identity before a fresh build is admitted.
The trust roots also bind the SHA-256 of the complete canonical Solidity
compiler input, including every source body, remapping, library map, optimizer
detail, metadata option, IR flag and output selection. Forge additionally puts
the machine-specific absolute checkout root in `basePath`, `allowPaths` and
`includePaths`. Their exact expected shape is validated and only that root is
replaced with the fixed `$AGTMAI_EVM_ROOT` token before hashing, so macOS and
Linux bind the same portable input without ignoring an extra search path. The
top-level Forge `id` is required to be exactly 16 lowercase hex characters and
is replaced with `$FORGE_BUILD_ID`; no other build-info field is normalized.
Every plan retains the raw byte hash as run-specific evidence. The current
native Forge 1.8.0/solc 0.8.36 root binds portable compiler input
`0x3697fd540ce6ee7328ac0db9c78c44efd0727eac4aad95f29678eb5ce7ed75d8`
and canonical build-info
`0xa3a29c0f0cbe1fb1e7f193cbc5991b594efdb1230313159a8611c46f5336c865`.
The smaller normalized settings object remains a readable policy view, but it
cannot replace the full compiler-input identity.
The RPC port has five read-only methods, rejects redirects and final-URL
changes, and cannot accept public hosts. There is deliberately no wallet,
signer, key, raw-transaction, deploy, transaction-send, or broadcast surface.
The additional read is the exact-block `eth_getTransactionCount` needed to bind
the unsigned identity to the canonical sender nonce. The identity carries the
full zero-value creation input, observation block, and independently derived
RLP/Keccak CREATE address, so nonce-zero and nonce-one plans cannot collide or
exchange evidence.

Bundles are assembled without READY in an unguessable owned staging directory,
validated there, and atomically renamed into place.
Before rename the held staging directory is synchronised to durable storage;
after rename its owned parent directory is synchronised as well. A failure at
either durability boundary fails closed and is covered by injected-failure
tests.
Only after those durability checks and a second identity/content validation is
a synced hidden marker atomically renamed to `READY`. Losing that final rename
on crash is a safe false negative. A post-rename durability or identity failure
returns typed `OUTPUT_PUBLICATION_UNCERTAIN`, preserves the target, and never
creates READY; a published pathname is never deleted after identity can change.
Unpublished staging directories are reclaimed on close only while their held
filesystem identity and each created leaf identity still match. Cleanup first
quarantines those identities and never recursively removes a substituted or
foreign tree; close reports those paths as rejected rather than hiding a failed
reclamation.
READY is the sole post-publication leaf. Its data and hidden name are synced
before an atomic no-replace name commit. The held directory identity and exact
payload bytes are checked after rename, so substitution and ABA races fail
before acceptable evidence exists.
Bundles contain `deployment-plan.v2.json`, `fee-quote.v2.json`, then `READY`.
The independent verifier recomputes identity, fee math, cap and freshness and
checks READY digests using no-follow file reads. The planner independently
rereads the RPC facts before any output claim, applies the trusted-clock check
again to the staged bytes immediately before rename, and then performs a final
post-publication RPC reread of the block, nonce, one-block fee-history shape,
base fee, and gas estimate against the reconstructed creation input. A quote is
expired when `now >= expiresAt`; failed cap or pre-publication validation checks
occur before publication.

Production observation, the final pre-publication freshness gate, and the
pre-return verification each read the system clock themselves. The CLI has no
simulated-time option. Deterministic tests inject time only through their test
surface.

Publication ordering deliberately preserves the immutable-byte invariant in
the accepted plan: a payload-only staging directory is checked, atomically
renamed, durably synced, checked again, and receives the final READY commit
before current RPC facts are reread. A post-publication RPC drift (including
estimate N to N+1)
therefore makes the run fail and the normal verifier reject the complete bundle;
it does not turn immutable READY into a claim that mutable RPC state can never
change. Deleting that complete bundle on drift would weaken the held-identity
publication proof and introduce unsafe cleanup ownership, while moving the last
RPC read earlier would stop it from being a final current-state check. This is
the reconciled interpretation of plan sections 6.3 and 6.5: failed runs cannot
leave a reviewable partial bundle, and READY denotes complete immutable bytes.

The root command and TypeScript-project checks include this feature. Tests can
also be run directly with:

`node --test tooling/deployment-plan/tests/*.test.ts`

The real integration test is enabled only when all three test-only tool paths
are supplied: `AGTMAI_ANVIL_BINARY`, `AGTMAI_FORGE_BINARY`, and
`AGTMAI_SOLC_BINARY`. It performs a fresh isolated Forge build and feeds the
resulting artifact and build-info into the actual unsigned planner. Supplying
only a subset is a configuration failure, not a skip. Anvil selects its owned
listener atomically with `--port 0`; the test parses that exact loopback
listener instead of probing and releasing a port before process startup.
Both temporary trees are removed in the E2E `finally` path. Forge execution and
Anvil shutdown have explicit deadlines; a child that ignores the bounded
SIGTERM grace period is deterministically sent SIGKILL.

Publication no-replace capability

Node.js `fs.rename` has replace semantics and is insufficient for either commit.
Production composition builds digest-pinned `native/no-replace.c` in owned
`0700` temporary custody with a fixed C11 invocation, makes the result owner-
executable only, and validates device/inode/ctime/size/SHA-256 immediately
before every direct, no-shell use. Linux calls `renameat2(RENAME_NOREPLACE)`;
macOS calls `renameatx_np(RENAME_EXCL)`. Occupied targets return `EEXIST`
without changing either path. The callback stays injectable for deterministic
unit races. Missing, unsupported, substituted, or failed native capability is
fail-closed; there is no shell or replace-capable fallback.
