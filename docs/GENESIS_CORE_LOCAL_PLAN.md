# AGTMAI Genesis Core: подробный план локальной реализации

**Дата:** 28 августа 2026 года
**Статус:** готов к реализации после внутренней архитектурной проверки;
hosted-критика ожидает восстановления subscription runtime; реализация ещё не
начата
**Цель первого блока:** за один автономный рабочий цикл получить проверяемое
локальное ядро токена AGTMAI без газа, mainnet-ключей, публичных транзакций и
необратимого утверждения спорной токеномики.

Этот документ конкретизирует первый технический блок из
[`PLAN.md`](PLAN.md). Общий план проекта остаётся источником долгосрочного
направления, а этот документ является исполнимым контрактом именно для локального
Genesis Core.

---

# 1. Результат блока

После завершения должны существовать и проходить проверки:

1. Строгий TypeScript-компилятор конфигурации токена в канонический локальный
   genesis manifest.
2. Неизменяемый Ethereum ERC-20 `Agent Teams AI / AGTMAI` с 9 decimals и одним
   выпуском фиксированного supply в constructor.
3. Самостоятельный `NoCatchUpVesting`, который до cliff выдаёт ноль, а после
   cliff начинает линейное начисление с нуля без разовой большой разблокировки.
4. Локальный deployment на Anvil с синтетическими, не имеющими ценности
   адресами и отдельным read-only verifier.
5. Золотой вектор manifest commitment, одинаково вычисляемый TypeScript и
   Solidity.
6. Локальный SPL Token fixture на Agave: 9 decimals, initial supply 0, freeze
   authority отсутствует.
7. Детерминированная симуляция Ethereum -> Solana -> Ethereum accounting,
   явно помеченная как mock, а не настоящий Chainlink CCIP E2E.
8. Native macOS arm64 feedback loop и воспроизводимые Linux CI jobs.
9. Отчёт, в котором разделены реально выполненные проверки, симуляции, mocks,
   ограничения и следующие решения владельца.

Обязательный Ethereum/manifest vertical slice оценивается в `2 200-3 500` строк.
Local Solana fixture и mock accounting добавят примерно `900-1 500`. Ожидаемый
итог: `3 100-5 000` строк production-кода, тестов, fixtures, CI и документации.
Это ориентир, а не цель по количеству строк: ненужные абстракции ради объёма
запрещены.

---

# 2. Что намеренно не входит

В первый блок не входят:

- mainnet, Sepolia или Solana Devnet broadcast;
- реальные ETH, SOL, LINK, USDC или газ;
- private keys, seed phrases, Safe или Squads владельцев;
- окончательное утверждение `100 000 000` или распределения `45/25/15/8/6/1`;
- сложные Community, Operations, Grants, Liquidity policy vaults;
- голосование, Governor, VoteEscrow, совет из 5-7 участников;
- Chainlink pool adapter, registration или реальный CCIP delivery;
- Raydium/Orca pool и любые покупки testnet assets;
- frontend, публичный dashboard и production monitor;
- прокси, upgradeability, mint после genesis, pause, blacklist, tax, rebase,
  staking, yield, arbitrary call или generic treasury executor;
- принятие ADR-0004 от имени владельца.

Код первого блока не объявляется audited, mainnet-ready или официальным
контрактом запуска. Он создаёт проверяемую основу, но не обходит открытые
продуктовые, юридические и управленческие решения.

---

# 3. Зафиксированные и открытые решения

## 3.1 Зафиксировано для локального ядра

- Название: `Agent Teams AI`.
- Symbol: `AGTMAI`.
- Canonical chain в целевой архитектуре: Ethereum.
- Trading/remote chain в целевой архитектуре: Solana.
- Decimals: `9` на обеих сетях.
- Ethereum supply создаётся один раз, функции дополнительного mint нет.
- Solana local fixture стартует с supply `0`.
- Ethereum token не имеет owner, proxy, pause, blacklist, transfer tax или
  скрытых административных функций.
- Chainlink остаётся внешним transport layer и не наследуется основным ERC-20.
- Все локальные ключи одноразовые и не имеют ценности.
- Любой public-network broadcast выключен по умолчанию и не входит в блок.

