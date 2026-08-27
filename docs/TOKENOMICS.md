# Community-first tokenomics proposal

Status: proposal, not a sale, airdrop, listing or launch announcement. No person
has an entitlement until the relevant allocation, schedule and distribution are
approved and executed onchain.

## Recommended model

**Progressive community treasury. 🎯 9/10 🛡️ 9/10 🧠 6/10, roughly
1,200-2,000 LOC of tokenomics contracts, deployment checks and dashboard rules,
excluding CCIP and the web application.**

| Allocation | Share | Enforceable public rule |
| --- | ---: | --- |
| Community treasury and grants | 42% | Genesis Community Timelock; Year 1 outflow ceiling 2% of total supply; later annual budgets require public approval |
| Protocol operations | 12% | Separate Project Timelock; Year 1 token outflow ceiling 0.5%; stablecoin or fiat runway is budgeted separately |
| Team and future contributors | 13% | Grant by grant; 12 months at zero, then linear to month 48 without cliff catch-up; unassigned reserve cannot transfer directly to an EOA |
| Founder | 5% | Irrevocable grant; 18 months at zero, then linear to month 60 without cliff catch-up |
| Community distributions and rewards | 20% | Maximum reserve, not promised issuance; up to six independently approved waves over 48-60 months |
| Liquidity reserve | 8% | Undeployed and non-circulating by default; no public pool until the legal and measurable market-depth gates pass |

This makes 62% community-directed without mislabelling liquidity as a community
allocation. Until independent governance is safely activated, the 42% bucket is
described truthfully as a **project-controlled community treasury** and its
beneficial control is disclosed.

The working fixed-supply default is `100,000,000` units with `9` decimals. Nine
decimals match Solana and avoid irreversible precision loss or `u64` overflow
from an 18-decimal representation. Supply size does not establish value.

## Other viable allocations

1. **Community-heavy: `45 / 12 / 13 / 5 / 20 / 5`. 🎯 8/10 🛡️ 9/10 🧠 6/10,
   roughly 1,200-2,000 LOC.** Better trust optics and less future market-control
   reserve, but less flexibility if meaningful liquidity is later justified.
2. **Operations-heavy: `40 / 15 / 15 / 5 / 20 / 5`. 🎯 7/10 🛡️ 8/10 🧠 5/10,
   roughly 1,100-1,900 LOC.** Easier contributor and operating support, but the
   project-controlled share is harder to defend publicly.

The prior `35 / 18 / 14 / 8 / 15 / 10` draft is rejected: founder, team and
operations totalled 40%, while a 10% liquidity reserve created unnecessary
control and dump optics.

## Genesis and onchain transparency

- Mint every bucket exactly once and directly to its final allocation contract
  on Ethereum. The deployer, factory and Treasury Safe hold zero unexplained
  tokens after genesis.
- Bind the deployment to `GENESIS_MANIFEST_HASH`, covering allocation IDs,
  base-unit amounts, beneficiaries, UTC timestamps, revocability and code hashes.
- No owner mint, proxy upgrade, transfer tax, blacklist, freeze, rebase, hidden
  role, token-funded yield, token-funded insurance or price-support mechanism.
- Publish every bucket address, controller, signer affiliations, schedule and
  transaction in a versioned Token Facts Pack and supply dashboard.
- Community and operations assets use separate `TimelockController` contracts.
  A Treasury Safe 3-of-5 may propose but cannot bypass a seven-day delay.
- An independent Emergency Safe 2-of-3 may cancel only. It cannot propose,
  execute, shorten delays, mint or transfer assets.
- No Safe modules or guards at genesis. Any later activation requires a separate
  review, timelock and public state diff.

## Vesting semantics

`T0` is the publicly declared utility launch timestamp, not merely contract
deployment. Every schedule uses exact UTC seconds in the genesis manifest.

- Founder: claimable is zero until `T0 + 18 months`; the stream then starts from
  zero and reaches 100% at `T0 + 60 months`. The grant cannot be cancelled.
- Team: claimable is zero until its grant-specific `start + 12 months`; the
  stream then starts from zero and reaches 100% at `start + 48 months`.
- Existing contributor grants declare revocability. Future grants may cancel
  only the unvested portion through the Project Timelock. Vested but unclaimed
  value remains owed; returned unvested value goes to its original reserve.
- Grants are staggered by real start date. There is no global insider cliff.
- Vesting contracts expose no onchain beneficiary or ownership transfer path.
  This cannot prevent sale of an EOA key and is not described as absolute
  non-transferability.

## Treasury market policy

- Beta has zero treasury token sales, buybacks, price support, liquidity mining,
  volume rewards, staking emissions or APY promises.
- Project payroll, audits, infrastructure and legal costs require a separately
  disclosed stablecoin or fiat budget. Spot value of treasury tokens is never
  presented as operating runway.
