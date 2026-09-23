# Fee Quoter mainnet attribution evidence

Date: 2026-09-21; official artifact recheck: 2026-09-22. Scope: read-only
evidence captured at repository base
`6c9f23bb1e898883a446fe621b60c0d398b90b09`. This record does not qualify a
lane, a deployed program's semantics, or a mainnet operation.

## Finding and confidence

**No exact attribution is currently possible (high confidence).** The finalized
Solana mainnet Fee Quoter ELF does not match any examined official Chainlink
`solana-v1.6.0` through `solana-v1.6.4` artifact. Resemblance to the v1.6.3
source line is an inference only (medium confidence), not an artifact identity.
ADR-0007 remains proposed and mainnet lane qualification is blocked. Its
proposed vendor-trust route would not require an exact release build match, but
the mismatch and additional Chainlink implementation/upgrade-governance trust
must be disclosed; the other deployment and behavior proofs are still missing.

This conclusion is bounded to the released artifacts and read-only observations
listed below. It does not identify the deployed source commit, build host, Rust
toolchain, Solana toolchain, or governance policy semantics.

## Finalized network and program observations

The capture used read-only HTTPS RPC `https://api.mainnet-beta.solana.com` with
commitment `finalized` and genesis hash
`5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. This authenticates the RPC
transport, not consensus independently.

| Observation | Value |
| --- | --- |
| Fee Quoter program | `FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi` |
| Program owner | `BPFLoaderUpgradeab1e11111111111111111111111` |
| ProgramData | `nfuV6WLjqmk6qm2gLHSeDqbS1s7YfQLekKHawpLrG6e` |
| ProgramData owner | `BPFLoaderUpgradeab1e11111111111111111111111` |
| Last deployed slot | `437468573` |
| Slot time / blockhash | `2026-08-05T22:59:01Z` / `4kkvybbtnW2g3NdK2QqtSTfxVCffWZpry6GRChqS1FrH` |
| Upgrade authority | `GoFoFfEDgALWRTw5dSY3VZQSwbFpvBEhDv1sFAWzYpbf` |
| Program account SHA-256 | `6940b3af491951cded5b1911a3ad0c2047a318c34e9efb357a2ff3ba5c0ba50f` |
| Full ProgramData SHA-256 | `5dcbe5e23b0cf5b673fc191cdbe50e8bedd907c0482b55351689a2b3f22170ac` |
| Allocated executable payload | 5,242,880 bytes; SHA-256 `f2103d34e01eb282eb388122e1bed42d05ce7309ddb8ab1670705df5d7fc43b8` |
| Canonical deployed ELF | 594,808 bytes; SHA-256 `f9fae84db2b68e104f19902fa38e55776ec0ab6daf0dc438392a57d382a23ff9` |

The canonical ELF extent uses `e_shoff=594232` plus nine 64-byte section
headers. The remainder of the allocated 5 MiB payload is zero padding. The
full ProgramData and ELF digests above are the identities used for comparison.

## Official-artifact mismatch matrix

Each official release's `fee_quoter.so` differs from the canonical deployed ELF
digest above. The official release tag and source commit are retained as the
reproducible artifact locators; no adjacent release is assigned to the program.

| Official tag | Source commit | Release tar SHA-256 | `fee_quoter.so` SHA-256 | Bytes | Result |
| --- | --- | --- | --- | ---: | --- |
| [`solana-v1.6.0`](https://github.com/smartcontractkit/chainlink-ccip/releases/tag/solana-v1.6.0) | `d0d81df3195728091cad1b0569a2980201a92e97` | `b5834be4385c7d1d13655b0e73c347efdadfe47377450b1aafc57a50cd4c3fbc` | `16878a3bcf2711a4fd2710c26fee2d49f62f469da6792fbfe341e4864af390fd` | 587,096 | mismatch |
| [`solana-v1.6.1`](https://github.com/smartcontractkit/chainlink-ccip/releases/tag/solana-v1.6.1) | `cb23ec38649f9d23aabd0350e30d3d649ebc2174` | `7b58a503fde7d8c347536e749cb7b1f707639af36023e97cae3176b0a591a6fa` | `ae8772f9214f947784fc79b106fd370d9d84339ea94166a4706db7cb206e2f39` | 592,680 | mismatch |
| [`solana-v1.6.2`](https://github.com/smartcontractkit/chainlink-ccip/releases/tag/solana-v1.6.2) | `9546a59bd0a3cee4ddc8ae4042da533e62225b78` | `bca66f35f7fbc31c2070dff2672db5b9ec26e58e5318be48ce1e05dd8912deb5` | `93dfc6405faa1828d81e145c013d9bbd260723e584d30be0b3eed9d1d96e35c9` | 592,680 | mismatch |
| [`solana-v1.6.3`](https://github.com/smartcontractkit/chainlink-ccip/releases/tag/solana-v1.6.3) | `1f9fb0b2d9e57626d5bb2d5c64840415228be732` | `7b0cea52ea9f4431159b31c4c9c835e46879b332414d949d5763fa4fc6ca6164` | `429806e3f07dd18f26148d99d2a8a2aecad04bc277967c126f8e0dec489e6d0d` | 592,712 | mismatch |
| [`solana-v1.6.4`](https://github.com/smartcontractkit/chainlink-ccip/releases/tag/solana-v1.6.4) | `c73892d4d33926195eee87b77013883e650a833c` | `d6305e9dfb42337716d0ef8dc0cf7a4b20a3e1a28dc6de6cd3f48271c271a5ff` | `37a3f232e0f125811c8e0e7e066c7374278db429539dd18f9c8cffbafe7c7d65` | 599,920 | mismatch |

The matching localtest artifacts for v1.6.0 through v1.6.3 also mismatch; the
examined current localtest artifacts sharing the v1.6.4 output also mismatch.
`cmp` diverged in ELF-header entry-point bytes, and `.text`, `.rodata`,
`.data.rel.ro`, and relocation comparisons differed. This excludes a
padding-only or metadata-only explanation (high confidence).

On 2026-09-22 the official GitHub release inventory still ended at
`solana-v1.6.4`. Three additional official `solana-artifacts-localtest` archives
were downloaded with `gh release download`, checked against their GitHub asset
SHA-256, and their `target/deploy/fee_quoter.so` entries hashed directly:

| Localtest release | Archive SHA-256 | Fee Quoter `.so` SHA-256 |
| --- | --- | --- |
| [`ea7ff77a0ddb`](https://github.com/smartcontractkit/chainlink-ccip/releases/tag/solana-artifacts-localtest-ea7ff77a0ddb) | `7072880e49ac873a7b6d6dbf5547b0517c87e17cd681e6143262a6c5fe803fc5` | `429806e3f07dd18f26148d99d2a8a2aecad04bc277967c126f8e0dec489e6d0d` |
| [`50f521d70e62`](https://github.com/smartcontractkit/chainlink-ccip/releases/tag/solana-artifacts-localtest-50f521d70e62) | `845f32800c5124614a69e9674ee825ecc69fb9ba495e0e5ca7887697b6fc60ef` | `37a3f232e0f125811c8e0e7e066c7374278db429539dd18f9c8cffbafe7c7d65` |
| [`720a003dab50`](https://github.com/smartcontractkit/chainlink-ccip/releases/tag/solana-artifacts-localtest-720a003dab50) | `38f0cf181de18285a23980ff80cda6ff1dfcac542208945c9adbe003994713e5` | `37a3f232e0f125811c8e0e7e066c7374278db429539dd18f9c8cffbafe7c7d65` |

None matches the deployed ELF digest `f9fae84db2b68e104f19902fa38e55776ec0ab6daf0dc438392a57d382a23ff9`.
This extends the inspected artifact set; it does not attribute the deployed
program, establish a vulnerability, or change ADR-0007's proposed status.

## Reproducibility and provenance boundary

Reproduce the observation by using finalized `getGenesisHash`, `getAccountInfo`
for the program and ProgramData, parsing Upgradeable Loader state, extracting
the ProgramData payload, calculating the ELF extent from its ELF section-header
table, and SHA-256 hashing both raw ProgramData and that ELF extent. Download
each official tag's release artifact, extract `fee_quoter.so`, then compare byte
length and SHA-256 (and, if needed, `cmp` and section hashes) to the deployed
ELF. Preserve the RPC endpoint, commitment, genesis hash, slots, raw account
bytes, release URLs, and hashes in the investigator's evidence store.

The official verified-build workflow pins `solana-verify@0.4.6` and invokes
`solana-verify build`; its Anchor configuration is `0.29.0`. It does not pin an
immutable GitHub runner image or Rust toolchain. Therefore the workflow alone
cannot reproduce or attribute the observed binary, even though official release
artifacts remain the authoritative comparison outputs.

The exact missing Chainlink attestation is: an official record binding the
deployed ELF SHA-256 `f9fae84db2b68e104f19902fa38e55776ec0ab6daf0dc438392a57d382a23ff9`
to its exact source commit, complete build and toolchain provenance, and an
official matching `.so` (or a reproducible recipe producing that digest),
preferably also binding deployment signature
`8HeCqo8V8Vy3bhouSE4nbFNkncQhMZ9yTxAyLTxPG8CyW3A2Ttn5cYSYNnvxNcBqUBZ7mSGuKd9WTE3u5vRw4of`
and slot `437468573`. Until that exists, source resemblance, directory labels,
and stable adjacent layouts are not attribution.

## Authority evidence and limits

The upgrade transaction above is finalized. Its observed timelock program is
`DoajfR5tK24xVw51fWcawUZWhAXD8yrBJVacc13neVQA`; the observed signer PDA is the
ProgramData upgrade authority above. The `timelock_signer`, `timelock_config`,
and `timelock_operation` PDA derivations reproduce from the official seed
definitions. This proves observed address relationships, not the identity or
quorum of off-curve controller members, the exact deployed timelock/access-
controller artifact, or decoded governance semantics. Those remain unqualified.

## Explicitly unqualified preparation profile

An explicitly unqualified, fail-closed preparation profile may capture and
decode finalized accounts, calculate diagnostic fees through a pinned official
SDK, and construct unsigned instructions solely for simulation. Preserve the
program ID, account owner, finalized slot, raw account hash, assumed source
revision, RPC endpoint, and simulation response with each observation. Reject
unknown layouts and decode failures instead of assigning an adjacent release.

This is preparation evidence, not attribution or a production fee guard. A fee
quote does not cap the fee charged by a later transaction, and the Fee Quoter
also contributes message parameters beyond the quoted amount. Do not promote
these observations to a qualified lane, production monitor, mainnet-ready
claim, or approval of ADR-0007. The proposed vendor-trust route still requires
deployed-binary behavior, fee-bound, configuration and authority proofs, with
the source/build mismatch disclosed. Signing, repair, deployment, and broadcast
remain blocked by the proposed ADR's qualification and approval gates.

## Primary sources

- [Pinned Chainlink mainnet chains directory](https://github.com/smartcontractkit/documentation/blob/b14cf1fbd45f88a4617cc7c8dbf668121e56649c/src/config/data/ccip/v1_2_0/mainnet/chains.json)
- [Pinned Chainlink mainnet lanes directory](https://github.com/smartcontractkit/documentation/blob/b14cf1fbd45f88a4617cc7c8dbf668121e56649c/src/config/data/ccip/v1_2_0/mainnet/lanes.json)
- [Fee Quoter account constraints at v1.6.3](https://github.com/smartcontractkit/chainlink-ccip/blob/1f9fb0b2d9e57626d5bb2d5c64840415228be732/chains/solana/contracts/programs/fee-quoter/src/context.rs)
- [Fee Quoter state layouts at v1.6.3](https://github.com/smartcontractkit/chainlink-ccip/blob/1f9fb0b2d9e57626d5bb2d5c64840415228be732/chains/solana/contracts/programs/fee-quoter/src/state.rs)
- [Router onramp use of the Fee Quoter at v1.6.2](https://github.com/smartcontractkit/chainlink-ccip/blob/9546a59bd0a3cee4ddc8ae4042da533e62225b78/chains/solana/contracts/programs/ccip-router/src/instructions/v1/onramp.rs)
- [Official CCIP SDK documentation](https://docs.chain.link/ccip/tools/sdk/)
- [Official verified-build workflow](https://github.com/smartcontractkit/chainlink-ccip/blob/c73892d4d33926195eee87b77013883e650a833c/.github/workflows/solana-verified-build.yml)
- [Official SVM upgradability description](https://github.com/smartcontractkit/documentation/blob/b14cf1fbd45f88a4617cc7c8dbf668121e56649c/src/content/ccip/concepts/architecture/onchain/svm/upgradability.mdx)