## 3.2 Остаётся proposal и не зашивается как production truth

- Total supply `100 000 000`.
- Allocation `45/25/15/8/6/1`.
- Founder максимум 3% и team максимум 3% внутри contributors.
- Founder schedule 18 -> 72 месяца и team 12 -> 60 месяцев.
- Контроллеры, signers, timelocks и governance activation.
- Разделение liquidity allocation на `0.1% + 0.9%`.
- Публичный airdrop, pool ratio, rate limits и launch jurisdictions.

Для тестов используется отдельный локальный fixture со статусом `test-only` и
очевидными test-only адресами. Слово `accepted` для него не используется, чтобы
не путать тестовое подтверждение со способом принятия настоящей токеномики. Он
не меняет статус `config/tokenomics.proposal.yaml` и не может быть передан
production-компилятору.

---

# 4. Архитектурные правила

## 4.1 Источники архитектуры

Используются два разных, дополняющих друг друга источника:

1. `@agent-teams/engineering-foundation` версии `0.19.0` - точная dev-only
   зависимость для механических проверок репозитория.
2. Agent Teams Orchestrator
   `docs/architecture/feature-module-standard.md` в редакции commit
   `81e6946bd4161b30e456965f09bcb7969ecd3cbb` - стандарт структуры feature
   modules и ответственности слоёв.

Engineering Foundation не импортируется production-кодом и не становится
runtime framework. Его опубликованный scaffolding в `0.19.0` пока не содержит
квалифицированного product recipe для этого репозитория, поэтому нельзя
притворяться, что Foundation автоматически создаст наши feature modules.
Структура создаётся локально, а Foundation проверяет применимые границы,
зависимости, документы, ADR, suppressions и quality gates.

## 4.2 Feature ownership

Каждый production artifact живёт внутри реальной capability:

```text
contracts/evm/src/features/token-genesis/
contracts/evm/src/features/no-catch-up-vesting/

packages/contexts/supply/src/features/genesis-manifest/
packages/contexts/supply/src/features/supply-reconciliation/
```

Почему TypeScript временно находится в `Supply`: ADR-0003 принят и остаётся
архитектурным источником истины. ADR-0004 с `Token Control` и `Cross-chain
Accounting` предложен, но не утверждён владельцем. Первый блок не имеет права
молча принять его. Если ADR-0004 будет принят позже, эти две feature slices
переносятся без изменения публичных contracts и domain semantics.

Запрещено создавать пустые `domain/application/adapters/composition` директории.
Слой появляется только с первым реальным артефактом.

## 4.3 Clean Architecture, DDD и SOLID без церемоний

- Domain содержит только детерминированные значения, правила и ошибки.
- Application координирует use cases и зависит от узких ports.
- YAML, filesystem, CLI, RPC и процессы Anvil/Agave являются adapters.
- Composition выбирает конкретные adapters и не содержит бизнес-правил.
- Один класс или модуль имеет одну причину изменения.
- Интерфейсы разделены по операциям чтения, компиляции, записи и проверки.
- Domain не зависит от `viem`, YAML parser, Node filesystem, RPC или Foundation.
- EVM и Solana не объединяются в универсальный `ChainClient`.
- Общий `shared`, `common`, `utils`, `services` или `infrastructure` запрещён.
- DRY применяется к одинаковой семантике, а не к внешне похожим EVM/Solana API.
- Абстракция извлекается после второго реального consumer или доказанной
  заменяемости, не заранее.

## 4.4 Предлагаемая структура первого блока

```text
contracts/evm/
  foundry.toml
  remappings.txt
  src/features/token-genesis/
    AGTMAIToken.sol
    README.md
  src/features/no-catch-up-vesting/
    NoCatchUpVesting.sol
    README.md
  script/features/local-genesis/
    DeployLocalGenesis.s.sol
  test/features/token-genesis/
  test/features/no-catch-up-vesting/
  test/features/manifest-commitment/

packages/contexts/supply/
  package.json
  tsconfig.json
  src/features/genesis-manifest/
    domain/
    application/
    adapters/
    composition/
    README.md
  src/features/supply-reconciliation/
  src/index.ts
  tests/features/genesis-manifest/
  tests/package/

tooling/local-solana/
  fixtures/
  scripts/

config/genesis/
  proposal.schema.json
  manifest.schema.json
  local.fixture.yaml

reports/local/
  .gitkeep only if reports are intentionally versioned; otherwise generated
  reports stay gitignored
```

