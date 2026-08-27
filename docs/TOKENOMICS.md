# Community-first tokenomics proposal

Status: proposal, not a sale, airdrop, listing or launch announcement. No person
has an entitlement until the relevant allocation, schedule and distribution are
approved and executed onchain.

## Recommended model

**Progressive community treasury. 🎯 9/10 🛡️ 9/10 🧠 7/10, roughly
2,600-4,200 LOC of tokenomics contracts, deployment checks and dashboard rules,
excluding CCIP and the web application.**

| Allocation | Share | Enforceable public rule |
| --- | ---: | --- |
| Community treasury and grants | 45% | Genesis Community Timelock and non-generic policy vault; new commitments capped at 2% of total supply per rolling 12 months, without rollover |
| Protocol operations | 12% | Separate Project Timelock; token outflow capped at 0.5% of total supply per rolling 12 months, without rollover; stablecoin or fiat runway is separate |
| Team and future contributors | 13% | Grant by grant; 12 months at zero, then linear to month 48 without cliff catch-up; unassigned reserve cannot transfer directly to an EOA |
| Founder | 5% | Irrevocable grant; 18 months at zero, then linear to month 60 without cliff catch-up |
| Community distributions and rewards | 20% | Maximum reserve, not promised issuance; up to six independently approved waves over 48-60 months |
| Liquidity reserve | 5% | Undeployed and non-circulating by default; first experimental pool capped at 0.01%, cumulative experimental beta at 0.1%; the remaining reserve stays locked |

This makes 65% community-designated without mislabelling liquidity as a
community allocation. At genesis, proven binding community control is 0%:
project-controlled roles can administer 82% across community treasury,
operations, distributions and unused liquidity, or up to 95% while unassigned
team reserve is included. Until independent governance is safely activated, the
45% bucket is described truthfully as a **project-controlled community
treasury** and the complete beneficial-control graph is disclosed.

The working fixed-supply default is `100,000,000` units with `9` decimals. Nine
decimals match Solana and avoid irreversible precision loss or `u64` overflow
from an 18-decimal representation. Supply size does not establish value.

The truthful beta claim is: **fixed Ethereum issuance with a disclosed,
governed Solana recovery authority and continuous reconciliation**. Solana is
not described as cryptographically bridge-only until mint authority is moved
directly to the Pool Signer PDA and that target-chain state is verified.

## Other viable allocations

1. **More liquidity flexibility: `42 / 12 / 13 / 5 / 20 / 8`. 🎯 7/10 🛡️ 8/10 🧠 6/10,
   roughly 2,600-4,200 LOC.** Keeps a larger locked LP ceiling, but worsens
   market-control optics without adding the external quote capital a pool needs.
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
- Community, operations and bridge administration use separate timelocks and
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

- Founder: claimable is zero until `T0 + 18 months`; the stream then starts from
  zero and reaches 100% at `T0 + 60 months`. The grant cannot be cancelled.
- Team: claimable is zero until its grant-specific `start + 12 months`; the
  stream then starts from zero and reaches 100% at `start + 48 months`.
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

The 20% allocation is a ceiling, not a promise to distribute all tokens.

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
