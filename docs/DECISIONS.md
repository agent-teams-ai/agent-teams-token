# Decision register

Architecture decisions and their lifecycle are indexed in
[`decisions/README.md`](decisions/README.md). Accepted ADRs are immutable;
changes use a proposed superseding ADR.

Current production allocation, reserve policy and custody split are recorded
in accepted [ADR-0008](decisions/0008-production-reserve-commitment-policy.md)
and [ADR-0009](decisions/0009-custody-split-and-launch-gates.md):
`30/30/20/9/5/5/1`, founder 3% and contributors 17%, with separate
solo-owner Safe 2-of-3 configurations. Earlier dated entries below are a
decision history; statements that percentages or signer independence remain
open were superseded by these ADRs. Exact addresses, cap amounts and dates
remain deployment inputs.

Product decisions that are not yet accepted remain in
[`OPEN_QUESTIONS.md`](OPEN_QUESTIONS.md) and the proposal config. They do not
become deployment truth until explicitly approved and compiled into the
canonical genesis manifest.

## Owner decisions, 2026-09-13

The owner explicitly accepted the following product rules in the tokenomics
discussion. These supersede the earlier schedule proposals, not accepted ADRs.

- Founder and initial-team grants both use `12 -> 48 months` from each
  grant's own start: zero vested through month 12, then linear vesting from
  zero to the full grant by month 48. This is four years in total, with a
  three-year linear segment and no cliff catch-up. Exact UTC starts and ends
  still require approval before deployment.
- Reserve purposes are fixed. Future recipients may be selected within the
  purpose and enforceable spending limits; administrators may not relabel an
  airdrop reserve as financing or move it into an unrestricted treasury.
- The project needs external money for development, including AI subscriptions
  and infrastructure. This is a funding need, not a required personal deposit
  by the owner, an approved token sale, or evidence of investor commitments.
- The owner estimates a minimum development cash budget of USD 2,000 per
  month for hosting, AI subscriptions and project development. This implies
  USD 12,000 for six months or USD 24,000 for twelve months at that monthly
  spend, before additional one-time costs. These are planning requirements,
  not funds already secured, an approved fundraising target or a token price.

Supply, allocation percentages, financing reserve size, release limits, sale
method/price/timing, buyer vesting, signer identities, revocability and exact
deployment dates are not approved by this decision. A reserve in AGTMAI is a
token spending ceiling, not cash runway; cash exists only after a completed
funding transaction. Keep the whole proposal config in `status: proposal`.

## Owner decisions, 2026-09-14

The next product slice is vesting, bounded reserves and genesis allocation;
mainnet bridge readiness follows it. Research existing open-source contracts
before selecting or implementing a custom primitive. A first public airdrop
is a separate, unapproved product action, not an implicit part of this slice.

The owner supports simplifying the older governance/global-budget proposal,
but the exact replacement rules remain to be decided. This is not approval to
remove enforceable caps or silently waive accepted security requirements.

The owner currently has no independent cofounder/signers to delegate custody
to. Several keys controlled by the owner still mean one beneficial controller.
The owner selected a solo-founder Safe custody baseline of 2-of-3 signatures
from three separate keys, with separate seeds/devices and backups. Safe checks
addresses and signatures, not device independence or common seed ownership.
Exact signer addresses, recovery procedures and onchain reserve permissions
remain to be configured and reviewed. A larger threshold is a comparison for
future consideration, not the current selected baseline.
Existing signers cannot be described as independent merely because their
wallet addresses differ. Preserve approved 12 -> 48 schedules and fixed
reserve purposes. Allocation percentages, financing and mainnet approval
remain open as recorded above.

### Grant revocation decision, 2026-09-14

The owner explicitly accepted the following rules after the research review:

- Founder grants are non-revocable. Neither the reserve controller nor its
  Safe may recover the founder's unvested allocation through cancellation.
- Team service grants may be cancelled when the participant leaves. Only the
  unvested portion returns to the same purpose-specific reserve that funded
  the grant, not to an unrestricted administrator wallet.
- Vested value remains the participant's entitlement even if not yet claimed.
  Previously released value is not clawed back. Cancellation must preserve
  the remaining vested claim and prevent further accrual of the returned part.
- A refund must not bypass or silently reset reserve spending/release limits.

This resolves the revocability choice left open in the earlier entries. It
does not select Sablier, approve beneficiary transferability or change the
accepted `12 -> 48 months` schedule. The contract cannot detect employment
departure itself: cancellation authority, effective-time rules and any delay
must be specified in the bounded implementation design. Investor conditions,
allocation amounts, reserve caps and production deployment remain open.

## Custody implementation decisions, 2026-09-15

The accepted custody split uses separate Project Controller Safe and Founder
Beneficiary Safe configurations. Each Safe is 2-of-3 and uses separate
keys/devices, while beneficial control remains with the solo founder. Multiple
keys are not independent humans. Exact Safe addresses and owner addresses remain
mandatory unresolved deployment inputs. This split is recorded in
[ADR-0009](decisions/0009-custody-split-and-launch-gates.md).

For the bounded production-code custody slice, each founder/team grant uses one
immutable `GrantVault` with no beneficiary, controller or ownership transfer.
The immutable controller address is intended for the selected Safe 2-of-3 and is
authorized by ordinary caller equality; Safe owners and signatures are not
implemented or certified. Team cancellation is effective at the successful
transaction timestamp with no vault-embedded delay. The originating reserve
alone activates the vault through an exact full-allocation ERC-20 pull, and only
that same immutable reserve receives an unvested refund.

These choices resolve wrapper routing, authority and time for this slice. They do
not approve actual addresses, allocations, dates, reserve caps, production
genesis or deployment. `GrantVault` makes no reserve callback or external
budget-counter update. Preserving reserve spending limits when a refund arrives
is the reserve implementation's responsibility.
