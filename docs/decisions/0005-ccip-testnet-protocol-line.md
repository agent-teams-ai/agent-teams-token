---
id: ADR-0005
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0005: CCIP testnet protocol line

Status: Accepted

Date: 2026-09-08

Decision owner: Project agent under the owner's autonomous testnet delivery instruction

## Context

The owner changed the active scope to a real AGTMAI Ethereum Sepolia to Solana
Devnet round trip. Matching lane version labels alone does not establish token
pool compatibility. The immutable genesis token has no registration getter.

## Decision

Use official EVM `@chainlink/contracts-ccip` 1.6.1 LockReleaseTokenPool, source
commit `bbab0601244ce58e2ffac0dbc178a80aab1fa4a3`, with the existing fixed-supply
genesis implementation extended only by a nonzero immutable `getCCIPAdmin()`.
The concrete deployment manifest binds the full artifact and administrator;
the unchanged genesis allocation hash is not evidence of admin approval.

Register through `registerAdminViaGetCCIPAdmin`, accept the registry role, then
set the pool. The getter describes the initial registration administrator;
subsequent authority lives in TokenAdminRegistry. It grants no token mint power.

For this pool line the canonical backing holder is the pool itself. It implements
IPoolV1 and CCIP_POOL_V1, with ABI-encoded local decimals in destination pool data.
Do not substitute contracts 2.0.0: that line introduces different pool/LockBox
custody semantics and needs a separate compatibility decision.

Use the official self-service Solana BurnMint pool and standard SPL Token,
decimals 9, initial supply zero, freeze authority None. Register pool/admin state
before transferring mint authority directly to the verified Pool Signer PDA.
No additional mint authority, custom program, bridge or relayer is introduced.

Pin the actually published CCIP CLI/SDK 1.13.0 and official BS58 generator commit
`4c8d008a0990f1135da1e2b8bf511edba94904de` when those tools are used. Record npm
integrity and source digests. The generator's default create-mint grants freeze
authority, so it is not our mint creation path: initialize the standard SPL mint
with explicit null freeze authority and persisted test-only mint identity.

Before broadcast, verify current directory addresses, selectors, chain identity,
deployed program/config state, pool peers, registration, decimals and authorities.
Source tags and mock execution do not prove live compatibility. The real testnet
round trip is the final compatibility check, not a pre-existing success claim.

## Consequences

This decision enables a thin testnet adapter. It does not approve mainnet,
production allocations, liquidity, tokenomics or an architecture migration.
Existing local qualification remains scoped to its original SHA. The new token,
pool configuration and transfer path need focused tests and independent review.

## Sources

- [Official LockRelease source](https://github.com/smartcontractkit/chainlink-ccip/blob/bbab0601244ce58e2ffac0dbc178a80aab1fa4a3/chains/evm/contracts/pools/LockReleaseTokenPool.sol)
- [Official registration source](https://github.com/smartcontractkit/chainlink-ccip/blob/bbab0601244ce58e2ffac0dbc178a80aab1fa4a3/chains/evm/contracts/tokenAdminRegistry/RegistryModuleOwnerCustom.sol)
- [Solana authority tutorial](https://docs.chain.link/ccip/tutorials/svm/cross-chain-tokens/direct-mint-authority)
- [Sepolia directory](https://docs.chain.link/ccip/directory/testnet/chain/ethereum-testnet-sepolia)
- [Solana Devnet directory](https://docs.chain.link/ccip/directory/testnet/chain/solana-devnet)

## Rejected alternatives

- A mintable tutorial ERC-20 changes the accepted supply invariant.
- A manual registration request is unnecessary for a fresh token with the getter.
- Latest-version substitution without interface/custody validation changes accounting.
