# Genesis Core plan critique - 2026-08-28

## Scope and evidence

Five independent read-only critics reviewed exact commit
`853a14a54832908f1f73fbc0f923592ab86c6247` in isolated production-hosted
worktrees. Every run used `gpt-5.6-sol`, `xhigh` reasoning and fast service tier.
No worker modified the repository.

| Focus | Job ID | Verdict |
| --- | --- | --- |
| Solidity and vesting security | `agtmai-genesis-plan-security-20260828-r1` | AMEND 6.5/10 |
| Clean Architecture and ADR lifecycle | `agtmai-genesis-plan-architecture-20260828-r1` | AMEND 6.5/10 |
| Manifest, canonicalization and commitments | `agtmai-genesis-plan-manifest-20260828-r1` | AMEND 6/10 |
| macOS/Linux local environment and CI | `agtmai-genesis-plan-local-ci-20260828-r1` | AMEND 6/10 |
| MVP scope and sequencing | `agtmai-genesis-plan-mvp-20260828-r1` | AMEND 6/10 |

The job results are review evidence, not an audit and not a substitute for
tests. Findings below were accepted only after comparison with the repository
and the plan.

## Accepted corrections

### 1. Make the first milestone real

The old 12-hour block combined 3,100-5,000 lines, two contracts, manifest
compiler, Anvil, Agave, mock accounting, five CI jobs and security tooling. Its
fallback allowed partial delivery while its Definition of Done required all of
them.

The executable milestone is now `Core-12h`:

1. strict proposal/local-fixture separation;
2. deterministic local manifest and one allocation commitment;
3. immutable ERC-20 with Foundry tests;
4. isolated Anvil deployment and adversarial verifier;
5. exact-SHA Linux parity and evidence report.

Vesting, Agave/SPL, mock accounting and the expanded security matrix are
separate independently-green slices.

### 2. Do not confuse integrity with approval

A constructor can prove that its hash matches the allocations it received. It
cannot prove that those allocations were approved by the project or community.
A malicious deployer can submit a different internally consistent set.

The token therefore computes and stores only `GENESIS_ALLOCATION_HASH` in the
first slice. The documentation explicitly calls it an integrity commitment.
Official production selection later requires a separately verified approval
envelope and deployment descriptor or an approved one-shot assembler. A plain
`status: accepted` field is never treated as authorization.

The previous incomplete `GENESIS_MANIFEST_HASH` was removed from the local ABI
plan. Production full-manifest commitment waits for the final fields, Facts Pack
binding, approvers, versioning, nonce/expiry and raw golden vectors.

### 3. Specify bytes, not intentions

Allocation IDs now have an ASCII grammar and exact bytes32 padding. Sorting is
unsigned bytewise and enforced in the constructor. Addresses are compared as
20-byte values. Amounts use decimal strings at the boundary and bigint inside;
floating point is forbidden. Golden vectors commit raw ABI bytes, not only the
final hash.

YAML/JSON parsing is fail-closed for duplicate keys, aliases, merge keys, tags,
multi-document input, unknown fields and coercion. Output is content-addressed
and becomes valid only after an atomic `READY` marker, so a failed compilation
cannot leave an old deployable artifact looking current.

### 4. Keep ADR lifecycle honest

The old plan simultaneously forbade migration before ADR-0004 acceptance and
required a temporary move into `Supply`. The new slice leaves the existing
`packages/domain` bootstrap unchanged. It adds only the new manifest feature.
After ADR-0004 is accepted or rejected, the existing code moves once to the
chosen topology.

ADR-0004 now explicitly preserves ADR-0003 decisions about dependency
direction, ports, ambient effects, chain-specific adapters, value objects and
semantic DRY; only bounded-context topology is proposed for replacement.

### 5. Strengthen evidence and process isolation

The verifier receives trusted manifest/build inputs separately from deployment
output and has negative tests for forged address, ABI, build artifact,
constructor data and report. Runtime code is reconstructed from pinned
build-info rather than compared with unlinked bytecode.

Every local run owns a private temporary directory, signing key, port/lock and
exact process ID. Interrupt cleanup must not kill a neighbouring worktree. Tool
downloads use platform-specific pins, partial files, checksum verification,
atomic installation and offline fail-closed verification. A local workflow
check is not reported as a green remote CI run.

## Findings intentionally deferred or narrowed

- A signed approval envelope is a mandatory production design gate, but not
  implementation scope for a test-only local compiler.
- `NoCatchUpVesting` remains a useful next primitive. It must use SafeERC20,
  canonical-token assumptions and adversarial token tests, but it is not called
  genesis E2E until an allocation actually funds it.
- Agave and mock accounting remain useful, but cannot strengthen the Ethereum
  core if rushed into the same milestone. The future SPL fixture must disclose
  exact test mint authority and `productionAuthorityProven: false`.
- A large package catalog/topology platform and five CI jobs are not built
  before real artifacts require them. Existing Engineering Foundation gates are
  reused and extended only for demonstrated gaps.
- Several critics labelled plan/specification gaps P0. They are P0 for a future
  production path, not exploitable defects in the current repository because no
  contract or production compiler exists yet. They were still fixed before
  implementation.

## Final planning verdict

**APPROVED FOR LOCAL IMPLEMENTATION WITH THE REVISED SCOPE.**

- Confidence: 9/10
- Reliability of the planned local evidence: 9/10
- Complexity: 6/10
- Expected `Core-12h` change size: approximately 1,600-2,800 lines

This approval covers only zero-cost local work. It does not approve tokenomics,
mainnet ABI, public-network transactions, liquidity, CCIP configuration or a
security-audit claim.
