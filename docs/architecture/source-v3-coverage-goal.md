---
id: token.architecture.source-v3-coverage-goal
type: architecture
status: active
owner: architecture
summary: "Current non-Token source-v3 coverage slice: land Orchestrator fixture.lint, classify the Runtime helper test, and keep Token later."
related:
  - token.document.open-questions
  - ADR-0003
code_anchors:
  - pattern: architecture/foundation/source-dependencies.yaml
    enforcement: advisory
---

# Source v3 coverage goal

This is the canonical current-slice goal. Later work, including Token
TypeScript coverage, stays in [Open product decisions](../OPEN_QUESTIONS.md).

Snapshot date: 2026-09-12.

## Purpose

Close remaining non-Token holes in `architecture.source-dependencies`
schema v3. Do not implement Token coverage in this slice.

The gate is the declared source graph against declared allowlists. Green
CI does not mean every git file is proven, and it does not mean leftover
Foundation capabilities should be turned on.

## Ownership boundary

This document owns the current coverage slice across consumers. It does
not own tokenomics, CCIP protocol line, or Token source-graph
implementation.

Token later-work remains in `docs/OPEN_QUESTIONS.md`. Orchestrator and
Runtime changes land in those repositories.

## Invariants

- Public YAML is schema v3 with `rootPackage: true`. `includeRootPackage`
  is invalid.
- Do not green CI by dropping a governed root, pending a root silently, or
  adding an unbounded suppression.
- Do not mkdir empty leftover directories to satisfy schema v3.
- Do not invent `packageRoots` for directories that are not packages.
- Do not enable leftover Foundation capabilities: public API on private
  packages, JSON Schema families, security-baseline on non-publishers,
  protobuf, scaffolding as a config toggle, or a managed adapter on Get
  Modular.
- Conventional commits. No `agent/` branch prefix. No `--no-verify`. No
  force-push to `main`.
- No mainnet broadcast. No mainnet keys. No custom bridge, relayer, CCIP
  program, or token mechanics.
- Docs Protocol managed surfaces are not hand-edited.

## Current facts

- Token `main` already adopted source v3 (PR 8). Remaining Token
  TypeScript coverage is not launch-blocking. Later-TODO lives in
  [Open product decisions](../OPEN_QUESTIONS.md) and Token PR 9 if still
  open.
- Orchestrator `main` still leaves `tooling/lint-fixtures` outside the
  graph (13 TS/JS files). PR 65 classifies them as `fixture.lint` and
  renames `vitest-invalid.ts` to `vitest-invalid.test.ts` so Vitest oxlint
  rules fire without adding a `vitest` dependency. Local `foundation:check`
  and `check:fast` were green. CI is red: `docs:impact --strict` requires
  an update to Orchestrator `docs/architecture/repository-tooling.md`.
- Runtime has ten `runtimeReferences: dynamic` entries, all on `test.*`
  or `tooling.*`. None sit on `core.*` or `production.*`. One live file is
  still outside the graph: `scripts/build-native-helper.test.mjs`.
- Platform live roots are in the graph. Root `.markdownlint-cli2.mjs` is
  config, not product TypeScript. Do not add a `packageRoot` for it.
- Extension and Get Modular have zero live TS/JS outside `governedRoots`.
  Do not open PRs there unless a new hole is found.

## In scope

1. Land Orchestrator PR 65 after the required `architecture` job is green.
2. Classify Runtime `scripts/build-native-helper.test.mjs` and merge after
   the required `check` job is green.
3. If Token PR 9 is still open, only tighten the later-TODO. If it is
   already merged, do not open a new Token PR for this slice.

## Out of scope

- Any Token coverage implementation (`tooling/testnet-ccip`,
  `tooling/local-evm`, `scripts/rollback`, toolchain scripts,
  `tooling/security` outside `slither/src`, and similar).
- New Foundation capabilities.
- Get Modular docs-protocol `pending_classification` /
  `pending_onboarding`.
- Tightening Runtime `dynamic` on legitimate `test.*` / `tooling.*`
  boundaries.
- Invented `packageRoots` or empty directories for schema v3.

## Orchestrator work

Keep `fixture.lint`. Do not add `vitest` to `package.json`.

CI failure on PR 65:

```text
REQUIRED architecture.repository-tooling
docs/architecture/repository-tooling.md
<- scripts/architecture/source-dependencies-v3.test.mjs
<- scripts/lint/validate-lint-config.test.mjs
```

Local `check:fast` is not CI. CI runs
`pnpm docs:impact -- --base <merge-base> --strict`.

In the same Orchestrator PR, update
`docs/architecture/repository-tooling.md`:

- oxlint counterexamples live in `tooling/lint-fixtures`;
- production oxlint lanes keep them ignored;
- source v3 classifies the directory as `fixture.lint`, `development` plus
  `dynamic`, not a `packageRoot`;
- the Vitest counterexample is `*.test.ts` without a `vitest` package
  import, so focused/disabled/expect-expect remain provable.

`AGENTS.md` is not enough; docs-impact requires that architecture
document. Do not add `tooling/lint-fixtures` to
`suppression-governance.yaml` governed roots.

Prove with the same commands CI uses:

```text
pnpm docs:impact -- --base origin/main --strict
pnpm foundation:check
node --test scripts/lint/validate-lint-config.test.mjs
pnpm check:fast
```

Merge only after job `architecture` is green on the exact SHA.

## Runtime work

This is not a no-op. Add `scripts/build-native-helper.test.mjs` to
`architecture/foundation/source-dependencies.yaml`: a pointed
`governedRoot` plus a `development` boundary, or an honest extension of
`test.filesystem-custody` / `tooling.filesystem-custody.scripts` if that
is the real owner.

Do not govern all of `scripts/`. Only `architecture`, `docs`,
`foundation`, and this test sit there. Keep the allowlist narrow:
`node:assert/strict`, `node:fs`, `node:path`, `node:test`, `node:vm`.
Do not add `dynamic` without proof. Do not change `core.*` /
`production.*` or the existing ten `dynamic` entries.

Prove `pnpm foundation:check` (required job `check`) on the exact SHA.

## Token later-work

Do not implement coverage here. If Token PR 9 is still open, the
later-TODO may also name:

- `tooling/testnet-ccip` first;
- `tooling/local-evm` without painting the directory as domain;
- remaining `scripts/` except `execution-environment`, including
  rollback and `scripts/tests`;
- tails in `tooling/security` outside `slither/src`, plus extra files in
  `local-solana` and `deployment-plan`;
- a ratchet: every `tsconfig` and production `*.ts` / `*.mjs` is in
  `governedRoots` plus a boundary, or explicit `test|fixture|generated`.

When that work is picked up: `EXPECTED_TOOLING_BOUNDARIES` stays exactly
13 `tooling.*` IDs; new IDs must not use the `tooling.` prefix;
`packageRoots` stay `packages/domain` and `packages/contexts/supply`;
Solidity and Rust stay outside this gate.

## Platform, Extension, Get Modular

Re-scan the tree against `governedRoots`. If no new live TypeScript root
exists, do not open a PR. Do not classify `.markdownlint-cli2.mjs` as
architecture source.

## Done when

- Orchestrator `main` contains `fixture.lint`; job `architecture` is
  green; `docs:impact --strict` against the former merge-base is green.
- Runtime `scripts/build-native-helper.test.mjs` is in the graph; job
  `check` is green; `dynamic` on `core.*` / `production.*` is still zero.
- Token coverage is not implemented; the later-TODO remains in
  [Open product decisions](../OPEN_QUESTIONS.md).
- No leftover Foundation capability was enabled.
