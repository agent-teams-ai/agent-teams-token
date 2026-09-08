# Main reconciliation review, 2026-09-04

Hosted planner121 output, not owner approval or completed merge. Original
user checkout stays untouched. Source pins remain deliberate; no dependency
installation or branch-protection change has been performed.

The reconciliation should be a deliberate three-way merge of upstream `370c3aac…` into the isolated integration lineage, preserving upstream ancestry but manually resolving against the accepted integration tree. Do not cherry-pick or merge into the dirty `212b…` checkout.

## Verified baseline

- Common base: `3231e8a918c6079c8b384b5389fef2be9f25d33f`.
- Managed-docs commit: `6174b253be76d2d6af151660050e2f545bb98c50`, direct child of the common base.
- ReviewRouter commit: `370c3aac97e4b3ddc7fcc9ada762a050580d0f39`, direct child of `6174b253…`.
- Accepted implementation source: `31e909f72d5470613d8875ed9266adb482ddff85`.
- Inspected integration HEAD: `6eaec1afb65baeeee84dd93c4a767eab0bc68450`, with `31e909f…` as an ancestor.
- `31e909f… → 6eaec1a…` changes only four documentation files; all non-`docs/**` bytes are identical.
- Upstream adds exactly 26 files/changes, `+2157/-18`.
- The inspected worktree remained clean and detached at `6eaec1a…`.
- Its `origin` is a local filesystem path, not GitHub. No network or remote inference is valid from it.
- The original dirty `212b278f…` checkout was not registered in this worktree and was not accessed or changed.

The reconciliation ledger still says full original-plan acceptance is open: ongoing Slither/Solana/recovery work, real Agave/Docker qualification, complete root/CI evidence, and final specialist plus holistic reviews remain outstanding. Main reconciliation must not narrow those obligations.

## Recommended merge shape and order

When the current source lanes are stable, create a fresh isolated branch from their accepted descendant of `6eaec1a…`, record its exact SHA, and perform one no-commit three-way merge of exact upstream `370c3aac…`. Resolve it manually and finish with a conventional merge message such as `chore: reconcile upstream main automation`.

This keeps both upstream commits in ancestry and avoids reconstructing their provenance. It should happen after source-lane integration but before the final exact-SHA gates and reviews, because any later merge invalidates prior exact-head evidence.

Resolution order:

1. Freeze and hash the isolated pre-merge tree and the original checkout’s dirty inventory.
2. Import byte-exact managed surfaces from `6174b253…`.
3. Adapt consumer-owned documentation metadata and indexes to the current 28-document tree.
4. Merge package/workspace/lock configuration without changing existing pins.
5. Import both ReviewRouter workflows byte-for-byte from `370c3aac…`.
6. Reconcile Foundation changed-scan and dependency declarations.
7. Run focused documentation/dependency checks.
8. Only after every source lane is final, run the original full exact-SHA acceptance sequence.

## Exact file decisions

