# AGTMAI: план трёх следующих локальных zero-cost slices

Status as of 2026-09-04: NOT FULLY ACCEPTED. The 2026-08-29 local acceptance
below is historical evidence, not a green result for the current candidate.
Current code candidate `7d07a10c70fd5c898152eadccae8e3e4e5bd0ba6` includes
independently accepted toolchain and deployment fixes. Combined lint, root TS
build, deployment TS and Foundation pass; the actual Mac Anvil source checkpoint
has125pass/3Linux skips. Separate local-EVM source passes7/7 runner integration
cases, but review retained one introduced error-cause redaction P2. Its bounded
fixae60e200 now covers25focused Mac cases and awaits independent review79.
The two earlier local-EVM P2s are closed.
The recovery checkpoint remains unaccepted, including actual Darwin failures;
its failed partial writer was replaced with a fresh isolated filesystem lane.
See [the current reconciliation ledger](research/E2E-RECONCILIATION-2026-09-04.md).
Final acceptance still requires a clean exact-SHA full local/CI run and repeated
independent specialist plus holistic reviews of that same SHA.

Correction: the first Barrier 3 closure correctly proved no `P0/P1`, but it did
not prove that every explicit requirement below was implemented. The final
holistic review retained nine `P2` and six `P3`; several are direct requirements
of sections 5-8 rather than optional future hardening. Therefore the three
vertical slices remain accepted for local MVP use. The direct code gaps are now
implemented and passed the then-current complete local gate, real local Solana lifecycle, real
local EVM lifecycle and real unsigned Anvil deployment-plan test. The stronger
claim "this plan is fully accepted" remains suspended until the new exact-SHA
CI and independent reviews finish. This correction does not expand scope into
public networks, tokenomics, vesting, governance, CCIP or liquidity.

Этот документ описывает только три независимо полезных блока:

1. локальный Solana SPL fixture;
2. Ethereum deployment-cost estimator и unsigned deployment plan;
3. Slither/security matrix и Linux CI evidence.

План не утверждает токеномику, vesting, governance, signers, public liquidity,
CCIP protocol line или Mainnet deployment. Все операции используют только
локальные сети и синтетические ключи без ценности. Реальные ETH, SOL, LINK,
USDC, faucet assets, public RPC и transaction broadcast запрещены.

## Исполнительный план в трёх пунктах

1. **Зафиксировать инструменты и архитектурные границы.** Интегратор проверяет
   Agave/SPL и Slither/solc/Forge в целевых средах, фиксирует версии, checksums,
   OCI digest и расширяет Engineering Foundation на новые `tooling/**` roots.
   До green preflight coding-workers не стартуют. 🎯 10/10  🛡️ 10/10  🧠 5/10,
   около `400-700` строк конфигурации, контрактных тестов и evidence.
2. **Параллельно реализовать три независимых vertical slices.** Три hosted
   implementation-worker на `gpt-5.6-sol medium`, с режимом из раздела 4.1, работают в отдельных
   worktree и не меняют shared-файлы: W1 делает local SPL lifecycle, W2 -
   unsigned deployment plan, W3 - Slither policy/tooling. 🎯 9/10  🛡️ 9/10
   🧠 7/10, около `3 200-5 000` строк рабочего кода и тестов.
3. **Интегрировать и критиковать exact SHA.** Интегратор по одному принимает
   scoped commits, подключает root/CI wiring, получает green local и GitHub
   evidence, затем запускает четыре независимых specialist-review и только
   после их общего frozen ledger - последовательный holistic review. Все P0/P1
   исправляются отдельными remediation jobs и проверяются повторно. 🎯 9/10
   🛡️ 10/10  🧠 6/10, около `300-500` строк wiring/evidence сверх slices.

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

Реалистичная оценка authored changes: `3 900-6 200` строк. Для сравнения, уже
реализованный аналогичный local-EVM slice занимает около `2 468` строк. Generated
lock/report files не считаются целью и не должны коммититься без необходимости.
Срок около недели реалистичен только при green toolchain preflight, трёх
параллельных implementation-workers и отдельном интеграторе; acceptance нельзя
сокращать ради календаря.