Точные поддиректории создаются только при наличии файлов. Если use case не
требует отдельного application layer, он не создаётся ради картинки.

---

# 5. Manifest contract

## 5.1 Два разных типа входа

Нельзя использовать один флаг для превращения proposal в production input.
Нужны разные discriminated schemas:

```text
TokenomicsProposal
  purpose = proposal
  status = proposal
  human-readable percentages and unresolved decisions allowed
  deployable output forbidden

GenesisManifestSource
  purpose = local-fixture, status = test-only
  или purpose = production, status = accepted
  integer base units, bps and UTC seconds only
  every required field resolved
```

Production-команда принимает только `purpose=production`, `status=accepted`,
целевую сеть Ethereum mainnet и полный набор обязательных decision references.
Local-команда принимает только `purpose=local-fixture`, `status=test-only`,
chain ID `31337` и явные test-only addresses. Подмена target, status или purpose
приводит к ошибке до создания deployment artifact.

## 5.2 Числовая модель

- Token amounts: canonical decimal strings на входе, `bigint` в domain,
  base-unit decimal strings в JSON artifact.
- Percentages/caps: только integer basis points.
- Chain ID и CCIP selectors: decimal strings или `bigint`, никогда JavaScript
  `number`.
- Timestamps: целые UTC seconds.
- Calendar months допустимы только в proposal/reporting layer. Перед accepted
  manifest они компилируются в точные timestamps с явно проверенным правилом
  month-end clamping.
- YAML floats, scientific notation, negative zero, whitespace-dependent числа,
  duplicate YAML keys и неизвестные fields отклоняются.

## 5.3 Семантическая валидация

Компилятор проверяет:

- schema version поддерживается;
- name/symbol/decimals совпадают с ожидаемым profile;
- total supply положительный и не превышает выбранные integer limits;
- сумма allocations равна total supply точно в base units;
- allocation ID не пуст, уникален и стабильно отсортирован;
- recipient не zero address и уникален для genesis bucket;
- amount каждого bucket больше нуля;
- schedule либо отсутствует, либо `end > cliff >= start` согласно типу;
- local fixture содержит только allowlisted test addresses;
- production input не содержит placeholders, unresolved decisions или test IDs;
- hash/code references имеют правильную длину и encoding;
- output path не может перезаписать source config.

Validation собирает все независимые diagnostics, но compiler fail-closed: при
одной ошибке deployable manifest и hash не создаются.

## 5.4 Два канонических commitments

Один opaque manifest hash недостаточен: deployment script мог бы передать hash
одного файла, а токену - allocations из другого. Поэтому определяются два
разных typed commitments.

`GENESIS_ALLOCATION_HASH` вычисляет сам token constructor и сравнивает с
ожидаемым значением до первого mint:

```text
keccak256(abi.encode(
  bytes32("AGTMAI_ALLOCATION_V1"),
  uint256(block.chainid),
  bytes32(keccak256("Agent Teams AI")),
  bytes32(keccak256("AGTMAI")),
  uint8(9),
  uint256(initialSupply),
  tuple(bytes32 id,address recipient,uint256 amount)[] allocations
))
```

Это связывает chain, identity, supply и реально переданный constructor array.
Wrong-chain deployment или подмена bucket вызывает constructor revert.

`GENESIS_MANIFEST_HASH` связывает полный внешний manifest:

```text
keccak256(abi.encode(
  bytes32("AGTMAI_MANIFEST_V1"),
  bytes32 environmentId,
  uint256 chainId,
  bytes32 tokenNameHash,
  bytes32 tokenSymbolHash,
  uint8 decimals,
  uint256 totalSupplyBaseUnits,
  tuple(
    bytes32 id,
    address recipient,
    uint256 amountBaseUnits,
    uint8 releaseKind,
    uint64 cliffUtc,
    uint64 endUtc,
    address beneficiary,
    bytes32 expectedCodeHash
  )[] allocations
))
```

