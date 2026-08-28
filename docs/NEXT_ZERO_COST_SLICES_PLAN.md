# AGTMAI: план трёх следующих локальных zero-cost slices

Status: proposed implementation plan, 2026-08-29.

Этот документ описывает только три независимо полезных блока:

1. локальный Solana SPL fixture;
2. Ethereum deployment-cost estimator и unsigned deployment plan;
3. Slither/security matrix и Linux CI evidence.

План не утверждает токеномику, vesting, governance, signers, public liquidity,
CCIP protocol line или Mainnet deployment. Все операции используют только
локальные сети и синтетические ключи без ценности. Реальные ETH, SOL, LINK,
USDC, faucet assets, public RPC и transaction broadcast запрещены.

## 1. Цель и Definition of Done

После выполнения должны существовать три independently-green vertical slices:

- обычный SPL Token, не Token-2022, созданный на owned local Agave validator с
  decimals `9`, initial supply `0`, test-only mint authority, окончательной
  freeze authority `None`, циклом mint -> burn -> final supply `0` и
  проверяемым sanitised evidence report;
- детерминированный unsigned Ethereum deployment artifact, который связывает
  exact build/bytecode/constructor inputs с локальным gas estimate, отделяет
  стабильную identity от волатильного fee snapshot и fail-closed отклоняет
  неверную chain, artifact или превышение лимита; signing/broadcast отсутствуют;
- воспроизводимый Slither gate на exact AGTMAI artifact, version/digest pin,
  машинный отчёт, контролируемую suppression policy и отдельный Linux job;
- targeted tests каждого slice, полный root gate и GitHub CI green на одном
  exact candidate SHA;
- независимые hosted reviews, закрытые P0/P1 и повторный holistic review после
  любых исправлений.

Оценка authored changes: `1 450-2 400` строк. Generated lock/report files не
считаются целью и не должны коммититься без необходимости.

## 2. Зафиксированные границы

### 2.1 Уже принято и может кодироваться

- token identity: `Agent Teams AI / AGTMAI`;
- `9` decimals на Ethereum и Solana;
- Ethereum остаётся canonical fixed-supply chain;
- Solana fixture использует classic SPL Token Program;
- Solana fixture начинает и заканчивает с supply `0`;
- freeze authority должна стать `None` и не восстанавливаться;
- local mint authority является одноразовой test authority. Её наличие не
  доказывает production hard cap или будущую CCIP authority model;
- public networks disabled by default;
- Engineering Foundation `0.20.0` остаётся exact dev-only dependency;
- feature-module structure, Clean Architecture, SOLID, DDD и semantic DRY
  применяются без пустых ceremonial layers.

### 2.2 Нельзя решать в этих slices

- final supply и проценты allocation;
- beneficiaries, cliff, vesting, revocation или recovery;
- Safe/Squads состав и private keys;
- CCIP EVM `1.6.4` vs `2.0.0`, pool authority или live lane;
- ADR-0004 acceptance либо package migration;
- Mainnet/Devnet deploy, liquidity pool или airdrop;
- production deployment address strategy и CREATE2;
- USD price provider как источник разрешения на транзакцию.

Если реализация упирается в любой пункт выше, worker возвращает blocker, а не
выбирает правило самостоятельно.

## 3. Проверенный technical baseline

- Agave `4.2.1` является текущим stable release. Локально проверены
  `solana-test-validator 4.2.1`, `solana-cli 4.2.1` и `spl-token-cli 5.6.1`.
- macOS arm64 Agave artifact уже имеет SHA256 pin. До Linux CI добавляется
  официальный `solana-release-x86_64-unknown-linux-gnu.tar.bz2` SHA256
  `7f35f92c15861263bc540c001466678d2da228149a107b51d5b65ce497603074`.
- Slither `0.11.6` является текущим stable release. Перед добавлением gate
  выполняется compatibility preflight с solc `0.8.36` и текущим Foundry layout.
- Текущий AGTMAIToken runtime занимает `1 945` bytes. Локально измерены
  `540 495` gas для трёх allocations и `1 420 877` для предельных 32.
- Текущие root, Foundry, local-EVM и exact-SHA Linux gates уже green; новые
  slices расширяют их, а не заменяют существующее evidence.