## 2. Зафиксированные границы

### 2.1 Уже принято и может кодироваться

- token identity: `Agent Teams AI / AGTMAI`;
- `9` decimals на Ethereum и Solana;
- Ethereum остаётся canonical fixed-supply chain;
- Solana fixture использует classic SPL Token Program;
- Solana fixture начинает и заканчивает с supply `0`;
- freeze authority должна стать `None` и не восстанавливаться;
- local mint authority является временной test authority. До удаления run-dir
  она технически может допечатать токены, поэтому evidence не называет её
  production hard cap или будущей CCIP authority model;
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
  выполняется compatibility preflight с solc `0.8.36+commit.8a079791`, Foundry
  `1.8.0`, exact `crytic-compile` и текущим Foundry layout.
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
  `gpt-5.6-sol`, reasoning `xhigh`; по указанию пользователя от 4 сентября
  следующие jobs запускаются в fast (`serviceTier=priority`);
- implementation/remediation workers: `gpt-5.6-sol`, reasoning `medium`, fast
  включён для следующих jobs; уже работающие no-fast jobs не перезапускаются;
- integrator остаётся основным агентом и единолично меняет shared/root wiring;
- каждый job имеет отдельный isolated worktree, job ID и scoped ownership;
- одна account identity может обслуживать параллельные jobs, если runtime это
  допускает, но workspace, job, branch и output у них всегда разные;
- planning/review работают read-only с `networkAccess=restricted` и не получают
  public-chain RPC. Implementation получает сеть только для заранее разрешённой
  загрузки pinned dependencies; после проверки hashes runtime работает offline.

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

Фактически выполненная критика draft SHA и принятые изменения записаны в
[`NEXT-ZERO-COST-SLICES-PLAN-CRITIQUE-2026-08-29.md`](research/NEXT-ZERO-COST-SLICES-PLAN-CRITIQUE-2026-08-29.md).

### 4.3 Implementation ownership

После plan acceptance три workers стартуют параллельно от одного clean base SHA:

| Worker | Owned paths | Запрещённые paths | Результат |
| --- | --- | --- | --- |
| W1 Solana | `tooling/local-solana/**` | EVM contract, deployment tooling, root/CI/docs | isolated validator runner, SPL cycle, verifier, tests, report schema |
| W2 Deploy plan | `tooling/deployment-plan/**` | Solana, Solidity source, root/CI/docs | pure cost model, artifact builder, local estimator, guards, tests |
| W3 Security | `tooling/security/slither/**` | token semantics, Solana/deployment features, root package/docs и `.github/workflows/**` | pinned Slither execution, parser/policy, tests, CI wiring request |
| Integrator | root scripts/config, toolchain lock, TS references, Foundation config, global docs | не переписывает worker feature без подтверждённого defect | dependency pins, commands, integration ledger |

Workers не меняют `package.json`, root `tsconfig`, `pnpm-lock.yaml`,
`tooling/toolchain.lock.json`, `scripts/toolchain.mjs`, общие документы или
существующие workflow jobs. Они возвращают dependency/root-wiring request в
handoff; интегратор применяет его один раз после проверки.

До старта W1-W3 интегратор коммитит отдельный prerequisite SHA с green
compatibility preflight, всеми платформенными pins и расширенной Foundation
policy. Именно этот SHA становится общим `baseSha`; worker не выбирает версии
или контейнер самостоятельно.

Branch names: `feat/local-solana-fixture`, `feat/deployment-cost-plan` и
`ci/slither-security-gate`. Префикс `codex/` запрещён. Каждый worker делает
conventional commits только в своём scope и никогда не merge-ит себя.

### 4.4 Brief/result contract

Каждый brief фиксирует `jobId`, exact `baseSha`, model/effort/service-tier profile,
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

Для review-result дополнительно обязательны `reviewerJobId`, `reviewedSha`,
`reviewScope`, `authorJobIds[]` и декларация независимости. Автор, интегратор или
remediation-worker не может ревьюить собственный scope.

## 5. Slice A - local Solana SPL fixture

