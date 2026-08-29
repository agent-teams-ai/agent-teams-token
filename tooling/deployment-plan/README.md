# Unsigned local deployment planner

This feature creates a deterministic stable plan and a separate volatile fee
quote for an exact AGTMAIToken creation input on loopback Anvil (`31337`). All
gas, fee and cap values are canonical decimal strings converted to `bigint`.

The committed `trust-roots.v1.json` is test-only and explicitly disallows
mainnet and production approval. The builder cannot promote its own output.
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
smaller normalized settings object remains a readable policy view, but it
cannot replace the full compiler-input identity.
The RPC port has five read-only methods, rejects redirects and final-URL
changes, and cannot accept public hosts. There is deliberately no wallet,
signer, key, raw-transaction, deploy, transaction-send, or broadcast surface.
The additional read is the exact-block `eth_getTransactionCount` needed to bind
the unsigned identity to the canonical sender nonce. The identity carries the
full zero-value creation input, observation block, and independently derived
RLP/Keccak CREATE address, so nonce-zero and nonce-one plans cannot collide or
exchange evidence.

Bundles are assembled READY-last in an unguessable owned staging directory,
validated there, and atomically renamed into place as a complete directory.
Before rename the held staging directory is synchronised to durable storage;
after rename its owned parent directory is synchronised as well. A failure at
either durability boundary fails closed and is covered by injected-failure
tests.
No bundle leaf is written after publication. The held staging identity and the
exact bytes are checked again after rename, so check/open, rename, substitution,
and ABA races cannot produce a bundle that publication reports as accepted.
Bundles contain `deployment-plan.v1.json`, `fee-quote.v1.json`, then `READY`.
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
the accepted plan: a READY-last staging directory is checked, atomically
renamed, and its exact bytes are checked again after rename before current RPC
facts are reread. A post-publication RPC drift (including estimate N to N+1)
therefore makes the run fail and the normal verifier reject the complete bundle;
it does not turn immutable READY into a claim that mutable RPC state can never
change. Deleting that complete bundle on drift would weaken the held-identity
publication proof and introduce unsafe cleanup ownership, while moving the last
RPC read earlier would stop it from being a final current-state check. This is
the reconciled interpretation of plan sections 6.3 and 6.5: failed runs cannot
leave a reviewable partial bundle, and READY denotes complete immutable bytes.

Root command and TypeScript-project wiring are integrator-owned and therefore
must be added separately. Tests can be run directly after the root build with:

`node --test tooling/deployment-plan/tests/*.test.ts`

The real integration test is enabled only when all three test-only tool paths
are supplied: `AGTMAI_ANVIL_BINARY`, `AGTMAI_FORGE_BINARY`, and
`AGTMAI_SOLC_BINARY`. It performs a fresh isolated Forge build and feeds the
resulting artifact and build-info into the actual unsigned planner. Supplying
only a subset is a configuration failure, not a skip. Anvil selects its owned
listener atomically with `--port 0`; the test parses that exact loopback
listener instead of probing and releasing a port before process startup.
