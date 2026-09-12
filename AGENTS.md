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
- record irreversible architecture choices in `docs/decisions/`;
- pin dependencies, binaries, images, program artifacts, and network data;
- use decimal strings or `bigint` for CCIP selectors, never JavaScript number;
- use conventional commits and never use an AI/agent branch prefix;
- keep production code independent of test-only relay and fixtures;
- keep tokenomics proposals clearly marked as proposals until approved;
- never compile production genesis unless config is `accepted`, strictly
  validated and canonically hashed with integer bps/base units and UTC seconds;
- do not implement the CCIP pool adapter or monitor before the protocol-line ADR;
- do not market expected profit, guaranteed returns, or investment upside.

Start with:

- `README.md`
- `docs/PLAN.md`
- `docs/ARCHITECTURE.md`
- `docs/TOKENOMICS.md`
- `docs/NON_NEGOTIABLES.md`
- `docs/OPEN_QUESTIONS.md`
- `docs/STATUS.md`
- `docs/architecture/source-v3-coverage-goal.md` for the current
  source-v3 coverage slice

Documentation authoring route:

- `architecture/foundation/document-authoring.yaml` owns document types,
  placement, owners, templates, and reachability;
- `docs/README.md` is the documentation entry point and
  `docs/decisions/README.md` is the only ADR index;
- accepted `ADR-NNNN` identities already present in `docs/decisions/` are stable
  immutable history; new ADRs use the profile's `ADR-NNNN` identity;
- new documents use only the authorable `adr`, `architecture`, and
  `open-decision` types declared by that profile;
- Docs Protocol stable8 managed surfaces and qualification v2 integration are
  active. Do not hand-edit their
  package aliases, managed route block, workflow, managed state, or local
  authoring Skill; use the consumer controller for those surfaces;
- the canonical authoring profile uses Foundation profile v3 with inline owner
  allowlists for the three repository-owned document types.

Foundation `architecture.source-dependencies` is schema v3: `rootPackage: true`
and `packageRoots` for every workspace package. Required CI runs
`agent-teams-foundation check` on the installed registry package. When that
gate reports a boundary violation, fix the source rather than shrinking scope
or adding a baseline:

- forbidden domain/tooling dependency -> introduce a consumer-owned port and
  adapter; do not import filesystem, environment, or a concrete adapter into
  domain/application;
- deep import -> use the public entrypoint listed for that boundary;
- cross-package relative import -> package export or a dynamic repo-root load
  of compiled dist from a development boundary;
- new root or package -> owner, `packageRoots`/`rootPackage`, and a
  non-overlapping boundary, never an exclusion;
- `includeRootPackage` in YAML is invalid; public v3 uses `rootPackage: true`;
- CI greening by dropping a governed root, pending a root silently, or adding
  an unbounded suppression is forbidden.

Before handoff run:

```text
./dev doctor
pnpm check:changed
pnpm check:fast
pnpm check
```

For complete Linux E2E acceptance use `pnpm check:linux`, which performs
the pinned-cache preflight, the root checks above and the full rollback proof.
`pnpm check` alone is not rollback-proof evidence. Darwin's unavailable
loaded-image binding must remain fail-closed, not bypassed for a green gate.

<!-- agent-teams-docs:route/v1 begin -->
Use [.agents/skills/docs-authoring/SKILL.md](.agents/skills/docs-authoring/SKILL.md) for documentation.
<!-- agent-teams-docs:route/v1 end -->

<!-- agent-teams:quality-standard:start -->
Before planning, implementing, or reviewing changes, read and follow the
[organization Engineering Quality Standard](https://github.com/agent-teams-ai/.github/blob/main/docs/engineering-quality-standard.md).
Apply it with this repository's instructions, accepted decisions and local
adoption profiles. This reference does not change pinned architecture contracts
or certify existing code as conformant.
<!-- agent-teams:quality-standard:end -->
