---
id: ADR-0010
type: adr
status: accepted
owner: architecture
summary: Stages AGTMAI Ethereum genesis before a separately qualified Solana bridge.
related: [ADR-0007, ADR-0008, ADR-0009]
blocked_by: []
code_anchors: []
supersedes: []
superseded_by: []
---

# ADR-0010: Ethereum-first launch sequence

## Context

On 2026-09-24 the owner selected an Ethereum-first release. The fixed-supply
token, grant custody, reserve controls and offline genesis tooling exist in the
repository, and a real Sepolia -> Solana Devnet -> Sepolia CCIP round trip has
settled. Neither that testnet proof nor local reserve tests establish an
Ethereum Mainnet deployment or a production Ethereum <-> Solana lane.

Using Chainlink's standard pools avoids writing a bridge from scratch, but a
production lane still needs exact protocol and authority qualification, pool
configuration, rate and fee bounds, backing reconciliation and settled
bidirectional canaries. Proposed ADR-0007 records those unresolved gates. In
particular, the deployed Solana Mainnet Fee Quoter does not byte-match the
examined official `solana-v1.6.0` through `solana-v1.6.4` release artifacts;
its source/build attribution is unknown. This is a provenance gap, not evidence
of an exploit or incorrect fees. Track it in [issue #43](https://github.com/agent-teams-ai/agent-teams-token/issues/43).

## Decision

Stage the release. First prepare and, only after its own release gates and a
fresh owner authorization, deploy the immutable AGTMAI token and accepted
genesis/reserve/grant custody configuration on Ethereum Mainnet. Do not make
Solana deployment, CCIP pool registration, bridge operation, a public sale,
airdrop, DEX liquidity, utility or governance a prerequisite for this
Ethereum-only genesis. Do not advertise cross-chain Mainnet transfers at that
stage. The accepted supply, allocation, vesting, reserve and custody policy in
ADR-0008 and ADR-0009 remains unchanged.

Before irreversible genesis, approve the exact production token contract and
bytecode. The repository contains both `AGTMAIToken` and
`AGTMAICCIPToken`; only the latter has an immutable initial `getCCIPAdmin()`
registration address. The Ethereum-first choice does not itself select that
variant or its administrator. Review the future-bridge registration path and
bind the chosen artifact and real administrator to the approved deployment
configuration. No later bridge decision may assume a token can be upgraded or
reminted.

Ethereum Mainnet is **not** one transaction away. The remaining gates are:

1. Record and verify two distinct real Safe 2-of-3 configurations (Project
   Controller and Founder Beneficiary), their public owner addresses and
   recovery arrangements. The solo founder remains the beneficial controller.
2. Approve actual allocation recipients, grant beneficiaries and amounts,
   exact UTC vesting dates and leap-day choice, reserve purposes, per-grant and
   rolling 365-day cap values, count/rate limits and all other genesis inputs.
   Produce a strictly validated, canonically hashed `accepted` configuration;
   a proposal or local fixture is insufficient.
3. Qualify exact contracts, constructor inputs and deployment wiring with
   independent security review and required repository checks. Complete the
   external entity, jurisdiction, classification and disclosure review that
   ADR-0009 requires before genesis.
4. Prepare an independently checked **unsigned** Ethereum-only deployment plan
   with chain ID, bytecode hash, target/signer/nonce, per-transaction gas and
   live ETH/USD fee ceilings. Stop on any mismatch or exceeded cost bound.
5. Obtain fresh explicit owner approval for each exact Mainnet broadcast. After
   execution, retain receipts, contract verification, onchain custody/reserve
   checks and public token facts. No uncertain transaction is blindly retried.

The agent must never receive, mount, log or store a Mainnet private key or seed
phrase. Planning needs public addresses only. The owner creates and backs up
distinct signer keys outside this repository and signs the reviewed
transactions in their own wallet/hardware signer; the agent may inspect public
transaction hashes and onchain results afterward. Safe's 2-of-3 threshold does
not establish three independent people or prove that keys are on separate
devices.

The Solana bridge becomes a separate release. It requires an accepted protocol
line or explicitly approved alternative to the Fee Quoter attribution gap, a
reviewed backing/administration policy, pinned production identities and
limits, independent audit and an approved two-way Mainnet canary with supply
reconciliation. Testnet success alone cannot close these gates. This ADR
authorizes no transaction, signing, deployment or broadcast on either network.

## Consequences

Engineering can finish Ethereum-only preparation without waiting for Solana
release provenance or mainnet bridge qualification. The first public claim must
say exactly what has been deployed and verified on Ethereum; cross-chain
capability remains a future, separately accepted claim. The staging decision
does not waive legal, security, custody or owner-signing gates.

## Rejected alternatives

- Requiring simultaneous Ethereum and Solana Mainnet launch would delay the
  Ethereum token on unresolved bridge-specific evidence without improving its
  fixed-supply or reserve correctness.
- Treating the settled testnet round trip as Mainnet bridge qualification would
  conflate different protocols, addresses, authorities and assets.
- Giving an agent production private keys would expose the owner to chat,
  workspace, worker and log retention risks without being needed for an
  unsigned plan or public-chain verification.
