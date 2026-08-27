# Transparent token release contracts

Status: design proposal for discussion. No contract in this document is deployed
or approved for mainnet.

## What the contracts must prove

The contracts must make four facts independently verifiable:

1. all `100,000,000` tokens are created once and sent to named allocation
   contracts, not to the founder or a general treasury wallet;
2. every allocation has a narrow purpose, a visible controller and an
   enforceable release limit;
3. neither a Safe nor an administrator can bypass a limit through a generic
   `transfer`, `approve`, arbitrary call, upgrade or replacement;
4. every commitment is visible before recipients can receive liquid tokens.

Contracts can enforce amounts, time, roles, destinations and code paths. They
cannot prove that a grant recipient did useful work or that a published reason
is truthful. Those facts require independent reviewers, public evidence and
conflict-of-interest disclosure. The dashboard must distinguish these two kinds
of guarantees instead of calling both of them "onchain enforced".

## Proposed contract map

```text
ProjectToken (fixed supply, no owner mint, no proxy)
├── CommunityGovernanceReserveVault  45%
├── CommunityDistributionVault       25%
├── ContributorGrantReserveVault     at least 9%
├── founder NoCatchUpVesting          at most 3%
├── initial-team NoCatchUpVesting     at most 3%
├── OperationsBudgetVault              8%
├── EcosystemGrantVault                6%
└── LiquidityVault                     1%
```

The token constructor mints each amount directly to the declared final contract.
The deployer, deployment factory and Treasury Safe end genesis with zero tokens.
The deployment sequence must solve the token/vault-address dependency without a
temporary custodian or an externally callable initialization window. This is a
mandatory local deployment spike before contract implementation is accepted.

Every vault is immutable and purpose-specific. It has no proxy, asset rescue for
`AGTMAI`, arbitrary call, arbitrary ERC-20 approval, controller replacement or
generic transfer function. Accidentally sent unrelated assets use a separately
bounded recovery path that can never address `AGTMAI`.

## Shared release mechanics

A release is charged against its limit when the project creates an irrevocable
commitment, not when a recipient later claims it. This prevents a large approved
batch from being hidden as "not yet claimed".

Each commitment records at least:

```text
allocation ID
recipient or distributor contract
maximum amount
earliest claim time
expiry or vesting schedule
reason/evidence hash
approving proposal ID
related-party flag and independent approval where required
```

The proposed rolling limit uses append-only cumulative checkpoints. A new
commitment is valid only when the cumulative amount committed during the previous
exact `365 days` plus the new amount is within the allocation cap. Unused capacity
does not carry forward. Returned or unclaimed tokens do not restore an old period's
capacity. This avoids both a calendar-year boundary double spend and an unbounded
loop over every old payment.

All ordinary commitments pass a seven-day timelock. The emergency group can only
cancel during a non-renewable authority period or reduce bridge limits. It cannot
create commitments, transfer tokens, shorten delays or grant itself a new period.

## Community governance reserve - 45%

Before community governance activation, project roles have no function that can
move, approve, bridge, stake or delegate these tokens. The reserve tokens also
have no voting power.

Activation must be a one-way transition into a known, immutable governance path.
It must not be a project Safe choosing any address and calling it "community
governance". The exact activation gate is intentionally still open because it
changes the trust model. At minimum it requires:

- an earliest activation time and a minimum amount of genuinely distributed
  community supply;
- a public proposal and code hash fixed before voting;
- a vote by circulating community holders with flash-loan/capture protections;
- approval by an independent activation group with disclosed affiliations;
- a seven-day delay and a verifier proving the destination code and role graph;
- permanent retention of the `2%` total-supply rolling 365-day commitment cap.

Activation changes who may create bounded commitments; it does not transfer all
45% to an unrestricted treasury. Until this mechanism is approved and tested,
the honest public statement is: "45% is inaccessible to the project and is not
yet controlled by the community."

## Community distributions - 25%

Each wave is a separately funded distributor. Funding the distributor consumes
the wave and rolling-period limits immediately. A Merkle root cannot be replaced
after funding. Recipient and amount are public when claimed; personal data and
wallet-linkage evidence never enter the leaf.

Unclaimed value after the fixed claim window returns only to this reserve and
does not become project funds. Pilot, per-wave, year-one and later rolling caps
from the tokenomics proposal are enforced in the vault, not only monitored.

## Founder, team and future contributors - 15%

Founder and initial-team amounts go directly to separate
`NoCatchUpVesting` contracts. Claimable value is zero before each cliff, then
grows linearly from zero to the full amount at the declared end. There is no
large first-day catch-up release and no beneficiary-change function.

The future contributor reserve can only create a new vesting grant through the
Project Timelock. A grant start cannot be earlier than the approving proposal's
execution time. Creating the grant consumes the rolling grant cap. Revocation can
return only the unvested part to the same contributor reserve; vested value remains
owed to the beneficiary.

The contract can prove the amount and schedule, but not that the recipient earned
the grant. Public milestone evidence, independent approval for related parties and
a conflict register remain mandatory human controls.

## Operations - 8%

The operations vault may create disclosed payments or payment schedules within
the `0.5%` total-supply rolling cap. It cannot sell tokens through a DEX, fund a
pool, approve a router or send tokens to another unrestricted project vault during
beta. Vendor payments may ultimately reach an ordinary wallet, so each one exposes
the recipient, amount, purpose hash and timelocked proposal.

Tokens are not counted as payroll runway. Real audits, infrastructure, legal work
and salaries still need a separate stablecoin or fiat budget.

## Ecosystem and public grants - 6%

The grant vault funds individual milestone-based grant escrows within its `1%`
rolling cap. A related-party grant additionally requires an independent approval
role that cannot be held by the grant proposer or recipient. Milestone release and
cancellation rules are fixed when the escrow is created.

No contract can detect a fake milestone by itself. The dashboard therefore shows
both the enforceable payment schedule and the human evidence/approver behind it.

## Liquidity - 1%

The liquidity vault can fund only a pre-approved pool position or deterministic
pool-deposit adapter, never an arbitrary wallet or router call. The first deposit
is capped at `0.01%` of total supply and cumulative experimental beta deposits at
`0.1%`. Deposited tokens become circulating immediately.

Community members add their own assets directly to the pool and own their own LP
positions. Project LP custody and withdrawal powers are public. "Held by Squads"
must not be described as "locked" while Squads can withdraw.

## Contract-level tests required before audit

- no role can bypass a vault through transfer, approval, arbitrary call, upgrade,
  replacement, delegate call or token recovery;
- rolling limits hold across exact boundary timestamps and long idle periods;
- creating a commitment consumes capacity once, while claiming consumes none;
- cancellation, expiry and unclaimed returns cannot manufacture new capacity;
- founder/team claimable value is zero at the cliff and grows from zero after it;
- backdating, beneficiary replacement and double claiming fail;
- governance-reserve movement is impossible before a valid one-way activation;
- activation cannot replace the bounded vault with an unrestricted treasury;
- emergency powers are down-only, expire and cannot renew themselves;
- direct genesis balances and the manifest sum exactly to fixed supply;
- stateful fuzz tests cover colluding roles, malicious recipients and hostile
  ERC-20 callbacks even though the canonical token itself is simple.

Independent audit is still required before mainnet. Passing tests means the code
matches the stated rules; it does not mean the economic policy or human approvals
are automatically good.
