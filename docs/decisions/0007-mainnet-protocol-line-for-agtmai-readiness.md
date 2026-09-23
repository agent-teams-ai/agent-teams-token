---
id: ADR-0007
type: adr
status: proposed
owner: architecture
summary: Defines the qualified EVM and Solana protocol identities, layouts, authority model and backing semantics required before any mainnet readiness claim.
---

# ADR-0007: Mainnet protocol line for AGTMAI readiness

## Context

The readiness evaluator must identify the exact CCIP protocol line before it
interprets authorities, pool accounts, remote token bytes, or backing. Testnet
success and mocked delivery do not establish mainnet compatibility.

## Decision

This is a proposed acceptance profile, not evidence of an AGTMAI mainnet
deployment. Its EVM side is a candidate LockRelease artifact whose future
deployment must be bound to the actual backing holder; the Solana side is the
standard SPL Token BurnMint pool program. No AGTMAI mainnet LockRelease pool,
EVM bytecode, configuration, or authority binding is established here.

The reviewed official directory snapshot is
`smartcontractkit/documentation` commit
`b14cf1fbd45f88a4617cc7c8dbf668121e56649c`:

| Network | Selector | Accepted directory identities |
| --- | --- | --- |
| Ethereum mainnet | `"5009297550715157269"` | Router `0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D` (directory `1.2.0`); RMN proxy `0x411dE17f12D1A34ecC7F45f49844626267c75e81` (`1.0.0`); TokenAdminRegistry `0xb22764f98dD05c789929716D677382Df22C05Cb6` (`1.5.0`); registry module `0x4855174E9479E211337832E109E7721d43A4CA64` (`1.6.0`). |
| Solana mainnet | `"124615329519749607"` | Router `Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C`; RMN `RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7`; Fee Quoter `FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi`; BurnMint pool `41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB`; LockRelease pool `8eqh8wppT9c5rw4ERqNCffvU6cNFJWff9WmkcYtmGiqC`. |

The directory's `1.6.0` lane labels identify local endpoints, not exact
deployed artifacts, compatibility, enabled configuration, peer configuration,
or authority:

| Direction | Source OnRamp | Destination OffRamp | Directory labels |
| --- | --- | --- | --- |
| Ethereum → Solana | `0x913814782144864e523C3FdB78E3ca25D2c2aeCa` | `offqSMQWgQud6WJz694LRzkeN5kMYpCHTpXQr3Rkcjm` | both `1.6.0` |
| Solana → Ethereum | `Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C` | `0x26d3681DfC9E4c8C79cfbf461adec8A21d5d73C5` | both `1.6.0` |

The supplied finalized-RPC snapshot establishes a mixed Solana component
matrix, rather than a single Solana `1.6.3` baseline. Full ProgramData and
matching official artifact hashes are:

| Program | Exact official release | ProgramData SHA256 | Matching `.so` SHA256 |
| --- | --- | --- | --- |
| Router | `solana-v1.6.2` | `7bd3f7408d54cce675ce3215b39c44faf7bd92864b2b52e69ed1f3bb67ad94bb` | `2f5fc714a35159e658a6eb920acba6613a53168044464d85a1b04a3791ea25c3` |
| BurnMint pool | `solana-v1.6.2` | `7ee31ec2f0394eac0328708a13bcaa6a7264e5f757513d4bc8eb21416ec978a0` | `49d9f7b1bbfea6aef89405f52a74240d87b6509b7d5482113bc5204c45f35f1d` |
| LockRelease pool | `solana-v1.6.2` | `bcd109cafb37d8d44a823103fcace13ac6cdde9f23297d6a8ec3fda27fc36e91` | `f4bd641b36a76a2de6e06777001e806cf3e9380f1305b33386040431fd3e2347` |
| OffRamp | `solana-v1.6.3` | `22a6e20a3b677531e1ef8e1d75672d4013e9336b34c48d9703b9349ee4fa033d` | `3dd19c2c4542fdb1eca1d2b0f3e770b16aed5ad242191adfe149f856553cd75d` |
| RMN | `solana-v1.6.3` | `80523981fd2bc45966c887579b87413be158542adf02f1f509d599336b8d7e03` | `698ccbe5b017a8c895cb10030f2aef18033340851fad5e4d6fb58c50a4245e9d` |
| Fee Quoter | no exact match in supplied `solana-v1.6.0`–`solana-v1.6.4` artifacts | `5dcbe5e23b0cf5b673fc191cdbe50e8bedd907c0482b55351689a2b3f22170ac` | none |

The Fee Quoter must not be assigned an adjacent release version. Its exact
source/build attribution remains unknown. The mismatch is not itself evidence
of a vulnerability, but a directory identity or a successful fee quote cannot
establish the deployed program's behavior.

The bounded finalized-RPC, authority, and artifact comparison record is
[Fee Quoter mainnet attribution evidence](../architecture/fee-quoter-mainnet-evidence-2026-09-21.md).
It establishes no exact Fee Quoter artifact attribution: the source commit,
build/toolchain provenance, and official matching `.so` remain missing. This
ADR and mainnet lane qualification remain open. Exact source attribution is
stronger assurance, but the proposed alternative below would explicitly trust
Chainlink's deployed implementation and upgrade governance rather than claim
that the deployed binary was source-verified.

Encoding is directional: Ethereum token identities stored in Solana remote
configuration are ABI32 and Ethereum pool identities there are raw20. Solana
mint and pool identities stored in Ethereum remote configuration are raw32.
The TokenAdminRegistry extended serialized layout is 170 bytes, with the final
`supports_auto_derivation` boolean at byte 169. A real mainnet registry
account's version, owner, PDA, and contents remain unproven; release version
does not prove account version or layout.

