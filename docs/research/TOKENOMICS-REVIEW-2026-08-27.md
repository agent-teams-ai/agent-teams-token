# Tokenomics research review

Date: 2026-08-27

Status: evidence for a proposal, not legal or financial advice.

Five independent research tracks covered comparable launches, failure cases,
treasury and vesting security, airdrop and liquidity design, and legal/public
disclosure. Facts below are linked to primary sources; recommendations are
project conclusions.

## Comparable projects

| Project | Primary-source fact | Agent Teams conclusion |
| --- | --- | --- |
| Safe | 1B supply; current allocation groups include 56.2% community treasuries and long contributor/backer schedules | Strong benchmark for public wallet and supply dashboards; do not give unreleased tokens voting power |
| Optimism | 25% ecosystem, 20% RetroPGF, 19% airdrops, 19% contributors, 17% investors | Separate `available` from `circulating`; do not copy governance-controlled inflation |
| Arbitrum | 35.28% DAO treasury after AIP-1 remediation; team/investors use four-year schedules | Approval must precede custody transfer; current supply disclosure must be generated, not a stale page |
| ENS | 50% DAO, 25% airdrop, 25% contributors | Strong community share, but founder/team beneficial ownership should be disclosed separately |
| Uniswap | 60% community, 21.266% team/future employees, 18.044% investors, 0.69% advisers | Genesis allocation is clear; perpetual inflation and a large insider share are not required here |
| dYdX | 50% community with large investor and contributor buckets; insider unlock was later extended | Avoid contractual-only locks and one common cliff |
| Yearn | 30,000 YFI fair launch, followed by a later governance mint for contributors and treasury | A zero-team/zero-treasury launch can create an ad hoc mint later; reserve transparent long-term funding now |

