# Six-critic review of the token foundation

Date: 2026-08-27

Status: adversarial review of the proposal, not legal or financial advice. Six
independent critics reviewed economics, community trust, governance/security,
distribution/liquidity, legal/disclosure and implementation architecture.

## Verdicts

| Track | Verdict | Main reason |
| --- | --- | --- |
| Economics | AMEND | Good community-first intent, but liquidity reserve, post-Year-1 release limits and cash-runway language needed tightening |
| Community trust | AMEND | `community-directed` was not true while binding community control is 0% |
| Governance/security | AMEND | Direct bridge admin, generic timelock transfers and permanent cancellation created bypass/deadlock paths |
| Distribution/liquidity | AMEND | `$0` Devnet is correct, but Raydium `priceImpact` and user slippage were conflated |
| Legal/disclosure | AMEND | Live utility and a Token Facts Pack are prerequisites, not classification or MiCA safe harbors |
| Architecture | AMEND | CCIP protocol line, executable config/schema and first vertical slice were not yet implementable contracts |

No critic recommended rejecting the project or abandoning the Ethereum → CCIP →
Solana architecture.

## Accepted amendments

1. **Naming.** `Agent Teams AI / AGTMAI` was approved by the product owner. Exact
   matches were not found in the checked CoinGecko, SEC, Jupiter, DexScreener or
   GitHub sources. Formal trademark/listing clearance is still required.
2. **Test cost.** Local, Sepolia and Solana Devnet use `$0` real-value assets.
   Fake USDC and faucet assets are never purchased. Faucet failure pauses only
   that public-testnet step.
3. **Allocation.** The recommended proposal is `45/12/13/5/20/5`: community
   treasury, operations, contributors, founder, distributions, liquidity. It
   reduces the market-control reserve without pretending that token inventory
   supplies the external USDC side of a pool.
4. **Truthful control.** 65% is community-designated, while binding community
   control is 0% at genesis. Project-administered control is disclosed as 82%,
   or 95% while the unassigned contributor reserve is included.
5. **Enforcement.** Budget caps require purpose-specific vaults without generic
   `execute` or `approve`, not only a Timelock and a promise. Bridge admin is
   behind its own Timelock. Emergency powers expire and can only cancel or reduce
   bridge capacity.
6. **Solana supply.** Recoverable authority is allowed only for tests or a
   bounded disclosed beta. Direct Pool Signer PDA is required before broad
   public distribution/liquidity.
7. **Distribution.** Airdrop lanes are separated into gratuitous retrospective,
   earned grants and usage/loyalty rewards. Work, referrals, promotion or PII
   consideration are never relabelled as a free airdrop.
8. **Liquidity.** Devnet may use 50-100 fake USDC units. A public pool requires
   exact current Raydium simulation. With a 25 bps CPMM the planning baseline is
   about `$13.2k` quote for `$100 <=1%` SDK price impact; use at least `$15k`,
   preferably `$20k`, or launch without an official pool. User slippage remains
   a separate guard.
9. **Legal sequence.** Local/test-only neutral work may continue. Rights/ABI and
   mainnet genesis wait for entity, jurisdictions and classification. Public
   addresses, claims, distribution, marketing and pools wait for their specific
   offer/white-paper/venue/market-conduct gates. Facts Pack does not replace a
   statutory document.
10. **Executable source of truth.** Proposal YAML uses integer bps/base units and
    cannot compile a production manifest until `status: accepted`. The compiler
    must use a strict schema, exact UTC seconds, canonical JSON and golden hash
    vectors.
11. **CCIP compatibility.** Before pool or monitor implementation, compare EVM
    CCIP `1.6.4` and `2.0.0` against the live SVM `1.6.3` lane and pin one
    verified line in an ADR. Backing may live in a separate LockBox, so the
    monitor cannot assume `balanceOf(pool)`.

## Deliberately unresolved

- One critic preferred team `12→60` and founder `18→72`; others considered the
  current no-catch-up `12→48` and `18→60` fair. Keep the current schedule as a
  proposal until the owner explicitly chooses.
- An 18-month external cash runway is a strong launch-risk control but not a
  reasonable hidden prerequisite for local MVP work. Before public distribution,
  publish the actual stablecoin/fiat operating plan and never count treasury
  tokens as runway.
- Formal trademark/listing clearance remains a pre-launch gate; product-owner
  approval is recorded and the naming choice is no longer open.

## Revised delivery shape

The first proof is a narrow vertical slice:

```text
accepted config
  -> canonical genesis manifest/hash
  -> token + vesting + capped policy vaults + timelocks
  -> local Anvil deployment
  -> independent read-only verifier report
```

Only then add a version-specific CCIP adapter, Solana authority verifier,
finalized exactly-once ledger and an explicitly approved Sepolia-Devnet round
trip. Estimated testnet-ready scope is 5,800-9,300 LOC excluding web and airdrop.

The permanently prohibited mistakes are maintained in
[`docs/NON_NEGOTIABLES.md`](../NON_NEGOTIABLES.md).
