---
id: ADR-0008
type: adr
status: accepted
owner: architecture
summary: Defines the bounded production reserve allocation, grant custody and gross commitment policy for AGTMAI.
---

# ADR-0008: Production reserve commitment policy

## Context

AGTMAI needs transparent allocation and grant controls without a generic
treasury, unrestricted administrator calls or a governance system that does not
yet exist. The selected launch envelope is a fixed 100,000,000-token supply
with 9 decimals and the following purpose allocation:

| Long-term | Users | Contributors | Operations | Ecosystem | Financing | Liquidity |
|---:|---:|---:|---:|---:|---:|---:|
| 30% | 30% | 20% | 9% | 5% | 5% | 1% |

The contributor envelope is split into a 3% founder grant and a 17% reserve for
future contributors. Founder rights are irrevocable after funding. Contributor
grants are revocable: a successful cancellation returns only the unvested
amount to the originating reserve while vested and already released value stays
the beneficiary's claim.

## Decision

Use two narrow immutable funding contracts alongside the existing `GrantVault`:

- `FounderGrantReserve` can fund one exact 3% founder grant. The grant uses the
  agreed individual 12-month cliff and linear vesting through month 48 and has
  no cancellation route.
- `ReserveController` can create and fully fund only contributor grants whose
  kind and purpose match the controller's immutable policy. Each grant is
  limited by an immutable per-grant cap and the controller charges the full
  amount against an immutable rolling 365-day gross commitment cap.

Commitments are charged when funding succeeds. Refunds never restore a used
cap or delete the historical gross commitment. A failed funding transaction
reverts its corresponding commitment. The contracts expose no generic transfer,
approval or arbitrary-call escape hatch.

Custody is split between a Project Controller Safe and a Founder Beneficiary
Safe. Each is a separate Safe 2-of-3 configuration using separate keys and
devices, while beneficial control remains with the solo founder. Multiple keys
do not establish independent human control. The exact Safe addresses and owner
addresses remain mandatory unresolved deployment inputs.

`ReserveGenesis` and the public reserve-facts compiler validate the allocation
envelope and the 3%/17% contributor split deterministically. Exact cap values,
beneficiary addresses, Safe owners, deployment dates and chain addresses remain
explicit deployment configuration. This ADR authorizes no deployment, signing,
RPC broadcast, liquidity, sale, airdrop, utility checkout, burn or governance.

## Consequences

The code can prove the amount and purpose of every admitted grant and the
remaining rolling commitment capacity. It cannot prove that a beneficiary is
independent of the owner or that a Safe's human keys remain independent; those
facts require public disclosure and separate Safe qualification. The 30/30/20/9/
5/5/1 numbers are allocation purposes, not circulating-supply or market-demand
claims. Future changes require a new ADR and a new reviewed deployment input.

The MVP deliberately uses the rolling 365-day gross commitment cap and
per-grant caps. It does not include the former global 30/90-day liquidization
budget. Before any later public market or liquidity launch, circulating-supply
and synchronized-unlock analysis must be published, and a separate global
unlock/liquidization budget must be explicitly accepted or rejected. That future
decision does not block code-only deployment preparation.

Legal work is outside this repository's code scope, not waived. External review
of entity, jurisdiction, classification and disclosures is required before
mainnet genesis or any public sale, airdrop, liquidity promotion or user-facing
utility offer.

## Rejected alternatives

- A generic reserve manager with arbitrary `transfer`, `approve` or `execute`
  was rejected because it would make the published purpose and caps bypassable.
- Calendar-year quotas were rejected because boundary-adjacent grants could
  bypass a yearly limit; the rolling window closes that gap.
- A burn or mint redesign was rejected because it would change the fixed-supply
  and bridge backing invariants outside this slice.
