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
- do not market expected profit, guaranteed returns, or investment upside.

Start with:

- `README.md`
- `docs/PLAN.md`
- `docs/ARCHITECTURE.md`
- `docs/TOKENOMICS.md`
- `docs/OPEN_QUESTIONS.md`
- `docs/STATUS.md`

Before handoff run:

```text
./dev doctor
pnpm check:changed
pnpm check:fast
pnpm check
```
