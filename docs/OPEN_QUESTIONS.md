# Open product decisions

Only decisions that materially change the implementation are listed here.

## P0 before rights/ABI freeze or mainnet genesis

`Agent Teams AI / AGTMAI` is approved. Formal pre-launch clearance remains a
release gate, not an open naming choice.

1. Confirm or replace the `100,000,000` fixed-supply default; keep `9` decimals.
2. Keep or amend the provisional `45/25/15/8/6/1` model. Founder is capped at 3%
   inside the 15% contributor allocation; proposed schedules are founder 18→72
   and team 12→60 without cliff catch-up. This is recorded but not final.
3. Define initial utility that exists at launch without promising investment
   return or project ownership.
4. Choose legal entity and launch jurisdictions and approve the exact holder
   rights/non-rights before immutable rights/ABI freeze. Local/test-only neutral
   implementation may proceed earlier.
5. Name independent Bridge, Treasury and Emergency signers. Bridge/Treasury may
   share at most one natural person; Emergency has no overlap. Different wallet
   addresses under one employer/custodian/recovery domain are not independent.
6. Approve the one-way activation rule for the 45% Community Governance Reserve:
   recommended Ethereum-only aged vote escrow, Constitutional/Operational
   governor split, earliest time, quorum/floors, 5-of-7 independent attestors and
   controller migration. Until then those tokens are inaccessible to both the
   project and the community.
7. Approve or reject proposed ADR-0004: replace the six package-level contexts in
   ADR-0003 with `Token Control` and `Cross-chain Accounting`, while retaining
   Supply, Distribution, Treasury and Launch Liquidity as features.
8. Set the global 30/90-day liquidization ceiling and outstanding committed-but-
   unreleased ceiling. Per-vault commitment caps do not prevent synchronized
   future unlocks.
9. Decide whether initial-team unvested grants are revocable. Recommended:
   service grants may return only unvested value after a timelocked cancellation;
   vested value remains owed. Founder vesting stays non-revocable.
10. Approve or reject splitting the 1% liquidity allocation into a physically
    beta-bounded `0.1%` experimental vault and a `0.9%` future reserve with no beta
    release path.
11. Choose the Solana emergency model: a small custom pause-only PDA, a broadly
    privileged emergency Squads with explicit trust, or no fast pause. The first
    is safest but revisits the current no-custom-Rust MVP rule.
12. Set rolling commitment-count caps, grant minimum cliff/full-duration and
    maximum start delay; choose reviewer silence/rejection and appeal behavior.

## P0 before public liquidity or airdrop

1. Refreshed token classification memo, required Token Facts Pack and documented
   exemption or completed white-paper/notification/publication gates where
   applicable.
2. Eligibility, consideration, privacy, Sybil and retrospective snapshot rules
   for each airdrop wave.
3. Public pool venue/CASP/admission, market-conduct, depth, ratio, custody,
   conflicts, restricted-list, trading-window and LP withdrawal policy.
4. Independent smart-contract audit and public incident response contacts.
5. Minimum genuine non-affiliate float, whole-pilot sell-impact limit and exact
   venue simulation. The current `0.01%` micro-pool cannot absorb a `0.25%` pilot.

## Mandatory TODO before any Ethereum Mainnet deployment

This checklist cannot be waived merely because gas happens to be cheap:

1. Approve final fixed supply, allocation recipients and amounts, and every
   vesting/release rule. The current proposal and local fixture are not approval.
2. Measure gas against the exact final constructor input and exact pinned
   bytecode; do not extrapolate from source-line count or an older build.
3. Fetch live base/priority fees and ETH/USD immediately before signing. Present
   the estimated ETH/USD total and worst-case transaction limit to the owner.
4. Add fail-closed `chainId`, bytecode/hash, signer, nonce, fee and maximum-total-
   cost guards. A violated guard must prevent signing and broadcasting.
5. Produce and independently verify an unsigned deployment plan first. Public
   broadcast requires a fresh explicit owner approval; no automatic retry after
   an uncertain result.
6. Estimate every deployment separately: AGTMAI core, vesting/release contracts,
   treasury/bridge configuration and verification operations. The cheap core
   deployment must never be presented as the cost of the whole launch.
7. Reconfirm explorer verification inputs and retain transaction, receipt,
   compiler/build and constructor evidence after deployment.

## P1 after the first vertical slice

1. Community-grant policy, budget cadence and reporting format.
2. Whether the code is published under Apache-2.0 and how brand assets are
   separately protected.
