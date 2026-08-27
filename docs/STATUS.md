# Project status

Last updated: 2026-08-28.

Approved product identity: `Agent Teams AI`, symbol `AGTMAI`. Formal pre-launch
clearance remains required.

Liquidity direction: trading is required, founder total cash contribution is
capped at `$100`, and community liquidity must be added directly by its owners.
The first pool is explicitly experimental and highly volatile, not depth or
valuation evidence.

Tokenomics working baseline, still under discussion: `45/25/15/8/6/1` for the
community-governance reserve, distributions, all contributors, operations,
ecosystem grants and liquidity. Founder is capped at 3% inside contributors.

## Proven locally

- Monorepo dependency installation is reproducible from the lockfile.
- TypeScript 7 typecheck, lint and domain tests pass.
- The pure supply projection covers quiescent and both in-flight bridge
  directions; it is not yet a finalized event-ledger source of truth.
- Public networks are disabled by default.
- Tool and container versions are exact pins with checksum or digest evidence.
- Foundry 1.8.0 native and containerized Anvil are verified on chain ID 31337.
- Engineering Foundation 0.19.0 is installed dev-only; applicable architecture,
  dependency, documentation, ADR, suppression and quality-gate policies pass
  static validation.
- The containerized Anvil RPC responds on host port `8545` with chain ID 31337.
- Native Agave validator RPC responds on host port `8899` with version 4.2.1.
- Local, Sepolia and Solana Devnet testing has a `$0` real-asset budget; fake
  USDC and faucet test tokens are never purchased.
- Confirmed historical and design anti-patterns are frozen in
  `docs/NON_NEGOTIABLES.md` as an implementation/review contract.
- Six independent critics returned `AMEND`, not `REJECT`; accepted amendments
  and deliberately unresolved choices are recorded in
  `docs/research/CRITIQUE-ROUND-2026-08-27.md`.
- Four contract designers and five independent critics reviewed the release,
  governance, liquidity, security, economics and architecture proposal. The
  synthesis is recorded in
  `docs/research/CONTRACT-DESIGN-REVIEW-2026-08-27.md`; those earlier reviews
  used the disclosed local read-only fallback, and no contract code started.
- Five additional independent read-only reviews ran on production hosted
  subscription runtime against exact commit `853a14a` using `gpt-5.6-sol`,
  `xhigh` reasoning and fast service tier. Their accepted findings narrowed the
  executable first slice and are recorded in
  [`GENESIS-CORE-PLAN-CRITIQUE-2026-08-28.md`](research/GENESIS-CORE-PLAN-CRITIQUE-2026-08-28.md).

## Designed, not implemented

- Detailed local-only Genesis Core implementation plan: strict proposal/test
  fixture separation, constructor-computed allocation commitment, immutable
  ERC-20, adversarial Anvil verifier and exact-SHA Linux parity. Vesting, local
  SPL and mocked accounting are later independent slices. Production manifest
  approval is intentionally not simulated by a self-declared status/hash.
- Feature-module standard from Agent Teams Orchestrator is adopted. The proposed
  two-context topology is recorded in ADR-0004 and awaits explicit acceptance.
  The local Genesis Core plan uses accepted ADR-0003 for the new manifest
  feature but leaves the generic bootstrap unchanged until ADR-0004 is accepted
  or rejected, avoiding a temporary double migration.
- Purpose-specific release/vesting vault proposal, rolling commitments and global
  liquidization budget; governance-reserve activation remains an explicit open
  decision and ABI blocker.
- Ethereum fixed-supply token, vesting and treasury contracts.
- Chainlink CCIP Ethereum and Solana pool configuration.
- CCIP EVM `1.6.4` versus `2.0.0` compatibility ADR and canonical backing-holder
  model for the live SVM `1.6.3` lane.
- Strict tokenomics schema/compiler and canonical genesis manifest/hash.
- Event-sourced cross-chain monitor and public transparency dashboard.
- Airdrop, liquidity and governance execution.
- Legal entity, launch jurisdictions, live utility and final tokenomics approval.

## Not proven locally

- Real CCIP offchain delivery between Ethereum and Solana. This requires an
  approved Sepolia-to-Solana Devnet test and must not be simulated as evidence.
- Mainnet addresses, signers, legal classification, audits or launch readiness.

No production token, sale, liquidity pool or official airdrop exists.
