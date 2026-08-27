# Agent instructions

This repository owns the Agent Teams token, cross-chain configuration,
governance tooling, transparency dashboard, and operational runbooks.

Hard rules:

- never broadcast to mainnet without a fresh explicit human approval;
- never request, store, log, or mount a mainnet seed phrase or private key;
- public networks are disabled by default and use test-only identities;
- do not write a custom bridge, relayer, CCIP program, or token mechanics;
- do not call a mocked delivery a real CCIP E2E;
- update `docs/PLAN.md` immediately when a confirmed plan error is found;
- record irreversible architecture choices only in `docs/decisions/`;
- pin dependencies, binaries, images, program artifacts, and network data;
- use decimal strings or `bigint` for CCIP selectors, never JavaScript number;
- use conventional commits and never use an AI/agent branch prefix;
- keep production code independent of test-only relay and fixtures;
- keep tokenomics proposals clearly marked as proposals until approved;
- do not market expected profit, guaranteed returns, or investment upside.

Start with:

- `README.md`
- `docs/PLAN.md`
- `docs/ARCHITECTURE.md`
- `docs/TOKENOMICS.md`
- `docs/OPEN_QUESTIONS.md`
- `docs/STATUS.md`

Documentation authoring route:

- `architecture/foundation/document-authoring.yaml` owns document types,
  placement, owners, templates, and reachability;
- `docs/README.md` is the documentation entry point and
  `docs/decisions/README.md` is the only ADR index;
- accepted `ADR-NNN` identities already present in `docs/decisions/` are stable
  immutable history; new ADRs use the profile's `ADR-NNNN` identity;
- new documents use only the authorable `adr`, `architecture`, and
  `open-decision` types declared by that profile;
- Docs Protocol stable3 v1 managed surfaces are active. Do not hand-edit its
  package aliases, managed route block, workflow, managed state, or local
  authoring Skill; use the consumer controller for those surfaces;
- `architecture/foundation/docs-protocol-rollout.yaml` records the separate
  pending v2 qualification projection and release/cohort blocker.

Before handoff run:

```text
./dev doctor
pnpm check
```

<!-- agent-teams-docs:route/v1 begin -->
Use [.agents/skills/docs-authoring/SKILL.md](.agents/skills/docs-authoring/SKILL.md) for documentation.
<!-- agent-teams-docs:route/v1 end -->