Primary sources: [Safe tokenomics](https://safefoundation.org/blog/safe-tokenomics),
[Optimism token overview](https://community.optimism.io/op-token/op-token-overview),
[Arbitrum distribution](https://docs.arbitrum.foundation/airdrop-eligibility-distribution),
[ENS token](https://docs.ens.domains/dao/token/),
[Uniswap launch](https://blog.uniswap.org/uni),
[dYdX genesis](https://www.dydx.foundation/blog/introducing-dydx-token), and
[Yearn YIP-57](https://gov.yearn.fi/t/yip-57-funding-yearns-future/9319).

## Failure patterns we must block

| Case | What failed | Preventive invariant or gate |
| --- | --- | --- |
| Terra UST/LUNA | Reflexive backing plus subsidised yield amplified the depeg | No peg, rebase or token-funded yield; rewards require external revenue coverage |
| Axie SLP | Repeatable emissions materially exceeded sinks | No emission programme without hard cap, net-liquid-supply monitor and `usage -80%` scenario |
| dYdX unlock | Insider concentration and a large common unlock required late rescheduling | Onchain grant-by-grant schedules, no cliff catch-up, 30/90-day sell-pressure model |
| Bancor | BNT-funded impermanent-loss protection created a sell/mint feedback loop | No own-token insurance or APY; measure liquidity retention after incentives end |
| Arbitrum AIP-1 | Foundation moved and sold treasury tokens before genuine approval | Approval before transfer, separate buckets, timelock, budget and public reports |
| Beanstalk | Flash liquidity captured same-transaction governance execution | Historical voting snapshots, voting delay/period and mandatory execution timelock |
| Wormhole | Destination mint occurred without valid source backing | Exact-once message ledger, orphan-mint alert, forged/duplicate/manual mint tests |
| Optimism Airdrop 1 | Per-address rules still admitted linked Sybil clusters | Small pilot, graph clustering, pre-announcement snapshot and appeal window |
| Celsius CEL | Undisclosed issuer purchases and insider concentration supported token price | No beta buybacks/price support; beneficial-control and related-party disclosure |

Primary sources: [SEC Terra case](https://www.sec.gov/news/press-release/2024-73),
[Axie economic balancing](https://blog.axieinfinity.com/p/upcoming-season-20-and-economic-balancing),
[dYdX unlock update](https://www.dydx.foundation/blog/update-on-dydx-unlock),
[Bancor emergency actions](https://gov.bancor.network/t/ratification-of-emergency-actions-taken-on-sunday-19th-june-utc/3714),
[Arbitrum AIP-1 clarification](https://forum.arbitrum.foundation/t/clarity-around-the-ratification-of-aip-1/12864),
[Beanstalk postmortem](https://bean.money/blog/beanstalk-governance-exploit),
[Optimism Airdrop 1](https://github.com/ethereum-optimism/community-hub/blob/0e3e4dfdf43a27f14923e4f351b447ff33b6b14e/pages/op-token/airdrops/airdrop-1.mdx),
and [SEC Celsius case](https://www.sec.gov/news/press-release/2023-133).

## Airdrop and liquidity conclusions

Retrospective contribution cohorts are the recommended distribution model.
Wallet count, raw transactions, referrals, social promotion, token holding and
LP deposits are not proof of useful contribution. A split identity must never
receive more than the unsplit identity. Measure useful product retention after
30/90/180 days, not only claims.

Raydium's CPMM is the likely first venue because a new token has no reliable
price range. A `$50-100` quote reserve is only a devnet demonstration. Under
constant-product math a `$100` swap needs about `$10,000` of quote reserve for
roughly 1% execution slippage before fees; the final gate uses an executable
simulation rather than that approximation. Sources: [Raydium CPMM
math](https://docs.raydium.io/algorithms/constant-product.md), [CLMM
overview](https://docs.raydium.io/products/clmm/overview.md), and [Optimism
launch postmortem](https://github.com/ethereum-optimism/optimism/blob/develop/docs/postmortems/2022-05-31-drop-1.md).

## Treasury and vesting conclusions

Use separate Community and Project timelocks. Treasury Safe 3-of-5 proposes;
Emergency Safe 2-of-3 cancels only; the timelock is self-administered and has an
open executor. Bootstrap must revoke the canceller role that OpenZeppelin grants
to constructor proposers. Genesis transfers directly to final allocation
contracts. A bridged treasury allocation arrives at a named Squads ATA and keeps
the same policy classification.

Relevant incidents and controls: [OpenZeppelin TimelockController
postmortem](https://forum.openzeppelin.com/t/timelockcontroller-vulnerability-post-mortem/14958),
[Safe module warning](https://docs.safe.global/advanced/smart-account-modules),
[Safe guard warning](https://docs.safe.global/advanced/smart-account-guards), and
[Optimism/Wintermute target-chain incident](https://gov.optimism.io/t/message-to-optimism-community-from-wintermute/2595).

## Legal and public-trust conclusions

`Community token` is not a legal classification. Before production contracts,
the exact holder rights, live utility, issuer/entity and launch countries need a
dated classification memo. A public offer, airdrop and each liquidity venue need
their own analysis. A supposedly free airdrop may not be free when the project
receives personal data, promotion, referrals or work in exchange.

Publish a versioned Token Facts Pack containing rights and explicit non-rights,
all allocation and controlled wallets, beneficial ownership, unlock calendar,
signer affiliations, authority matrix, treasury policy, airdrop rules, LP
control, code/audit scope and material risks. Marketing must never imply future
value, guaranteed listing, price support, regulator approval or decentralisation
that does not yet exist.

Primary sources: [EU MiCA](https://eur-lex.europa.eu/eli/reg/2023/1114/oj/eng),
[ESMA classification guidelines](https://www.esma.europa.eu/sites/default/files/2025-03/ESMA75453128700-1323_Guidelines_on_the_conditions_and_criteria_for_the_qualification_of_CAs_as_FIs.pdf),
[SEC 2026 interpretation](https://www.federalregister.gov/documents/2026/03/23/2026-05635/application-of-the-federal-securities-laws-to-certain-types-of-crypto-assets-and-certain),
and [FINMA ICO guidance](https://www.finma.ch/en/news/2018/02/20180216-mm-ico-wegleitung/).

## Recommendation

Adopt the `42 / 12 / 13 / 5 / 20 / 8` proposal only after product-owner review.
The percentages alone are insufficient: the liquid-supply budget, timelocks,
no-catch-up vesting, no-market-sale beta, airdrop wave gates and public reporting
are part of the same tokenomics contract with the community.