🎯 10/10  🛡️ 9/10  🧠 6/10. Около `1 300-2 000` authored lines.

### 5.1 Architecture

Создать feature-owned tooling с минимальными слоями:

```text
tooling/local-solana/
  src/domain/model.ts      # typed facts/errors/report contracts
  src/application/ports.ts
  src/application/runner.ts
  src/application/verifier.ts
  src/adapters/process.ts
  src/adapters/rpc.ts
  src/adapters/cli.ts
  src/composition/index.ts
  evidence-report.schema.v1.json
  tests/
scripts/solana/local-fixture.ts   # integrator-owned thin composition entrypoint
```

Foundation и локальная topology-проверка включают весь новый root. Направление
зависимостей фиксируется как `domain <- application <- adapters <- composition`:
модель и verifier не импортируют CLI/process/filesystem adapters, а composition
получает их через узкие ports. Negative fixtures доказывают запрещённые импорты.

Не импортировать `tooling/local-evm` как generic utility. После второго green
consumer отдельный refactor может извлечь только действительно одинаковые
process/safe-filesystem semantics.

### 5.2 Lifecycle

1. Bootstrap только из platform-specific lock: immutable official URL, archive
   SHA256, формат `.tar.bz2`, ожидаемые относительные binary paths, их hashes и
   exact versions для Agave/Solana и SPL CLI. Используются абсолютные binary
   paths; PATH/system/global fallback запрещён. Если SPL CLI не входит в
   проверенный Agave artifact, он получает отдельный version+integrity pin.
2. Create an owned mode-`0700` run directory outside tracked source. Create
   ledger, temporary config and payer/mint/owner keypairs with mode `0600`.
   Key generation выполняется без mnemonic/stdout leakage: child output
   удерживается в памяти, наружу проходят только allowlisted diagnostics.
3. Select an owned localhost RPC/dynamic-port range. Start
   `solana-test-validator` with explicit ledger, `127.0.0.1`, reset and no
   dependency on global Solana config. Каждая CLI/RPC операция получает exact
   loopback URL, absolute binary и allowlisted environment. Retry only
   pre-mutation port collision.
4. Wait for bounded RPC readiness and record version/genesis identity. Reject
   any non-localhost RPC URL.
