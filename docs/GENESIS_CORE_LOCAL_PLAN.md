# AGTMAI Genesis Core: подробный план локальной реализации

**Дата:** 28 августа 2026 года
**Статус:** исправлен после пяти независимых hosted-review на commit
`853a14a54832908f1f73fbc0f923592ab86c6247` и дополнен обязательной hosted
worker/review orchestration; реализация ещё не начата
**Цель первого блока:** за один автономный рабочий цикл до 12 часов получить
узкий проверяемый Ethereum vertical slice токена AGTMAI без газа,
mainnet-ключей, публичных транзакций и необратимого утверждения спорной
токеномики.

Этот документ конкретизирует первый технический блок из
[`PLAN.md`](PLAN.md). Общий план проекта остаётся источником долгосрочного
направления, а этот документ является исполнимым контрактом именно для локального
Genesis Core.

---

# 1. Результат блока

## 1.1 Обязательный `Core-12h`

После завершения обязательного блока должны существовать и проходить проверки:

1. Строгий TypeScript-компилятор конфигурации токена в канонический локальный
   genesis manifest.
2. Неизменяемый Ethereum ERC-20 `Agent Teams AI / AGTMAI` с 9 decimals и одним
   выпуском фиксированного supply в constructor.
3. Локальный deployment на Anvil с синтетическими, не имеющими ценности
   адресами и отдельным read-only verifier.
4. Золотой вектор allocation commitment, одинаково вычисляемый TypeScript и
   Solidity.
5. Native macOS arm64 feedback loop и один воспроизводимый Linux parity job для
   этого exact vertical slice.
6. Отчёт, в котором разделены реально выполненные проверки, прототипные
   ограничения и следующие решения владельца.

`NoCatchUpVesting` является stretch goal: он добавляется только после полного
green обязательного блока и остаётся самостоятельным primitive, не частью
genesis E2E. Его funding/wiring будет отдельным решением.

## 1.2 Следующие independently-green slices

Они сохраняются в плане, но не входят в обещание одного 12-часового цикла:

1. `NoCatchUpVesting` и adversarial ERC-20 tests.
2. Изолированный Agave/SPL fixture: 9 decimals, initial supply 0, точная
   test-only mint authority, freeze authority `None`, mint -> burn -> final 0.
3. Детерминированная Ethereum -> Solana -> Ethereum accounting simulation,
   явно помеченная как mock, а не настоящий Chainlink CCIP E2E.
4. Расширенная Linux matrix, Slither и consolidated evidence reports.

Обязательный `Core-12h` оценивается в `1 600-2 800` строк production-кода,
тестов, fixtures, CI и документации. Следующие slices добавят ориентировочно
`1 500-2 500`. Это не цель по количеству строк: ненужные абстракции ради объёма
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
packages/contexts/supply/src/features/genesis-manifest/
```

Почему TypeScript временно находится в `Supply`: ADR-0003 принят и остаётся
архитектурным источником истины. ADR-0004 с `Token Control` и `Cross-chain
Accounting` предложен, но не утверждён владельцем. Первый блок не имеет права
молча принять его. Поэтому `Core-12h` создаёт только новую
`genesis-manifest` feature и не переносит существующий `packages/domain`.
Решение принять либо отклонить ADR-0004 обязательно до package migration:

- при принятии ADR-0004 код один раз переносится в два целевых context;
- при отклонении код один раз переносится в принятый ADR-0003 `Supply`;
- временный двойной перенос запрещён.

Перед возможным принятием ADR-0004 он должен явно сохранить решения ADR-0003
об explicit ports, отсутствии ambient effects, value objects, chain adapters и
semantic DRY, заменив только bounded-context topology.

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
  script/features/local-genesis/
    DeployLocalGenesis.s.sol
  test/features/token-genesis/
  test/integration/genesis-manifest/

packages/contexts/supply/
  package.json
  tsconfig.json
  src/features/genesis-manifest/
    domain/
    application/
    adapters/
    composition/
    README.md
  src/features/genesis-manifest/index.ts
  tests/features/genesis-manifest/
  tests/package/

config/genesis/
  proposal.schema.json
  local-source.schema.json
  local-manifest.schema.json
  local.fixture.yaml

reports/local/
  .gitkeep only if reports are intentionally versioned; otherwise generated
  reports stay gitignored
```

Точные поддиректории создаются только при наличии файлов. Если use case не
требует отдельного application layer, он не создаётся ради картинки.
Публичный TypeScript API экспортируется отдельным subpath
`./genesis-manifest`; общий barrel двух будущих features не создаётся. Build
config не включает тесты в публикуемый `dist`.

---

# 5. Manifest contract

## 5.1 Разные типы входа без production shortcut

Нельзя превращать proposal в deployable input сменой одного поля. В `Core-12h`
существуют три разные schemas:

```text
TokenomicsProposal
  purpose = proposal
  status = proposal
  percentages and unresolved decisions allowed
  deployable output forbidden

LocalGenesisSource
  purpose = local-fixture
  status = test-only
  chainId = "31337"
  exact base-unit amounts and allowlisted test addresses

LocalGenesisManifest
  generated output only
  source digest + allocation commitment + tool identity
```

