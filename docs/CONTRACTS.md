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
The recommended genesis scheme is a one-shot `GenesisAssembler`: it deploys the
full-code allocation contracts, binds them to the one canonical token and deploys
the token that mints directly to those contracts in one atomic transaction. It
has no public initializer, clone or proxy. A local gas/block-limit spike, CREATE2
collision tests and final code/config-hash verification are mandatory before the
scheme is accepted.

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

The exact interval is `(now - 365 days, now]`; a commitment at the left boundary
is excluded. Same-timestamp writes coalesce, lookup stays `O(log n)`, and each
vault also has a rolling commitment-count cap plus bounded children/tranches so
one-base-unit commitments cannot create unbounded storage growth.

Commitment limits alone do not prevent many old schedules from unlocking at the
same time. Every discretionary commitment therefore also reserves capacity in a
global rolling liquidization budget at its earliest possible claim/release time.
The budget includes every allocation vault, LP deployment and any project-
controlled Solana account. Start delay, cliff and full-duration bounds are fixed
so a distant maturity cannot hide synchronized future unlocks.

All ordinary commitments pass a seven-day timelock. The emergency group can only
cancel during a non-renewable authority period or pause EVM v2 rate limits to
zero. It cannot create commitments, transfer tokens, shorten delays or grant
itself a new period.

## Community governance reserve - 45%

Before community governance activation, project roles have no function that can
move, approve, bridge, stake or delegate these tokens. The reserve tokens also
have no voting power.

Activation must be a one-way transition into a known governance path. It must not
be a project Safe choosing any address and calling it "community governance".
The recommended design separates an immutable capped vault from governance:

```text
Ethereum VoteEscrow -> ConstitutionalGovernor -> OperationalGovernor
                                            \-> CommunityGovernanceReserveVault
```

Only released tokens voluntarily locked on Ethereum before the snapshot may vote.
Solana holders must burn/unlock back to Ethereum before voting; cross-chain vote
aggregation is deferred because it creates double-voting and oracle trust. The
constitutional layer may activate or replace the operational controller, but it
cannot transfer tokens, change the `2%` cap or erase its checkpoint history. The
operational controller may only create typed commitments accepted by the vault.

The exact activation parameters remain open because they change the trust model.
The starting proposal to threat-model is:

- no earlier than `utility launch + 24 months` and at least `3%` genuinely
  distributed eligible supply;
- at least `2%` total supply escrowed and aged for `90 days`;
- turnout at least the greater of `1.5%` total supply and `50%` of eligible
  escrow; at least two-thirds `FOR` among `FOR + AGAINST`, and `FOR` at least
  `1%` total supply;
- a candidate plan, exact addresses, code/config hashes and roles published at
  least `30 days` before voting;
- approval by `5-of-7` independent activation attestors with no Bridge,
  Treasury or Emergency signer overlap and disclosed affiliations;
- a `14-day` execution delay, permissionless execution and exact state recheck;
- permanent retention of the `2%` total-supply rolling 365-day commitment cap.

```text
LOCKED -> CANDIDATE_REVIEW -> VOTING -> PASSED_ATTESTATION -> QUEUED -> ACTIVE
   ^             failure / expiry / cancel consumes nonce              |
   +-------------------------------------------------------------------+
```

`ACTIVE` is terminal for the vault. A later operational-controller replacement
uses a new constitutional proposal and atomic old-controller revocation; it does
not move the vault or reset its limits.

Activation changes who may create bounded commitments; it does not transfer all
45% to an unrestricted treasury. Until this mechanism is approved and tested,
the honest public statement is: "45% is inaccessible to the project and is not
yet controlled by the community."

The reserve is expected to last at least `22.5 years` at the maximum cap. If the
constitutional layer loses liveness, the fail-closed outcome is a frozen reserve,
not a project recovery path. The remaining reserve never gains voting power.

## Community distributions - 25%

Each wave is a separately funded, full-code distributor. The vault deploys the
known bytecode and atomically calls its write-once activation with the root,
funding and timestamps. Funding the distributor consumes the wave and rolling-
period limits immediately. A Merkle root cannot be replaced after funding.

