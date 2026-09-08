---
name: docs-authoring
description: Use when creating, changing, reorganizing, or reviewing governed documentation in this repository.
---

# Documentation Authoring

Protocol: `agent-teams.docs-protocol/v1`.

## Required workflow

Run from the repository root with exact installed binaries via `pnpm exec`.
The `docs-protocol` executable is the supported alias supplied by the Docs package.

- Read current types, owners, placement, metadata, and index policy with `pnpm docs:info`.
- Search first with `pnpm exec docs-protocol find --consumer . --profile architecture/foundation/docs-protocol.yaml --text "QUERY"`.
- Reuse or relate existing authority instead of creating a competing source.
- Preview with `pnpm exec docs-protocol new --consumer . --profile architecture/foundation/docs-protocol.yaml --type TYPE --id ID --title "TITLE" --owner OWNER --summary "SUMMARY" --dry-run --json`.
- Review the exact destination, metadata, relations, anchors, diagnostics, and returned `planDigest`; retain that digest as `PLAN_DIGEST`.
- Apply identical intent with `pnpm exec docs-protocol new --consumer . --profile architecture/foundation/docs-protocol.yaml --type TYPE --id ID --title "TITLE" --owner OWNER --summary "SUMMARY" --apply --expect "$PLAN_DIGEST" --json` after review.
- When reachability is `manual-required`, insert the returned `markdownLink` into the exact returned `indexPath` before checking.
- Inspect resulting authority with `pnpm exec docs-protocol context --consumer . --profile architecture/foundation/docs-protocol.yaml --id ID`.
- Validate with `pnpm exec docs-protocol check --consumer . --profile architecture/foundation/docs-protocol.yaml`, then finish with the full consumer gate `pnpm docs:protocol:check` after the index is current.

## Consumer authority and rules

- `architecture/foundation/document-authoring.yaml` owns all allowed types, inline owner allowlists, placement, templates, and reachability.
- Only `adr`, `architecture`, and `open-decision` are authorable. Never invent owners, types, statuses, paths, or metadata outside `docs:info`.
- Accepted `ADR-NNN` records are immutable history; new ADRs use `ADR-NNNN`. Record supersession explicitly instead of silently rewriting accepted authority.
- `docs/README.md` is the documentation entry point; `docs/decisions/README.md` is the only ADR index.
- For edits, preserve canonical frontmatter and sidecar ownership; use the repository's governed review flow rather than bypassing the create-only writer.
- Keep preview and apply inputs identical, including optional relations, anchors, metadata, and destination. If authority changes or the digest is stale, preview and review again.
- Resolve required anchors and blockers before apply. Never infer that a preview reserves a path.
- Stop when recovery is required; use `pnpm docs:doctor` before `pnpm docs:recover` with the exact evidence-owning installation.
- If dependencies are absent, use only `pnpm install --frozen-lockfile`; never use npx, dlx, or latest tags. Resolve pending archive-integrity and managed Cohort gates before installation.
- Do not bypass repository scripts or hand-edit transaction evidence, managed state, receipts, or Cohort authority.