Production source schema, production compile command и значение
`status=accepted` в этом блоке отсутствуют. Само слово `accepted` не доказывает
человеческое одобрение. Будущий production artifact потребует отдельный
проверяемый approval envelope, который свяжет source digest, manifest hash,
schema/compiler versions, repository commit, chain ID, nonce/expiry, Facts Pack
digest и утверждённых approvers. Compiler и deployer должны проверять envelope
независимо; `--force` или status override запрещены.

## 5.2 Числовая модель

- Token amounts: canonical decimal strings на входе, `bigint` в domain,
  base-unit decimal strings в JSON artifact.
- Percentages/caps: только integer basis points.
- Chain ID и CCIP selectors: decimal strings или `bigint`, никогда JavaScript
  `number`.
- Timestamps в будущих schedule sources: canonical decimal strings на границе и
  `bigint` внутри. Их нельзя пропускать через `Number` или `Date`.
- Calendar months допустимы только в proposal/reporting layer. Перед accepted
  manifest они компилируются в точные timestamps с явно проверенным правилом
  month-end clamping.
- YAML parsing: только YAML 1.2, ровно один document, string keys; anchors,
  aliases, merge keys, custom tags, duplicate keys и non-string keys запрещены
  до преобразования в object.
- JSON duplicate members также отклоняются до `JSON.parse`-подобной last-wins
  обработки. Validator не применяет coercion/default/remove-additional;
  неизвестные fields запрещены на каждом уровне.

## 5.3 Семантическая валидация

Компилятор проверяет:

- schema version поддерживается;
- name/symbol/decimals совпадают с ожидаемым profile;
- total supply положительный, помещается в EVM `uint256` и в отдельно выбранный
  SPL-compatible profile;
- сумма allocations равна total supply точно в base units;
- bps, если присутствуют для сверки, суммируются ровно в `10 000`; base-unit
  amounts являются авторитетными, скрытого округления bps -> amount нет;
- allocation ID соответствует ASCII grammar, уникален после bytes32 encoding и
  отсортирован по unsigned bytes;
- local recipient имеет lowercase `0x` + 40 hex digits, не zero и уникален как
  20-byte value;
- amount каждого bucket больше нуля;
- local fixture содержит только allowlisted test addresses;
- hash references имеют правильную длину и encoding;
- source/output не являются одним inode, symlink или hardlink.

Validation собирает все независимые diagnostics, но compiler fail-closed: при
одной ошибке manifest, hash и deployable path не возвращаются. Diagnostic имеет
стабильные `code`, `severity`, JSON Pointer, source span и deterministic order;
validation, I/O и internal failure имеют разные exit codes.

## 5.4 Единственный onchain commitment первого блока

`Core-12h` фиксирует только данные, которые token действительно способен
проверить: свои genesis allocations. Неполный hash не называется full manifest
hash и не выдаётся за человеческое одобрение токеномики.

`GENESIS_ALLOCATION_HASH` вычисляет token constructor до первого mint:

```text
keccak256(abi.encode(
  AGTMAI_ALLOCATION_V1_DOMAIN,
  uint256(block.chainid),
  bytes32(keccak256("Agent Teams AI")),
  bytes32(keccak256("AGTMAI")),
  uint8(9),
  uint256(initialSupply),
  tuple(bytes32 id,address recipient,uint256 amount)[] sortedAllocations
))
```

Нормативное кодирование:

- `AGTMAI_ALLOCATION_V1_DOMAIN` - зафиксированный в golden vector `bytes32`, не
  вычисляемая во время deploy строка;
- allocation ID - 1-31 ASCII символов `[a-z0-9-]`, первый и последний символ
  буквенно-цифровые, NUL запрещён; байты копируются слева в `bytes32`, остаток
  справа заполняется нулями;
- uniqueness проверяется после encoding;
- allocations строго возрастают по числовому значению `bytes32`; constructor
  сам отклоняет любую перестановку или duplicate;
- address сравнивается как ровно 20 bytes;
- используется только `abi.encode`, никогда `abi.encodePacked`.

Hash связывает chain, identity, supply и фактически mint-нутые allocations, но
не выбирает «официальный» deployment. Если deployer передаст другой взаимно
согласованный набор, constructor вычислит другой корректный hash. Поэтому
официальность адреса и соответствие утверждённой конфигурации позже доказываются
независимо опубликованным approval envelope и deployment descriptor либо
generated one-shot assembler с зафиксированным approved hash.

TypeScript использует exact-pinned ABI library; Solidity независимо вычисляет
тот же payload. Committed golden vectors содержат source, normalized records,
raw ABI bytes и expected hash и не регенерируются внутри теста.

Human-readable artifact получает отдельный
`LOCAL_FIXTURE_ARTIFACT_SHA256`: SHA-256 от domain prefix + UTF-8 RFC 8785 bytes
без BOM, trailing newline и самого digest field. JSON числа, способные выйти за
safe integer, хранятся строками. Hash allocation и SHA-256 artifact никогда не
смешиваются в UI или документации.

