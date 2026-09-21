# Open product decisions

## Accepted production policy

This register supersedes its former `45/25/15/8/6/1` allocation, independent
Bridge/Treasury/Emergency-signer, governance-activation, liquidity and airdrop
assumptions. The accepted policy is `Agent Teams AI` (`AGTMAI`): a fixed supply
of `100,000,000` tokens at `9` decimals. It is recorded in the accepted
[production reserve policy](decisions/0008-production-reserve-commitment-policy.md);
the committed local implementation and its proofs are not deployment or mainnet
readiness evidence.

The canonical allocation identifiers and envelope are:

| Identifier | Share | Policy meaning |
| --- | ---: | --- |
| `long-term` | 30% | Long-term allocation |
| `users` | 30% | Users allocation |
| `founder` | 3% | Irrevocable founder genesis grant |
| `contributors` | 17% | Revocable future-contributor reserve |
| `operations` | 9% | Operations allocation |
| `ecosystem` | 5% | Ecosystem allocation |
| `financing` | 5% | Financing allocation |
| `liquidity` | 1% | Liquidity allocation |

Together, `founder` and `contributors` are the 20% contributor envelope, so the
allocation policy is 30/30/20/9/5/5/1. Founder grants remain irrevocable after
funding. Future contributor grants are revocable only as accepted policy: a
successful cancellation returns unvested tokens to the originating reserve while
vested and released value remains the beneficiary's claim.

Custody is honest solo-founder control, not independent-human signing,
decentralized governance or a DAO: the Project Controller Safe and Founder
Beneficiary Safe are separate Safe 2-of-3 configurations with distinct
keys/devices. The actual Safe addresses and configuration evidence remain
deployment inputs; this statement does not claim independent human signers.

The accepted reserve controls are a rolling 365-day gross-commitment cap and a
per-grant cap. Commitments are charged on successful funding and refunds do not
restore capacity. Exact production cap amounts, commitment-count limits and rate
limits remain required inputs and must not be invented.

The MVP does not include the former global 30/90-day liquidization budget.
Before any later public market or liquidity launch, publish circulating-supply
and synchronized-unlock analysis and explicitly accept or reject a separate
global unlock/liquidization budget. That future decision does not block code-only
deployment preparation.

## Open deployment inputs before mainnet genesis

1. Record and qualify the real Project Controller Safe and Founder Beneficiary
   Safe addresses, their 2-of-3 owners, and the distinct-key/device setup.
2. Supply real allocation recipients and grant beneficiaries. The allocation
   envelope is accepted, but actual addresses and individual grant amounts remain
   unresolved deployment inputs.
3. Supply exact UTC grant start, cliff and end dates, the applicable leap-day
   choice, and the approved purposes for individual grants.
4. Supply the exact rolling 365-day gross-commitment cap, per-grant cap,
   commitment-count constraints and rate limits. Validate and canonically hash
   the accepted configuration before any production genesis artifact is made.
5. Complete the remaining deployment-specific qualification, including the
   selected configuration approval, production addresses and required protocol
   evidence. A public broadcast still requires fresh explicit human approval.

ADR-0004 remains proposed and independently open; it does not change this
accepted allocation, custody policy or code-only deployment preparation.

## Current MVP boundary

The MVP excludes utility pricing, checkout and burn; AMM/LP activity; public
sales; airdrops; a DAO; and a legal model. A future utility is a consumptive
product integration, not an investment-return or ownership promise, and it does
not block code-only deployment preparation. ReviewRouter is not a blocker.
These excluded activities require separate future decisions and must not be
presented as current launch scope.

Legal work is outside this repository's code scope, not waived. External entity,
jurisdiction, classification and disclosure review is required before mainnet
genesis or any public sale, airdrop, liquidity promotion or user-facing utility
offer.

## Mandatory TODO before any Ethereum Mainnet deployment

This checklist cannot be waived merely because gas happens to be cheap:

1. Bind the accepted fixed supply and canonical allocation envelope to real
   recipients, exact grant amounts and every UTC vesting/release input. The
   configuration must be strictly validated and canonically hashed before
   production genesis; a local fixture is not deployment approval.
2. Measure gas against the exact final constructor input and exact pinned
   bytecode; do not extrapolate from source-line count or an older build.
3. Fetch live base/priority fees and ETH/USD immediately before signing. Present
   the estimated ETH/USD total and worst-case transaction limit to the owner.
4. Add fail-closed `chainId`, bytecode/hash, signer, nonce, fee and maximum-total-
   cost guards. A violated guard must prevent signing and broadcasting.
5. Produce and independently verify an unsigned deployment plan first. Public
   broadcast requires a fresh explicit owner approval; no automatic retry after
   an uncertain result.
6. Estimate every deployment separately: AGTMAI core, reserve/grant contracts,
   Safe and protocol configuration, and verification operations. The cheap core
   deployment must never be presented as the cost of the whole launch.
7. Reconfirm explorer verification inputs and retain transaction, receipt,
   compiler/build and constructor evidence after deployment.

## P1 after the first vertical slice

1. Community-grant policy, budget cadence and reporting format.
2. Whether the code is published under Apache-2.0 and how brand assets are
   separately protected.

## Later engineering: Foundation TypeScript coverage

Not launch-blocking. Think later. Do not treat this as a current delivery
slice. The current slice is
[Source v3 coverage goal](architecture/source-v3-coverage-goal.md).

Green CI today means the declared source graph matches the declared
allowlists. It does not yet mean every Token TypeScript root is in that
graph. Solidity and Rust stay outside this gate by design.

Keep these invariants when the work is picked up:

- `EXPECTED_TOOLING_BOUNDARIES` stays exactly 13 `tooling.*` IDs. Extra
  `tooling.*` IDs fail rollback. New coverage must use other ID prefixes
  such as `ccip.*` or `token.*`.
- `packageRoots` stay `packages/domain` and `packages/contexts/supply`.
- Do not mkdir empty leftover directories to satisfy schema v3.

Candidates, in useful order:

1. Add a coverage ratchet so every `tsconfig` and production `*.ts` /
   `*.mjs` is in `governedRoots` plus a boundary, or is explicit
   `test|fixture|generated`.
2. Classify `tooling/testnet-ccip`. It already has `src/domain`,
   `application`, `adapters`, `composition`, and tests, but it is absent
   from `architecture/foundation/source-dependencies.yaml`.
3. Classify `tooling/local-evm`. `model.ts` is pure; `runner.ts` uses
   `fs` and `child_process`. Do not paint the whole directory as domain.
   Split like `local-solana`, or keep one honest adapter boundary.
4. Classify remaining `scripts/` except `execution-environment`,
   including `scripts/rollback` and `scripts/tests`.
5. Classify tails in `tooling/security` outside `slither/src`, plus extra
   files in `tooling/local-solana` and `tooling/deployment-plan`.
