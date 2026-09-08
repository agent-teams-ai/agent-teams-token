# Contract design review - 2026-08-27

Status: nine independent read-only reviews synthesized; no contract code was
started. The requested hosted subscription-runtime service was unavailable, so
the reviews ran as an explicitly disclosed local fallback rather than being
misreported as hosted jobs.

## Verdict

Four designers and five critics converged on `AMEND`, with governance activation
`BLOCK` until its exact charter is accepted. The `45/25/15/8/6/1` allocation may
remain a provisional long-term reserve map. It is not launch-ready and the
proposal config must not be promoted to `accepted`.

## Amendments incorporated into the working design

1. Genesis uses an atomic one-shot full-code deployment scheme with direct mint
   to final allocation contracts, no temporary custodian or public initializer.
2. Every purpose has a separate immutable vault and full-code child
   distributor/vesting/escrow. No generic treasury engine, proxy, clone,
   arbitrary transfer/approve/execute or canonical-token rescue exists.
3. Rolling commitment accounting uses `(now - 365 days, now]`, append-only
   cumulative checkpoints, no return credit and a count cap against storage spam.
4. A second global liquidization budget is reserved at earliest possible release
   across every vault, LP action and project-controlled Solana account.
5. The 45% reserve remains in one immutable capped vault. Recommended governance
   is Ethereum-only aged vote escrow, minimal ConstitutionalGovernor and a
   replaceable operational controller. The vault cap/history cannot migrate.
6. Community waves use write-once roots and publish reproducible recipient/amount
   evidence before funding, subject to a privacy-safe independent-audit fallback.
7. Founder/team use custom no-catch-up vesting. `VestingWallet` is not compatible.
   Founder is non-revocable; initial-team revocability remains open.
8. The recommended liquidity custody split is `0.1%` experimental and `0.9%`
   future-only. It remains an explicit product choice.
9. Generic Solana treasury buffers are removed. Every bridge transfer maps to an
   exact final commitment; a generic Squads ATA is liquid overhang.
10. Direct Pool Signer PDA is described accurately: it prevents raw project
    `MintTo`, but remote configuration and Chainlink governance remain trusted.
11. CCIP EVM admin calls require a protocol-specific policy controller or a clear
    disclosure that Bridge quorum can underback supply after the delay.
12. CCIP EVM v2 emergency action is pause-to-zero only because a partial limit
    update can refill an exhausted bucket. Timelock minimum delay is immutable and
    queued actions expire.

## Critical economic findings

- A `0.01%` token-side pool contains `10,000` AGTMAI, while the nominal `0.25%`
  pilot contains `250,000`. Selling that pilot into the micro-pool would drain
  almost all quote liquidity. Pool and pilot need a common sell simulation and
  genuine non-affiliate float gate.
- Current per-vault yearly commitments can synchronize into nearly `8%` liquid
  supply before accounting for every edge case. A commitment cap alone is not an
  unlock cap.
- The current six-wave plan authorizes at most `3%` total supply. At least `22%`
  of the 25% distribution reserve is unprogrammed and creates no entitlement.
- At maximum release rates the 45% governance reserve lasts at least `22.5`
  years, operations at least `16` years, and the distribution reserve at least
  `12.5` years. These are long-term reserves, not near-term circulating supply.
- Thin beta liquidity cannot fund real salaries or vendor payments. Operations
  liquid-token outflow defaults to zero; real obligations need fiat/stablecoin.

## Honest public control view

```text
Community-controlled now                  0%
Activation-locked, controlled by nobody 45%
Project-administered distribution reserve 25%
Other project/insider-administered        30%
```

`70% community-designated` may appear only as a secondary label next to this
view. It is not a synonym for community control or promised distribution.

Contracts can prove code, amount, time, cap, role and destination. They cannot
prove useful work, truthful evidence, real beneficial ownership, human
independence, absence of bribery or what a recipient does after claiming.

## Architecture conclusion

Engineering Foundation `0.19.0` remains exact dev-only. The Orchestrator
feature-module standard is adopted, but the proposed consolidation from six
contexts to `Token Control` and `Cross-chain Accounting` requires proposed
ADR-0004 to supersede accepted ADR-0003. Before migration, local mechanical gates
must cover package catalog, default-deny edges, rogue/deep imports, empty layers,
exports, workspace discovery and package-consumer tests.

## Decisions still requiring the owner

1. Governance activation charter and starting numerical parameters.
2. Accept or reject ADR-0004's two-context topology.
3. Global 30/90-day liquidization and outstanding-commitment ceilings.
4. Initial-team revocability and future-grant minimum schedules.
5. Liquidity `0.1% / 0.9%` physical split.
6. Solana emergency choice: custom pause-only PDA, privileged emergency Squads,
   or no fast pause.
7. Commitment-count limits and milestone dispute/appeal semantics.

## Primary production lessons

- [OpenZeppelin Governance v5.7](https://docs.openzeppelin.com/contracts/5.x/api/governance): historical voting, timelock roles and quorum behavior.
- [OpenZeppelin Timelock incident](https://forum.openzeppelin.com/t/timelockcontroller-vulnerability-post-mortem/14958): exact versions and adversarial execution tests matter.
- [Chainlink SVM token-pool model](https://docs.chain.link/ccip/concepts/cross-chain-token/svm/token-pools): mint/pool authorities and recovery tradeoffs.
- [Chainlink SVM upgradability](https://docs.chain.link/ccip/concepts/cross-chain-token/svm/upgradability): Pool Signer PDA still depends on program governance.
- [Uniswap UNI launch](https://blog.uniswap.org/uni): headline community share differs from immediately claimable/control share.
- [Arbitrum AIP-1.1](https://forum.arbitrum.foundation/t/proposal-aip-1-1-lockup-budget-transparency/13360): onchain lock, budgets and reporting followed a trust failure.
- [Beanstalk governance exploit](https://bean.money/blog/beanstalk-governance-exploit): holder voting alone is not capture protection.
- [Optimism/Wintermute incident](https://gov.optimism.io/t/message-to-optimism-community-from-wintermute/2595): target-chain control must be verified before a treasury transfer.
- [Safe modules](https://docs.safe.global/advanced/smart-account-modules) and [guards](https://docs.safe.global/advanced/smart-account-guards): generic extension power can drain or freeze custody.