Актуальность версии каждой добавляемой зависимости повторно проверяется по
official release непосредственно перед pin. Floating `latest`, непроверенный
installer и network fallback в CI запрещены.

## 4. Worker execution model

`Workers` в этом плане - production-hosted subscription-runtime workers, не
локальные сабагенты.

### 4.1 Model split

- planners, threat critics, specialist reviewers и final holistic reviewer:
  `gpt-5.6-sol`, reasoning `xhigh`, fast mode выключен; поле `serviceTier=fast`
  не передаётся;
- implementation/remediation workers: `gpt-5.6-sol`, reasoning `medium`, fast
  mode выключен;
- integrator остаётся основным агентом и единолично меняет shared/root wiring;
- каждый job имеет отдельный isolated worktree, job ID и scoped ownership;
- одна account identity может обслуживать параллельные jobs, если runtime это
  допускает, но workspace, job, branch и output у них всегда разные;
- network disabled для planning/review. Implementation получает только доступ,
  необходимый для pinned dependency fetch; public-chain RPC запрещён.

### 4.2 Planning wave до coding

Параллельно запускаются четыре read-only planners на одном exact draft-plan SHA:

| Planner | Проверяет | Обязательный результат |
| --- | --- | --- |
| P1 Solana | Agave/SPL lifecycle, authority semantics, isolation, JSON/RPC proof | упорядоченные шаги, edge cases, test matrix, blockers |
| P2 Ethereum deploy | creation input, EIP-1559 math, identity/quote separation, fail-closed guards | artifact schema, formulas, negative tests, forbidden broadcast paths |
| P3 Security/CI | Slither pin/compatibility, suppressions, container/supply chain, Linux job | минимальный reproducible gate и rollback |
| P4 Delivery/threat | ownership, parallelism, merge barriers, scope creep, evidence honesty | ACCEPT/AMEND/REJECT и исправления плана |

Интегратор воспроизводит существенные замечания, правит этот документ и только
после final plan review создаёт implementation briefs. План не принимается
простым голосованием.

### 4.3 Implementation ownership

После plan acceptance три workers стартуют параллельно от одного clean base SHA:

| Worker | Owned paths | Запрещённые paths | Результат |
| --- | --- | --- | --- |
| W1 Solana | `tooling/local-solana/**` | EVM contract, deployment tooling, root/CI/docs | isolated validator runner, SPL cycle, verifier, tests, report schema |
| W2 Deploy plan | `tooling/deployment-plan/**` | Solana, Solidity source, root/CI/docs | pure cost model, artifact builder, local estimator, guards, tests |
| W3 Security | `tooling/security/slither/**`, выделенный новый security workflow/job | token semantics, Solana/deployment features, root package/docs | pinned Slither execution, parser/policy, tests, Linux gate |
| Integrator | root scripts/config, toolchain lock, TS references, Foundation config, global docs | не переписывает worker feature без подтверждённого defect | dependency pins, commands, integration ledger |

Workers не меняют `package.json`, root `tsconfig`, `pnpm-lock.yaml`,
`tooling/toolchain.lock.json`, `scripts/toolchain.mjs`, общие документы или
существующие workflow jobs. Они возвращают dependency/root-wiring request в
handoff; интегратор применяет его один раз после проверки.

Branch names: `feat/local-solana-fixture`, `feat/deployment-cost-plan` и
`ci/slither-security-gate`. Префикс `codex/` запрещён. Каждый worker делает
conventional commits только в своём scope и никогда не merge-ит себя.

### 4.4 Brief/result contract

Каждый brief фиксирует `jobId`, exact `baseSha`, model/effort/no-fast profile,
owned/forbidden paths, required docs, deliverables, commands, acceptance,
non-goals и expected handoff schema.

Каждый result содержит:

```text
status = completed | blocked | failed
baseSha, commitSha, changedPaths[]
checks[{command, exitCode, evidence}]
dependencyRequests[], limitations[], residualRisks[]
```

Dirty workspace, изменение чужих paths, отсутствие scoped commit или результат
от другого base SHA запрещают интеграцию.