Before funding, the project publishes a reproducible address and amount manifest
without personal data or linkage reasons. If privacy law prevents that
publication, an independent signed full-set audit and public concentration
aggregates are required. The leaf is domain-separated by wave, chain,
distributor, index, recipient and amount.

```text
CommunityDistributionVault -> CommunityWaveDistributor
                               Uninitialized -> Active -> Closed
```

Unclaimed value after the fixed claim window returns permissionlessly only to
this reserve and does not become project funds. Pilot, per-wave, year-one and later rolling caps
from the tokenomics proposal are enforced in the vault, not only monitored.
The current six-wave program can authorize at most `3%` of total supply; at least
`22%` remains unprogrammed and creates no current entitlement or expected
distribution.

## Founder, team and future contributors - 15%

Founder and initial-team amounts go directly to separate full-code
`NoCatchUpVesting` contracts, not OpenZeppelin `VestingWallet`. Claimable value
is zero before each cliff, then grows linearly from zero to the full amount at
the declared end. There is no
large first-day catch-up release and no beneficiary-change function.

Calendar months are compiled to exact UTC seconds with month-end clamping and
golden leap-day vectors. Team service earned before token launch does not create
a catch-up release at launch: the token-release schedule begins no earlier than the
public post-launch schedule. Initial-team revocability is still an explicit
product choice; founder vesting is non-revocable.

For allocation `A`, cliff `C` and end `E`, vested is zero at `t <= C`, `A` at
`t >= E`, otherwise `floor(A * (t - C) / (E - C))`. Releasable is vested minus
already released. Donations never increase `A`.

The future contributor reserve can only create a full-code vesting grant through
the Project Timelock. A grant start cannot be earlier than the approving proposal's
execution time. Creating the grant consumes the rolling grant cap. Revocation can
return only the unvested part to the same contributor reserve; vested value remains
owed to the beneficiary.

Future grants also require a minimum cliff, minimum full vesting duration,
no-catch-up release and an aggregate cap per disclosed beneficial owner. All
project-issued founder allocations count toward the founder cap regardless of
which vault created them.

The contract can prove the amount and schedule, but not that the recipient earned
the grant. Public milestone evidence, independent approval for related parties and
a conflict register remain mandatory human controls.

## Operations - 8%

The operations vault may create disclosed payments or payment schedules within
the `0.5%` total-supply rolling cap. It cannot sell tokens through a DEX, fund a
pool, approve a router or send tokens to another unrestricted project vault during
beta. Vendor payments may ultimately reach an ordinary wallet, so each one exposes
the recipient, amount, purpose hash and timelocked proposal.

```text
OperationsBudgetVault -> OperationsPaymentEscrow
                         Committed -> Claimable -> Paid
                                      \-> Expired -> Returned to parent vault
```

During the thin-liquidity beta, the default liquid-token operations outflow is
zero. Tokens may be a separately disclosed long-term award but cannot substitute
for agreed fiat/stablecoin compensation. Tokens are not counted as payroll
runway. Real audits, infrastructure, legal work and salaries still need a
separate stablecoin or fiat budget.

## Ecosystem and public grants - 6%

The grant vault funds individual full-code milestone escrows within its `1%`
rolling cap. A related-party grant requires a single-use approval over the exact
grant digest by an immutable Independent Timelock. The proposer, beneficiary and
milestone reviewer cannot satisfy that approval. Recipient, reviewer, amounts,
deadlines, evidence requirements, cancellation and appeal rules are fixed when
the escrow is created. Related-party milestone payment also requires independent
review; independence cannot stop at grant creation.

```text
EcosystemGrantVault -> MilestoneGrantEscrow
                       Pending -> Submitted -> Approved/Paid | Rejected
                       Active -> Completed | Canceled/Expired
```

No contract can detect a fake milestone by itself. The dashboard therefore shows
both the enforceable payment schedule and the human evidence/approver behind it.
Contributor, operations and grant disclosures include beneficial owner,
affiliations, selection method, acceptance criteria, approver recusals and an
outcome report. A hash does not make weak or false evidence truthful.

## Liquidity - 1%