Успешный output пишется в новый content-addressed directory: temporary file в
том же filesystem -> flush/fsync -> atomic rename -> `READY` marker с source и
artifact digests. Failed run не обновляет `READY`; deployer принимает только
явно переданный artifact digest текущего успешного run и не подхватывает старый
файл по фиксированному пути.

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
GENESIS_ALLOCATION_HASH = constructor-computed integrity commitment
```

Constructor принимает `initialSupply` и отсортированный список с максимумом
`MAX_GENESIS_ALLOCATIONS = 32`. Лимит `32` является local-candidate choice и
перед production ABI freeze получает отдельное gas/rationale подтверждение:

```text
Allocation {
  bytes32 id;
  address recipient;
  uint256 amount;
}
```

Constructor обязан до первого mint:

- отклонить пустой список и список длиннее `32`;
- отклонить zero ID и любой ID, который не строго больше предыдущего;
- отклонить zero/duplicate recipient;
- отклонить zero amount;
- проверить сумму без потери точности;
- требовать точного равенства суммы `initialSupply`;
- самостоятельно вычислить и сохранить allocation commitment с
  `block.chainid`;
- mint каждый bucket сразу его final recipient;
- emit отдельное `GenesisAllocation(id, recipient, amount)`;
- завершиться без баланса у deployer/factory, если они не являются явно
  объявленным allocation recipient.

После constructor отсутствуют:

- `mint`, `burnFrom`, owner/admin role;
- pause/blacklist/tax/fee/rebase;
- privileged arbitrary call или forced approval; стандартный ERC-20 `approve`
  остаётся частью обычного token ABI;
- proxy initializer или upgrade hook;
- CCIP-specific inheritance.

`getCCIPAdmin()` не добавляется вслепую. Его ABI зависит от выбранного
registration flow и будет решён protocol-line ADR до CCIP adapter. Это означает,
что локальный контракт является candidate core, а не замороженным mainnet ABI.

## 6.2 Stretch slice: `NoCatchUpVesting`

Этот контракт не входит в обязательный `Core-12h`. Он реализуется только после
green token vertical slice и не считается связанным с genesis, пока отдельный
fixture bucket фактически не направлен в его адрес и verifier не доказал
funding, code identity и schedule.

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
- transfer выполняется через `SafeERC20.safeTransfer`; production instance
  допускает только canonical AGTMAI с обычной non-fee/non-rebase семантикой;
- beneficiary balance до/после transfer обязан увеличиться ровно на release
  amount, иначе вся transaction откатывается;
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

В обязательном блоке реализуется token, а vesting остаётся самостоятельным
следующим slice. Local token deploy использует детерминированные test recipients. Полная atomic
схема `GenesisAssembler`, CREATE2 адреса и binding всех будущих vaults не
утверждается, пока не определены сами vaults и activation rules.

Это исключает опасный временный production treasury, но не создаёт сложную
factory до того, как известны реальные consumers. Перед mainnet будет отдельный
ADR: direct constructor recipients, one-shot assembler или другая доказанная
atomic схема.

---

# 7. Пошаговая реализация

## 7.1 Модель исполнения

Кодирование и критика выполняются production-hosted subscription-runtime
воркерами. Это не локальные сабагенты и не проверка самого runtime на проекте.
Основной агент остаётся интегратором: фиксирует интерфейсы, распределяет
непересекающееся владение, проверяет каждый commit, объединяет изменения и
принимает или отклоняет замечания критиков.

Model split обязателен:

- планирование, threat review и финальная критика: `gpt-5.6-sol`, reasoning
  `xhigh`, service tier `fast`;
- implementation workers: `gpt-5.6-sol`, reasoning `medium`, service tier
  `fast`;
- каждый worker имеет отдельный job и isolated worktree на точном base SHA;
- одна и та же директория никогда не используется двумя активными workers;
- public-network broadcast, реальные ключи и платные assets запрещены всем
  jobs.

Runtime capacity проверяется перед каждой волной. Недоступный account не
является причиной смешивать worktrees или запускать дублирующую задачу: основной
агент продолжает интеграцию готовых результатов, а недостающий job ставится на
другой доступный slot. Локальный fallback для worker-задачи без нового явного
разрешения владельца не используется.

## 7.2 Integration contract до первого worker

До параллельного кодирования основной агент создаёт один baseline commit и
фиксирует в worker briefs:

1. exact base SHA и разрешённую branch name без `codex/` prefix;
2. обязательные документы: этот план, ADR-0003, proposed ADR-0004,
   `NON_NEGOTIABLES.md` и итог hosted-критики;
3. normative allocation ABI: domain bytes, ID grammar/padding, ordering, types,
   address rules и fixture source без заранее «подогнанного» expected hash;
4. local manifest schema version, commands и diagnostic contract;
5. file ownership, read-only dependencies и явно запрещённые paths;
6. acceptance tests, команды проверки и non-goals;
7. handoff format: status, commit SHA, changed paths, проверки с exit status,
   ограничения, dependency requests и оставшиеся риски.

Минимальный machine-readable brief/result contract:

```text
brief:
  jobId, role, model, reasoning, serviceTier
  baseSha, branch, ownedPaths[], forbiddenPaths[]
  requiredDocs[], deliverables[], acceptance[], commands[], nonGoals[]