## 5. Slice A - local Solana SPL fixture

🎯 10/10  🛡️ 9/10  🧠 5/10. Около `700-1 100` authored lines.

### 5.1 Architecture

Создать feature-owned tooling с минимальными слоями:

```text
tooling/local-solana/
  model.ts                 # typed facts/errors/report contracts
  process.ts               # owned child lifecycle only
  rpc.ts                   # narrow JSON-RPC reads
  cli.ts                   # explicit Solana/SPL CLI adapter
  runner.ts                # application orchestration
  verifier.ts              # independent read-only verification
  evidence-report.schema.v1.json
  tests/
scripts/solana/local-fixture.ts   # thin composition entrypoint
```

Не импортировать `tooling/local-evm` как generic utility. После второго green
consumer отдельный refactor может извлечь только действительно одинаковые
process/safe-filesystem semantics.

### 5.2 Lifecycle

1. Verify exact Agave/Solana/SPL binaries and hashes before process start.
2. Create an owned mode-`0700` run directory outside tracked source. Create
   ledger, temporary config and payer/mint/owner keypairs with mode `0600`.
3. Select an owned localhost RPC/dynamic-port range. Start
   `solana-test-validator` with explicit ledger, `127.0.0.1`, reset and no
   dependency on global Solana config. Retry only pre-mutation port collision.
4. Wait for bounded RPC readiness and record version/genesis identity. Reject
   any non-localhost RPC URL.
5. Fund only the ephemeral local payer using local validator facilities.
6. Create a classic SPL Token mint with decimals `9`, initial supply `0` and
   explicit test mint authority. If freeze is initially enabled to exercise
   revocation, disable it with `authorize ... freeze --disable` before minting.
7. Create the test owner's associated token account. Mint an exact integer-safe
   test amount, read state, burn `ALL`, then read final state.
8. The independent verifier reads RPC/structured CLI JSON and proves:
   program owner is classic Token Program, decimals `9`, initial/final supply
   `0`, expected intermediate supply/balance, mint authority equals ephemeral
   test pubkey, freeze authority is `None`, and all recorded transactions belong
   to the owned local genesis.
9. Attempting to re-enable or use freeze after revocation must fail. This is a
   regression test, not only a state read.
10. Write READY-last machine JSON and concise Markdown evidence without secret
    bytes or key paths. Mark `productionAuthorityProven=false`, `ccip=false`,
    `publicNetwork=false` and `realAssetCostUsd=0`.
11. On success, failure, interrupt or timeout, terminate only the owned child,
    delete every private key and ledger, and retain only explicitly selected
    sanitised report output.

### 5.3 Required tests

- unit: strict JSON parsing, bigint/base-unit rules, wrong/missing fields,
  unexpected Token-2022 program, decimals, authority and supply;
- process: startup timeout, early exit, SIGINT/SIGTERM, owned PID cleanup and no
  neighbour kill;
- filesystem: symlink/redirection rejection, permissions and READY-last writes;
- integration: clean mint -> burn -> zero on real local validator;
- adversarial: forged CLI output is rejected by independent RPC reads; stale
  ledger/config and non-local URL fail closed;
- concurrency: two isolated runs use distinct ports/directories and finish
  without shared cleanup;
- negative authority: freeze cannot be restored after `None`;
- evidence: no seed/private key/path material in tracked or retained output.

### 5.4 Acceptance

`pnpm solana:fixture:local` must work from a clean bootstrap, cost `$0`, leave
the checkout clean, return final supply `0`, delete secrets and emit a validated
sanitised report. Linux CI repeats the same lifecycle on exact SHA.

## 6. Slice B - deployment cost estimator and unsigned plan

🎯 9/10  🛡️ 10/10  🧠 5/10. Около `350-650` authored lines.

### 6.1 Architecture

```text
tooling/deployment-plan/
  domain.ts                # bigint fee/cap rules, no RPC/filesystem
  artifact.ts              # exact Forge build/constructor identity
  rpc.ts                   # narrow estimate/fee adapter
  schema.v1.json
  builder.ts               # stable plan + volatile quote
  verify.ts                # independent checks
  tests/
scripts/deployment/estimate-local.ts
```