The intended future Ethereum backing holder remains the reconciliation point
for fixed issuance, Solana supply, and finalized pending effects. Its pool
owner, router/RMN bindings, registry and limiter administration, rebalancer or
withdrawal powers, Solana pool administration, and ProgramData upgrade
authority require authenticated capability records. This requirement is not
currently enforced fail-closed by the readiness implementation.

The official EVM `LockReleaseTokenPool` source at
[`contracts-ccip-v1.6.1`](https://github.com/smartcontractkit/chainlink-ccip/blob/bbab0601244ce58e2ffac0dbc178a80aab1fa4a3/chains/evm/contracts/pools/LockReleaseTokenPool.sol)
and [`contracts-ccip-v1.6.4`](https://github.com/smartcontractkit/chainlink-ccip/blob/bccdd15b734ea6c0e6d1b3d36c482e64ced2d441/chains/evm/contracts/pools/LockReleaseTokenPool.sol)
allows the owner to set a rebalancer, which can call `withdrawLiquidity` to
remove locked tokens without checking remote liabilities or transfer rate
limits. The owner can also replace the Router, which controls OffRamp
authorization, and change remote peers. A direct Safe owner therefore retains
routes to remove or misdirect backing even if the observed rebalancer starts at
zero. A generic timelock delays these powers but does not remove them. Before
claiming that backing is inaccessible to the owner, a protocol-specific
restricted ownership policy and its bypass tests must be accepted; otherwise
an explicitly approved custodial pilot must disclose the actual powers. The
fixed-configuration alternative can prevent migration and strand outstanding
remote supply, so this proposal does not select or implement it. Any relaxation
of [the bridge-administration invariants](../NON_NEGOTIABLES.md#treasury-vesting-и-governance)
requires a separate ADR, threat review, and explicit owner decision.

This ADR remains proposed. A future source-authenticated qualification can use
an exact official Fee Quoter release/build match. A proposed vendor-trust route
may instead retain the mismatch as an explicit limitation, provided independent
review proves all of the following for the exact intended transfer shape:

- finalized deployed program identities, code/ProgramData hashes, upgrade
  authorities, actual Router-to-Fee-Quoter binding, account owners, PDAs and
  layout versions;
- enabled lanes, exact token/pool peers, directional encoding, nine-decimal
  mapping, direct Solana Pool Signer mint authority and absent freeze authority;
- bounded positive and malformed/unsupported-message tests against the deployed
  Fee Quoter, including its full returned message parameters, not only quotes;
- a tested execution-time fee spending bound, since an earlier quote or
  simulation cannot cap a later transaction;
- pinned candidate EVM pool artifact, expected runtime hash, constructor
  arguments, ownership and Router/OffRamp capabilities, rate limits, and
  backing-accounting method.

Unknown layouts, changed code or authorities, missing observations and failed
tests keep the lane unqualified. The vendor-trust route does not prove source
equivalence or eliminate Chainlink governance risk. The backing-control choice
above and the existing legal, owner-approval and mainnet canary gates remain
separate. This proposed ADR authorizes no deployment, signing, repair, or
broadcast.

The items above are **pre-canary evidence**, not a claim that the undeployed
AGTMAI pool has settled a transfer. A separately approved mainnet deployment
and bounded canary may proceed only after this ADR and the separate
backing-control decision are accepted, the pre-canary evidence is reviewed,
the unsigned deployment and fee/spend bounds are checked, and the owner gives
fresh approval for the exact transactions. Acceptance of this ADR alone does
not approve any broadcast. After deployment, compare the actual EVM runtime,
owners, Router/OffRamp bindings, peers, limits, and backing balance with the
approved plan before any canary transfer. Qualify the lane only after
separately approved small transfers settle in both directions and the
fixed-supply/backing reconciliation passes. A failed comparison or settlement
halts the canary; simulation never substitutes for settled mainnet evidence.

Before that evidence exists, an explicitly unqualified preparation profile may
perform read-only account decoding, diagnostic fee quotes, and unsigned
simulation against pinned upstream layouts and SDK behavior. It must bind each
observation to the program ID, account owner, finalized slot, raw account hash,
and assumed source revision; unknown layouts or failed decoding remain unknown.
Unsigned instructions may be constructed solely for simulation. These results
cannot qualify the deployed Fee Quoter, establish a fee ceiling, or be promoted
to a production monitor or readiness claim. While this ADR remains proposed,
signing, repair, deployment, and broadcast remain blocked. Neither
qualification route above has been proven.

## Consequences

A future qualified readiness report must distinguish an unqualified protocol
from an absent deployment and from an authority or backing discrepancy.
Protocol upgrades require a new ADR or an explicit superseding decision and a
new pinned snapshot. Testnet fixtures remain separate evidence.

## Rejected alternatives

Tutorial mintable tokens are rejected because they change the supply model.
CCIP `2.0.0` is not a substitute until its exact package/artifacts and custody
differences are qualified; a directory or pool-factory label alone proves no
LockBox or custody migration. Generic bridge adapters and inferred account
layouts are also rejected.

## Evidence

- Directory chains snapshot SHA256:
  `12070eb4e156ee5e1f77d7a65098582805da9373e213674edd01b0f254646275`.
- Directory lanes snapshot SHA256:
  `680d5ffd65de0d81de0e175177b6f3de1d7ead1bd383b7c0b062df31eca406dd`.
- On-chain comparison snapshot SHA256:
  `ee7f12649b250f17690a1810119b9cdaf2411f7a022fb87f385c5908164d72c8`.