The recommended physical split is an `ExperimentalLiquidityVault` holding only
`0.1%` and a `FutureLiquidityReserve` holding `0.9%` with no beta release path.
It remains an open allocation-structure decision. The experimental vault can fund
only a hash-bound pool plan through an immutable CCIP adapter, never an arbitrary
wallet or router call. The first bridge is capped at `0.01%` and cumulative beta
deployment at `0.1%`; used capacity never returns. Deposited or generally
transferable Solana tokens become circulating immediately.

No uncommitted reserve or generic treasury buffer is bridged. Each transfer is
an exact final commitment to a staging address, distributor or LP destination;
an ordinary Squads-controlled ATA is treated as liquid overhang. The pool plan
binds venue programs, mint, pool accounts, amounts, opening/expiry, LP owner and
full instruction/account data. On Solana, without a custom policy program these
restrictions are verified transaction policy and monitoring, not an immutable
onchain guarantee.

Community members add their own assets directly to the pool and own their own LP
positions. Project LP custody and withdrawal powers are public. "Held by Squads"
must not be described as "locked" while Squads can withdraw.

The `0.01%` pool and a `0.25%` pilot are economically incompatible: selling the
whole pilot would drain almost all of a `$100`-scale quote reserve. Public
distribution and pool opening therefore require a fresh whole-allocation sell
simulation, a minimum genuine non-affiliate float and a rule that the pool token
side is no more than `5%` of that float. Until those fields are accepted, the
pool is only a highly volatile micro-market demonstration, not an economic
launch or price discovery mechanism.

## Bridge administration boundary

Direct Solana Pool Signer PDA prevents a project key from calling raw SPL
`MintTo`; it does not make supply independent of the configured remote pools,
pool owner, router/offramp checks or upgradeable Chainlink programs. Likewise,
the EVM pool/LockBox owner surface may change routers, hooks, fee roles or backing
callers depending on the selected CCIP line.

The protocol-line ADR must enumerate every privileged selector. The recommended
EVM owner is a narrow immutable policy controller that permits only manifest-
bound configuration/migration and forbids arbitrary routers, hooks, fee admins,
rebalancers and backing withdrawals. If this is not technically compatible, the
public disclosure must say that a compromised Bridge quorum can underback supply
after the timelock.

For CCIP EVM `2.0`, a partial rate-limit reduction can refill an exhausted bucket.
The emergency path may therefore only make a one-way pause to zero; it may not
perform positive partial reductions. A fast constrained Solana pause remains an
open design choice because the standard rate-limit administrator can also raise
limits.

Every administration call has a deadline, nonce and expected-state hash. The
timelock enforces an immutable minimum delay and operation expiry; vanilla
`TimelockController` does not make either property permanent by itself.

## Contract-level tests required before audit

- no role can bypass a vault through transfer, approval, arbitrary call, upgrade,
  replacement, delegate call or token recovery;
- rolling limits hold across exact boundary timestamps and long idle periods;
- global liquidization limits hold across synchronized future unlocks from every
  vault and project-controlled Solana account;
- creating a commitment consumes capacity once, while claiming consumes none;
- cancellation, expiry and unclaimed returns cannot manufacture new capacity;
- founder/team claimable value is zero at the cliff and grows from zero after it;
- backdating, beneficiary replacement and double claiming fail;
- governance-reserve movement is impossible before a valid one-way activation;
- activation cannot replace the bounded vault with an unrestricted treasury;
- emergency powers are pause-to-zero/cancel-only, expire and cannot renew themselves;
- direct genesis balances and the manifest sum exactly to fixed supply;
- stateful fuzz tests cover colluding roles, malicious recipients and hostile
  ERC-20 callbacks even though the canonical token itself is simple;
- a compromised bridge proposer cannot install a malicious router, rebalancer,
  hook, fee administrator, LockBox caller or fake remote token/pool;
- an exhausted CCIP v2 rate bucket cannot regain capacity through an emergency
  action, and stale timelock operations cannot execute.

Independent audit is still required before mainnet. Passing tests means the code
matches the stated rules; it does not mean the economic policy or human approvals
are automatically good.