Token хранит full manifest hash, но не делает вид, что способен проверить
schedule или code hash внешнего recipient. Verifier проецирует manifest в token
allocations, сравнивает оба hashes и независимо читает recipient code/state.

TypeScript использует проверенную ABI-библиотеку с exact pin. Solidity tests
вычисляют оба payload независимо. Golden vectors содержат вход, encoded bytes и
expected hashes. Любое изменение field order, type width, sorting или encoding
ломает тест до deployment.

Human-readable JSON получает фиксированный formatter и собственный SHA-256 для
artifact integrity. `GENESIS_ALLOCATION_HASH`, `GENESIS_MANIFEST_HASH` и artifact
SHA-256 имеют разные имена и никогда не смешиваются в UI или документации.

---

# 6. Ethereum contracts

## 6.1 `AGTMAIToken`

Контракт наследует только актуальный стабильный OpenZeppelin `ERC20` из exact
pinned release, подтверждённого перед установкой. Solidity compiler и EVM target
фиксируются после короткой совместимости OpenZeppelin + Foundry. Chainlink
dependency в этом контракте отсутствует.

Публичные свойства:

```text
name() = Agent Teams AI
symbol() = AGTMAI
decimals() = 9
INITIAL_SUPPLY = immutable constructor/profile supply
GENESIS_ALLOCATION_HASH = constructor-verified commitment
GENESIS_MANIFEST_HASH = immutable commitment
```

Constructor принимает `initialSupply`, оба expected commitments и список с
максимумом `MAX_GENESIS_ALLOCATIONS = 32`:

```text
Allocation {
  bytes32 id;
  address recipient;
  uint256 amount;
}
```

Constructor обязан:

- отклонить zero manifest hash;
- отклонить zero allocation hash;
- отклонить пустой список и список длиннее `32`;
- отклонить zero/duplicate allocation ID;
- отклонить zero/duplicate recipient;
- отклонить zero amount;
- проверить сумму без потери точности;
- требовать точного равенства суммы `initialSupply`;
- пересчитать allocation commitment с `block.chainid` и отклонить mismatch до
  первого mint;
- mint каждый bucket сразу его final recipient;
- emit отдельное `GenesisAllocation(id, recipient, amount)`;
- завершиться без баланса у deployer/factory, если они не являются явно
  объявленным allocation recipient.

После constructor отсутствуют:

- `mint`, `burnFrom`, owner/admin role;
- pause/blacklist/tax/fee/rebase;
- arbitrary call/approve;
- proxy initializer или upgrade hook;
- CCIP-specific inheritance.

`getCCIPAdmin()` не добавляется вслепую. Его ABI зависит от выбранного
registration flow и будет решён protocol-line ADR до CCIP adapter. Это означает,
что локальный контракт является candidate core, а не замороженным mainnet ABI.

## 6.2 `NoCatchUpVesting`

Immutable constructor parameters:

```text
token
beneficiary
allocationAmount
cliffUtc
endUtc
```

Инварианты:

- `token != 0`, `beneficiary != 0`, `allocationAmount > 0`;
- `endUtc > cliffUtc`;
- vested равно `0` при `t <= cliffUtc`;
- vested равно `allocationAmount` при `t >= endUtc`;
- между ними:
  `Math.mulDiv(allocationAmount, t - cliffUtc, endUtc - cliffUtc)` с округлением
  вниз и без промежуточного overflow;
- `released <= vested <= allocationAmount`;
- vested монотонно не убывает;
- donation не увеличивает allocationAmount или releasable;
- beneficiary нельзя заменить;
- revoke, owner, upgrade и arbitrary call отсутствуют в базовом контракте;
- вызвать release может любой адрес, но получателем всегда является immutable
  beneficiary;
- state обновляется до ERC-20 transfer;
- release при нулевом releasable отклоняется custom error
  `NothingToRelease()`.