5. Fund only the ephemeral local payer using local validator facilities.
6. Create a classic SPL Token mint under exact program
   `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, decimals `9`, initial supply
   `0`, explicit ephemeral mint authority and explicit ephemeral freeze
   authority. Finalize `SetAuthority(FreezeAccount, None)` before minting; эта
   transition обязательна, а не опциональна.
7. Create the test owner's associated token account. Mint an exact integer-safe
   test amount, read state, burn the exact base-unit amount, then read final
   state. После create/revoke/mint/burn ждать finalized checkpoint.
8. The independent verifier reads RPC/structured CLI JSON and proves:
   program owner is classic Token Program, decimals `9`, initial/final supply
   `0`, expected intermediate supply/balance, mint authority equals ephemeral
   test pubkey, freeze authority is `None`, and all recorded transactions belong
   to the owned local genesis. Evidence retains sanitised signatures, finalized
   slots, `meta.err`, decoded program/instruction/amount facts, state snapshots
   and genesis before/after; verifier reconstructs the lifecycle instead of
   trusting the runner summary.
9. Submit fully signed attempts to restore freeze authority and to freeze an
   account after revocation. Both must reach the classic Token program and fail;
   a local CLI validation error does not count as proof.
10. Write READY-last machine JSON and concise Markdown evidence without secret
    bytes or key paths. Mark `productionAuthorityProven=false`, `ccip=false`,
    `publicNetwork=false`, `realAssetCostUsd=0`, `mintAuthorityRevoked=false`,
    `authorityKeyRetained=false`, `remintPossibleUntilTeardown=true` and
    `productionHardCapProven=false`.
11. On success, failure, interrupt or timeout, terminate only the owned child,
    delete every private key and ledger, and retain only explicitly selected
    sanitised report output. Synchronous cleanup after `SIGKILL` is impossible:
    an owned marker/lease lets the next invocation or outer job safely reclaim a
    stale run without touching neighbouring runs.

### 5.3 Required tests

- unit: strict JSON parsing, bigint/base-unit rules, wrong/missing fields,
  unexpected Token-2022 program, decimals, authority and supply;
- bootstrap: cold/warm cache, tampered/missing/wrong archive or binary, hostile
  PATH and no network fallback after verified install;
- process: startup timeout, early exit, SIGINT/SIGTERM, owned PID cleanup and no
  neighbour kill; SIGKILL followed by safe stale-run reclamation;
- filesystem: symlink/redirection rejection, permissions and READY-last writes;
- integration: clean mint -> burn -> zero on real local validator;
- adversarial: forged CLI output is rejected by independent RPC reads; stale
  ledger/config, hostile global Solana config, decoy PATH and non-local URL fail
  closed; decoy binaries receive zero calls;
- concurrency: two isolated runs use distinct ports/directories and finish
  without shared cleanup;
- negative authority: signed restore/freeze instructions reach the Token program
  and fail after `None`;
- evidence: lifecycle reconstruction from finalized transactions; no seed,
  mnemonic, private key, secret-bearing raw error or host path in output.

### 5.4 Acceptance

`pnpm solana:fixture:local` must work from a clean bootstrap, cost `$0`, leave
the checkout clean, return final supply `0`, delete secrets and emit a validated
sanitised report. A second run must reclaim an intentionally SIGKILLed owned
fixture. Linux CI repeats the same lifecycle on exact SHA.

## 6. Slice B - deployment cost estimator and unsigned plan

🎯 9/10  🛡️ 10/10  🧠 7/10. Около `900-1 400` authored lines.

### 6.1 Architecture

```text
tooling/deployment-plan/
  src/domain/model.ts      # bigint fee/cap rules, no RPC/filesystem
  src/domain/identity.ts
  src/application/ports.ts
  src/application/builder.ts
  src/application/verifier.ts
  src/adapters/artifact.ts # exact Forge build/constructor identity
  src/adapters/rpc.ts      # narrow allowlisted estimate/fee adapter
  src/composition/index.ts
  schema.v1.json
  tests/
