# Community-first tokenomics proposal

Status: proposal, not a sale, airdrop, listing or launch announcement. No person
has an entitlement until the relevant allocation, schedule and distribution are
approved and executed onchain.

## Recommended model

**Split-control community model. 🎯 9/10 🛡️ 9/10 🧠 7/10, roughly
3,200-5,200 LOC of tokenomics contracts, deployment checks and dashboard rules,
excluding CCIP and the web application.**

| Allocation | Share | Enforceable public rule |
| --- | ---: | --- |
| Community governance reserve | 45% | Project cannot transfer it before independently approved community governance is activated; later commitments capped at 2% per rolling 12 months without rollover |
| Community distributions and rewards | 25% | Maximum reserve, not promised issuance; bounded independently reviewed waves |
| Founder, team and future contributors | 15% | Founder max 3%; other initial team max 3%; at least 9% remains for future grants; future grant creation capped at 2% per rolling 12 months and 0.5% per grant |
| Protocol operations | 8% | Separate Project Timelock; token outflow capped at 0.5% per rolling 12 months; stablecoin/fiat runway is separate |
| Ecosystem and public grants | 6% | Commitments capped at 1% per rolling 12 months; milestone evidence and independent approval for related parties |
| Liquidity reserve | 1% | First experimental pool capped at 0.01%, cumulative experimental beta at 0.1%; the remainder stays locked |

This makes 70% community-designated. At genesis, proven binding community
control is still 0%, but project roles can administer at most 55%; the 45%
governance reserve has no project transfer path before independently approved
community governance is activated. Of the 15% contributor allocation, no more
than 3% is the disclosed founder grant, no more than 3% may be assigned to other
initial contributors, and at least 9% remains locked for future work.

The working fixed-supply default is `100,000,000` units with `9` decimals. Nine
decimals match Solana and avoid irreversible precision loss or `u64` overflow
from an 18-decimal representation. Supply size does not establish value.

The truthful beta claim is: **fixed Ethereum issuance with a disclosed,
governed Solana recovery authority and continuous reconciliation**. Solana is
not described as cryptographically bridge-only until mint authority is moved
directly to the Pool Signer PDA and that target-chain state is verified.

## Other viable allocations

1. **Prior project-stewarded model: `45 / 12 / 13 / 5 / 20 / 5`. 🎯 6/10 🛡️
   7/10 🧠 6/10, roughly 2,600-4,200 LOC.** Simpler, but project roles initially
   administer too much supply and the separate 5% founder line has worse optics.
2. **No predefined founder grant. 🎯 6/10 🛡️ 8/10 🧠 5/10, roughly
   2,800-4,600 LOC.** Looks equal at genesis, but risks less transparent founder
   compensation through later discretionary grants.

The prior `35 / 18 / 14 / 8 / 15 / 10` draft is rejected: founder, team and
operations totalled 40%, while a 10% liquidity reserve created unnecessary
control and dump optics.

