---
id: ADR-0009
type: adr
status: accepted
owner: architecture
summary: Records the solo-founder Safe custody split and the gates that remain outside the bounded reserve-contract MVP.
related: [ADR-0008]
blocked_by: []
code_anchors: []
supersedes: []
superseded_by: []
---

# ADR-0009: Custody split and launch gates

## Context

ADR-0008 fixes the production reserve and grant policy. Deployment still needs
an explicit custody topology and an honest boundary between the current
contract MVP and later market, legal and utility decisions. Those additions
must not mutate the immutable ADR-0008 record.

## Decision

Use separate Project Controller Safe and Founder Beneficiary Safe
configurations. Each Safe is 2-of-3 with keys kept on separate devices, while
beneficial control remains with the solo founder. Multiple keys do not establish
independent human control. Exact Safe addresses and owner addresses remain
mandatory unresolved deployment inputs.

The current MVP uses ADR-0008's rolling 365-day gross commitment cap and
per-grant caps. It does not implement the former global 30/90-day liquidization
budget. Before any later public market or liquidity launch, publish
circulating-supply and synchronized-unlock analysis and explicitly accept or
reject a separate global unlock/liquidization budget.

Legal work is outside the repository's code scope, not waived. External entity,
jurisdiction, classification and disclosure review is required before mainnet
genesis or any public sale, airdrop, liquidity promotion or user-facing utility
offer.

This decision authorizes no deployment, signing, broadcast, public sale,
airdrop, liquidity action, utility checkout, burn or governance.

## Consequences

Production configuration can require two distinct Safe identities without
claiming independent governance. Code-only deployment preparation can proceed
without inventing addresses or future market controls. Mainnet genesis stops at
the external legal-review gate, and a later market launch stops until its
circulating-supply and synchronized-unlock analysis is reviewed.

## Rejected alternatives

- Treating three keys as three independent people was rejected because one
  founder controls all keys.
- Reintroducing the former global liquidization budget into the current MVP was
  rejected because no public market or liquidity launch is in this scope.
- Removing legal review from launch readiness was rejected because excluding a
  legal model from code does not waive external launch obligations.
