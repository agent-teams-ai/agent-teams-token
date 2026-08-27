# Community-first tokenomics proposal

Status: proposal, not a sale or launch announcement. Percentages and schedules
must be approved before contracts are implemented.

## Recommended model

**Community-first with progressive decentralization. 🎯 9/10 🛡️ 9/10 🧠 6/10,
roughly 1,600-2,400 LOC of contracts, scripts and tests, excluding CCIP and UI.**

| Allocation | Share | Public rule |
| --- | ---: | --- |
| Community treasury and grants | 35% | 3% initially available, remaining 32% linear over 72 months |
| Project development reserve | 18% | 2% runway, remaining 16% linear over 60 months |
| Team and future contributors | 14% | individual grants, 12-month cliff, linear to month 48 |
| Founder | 8% | 12-month cliff, linear to month 60 |
| Community airdrops | 15% | 3-4 independent rounds over 24-36 months |
| Liquidity reserve | 10% | 0% in beta; at most 1-2% after legal and launch gates |

Founder plus team is 22%; 60% is explicitly community-facing. The project
reserve is not a founder wallet. It is a separate public treasury.

The working fixed-supply default is `100,000,000` units with `9` decimals. The
amount does not change allocation percentages or value; it remains an open
product decision. Nine decimals match Solana and avoid irreversible precision
loss or `u64` overflow risks caused by an 18-decimal representation.

## Onchain transparency

- Mint exactly 100% once on Ethereum. The deployer must hold zero tokens after
  genesis distribution.
- No owner mint, proxy upgrade, transfer tax, blacklist, freeze or hidden role.
- Each bucket has a named address, contract type, schedule and transaction link
  in a signed deployment manifest and public dashboard.
- Treasury assets live in `TimelockController`; a Safe 3-of-5 can propose and
  cancel, but cannot bypass a 7-day execution delay.
- The emergency council can cancel only. It cannot execute or shorten delays.
- Founder and assigned team grants use non-transferable vesting positions, so
  future unlock rights cannot be quietly sold. Future contributors receive a
  new public grant only after an approved decision.
- Unclaimed airdrop tokens return to the community treasury after 180 days.
- Treasury, reserve and unreleased vesting balances do not count as circulating
  supply and do not vote before release.
- No Safe modules or guards at genesis. Either can gain dangerous execution or
  denial-of-service power and requires a separate security review.

## Why treasury schedules differ from personal vesting

Founder and team allocations unlock mechanically over time. Community and
project budgets combine slow availability with a per-operation timelock: a
fully linear personal-style vest cannot react to real grant and infrastructure
needs, while an immediately spendable treasury would defeat transparency.

## Alternatives

1. **DAO-first. 🎯 7/10 🛡️ 8/10 🧠 9/10, roughly 2,800-4,200 LOC.** Community
   43%, project 12%, team 12%, founder 5%, airdrop 20%, liquidity 8%. Stronger
   optics, but immature cross-chain voting creates capture and participation
   risks.
2. **Founder-led progressive treasury. 🎯 8/10 🛡️ 7/10 🧠 4/10, roughly
   1,000-1,600 LOC.** Community 25%, project 30%, team 18%, founder 10%,
   airdrop 10%, liquidity 7%. Easier to operate, but 58% in founder/team/project
   buckets is harder for a community to trust.

## Legal launch gate

Do not market profit, price growth, yield, ownership in Agent Teams AI or a
claim on project revenue. Before any public liquidity, sale or mainnet airdrop,
obtain a jurisdiction-specific classification memo and decide whether a MiCA
white paper or another disclosure is required. A "free" airdrop is not safely
free when recipients exchange money, personal data, promotion or work for it.

Useful primary references:

- [Chainlink cross-chain token overview](https://docs.chain.link/ccip/concepts/cross-chain-token/overview)
- [Chainlink EVM token pools](https://docs.chain.link/ccip/concepts/cross-chain-token/evm/token-pools)
- [OpenZeppelin VestingWallet](https://docs.openzeppelin.com/contracts/5.x/api/finance)
- [Safe modules and guards](https://docs.safe.global/advanced/smart-account-modules)
- [EU Markets in Crypto-Assets Regulation](https://eur-lex.europa.eu/eli/reg/2023/1114/oj/eng)

