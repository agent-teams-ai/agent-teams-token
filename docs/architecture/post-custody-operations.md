---
id: token.architecture.post-custody-operations
type: architecture
status: active
owner: architecture
summary: Deployment configuration, custody proofs, read-only readiness and manifest-derived public facts.
---

# Post-custody operations

## Purpose

Prepare and verify one deployment configuration and its custody, bridge and
public-fact evidence. This work implements the four-feature scope in
[PLAN](../PLAN.md#active-post-custody-implementation-2026-09-15). Implementation
and offline qualification are in progress; no new owned-testnet acceptance or
mainnet readiness is claimed by the presence of this runbook.

## Ownership boundary

`@agent-teams/supply/deployment` owns pure validation, calendar arithmetic,
unsigned preparation and verified deployment facts. Its parsing, hashing,
artifact and filesystem adapters remain outside that public entrypoint.
`tooling/testnet-ccip` owns custody/testnet execution; `tooling/deployment-plan`
owns read-only readiness. Existing Solidity remains unchanged.

The authored configuration owns intentions. Prepared inputs bind its canonical
SHA-256 to source and compiler artifacts. A deployment manifest owns confirmed
addresses, creation transactions and immutable terms. Separate observations own
mutable balances, authorities, activity and estimates. Generated passports and
registries never become a second editable fact source.

## Invariants

- Modes are `local-test`, `owned-testnet` and `mainnet-dry-run`; there is no
  mainnet execution mode. Compilation is unsigned.
- Supply, allocation amounts, purposes, recipients, limits and exact UTC seconds
  are explicit inputs. Test fixtures have no product approval.
- Production uses `calendar-12-48`: preserve UTC time of day and explicitly
  select the February-29 anniversary rule when applicable. The supported start
  years are 1970–9995. Calendar validation is separate from Solidity uint64
  validation. An accelerated schedule is always test-only.
- Resolve test timestamps once. Persist them and the digest; a missed funding
  deadline needs a new run/configuration identity. Never retime a resumed run.
- Three Safe keys and a threshold of two do not prove independent beneficial
  control. The configured disclosure must identify the actual control model.
- A founder vault has a callable cancellation entrypoint that rejects founder
  cancellation. A team refund equals allocation minus vested entitlement;
  unpaid vested debt remains owed to the immutable beneficiary.
- Minting directly to, or donating into, an unfunded vault does not activate it.
  The original reserve must approve exactly the grant allocation and fund it
  once before its start. Production reserve wiring remains a prerequisite.
- Config status `accepted` does not establish approval. Production preparation
  additionally requires independently selected approval evidence bound to the
  canonical configuration digest. Changing any approved value invalidates it.
- Ethereum issuance includes custody balances. Bridge backing is counted once.
  Equal Solana supply at two endpoints cannot prove absence of intervening
  mint/burn activity.
- Published files contain allowlisted public fields only. Credentials, signer
  references and RPC settings remain private. A file-hash inventory is written
  last, excludes its own digest, and rejects changed/missing files.

## Inputs and qualification

Synthetic examples live in `packages/contexts/supply/tests/fixtures/deployment/`.
They intentionally use different supplies, recipients and schedules. Do not
promote them into production input. Bridge protocol/network hashes identify
pinned configuration, not current chain evidence. Missing deployments and
unqualified protocol identities remain unresolved.

Use the repository's pinned offline toolchain and frozen dependency cache.
The root gates, Solidity suites, native SDK cases and actual local integrations
remain required; a skipped or unavailable prerequisite is not a passing proof.
Historical September-8 journals retain their original identities and must not
be replayed as new transfers.

## Deployment configuration commands

```bash
pnpm deployment:config validate --config "$CONFIG"
pnpm deployment:config compile --config "$CONFIG" --artifacts "$ARTIFACT_PINS" --output "$PREPARED"
pnpm deployment:config materialize --prepared "$PREPARED/prepared-deployment.json" --evidence "$DEPLOYMENT_EVIDENCE" --output "$DEPLOYMENT"
pnpm deployment:config verify --manifest "$DEPLOYMENT/deployment-manifest.json"
```

For production compilation, also supply `--approval "$APPROVAL"`. The standalone
approval record has schema `agtmai-deployment-approval-v1`, a public `reference`
and the independently selected `configurationSha256`. There is no execution or
RPC option on these commands.

The `agtmai-artifact-pins-v1` input records the contract-source `sourceRevision`
and exactly two artifact entries (`AGTMAICCIPToken`, `GrantVault`), each with
`artifactPath`, `artifactSha256`, `buildInfoPath` and `buildInfoSha256`. Hashes
cover the actual bytes; paths resolve relative to the pins file. The pinned
Foundry build must use repository compiler/optimizer/EVM settings. Compilation
publishes the raw artifact/build-info files so later verification can authenticate
runtime immutable slots against their hashes instead of trusting a claimed hash.

Materialization requires bounded native creation evidence for each present
contract: transaction identity/input, receipt/events, canonical block observations,
finality, runtime and all required getters at the same block. It emits
`not-deployed`, `partial` or `deployed` without inventing missing observations.
A selected offline RPC capture establishes reproducibility under stated RPC
trust; it is not an independent consensus proof. Custody and current authority
observations remain separate from deployment facts.

Exit codes are 0 for completed verification/preparation, 2 for rejected inputs,
3 for unavailable I/O and 4 for unexpected internal failure. Reports separately
state their status/reason and `broadcastAllowed: false`. Output directories are
exclusive. Preserve an incomplete directory and use a new output directory or
an authenticated publication-only retry; never repeat a transaction to repair
publication.

## Recovery and external execution

Custody orchestration advances one operation at a time. Preserve signed
transaction identity before submission. After uncertainty, reconcile that
identity; neither timeout nor not-found authorizes replacement. A finalized
revert or Safe inner failure is terminal even when the outer Safe transaction
succeeded. Crash locks need process-death evidence and journal reconciliation;
age is insufficient. Publication retry never repeats an economic operation.

Later orchestration supplies the reviewed official Safe artifacts, native
providers, owned faucet-funded identities and endpoints without exporting
secrets. It must execute a fresh small Sepolia custody scenario, official
E→A/A→E/E→B transfers using liquid tokens, and publish finalized native evidence.
Local time-warp proofs and offline captures cannot substitute for that run.
Read-only mainnet observation remains separate and cannot submit transactions.
