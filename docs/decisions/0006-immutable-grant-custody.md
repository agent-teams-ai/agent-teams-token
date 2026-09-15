---
id: ADR-0006
type: adr
status: proposed
owner: architecture
summary: Selects one immutable fully funded vault per contributor grant with fixed routing and GrantAccounting-owned vesting transitions.
---

# ADR-0006: Immutable grant custody

## Context

Contributor grants already use `GrantAccounting` for the accepted individual
zero-through-cliff and linear-to-end curve. Production custody must connect that
ledger to real ERC-20 movement without adding provisional percentages, reserve
budgets, governance machinery or a mutable beneficiary. Founder principal must
never be cancellable; team cancellation must preserve unpaid vested debt and
return only unvested tokens to the originating reserve.

## Decision

Use one immutable full-code `GrantVault` per founder or team grant. Constructor
inputs bind the ERC-20, beneficiary, originating reserve, controller, allocation,
kind, purpose and exact UTC schedule. The vault uses `GrantAccounting` unchanged
for vesting and transition arithmetic.

The originating reserve alone may activate the vault by an exact, one-time pull
of the full allocation no later than the grant start. The beneficiary alone may
release all currently available entitlement, always to its bound address. The
controller alone may cancel a funded team grant at `block.timestamp`; it is an
immutable address intended for a Safe 2-of-3, not an implementation or
verification of Safe policy. Founder cancellation remains rejected by the
accounting library.

Funding, release and nonzero refund require successful typed IERC-20 calls and
exact sender-debit/recipient-credit balance deltas under a common reentrancy
guard. Team cancellation transfers only `allocation - frozenEntitlement` to the
immutable originating reserve. Vested but unreleased entitlement stays in the
same vault and remains claimable. No refund callback or reserve-cap reset exists.

There is no factory, shared manager, proxy, upgrade path, ownership transfer,
beneficiary/controller replacement, pause, arbitrary execution, token approval
or AGTMAI recovery function.

## Consequences

Each grant has isolated custody and a small fixed authority surface. Deployment
review remains responsible for canonical token identity, the actual Safe and
reserve, exact base-unit allocation, purpose and calendar-derived UTC instants.
Role addresses may alias one another where operationally intended, but none may
be zero or the vault itself; only the token must have deployed code.

Donated AGTMAI does not activate or enlarge a grant and has no recovery path.
Alternative transfer semantics, fees, rebasing and no-return ERC-20s are
unsupported. A malicious token can lie about balances, so exact delta checks do
not replace deployment identity verification.

Before funding, source rollback can remove the slice. After funding, replacing
repository code cannot reverse custody: founder principal remains bound to the
beneficiary, and team cancellation recovers only unvested value while unpaid
vested debt remains in the original vault.

## Rejected alternatives

- Constructor token pulls, because they require predicted-address approval and
  complicate a separately reviewable atomic activation.
- A shared manager, because pooled balances introduce cross-grant solvency and
  routing risk.
- A factory, because no current deployment invariant requires another mutable or
  privileged production component.
- OpenZeppelin `VestingWallet`, because its cliff catch-up and ownership model do
  not implement the accepted no-catch-up, fixed-beneficiary cancellation rules.
