# Engineering baseline research

Date: 2026-08-27

## Stack decision

Use Solidity and Foundry only for Ethereum contracts and invariant tests. Use
TypeScript 7 for Solana and CCIP tooling, deployment plans, reconciliation,
monitoring and the dashboard. Use native macOS arm64 binaries for feedback and
digest-pinned Linux containers for CI parity.

Historical baseline at the research date:

| Component | Selected or observed version | Policy |
| --- | --- | --- |
| Node | 24.20.0 | Pinned native archive |
| pnpm | 11.24.0 | Exact package-manager identity |
| TypeScript | 7.0.2 | Exact catalog version |
| Engineering Foundation | 0.19.0 | Exact dev-only registry dependency |
| Foundry | 1.8.0 | Checksum-pinned native archive and digest-pinned container |
| Agave | 4.2.1 | Checksum-pinned local validator |
| Chainlink CCIP SDK | 1.13.0 current | Add only with the first real adapter |
| Chainlink Local | 0.2.9 current | Isolated test-only package because its CCIP contracts trail production |
| Chainlink CCIP EVM | 1.6.4 versus 2.0.0 unresolved | Execute compatibility spike against live SVM lane, then ADR and exact pin |
| Chainlink CCIP SVM | Superseded: single 1.6.3 live-line claim | Corrected snapshot: Router, BurnMint and LockRelease match `solana-v1.6.2`; OffRamp and RMN match `solana-v1.6.3`; Fee Quoter has no exact match in supplied `solana-v1.6.0` through `solana-v1.6.4` artifacts, so qualification remains blocked |
| OpenZeppelin Contracts | v5.7.0 stable release | Pin only after compiler and Chainlink compatibility spike |
| Solidity | 0.8.36 current | Candidate, not a contract baseline until the compatibility spike passes |

Sources: [Engineering Foundation](https://github.com/agent-teams-ai/engineering-foundation),
[Foundry releases](https://github.com/foundry-rs/foundry/releases), [Chainlink CCIP
SDK](https://www.npmjs.com/package/@chainlink/ccip-sdk), [Chainlink Local](https://www.npmjs.com/package/@chainlink/local),
[OpenZeppelin releases](https://github.com/OpenZeppelin/openzeppelin-contracts/releases),
and [Solidity releases](https://github.com/ethereum/solidity/releases).

Correction, 2026-09-21: the former single live SVM `1.6.3` baseline is
superseded by the proven mixed snapshot in the table above. This dated research
does not accept ADR-0007 or qualify a protocol line.

Do not install every researched tool pre-emptively. `viem`, Safe Protocol Kit,
Squads, Solana clients, Slither, Echidna, Medusa and Halmos enter only with a real
consumer and a pinned test. In particular, the CCIP SDK currently uses
`@solana/web3.js`; adding `@solana/kit` at the same boundary would create two
transaction models without product value.

## Architecture

The invariant dependency direction is:

```text
domain <- application ports/use cases <- chain and storage adapters <- composition
```

Bounded contexts:

- Supply: fixed supply, pending transfers, reconciliation and incidents.
- Distribution: allocations, grants, vesting, airdrop waves and claim state.
- Treasury: budgets, proposals, signer/control evidence and timelocks.
- Cross-chain Transport: CCIP message lifecycle and chain-specific execution.
- Transparency: manifests, dashboard projections and public reports.
- Launch Liquidity: simulations, depth gates, LP custody and market policy.

Domain values use `bigint` or canonical decimal strings. Clocks, randomness,
environment, filesystem, RPC and wallet effects are ports. Ports stay narrow,
for example `ReadCanonicalSupply`, `ReadRemoteSupply`, `ReadPendingTransfers`
and `SubmitTransfer`. There is no generic chain client in the domain.

SOLID means adapters have one operational reason to change, domain use cases
depend on ports, and read/write capabilities are split. DRY does not mean forcing
EVM and Solana into one abstraction: shared code is extracted only after two
real consumers prove identical invariants and failure semantics.

## Engineering Foundation adoption

Enabled applicable capabilities:

- exact catalog and workspace dependency declarations;
- observed source-dependency boundaries;
- local Markdown reference validation;
- immutable accepted ADR evidence;
- governed, expiring lint suppressions with no current waivers;
- bounded fast quality gates;
- portable agent instruction routing.

Foundation remains an exact dev dependency and production imports are rejected.
The strict tokenomics schema/compiler is the first executable specification and
must precede production genesis compilation. Public API compatibility is
deferred while all workspace packages
are private. Repository publishing security and protobuf/JSON-schema evolution
are deferred until those artifacts exist; fabricating empty evidence would not
improve safety.

## Test strategy

- Domain: examples plus property tests for supply, allocation and vesting maths.
- Solidity: Foundry unit, fuzz and stateful invariants; exact timestamp, rounding,
  role graph, donation and cancellation boundaries.
- Adapters: deterministic fixtures for RPC failures, reorg/finality, duplicate
  messages and manual execution.
- Local integration: Anvil plus Agave with valueless accounts; CCIP delivery is
  explicitly mocked.
- Public testnet: `$0` real-asset budget. Sepolia ETH, Devnet SOL, test LINK and
  fake USDC come from faucets/local minting; unavailable faucets pause only that
  E2E step and never justify buying test assets.
- Security: Slither first, then Echidna/Medusa/Halmos only for risks their model
  can prove; target-chain Safe/Squads ownership and authority readback.
- Public testnet: one approved Sepolia-to-Solana Devnet round trip and return.
  This is the only first-party evidence of real cross-family delivery.
- Mainnet: simulation, decoded state diff, canary amount, human multisig approval
  and independent post-state verification. No autonomous signing.

The first implementation slice should be `accepted config -> canonical allocation
manifest/hash -> immutable EVM token/policy vaults/vesting -> local invariant
tests -> independent read-only verifier report`. Local/test-only neutral work may
start before entity selection. CCIP and Solana adapters follow the protocol-line
ADR; public distribution, marketing and pool work still wait for their legal and
economic gates.