Лишние AGTMAI, случайно отправленные в vesting, не увеличивают entitlement и не
имеют admin rescue path: они остаются заблокированы. Это сознательная fail-closed
цена отсутствия скрытой withdrawal authority; verifier/monitor позднее обязан
сигнализировать о surplus.

Revocable team grants не добавляются в этот контракт: это отдельная будущая
feature с другим trust model. Founder/local non-revocable primitive остаётся
простым и проверяемым.

## 6.3 Почему wiring allocations не финализируется ночью

Token и vesting реализуются и тестируются как самостоятельные primitives.
Local token deploy использует детерминированные test recipients. Полная atomic
схема `GenesisAssembler`, CREATE2 адреса и binding всех будущих vaults не
утверждается, пока не определены сами vaults и activation rules.

Это исключает опасный временный production treasury, но не создаёт сложную
factory до того, как известны реальные consumers. Перед mainnet будет отдельный
ADR: direct constructor recipients, one-shot assembler или другая доказанная
atomic схема.

---

# 7. Пошаговая реализация

## Phase A - безопасный baseline

1. Создать ветку по правилам проекта от текущего research baseline.
2. Зафиксировать начальный commit SHA и убедиться, что нет чужих изменений.
3. Выполнить `./dev doctor`, Foundation static gates и текущий полный `pnpm check`.
4. Перепроверить официальные stable releases перед добавлением зависимостей.
5. Зафиксировать exact versions, source URLs, release tag/commit и checksums.
6. Обновить lockfile только пакетным менеджером.
7. Не использовать dirty checkout `engineering-foundation`; consumer зависит
   только от registry package `0.19.0`.

Stop condition: baseline red по причине существующего проекта документируется;
новые изменения не маскируют его.

## Phase B - mechanical architecture gates

1. Материализовать только принятый ADR-0003 `Supply` package и первые реальные
   feature files.
2. Атомарно перенести существующий `packages/domain/src/supply.ts` с тестом в
   `packages/contexts/supply/src/features/supply-reconciliation/`, доказать
   parity и удалить старый generic package в том же structural commit. Два
   источника одной supply semantics одновременно не сохраняются.
3. Расширить pnpm workspace pattern для `packages/contexts/*`.
4. Добавить package catalog и token-local topology validator, если текущей
   Foundation capability недостаточно для `src/features/*` правила.
5. Default-deny source policy разрешает только фактические edges.
6. Запретить production imports из adapters в domain и deep imports между
   features.
7. Запретить broad shared/common/utils/services/infrastructure paths.
8. Добавить negative fixtures: misplaced source, deep import, cycle, empty
   ceremonial layer, missing feature README.
9. Package exports публикуют только curated entrypoint.
10. Добавить declaration и packed-consumer tests при первом публичном export.

Rollback: весь structural gate находится в отдельном commit и может быть
отменён без изменения contract semantics.

## Phase C - strict manifest vertical slice

1. Добавить proposal/local-source/manifest JSON Schemas.
2. Реализовать strict YAML adapter с duplicate-key rejection.
3. Реализовать domain value objects для base units, bps, UTC seconds,
   allocation ID и EVM address.
4. Реализовать semantic validator и diagnostic codes.
5. Реализовать deterministic ordering.
6. Реализовать ABI commitment builder.
7. Реализовать commands `validate`, `compile-local`, `inspect`.
8. Production command либо отсутствует, либо всегда fail-closed до появления
   accepted production config и отдельного release gate.
9. Сгенерировать local artifact только из `status=test-only` в gitignored build
   directory.
10. Проверить, что proposal не создаёт deployable artifact.

## Phase D - Solidity primitives

1. Инициализировать Foundry project внутри `contracts/evm`.
2. Pin OpenZeppelin по точному release commit.
3. Реализовать `AGTMAIToken` с минимальным ABI.
4. Реализовать `NoCatchUpVesting`.
5. Добавить custom errors и events без строковых revert reasons, где это
   уменьшает bytecode и не ухудшает ясность.
6. Не создавать base vault hierarchy и generic treasury abstraction.
7. Сохранить ABI snapshots, compiler settings и compiler-aware deployed-code
   identity в local artifacts. Простой hash unlinked bytecode не выдавать за
   hash кода с embedded immutables.

