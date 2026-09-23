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
Passport generation and checking take a `PassportHashPort` with `sha256(bytes)`;
the file composition supplies the existing SHA-256 adapter. Canonical bytes and
passport digests retain their format.
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
  once no later than its start. The configured funding lead time is a stricter
  operational gate. Production reserve wiring remains a prerequisite.
- Config status `accepted` does not establish approval. Production preparation
  additionally requires independently selected approval evidence bound to the
  canonical configuration digest. Changing any approved value invalidates it.
- Ethereum issuance includes custody balances. Bridge backing is counted once.
  Equal Solana supply at two endpoints cannot prove absence of intervening
  mint/burn activity.
- Mainnet dry-run bridge configuration requires all four rate-limit buckets
  enabled. Enabled `0/0` pauses transfers; disabled `0/0` would be unlimited.
  Each outbound capacity and refill rate must fit the opposite inbound bucket.
  A positive production capacity requires a positive refill rate.
  These checks do not prove the current live bucket state.
- Published files contain allowlisted public fields only. Credentials, signer
  references and RPC settings remain private. A file-hash inventory is written
  last, excludes its own digest, and rejects changed/missing files.

## Grant custody boundaries

The [current qualification slice](../PLAN.md#grant-custody-qualification-2026-09-16)
retains the immutable vault and accounting library. The constructor encoding
boundary rejects every kind except `founder` and `team`; valid values still map
to ABI enums 0 and 1. Grant names do not establish revocability. Configuration,
constructor words, runtime/getters and `GrantConfigured` must agree exactly.

Funding has two distinct operations: the original reserve approves the vault,
then calls `fund()`. The full allocation pull and activation occur in that one
call. A failing funding transaction rolls back token movement, allowance
consumption and the funded flag; an earlier successful approval remains. Use
exact finite allowance equal to the allocation for the reviewed operational
path. The contract itself accepts sufficient allowance. Reconcile existing
allowance and uncertain transaction identities before another action; neither a
prior donation nor direct genesis minting activates a grant. A successful funding
receipt needs the canonical token's reserve-to-vault `Transfer` and
`GrantFunded`, with unchanged total supply and no mint event.

For allocation A, releases L, refunds Q, separately attributed donations D and
vault balance B, funded principal conserves `L + Q + (B - D) = A`. Donations
never increase entitlement or spending authority and have no recovery path.
The production reader assumes a complete fresh inventory, zero attributed
donations and isolated block-level before/after effects. Ambiguous activity
must not be attributed to a grant simply because aggregate arithmetic balances.

The beneficiary address and terms cannot change at any lifecycle stage. Claims
must originate from that address and always pay that address. Before funding,
an address error requires abandoning the empty vault and reviewing a new vault
identity and schedule. After funding there is no migration or recovery selector.
Team cancellation cannot move frozen vested debt into a replacement vault.
Review the full ABI/runtime and the beneficiary's ability to call `release()`;
negative tests of guessed selectors alone do not establish absence of a path.
A fixed address does not prevent key sale, smart-wallet owner or implementation
changes, offchain assignment, or sale of released tokens. The local controlled
wallet test demonstrates this limitation; it is not a Safe implementation.

Founder non-revocation applies to funded custody. Before activation, the reserve
can withhold funding. Once funded, even an authorized Safe cancellation cannot
refund founder principal. The public selector remains present and rejects with
`FounderCannotCancel` after authorization and funding checks. No rescue, pause,
approval, upgrade or alternate withdrawal route exists in GrantVault.

For a team's successful cancellation at time τ, freeze `F = V(τ)`, return `A-F`
to `ORIGINAL_RESERVE`, and retain `F-L` as beneficiary debt in the same vault.
Previously released value is never clawed back. A failed refund restores the
uncancelled ledger and balances; a later successful retry uses its later block
time. Fully vested cancellation can emit a zero refund without a token call.
Claims after the original end remain payable from frozen debt. Subsequent claims
advance `lastTransition`, so retain the cancellation receipt/event to identify τ.
Departure is a human decision; no HR oracle, personal record or backdated cutoff
is part of this contract. External timelock scheduling does not freeze vesting.
The scenario's positive release/refund/debt requirements are acceptance-fixture
constraints, not universal contract preconditions.

## Production reserve prerequisite

The prerequisite is now implemented as the bounded reserve enforcement layer
described below; production qualification and deployment evidence remain
separate gates.

The bounded reserve implementation now provides the purpose-specific onchain
limit that this document previously marked as missing. `ReserveController`
binds the canonical token, one immutable purpose and the controller address;
it creates and fully funds only `TeamService` grants whose terms match that
purpose. It charges the full grant amount to an immutable per-grant cap and a
rolling `(now - 365 days, now]` gross-commitment window. Refunds return only
unvested inventory to the originating reserve and never erase consumed gross
commitments. Approval, funding and commitment accounting are atomic, and there
is no generic transfer, approval or execution bypass. `FounderGrantReserve`
has a one-shot 3% founder allocation with the same 12-to-48-month calendar
validation and no cancellation path.

`ReserveGenesis` and the supply reserve-facts feature verify the 30/30/20/9/5/5/1
allocation envelope, the 3% founder plus 17% contributor split, and normalized
configuration facts offline. They do not choose live beneficiaries, Safe
addresses, cap amounts or deployment dates, and they do not establish that any
contract is deployed. Safe qualification remains a separate custody gate.

Acceptance coverage exhausts a synthetic cap, rejects an immediate over-cap
replacement, verifies refund routing without cap restoration, rejects wrong
purposes and alternate destinations, and proves constructor routing and supply
conservation. Production qualification still requires clean-head toolchain and
deployment evidence; test fixtures and offline facts must not be presented as
mainnet evidence.

## Safe qualification and control

Safe 1.4.1 is a qualification candidate. The artifact adapter consumes a
separately reviewed `agtmai-safe-artifact-pins-v1` record and an independently
selected SHA-256 of its canonical bytes. It checks source revision, raw artifact
and build-info hashes, ABI hashes, compiler provenance, runtime hashes and their
agreement. Supply's token/vault artifact schema remains unchanged. A captured
profile cannot nominate its own trust root. Review must establish official
origin and the exact source revision; calculating a hash is not that review.

The reader accepts qualified profiles and reads owner code at the same canonical
block as proxy/singleton state. Only three distinct supported EOA owners with
threshold two qualify. Sentinel and Safe-self owners, contract/delegated owner
code, modules, guard and fallback handler are rejected. Complete empty module
enumeration, exact proxy/singleton, version, block identity and nonce are required.
The reader additionally requires a separately selected finalized direct setup
transaction: exactly three EOA owners, threshold two, no setup delegatecall,
fallback handler or payment, the authentic `SafeSetup` event and pristine nonce
zero with qualified runtime/state at that block. It rechecks this receipt after
current inspection. Factory/batched initialization remains unsupported. Current
state alone cannot prove absence of historical setup effects; owner rotation
changes the current approved set without rewriting the original setup evidence.

The selected custody disclosure remains one beneficial controller. Separate
keys/devices/seeds/backups and recovery practices are human attestations; Safe
cannot verify their independence. Standard Safe administration can change
owners, threshold and extensions. An observation proves the current configuration,
not permanent 2-of-3 enforcement. Owner rotation requires qualification against
a reviewed updated owner set; an old inspection or signature set is insufficient.
Loss of beneficiary access can strand entitlement even if controller keys recover.

| Operation | Caller route |
| --- | --- |
| Production funding | Safe → approved reserve entrypoint → token approval and vault funding |
| Team cancellation | Controller Safe → `vault.cancel()` |
| Claim | Beneficiary → `vault.release()` |
| Refund | Vault → original reserve automatically |

A Safe cannot directly fund a grant bound to another reserve contract. The local
Safe-as-reserve demonstration uses two ordinary signed transactions, approval
then funding, and makes no reserve-cap claim. Production tooling continues to
support cancellation only; fixture ABI calls are test-only.

Require two distinct owner signatures in canonical order, the exact chain, Safe,
nonce, target, calldata, CALL operation, zero native value and no reimbursement.
An outer successful receipt does not prove inner success. Safe inner failure can
consume its nonce while leaving target state unchanged; an outer revert preserves
Safe state. An `ExecutionFailure` alone does not identify the founder guard; the
Solidity exact-error test establishes that guard under valid prerequisites.
Safe signatures do not enforce an application expiry or automatically bind an
offchain manifest. Pending signatures therefore require reconciliation before
replacement. Source rollback cannot reverse funded immutable custody.

Run `.tools/bin/node --test tooling/testnet-ccip/tests/safe-custody.local.test.ts`
with `AGTMAI_SAFE_ARTIFACT_DIRECTORY` containing `pins.json`, `SafeProxy.json`,
`Safe.json` and the corresponding Hardhat `build-info.json`, and with the
independently selected `AGTMAI_SAFE_PINS_SHA256`. These are qualification inputs,
not production addresses. Missing inputs fail rather than skip. The test uses
the existing disposable local Anvil supervisor and pinned cast with fresh test
identities, never Safe impersonation. Its temporary public evidence directory
contains receipts, transaction fields, state/code observations, recovered signer
identities, nonce changes and grant effects. Synthetic artifact/parser tests
remain explicitly distinct from this actual execution gate. No current Safe
qualification is claimed until this gate passes with official reviewed bytes.

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
cover the actual bytes. Paths must stay below the trusted pins directory, with
no absolute paths, traversal or linked files/directories. Artifact leaves are
`<Contract>.json` or `<contract-lowercase>.artifact.json`; build-info leaves are
Foundry's 16-hex-digit `.json` names or `<contract-lowercase>.build-info.json`.
Other leaves are rejected before reading or publication. The pinned
Foundry build must use repository compiler/optimizer/EVM settings. Compilation
publishes the raw artifact/build-info files so later verification can authenticate
runtime immutable slots against their hashes instead of trusting a claimed hash.
Reads traverse each parent through held Linux directory descriptors and recheck
their identities before returning bytes. Platforms without that traversal fail
closed with `DEPLOYMENT_IO_DESCRIPTOR_TRAVERSAL_UNAVAILABLE`.

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

## Offline custody and readiness verification

`pnpm custody:verify --manifest "$DEPLOYMENT/deployment-manifest.json" --evidence "$TRANSITION"`
requires the complete published deployment directory, including its inventory,
prepared configuration, compiler files and native creation evidence. It recompiles
and hashes the canonical configuration, regenerates the manifest and checks its
preparation/evidence digests before evaluating the transition. A standalone
manifest and fabricated transition are insufficient. The current evidence v1
schema authenticates creation only; it does not bind subsequent custody
transactions, receipts or finality. Therefore this command rejects even
arithmetically valid transitions with `CUSTODY_TRANSITION_PROVENANCE_UNPROVEN`.
The pure transition checker reports `arithmetic-only`; it cannot establish
testnet success. Debt releases after cancellation use the frozen entitlement,
while `lastTransition` advances to the release timestamp.

The read-only custody reader rejects a conflicting finalized hash at the receipt
height and rechecks canonical block identities after capturing effects. The
before-state block must match the receipt block's parent hash. Safe proofs decode
the outer `execTransaction` calldata, bind every call field to the intended vault
operation and recompute the EIP-712 transaction hash before accepting the result
event. The reader requires an independently selected official Safe profile and
checks proxy/singleton runtimes, owners, threshold, extensions and nonce progression
at both blocks. Missing profile authentication cannot establish a Safe result.

Readiness evidence requires JSON booleans for deployment, authority, protocol,
coverage and estimate flags. String booleans are rejected. Report verification
requires all canonical report fields, including explicit `authorityComplete` and
`estimatesComplete` booleans, valid manifest digest and UTC seconds, and consistent
status, reasons and reconciliation. Regenerate earlier reports missing the
required authority field. Adjusted supply and the implied fixed supply must be
nonnegative. Chain timestamps must be inside `[observedAt, validUntil]`; estimate
expiry must be after `observedAt` and at or before `validUntil`.
The report's `validUntil` is capped at the earliest operation estimate expiry;
freshness checks of evidence and reports enforce that shorter interval.
Both verification commands read local files and cannot
broadcast. Readiness verification checks report integrity under the supplied
manifest digest; current chain observations remain separate evidence.

`pnpm token:passport generate` produces a deterministic archive from the manifest
and observations. `pnpm token:passport check` additionally requires `--now` as
canonical UTC seconds inside the observation interval. Authority observations
must identify a configured chain and controlled address; known capabilities must
also match their exact manifest target. Unconfigured capabilities remain
explicitly unresolved, and duplicate capability observations are rejected.
The passport lists each recorded token and grant deployment address,
transaction, block and artifact/compiler-input digest. An empty manifest says
that no deployment transaction is recorded. These facts come from the verified
manifest; they do not claim explorer source verification or current live state.
It also publishes configured allocation amounts, recipients, Safe owners,
thresholds and beneficial-control labels, explicitly distinct from observed
balances and current Safe state.
When bridge configuration is present, the authority registry also lists the
configured EVM pool owner, rebalancer, rate-limit and registry administrators,
plus Solana pool, registry, mint and program authorities. It leaves an unverified Fee
Quoter upgrade authority unresolved. These entries disclose powers and
configuration, not verified live control or qualified protocol artifacts.

```bash
pnpm token:passport generate --manifest "$DEPLOYMENT/deployment-manifest.json" --observations "$OBSERVATIONS" --output "$PUBLIC_FACTS"
pnpm token:passport check --manifest "$DEPLOYMENT/deployment-manifest.json" --observations "$OBSERVATIONS" --passport "$PUBLIC_FACTS/token-passport.md" --registry "$PUBLIC_FACTS/authority-registry.v1.json" --now "$NOW_UTC_SECONDS"
```

## Public read-only verification

This guide becomes usable only after the project publishes a mainnet deployment
manifest, a current token passport, and official Ethereum and Solana addresses.
An address in a proposal or testnet report is not a mainnet address. Do not send
funds to an address taken only from this repository.

### 1. Establish the right contracts

Start with the signed official address manifest. Match its Ethereum chain ID,
token address, deployment transaction and block to the public deployment
manifest. Match the manifest SHA-256 shown in the token passport to the
published manifest. Run the repository's read-only passport check with the
current UTC time in seconds:

```bash
pnpm token:passport check \
  --manifest "$DEPLOYMENT/deployment-manifest.json" \
  --observations "$OBSERVATIONS" \
  --passport "$PUBLIC_FACTS/token-passport.md" \
  --registry "$PUBLIC_FACTS/authority-registry.v1.json" \
  --now "$NOW_UTC_SECONDS"
```

This detects edited or stale published files. It does not prove that the
observations match the chains. Check the deployment transaction's contract
creation address, bytecode and verified source in an Ethereum explorer against
the exact artifact and compiler-input hashes in the manifest. If source is not
verified, treat the implementation as unverified even when a name and symbol
appear correct.

After deployment, verify the published source from a clean checkout at the
manifest's `sourceRevision`, using the exact pinned Foundry profile and the
ABI-encoded constructor arguments recorded in the manifest. For example, from
the repository root, verify the token with [Foundry's documented
command](https://getfoundry.sh/forge/reference/verify-contract/). Set
`ETHERSCAN_API_KEY` in the shell without storing it in the manifest:

```bash
set -euo pipefail
MANIFEST="$DEPLOYMENT/deployment-manifest.json"
git diff --quiet HEAD
test "$(git rev-parse HEAD)" = "$(jq -er '.sourceRevision' "$MANIFEST")"
TOKEN_ADDRESS="$(jq -er '.token.address' "$MANIFEST")"
TOKEN_ARGS="$(jq -er '.token.constructorArgs' "$MANIFEST")"
.tools/bin/forge verify-contract --root contracts/evm --chain 1 \
  --verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --watch --constructor-args "$TOKEN_ARGS" "$TOKEN_ADDRESS" \
  src/features/token-genesis/AGTMAICCIPToken.sol:AGTMAICCIPToken
```

Repeat for every `grants[]` record with its recorded address and constructor
arguments and `src/features/contributor-grants/GrantVault.sol:GrantVault`.
Reserve contracts and any pool require their own verified creation records;
the token/grant manifest cannot establish their source identity. Compare each
sealed artifact and compiler input with the manifest's `artifactSha256` and
`compilerInputSha256` before submission. Compare each explorer result and
deployed runtime with that artifact before publishing the address as verified.
Source verification is a post-deployment public operation, never a substitute
for the unsigned plan or owner approval to broadcast deployment transactions.

### 2. Check issuance and allocations

With a trusted Ethereum RPC and the published token address, the following
calls are read-only. The expected fixed supply is `100000000000000000` base
units: 100 million AGTMAI with 9 decimals.

```bash
cast call "$TOKEN" 'name()(string)' --rpc-url "$ETH_RPC_URL"
cast call "$TOKEN" 'symbol()(string)' --rpc-url "$ETH_RPC_URL"
cast call "$TOKEN" 'decimals()(uint8)' --rpc-url "$ETH_RPC_URL"
cast call "$TOKEN" 'INITIAL_SUPPLY()(uint256)' --rpc-url "$ETH_RPC_URL"
cast call "$TOKEN" 'totalSupply()(uint256)' --rpc-url "$ETH_RPC_URL"
cast call "$TOKEN" 'GENESIS_ALLOCATION_HASH()(bytes32)' --rpc-url "$ETH_RPC_URL"
```

Expected name and symbol are `Agent Teams AI` and `AGTMAI`. The genesis hash
must match the approved deployment configuration's computed hash. The manifest
lists the configured allocation recipients and amounts; check the genesis
`GenesisAllocation` events in the creation receipt against it. Current balances
can differ after transfers. A matching total supply alone does not prove
allocations, vesting or bridge backing.

### 3. Check custody and grants

For each published Safe, inspect the *current* owners, threshold and enabled
modules on that Safe, not only the configured values in the passport. The
disclosed 2-of-3 setup has one beneficial controller; three keys do not mean
three independent people. For each grant vault, compare its token, beneficiary,
original reserve, controller, terms and funded state to the published grant
manifest and on-chain balance. A founder grant is non-cancellable; a cancelled
team grant returns the unvested remainder to its originating reserve while the
vested remainder stays claimable by the beneficiary.

### 4. Check bridge backing before trusting cross-chain supply

The Ethereum bridge uses lock/release: tokens sent to Solana are locked in the
Ethereum pool, not burned. The Solana representation is minted/burned. At a
single coherent finalized observation point, compare Ethereum pool balance,
Solana mint supply, and every finalized-but-unsettled message in both
directions. In base units, the required relation is:

```text
Ethereum pool balance
  = Solana mint supply
  + pending Ethereum-to-Solana amount
  + pending Solana-to-Ethereum amount
```

The pending inventory must be complete and each source message must bind to a
unique destination receipt. If an inventory, receipt, finality proof, mint
authority, pool authority or protocol version is missing, the result is
*unknown*, not `exact`. A surplus or deficit needs investigation before any
backing claim. Check the pool owner and rebalancer powers too: the standard
LockRelease pool can allow its rebalancer to withdraw locked liquidity.

As of this draft, the mainnet bridge protocol line is **not qualified** under
[ADR-0007](../decisions/0007-mainnet-protocol-line-for-agtmai-readiness.md), and
no AGTMAI mainnet bridge canary has been proven. The published Sepolia/Devnet
round trip is testnet evidence only.

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

## Bounded production deployment slices

The production envelope, artifact preparation and offline preflight are a
feature-local extension of the existing Supply and deployment-plan boundaries.
The CLI remains static composition, filesystem and chain readers remain
technical adapters, and the disposable Anvil harness remains dev-only
composition. This does not add an Assembly graph node, adoption profile or
general deployment framework.

After the offline preflight is accepted, implementation stays limited to two
reviewable slices. The first emits one deterministic unsigned package for the
token, contributor reserve, founder reserve with its nested vault, and founder
funding call. It binds predicted addresses to genesis recipients and records
artifact, constructor, source and operation provenance. The second executes
that exact package only against the existing disposable Anvil environment and
verifies code, immutable terms, reserve balances, the nested founder vault,
permissionless founder funding, fixed supply and the 3% founder, 17%
contributors and 80% remaining allocations.

Both slices remain non-broadcasting and use one fixed topology. Mainnet forks,
generic deployment platforms, generic Solana observation tooling, utility
pricing, checkout or burn, AMM or liquidity, public sale, airdrop, DAO and legal
model work stay outside this scope. Live Safe addresses, beneficiaries, dates,
caps and rate limits remain required owner inputs and are never inferred.
