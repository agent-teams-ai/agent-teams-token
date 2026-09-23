# Fee Quoter mainnet attribution evidence

Date: 2026-09-21; official artifact recheck: 2026-09-22; Router and Fee Quoter
configuration observations: 2026-09-23. Original read-only evidence was captured
at repository base
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

### Additional Router binding observation, 2026-09-23

At finalized slot `449641662`, official RPC `getAccountInfo` returned the Router
config PDA
`3Yrg9E4ySAeRezgQY99NNarAmFLtixapga9MZb6y2dt3`, owned by
`Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C`. The 210-byte account
has SHA-256 `c7db7f630777e0bd738f993231eb1888eff154025d5bb4626fc6e053e8e6d4b0`.
Its Anchor `account:Config` discriminator matches, version is `1`, SVM chain
selector is `"124615329519749607"`, owner is
`GoFoFfEDgALWRTw5dSY3VZQSwbFpvBEhDv1sFAWzYpbf`, `fee_quoter` is
`FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi`, and `rmn_remote` is
`RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7`. A second HTTPS RPC,
`https://solana-rpc.publicnode.com`, reported the same account owner, raw
SHA-256 and decoded fields at finalized slot `449642530`; its reported genesis
hash matched the mainnet value above.

Both RPCs returned these same public account-data bytes (base64, line breaks
added here); retaining them allows the field decode and SHA-256 check after the
live account changes:

```text
mwyq4B76zIIBAefJl2H7uLoB6rjArgURWACQPO3/FCieVBlI0ChXBc5le3xg3GY+6T4AAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANmoZhgtaQLmSSx6MoEr6jZ+GpTXBrFu
2pFEnQSGuA0BBliT7ZWrhugwWyiYp2G+HCHNv7C39ebv1T6DsoMrGlAFDUlC14STn4XZIg
vTCI8VnN55JwY38ECyqv1LWYU5A1ihu8X0thXE87Y1i+/UeYOlY7EnXlEv6Wxc9fvOtwvU
```