Comparable projects show that the contributor share is conservative, not an
attempt to hide an unusually large insider allocation. Uniswap disclosed 21.266%
for team/future employees and 18.044% for investors, both with four-year vesting.
Arbitrum disclosed 26.94% for team/contributors/advisers and 17.53% for investors,
also with four-year locks. These are references, not targets to copy:
[Uniswap](https://blog.uniswap.org/uni) and
[Arbitrum](https://docs.arbitrum.foundation/airdrop-eligibility-distribution).

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
- The Community Governance Reserve contract has no generic transfer, approval or
  grant path for project roles. Activation requires a separately reviewed
  community-governance design and independent approval.
- Distributions, operations, grants and bridge administration use separate timelocks and
  purpose-specific policy vaults. A Safe 3-of-5 may propose but cannot bypass a
  seven-day delay or execute arbitrary token transfers from a capped vault.
- An independent Emergency Safe 2-of-3 acts only through an expiring canceller
  and a down-only bridge brake. It cannot renew its own authority, propose,
  execute, shorten delays, mint, transfer assets or increase rate limits.
- No Safe modules or guards at genesis. Any later activation requires a separate
  review, timelock and public state diff.

## Vesting semantics

`T0` is the publicly declared utility launch timestamp, not merely contract
deployment. Every schedule uses exact UTC seconds in the genesis manifest.

- Founder: part of the shared contributor allocation, capped at 3%; claimable is
  zero until `T0 + 18 months`, then reaches 100% at `T0 + 72 months`. The grant
  cannot be cancelled.
- Team: claimable is zero until its grant-specific `start + 12 months`; the
  stream then starts from zero and reaches 100% at `start + 60 months`.
- Existing contributor grants declare revocability. Future grants may cancel
  only the unvested portion through the Project Timelock. Vested but unclaimed
  value remains owed; returned unvested value goes to its original reserve.
- A new grant cannot backdate `start`; the manifest requires `start >=` the
  approving proposal's execution timestamp.
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
- Across discretionary treasury, operations, distributions and LP expansion,
  new 90-day liquid supply is capped by the minimum of `0.5%` total supply,
  `10%` trailing 90-day average liquid supply and the approved executable
  sell-depth budget. Cap excess pauses new discretionary actions, never already
  vested beneficiary rights.
- Treasury tokens bridged to Solana must arrive at a named Squads-controlled ATA
  with equivalent budget policy. Bridging never changes allocation ownership or
  circulation classification.

## Community distributions

The 25% allocation is a ceiling, not a promise to distribute all tokens.

- Use one explicitly classified lane per wave:
  - gratuitous retrospective: no eligibility terms before cutoff and no task,
    purchase, service, referral, promotion or personal-data consideration;
  - earned work, promotion or referral: contributor grant/reward with agreement,
    tax, IP, sanctions and privacy treatment;
  - usage or loyalty rewards: separate offer/consideration analysis.
- The first pilot is the lesser of `0.25%` of total supply and the amount whose
  immediate 100% sale stays inside the approved price-impact budget.
- Year 1 community distributions are capped at 1% of total supply. A later wave
  requires a published 90-day retention, Sybil and immediate-sell report.
- Every wave is at most 0.5% of total supply; all waves together are capped at
  2% per rolling 12 months with no unused-cap rollover.
- Target six possible waves over 48-60 months, each with its own approval and
  legal consideration memo.
- Claim window is 180 days, preceded by a 14-day eligibility and appeal preview.
  Unclaimed value returns only to the community-distribution reserve.
- Use capped square-root scoring after identified-cluster aggregation. Within a
  detected cluster, splitting wallets cannot increase total reward; do not claim
  this is globally provable for undetected identities.
- Do not publish linkage graphs or cluster reasons by address. A leaf contains
  only domain-separated `waveId`, `chainId`, distributor, recipient and amount;
  the preview explains that recipient and amount become public onchain.
- Work, promotion, referrals and announced tasks are grants or rewards, not a
  "free airdrop". Never put email, IP, account ID or cross-chain identity links
  in a Merkle leaf or public manifest.

## Liquidity policy

Devnet demonstrations cost **$0 real money**. Mint `50-100` units of a local or
Devnet-only fake USDC and use faucet Devnet SOL/test ETH/test LINK for fees. Test
assets have no value and must never be purchased. If a faucet is unavailable,
pause that public-testnet step and continue local tests instead of spending real
funds. A `50-100` quote reserve is not a viable public mainnet market and must
never be used to imply FDV or project valuation.

- Compare Raydium CPMM and Orca Splash as standard full-range candidates. CLMM
  requires active range management and is not the default for a tiny launch.
- An official experimental pool may use at most `$100` of founder cash in total,
  including pool-creation rent/fees and quote capital. It is explicitly described
  as thin and highly volatile, never as price discovery, valuation or adequate
  depth.
- The first pool may contain at most 0.01% of total supply; cumulative token-side
  deployment during experimental beta is at most 0.1%. This bounds how much an
  early buyer can acquire even if the quote side is drained.
- Select Raydium CPMM, Orca Splash or another standard permissionless venue only
  after current mainnet simulation proves the complete creation cost fits the
  same `$100` hard cap. Raydium's current documented creation cost is about 0.2
  SOL, so it may not fit.
- Community members add liquidity directly to the pool and retain their own LP
  positions. The project does not centrally collect community liquidity money.
- Publish mint addresses, initial ratio, exact balances, opening time, LP owner,
  withdrawal powers and a prominent volatility warning at least seven days
  before opening. Treasury/community-reserve market sales remain prohibited.
- A later mature-pool target remains exact SDK `priceImpact` of at most 1% for a
  `$100` swap and 5% for `$500`. With a 25 bps CPMM, the first target needs
  roughly `$13.2k` quote reserve; plan at least `$15k` and prefer `$20k` if the
  community eventually provides it directly. Realized slippage is separate.
- The unused liquidity reserve stays in its own timelocked Liquidity Vault.
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
- bridge lock plus remote mint is counted once. Allocation classification is
  preserved only for an approved provenance tuple: source allocation vault,
  finalized source event, message ID, amount, canonical destination ATA,
  beneficial controller and terminal status. Any mismatch is `unknown` and
  counted as circulating until resolved.

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
token_distribution_outflow_base_units <= approved_token_budget_base_units
program_external_cost_usd <= approved_external_asset_budget_usd
orphan_bridge_mints == 0
duplicate_settlement_total == 0
unexplained_supply_delta == 0
```

## Holder rights and explicit non-rights

The token may provide only documented consumptive product utility that is live
before public distribution. Live utility is a product prerequisite, not a
classification safe harbor: actual rights, issuer statements, distribution,
transferability and venue intent still require jurisdiction-specific analysis.
It provides no equity, debt, dividend, revenue or profit share, passive yield,
contractual issuer buyback/redemption, ownership of Agent Teams AI, claim on
treasury, IP or assets, price floor, buyback promise, guaranteed liquidity or
guaranteed listing. Technical governance, if later introduced, is not corporate
shareholder voting. This does not waive non-excludable statutory consumer rights.

## Legal and disclosure gates

Local and test-only neutral implementation may proceed before entity selection.
Before freezing holder rights/ABI or mainnet genesis, identify the issuer,
offeror, utility provider, treasury controller, distributor, LP provider,
website operator and data controller, plus the jurisdictions with real nexus.
Before any official-address promotion, public claim, distribution, beta
onboarding or pool, the applicable path must be either a documented exemption or
the completed notification/publication/marketing process. A Token Facts Pack is
required but never represented as a substitute for a MiCA white paper.

Before mainnet genesis, freeze and sign the Token Facts Pack and bind its hash
into the genesis manifest. Publish a signed post-deploy address addendum only
after the legal communications gate. Before a pool or ratio announcement, add
venue/CASP/admission and market-conduct review, issuer/affiliate restricted-list
and trading-window policy, related-party/LP withdrawal disclosure, and explicit
prohibitions on wash trading, self-dealing and undisclosed market making.

Do not claim `free airdrop`, `community-owned`, `decentralized`, `locked
liquidity`, `immutable`, `trustless`, `regulator approved`, future price, return,
APY, scarcity-driven appreciation or guaranteed listing when the facts do not
support it.

Primary references and case studies are collected in
[the tokenomics research review](research/TOKENOMICS-REVIEW-2026-08-27.md).