The domain has no wallet, signer, private key, transaction sender or generic
`execute` function.

### 6.2 Two-artifact model

Separate:

1. `deployment-plan.v1.json` - stable exact identity: chain policy, source and
   artifact digests, compiler/settings, creation bytecode hash, constructor ABI
   bytes/hash, token identity, value=`0`, deployer public address if supplied,
   `broadcastAllowed=false`;
2. `fee-quote.v1.json` - volatile snapshot: observed chain/block/time, gas
   estimate, base/priority/max fee, chosen gas buffer, expected and worst-case
   wei, optional informational USD conversion and expiry.

Changing market price must not change bytecode/constructor approval identity.
USD is display-only; all hard limits use integer wei/gas values.

### 6.3 Calculation and guards

- encode exact creation input from pinned build-info and constructor values;
- estimate against local Anvil by default. Public RPC remains disabled in this
  slice; tests use deterministic fake fee histories;
- use bigint only. Worst-case cost is `gasLimit * maxFeePerGas + value`;
- record the buffer formula explicitly and test rounding/overflow boundaries;
- reject wrong chain, absent/mismatched artifact, unexpected value, stale quote,
  zero/absurd gas, negative/malformed fee data and cost above configured cap;
- cap check occurs before any output can be marked reviewable;
- artifact contains no signed raw transaction and no method capable of sending
  `eth_sendRawTransaction` or `eth_sendTransaction`;
- independent verifier recomputes creation input and all totals from trusted
  inputs rather than trusting builder summaries.

### 6.4 Required tests

- golden current AGTMAIToken artifact and constructor vector;
- property tests for bigint formula, rounding and cap boundaries;
- tampered bytecode/build-info/ABI/constructor/deployer/chain rejection;
- EIP-1559 fee-history edge cases and stale snapshot;
- gas estimate changes only volatile quote, not stable plan identity;
- codebase scan proving broadcast RPC methods and secret inputs are absent;
- local Anvil integration estimate compared with measured Foundry gas within a
  documented tolerance; exact equality is not assumed across estimators;
- schema and independent verifier reject forged totals or `broadcastAllowed`.

### 6.5 Acceptance

The command produces a reviewable, unsigned, non-broadcastable local plan and a
separate quote. It fails before success when any exact-artifact or total-cost
guard is violated. Mainnet quoting/signing remains a later explicitly approved
slice in `OPEN_QUESTIONS.md`.

## 7. Slice C - Slither/security matrix and Linux evidence

🎯 9/10  🛡️ 9/10  🧠 5/10. Около `400-700` authored lines.

### 7.1 Preflight and pin

1. Verify official current stable Slither release again (`0.11.6` at plan time).
2. Run an isolated compatibility spike against solc `0.8.36`, Foundry `1.8.0`
   and the vendored OpenZeppelin subset.
3. Prefer the official Trail of Bits Ethereum Security Toolbox image pinned to
   an immutable dated tag and digest. Assert exact `slither --version` and
   `solc --version` inside it. If the image does not contain the required stable
   versions or lacks usable arm64/Linux parity, stop and record a blocker rather
   than float dependencies or add an unreviewed Python stack.
4. Run container with repository read-only, network disabled, tmpfs writable
   paths, no host secrets and no Docker socket mount.

### 7.2 Gate behavior

- analyse only production Solidity under `contracts/evm/src`, not test helpers;
- emit deterministic JSON plus a short human summary;
- P0/P1-equivalent high/medium findings fail the gate;
- low/informational findings remain visible and require triage, but do not
  silently become blockers;
- suppressions are exact detector/path/fingerprint records with reason, owner,
  expiry/review date and regression evidence. Broad detector disable and inline
  unexplained ignore are forbidden;
- `--warn-unused-ignores` or equivalent stale-suppression detection is enabled;
- output separates tool findings, policy decisions and environment failure;
- the existing Foundry unit/fuzz/invariant/gas-size gates remain authoritative
  complementary checks. Slither is not called an audit.

### 7.3 CI layout

Add a separate `solidity-security` Linux job after the ordinary Solidity build.
It checks out exact SHA without credentials, verifies the pinned image digest,
runs offline after pull, uploads only sanitised reports on failure and asserts a
clean checkout. A missing image/tool/version is a hard environment failure, not
an automatic pass.