The PDA was independently derived from official `seed::CONFIG = b"config"`
and the Router program ID with `@solana/web3.js@1.99.0` (`findProgramAddressSync`,
bump `251`). Decode follows the matching official `solana-v1.6.2` Router
[`Config` layout](https://github.com/smartcontractkit/chainlink-ccip/blob/9546a59bd0a3cee4ddc8ae4042da533e62225b78/chains/solana/contracts/programs/ccip-router/src/state.rs),
[`config` account constraint](https://github.com/smartcontractkit/chainlink-ccip/blob/9546a59bd0a3cee4ddc8ae4042da533e62225b78/chains/solana/contracts/programs/ccip-router/src/context.rs),
and [seed definition](https://github.com/smartcontractkit/chainlink-ccip/blob/9546a59bd0a3cee4ddc8ae4042da533e62225b78/chains/solana/contracts/programs/ccip-common/src/seed.rs).
Reproduce with finalized `getAccountInfo` for that PDA and compare the raw
base64-decoded account hash and fields above. The two RPC observations show the
Router's configured Fee Quoter address at those slots; they do not
attribute the Fee Quoter ELF, verify its behavior, prove consensus independently,
or establish an AGTMAI lane. ADR-0007 remains proposed.

The same official Router layout defines a `DestChain` PDA from
`b"dest_chain_state"` and the Ethereum selector's eight little-endian bytes
(`157b9cfc94998445`). The derived account is
`CowGG7G1FsfedN4jx66Gw7co1xEsiKQfE1f8BXSnSK9w` (bump `255`). Both RPCs
returned the same 40-byte, Router-owned account at finalized slots `449643549`
and `449643661`, with raw SHA-256
`caa8d0f6c0179a1e004ad6c2e327ec9cce243f74bf0e12a1242d4c15304e7b63`.
Its `account:DestChain` discriminator matches; version is `1`, selector is
`"5009297550715157269"`, sequence number is `7864`, lane code version is
`Default` (`0`, using Router config's `V1`), and sender allowlisting is disabled.
The exact public account data, returned identically by both RPCs, is
`TRLxhNQ22hABFXuc/JSZhEW4HgAAAAAAAAAAAAAAAAAAAAAAAAAAAA==` (base64).
This establishes the configured Solana-to-Ethereum destination-chain account
at those slots. It does not establish current fee acceptance, OffRamp execution,
AGTMAI peer registration, or a qualified bidirectional lane.

### Diagnostic Fee Quoter config observation, 2026-09-23

The PDA derived from `b"config"` and the Fee Quoter program ID is
`Jexa4tyW5xjDuucnNpTc3cz3Jsq1qY8fp4P4Dd4NQAb` (bump `253`). At finalized
slots `449645856` and `449645978`, the two RPCs above returned the same
155-byte account owned by the Fee Quoter program, with SHA-256
`21de4f4de300e0522f9cd62a095ea975372a4ef229d0075d93c738d0858a80d7`.
Its `account:Config` discriminator and version `1` match the candidate
[`solana-v1.6.3` layout](https://github.com/smartcontractkit/chainlink-ccip/blob/1f9fb0b2d9e57626d5bb2d5c64840415228be732/chains/solana/contracts/programs/fee-quoter/src/state.rs)
and [PDA constraint](https://github.com/smartcontractkit/chainlink-ccip/blob/1f9fb0b2d9e57626d5bb2d5c64840415228be732/chains/solana/contracts/programs/fee-quoter/src/context.rs).
Under that layout, `onramp` points back to Router
`Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C`, the owner is
`GoFoFfEDgALWRTw5dSY3VZQSwbFpvBEhDv1sFAWzYpbf`, default code version is
`V1`, local LINK decimals are `9`, and `max_fee_juels_per_msg` is
`200000000000000000000`. The exact public account data returned by both RPCs
is retained here (base64, line breaks added):

```text
mwyq4B76zIIB6rjArgURWACQPO3/FCieVBlI0ChXBc5le3xg3GY+
6T4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIMZa
vI7XCgAAAAAAAAAFDUlC14STn4XZIgvTCI8VnN55JwY38ECyqv1L
WYU5Awmslyl34bq1//bGhikfmU/1LzSr7RvH34j3b0P5JlksjwE=
```

This is a layout-compatible diagnostic, not attribution of the mismatched ELF
or proof of Fee Quoter execution semantics. The observed maximum-fee field is
not an execution-time spending bound for an AGTMAI transaction. ADR-0007 and
the mainnet lane remain unqualified.

The candidate layout also derives an Ethereum `DestChain` PDA from
`b"dest_chain"` and selector bytes `157b9cfc94998445`:
`JCY1GFP2ayVmEsQxeRQXGZvk3nR9TovFbXF8rzcfgjHA` (bump `255`). Two finalized
RPC observations at slots `449646716` and `449646890` returned the same
120-byte, Fee-Quoter-owned account with SHA-256
`905d2e08f60128370701f90c36c10ad2c05bac61fbb5c7c80a7151f82589199d`.
Its `account:DestChain` discriminator and version `1` match the candidate
layout. Under that layout, selector is `"5009297550715157269"`,
`is_enabled = true`, `max_number_of_tokens_per_msg = 1`, and
`max_per_msg_gas_limit = 3000000`. Both RPCs returned identical public data:

```text
TRLxhNQ22hABFXuc/JSZhEUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAac6CI7Oroez
agAAAAABAAEAMHUAAMDGLQDobgMAEAAAACgAAAC4CwAAAAAAABAAAACWAJBfAQBA
DQMAAADuBCz8Qw8yAAAAkF8BAAEoEtUs
```

This is evidence of an enabled destination-chain setting under an unverified
layout interpretation, not a successful `get_fee` call, charged-fee bound,
source attribution, or proof that AGTMAI tokens can cross the lane.

### Direct diagnostic `getFee` simulations, 2026-09-23

Two read-only RPCs, `https://api.mainnet-beta.solana.com` and
`https://solana-rpc.publicnode.com`, simulated unsigned `GetFee` instructions
against finalized state at slots `449703049` and `449703050`-`449703051`,
respectively. Neither
transaction was signed or broadcast. Both observed the same Fee Quoter config
SHA-256 `21de4f4de300e0522f9cd62a095ea975372a4ef229d0075d93c738d0858a80d7`.
The Ethereum destination-chain account instead had SHA-256
`9754b747aca2fb9a0dbb7cb096290e1b3dd6801d2ebf675efbc36019137b3262`,
different from the earlier snapshot above. Its live configuration must be
re-read for any future operation. The ProgramData header at these slots still
reported last deployment slot `437468573` and upgrade authority
`GoFoFfEDgALWRTw5dSY3VZQSwbFpvBEhDv1sFAWzYpbf`; its 45-byte header
SHA-256 was `8b718bf684c181d7d1dbdbd0fb1594e543298dc3c58a9c6f8b0c22c47e621e01`.

The diagnostic used the candidate `solana-v1.6.3` [IDL](https://github.com/smartcontractkit/chainlink-ccip/blob/1f9fb0b2d9e57626d5bb2d5c64840415228be732/chains/solana/contracts/target/idl/fee_quoter.json),
[account constraints](https://github.com/smartcontractkit/chainlink-ccip/blob/1f9fb0b2d9e57626d5bb2d5c64840415228be732/chains/solana/contracts/programs/fee-quoter/src/context.rs)
and [message validation](https://github.com/smartcontractkit/chainlink-ccip/blob/1f9fb0b2d9e57626d5bb2d5c64840415228be732/chains/solana/contracts/programs/fee-quoter/src/instructions/v1/messages.rs)
only as an assumed layout. The receiver was a 32-byte ABI-encoded diagnostic
EVM address; destination selector was `5009297550715157269`; native SOL was
selected as the fee token. Extra args requested 200,000 destination gas and
out-of-order execution. The token path used the existing Solana LINK mint with
1,000,000 base units, not AGTMAI. The full candidate `GetFeeResult`, including
processed extra args, was decoded and its raw bytes retained.

| Simulation | Both RPC results | Candidate decoded return |
| --- | --- | --- |
| Empty message | success | 11,520,129 lamports; 105,083,590,000,000,000 juels; gas 200,000; out-of-order true; no token-transfer additional data |
| LINK token message | success | 21,576,154 lamports; 196,812,009,000,000,000 juels; gas 200,000; out-of-order true; token-transfer overhead 32 destination bytes and 90,000 destination gas |
| 20-byte EVM receiver | error `10009` (`InvalidEVMAddress`) | no return data |
| Invalid extra-args tag | error `8029` (`InvalidExtraArgsTag`) | no return data |
| Wrong token billing PDA | error `8015` (`InvalidInputsBillingTokenConfig`) | no return data |

The two RPCs returned identical result bytes and error codes for these exact
inputs. The unsigned instruction bytes, ordered account metas, raw return data,
logs, account hashes and slots are retained in the worker's durable evidence
directory
`/srv/worker-state/jobs/agent-teams-token/mainnet-readiness-20260923/evidence/fee-quoter-diagnostic-20260923-v3/`.
The diagnostic script SHA-256 is
`cdd8a26fdf164c43c87c56ed77de487d6e3c23dc003c1b50b8d253cf3d0c1192`;
the official-RPC and PublicNode JSON SHA-256 values are
`7c572f090a64859a56861c56a726e52139d254a446ebb6a38a490331f38eb427`
and `6aa42f4903ed35cb97551c4ea2110fc58346e4125d6312306b9851c9b3832a4d`.
The script used `@solana/web3.js@1.99.0` with retained lockfile SHA-256
`5453056ad611811f6a15f21b27739d2485139c8c9157bacb8805d6f4798b9427`.

These observations show bounded behavior for two sample message shapes at
those slots. Two RPC operators are not independent consensus proof. The tests
do not exercise an AGTMAI mint/pool, establish an execution-time spending cap,
authenticate the deployed ELF's source, or qualify the bidirectional lane.
ADR-0007 remains proposed.

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
the source/build mismatch disclosed. While ADR-0007 remains proposed, signing,
repair, deployment, and broadcast remain blocked. Its staged pre-deployment gate,
if accepted later, would require separate approval of exact transactions;
actual runtime, configured peers and authorities, and settled transfers are
post-deployment evidence, not preconditions for an undeployed pool.

### Candidate transaction-scoped fee ceiling, not yet qualified

The pinned Router `solana-v1.6.2` source calls `get_fee` inside `ccip_send` and
passes its returned amount to `TransferChecked` for a non-native SPL fee token.
The fee source is constrained to the caller's associated token account; the
transfer authority is the Router's `fee_billing_signer` PDA. The instruction
does not accept a caller-selected maximum fee. This is the
[onramp path](https://github.com/smartcontractkit/chainlink-ccip/blob/9546a59bd0a3cee4ddc8ae4042da533e62225b78/chains/solana/contracts/programs/ccip-router/src/instructions/v1/onramp.rs),
[account constraint](https://github.com/smartcontractkit/chainlink-ccip/blob/9546a59bd0a3cee4ddc8ae4042da533e62225b78/chains/solana/contracts/programs/ccip-router/src/context.rs),
and [billing CPI](https://github.com/smartcontractkit/chainlink-ccip/blob/9546a59bd0a3cee4ddc8ae4042da533e62225b78/chains/solana/contracts/programs/ccip-router/src/instructions/v1/fees.rs).

A bounded candidate is one Solana transaction containing, in order,
`ApproveChecked` for that PDA and an owner-approved maximum amount on the exact
fee ATA, `ccip_send` for the exact message, and `Revoke` on the same ATA. The
[Token Program delegation contract](https://solana.com/docs/payments/advanced-payments/spend-permissions)
limits the PDA to the approved amount. If the execution-time quote is higher,
the fee transfer should fail and [transaction rollback](https://solana.com/docs/core/transactions/transaction-pipeline)
should leave no CCIP token transfer or message; the ordinary Solana network fee
can still be charged. A successful `Revoke` should leave no residual delegation.
Native-SOL fee payment does not use this delegated-token bound.

This is a source-derived design candidate, **not a tested fee ceiling**. Before
ADR-0007 acceptance, independently verify the deployed Router binding, fee
mint/program and ATA, exact PDA, supported fee-token configuration, instruction
ordering and transaction size. Simulate an AGTMAI-shaped message both below and
above the cap against the deployed programs, compare post-simulation account
effects and message parameters, and retain the full observation. No production
adapter, signing, or broadcast follows from this candidate.

## Primary sources

- [Pinned Chainlink mainnet chains directory](https://github.com/smartcontractkit/documentation/blob/b14cf1fbd45f88a4617cc7c8dbf668121e56649c/src/config/data/ccip/v1_2_0/mainnet/chains.json)
- [Pinned Chainlink mainnet lanes directory](https://github.com/smartcontractkit/documentation/blob/b14cf1fbd45f88a4617cc7c8dbf668121e56649c/src/config/data/ccip/v1_2_0/mainnet/lanes.json)
- [Fee Quoter account constraints at v1.6.3](https://github.com/smartcontractkit/chainlink-ccip/blob/1f9fb0b2d9e57626d5bb2d5c64840415228be732/chains/solana/contracts/programs/fee-quoter/src/context.rs)
- [Fee Quoter state layouts at v1.6.3](https://github.com/smartcontractkit/chainlink-ccip/blob/1f9fb0b2d9e57626d5bb2d5c64840415228be732/chains/solana/contracts/programs/fee-quoter/src/state.rs)
- [Router onramp use of the Fee Quoter at v1.6.2](https://github.com/smartcontractkit/chainlink-ccip/blob/9546a59bd0a3cee4ddc8ae4042da533e62225b78/chains/solana/contracts/programs/ccip-router/src/instructions/v1/onramp.rs)
- [Official CCIP SDK documentation](https://docs.chain.link/ccip/tools/sdk/)
- [Official verified-build workflow](https://github.com/smartcontractkit/chainlink-ccip/blob/c73892d4d33926195eee87b77013883e650a833c/.github/workflows/solana-verified-build.yml)
- [Official SVM upgradability description](https://github.com/smartcontractkit/documentation/blob/b14cf1fbd45f88a4617cc7c8dbf668121e56649c/src/content/ccip/concepts/architecture/onchain/svm/upgradability.mdx)