scripts/deployment/estimate-local.ts # integrator-owned thin composition entrypoint
```

The domain has no wallet, signer, private key, transaction sender or generic
`execute` function.

Foundation применяет к этому root то же направление
`domain <- application <- adapters <- composition`; forbidden-import fixtures
не позволяют pure cost/identity model зависеть от RPC, clock или filesystem.

### 6.2 Two-artifact model

Separate:

1. `deployment-plan.v1.json` - immutable stable identity: domain-separated
   canonical `planId`, contract FQN, build profile, source dependency closure,
   build-info/artifact/ABI/fixture digests, compiler/settings, creation bytecode
   hash, constructor ABI bytes/hash, full `creationInputHash`, chain ID, explicit
   `from`, value=`0`, cap policy and `broadcastAllowed=false`;
2. `fee-quote.v1.json` - volatile snapshot: observed chain/block/time, gas
   estimate, base/priority/max fee, chosen gas buffer, expected and worst-case
   wei, optional informational USD conversion and expiry. Quote обязательно
   содержит `planId` и `creationInputHash`; quote от другого plan отвергается.

Changing market price must not change bytecode/constructor approval identity.
USD is display-only; all hard limits use integer wei/gas values.

Доверенные основания коммитятся отдельно от builder output: chain ID `31337`,
localhost-only RPC policy, test-only maximum wei cap, exact fixture/READY digest,
contract FQN, compiler profile и source/artifact/ABI pins. Они маркируются
`testOnly=true`, `productionApproved=false`, `mainnetAllowed=false`; builder не
может сам объявить собственный output доверенным.

### 6.3 Calculation and guards

- encode exact creation input from pinned build-info and constructor values;
- estimate against local Anvil by default. Public RPC remains disabled in this
  slice; tests use deterministic fake fee histories;
- use bigint only and следующие точные формулы:
  `gasLimit = ceilDiv(gasEstimate * (10_000 + bufferBps), 10_000)`,
  `effectiveFee = min(maxFeePerGas, baseFeePerGas + maxPriorityFeePerGas)`,
  `estimatedWei = gasEstimate * effectiveFee + value`,
  `worstCaseWei = gasLimit * maxFeePerGas + value`;
- hard cap применяется к `worstCaseWei`. Проверяются uint256 bounds,
  `maxFeePerGas >= baseFeePerGas`, `maxPriorityFeePerGas <= maxFeePerGas`,
  `gasLimit >= gasEstimate` и `gasLimit <= blockGasLimit`;
- reject wrong chain, absent/mismatched artifact, unexpected value, stale quote,
  zero/absurd gas, negative/malformed fee data and cost above configured cap;
- cap check occurs before any output can be marked reviewable;
- quote freshness binds decimal block number, block hash, block timestamp,
  fee-history newest block, fixed TTL and maximum head lag. Timestamp-only
  freshness запрещена;
- RPC adapter exposes a fixed typed allowlist only: `eth_chainId`, required block
  reads, `eth_feeHistory` and `eth_estimateGas` with exact `{from,data,value}` at
  the bound block. Any other method fails before transport;
- package contains no wallet/signing dependency, private-key environment read,
  transaction CLI, signed raw transaction or send RPC method;
- independent verifier separately parses approved build inputs, encodes and
  cross-checks initcode, recomputes expected `planId`, totals and freshness, and
  performs its own allowlisted RPC reads. Builder helpers are not its authority;
- plan bundle and quote are written into a fresh owned directory, validated,
  then published transactionally with READY last. Failed runs cannot leave a
  reviewable partial bundle.

### 6.4 Required tests

- golden current AGTMAIToken artifact and constructor vector;
- property tests for exact bigint formulas, ceil rounding, uint256 overflow and
  every fee/gas relation boundary;
- tampered bytecode/build-info/ABI/constructor/deployer/chain rejection;
- mutation tests prove each plan identity input changes `planId`; golden vector
  fixes expected ID independently; swapping quotes between plans is rejected;
- EIP-1559 fee-history edge cases, reorged block hash, head lag, future block,
  exact expiry boundary and stale snapshot;
- gas estimate changes only volatile quote, not stable plan identity;
- transport/import-graph tests prove fixed RPC allowlist and absence of wallet,
  signing, secret and broadcast capabilities; string scan is defense in depth;
- local Anvil integration estimate compared with measured Foundry gas within a
  documented tolerance; exact equality is not assumed across estimators;
- schema and independent verifier reject forged totals or `broadcastAllowed`.

### 6.5 Acceptance

The command produces a reviewable, unsigned, non-broadcastable local plan and a
separate quote. It fails before success when any exact-artifact or total-cost
guard is violated. The verifier accepts only a READY-last bundle bound to its
independently expected `planId`. Mainnet quoting/signing remains a later
explicitly approved slice in `OPEN_QUESTIONS.md`.

## 7. Slice C - Slither/security matrix and Linux evidence

🎯 9/10  🛡️ 10/10  🧠 7/10. Около `1 000-1 600` authored lines.

### 7.1 Preflight and pin

1. Verify official current stable Slither release again (`0.11.6` at plan time).
2. Run an isolated compatibility spike against exact Slither, crytic-compile,
   solc `0.8.36+commit.8a079791`, Foundry `1.8.0` and the vendored OpenZeppelin
   subset. Compare normalized compiler settings and creation-bytecode identity
   with a fresh pinned-Foundry build.
3. Use official Trail of Bits Ethereum Security Toolbox
   `nightly-20260824@sha256:9c5836...82d0`, with source revision `8cad443...`,
   pinned to `linux/amd64`. The image supplies Slither `0.11.6` and
   crytic-compile `0.4.2`; its embedded Forge `1.7.1` is intentionally not used.
   Exact official project pins Forge `1.8.0` and solc
   `0.8.36+commit.8a079791` are checksum-verified and mounted read-only at fixed
   paths. The runner forces those paths and verifies all four versions before
   analysis. This preserves the official image and avoids a custom Python image.
   Any tag, digest, platform, source revision, mounted hash or version mismatch
   remains a hard blocker.
4. Run as explicit non-root UID/GID with read-only root filesystem,
   `no-new-privileges`, all capabilities dropped, bounded PID/memory/CPU/time,
   controlled HOME/tmp, environment cleared to an explicit minimal allowlist,
   network disabled, no host secrets, credentials or Docker socket.
5. Keep checkout read-only. Copy only exact tracked inputs into a fresh tmpfs
   work area; redirect Forge out/cache/build-info and Slither output to fresh
   tmpfs paths. Pass pinned solc explicitly, reuse no analysis cache, and hash
   source/config/vendor closure before and after execution.

### 7.2 Gate behavior

- check in an expected target/source-closure manifest containing AGTMAIToken and
  its vendored OpenZeppelin production imports, while excluding tests/scripts
  from policy results;
- require the exact nonzero compiled/analyzed targets, source hashes, normalized
  compiler settings and complete detector inventory. Zero/omitted targets,
  missing or unexpected detectors and broad exclude flags fail closed;
- emit deterministic JSON plus a short human summary;
- every High/Medium impact finding fails regardless of confidence;
- low/informational findings remain visible and require triage, but do not
  silently become blockers;
- suppression schema has a versioned canonical fingerprint over detector ID,
  repository-relative POSIX path, source offsets, source/snippet hash and
  normalized finding identity, plus reason, owner, expiry/review date and
  regression evidence. Matching is one-to-one after complete analysis;
  duplicate, expired, unused, unmatched or multiply matched suppressions fail;
- output separates tool findings, policy decisions and environment failure;
- the existing Foundry unit/fuzz/invariant/gas-size gates remain authoritative
  complementary checks. Slither is not called an audit.

### 7.3 CI layout

Интегратор, не W3, добавляет `solidity-security` в существующий Linux workflow с
теми же PR/push triggers, без path filter, permissive `if` или
`continue-on-error`, и с `needs: [solidity]`. Job checks out exact SHA without
credentials, verifies the pinned image digest and runs offline after pull.
Shell boundary uses fail-closed pipeline semantics. Distinct exit classes cover
clean result, policy finding, malformed output and environment failure; timeout,
cancellation, missing image/tool/report or skipped job never count as success.

Schema-valid evidence создаётся с READY last и загружается на success и failure
action-ом, pinned на полный commit SHA. Evidence содержит candidate SHA, run ID
и attempt, event/platform, image tag+digest, exact tool versions, input/config/
policy hashes, expected/observed targets, detector inventory, finding and
suppression counts, result category и exit status. Если анализ не стартовал,
создаётся минимальный environment-failure envelope. Отсутствие или ошибка
загрузки evidence блокирует acceptance.

Local command uses the same image/digest and config. Do not insert a large image
pull into `check:fast`; expose it through `security:solidity` and include it in
the full release/security gate.

### 7.4 Required tests

- parser/policy fixtures for high/medium/low/info and malformed output;
- detector/path/fingerprint suppression exactness and expiry;
- unused/broad suppression rejection;
- wrong image digest/version/solc fails closed;
- tag-only/wrong-platform pin, missing Forge/crytic-compile и любой version
  mismatch fail container-contract tests;
- read-only checkout integration ignores injected stale out/cache sentinels,
  writes only fresh tmpfs and proves unchanged input closure/postcondition;
- zero contracts, omitted AGTMAIToken/inherited source, source hash drift,
  missing/unexpected detector and every impact/confidence class fail as defined;
- suppression mutation by detector/path/range/source/finding invalidates waiver,
  while absolute worktree change does not; duplicate/broad/expired/unused fail;
- runtime probes prove non-root, zero effective capabilities, resource limits,
  absent secrets/socket and unwritable source/root filesystem;
- workflow structure test proves exact checkout, same triggers, `needs`, timeout,
  permissions, network policy, digest pin, READY-last upload on all outcomes and
  absence of skip/continue constructs;
- integration fixtures prove container failure, broken pipeline, timeout,
  image-pull failure and missing/malformed evidence all fail the job;
- one synthetic vulnerable contract fixture demonstrates that the gate fails;
  it never enters production source or shipped artifacts.

### 7.5 Acceptance

`pnpm security:solidity` must execute the exact pinned tuple on a clean checkout,
analyse the complete expected production closure and emit schema-valid evidence.
The existing GitHub workflow must invoke the same command on exact candidate SHA.
Success requires clean policy result, immutable evidence upload and unchanged
checkout; tool/policy/environment failures remain distinguishable and nonzero.

## 8. Integration barriers

### Barrier 0 - reviewed plan

- four planning workers completed on exact draft SHA using independent hosted
  jobs, `gpt-5.6-sol xhigh`, read-only and no fast mode;
- every finding has accepted/rejected/deferred rationale;
- owner confirms implementation may start;
- amended plan and critique ledger are committed on a clean SHA.

### Barrier 0.5 - toolchain and architecture prerequisite

- integrator verifies Agave/SPL cold bootstrap on macOS arm64 and Linux x64 and
  commits immutable URLs, archive/binary hashes, paths and versions;
- integrator verifies the complete official Slither/crytic-compile/solc/Forge
  container tuple, tag, `linux/amd64` digest, read-only project tool overrides
  and Foundry bytecode parity;
- all three `tooling/**` roots enter Foundation/source policy and full-scan
  paths; dependency direction and forbidden imports have negative fixtures;
- prerequisite checks pass from a clean checkout and the resulting SHA is
  frozen as the shared W1/W2/W3 base;
- if any compatibility tuple is unavailable, implementation pauses at this
  barrier instead of inventing an unreviewed fallback.

### Barrier 1 - scoped workers

- W1/W2/W3 return scoped conventional commits from the same base;
- integrator checks changed paths, secrets, generated files and handoff evidence;
- targeted tests pass independently before any cherry-pick;
- dependency/root-wiring requests are reviewed, deduplicated and applied once.

### Barrier 2 - integrated candidate

- integrate one worker at a time with targeted checks after each;
- apply one root-wiring commit per slice. A genuinely shared prerequisite must
  already exist in the Barrier 0.5 commit; commit DAG and ownership are recorded
  in the integration ledger so each slice can be independently reverted;
- add root commands/TS references and regenerate only necessary lock data;
- run Foundation, lint, TS, package, Foundry, local EVM, local Solana,
  deployment-plan and Slither gates;
- run parallel/interrupt cleanup tests;
- push candidate and obtain green GitHub CI for that exact SHA. Structural
  evidence records repository, candidate SHA, workflow, run ID, attempt, event,
  remote `head_sha` and every required job conclusion;
- freeze SHA before reviewers start.

### Barrier 3 - hosted review

Сначала четыре parallel read-only specialist reviewers используют
`gpt-5.6-sol xhigh`, fast mode согласно разделу 4.1 и isolated clean worktrees:

1. Solana/SPL authority and lifecycle security;
2. deployment-plan math, artifact binding and broadcast absence;
3. Slither/supply-chain/CI isolation;
4. Architecture/Foundation/MVP scope;

После завершения specialists интегратор замораживает единый immutable findings
ledger. Затем отдельный fifth reviewer последовательно выполняет holistic plan
compliance/evidence-honesty review на том же SHA и уже видит полный specialist
ledger. Параллельный holistic review до завершения specialists запрещён.

Reviewer job identity должна отличаться от всех author/integrator/remediation
job identities её scope. Holistic reviewer не может быть участником реализации,
интеграции или исправлений кандидата.
Речь об отдельных jobs/сессиях и авторстве кода, не об обязательных разных
subscription-аккаунтах: один разрешённый аккаунт может обслуживать эти jobs.

Every finding requires verdict `ACCEPT/AMEND/REJECT`, severity `P0/P1/P2/P3`, exact
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
- Each slice and its root/CI wiring are a separate conventional commit group.
  Integration acceptance explicitly tests revertability of each group without
  removing Genesis Core or breaking the two surviving slices.

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
- reviewer authorship and exact-SHA independence are proven in the ledger;
- `STATUS.md` separates proven, simulated, deferred and not-proven claims.
