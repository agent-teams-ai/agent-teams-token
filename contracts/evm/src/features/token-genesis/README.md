# AGTMAI token genesis

`AGTMAIToken` is a local-candidate immutable ERC-20 core. Its constructor validates
and commits to 1-32 sorted allocations before minting each bucket directly to its
recipient. `GENESIS_ALLOCATION_HASH` is an integrity commitment only; it is not a
tokenomics approval or official-deployment marker.

Solidity `0.8.36`, the Paris EVM target, optimizer settings, metadata and build-info
retention are pinned in `foundry.toml`. The only inherited contract is the vendored
OpenZeppelin Contracts `ERC20` surface selected from stable release `v5.7.0`; the
release provenance locator is recorded in `lib/openzeppelin-contracts/PINNED_VERSION`.

There is no owner, proxy, fallback, receive, pause, blacklist, fee, burn, later mint,
arbitrary call or CCIP registration surface.