## Phase E - tests and adversarial properties

Token tests:

- exact name/symbol/decimals/supply и оба hashes;
- constructor recomputes allocation hash and rejects wrong chain/hash;
- каждый constructor rejection path;
- unique IDs/recipients;
- exact allocation events and balances;
- ordinary transfer/approve/transferFrom semantics;
- fuzz allocation sums and boundaries;
- invariant totalSupply never changes;
- deployer/factory unexplained balance zero;
- ABI denylist и отсутствие dangerous selectors;
- compiler metadata/settings reproducibility и exact deployed-code verification
  с корректной обработкой embedded immutables.

Vesting tests:

- one second before, at and after cliff;
- one second before, at and after end;
- very small allocation and rounding dust;
- `uint64` timestamp boundaries accepted by profile;
- fuzz monotonicity and `released <= vested <= allocation`;
- repeated and permissionless release, включая `NothingToRelease()`;
- donation does not enlarge entitlement;
- beneficiary cannot change;
- no catch-up at cliff;
- full amount becomes releasable by end.

Manifest tests:

- golden allocation/manifest ABI/hash vectors TypeScript vs Solidity;
- YAML float/scientific notation/duplicate key/unknown field rejection;
- proposal-to-production rejection;
- allocation sum off by one base unit;
- duplicate ID/address and zero address;
- unstable ordering produces same normalized artifact;
- purpose/network mismatch;
- placeholder/test address in production;
- malformed hash, timestamp and decimal strings;
- partial output is never left after failure.

Security tools:

- Foundry unit, fuzz and stateful invariants;
- Slither pinned and scoped to project contracts;
- gas report, contract size and local block-limit check;
- dependency/secret/license scan through reproducible CI;
- no claim of audit from automated tools.

## Phase F - local deployment and independent verifier

1. Запустить ephemeral Anvil chain ID `31337`.
2. Использовать только стандартные documented Anvil test accounts.
3. Compile local fixture and record both commitments.
4. Deploy token and optional independently tested vesting fixtures.
5. Deployment script жёстко проверяет chain ID и local environment.
6. Отдельный verifier заново читает state через RPC и не доверяет deployment
   success output.
7. Verifier проверяет:
   - chain ID;
   - address code presence и compiler-aware deployed bytecode identity с учётом
     immutable references;
   - name, symbol, decimals, totalSupply;
   - allocation и manifest commitments;
   - каждый allocation balance;
   - сумму balances;
   - zero unexplained deployer/factory balance;
   - vesting immutable config and released state;
   - ABI/runtime identity expected build artifact без сравнения с unlinked
     bytecode как будто это deployed code.
8. Создать machine-readable JSON report и короткий Markdown summary.
9. Повторный deploy на чистой chain должен дать те же commitments и
   те же проверки; адрес может зависеть от выбранной deterministic strategy и
   не объявляется стабильным без CREATE2 ADR.

## Phase G - local Solana fixture

1. Запустить native `solana-test-validator`/Agave `4.2.1`.
2. Создать одноразовый test-only payer вне Git.
3. Создать обычный SPL Token mint с decimals `9` и supply `0`.
4. Создать test ATA только при необходимости проверки transfer path.
5. Установить freeze authority в `None` и прочитать state обратно.
6. Не развёртывать Chainlink SVM program и не имитировать его program ID.
7. Сохранить fixture state без private key material.
8. Stop validator и удалить ephemeral key material после теста.

Solana fixture остаётся test tooling, а не production adapter. До protocol-line
ADR не добавляются одновременно несовместимые `@solana/kit` и
`@solana/web3.js` transaction models. Если CLI достаточно для fixture, новая
runtime library не ставится.

## Phase H - mock cross-chain accounting

Использовать deterministic local events:

```text
Ethereum allocation balance
  -> mock lock event
  -> pending E->S
  -> mock finalized mint on local SPL fixture
  -> mock burn
  -> pending S->E
  -> mock finalized release
```

Проверить:

- global adjusted supply остаётся canonical fixed supply;
- duplicate delivery не учитывается дважды;
- out-of-order events не создают false healthy state;
- pending message не исчезает по timeout;
- unknown mint классифицируется critical;
- voluntary holder burn классифицируется отдельно;
- report явно содержит `transport: mocked` и
  `realCrossFamilyDeliveryProven: false`.

Не создаётся самописный relayer. Test harness вызывает adapters напрямую как
детерминированную симуляцию accounting transitions.

## Phase I - Linux CI parity

Минимальные jobs:

1. `foundation-and-typescript` - install from lockfile, Foundation gates,
   lint, typecheck, unit/property/package tests.
2. `solidity` - exact Foundry, build, unit, fuzz, invariant, gas and Slither.
3. `local-evm-e2e` - fresh Anvil, compile fixture, deploy, independent verify.
4. `local-solana-fixture` - exact Agave artifact, create/readback/cleanup mint.
5. `security-metadata` - secret scan, dependency declarations, pinned action and
   image policy.

GitHub Actions используются только по immutable commit SHA. Docker images
фиксируются digest. macOS остаётся быстрым native loop, Linux CI -
воспроизводимым доказательством parity. Полный `pnpm check` остаётся финальным
gate; `check:changed`, `check:fast` и глобальный `tsc7` являются только быстрыми
preflight.

## Phase J - final handoff

1. Выполнить весь required gate list из `AGENTS.md`.
2. Повторно проверить diff на secrets, public RPC URLs, private keys и
   случайные generated artifacts.
3. Сравнить реализацию с каждым acceptance criterion этого документа.
4. Зафиксировать реальные LOC, время до первого рабочего patch, долю тестов,
   прошедших с первого раза, review defects и число итераций до green.
5. Обновить `STATUS.md`, общий `PLAN.md` и только подтверждённые решения.
6. Подготовить conventional commit(s) только своих изменений.
7. Push feature branch; не открывать mainnet proposal и не публиковать launch.
8. Отправить владельцу macOS notification с заголовком `AGTMAI Genesis Core`.

---

# 8. Порядок при ограничении времени

Если полный блок не помещается в окно, нельзя оставлять широкий полуготовый
слой. Приоритет vertical slices:

1. Schema/semantic validation -> canonical commitment -> golden vectors.
2. `AGTMAIToken` -> Foundry tests -> local deploy -> independent verifier.
3. `NoCatchUpVesting` -> boundary/fuzz tests.
4. Architecture/Foundation gates and Linux CI for сделанных slices.
5. Local Solana fixture.
6. Mock cross-chain accounting.

Каждый завершённый пункт должен быть green и отдельно полезен. Незавершённый
следующий пункт документируется, но не маскируется пустыми каталогами, skipped
tests или ложным Definition of Done.

## Ориентир на 12 часов

| Работа | Окно |
| --- | ---: |
| Baseline, pins и ветка | 0.5 ч |
| Feature topology и Foundation gates | 1.5 ч |
| Manifest schemas/compiler/two commitments | 2.0 ч |
| ERC-20 и Foundry tests | 2.0 ч |
| Vesting и boundary/fuzz tests | 1.5 ч |
| Anvil deploy и independent verifier | 1.5 ч |
| Solana fixture и mock accounting | 1.0 ч |
| Linux CI, полный gate и handoff | 1.5 ч |

Это порядок планирования, не обещание закончить небезопасный код к таймеру.
При отклонении применяется приоритет vertical slices выше.

---

# 9. Failure modes и защитные меры

| Риск | Защита |
| --- | --- |
| Proposal случайно становится deployable | Разные schema discriminators, команды и negative tests |
| Ошибка decimals/supply | Integer base units, exact sum, Solidity/TS golden vectors |
| Hash не соответствует constructor allocations | Token сам пересчитывает allocation hash; verifier связывает его с full manifest |
| Скрытая admin-функция | Минимальное наследование, ABI denylist, bytecode hash, review |
| Catch-up dump в cliff | Формула с нулём при `t <= cliff`, boundary/fuzz tests |
| Donation меняет vesting | Immutable allocationAmount, entitlement cap |
| Локальный ключ попал в Git | Ephemeral paths, ignore rules, secret scan, cleanup |
| Public network запущена случайно | Chain ID allowlist, public flags false, отсутствуют public deploy commands |
| Mock назван настоящим CCIP | Machine-readable evidence flag и явная документация |
| Foundation стал runtime dependency | assert-dev-only, source dependency gate |
| Архитектура стала церемониальной | feature-first, no empty layer, negative topology fixtures |
| Разные EVM/Solana модели спрятали ошибки | Явные adapters, без universal ChainClient |
| Dependency drift | exact pins, lockfile, release/checksum evidence |
| Один deploy script подтверждает сам себя | независимый RPC verifier и fresh-chain повтор |
| Сложность выросла раньше продукта | нет policy vaults/governance/CCIP adapter в первом блоке |