result:
  status = completed | blocked | failed
  baseSha, commitSha, changedPaths[]
  checks[{command, exitCode, evidence}]
  dependencyRequests[], limitations[], residualRisks[]
```

Job ID, account slot, timestamps, base/final SHA, model settings и result digest
попадают в финальный evidence report. Auth material и worker-local paths в
репозиторий не копируются.

Worker не расширяет scope и не меняет общий контракт молча. Если normative
interface недостаточен или противоречив, job возвращает blocker с минимальным
вариантом решения; основной агент исправляет integration contract и только затем
перезапускает зависимые jobs от нового base SHA.

## 7.3 Непересекающееся владение implementation workers

| Worker | Волна | Владеет | Не трогает | Результат |
| --- | --- | --- | --- | --- |
| W1 Manifest/Foundation | 1 | `packages/contexts/supply/**`, `config/genesis/**`, нужные root pnpm/TS/Foundation files | `contracts/evm/**`, local-EVM tooling, CI workflow | strict compiler, schemas, diagnostics, normalized artifact, TypeScript ABI bytes/tests |
| W2 Solidity token | 1 | `contracts/evm/**` | TypeScript/config, root manifests, verifier, CI | minimal token, independent ABI/hash implementation, Foundry unit/fuzz/invariants |
| W3 Local EVM verifier | 2 | `tooling/local-evm/**`, `scripts/genesis/**`, local report schemas | token/compiler internals, CI/toolchain bootstrap | isolated Anvil lifecycle, deploy, adversarial read-only verifier, failure reports |
| W4 Linux parity | 2 | `.github/workflows/ci.yml`, `tooling/toolchain.lock.json`, bootstrap/doctor/env, `compose.yaml` | domain/token/verifier semantics | platform pins, offline fail-closed install, exact-SHA Linux jobs |
| Integrator | все | global docs, root command wiring, conflict resolution, acceptance ledger | не переписывает рабочий feature без подтверждённого дефекта | единая ветка, cross-language proof, final evidence |

W1 временно является единственным worker, которому разрешено менять root
dependency/workspace files в первой волне. После barrier эти paths снова
принадлежат только интегратору. W3 и W4 стартуют от integrated barrier SHA, а не
от первоначального research commit. Global docs редактирует только интегратор,
чтобы workers не создавали несколько несовместимых описаний истины.

Каждый worker создаёт один или несколько conventional commits только в своей
ветке (`feat/genesis-manifest`, `feat/agtmai-token`,
`test/local-evm-verifier`, `ci/genesis-parity`) и push-ит её только после своих
scope checks. Worker не merge-ит себя в integration branch. Интегратор перед
cherry-pick проверяет base SHA, diff, отсутствие чужих paths/secrets/generated
artifacts и повторяет минимальный относящийся gate.

## 7.4 Волны, барьеры и cross-language proof

```text
Baseline/spec freeze
  ├─ W1 manifest/compiler ─┐
  ├─ W2 Solidity/token ────┼─ Barrier 1: integrate + raw ABI equality
  └─ integrator pin discovery┘
                             ├─ W3 deploy/verifier ─┐
                             └─ W4 Linux parity ────┼─ Barrier 2: full candidate
                                                    └─ hosted critics
                                                         └─ fixes + exact-head review
```

### Barrier 1

1. Cherry-pick W1 и W2 в чистую integration branch.
2. Regenerate lockfile только package manager и проверить Foundation boundary.
3. Сравнить TypeScript и Solidity raw `abi.encode` bytes, а не только final hash.
4. Принять golden vector только после независимого совпадения обеих реализаций;
   expected bytes/hash не генерируются тестом во время его выполнения.
5. Запустить targeted TS/Foundry tests и negative permutation/encoding cases.
6. Зафиксировать новый barrier SHA. Только он является base для W3/W4.

Если bytes расходятся, W3/W4 не стартуют. Интегратор локализует различие до
конкретного field/offset; W1 и W2 получают один и тот же defect brief. Нельзя
выбрать одну реализацию «правильной» только потому, что она первой прошла свои
собственные тесты.

### Barrier 2

1. Cherry-pick W3/W4 и выполнить root command wiring.
2. Проверить interrupted/parallel Anvil lifecycle и forged verifier inputs.
3. Получить одинаковые normalized artifacts/commitments на macOS arm64 и Linux
   x86_64.
4. Выполнить `check:changed`, `check:fast`, полный `pnpm check` и Foundry gates.
5. Push candidate SHA и получить green remote CI именно на этом SHA.
6. Заморозить candidate: до окончания критики никакой worker его не меняет.

## 7.5 Процесс hosted-критики реализации

Критики являются отдельными read-only subscription-runtime workers. Все читают
один exact candidate SHA в разных clean worktrees и не получают ветки
implementation workers как источник истины.

Им разрешены только локальные zero-cost проверки без public RPC/broadcast.
Игнорируемые test artifacts очищаются после запуска; tracked dirty state делает
review evidence недействительным.

Пять специализаций запускаются параллельно:

1. Solidity/asset security: supply, constructor, ABI, runtime bytecode, gas и
   adversarial call paths.
2. Manifest/canonicalization: parser, numeric boundaries, raw ABI vectors,
   atomic output и approval-vs-integrity wording.
3. Verifier/local runtime: forged artifacts, race/interrupt/cleanup, stale state
   и независимость evidence.
4. Architecture/Foundation: DDD ownership, dependency direction, exports,
   package/ADR lifecycle и отсутствие лишней платформы.
5. CI/MVP: platform pins, offline behavior, exact-SHA evidence, scope completeness
   и честность claims.

Каждый prompt требует:

- verdict `ACCEPT`, `AMEND` или `REJECT`;
- severity `P0/P1/P2` для каждой находки;
- точный `file:line`, воспроизводимый failure/attack scenario и нарушенный
  invariant;
- минимальное исправление и тест, который до исправления падает;
- отдельный список предпочтений, которые не являются дефектами;
- подтверждение exact HEAD, clean worktree и отсутствия tracked edits.

Severity contract:

- `P0`: возможна потеря/создание supply, обход прав, secret/public-network
  exposure или доказательство относится не к тому artifact;
- `P1`: неверный protocol/manifest/evidence contract либо обязательный failure
  path не проверен;
- `P2`: ограниченный maintainability/observability gap без нарушения текущего
  локального инварианта.

Решение не принимается голосованием. Интегратор воспроизводит и проверяет каждую
находку, затем записывает `accepted`, `rejected` или `deferred` с причиной в
`docs/research/GENESIS-CORE-CODE-REVIEW-<date>.md`. Для accepted finding
фиксируются owner, fix commit и regression test. `P0/P1` блокируют завершение;
`P2` можно отложить только с явным ограничением и безопасной точкой расширения.

Исправления возвращаются worker, который владеет затронутым path. Если finding
пересекает несколько owners, интегратор сначала фиксирует единый interface
change, затем выдаёт непересекающиеся repair briefs. После fix повторно
запускается затронутый специализированный critic и один финальный holistic
`xhigh` critic на новом exact HEAD. Старый review не переиспользуется как
доказательство для изменившегося SHA.

## 7.6 Сбои workers и правила восстановления

- Нет progress/result, процесс умер: job не считается выполненным; проверить
  последнюю чистую commit boundary и перезапустить в новом isolated worktree.
- Worker оставил dirty/untracked state: не интегрировать; принять только
  осмотренный scoped commit либо перезапустить задачу.
- Worker изменил чужой path: cherry-pick запрещён до разделения commit; чужие
  изменения не «подчищаются» интегратором вслепую.
- Base SHA устарел после interface fix: результат не merge-ится; worker получает
  новый brief и новый base.
- Временный registry/network failure: bounded retry только failed fetch phase,
  затем checksum/readback; уже доказанные тесты не перезапускаются без причины.
- Неопределённый push/CI result: сначала прочитать remote state через `git`/`gh`,
  не повторять mutation до подтверждения.
- Любой намёк на public RPC, реальный secret или transaction broadcast:
  немедленно остановить job, не публиковать ветку и провести secret/state audit.

Handoff считается готовым, когда integration worktree чистый, все accepted
`P0/P1` закрыты regression tests, affected critics подтвердили исправления,
holistic review относится к final SHA, remote CI green на том же SHA, а отчёт
разделяет proven, simulated, deferred и not-proven claims.

Метрики model-split эксперимента записываются в final report: время до первого
рабочего patch, доля тестов, прошедших с первого раза, defects каждого critic,
число repair iterations, total worker time и wall-clock time. Они используются
для настройки следующего slice, но не ослабляют acceptance criteria.

## 7.7 Детальные технические фазы

### Phase A - безопасный baseline

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

### Phase B - mechanical architecture gates

1. Не перемещать и не переписывать существующий `packages/domain` до решения по
   ADR-0004.
2. Добавить только новую `genesis-manifest` feature в принятую ADR-0003
   capability `Supply` и расширить pnpm workspace pattern.
3. Экспортировать только subpath `./genesis-manifest`; запретить deep imports и
   проверить его одним black-box consumer test.
4. Для реально появившихся слоёв задать default-deny matrix: domain не имеет
   runtime imports; application -> domain; adapters -> application/domain;
   composition -> существующие слои. `node:test` разрешён только test paths,
   Foundation запрещён production code.
5. Использовать существующие Foundation gates. Локальный topology validator и
   negative fixtures добавлять только для правил, которых Foundation реально не
   умеет проверить, а не строить платформу заранее.
6. Root/nested manifests, workspace и topology config должны запускать full
   scan в `check:changed`.

Rollback: весь structural gate находится в отдельном commit и может быть
отменён без изменения contract semantics.

### Phase C - strict manifest vertical slice

1. Добавить обязательный `purpose: proposal` в текущий proposal и независимые
   proposal/local-source/local-manifest JSON Schemas без defaults/coercion.
2. Реализовать lexical/CST strict YAML/JSON adapter по правилам §5.2.
3. Реализовать domain value objects для base units, bps, UTC seconds,
   allocation ID и EVM address.
4. Реализовать semantic validator и diagnostic codes.
5. Реализовать deterministic ordering.
6. Реализовать ABI commitment builder.
7. Реализовать commands `validate:proposal`, `compile:local`, `inspect:local`.
8. Production command и production source schema отсутствуют.
9. Сгенерировать local artifact только из `status=test-only` в новом
   content-addressed gitignored directory с `READY` marker.
10. Проверить, что proposal не создаёт deployable artifact.

### Phase D - Solidity token primitive

1. Инициализировать Foundry project внутри `contracts/evm`.
2. Pin OpenZeppelin по точному release commit.
3. Реализовать `AGTMAIToken` с минимальным ABI.
4. Добавить custom errors и events без строковых revert reasons, где это
   уменьшает bytecode и не ухудшает ясность.
5. Не создавать vesting, base vault hierarchy и generic treasury abstraction в
   обязательном block.
6. Сохранить ABI snapshots, compiler settings и compiler-aware deployed-code
   identity в local artifacts. Простой hash unlinked bytecode не выдавать за
   hash кода с embedded immutables.

### Phase E - tests and adversarial properties

Token tests:

- exact name/symbol/decimals/supply и allocation hash;
- constructor независимо вычисляет hash из фактических sorted allocations;
- каждый constructor rejection path;
- strictly increasing IDs и unique recipients;
- exact allocation events and balances;
- ordinary transfer/approve/transferFrom semantics;
- fuzz allocation sums and boundaries;
- invariant totalSupply never changes;
- deployer/factory unexplained balance zero;
- arbitrary-calldata fuzz, ABI review и отсутствие fallback/privileged
  dispatch; один denylist сам по себе не считается доказательством;
- compiler metadata/settings reproducibility и exact deployed-code verification
  с корректной обработкой embedded immutables.

Stretch vesting tests после обязательного green:

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
- `SafeERC20` mocks: returns false, returns true without transfer,
  fee-on-transfer и reentrant token; неподдерживаемая семантика должна
  отклоняться либо быть явно исключена canonical-token binding.

Manifest tests:

- committed golden allocation ABI/hash vectors TypeScript vs Solidity;
- YAML float/scientific notation/duplicate key/alias/merge/tag/multi-document и
  unknown field rejection;
- proposal-to-local-artifact rejection и отсутствие production command;
- allocation sum off by one base unit;
- duplicate ID/address and zero address;
- permutation normalizes deterministically, но constructor отклоняет
  несортированный raw array;
- purpose/network mismatch;
- non-allowlisted address in local fixture;
- malformed hash, decimal strings, `2^53±1`, `uint64/uint256` boundaries;
- ID Unicode/NUL/length/encoding collision и address case duplicates;
- crash/stale artifact/symlink/hardlink не обновляют `READY`.

Security tools:

- Foundry unit, fuzz and scoped invariant handlers;
- gas report, contract size and local block-limit check;
- dependency/secret/license scan through reproducible CI;
- no claim of audit from automated tools.

Slither переносится в расширенный security slice, если его exact Python/solc
environment не удаётся воспроизводимо зафиксировать в обязательном окне.

### Phase F - local deployment and independent verifier

1. Запустить ephemeral Anvil chain ID `31337`.
2. Создать unique run directory с mode `0700`, ephemeral signing key, unique
   process ownership и dynamic RPC port либо fail-fast port lock.
3. Compile local fixture and record allocation commitment + artifact SHA-256.
4. Deploy только token; vesting не является optional скрытой частью этого gate.
5. Deployment script жёстко проверяет chain ID и local environment.
6. Отдельный verifier заново читает state через RPC и не доверяет deployment
   success output. Approved local artifact, build-info digest и target address
   передаются ему явно, не считываются неявно из `latest` report.
7. Verifier проверяет:
   - chain ID;
   - address code presence и compiler-aware deployed bytecode identity с учётом
     immutable references;
   - name, symbol, decimals, totalSupply;
   - allocation commitment против independently encoded golden/raw vector;
   - каждый allocation balance;
   - сумму balances;
   - zero unexplained deployer/factory balance;
   - ABI/runtime identity expected build artifact без сравнения с unlinked
     bytecode как будто это deployed code.
8. Runtime bytecode реконструируется из pinned build-info с ожидаемыми
   immutable/link values и сравнивается побайтно/по `keccak256`; mutation test
   меняет каждое immutable/constructor input и требует отказ verifier.
9. Verifier имеет negative tests для подменённых address, ABI, build artifact,
   constructor args и deployment report.
10. Создать versioned machine-readable JSON report и короткий Markdown summary
    с tool versions, exit status, chain identity, artifact digests и redaction.
11. Повторный deploy на чистой chain должен дать те же commitments и
   те же проверки; адрес может зависеть от выбранной deterministic strategy и
   не объявляется стабильным без CREATE2 ADR.
12. `trap` на `EXIT/INT/TERM` удаляет только owned PID/process, temp key и run
    directory; parallel worktree test доказывает отсутствие убийства соседнего
    Anvil.

### Следующий slice G - local Solana fixture

1. Запустить native `solana-test-validator`/Agave `4.2.1`.
2. Создать одноразовый test-only payer вне Git.
3. Создать обычный SPL Token mint с decimals `9` и supply `0`.
4. Зафиксировать exact test-only mint authority и
   `productionAuthorityProven: false`.
5. Создать test ATA, выполнить реальный SPL mint -> burn и проверить final
   supply `0`.
6. Установить freeze authority в `None` и прочитать Token Program owner, mint и
   freeze authorities обратно.
7. Не развёртывать Chainlink SVM program и не имитировать его program ID.
8. Сохранить fixture state без private key material.
9. Stop validator и удалить только owned ledger/key material после теста.

Solana fixture остаётся test tooling, а не production adapter. До protocol-line
ADR не добавляются одновременно несовместимые `@solana/kit` и
`@solana/web3.js` transaction models. Если CLI достаточно для fixture, новая
runtime library не ставится.

### Следующий slice H - mock cross-chain accounting

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

### Phase I - Linux CI parity обязательного блока

В `Core-12h` добавляется минимальная parity matrix:

1. `foundation-and-typescript` - install from lockfile, Foundation gates,
   lint, typecheck, unit/property/package tests.
2. `solidity` - exact Foundry/solc, build, unit, fuzz, scoped invariants и gas.
3. `local-evm-e2e` - fresh Anvil, compile fixture, deploy, independent verify.

Agave/SPL, Slither и consolidated security metadata jobs добавляются вместе с
соответствующими следующими slices, а не пустыми placeholders.

GitHub Actions используются только по immutable commit SHA. Docker images
фиксируются digest; binary artifacts имеют platform-specific URL + SHA-256 в
едином lock-файле для `darwin-arm64` и `linux-x64`. Lock включает Node,
Foundry, solc и все реально используемые CLI. Bootstrap скачивает в `.part`,
проверяет checksum, атомарно переименовывает/распаковывает и поддерживает
отдельные `fetch` и `verify/install --offline` режимы без fallback на
system/latest.

macOS остаётся быстрым native loop, Linux CI - воспроизводимым доказательством
parity: одинаковые golden bytes, commitments и normalized reports. Локальная
проверка workflow доказывает только корректность config; green remote run на
точном commit SHA является отдельным обязательным evidence. Полный `pnpm check`
остаётся финальным gate; `check:changed`, `check:fast` и глобальный `tsc7`
являются только быстрыми preflight.

### Phase J - final handoff

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

Если обязательный блок не помещается в окно, нельзя оставлять широкий
полуготовый слой. Приоритет внутри `Core-12h`:

1. Schema/semantic validation -> canonical commitment -> golden vectors.
2. `AGTMAIToken` -> Foundry tests -> local deploy -> independent verifier.
3. Architecture/Foundation gates and Linux parity для сделанных slices.

Vesting, Solana и mock accounting не являются fallback-незавершённостью: это
заранее отдельные следующие slices со своими Definition of Done.

Каждый завершённый пункт должен быть green и отдельно полезен. Незавершённый
следующий пункт документируется, но не маскируется пустыми каталогами, skipped
tests или ложным Definition of Done.

## Ориентир на 12 часов

| Wall-clock окно | Параллельная работа | Barrier/result |
| --- | --- | --- |
| 0-1 ч | интегратор: baseline, pins, interface/ownership freeze | worker briefs + clean base SHA |
| 1-4 ч | W1 manifest и W2 token; интегратор параллельно проверяет CI pins | два scoped commits |
| 4-5 ч | интегратор + targeted W1/W2 repair | Barrier 1, raw ABI equality |
| 5-8 ч | W3 verifier и W4 Linux parity параллельно | scoped E2E/CI commits |
| 8-9 ч | интеграция, local full gates, remote exact-SHA CI | frozen candidate SHA |
| 9-10 ч | пять read-only hosted critics параллельно | evidence-based findings ledger |
| 10-11.5 ч | только owners затронутых paths + affected re-review | закрытые P0/P1 |
| 11.5-12 ч | holistic exact-head review, final CI/report/handoff | clean final SHA |

Окна являются wall-clock ориентиром при доступной hosted capacity, а не суммой
worker-hours и не обещанием закончить небезопасный код к таймеру. Если barrier
не пройден, зависимая волна не стартует. Если время вышло, сдаётся только
последний полностью green пункт с честным evidence; scope не расширяется
vesting/Solana/mock задачами.

---

# 9. Failure modes и защитные меры

| Риск | Защита |
| --- | --- |
| Proposal случайно становится deployable | Production schema/command отсутствуют; разные local schemas и negative tests |
| `accepted` сам выдаёт себя за approval | В будущем отдельный подписанный/verifiable approval envelope; status не является доверием |
| Ошибка decimals/supply | Integer base units, exact sum, Solidity/TS golden vectors |
| Hash ошибочно назван approval | Token hash доказывает только целостность фактических allocations; официальный адрес требует отдельного descriptor/envelope |
| Подан согласованный, но неверный набор | Verifier сравнивает deployment с отдельно выбранным artifact; negative coherent-wrong-config test |
| Старый artifact пережил failed compile | Content-addressed run + atomic `READY`; deployer принимает exact current digest |
| Скрытая admin-функция | Минимальное наследование, source/runtime review, arbitrary-calldata fuzz, ABI snapshot |
| Локальный ключ попал в Git | Ephemeral paths, ignore rules, secret scan, cleanup |
| Cleanup убил соседний процесс | Unique run ownership, dynamic port/lock, exact PID cleanup, parallel-worktree test |
| Public network запущена случайно | Chain ID allowlist, public flags false, отсутствуют public deploy commands |
| Foundation стал runtime dependency | assert-dev-only, source dependency gate |
| Архитектура стала церемониальной | feature-first, no empty layer; новые gates только для реального пробела |
| Dependency/cache drift | platform pins, `.part` + checksum + atomic install, offline fail-closed |
| Один deploy script подтверждает сам себя | Отдельные trusted inputs, independent vectors, adversarial verifier и fresh-chain повтор |
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
pnpm test:linux-parity
```

Если `test:linux-parity` фактически является CI-only job, локальный alias
валидирует Compose/build definition и документирует команду запуска, но не
выдаёт это за завершённый удалённый CI run. Acceptance требует отдельно
зафиксированный green GitHub Actions run на exact commit SHA.

---

# 11. Acceptance criteria

Блок считается выполненным только если:

- текущая proposal config остаётся `proposal`;
- proposal имеет обязательный `purpose: proposal`;
- proposal не создаёт deployable manifest;
- production schema и production compile command отсутствуют;
- local `test-only` fixture создаёт deterministic manifest, allocation
  commitment и artifact SHA-256;
- TypeScript и Solidity дают одинаковые raw ABI bytes и allocation commitment;
- token constructor вычисляет commitment только из фактически mint-нутого
  строго отсортированного массива;
- документация не называет integrity hash человеческим approval;
- token supply выпущен один раз и точная сумма находится у fixture recipients;
- отсутствуют post-genesis mint/admin/proxy/pause/blacklist/tax paths;
- local deploy проходит на чистом Anvil;
- adversarial verifier с отдельными inputs подтверждает
  code/state/balances/hash и отклоняет подменённые artifacts/reports;
- два parallel runs не конфликтуют, а interrupt cleanup не трогает соседа;
- Foundation, lint, TypeScript, Foundry и полный project gate green;
- Linux parity green на exact commit SHA, не только локально провалидирован;
- ни одна public-network transaction не создана и не отправлена;
- ни один реальный secret или платный asset не использован;
- документация перечисляет ограничения и открытые mainnet решения;
- review не содержит unresolved critical/high findings.

---

# 12. Решения после этого блока

Следующая реализация начинается только после отдельного выбора:

1. Принять или отклонить ADR-0004 и окончательную package topology.
2. Утвердить supply/allocation/vesting tokenomics.
3. Утвердить production manifest fields и approval envelope, включая Facts
   Pack/decision digests, approvers, nonce/expiry и versioning.
4. Утвердить минимальный набор policy vaults вместо всей сложной системы сразу.
5. Выбрать atomic genesis wiring и deployment address strategy.
6. Выполнить EVM CCIP `1.6.4` vs `2.0.0` compatibility spike и принять
   protocol-line ADR.
7. Определить signers и recovery model без передачи private keys.
8. Только затем готовить Sepolia/Devnet unsigned plan и запрашивать разрешение
   на public-network test.

До этих решений локальное ядро остаётся полезным: local schema, allocation
commitment, ERC-20, verifier, tests и CI не зависят от будущего governance UI
или DEX.

---

# 13. Rollback

Работа делится минимум на независимые conventional commits:

1. `chore: enforce genesis core architecture boundaries`
2. `feat: compile canonical local genesis manifests`
3. `feat: add immutable agtmai token core`
4. `test: verify local ethereum genesis fixture`
5. `ci: add genesis core linux parity gates`
6. `docs: record genesis core evidence and limitations`

Это пример семантических границ, а не обязательное число commits. Каждый commit
должен проходить относящиеся к нему проверки. Vesting, Solana fixture и mock
accounting позже получают отдельные commits и не влияют на rollback обязательного
Ethereum slice. Спорная будущая tokenomics не требует переписывать базовый token
ABI, кроме отдельно зафиксированного mainnet freeze decision.
