# Local Solana SPL fixture

This feature creates a classic SPL Token mint named by the surrounding evidence as Agent Teams AI (`AGTMAI`) on an owned local Agave validator only. It fixes decimals at 9, revokes only the freeze authority, mints exactly 1,000 tokens, burns them all, and independently reconstructs the finalized transaction lifecycle. The ephemeral mint authority deliberately remains usable until teardown; its key is then deleted.

The feature is local/test-only. It does not implement CCIP, production authorities, a hard cap, tokenomics, public RPC access, signing for public networks, or any broadcast surface outside `127.0.0.1`.

Bootstrap the checksum-pinned Agave 4.2.1 / SPL CLI 5.6.1 tuple using the integrator-owned toolchain command:

```text
./dev bootstrap fetch --scope=solana
./dev bootstrap install --offline --scope=solana
```

Agave 4.2.1 does not place the classic SPL Token and associated-token programs in an empty local genesis. The fixture therefore loads the two read-only SBF artifacts under `programs/` with upgrades disabled. Their exact source repositories, release tags, commits, build toolchain, paths and SHA-256 digests are frozen in `tooling/toolchain.lock.json`: SPL Token `9.0.0` at `dfb260231c761be7d9c8b63728e770a102b86495`, and Associated Token Account `8.0.0` at `0b867b5340cd001e5980d8ca7928effc4e10015c`. The resolver rejects missing, modified, linked or substituted artifacts before starting the validator.

Run the feature directly until the integrator adds `pnpm solana:fixture:local`:

```text
node tooling/local-solana/src/composition/index.ts --output /tmp/agtmai-solana-evidence
```

The output root and every run root must be owned mode `0700`. Evidence is written atomically as JSON and Markdown before `READY`; no key path, key bytes, mnemonic, ledger, or raw secret-bearing error is retained. On normal exit and signals, only the owned validator and run directory are removed. A lease permits a later invocation to reclaim a run orphaned by `SIGKILL` without touching neighbouring directories.
