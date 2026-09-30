---
id: ADR-0011
type: adr
status: proposed
owner: architecture
summary: Proposes immutable rolling-gross-outflow vaults for six non-grant allocations, implemented locally before production policy selection.
related: [ADR-0008, ADR-0009, ADR-0010]
blocked_by: []
code_anchors:
  - pattern: contracts/evm/src/features/purpose-reserves/PurposeReserveVault.sol
    enforcement: advisory
supersedes: []
superseded_by: []
---

# ADR-0011: Purpose reserve vaults

## Context

ADR-0008 fixes the grant reserve policy. The six other allocation recipients
are purpose-labeled but currently lack onchain outflow limits. This proposal
adds a local contract primitive without selecting production parameters or
rewriting accepted grant decisions.

## Decision

For each non-grant purpose, use an instance of one immutable vault bound to a
token contract, controller contract, purpose, opening time, window duration
and rolling gross outflow cap. The controller can transfer after opening to
any valid recipient. Each successful transfer consumes the cap for the exact
half-open interval `(now - window, now]`; returned or donated tokens never
erase gross outflow. A full cap can leave at the opening instant. The vault
uses cumulative checkpoints, coalesces same-timestamp transfers, requires
exact token balance changes and rejects reentrant transfers. It exposes no
setter, upgrade, approval, arbitrary call, rescue or lifetime cap.

Checkpoint 1 implements and tests this primitive in dev mode. It does not
wire genesis, select production addresses/caps/dates, deploy contracts or
qualify an actual Safe. A controller can choose an address it controls, and
the vault cannot constrain downstream movement. Code existence is not
authentication of the token or Safe; deployment artifact and Safe checks
belong to later local checkpoints and independent production qualification.

## Consequences

Six local instances can be wired in a later checkpoint without changing the
grant controller or founder vault. Gross accounting prevents refunds from
replenishing current window capacity, but time expiry restores it. There is
no lifetime depletion limit. Production use requires reviewed exact
parameters, custody, token and controller identity, security evidence and
the existing launch gates. Public distributions, market liquidity and
bridge operations remain separately governed.

## Rejected alternatives

- A generic treasury or arbitrary-call interface would bypass the purpose
  policy.
- A lifetime cap would impose an additional permanent-spend policy that has
  not been selected.
- A global market liquidization budget belongs to ADR-0009's later analysis.