- Any later token sale or LP funding requires advance public notice, destination
  disclosure, legal review, a rolling volume/depth cap, conflict recusals and a
  timelocked proposal.
- Treasury tokens bridged to Solana must arrive at a named Squads-controlled ATA
  with equivalent budget policy. Bridging never changes allocation ownership or
  circulation classification.

## Community distributions

The 20% allocation is a ceiling, not a promise to distribute all tokens.

- Use retrospective contribution cohorts. Announce eligible kinds of genuine
  product value, but freeze each snapshot before publishing exact thresholds.
- The first pilot is the lesser of `0.25%` of total supply and the amount whose
  immediate 100% sale stays inside the approved price-impact budget.
- Year 1 community distributions are capped at 1% of total supply. A later wave
  requires a published 90-day retention, Sybil and immediate-sell report.
- Target six possible waves over 48-60 months, each with its own approval and
  legal consideration memo.
- Claim window is 180 days, preceded by a 14-day eligibility and appeal preview.
  Unclaimed value returns only to the community-distribution reserve.
- Use capped square-root scoring, a cluster-level cap and the invariant that
  splitting one identity into more wallets never increases its total reward.
- Work, promotion, referrals and announced tasks are grants or rewards, not a
  "free airdrop". Never put email, IP, account ID or cross-chain identity links
  in a Merkle leaf or public manifest.

## Liquidity policy

`$50-100 USDC` is for devnet demonstrations only. It is not a viable public
mainnet market and must never be used to imply FDV or project valuation.

- Keep Raydium CPMM as the likely first venue for an unknown price range. CLMM
  requires active range management and is not the default for launch.
- Do not create an official public pool until an independent depth simulation
  shows that a `$100` swap has at most 1% execution slippage. In a simple CPMM
  this implies roughly `$10,000` of quote reserve before fees and other effects.
- If that capital is not justified, launch utility/community beta without an
  official market pool.
- Initial deployed token-side liquidity is at most 0.25% of total supply and is
  determined only after the quote reserve and ratio are approved. This is not a
  listing commitment.
- LP custody stays in a disclosed Squads vault. It is not called "locked" while
  Squads can withdraw. Publish the withdrawal delay, notice policy, fee
  destination, controller and conflicts.
- Do not burn the LP position in beta. Report quote reserve, `$100/$500` depth,
  fees, impermanent loss, custody and withdrawal capability.

## Supply taxonomy and economic monitoring

`allocated`, `available`, `claimable`, `circulating` and `liquid overhang` are
different values:

- unreleased vesting, unspent timelocks, unclaimed distributors and unused
  liquidity reserve are non-circulating;
- claimable but unclaimed tokens are reported separately as liquid overhang;
- tokens deposited into a permissionless AMM are circulating even if the LP
  position belongs to Squads;
- bridge lock plus remote mint is counted once, and the allocation classification
  follows the CCIP message ID.

The dashboard and release gate track at least:

```text
liquid_supply
liquid_overhang_30d / liquid_overhang_90d
unlock_to_float_ratio
worst_case_30d_sell / executable_depth
treasury_net_flow / issuer_buy_share
top_10_beneficial_control
airdrop_cluster_share / immediate_sell_ratio / retention_30d / retention_90d
organic_liquidity_retention / reward_coverage_ratio
orphan_mint_total / duplicate_settlement_total / bridge_reconciliation_lag
```

Hard economic invariants:

```text
treasury_market_sales_beta == 0
issuer_price_support == 0
reward_outflow <= approved_external_asset_budget
orphan_bridge_mints == 0
duplicate_settlement_total == 0
unexplained_supply_delta == 0
```

## Holder rights and explicit non-rights

The token may provide only documented consumptive product utility that is live
before public distribution. It provides no equity, debt, dividend, revenue or
profit share, passive yield, redemption, ownership of Agent Teams AI, claim on
treasury, IP or assets, price floor, buyback promise, guaranteed liquidity or
guaranteed listing. Technical governance, if later introduced, is not corporate
shareholder voting.

## Legal and disclosure gates

Before production contract implementation, choose the legal entity, launch
countries and live utility, then obtain dated EU/US/Swiss classification advice
for the exact rights and launch path. Before mainnet genesis publish an approved
allocation/control model, authority matrix, audit scope and draft Token Facts
Pack. Every airdrop and liquidity venue then has a separate consideration,
privacy, market-abuse and marketing gate.

Do not claim `free airdrop`, `community-owned`, `decentralized`, `locked
liquidity`, `immutable`, `trustless`, `regulator approved`, future price, return,
APY, scarcity-driven appreciation or guaranteed listing when the facts do not
support it.

Primary references and case studies are collected in
[the tokenomics research review](research/TOKENOMICS-REVIEW-2026-08-27.md).