| Files | Decision |
|---|---|
| `.agents/skills/docs-authoring/SKILL.md` | Take exact upstream blob `506ad203…`. |
| `.github/workflows/docs-protocol.yml` | Take exact upstream blob `cfdd07fd…`; do not locally rewrite the reusable workflow or permissions. |
| `architecture/foundation/docs-consumer-integration.json` | Take exact upstream bytes. Repository ID/name and Node/pnpm ranges match the current repository. |
| `architecture/foundation/docs-protocol-managed-state.json` | Take exact upstream blob `ac493291…`; controller-owned, no hand editing. |
| `architecture/foundation/docs-protocol-qualification.json` | Take exact upstream bytes. |
| `architecture/foundation/docs-protocol.yaml` | Take exact upstream bytes. |
| `.github/workflows/reviewrouter-codex.yml` | Take exact `370c3aac…` blob `f17cffb2…`. |
| `.github/workflows/reviewrouter-interaction.yml` | Take exact `370c3aac…` blob `f909892f…`. Do not disable or locally “harden” the managed workflow. |
| `.gitignore` | Semantic union: preserve all current ignores and add `.agent-teams-local/`. |
| `.node-version` | Preserve `24.20.0`; upstream differs only in terminal whitespace. |
| `AGENTS.md` | Preserve every current hard rule/start/handoff command. Add the upstream documentation-authoring section and exact managed route block. Keep `docs/decisions/` as the ADR authority. |
| `README.md` | Preserve the current stack/state links, including `docs/DECISIONS.md`; add links to `docs/README.md` and `docs/decisions/README.md`. |
| `docs/PLAN.md` | Keep the current integration version. Do not replay stale upstream changes based on the common-base plan. Current `docs/DECISIONS.md` is a valid register pointing to the ADR index. |
| `docs/STATUS.md` | Keep current evidence. Do not import upstream’s obsolete “ten documents proven” claim. Add new proof only after the reconciled docs gate actually passes. |
| `docs/decisions/README.md` | Preserve the current four-digit ADR list and proposed ADR-0004. Add protocol-compatible index frontmatter; never restore the deleted `ADR-001/002` paths. |
| Existing `docs/decisions/0001…0004.md` | No byte changes. Keep `architecture/decisions/accepted-decisions.json` and its immutable digests unchanged. |
| `docs/README.md` | Start from upstream, then expand navigation to the current plans, contracts, invariants, decision register, and research/evidence documents. |
| `docs/document-metadata.schema.json` | Take exact upstream schema. It already permits four-digit ADR IDs and the needed document types. |
| `docs/document-metadata.yaml` | Rebuild semantically for every current non-template document: 27 sidecar entries after the two indexes carry frontmatter. Use current four-digit ADR paths and include all research ledgers; remove the obsolete uppercase `ADR-001/002` paths. |
| `docs/owners.yaml` | Take exact upstream owner catalog. |
| `architecture/foundation/document-authoring.yaml` | Preserve its functional upstream profile, but correct the obsolete comment claiming current accepted ADRs use three-digit IDs. Creation remains four-digit and create-only. |
| `docs/templates/adr.md` | Preserve the template structure but correct the obsolete three-digit-history statement. New ADRs remain `ADR-NNNN`. |
| `docs/templates/architecture.md`, `docs/templates/open-decision.md` | Take exact upstream bytes. |
| `package.json` | Keep all current scripts and pins. Add the seven exact `docs:*` aliases, exact dev dependency `@agent-teams/docs-protocol: 0.2.0`, and place `pnpm docs:protocol:check` at the front of the current full `check` chain. |
| `pnpm-workspace.yaml` | Preserve strict catalogs, `autoInstallPeers: false`, all current catalog pins and workspace roots. Add only `@agent-teams/docs-protocol@0.2.0` to `minimumReleaseAgeExclude`. |
| `pnpm-lock.yaml` | Do not take the upstream lock wholesale: it records `autoInstallPeers: true` and lacks current workspace/catalog entries. Preserve the current lock and add only the docs-protocol root importer, package record, and snapshot from upstream. |
| `.npmrc` | Leave unchanged. Its package-manager strictness and registry authority are deliberate. |
| `architecture/foundation/dependency-declarations.yaml` | Add `@agent-teams/docs-protocol` beside Foundation under exact registry development-only packages. |
| `architecture/foundation/repository-agent-workflow.yaml` | Add `docs`, `AGENTS.md`, `README.md`, and the local docs-authoring skill to full-scan routing. Existing `.github/workflows`, package, lock, and Foundation paths already trigger full scans. |
| `foundation.config.yaml`, current CI, production source | No semantic change required. |

No files under `contracts/**`, `packages/**`, `scripts/**`, `tooling/**`, `config/**`, `compose.yaml`, or TypeScript configuration should change as part of this reconciliation.

## Dependency and lifecycle compatibility

Compatibility is direct:

- Current and upstream both select Node `24.20.0`.
- Both require Node `>=24.18.0 <25`.
- Both select pnpm `11.24.0`; docs protocol allows `>=11.17.0 <12`.
- Both pin Engineering Foundation `0.20.0` with integrity  
  `sha512-YGyNyfpxyElMUALIho+pi+xM9XHXWWEV5hBBEzcysaCO1Dgz5/3GuUjQ6fQM2sCjfPo7Pd6OoFJOSKiHaqe5ZA==`.
- Docs Protocol remains exactly `0.2.0`, integrity  
  `sha512-KtmILYJTQf91wU643UMRh5QuO2Jnbn5f/kBD6e3agUIWv0KpuxHqEyZZPLsp0jiTA1WV4TBJa4EyFDT0Ju1/KQ==`.
- Its recorded dependencies—Foundation, Ajv, Ajv formats, `jsonc-parser`, and YAML—already exist at the necessary versions in the current lock. No upgrade or “latest” resolution is needed.

The lock marks Docs Protocol as a binary package and does not mark it `requiresBuild`, but lock metadata alone does not prove absence of `preinstall`, `install`, `postinstall`, or `prepare` hooks. Before any authorized installation, authenticate the exact tarball against the pinned integrity and inspect its manifest. Confirm there is no repository `.pnpmfile` authority and use only pinned pnpm `11.24.0`, frozen/offline. No install was performed here.

Configuration ownership must remain:

- Controller-owned: managed state, docs workflow, generated skill, managed AGENTS route block, and exact package aliases/pin.
- Consumer-owned: metadata sidecar, owner assignments, document indexes, authoring profile, and templates.
- Accepted ADR bodies: immutable.
- Recovery commands: only after an actual protocol recovery condition, not as a routine merge step.

## CI permissions and evidence semantics

The workflows do not broaden permissions of the existing `CI` workflow.

- Documentation Protocol adds `contents: read` and `id-token=[redacted:token-field] to its separate reusable-workflow caller, pinned to `agent-teams-ai/.github` revision `07d49409cb51f6124ad17673860b812a9d7b5f5b`.
- ReviewRouter has top-level `permissions: {}` and job-scoped permissions:
  - review: contents/read, pull-requests/read, OIDC write;
  - refresh: OIDC write;
  - interaction: contents/read, issues/read, pull-requests/read, OIDC write.
- Its reusable runtime and checkout actions are full-SHA pinned.
- `reviewrouter-interaction.yml` installs exact Codex `0.144.0` conditionally, but the npm artifact integrity is not recorded in-repository. Preserve the upstream managed file; do not execute it or create a local bypass. Treat its external supply-chain/credential operation as managed ReviewRouter risk, not evidence for the E2E plan.
- No secret contents should be inspected, requested, logged, or copied. The repository only gains secret names.

Branch/evidence treatment:

- The existing six `CI` jobs remain required original-plan evidence.
- Documentation Protocol should be an additional exact-head required check once its real emitted status-context name is observed.
- ReviewRouter must not be counted as an original-plan acceptance reviewer or mandatory protection check. It is conditional, skips bot/fork/draft cases, lacks `merge_group`, and depends on external credentials/service state.
- ReviewRouter interaction/refresh jobs are never merge gates.
- If merge queue is enabled, owner action is required: Documentation Protocol handles `merge_group`, while current `CI` does not. Requiring current CI in a merge queue without adding that trigger would deadlock the queue.
- The final ledger must record repository, candidate SHA, workflow, run ID, attempt, event, remote `head_sha`, and each required job conclusion for both CI and Documentation Protocol. ReviewRouter output remains advisory.

## Minimal undischarged gates

Before creating the merge commit:

1. Confirm the actual left parent still descends from `6eaec1a…`; rerun the conflict inventory if active lanes touched shared files.
2. Record the original `212b…` checkout HEAD and a hash of its NUL-delimited dirty inventory, then prove both unchanged afterwards.
3. Verify the post-resolution changed-path allowlist and unchanged accepted ADR/source bytes.
4. Compare the five byte-exact managed-doc artifacts to `6174b253…` and both ReviewRouter blobs to `370c3aac…`.
5. Confirm the lock retains `autoInstallPeers: false`, all current catalogs/importers, and only the expected Docs Protocol records are added.
6. Run syntax/link/static checks and `git diff --check`.

After dependency installation is separately authorized:

1. Authenticate and inspect the Docs Protocol archive; perform only pinned frozen/offline installation.
2. Run `pnpm docs:info`, resolve the complete current catalog, then `pnpm docs:protocol:check`.
3. Run Foundation dev-only/registry/full checks and the lock/advisory/license security check.
4. Run the mandated handoff gates on the final tree:

   - `./dev doctor`
   - `pnpm check:changed`
   - `pnpm check:fast`
   - `pnpm check`

5. Preserve the original E2E obligations: real current-source Agave, Anvil/deployment, Slither/Docker and recovery acceptance; then exact-head CI plus Documentation Protocol.
6. Freeze that SHA, run all four original specialist reviews, freeze their ledger, and only then run the independent holistic review. ReviewRouter cannot substitute for any of these.

## Owner decisions that remain material

Two policy points cannot safely be invented:

1. The current repository has 28 Markdown documents versus upstream’s catalog of ten. Nineteen additional plans, policies, reviews, and ledgers need authoritative `type/status/owner` metadata. The likely grouping is product for plans/status/registers, architecture for contracts/topology/baseline, security for non-negotiables/code-review/audit ledgers, and tokenomics for tokenomics research—but the owner must ratify that map through the Docs Protocol workflow. Excluding `docs/research` to make the gate pass is not acceptable.
2. The owner must decide branch-protection/merge-queue configuration after observing real check-context names. Recommended: require the six existing CI jobs and Documentation Protocol; keep ReviewRouter advisory. Any decision to require ReviewRouter or activate its credential-dependent interaction path needs explicit policy approval, not a repository-side workaround.

No code, documentation, lockfile, Git state, dependency installation, credential, workflow, network, or runtime state was changed. Read-only planning completed in approximately 5 minutes 41 seconds.