Local command uses the same image/digest and config. Do not insert a large image
pull into `check:fast`; expose it through `security:solidity` and include it in
the full release/security gate.

### 7.4 Required tests

- parser/policy fixtures for high/medium/low/info and malformed output;
- detector/path/fingerprint suppression exactness and expiry;
- unused/broad suppression rejection;
- wrong image digest/version/solc fails closed;
- secrets and writable checkout are unavailable in the container;
- workflow structure test proves exact checkout, timeout, network policy,
  digest pin and clean-postcondition;
- one synthetic vulnerable contract fixture demonstrates that the gate fails;
  it never enters production source or shipped artifacts.

## 8. Integration barriers

### Barrier 0 - reviewed plan

- four planning workers completed on exact draft SHA;
- every finding has accepted/rejected/deferred rationale;
- owner confirms implementation may start;
- clean baseline commit and exact worker briefs exist.

### Barrier 1 - scoped workers

- W1/W2/W3 return scoped conventional commits from the same base;
- integrator checks changed paths, secrets, generated files and handoff evidence;
- targeted tests pass independently before any cherry-pick;
- dependency/root-wiring requests are reviewed, deduplicated and applied once.

### Barrier 2 - integrated candidate

- integrate one worker at a time with targeted checks after each;
- add root commands/toolchain pins/TS references and regenerate only necessary
  lock data;
- run Foundation, lint, TS, package, Foundry, local EVM, local Solana,
  deployment-plan and Slither gates;
- run parallel/interrupt cleanup tests;
- push candidate and obtain green GitHub CI for that exact SHA;
- freeze SHA before reviewers start.

### Barrier 3 - hosted review

Five parallel read-only reviewers use `gpt-5.6-sol xhigh`, no fast mode and
isolated clean worktrees:

1. Solana/SPL authority and lifecycle security;
2. deployment-plan math, artifact binding and broadcast absence;
3. Slither/supply-chain/CI isolation;
4. Architecture/Foundation/MVP scope;
5. holistic plan compliance and evidence honesty.

Every finding requires verdict `ACCEPT/AMEND/REJECT`, severity `P0/P1/P2`, exact
`file:line`, reproducible scenario, violated invariant, minimal fix and a test
that failed before the fix. Preferences are listed separately.

P0/P1 block completion. Accepted fixes return only to the owning worker in a
fresh remediation job. After fixes, rerun affected reviewer plus holistic review
on the new exact SHA. Old reviews never prove a changed SHA.

## 9. Failure recovery and rollback

- Worker unavailable/quota-limited: continue integration of completed scopes;
  schedule the missing isolated job on another available slot. Never merge
  workspaces or duplicate an uncertain job.
- Worker dies with dirty state: do not integrate. Use last inspected scoped
  commit or restart from clean base.
- Temporary dependency download failure: bounded retry only the unproven fetch,
  then hash/readback. No floating fallback.
- Validator/Anvil port collision: retry only before mutation with a fresh owned
  run directory. After any transaction, fail and preserve sanitised evidence.
- Uncertain GitHub push/run: read remote state with `git`/`gh` before retry.
- Security tool false positive: triage explicitly; never globally disable a
  detector to make CI green.
- Each slice is a separate conventional commit group and can be reverted without
  removing the already proven Genesis Core.

## 10. Final acceptance checklist

- no disputed tokenomics/governance/vesting decision entered production code;
- no real account, public RPC, secret or paid asset was used;
- all dependencies have exact stable version and integrity pins;
- local Solana finishes supply `0`, freeze `None`, no retained key material;
- deployment plan cannot sign or broadcast and fails above integer wei cap;
- Slither gate is reproducible, fail-closed and honestly described as static
  analysis, not an audit;
- every slice has unit, adversarial and real local integration evidence;
- Foundation and full exact-SHA CI pass;
- all accepted P0/P1 are closed with regression tests;
- final holistic hosted review returns `ACCEPT` on exact candidate SHA;
- `STATUS.md` separates proven, simulated, deferred and not-proven claims.
