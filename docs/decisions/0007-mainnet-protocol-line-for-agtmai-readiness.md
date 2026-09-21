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

The Fee Quoter mismatch blocks qualification. It must not be assigned an
adjacent release version.

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

This ADR remains proposed until the Fee Quoter has an exact official
release/build match; EVM artifacts and finalized code/configuration evidence;
actual registry account/version evidence; both-direction compatibility; enabled
peer configuration; and authority/backing proofs are independently reviewed.
It authorizes no deployment, signing, repair, or broadcast.

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