---

# 10. Verification commands

Точные scripts будут добавлены в repository manifest. Финальный интерфейс
должен сводиться к следующему, без ручной последовательности из десятков команд:

```text
./dev doctor
pnpm check:changed
pnpm check:fast
pnpm check
pnpm genesis:validate:proposal
pnpm genesis:compile:local
pnpm genesis:verify:local
pnpm test:local-solana
pnpm test:mock-roundtrip
pnpm test:linux-parity
```

Если `test:linux-parity` фактически является CI-only job, локальный alias
валидирует Compose/build definition и документирует команду запуска, но не
выдаёт это за завершённый удалённый CI run.

---

# 11. Acceptance criteria

Блок считается выполненным только если:

- текущая proposal config остаётся `proposal`;
- proposal не создаёт deployable manifest;
- local `test-only` fixture создаёт deterministic manifest и commitments;
- TypeScript и Solidity дают одинаковые allocation/manifest commitments;
- token constructor сам отклоняет wrong-chain/allocation commitment mismatch;
- token supply выпущен один раз и точная сумма находится у fixture recipients;
- отсутствуют post-genesis mint/admin/proxy/pause/blacklist/tax paths;
- vesting до cliff выдаёт 0 и после cliff линейно растёт с 0;
- donation не увеличивает vesting entitlement;
- local deploy проходит на чистом Anvil;
- независимый verifier подтверждает code/state/balances/hash;
- local SPL mint имеет decimals 9, supply 0 и freeze authority None;
- mock round-trip сохраняет accounting invariant и честно помечен mock;
- Foundation, lint, TypeScript, Foundry, security и полный project gate green;
- ни одна public-network transaction не создана и не отправлена;
- ни один реальный secret или платный asset не использован;
- документация перечисляет ограничения и открытые mainnet решения;
- review не содержит unresolved critical/high findings.

---

# 12. Решения после этого блока

Следующая реализация начинается только после отдельного выбора:

1. Принять или отклонить ADR-0004 и окончательную package topology.
2. Утвердить supply/allocation/vesting tokenomics.
3. Утвердить минимальный набор policy vaults вместо всей сложной системы сразу.
4. Выбрать atomic genesis wiring и deployment address strategy.
5. Выполнить EVM CCIP `1.6.4` vs `2.0.0` compatibility spike и принять
   protocol-line ADR.
6. Определить signers и recovery model без передачи private keys.
7. Только затем готовить Sepolia/Devnet unsigned plan и запрашивать разрешение
   на public-network test.

До этих решений локальное ядро остаётся полезным: schema, hash contract, ERC-20,
vesting math, verifier, tests и CI не зависят от будущего governance UI или DEX.

---

# 13. Rollback

Работа делится минимум на независимые conventional commits:

1. `chore: enforce genesis core architecture boundaries`
2. `feat: compile canonical local genesis manifests`
3. `feat: add immutable agtmai token core`
4. `feat: add no-catch-up vesting primitive`
5. `test: verify local ethereum and solana genesis fixtures`
6. `ci: add genesis core linux parity gates`
7. `docs: record genesis core evidence and limitations`

Это пример семантических границ, а не обязательное число commits. Каждый commit
должен проходить относящиеся к нему проверки. Откат Solana fixture не затрагивает
Ethereum contracts; откат mock accounting не меняет manifest; спорная будущая
tokenomics не требует переписывать базовый token ABI, кроме отдельно
зафиксированного mainnet freeze decision.
