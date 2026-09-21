# Agent Teams token: живой план Ethereum ↔ Solana на Chainlink CCIP

## Production reserve implementation, 2026-09-19

The owner requested the bounded production-reserve slice from
`7f55b55fa0ce322721ea94f66869826f52c81fd4`: 30/30/20/9/5/5/1 allocation,
3% irrevocable founder grant, 17% revocable contributor reserve, individual
12-month cliff and full vesting at month 48, rolling 365-day gross commitment
caps, per-grant caps and deterministic offline genesis/public facts verification.
No deployment, network execution or changes to utility, liquidity, airdrop,
public sale, governance or CCIP are authorized by this slice.

The committed `ReserveController` implementation funds existing `GrantVault`
instances atomically, binds one purpose and controller, and counts full grant
amounts in `(now - 365 days, now]`. Refunds preserve consumed cap authority.
Caps are immutable explicit constructor inputs, not invented production defaults.
This corrects the historical statement below that no reserve implementation
exists; it does not establish completed production wiring or qualification.
The implementation also includes a one-shot 3% founder funding reserve and strict
offline configuration verification/public facts. The 20% envelope is represented
as separate 3% founder and 17% contributor recipients. The other six bucket IDs
are explicit approved input, not inferred product policy. Facts bind normalized
configuration to a separately selected hash and explicitly do not prove deployment.
Offline founder calendar anniversaries reuse the existing 12/48-month validator.
Both funding contracts now enforce Gregorian UTC anniversaries onchain; leap-day
cliff/end instants must consistently select February 28 or March 1. A local
constructor-order fixture proves direct genesis routing, the 3%/17% split,
founder irrevocability, refund routing and conserved supply. This is not deployed
production evidence. ADR-0008 records the reserve policy; full qualification
and deployment evidence remain pending. Deployment artifact generation and actual
deployment are outside this bounded slice.
The requested allocation's bucket identities and numerical cap policy must be
bound to their approved source before production inputs can be accepted.
Founder reserve construction rejects an identical beneficiary and controller;
this separates bound addresses, not beneficial wallet ownership. Actual deployment,
deployment artifacts, production addresses, caps and dates, and Safe qualification
remain pending. The earlier uncommitted-patch delivery instructions below are
historical; the reserve implementation is committed. Fresh exact-SHA security
and rollback evidence is a separate follow-up after this remediation commit.

## Grant custody qualification, 2026-09-16

The bounded qualification starts from `3ff3d11a70bab96d27e9979ccbb16250a27bc788`.
It retains GrantVault, GrantAccounting, deployment configuration and the existing
custody/Safe utilities. Only constructor-kind validation and proven Safe
qualification gaps may change production behavior; the remaining work is
adversarial evidence and operational documentation. This task is local-only;
the historical public-network authorization below does not apply to it.

Confirmed corrections: funding is permitted **through** the start timestamp
(`timestamp <= start`), while configured operational lead time is stricter.
Approval may precede funding; the full reserve pull and activation are atomic
inside `fund()`. Beneficiary address immutability does not freeze wallet control.
Team cancellation uses its successful transaction timestamp, not a departure,
scheduling or signing timestamp. The selected custody baseline is solo-founder
Safe 2-of-3; older independent 3-of-5 governance descriptions remain proposals.
ADR-0006 remains proposed.

Historically, this September 16 custody-only slice did not include production
purpose-specific reserve enforcement. The committed `ReserveController` now
enforces per-grant and rolling 365-day gross commitment caps without restoring
authority on refunds; production wiring and qualification remain pending.
A refund to the original address proves routing only. It must not restore consumed spending
authority merely by increasing reserve inventory. Qualifying that behavior
requires evidence from the real reserve implementation; an EOA, Safe or
mock cannot establish it. No cap window, amount or reserve platform was selected
or implemented in that historical custody-only task. The prerequisite and its
acceptance cases belong to [Post-custody operations](architecture/post-custody-operations.md).

Official Safe artifacts and actual local two-signature execution are required
for Safe qualification. Synthetic inspection and creation evidence do not prove
later custody execution. Current Safe state also cannot establish clean setup:
qualification requires a separately selected finalized initialization transaction
and authenticated state at that block. This bounded reader supports direct Safe
setup; factory/batched initialization remains unqualified. Keep `CUSTODY_TRANSITION_PROVENANCE_UNPROVEN` and the
existing narrower readiness meaning. Missing artifacts/native prerequisites
must fail qualification visibly. The historical custody task requested a reviewable
uncommitted patch; that is not the current delivery state. Fresh committed-candidate
Slither/rollback evidence follows separately from this remediation.
Amounts, addresses, reserve caps, signer identities, recovery arrangements and
exact UTC deployment values remain configuration and release gates.

## Active post-custody implementation, 2026-09-15

The reviewed four-feature plan is being implemented from exact base
`17136dc08fc928f3cebc6af89215e31f6f2bb537`: validated deploy-time configuration,
resumable owned-testnet custody proof, read-only Ethereum/Solana readiness and
deterministic manifest-derived passport/authority registry. The immutable token,
GrantVault and GrantAccounting remain the onchain authorities. No supply,
allocation, recipient, reserve limit or UTC schedule is a production default.

Local calendar proofs use controlled Anvil time. Later owned-Sepolia proofs use
explicitly accelerated test-only schedules and ordinary chain time. Offline
captures and mocked deliveries do not establish public-chain CCIP E2E. Readiness
and compilation produce unsigned artifacts and structurally forbid broadcast.
Missing mainnet deployments, protocol qualification or product inputs remain
explicit unresolved requirements. Production reserve wiring and bridge timelock
policy remain release prerequisites.

Corrections to the reviewed plan: its passport command remains redacted; the
concrete alias will be `pnpm token:passport`. Compilation needs explicit
`--artifacts` pins; `deployment:config materialize` turns verified creation
evidence into the manifest. These fill missing command arguments/steps without
changing acceptance. That historical implementation task requested an uncommitted
patch followed by orchestrator review, commit and committed-candidate/rollback
qualification. The implementation is now committed; qualification still requires
evidence bound to the exact candidate. ADR-0006 is still proposed; merged
custody code does not accept it. The owner-approved custody semantics in
DECISIONS remain applicable while its ADR lifecycle is resolved through the
repository documentation process. Historical scope and proof below are retained
as historical records, not qualification of the new implementation.

The sandbox is offline. Retained pinned tool archives can be copied and verified
locally; missing Safe/native-provider/Linux prerequisites must remain visible.
No mainnet transaction or production secret is authorized. Final owned-testnet
execution and independent exact-candidate review belong to later orchestration.

Exact-review correction: deployment evidence v1 binds creation only, not later
custody transitions. Offline `custody:verify` must therefore fail closed with
`CUSTODY_TRANSITION_PROVENANCE_UNPROVEN`; arithmetic checks alone cannot claim a
finalized transaction. Current passport checks require explicit canonical UTC
seconds through `--now`; archival generation makes no freshness claim.

The pinned cast 1.8.0 keystore path has an additional native prerequisite found
while qualifying two ephemeral test signatures: it requires the existing user
home location even with an explicit absolute `--keystore`. The narrow subprocess
environment now preserves only that existing `HOME` alongside PATH/LANG; no home
is reassigned, no default account is selected, and no environment is published.
The keystore and password-file arguments remain explicit test-only inputs.

## Approved contributor-grant custody slice, 2026-09-15

Current owner-approved rules: individual founder/team schedules are zero through
month 12, then linear from zero to full at month 48. Founder grants cannot be
revoked. On departure, team service grants may return only unvested value to
their original purpose reserve; vested-but-unclaimed value remains owed. Safe
2-of-3 is selected with one beneficial controller, not independent governance.
See [owner decisions](DECISIONS.md#owner-decisions-2026-09-14) and
[revocation](DECISIONS.md#grant-revocation-decision-2026-09-14).

The active delivery adds one immutable `GrantVault` per grant around the existing
`GrantAccounting` library. Each vault binds the ERC-20, beneficiary, originating
reserve, controller, allocation, kind and exact UTC schedule at construction;
only the reserve can atomically fund the full allocation. The beneficiary can
release vested tokens only to the bound address. The controller is an immutable
address intended for the selected Safe 2-of-3 and may cancel only a funded team
grant at the transaction timestamp. Cancellation returns only unvested tokens to
the bound originating reserve and leaves vested-but-unreleased tokens claimable.
Founder cancellation remains permanently forbidden.

This custody slice does not implement or certify Safe signatures, a timelock,
reserve budget/cap accounting, beneficiary or controller replacement, a factory,
governance, production genesis wiring or deployment. Amounts, purposes, parties
and exact UTC instants remain constructor/deployment inputs; percentages and
production supply remain proposals. The prior direct-genesis-mint vesting flow
cannot activate this reserve-funded vault and requires later production wiring.
No framework, dependency, airdrop, sale, Solana, CCIP or broadcast change is part
of this delivery.


## Активная продуктовая граница, 8 сентября 2026

Владелец прямо поручил изменить план и автономно доставить полезный продуктовый
результат без повторных approvals. Этот раздел заменяет прежний local-only scope
и порядок, требовавший сначала завершить весь отдельный цикл локальных ревью.
Исторические результаты сохраняются; неподтверждённые ревью не объявляются принятыми.

**Текущий результат: реальный AGTMAI testnet round trip Ethereum Sepolia ->
Solana Devnet -> Ethereum Sepolia через официальный Chainlink CCIP CCT,
с проверкой backing/supply и читаемым статусом каждого сообщения.**

Разрешены автономно: реализация, независимый технический review, test-only keys,
публичный testnet RPC, faucet requests, deploy/register/configure стандартных
pools, testnet transactions и проверка их фактического исполнения. Агент сам
проверяет decoded operations, адреса, chain identity, лимиты и состояние до
подписания; отдельное подтверждение владельца на каждый тестовый шаг не нужно.
Расход реальных денег, mainnet operations и mainnet keys не входят в этот этап.
Faucet assets не являются бюджетом mainnet и не покупаются за реальные деньги.

Сохраняются: AGTMAI, decimals 9, immutable fixed-supply Ethereum ERC-20 без
post-deploy mint, LockRelease на Ethereum, стандартный SPL Token и официальный
self-service BurnMint pool на Solana, initial remote supply 0, freeze None.
Тестовые supply и recipients берутся из явно test-only fixture и не принимают
production allocations/rights. Никакого собственного bridge, relayer или program.

### Продуктовая testnet приёмка завершена, 8 сентября 2026

Все три сообщения E->A, A->E и E->B по 1 AGTMAI settled. PUBLIC
`product-final-three-message-proof-success.json` фиксирует coherent fresh snapshot
`2026-09-08T05:04:14.470Z`: F=100, L=1, S=1, pending=0, backing surplus=0;
Ethereum height 11658930, Solana slot 494943575. Native finalized effects связаны
с точной SDK message identity. `product-final-balances-and-b-ata-proof.json`
на `05:04:59.366Z` подтверждает E wallet=99, A=0, B=1 AGTMAI, B native SOL=0.
B не финансировался и не подписывал транзакции. ATA создан отдельно стандартным
Associated Token Program перед официальным автоматическим Execute, тем же
payer/signer; ATA не создавался CPI OffRamp. Точные IDs, balances и fees:
[ledger/runbook](../tooling/testnet-ccip/transfer-status.md#public-transfer-ledger).
B approval nonce 8 и send nonce 9 succeeded; inventory всех трёх сообщений
полный. Сохранять journals; source transfers никогда не повторять.

Первый E->A восстановлен вручную по исходному message. Reverse API всё ещё
HTTP 404, но UNTRUSTED `destinationReceipt: {transactionHash, offRamp}` позволяет
discovery с обязательной native/SDK authentication, finality, effects и binding.
Обычный full native status CLI успешно проверяет все три settled сообщения.
P2 stale snapshot исправлен в `1f44039`, независимый review ACCEPT: Ethereum
не старше 30 минут, Solana не старше 5 минут; missing/future/invalid/stale
timestamps запрещают exact accounting. Реальный Solana RPC 429 с Retry-After 10
обработан в `d06f816`: ровно один retry, максимум 10 секунд, только allowlisted
read-only methods, без write retries. SDK уже фильтрует InProgress.

31 status/RPC test passed; на `3fd2fd3` default suite 171 tests, 0 skips,
lint 0 diagnostics и typecheck pass. Deployed-pool negative rate-limit `eth_call`
остаётся simulation, не broadcast router rejection. Main `370c` интегрирован
в `255138f`; burn review `8e` ACCEPT, artifact approval ACCEPT_REFRESH;
`e403d49` прошёл 141 local-EVM + 7 native checks. Полный `pnpm check` на
`ab69885` прошёл, включая 416 rollback tests с 1 skip. Последующий sealed proof
остановился только на forge fmt двух test statements; исправлено в `c370232`.
Повторный sealed proof, final-head Linux/CI и итоговый review ещё требуют
release evidence; результаты прежних SHA не доказывают новый HEAD.
Product testnet acceptance complete; delivery qualification остаётся отдельной.
Это fixture 100 AGTMAI, не production launch; mainnet вне scope, MVP не расширен.

### Подтверждённый формат Solana registry, 8 сентября 2026

Реальный owner-propose-administrator создал TokenAdminRegistry v2: 170 bytes,
последний byte 169 - canonical bool supports_auto_derivation (false в этом flow).
IDL generator 0.5.1 описывал старый v1/169 и не доказывает формат live account.
Официальный source `c73892d4d33926195eee87b77013883e650a833c` создаёт v2;
accept-admin и set-pool требуют v2. Проверять строгий v2, без fallback к v1
и без игнорирования trailing bytes. Router Config при этом остаётся v1.
Это исправление verifier, не повторное предложение администратора: исходная
proposal transaction уже finalized успешно и должна быть reconciled по её ID.

### Подтверждённая аллокация Solana ChainConfig

Реальная init-chain-remote-config финализирована в slot 494854806: пустой
pool vector выделяет 147 bytes при payload 115, поскольку token max_len(64).
EVM remote token остаётся ABI32; remote pool должен быть raw20, поэтому
канонический account занимает 171 bytes (payload 139 и slack 32).

### Подтверждённая ошибка source pool encoding, 8 сентября 2026

Исторически первый Sepolia -> Solana перевод финализировался на source и заблокировал
1 AGTMAI, но destination завершился InvalidSourcePoolAddress (6007), supply Solana 0.
Фактический CPI передаёт raw20 pool `24508e2eb3bedc086318abc054153fd83823a4e2`,
а append сохранил padded32. Официальный common.rs сравнивает Vec побайтово.
Исправление: fresh append raw20 и отдельный `repair-remote-pool-encoding` через
официальный edit_chain_remote_config; старый append32 journal исторический,
его нельзя переписывать или повторять. Repair сохраняет token ABI32, decimals 9,
точные rate buckets, mint authority, supply 0, registry и существующий ALT.

Read-only simulation official edit в slot 494886698 успешна: 183 -> 171 bytes,
оба rate buckets неизменны. realloc::zero=false оставляет строго доказанный slack
`0200000000ca9a3b000000000000000000000000000000000000000000000000`.
Fresh account допускает zero slack; произвольные trailing bytes запрещены.
Эта simulation сама по себе не доказывала onchain repair или доставку.
Теперь официальный edit финализирован с signature
`N2Ch32vM2j5ATjUTdSTa8JtRGuZX3sv47dz8MLfAwodV8bgPXrzGnikUCQ92S8SmhFUJyEvfpU1xJPsmECx75qJ`.
Исходный message исполнен вручную, без replacement source transfer: signature
`4apQ7wSFwRSRtbMRdmEPe9eko6VawQrJnktmStGe8qsAGpQcEWevGy8W9dNAao4SkGPcdPW8Y9wgpZVh8Q4rKcEk`.
Native finalized proof подтверждает mint, затем reverse pool burn и Ethereum release.

### Порядок доставки

1. Зафиксировать совместимую protocol line и проверенные текущие Chainlink
   addresses/programs/artifact versions в узком ADR и testnet manifest. Проверить
   registration path существующего immutable token, а не подменять его mintable
   tutorial token. Не мигрировать все bounded contexts ради этого сценария.
2. Реализовать тонкий testnet deployment/transfer path с существующими provider
   tools: chain allowlist, decoded intents, ограниченные approvals, durable tx IDs,
   read-before-write reconciliation. При неизвестном результате сначала искать
   исходную транзакцию; не отправлять повторно автоматически.
3. Реализовать accounting/status непосредственно для этого flow: identity каждого
   сообщения, finalized source/destination evidence, duplicate/conflict detection,
   pending/manual execution, stale/unknown/reorg и backing discrepancy. Статус CLI
   или минимальная read-only страница достаточны; отдельный dashboard не нужен.
4. Выполнить настоящий round trip, второй recipient/ATA path и bounded negative
   rate-limit сценарий. Сохранить source tx, message ID, destination tx, amounts,
   fees, authorities и balances до/после. Mock tests не заменяют CCIP delivery.
5. Совместить проверенную работу с актуальным main, сохранив Docs Protocol 0.2,
   Foundation 0.20 и ReviewRouter; focused regression и итоговый CI, независимый
   review продуктового изменения, PR и воспроизводимый runbook.

### Приёмка и запрет расширения

Готово только когда реальные сообщения обоих направлений достигли destination,
согласованы finality и authorities, нет необъяснимого mint/release/duplicate,
после settlement pending=0 и L=S, а F-L+S+P_ES+P_SE=F. Unknown/stale/inconsistent
не показываются как success. Источники данных, hash/version и tx IDs проверяемы.
Pending не исчезает по timeout; resumption не дублирует исходный transfer.

Уже пройденные Mac20, Linux check:linux, sealed rollback и Docker Slither для
75418030 сохраняются как evidence именно этого SHA. Незавершённый исторический
набор четырёх specialist + holistic не блокирует независимую продуктовую работу.
Для затронутых рисков обязательны focused tests и независимый review; полный
pipeline повторяется при изменении его входов/обязательном финальном CI, а не
как ритуал перед каждым patch. Старое evidence не объявляется проверкой нового SHA.

За scope: mainnet launch, liquidity/DEX, продажи/airdrop, tokenomics/vesting,
новая governance platform, branded frontend, новые сети и developer frameworks.
Новый инструмент допускается только для конкретного риска активного flow.
Если provider/faucet недоступен, фиксировать точный невыполненный шаг и продолжать
независимую реализацию; не заменять настоящий E2E симуляцией и не объявлять запуск.

Нижние roadmap-разделы сохранены как контекст и backlog. Их прежние local-only
запреты и per-operation human testnet approvals заменены этим поручением;
mainnet, supply и key-инварианты остаются в силе.

## Уточнение snapshots и публикации, 5 сентября 2026

Это уточнение заменяет устаревшие утверждения ниже только для текущего
кандидата; исторические результаты сохраняют свой исходный объём проверки.
Полный [NEXT_ZERO_COST_SLICES_PLAN](NEXT_ZERO_COST_SLICES_PLAN.md) и его
[критический разбор](research/NEXT-ZERO-COST-SLICES-PLAN-CRITIQUE-2026-08-29.md)
сохраняются без сокращения целей и критериев принятия.

- Подтверждённая ошибка: authenticated Solana snapshots нельзя размещать
  внутри immutable tool installation или области рекурсивной очистки run store.
  Отдельный lease `.authenticated-tools-*` рядом с `run-*` удерживает копии
  до подтверждённого завершения всех пользователей инструментов. Строгий отказ
  bootstrap при лишних файлах корректен и не ослабляется. Успех с READY требует
  завершённой очистки; неизвестные или подменённые ресурсы сохраняются с явной
  ошибкой. Закрытие lease терминально, каждый дескриптор закрывается один раз.
- Публикация Slither эксклюзивно резервирует каталог, копирует проверенные файлы
  ограниченными блоками и публикует пустой READY через hardlink с удержанием
  дескриптора staging-файла; после удаления staging-ссылки READY имеет одну ссылку.
  Он остаётся отзываемым до завершения staging cleanup и CLI finalization.
  Первый родительский SIGINT/SIGTERM сохраняет exit 130/143; отмена не публикует
  вторую failure envelope. Очистка exact container ID независима от отмены;
  подмена или неопределённость очистки сохраняет объекты и сообщает ошибку.
- Пути тестовых fixtures нужно канонизировать через `realpath` до передачи в seams:
  `/tmp` и `/private/tmp` на Mac не взаимозаменяемы при проверке идентичности.
  Ни SIGKILL/host-crash recovery публикации, ни отсутствие same-UID гонок между
  последними проверками и syscalls не доказаны. Текущие результаты и оставшиеся
  полные проверки обеих платформ перечислены в [STATUS](STATUS.md).

## Уточнение проверки восстановления, 4 сентября 2026

- Подготовка архива не должна передавать результат до успешного закрытия
  исходного файла. При ошибке закрытия подготовленное дерево очищается по уже
  удерживаемой идентичности; исходная ошибка проверки или копирования остаётся
  первой, ошибки закрытия и очистки не теряются. Если обновление снимка дерева
  не удалось, неизвестные файлы сохраняются, а открытые ресурсы освобождаются.
  Это подтверждённая регрессия подготовки архива, не доказательство полного
  восстановления установки после публикации и не принятие всей recovery-ветки.
- Проверка Node разделяет чтение проверенных файлов и проверку загруженного
  процесса. Чтение не передаёт открытый файл вызывающему коду, пока закрытие
  родительского каталога не завершилось успешно. Итоговое завершение проверяет
  все открытые ресурсы и очистку подготовленного архива даже после ошибки
  закрытия исполняемого файла или корневого каталога. Исходная ошибка остаётся
  первой; повторное закрытие использованного номера файла запрещено.
  Проверка реального образа процесса на Linux остаётся обязательной; отсутствие
  соответствующей проверки на macOS нельзя обходить ради зелёного результата.
- Проверка состава каталога и подготовка файлов Git обязаны соблюдать те же
  правила завершения: не терять исходную ошибку, закрывать каждый ресурс один
  раз и освобождать остальные ресурсы после сбоя одного закрытия. При переходе
  между каталогами владение новым дескриптором принимается до закрытия старого,
  иначе ошибка закрытия старого может потерять новый и повторно закрыть чужой.
  Для обхода каталога также сохраняется ошибка чтения перед ошибкой закрытия
  итератора. Это часть 120/P1-4; Node runtime квалифицируется отдельно по тем же
  правилам. Полное принятие восстановления ещё требует независимой проверки.
- Открытие каталога передаёт владение файловым дескриптором вызывающему коду
  только после проверки типа, определения канонического пути и регистрации
  идентичности. Сбой любого из этих шагов закрывает уже открытый дескриптор
  ровно один раз и сохраняет исходную ошибку перед ошибкой закрытия.
  Это часть замечания 120/P1-4; остальные пути закрытия в runtime ещё открыты.
- Запись журналов команды также является одной операцией владения ресурсами:
  ошибка открытия второго журнала или подготовки запуска закрывает все уже
  открытые журналы. Закрытие каждого файла выполняется один раз. Ошибка команды
  сохраняется перед ошибками закрытия и записи результата; код завершения 0
  сам по себе не даёт статус успешной проверки при ошибке закрытия журналов.
  Это отдельное исправление замечания 120/P1-3; защита самого каталога результатов
  от подмены остаётся следующей задачей и не считается здесь реализованной.
- Полная итоговая команда на Linux: `pnpm check:linux`. Она выполняет проверку
  закреплённых инструментов, `pnpm check` и затем полный сценарий отката.
  Один `pnpm check` включает тесты отката, но не доказывает полный сценарий.
  Исправлены соответствующие формулировки исполнительного плана и инструкции.
- Критик 120 подтвердил ошибку: сбой закрытия файлов рабочего каталога мог
  скрыть исходную ошибку проверки и ошибку очистки. Завершение обязано сохранить
  их порядок: исходный сбой, очистка, закрытие. Повторно закрывать уже
  использованный файловый дескриптор запрещено; ошибка закрытия не даёт статус
  успешного завершения, даже если удаление временного каталога уже выполнено.
- Исправление проверяется отдельно в изолированном кандидате. Это не принятие
  всей системы восстановления: удержание каталога результатов, неполное
  создание ресурсов, остальные пути закрытия и проверка загруженного Node
  на macOS остаются открытыми. Токеномика и блокировки токенов не меняются.

**Дата контекста:** 27 августа 2026 года  
**Статус:** living document; изменения архитектуры фиксируются здесь и в ADR  
**Режим работы:** пользователь сейчас на связи, но ожидает, что ты будешь работать преимущественно автономно и обращаться к нему только в согласованных точках принятия решений.  
**Главная цель:** довести проект от продуктовых решений и гибридной local/CI-среды до полностью проверенного testnet E2E, frontend/dashboard и подготовленного mainnet deployment. Mainnet-действия выполняются только после человеческого просмотра и подписей.

> ⚠️ Этот файл перенесён из исходного handoff. При обнаружении подтверждённой ошибки она исправляется в этом документе сразу, а существенное решение дополнительно получает ADR. Git history остаётся audit trail исходных формулировок.

## Уточнение исполнения, 4 сентября 2026

Обновление15:45 UTC: вариант Solanaabf837 закрывает каждый файловый дескриптор
только один раз. Если публикация уже состоялась, а завершение дало ошибку,
команда сообщает отдельный неуспешный результат и не повторяет публикацию.
Эту семантику ещё проверяет126: это не разрешение ослабить условия READY.
79 Mac-тестов прошли,5 только для Linux; дополнительно13/13 тестов запуска.
Критик122 нашёл ещё три ошибки публикации Slither; исправляет125.120 проверяет
основание восстановления целиком. План объединения с main сохранён отдельно,
но объединение не выполнено. Полный исходный E2E остаётся незавершённым.

Обновление15:28 UTC: Slither e9292 прошёл141/141 тест, проверяет122.
Исправление восстановления47fe принято118, полное основание проверяет120.
Черновик Solana119 не применён: повтор закрытия после ошибки небезопасен,
поскольку файл уже мог закрыться.123 исправляет это без повтора и ложного
успеха.121 готовит безопасное объединение с двумя изменениями в main.
Все четыре задания активны в fast-режиме; полный E2E ещё не принят.

Обновление15:12 UTC: расширенный набор восстановления47fe прошёл50/50
без пропусков, проверяет118. Черновик Slither114 не применён: удаление только
по принадлежности каталога недостаточно защищает посторонние вложенные файлы;
117 исправляет это вместе с сохранением ошибок очистки и поздней отменой.
Критик Solana116 подтвердил прошлые исправления, но нашёл два оставшихся P2:
закрытие файлов уже после READY и короткий переход завершающегося процесса.
Их исправляет119. Linux-прогон73/74 не считается успешным общим E2E.

Обновление15:05 UTC: Solana6b877 проверяет файл конфигурации непосредственно
перед использованием и убирает собственный READY при ошибке публикации,
сохраняя чужой заменённый файл.69 тестов прошли, пять только для Linux;
проверяет критик116. В Slither отмена всё ещё могла попасть между последней
проверкой и записью успеха:114 исправляет это окно. Исправление закрытия файлов
восстановления7437 принято113, но115 устраняет отдельно доказанную ложную
ошибку при обычном изменении соседних файлов в родительском каталоге.
Проверки самого принадлежащего запуску каталога останутся строгими.
Общий исходный объём плана не сокращается, полный E2E ещё не завершён.

Обновление14:56 UTC: файловые исправления Ethereum приняты критиком109 и
включены в проверочную ветку31e909f7. Новый тест очистки добавлен в общую
команду; проверка типов и линтер прошли, настоящий общий EVM-прогон86/86,
без пропусков, включая семь реальных сценариев жизненного цикла.
Slitherb74e прошёл135/135 Mac-тестов и проверяется критиком112. Критик108
нашёл три конкретных пропуска публикации и проверки конфигурации Solana;
их исправляет111. В восстановлении7437 прошли15/15 узких тестов, но общий
набор дал46/47: проверка метаданных родительского каталога нестабильна.
Это отдельно проверяет113; старое основание восстановления не принято.
Все три новые работы идут на старом сервере в fast-режиме. Полный E2E
и исходная матрица требований остаются открытыми; подробности в свежем журнале.

Текущая задача ограничена тремя локальными блоками из
[`NEXT_ZERO_COST_SLICES_PLAN.md`](NEXT_ZERO_COST_SLICES_PLAN.md).
Исторические зелёные проверки не подтверждают текущий изменённый код:
исправление инструментов уже принято отдельным ревью и интегрировано.
Исправления Foundation, TypeScript, линтера и ограничений JSON уже приняты
ревью и интегрированы; настоящие Mac/Anvil проверки прошли. Два прежних
замечания P2 к local-EVM и новая ошибка очистки данных во вложенной ошибке
закрыты независимым ревью и интегрированы. Общий Mac/EVM прогон на
`b95c66be` прошёл 7/7 без пропусков.
Проверка точных байтов Solana принята независимым ревью и интегрирована в
`e723bc0d`; настоящий локальный цикл прошёл 4/4 без пропусков. Файловое
восстановление `ff44c448` прошло 33/33 расширенных Mac-тестов, но независимый
критик92 нашёл непокрытую ошибку закрытия файлов. Работник95 исправляет все
подтверждённые пути: каждый дескриптор закрывается только один раз, сбой одного
не мешает закрыть остальные. Черновик Slither91 ещё не принят. Он ограничивает время всех
подпроцессов и завершения контейнера общим сроком; при неподтверждённом
завершении возвращается явная ошибка, не ложный успех. Это не обещает остановить
зависшее ядро, злонамеренный Docker или произвольный неотменяемый callback.
Механизм проверки отката остаётся
непринятым; новый изолированный работник исправляет файловую часть.
Обнаружено, что копия исполнительного плана в текущем кандидате не содержит
значительную часть дополнений исходного пользовательского файла за 31 августа
- 3 сентября. Независимый работник сверил эти требования с кодом;
полная таблица сохранена в
[`ORIGINAL-PLAN-INVARIANT-AUDIT-2026-09-04.md`](research/ORIGINAL-PLAN-INVARIANT-AUDIT-2026-09-04.md).
Открыты также проверка точных байтов Solana, восстановление старых локальных
запусков, ограничения процессов Slither, проверка используемых файлов и полный
прогон обеих платформ. Нельзя сокращать scope до отката или переносить старые
отклонённые ветки без проверки. Работники85/86 исправляют отдельные замечания
к восстановлению и Solana. Локальные18/18 тестов файлового исправления прошли,
но независимый критик оставил четыре других замечания к его основанию.
Подробности и точные коммиты зафиксированы в
[`E2E-RECONCILIATION-2026-09-04.md`](research/E2E-RECONCILIATION-2026-09-04.md).

Подтверждённое ограничение L5: старый Solana lease v3 не сохранял привязку
к корню, папке запуска и файлу. Копию такого маркера нельзя отличить от
подлинной старой папки. Поэтому требование автоматически удалять старые v3
запуски несовместимо с текущими гарантиями. Они остаются нетронутыми; нельзя
придумывать недостающую привязку или автоматически превращать v3 в v4.
Расширение доверия ко всем процессам того же пользователя требует отдельного
решения владельца. L5 остаётся открытым ограничением, а не выполненным пунктом.
Это не блокирует безопасные проверки и исправления текущего v4 и EVM.

14:20 UTC: критик99 нашёл оставшиеся ошибки в промежуточном закрытии файлов
и вызывающих функциях;101 исправляет весь подтверждённый набор. EVM1f4fc8d8
проходит7/7 настоящих Mac-сценариев, Slitherfb416ec1 проходит130/130 тестов.
Оба прошли TypeScript и линтер, но ожидают независимых критиков103/104.
Solanaa2261b36 проходит21 тест с одним Linux-only пропуском;102 получает
подтверждённые пробелы проверки файлов до и после отметки READY. Новые тесты
очистки EVM необходимо подключить к общей команде проверки при интеграции.
Запуск новых задач задержал контроль свободного диска; удалены только11
повторных копий Node завершённых задач, не исходники или результаты.
В14:22 проверено:102/103/104 работают,101 завершился и ожидает проверки результата.
В14:27 результат101 применён:598b5788 проходит41/41 Mac-тестов и линтер.
Его проверяет отдельный критик105; до результата не считать принятым.
Ни одно из этих новых исправлений пока не считается принятым.

В14:40 независимые критики103/104 подтвердили ещё четыре ошибки: три связаны
с корректной отменой Slither и одна с зависанием EVM при подмене файла каналом.
Их исправляют106/107. Критик105 уже действительно работает над восстановлением.
Solana80bbca47 прошла31 проверку с одним Linux-only пропуском после исправления
несовместимого синтаксиса, удержания файлов до финальной проверки READY и
обработки ошибок закрытия. Готовится независимое ревью108. Счётчики тестов не
заменяют принятие кода или итоговый E2E. Новые тяжёлые копии инструментов на
перегруженном дисковыми операциями сервере не создаются без необходимости.

В14:45 EVM25b33245 прошёл39/39 проверок на Mac и передан критику109.
Критик105 подтвердил изменённые пути, но нашёл ещё два старых пропуска в
реально вызываемых файловых функциях; их исправляет110. Работник106 завершён,
его исправление Slither ещё нужно применить и проверить.108 продолжает ревью
Solana.108/109/110 подтверждены как работающие задачи в fast-режиме.

С 4 сентября следующие hosted jobs используют fast: реализация
`gpt-5.6-sol medium`, планирование/ревью `gpt-5.6-sol xhigh`.
Текущие no-fast jobs продолжаются без перезапуска. Независимость ревью означает
отдельные jobs/сессии без участия в авторстве проверяемого кода; разные
subscription-аккаунты не являются дополнительным условием плана.

Нельзя считать завершённым работника только по статусу launcher: нужны
запуск модели, завершённый результат, проверенный чистый коммит и независимые
проверки. Незавершённые изменения четырёх quota-limited работников сохранены
в отдельных workspace и не интегрированы. Продолжение начинается с чистого
подтверждённого коммита, не с этих незавершённых деревьев.

Исторический этап ниже не реализовывал вестинг. Текущий согласованный
accounting slice описан в начале плана: график и правила отзыва уже приняты;
проценты, получатели, публичные полномочия и запуск остаются отдельными решениями.

Запрещённые anti-patterns и уже подтверждённые исторические ошибки собраны в
[`NON_NEGOTIABLES.md`](NON_NEGOTIABLES.md). Любая реализация и review обязаны
проверять этот список как acceptance contract.

Проект release/vesting contracts, их role graph, onchain limits и честные
границы гарантий ведутся в [`CONTRACTS.md`](CONTRACTS.md). Спорные policy vaults,
governance activation и production genesis wiring не реализуются до отдельных
продуктовых решений. Переиспользуемое local-only ядро - strict manifest,
immutable ERC-20 и verifier с тестами - выполняется по
[`GENESIS_CORE_LOCAL_PLAN.md`](GENESIS_CORE_LOCAL_PLAN.md) без фиксации
токеномики или mainnet ABI. Самостоятельный no-catch-up vesting primitive
остаётся следующим отдельным slice и не входит в обязательный Genesis Core.

---

# 1. Как взаимодействовать с пользователем

Не повторяй вопросы, ответы на которые уже зафиксированы ниже.

Работай по следующей модели:

1. Сначала прочитай весь handoff.
2. Проверь актуальность официальной документации, версий, chain selectors, program IDs и ограничений сервисов.
3. Создай:
   - `docs/DECISIONS.md`;
   - `docs/OPEN_QUESTIONS.md`;
   - `docs/STATUS.md`;
   - каталог `docs/decisions/` для Architecture Decision Records.
4. Задай пользователю **одним сообщением один пакет продуктовых вопросов уровня P0**, перечисленных ниже.
5. Пока пользователь отвечает, не простаивай:
   - исследуй актуальные версии;
   - инициализируй репозиторий;
   - подними Docker;
   - подготовь конфигурации;
   - реализуй локальные тесты с безопасными test-only параметрами.
6. Не отвлекай пользователя из-за каждой команды или несущественного выбора. Используй рекомендованные defaults для local/testnet и документируй их.
7. Перед каждым необратимым или платным действием покажи:
   - сеть;
   - адреса;
   - decoded operation;
   - ожидаемый state diff;
   - комиссию;
   - влияние на бюджет;
   - возможность отката;
   - необходимые подписи.
8. Обновляй пользователя после завершения логического этапа, а не после каждой транзакции.
9. Если внешний сервис, faucet или RPC недоступен, продолжай всё, что не зависит от блокера, и записывай ровно один конкретный следующий шаг в `NEEDS_INPUT.md`.
10. Никогда не скрывай, что именно было реально исполнено, что симулировано, а что замокано.

Проверенная evidence snapshot не задаёт единый production Solana CCIP baseline
`1.6.3`: Router, BurnMint и LockRelease точно совпадают с
`solana-v1.6.2`, OffRamp и RMN — с `solana-v1.6.3`, а Fee Quoter не имеет
точного совпадения среди supplied `solana-v1.6.0`–`solana-v1.6.4` artifacts и
блокирует qualification. Directory lane labels `1.6.0` не доказывают artifact,
compatibility, enabled configuration или authority. См. proposed
[ADR-0007](decisions/0007-mainnet-protocol-line-for-agtmai-readiness.md);
перед public-network operation требуются fresh official directory и
independently reviewed exact artifacts.

---

# 2. Контекст проекта и история выбора

Пользователь хочет запустить токен своего проекта сразу в нескольких сетях, чтобы:

- supply оставался глобально контролируемым;
- у пользователей не появлялись конкурирующие wrapped-версии;
- токеном было удобно торговать;
- управление сетью, ролями и лимитами было понятным;
- можно было добавить frontend и dashboard;
- не писать собственный bridge, relayer, consensus или Solana bridge program;
- сохранить техническую гибкость;
- уложиться в очень маленький стартовый бюджет.

Пользователь технический, имеет опыт программирования и IT. Сложные CLI, Foundry, TypeScript, Docker, Solana tooling и config-as-code приемлемы, если они уменьшают риск и не превращают проект в самописный bridge.

## Рассмотренные варианты

Рассматривались:

- Wormhole NTT;
- LayerZero OFT;
- Chainlink CCIP CCT;
- Axelar ITS;
- Hyperlane Warp Routes;
- Base, Ethereum, Solana, Avalanche и другие сети.

Итоговый выбор:

- **Ethereum L1** — каноническая сеть и источник fixed supply;
- **Solana** — пользовательская и торговая сеть;
- **Chainlink CCIP Cross-Chain Token** — cross-chain инфраструктура;
- **Lock & Mint** из Ethereum в Solana;
- **Burn & Unlock** из Solana обратно в Ethereum.

Причина отказа от Base как canonical chain: пользователь предпочитает не L2, а Ethereum L1 при нынешней низкой стоимости газа. Base можно добавить позже как remote network, но он не нужен для первого запуска.

Причина выбора CCIP: на Solana доступен рекомендуемый self-serve режим стандартных BurnMint/LockRelease pool programs, которые поддерживаются через CCIP governance. Проект инициализирует состояние своего пула, но не пишет и не обслуживает собственную Rust bridge program. Стандартные pools уже реализуют cross-chain accounting, decimal conversion, rate limits и access control.

---

# 3. Зафиксированные решения

| Область | Решение |
|---|---|
| Canonical chain | Ethereum Mainnet |
| Remote/trading chain | Solana Mainnet |
| Cross-chain protocol | Chainlink CCIP CCT |
| Модель Ethereum → Solana | LockRelease на Ethereum + BurnMint на Solana |
| Модель Solana → Ethereum | Burn на Solana + Release на Ethereum |
| Ethereum token | Простой immutable fixed-supply OpenZeppelin ERC-20 |
| Solana token | Обычный SPL Token, не Token-2022 |
| Decimals | 9 в обеих сетях |
| Начальный remote supply | 0 на Solana |
| Upgradeable token proxy | Нет |
| Transfer tax/reflections/rebase | Нет |
| Blacklist и скрытые admin-функции | Нет |
| Token-level pause | Нет |
| Solana freeze authority | None |
| Ethereum trading pool на старте | Нет |
| Solana trading pool | Один experimental TOKEN/USDC pool; venue выбирается по полной стоимости и безопасности |
| Devnet liquidity | $0 real money; 50–100 units of fake USDC + faucet test tokens |
| Mainnet founder cash | Не более $100 total, включая создание pool и quote liquidity |
| LP custody | LP-токены держит Squads, не сжигаются в beta |
| Ethereum governance | Отдельные Bridge, Treasury и Emergency Safe за timelocks/policy vaults |
| Solana governance | Отдельные Bridge/Treasury Squads; strict Pool Signer PDA для public mainnet |
| Пользовательский bridge v0 | Transporter |
| Cross-chain status v0 | CCIP Explorer |
| Admin UI | Token Manager + Safe + Squads |
| Branded UI | Собственный frontend после/параллельно testnet |
| Mainnet signing | Только человек через Safe/Squads |
| Agent mainnet keys | Запрещены |
| Public token sale | Пока не планируется и не должна подразумеваться |
| Card onramp | Второй этап; сначала card → USDC/SOL → swap |
| Accounts/embedded wallets | Второй этап; MVP может быть wallet-only |
| Дополнительные сети | Только после стабильного Ethereum↔Solana запуска |

---

# 4. Token Manager: подтверждённые возможности и границы

Ранее предполагалось, что Token Manager не может развернуть Ethereum LockRelease pool. Актуальная документация точнее:

- для **existing token** Token Manager предлагает выбрать `Burn / Mint` или `Lock / Release`;
- для добавляемых remote networks wizard автоматически использует Burn & Mint;
- указанное ограничение касается **Lock-and-Unlock**, pool replacement/upgrades и custom pools;
- Transporter позволяет импортировать активированный токен по адресу.

Документация Token Manager находится в EVM-разделе и не подтверждает полный cross-family wizard Ethereum ↔ Solana. Поэтому UI не является критическим deployment path.

Следовательно, выполни только короткий необязательный capability spike:

1. Проверь на testnet, способен ли текущий Token Manager провести именно:
   - existing Ethereum ERC-20;
   - LockRelease на Ethereum;
   - новый BurnMint SPL token/pool на Solana.
2. Зафиксируй, какие шаги UI реально поддерживает.
3. Не используй browser automation как production deployment mechanism.
4. Даже если UI закрывает весь flow, создай воспроизводимые Foundry/TypeScript scripts и verifier scripts.
5. Если Solana flow не поддерживается полностью, используй официальный CCIP CLI, Solana BS58 generator и собственные воспроизводимые scripts.
6. Token Manager используй как дополнительный control plane для просмотра, rate limits, admin operations и verification, но не как источник истины.

---

# 5. Целевая архитектура

```text
                         Ethereum L1
┌──────────────────────────────────────────────────────────┐
│ ProjectToken                                             │
│ - OpenZeppelin ERC-20                                    │
│ - fixed supply                                           │
│ - 9 decimals                                             │
│ - no post-deploy mint                                    │
│ - immutable / no proxy                                   │
│                                                          │
│ Named allocation policy vaults / Timelocks              │
│      └── approved bridge budget ──> LockReleaseTokenPool │
│ Bridge Safe ──> Bridge Timelock ──> CCT/pool/rate config │
└──────────────────────────┬───────────────────────────────┘
                           │
                           │ Chainlink CCIP
                           │ Lock & Mint / Burn & Unlock
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Solana                                                   │
│ - standard SPL mint                                      │
│ - initial supply = 0                                     │
│ - 9 decimals                                             │
│ - freeze authority = None                                │
│ - Chainlink self-serve BurnMint pool                     │
│ - Squads governance                                      │
│ - SPL mint-authority multisig                            │
│                                                          │
│ Bridged supply ──> Treasury ATA ──> Raydium TOKEN/USDC   │
└──────────────────────────────────────────────────────────┘
```

CCIP официально описывает такую комбинацию как Lock & Mint: LockRelease используется на issuing chain, а BurnMint — на remote chain. В обратную сторону механизм становится Burn & Unlock.

## Ethereum token

Использовать:

- актуальную стабильную версию OpenZeppelin Contracts;
- `ERC20`;
- переопределение `decimals()` → `9`;
- constructor mint каждого allocation bucket напрямую в его конечный
  vesting/reserve/timelock contract; deployer и Treasury Safe не получают
  промежуточную custody над `100%` supply;
- будущие `GENESIS_MANIFEST_HASH` и approval envelope вместе связывают token
  deployment с точными allocation IDs, base-unit amounts, beneficiaries, UTC
  timestamps, revocability rules, Facts Pack и утверждёнными approvers; один
  hash без envelope доказывает целостность, но не человеческое одобрение;
- минимальный механизм регистрации CCIP admin, если его требует актуальный выбранный registration flow.

Не добавлять без отдельного решения:

- `ERC20Permit`;
- `ERC20Burnable`;
- `ERC20Votes`;
- `ERC20Pausable`;
- `Ownable`;
- proxy;
- отдельную mint-функцию;
- налог;
- ограничения transfers;
- staking/rewards;
- автоматический market-making.

`ERC20Permit` не запрещён навсегда, но по умолчанию не нужен: Ethereum DEX на первом этапе отсутствует, а дополнительный интерфейс следует добавлять только под конкретный UX.

Canonical ERC-20 не должен наследовать bridge-specific token contract. CCIP подключается внешним `LockReleaseTokenPool`. Это оставляет возможность в будущем заменить bridge adapter без замены основного Ethereum token.

## Solana token

Использовать:

- стандартный SPL Token Program;
- не Token-2022;
- initial mint supply = 0;
- decimals = 9;
- freeze authority = `None`;
- Metaplex Token Metadata для name, symbol, logo URI и project URI;
- metadata update authority первоначально — Squads, если пользователь не выберет immutable metadata сразу;
- официальный self-service Chainlink BurnMint pool;
- никакой собственной Solana bridge program.

На Mainnet и Devnet CCIP Directory сейчас показывает self-service BurnMint/LockRelease programs и активные Ethereum/Sepolia lanes, но адреса и selectors необходимо читать из актуального CCIP Directory непосредственно перед execution, а не копировать из этого документа.

---

# 6. Supply accounting

Обозначения:

```text
F = ProjectToken.totalSupply() на Ethereum
L = ProjectToken.balanceOf(versionSpecificCanonicalBackingHolder)
S = SPL mint supply на Solana
P_ES = locked на Ethereum, но ещё не minted на Solana
P_SE = burned на Solana, но ещё не released на Ethereum
```

Проверяемый invariant при отсутствии donation, pre-funding, manual mint и liquidity withdrawal:

```text
L = S + P_ES + P_SE
adjustedGlobalSupply = F - L + S + P_ES + P_SE
adjustedGlobalSupply = F
backingSurplus = L - S - P_ES - P_SE
```

Интерпретация `backingSurplus`:

```text
< 0  under-backed, немедленный P0 incident
= 0  точное причинное соответствие locks/burns/mints/releases
> 0  donation, manual top-up, manual burn или потерянное событие; требуется классификация
```

После завершения всех сообщений и при отсутствии ручных liquidity operations:

```text
P_ES == 0
P_SE == 0
L == S
```

Monitor обязан строить ledger из finalized onchain events, а не только сравнивать snapshots. Для каждого transfer хранить provenance tuple: source allocation vault, finalized source event, message ID, amount, canonical destination ATA, beneficial controller, direction, manual-execution state и terminal status. Message ID сам по себе не доказывает allocation classification. Pending message нельзя списывать по timeout; несовпадение tuple считается `unknown/circulating` до расследования.

Нормальный режим запрещает:

```text
прямой Treasury transfer в pool
version-specific unauthorized liquidity/LockBox caller operation
ручной governance/system Solana MintTo
необъяснимый перевод из Ethereum pool
```

Обычный holder может сам burn-ить SPL token через стандартный Token Program.
Monitor классифицирует это как voluntary holder burn; такой event не является
CCIP settlement и не может быть запрещён обещанием в документации.

Критические состояния:

```text
backingSurplus < 0
необъяснимый mint на Solana
изменение mint authority без governance proposal
remote pool не совпадает с manifest
любое liquidity movement без отдельного proposal и reconciliation
```

При появлении дополнительных remote chains:

```text
adjustedGlobalSupply =
    F
    - lockedOnEthereum
    + Σ remoteSupplies
    + Σ pendingNormalizedAmounts
```

Никогда не показывать пользователю простую сумму `Ethereum totalSupply + Solana supply`: Ethereum `totalSupply()` включает заблокированные в pool токены.

---

# 7. Governance и authorities

## Ethereum

Предлагаемая схема:

```text
Bridge Safe 3-of-5
└── proposer Bridge Timelock, minimum 7 days
    ├── CCT token admin
    ├── LockRelease pool and LockBox owner changes
    ├── rate-limit increases
    └── remote-chain configuration

Treasury Safe 3-of-5
└── proposer для отдельных Community и Project Timelock

Emergency Safe 2-of-3
├── ExpiringCanceller, 30-day epoch; cannot self-renew
└── EVM v2 one-way pause-to-zero; no positive partial reconfiguration

Community / Project Timelock
├── sole DEFAULT_ADMIN_ROLE после атомарного bootstrap
├── minimum delay 7 дней
├── открытый EXECUTOR_ROLE не обходит schedule/delay
└── purpose-specific policy vaults reject generic execute/transfer bypass
```

Bridge, Treasury и Emergency должны быть разными Safe-адресами. Пересечение
Bridge/Treasury signer sets не больше одного natural person, а Emergency не
пересекается с ними. Считать employer, custodian и recovery domain, не только
wallet address. Ключи, устройства и recovery channels не переиспользуются.

При bootstrap нужно явно отозвать автоматически выданные proposer/canceller и
временные admin roles: в актуальном `TimelockController` proposer из constructor
также получает `CANCELLER_ROLE`. Permanent cancel-only authority запрещена:
скомпрометированный canceller может бесконечно отменять собственное удаление.
Emergency lane остаётся быстрее обычных changes, но bounded по времени, не
получает custody и для CCIP EVM v2 может только выставить все buckets в ноль:
partial reduction способна заново наполнить исчерпанный bucket.

Обычный `TimelockController`, владеющий ERC-20, не обеспечивает budget cap:
он способен вызвать произвольный `transfer`. Community, Distribution,
Operations, Grant Reserve и Liquidity используют отдельные policy vaults без
generic `execute`; каждый vault enforce-ит разрешённые recipients, rolling cap,
no-rollover и destination rules. Раскрытый лимит нельзя называть onchain
invariant, пока это не доказано контрактом и stateful tests.

Agent может:

- создавать Safe transaction proposal;
- генерировать Safe Transaction Builder JSON;
- декодировать calldata;
- симулировать state diff;
- проверять signatures threshold.

Agent не может:

- хранить Safe owner private key;
- самостоятельно подтверждать mainnet proposal;
- автоматически исполнять mainnet transaction.

Safe официально поддерживает модель, где агент подготавливает proposal, а люди проверяют, подтверждают и исполняют его.

## Solana

Предлагаемая governance:

```text
Bridge Admin Squads 3-of-5, 7-day timelock
├── CCIP pool owner
├── CCIP administration
├── remote-chain configuration
├── rate limits
└── metadata update authority

Treasury Squads 3-of-5, 7-day timelock
├── separate ATA per allocation
└── LP custody; no spending-limit bypass at genesis

SPL mint authority on public mainnet
└── CCIP Pool Signer PDA directly
```

SPL multisig не равен Squads. Recoverable `[P,P,G,G]`, `M=2,N=4` означает
`Pool PDA OR governance`: один Squads Vault PDA может удовлетворить оба `G`
slots и вручную mint-ить unlimited supply. Поэтому recoverable authority
допустима только в test/bounded beta с headline disclosure и P0 alert; до
широкой public distribution/liquidity mint authority переходит напрямую Pool
Signer PDA и это проверяется на target chain.

Нужно принять отдельное продуктовое решение между двумя моделями.

### Recoverable test/bounded-beta model

Governance сохраняет возможность recovery/migration через Squads, а CCIP Pool Signer PDA автономно выполняет штатный mint/burn.

Плюсы:

- можно исправить ошибку authority;
- можно мигрировать bridge provider;
- можно восстановиться после инцидента;
- соответствует production multisig pattern в документации Chainlink.

Минусы:

- governance теоретически может сделать ручной mint;
- supply hard cap защищён не только математикой, но и честностью multisig;
- это нужно публично раскрыть и мониторить.
- SPL multisig реализует по смыслу `Pool PDA OR governance`, а не обязательную совместную подпись двух слоёв.

### Direct Pool Signer public-mainnet model - recommended baseline

Mint authority передаётся непосредственно Pool Signer PDA без governance recovery path.

Плюсы:

- project key не может отдельно вызвать raw SPL `MintTo`;
- меньше прямых recovery-authority путей.

Минусы:

- сложнее migration;
- выше vendor lock-in;
- тяжелее emergency recovery;
- ошибка authority может стать необратимой.
- supply всё ещё зависит от remote token/pool configuration, CCIP
  router/offramp и upgradeable Chainlink program governance;
- Bridge governance может косвенно направить штатный mint через вредоносную
  remote configuration, если её surface не ограничена policy controller.

Ни одна модель не называется абсолютно `bridge-only`. Mainnet не запускается,
пока пользователь явно не подтвердит authority model, а protocol-line ADR не
перечислит все privileged selectors и допустимые state transitions.

---

# 8. Бюджет и финансовые ограничения

Главное: разработка и локальные тесты не требуют газа. Публичный market pool не
входит в минимальный технический бюджет и может потребовать существенно больше
капитала для безопасной глубины.

## Предварительный минимальный бюджет

| Категория | Цель |
|---|---:|
| Ethereum deploy/config reserve | около $20–50 |
| Solana token/CCIP/Squads/Raydium reserve | около 0.5–0.8 SOL |
| CCIP mainnet round-trip tests | около $10–25 |
| Raydium Devnet liquidity | $0 real money; 50–100 units of mintable fake USDC |
| Experimental mainnet pool | Founder total cash ≤$100; community adds directly |
| Непредвиденный резерв | $50–100 |
| Общий технический бюджет без public LP | примерно $250–350, уточняется по live gas/SOL |

Неиспользованные ETH и SOL остаются на кошельках. USDC в LP — это risk capital, а не сервисная комиссия.

Локальный gas report текущего `AGTMAIToken` измеряет `540 495` gas для трёх
allocation и `1 420 877` gas для предельных 32 allocation. Runtime-код занимает
`1 945` bytes; тесты и TypeScript tooling в Ethereum не развёртываются. При
снимке 2026-08-29 около `0.082 gwei` и ETH около `$2 426` сам core стоил бы
примерно `$0.11-$0.29`, но это аномально дешёвый момент и не стоимость всего
launch. Перед Mainnet обязательно оценить exact final constructor и отдельно
каждый vesting/release/bridge contract, показать пользователю ETH/USD total и
заблокировать broadcast при превышении утверждённого лимита. Полный обязательный
чек-лист записан в `docs/OPEN_QUESTIONS.md`.

Raydium указывает типичную стоимость создания CPMM около `0.19 SOL`: примерно `0.15 SOL` creation fee и `0.04 SOL` account rent. Seed liquidity оплачивается отдельно.

Squads сейчас указывает разовую стоимость `0.1 SOL` для создания multisig и отсутствие обычной ежемесячной платы. Проверить цену снова перед mainnet.

CCIP network fee table сейчас показывает примерно:

- Ethereum → Solana: `$0.54` при оплате LINK или `$0.60` другим fee token;
- Solana → Ethereum: `$1.35` или `$1.50`;
- создание destination ATA на Solana: ещё около `$0.10`;
- дополнительно оплачиваются blockchain и destination execution costs.

## Hard guards

По умолчанию:

```text
ETHEREUM_SOFT_BUDGET_USD=50
ETHEREUM_HARD_BUDGET_USD=200

CCIP_TEST_SOFT_BUDGET_USD=25

RAYDIUM_DEVNET_LIQUIDITY_USDC=100
RAYDIUM_MAINNET_LIQUIDITY_USDC=UNSET

ALLOW_PAID_SUBSCRIPTIONS=false
ALLOW_MAINNET_BROADCAST=false
ALLOW_MAINNET_POOL_CREATION=false
```

Любое превышение hard cap требует нового явного подтверждения пользователя.
Testnet assets никогда не покупаются: Sepolia ETH, Devnet SOL, test LINK и fake
USDC берутся из faucets или создаются локально. Недоступность faucet является
временным blocker соответствующего E2E, а не основанием тратить реальные деньги.

---

# 9. Продуктовые решения, которые нужно принять вместе с пользователем

Tokenomics является отдельным product/security workstream, а не только строкой allocations. Пока `status: proposal`, `docs/TOKENOMICS.md` и `config/tokenomics.proposal.yaml` являются согласованным предложением, не execution truth. После явного принятия strict compiler создаёт canonical immutable genesis manifest, и только он допускается к deployment.

🔒 Инварианты tokenomics:

- `100%` fixed supply распределяется между публично именованными allocation buckets;
- сумма buckets и их onchain balances всегда проверяема;
- founder/team allocations не попадают в обычные wallets до vesting release;
- 45% Community Governance Reserve не имеет project transfer path до отдельно
  одобренного community-governance activation;
- primary control view на genesis: `0%` community-controlled, `45%` никем не
  управляются и закрыты до активации, `25%` project-administered distribution
  reserve, `30%` другие purpose-specific project/insider allocations;
- `70% community-designated` разрешено только как вторичная строка рядом с этой
  разбивкой, а не как обещание контроля или скорой раздачи;
- founder входит в общий contributor allocation: максимум 3%; другие initial
  contributors суммарно максимум 3%; минимум 9% остаётся для future grants;
- неиспользованные contributor grants остаются в locked reserve, который может
  создавать только публичные grants и не может переводить резерв напрямую EOA;
- undeployed liquidity reserve не равен circulating supply, но TOKEN внутри
  permissionless AMM всегда circulating независимо от владельца LP;
- bridged treasury/reserve tokens сохраняют allocation classification и не
  становятся circulating только из-за появления на Solana;
- manual mint отсутствует на Ethereum, а recoverable Solana mint authority раскрывается как governance risk;
- dashboard показывает total, allocated, available, vested, claimable,
  liquid-overhang, spent и circulating amounts;
- spot value treasury token не считается runway для payroll, audit, legal или infra;
- beta запрещает treasury market sales, buybacks и token-funded yield;
- никакой public sale или marketing с обещанием доходности без отдельного legal review.

## P0 — блокируют rights/ABI freeze или mainnet deployment

| ID | Вопрос | Рекомендуемый default | Почему важно |
|---|---|---|---|
| D-01 | Финальное имя токена | ✅ `Agent Teams AI` утверждено владельцем 2026-08-27 | Имя попадёт в immutable Ethereum contract |
| D-02 | Финальный symbol | ✅ `AGTMAI` утверждён владельцем 2026-08-27 | Exact collision не найден; formal clearance всё равно обязателен |
| D-03 | Total supply | `100,000,000` | Стоимость deployment от supply не зависит |
| D-04 | Decimals | `9` | Одинаковая точность Ethereum/Solana |
| D-05 | Utility на старте | Минимум одна live consumptive function до public distribution | Не проектировать публичный запуск только вокруг будущего roadmap |
| D-06 | Allocations | Рабочее предложение `45/25/15/8/6/1`, ещё обсуждается | Governance reserve, distributions, all contributors, operations, ecosystem grants, liquidity |
| D-07 | Vesting | ✅ Founder и initial team: 12→48, отдельные старты, без catch-up; founder без отзыва; доли ещё обсуждаются | Не создавать отдельный свободный founder reserve и общий unlock cliff |
| D-08 | Public sale | Нет на первом beta | Снижает legal и operational scope |
| D-09 | Entity и target jurisdictions | Решить до rights/ABI freeze, mainnet genesis и public communications | Local/test-only neutral implementation разрешена раньше |
| D-10 | Ethereum signer sets | Bridge/Treasury 3-of-5, Emergency 2-of-3; `|B∩T|≤1`, `E∩(B∪T)=0` | Изолировать custody, configuration и bounded cancellation |
| D-11 | Solana signer sets | Bridge/Treasury Squads 3-of-5 с 7-day timelock, без spending-limit bypass | Не путать Squads и SPL mint authority |
| D-12 | Solana authority model | Recoverable только test/bounded beta; Pool Signer PDA до широкой public distribution/liquidity | Строгий mainnet supply invariant важнее удобства recovery |
| D-13 | Metadata authority | Squads на beta | Можно исправить URI/logo, затем заморозить |
| D-14 | Public liquidity depth | Experimental pool разрешён при total founder cash ≤$100 и token side ≤0.01%; mature target: `$100` ≤1%, `$500` ≤5% | Малый pool даёт trading, но маркируется как highly volatile и не valuation |
| D-15 | Initial pool ratio/token amount | UNSET до отдельного proposal | Tiny pool не является valuation или price discovery |
| D-16 | Venue и fee tier | Сравнить Raydium CPMM, Orca Splash и current configs/costs | Не хардкодить venue или устаревший tier |
| D-17 | LP custody | Squads, не burn | Сохраняет recovery на beta |
| D-18 | Launch access | Utility/community beta + один highly volatile experimental pool | Permissionless pool доступен всем; первые buyers ограничены token-side cap |
| D-19 | Initial bridge allocation | Только exact final commitment; generic treasury buffer = 0 | Обычный Squads ATA обходит EVM policy и считается liquid overhang |
| D-20 | Rate-limit risk budget | Пользователь задаёт максимальный ущерб | Limits должны исходить из tolerable loss |
| D-20A | 30/90-day liquid-supply shock | Утвердить числовой budget | Fixed supply не ограничивает dump pressure |
| D-20B | Treasury sale/buyback policy | Zero в beta | Не допустить скрытого price support или treasury dump |
| D-20C | Airdrop pilot/Sybil budget | ≤ min(0.25% supply, price-impact budget) | Первая wave должна быть обратимо малой |
| D-20D | Cliff semantics | Zero до cliff, затем linear с нуля | Исключить catch-up dump в один день |
| D-20E | Circulating/liquid-overhang formula | Machine-readable и dashboarded | Пользователь должен видеть будущий sell pressure |
| D-20F | Governance activation gate | Ethereum-only aged vote escrow + Constitutional/Operational split; точные параметры ещё утвердить | Governor на genesis и dual-chain vote преждевременны |
| D-20G | Global liquidization cap | Отдельно от commitment caps, списывается по earliest possible release и охватывает все vaults/Solana accounts | Иначе старые schedules могут разблокироваться одновременно |

## Как одобрять liquidity

Не выбирать token amount через желаемый FDV. Для первого experimental pool весь
личный денежный вклад, включая rent/creation fees и quote capital, не превышает
`$100`, а token side не превышает 0.01% supply. Exact venue выбирается только
после mainnet simulation полной стоимости; Raydium документирует около 0.2 SOL
на создание CPMM, поэтому более дешёвый стандартный venue может быть разумнее.

Малый pool не проходит mature depth gate и не выдаётся за стабильный рынок.
Перед ним публикуются ratio, balances, opening time, LP owner и предупреждение о
сильном движении цены. Community добавляет liquidity прямо в pool и сохраняет
собственные LP-позиции; проект не собирает их деньги. Mature target остаётся:
`$100 <=1%`, `$500 <=5%` по exact SDK simulation. При 25 bps CPMM это требует
примерно `$13.2k` quote reserve; planning target `$15k`, предпочтён `$20k`.

Frontend обязан показывать:

- pool TVL;
- price impact;
- предупреждение о низкой ликвидности;
- предупреждение, что spot price и FDV легко манипулируются.

Не использовать цену такого пула:

- как oracle;
- для collateral;
- для reward calculation;
- для vesting valuation;
- для обещаний инвесторам;
- для бухгалтерской оценки treasury.

Raydium отдельно предупреждает, что low-TVL CPMM pools особенно подвержены сильному price movement и MEV; интеграции не должны использовать spot pool price как надёжный oracle.

## P1 — решить до публичного mainnet beta

| ID | Вопрос | Рекомендуемый подход |
|---|---|---|
| D-21 | Frontend day one | Собственный read-only dashboard + Transporter |
| D-22 | Branded bridge | После successful testnet round-trip |
| D-23 | User identity | Wallet-only либо internal UUID + linked wallets |
| D-24 | Existing project accounts | Привязывать wallets через signed challenge |
| D-25 | Embedded wallet | Не блокирует первый запуск; оценить Privy/Reown/CDP позже |
| D-26 | Card payments | Card → USDC/SOL on Solana → swap |
| D-27 | Gas sponsorship | Не в первой версии; позже Kora/Privy |
| D-28 | Who pays CCIP fees | Пользователь платит native ETH/SOL |
| D-29 | RPC providers | Бесплатные tiers для beta, два fallback RPC |
| D-30 | Alerts | Telegram + structured logs |
| D-31 | Public repository | Опубликовать перед mainnet после secret scan |
| D-32 | License | MIT, если нет иной бизнес-причины |
| D-33 | Token metadata immutability | После проверки логотипа, URI и domain |
| D-34 | CCIP token verification | Подать после окончательных metadata/project URLs |
| D-35 | Jupiter visibility | Не обещать мгновенную verification |
| D-36 | Incident communication | Публичная status page и runbook |
| D-37 | Bridge UI minimum amount | UI warning, не custom onchain rule |
| D-38 | Timelock delay/cancel policy | Immutable minimum 7 дней + operation expiry; Emergency expiring canceller и EVM v2 pause-to-zero only |
| D-39 | Independent code review | Хотя бы один технический reviewer до mainnet |
| D-40 | Token Facts Pack и legal classification | Freeze/sign до genesis, bind hash; signed address addendum до первого offer/airdrop/marketing |
| D-41 | EU/public-offer path | Documented exemption либо выполненные white-paper/notification/publication/marketing gates | Facts Pack не заменяет MiCA white paper |
| D-42 | Market-conduct path | Venue/CASP/admission memo, restricted list, trading windows, LP/affiliate disclosure | Нужен до pool, ratio announcement или issuer trading |

## P2 — не блокируют первый запуск

- social login;
- embedded wallets;
- account recovery;
- card onramp;
- gasless Solana transactions;
- mobile app;
- дополнительная EVM-сеть;
- Base или Avalanche;
- Ethereum DEX pool;
- CEX listings;
- staking;
- governance voting;
- referrals;
- buybacks;
- revenue sharing;
- public presale;
- professional market maker.

Не реализовывать staking, revenue share, buyback promises или investment referrals без отдельного legal и economic review.

---

# 10. Product/legal context

Пользователь рассматривал предложение друзьям-кодерам: купить токен как ранним инвесторам и заработать после привлечения пользователей.

Не использовать такую формулировку.

Правильное разделение:

```text
Founding contributor arrangement
├── конкретная работа и ответственность
├── milestone-based token allocation
├── vesting
├── IP/code contribution terms
└── отсутствие гарантированной доходности

Optional token purchase
├── отдельное решение
├── одинаковые прозрачные условия
├── риск полной потери
└── отсутствие обещаний роста
```

Не реализовывать:

- процент за привлечённые инвестиции;
- guaranteed return;
- revenue share без legal review;
- публичный fundraising под обещание роста цены;
- маркетинг «мы привлечём пользователей, поэтому вы заработаете».

В ЕС MiCA регулирует выпуск и маркетинг crypto-assets, а маркетинговые сообщения должны быть честными, понятными и не вводящими в заблуждение. В США SEC в актуальных материалах отдельно рассматривает ситуации, где crypto asset предлагается вместе с ожиданием прибыли от предпринимательских или управленческих усилий других лиц. Это не юридическое заключение, но продуктовый и маркетинговый wording должен пройти отдельную проверку.

Рекомендуемый первый запуск:

- live consumptive utility + technical/community beta;
- без публичного сбора инвестиций;
- без обещаний доходности;
- contributors получают grants за работу;
- маленькая retrospective distribution wave только после отдельного gate;
- без official DEX pool, пока depth gate не пройден;
- полное раскрытие beneficial control, unlocks, LP и admin authorities.

---

# 11. User identity, accounts и card onramp

## MVP identity

Не делать обязательную централизованную регистрацию только ради токена.

Варианты:

### Wallet-only

```text
User identity = connected wallet
```

Подходит для первого DEX/bridge beta.

### Product account + linked wallets

```text
Internal User UUID
├── Ethereum wallet
├── Solana wallet
├── optional embedded wallet
└── email/social account
```

Это лучший долгосрочный вариант, если у основного продукта уже есть пользователи.

Связывание wallets выполнять через signed challenge:

- random nonce;
- domain;
- chain;
- wallet address;
- expiration;
- one-time use;
- replay protection.

Не считать wallet address вечным user ID: пользователь должен иметь возможность сменить или восстановить wallet.

## Embedded wallets

Кандидаты второго этапа:

- Privy;
- Reown AppKit;
- Coinbase CDP;
- Crossmint.

Privy документирует Solana embedded wallets, wallet login и transaction signing. Reown поддерживает Solana wallets и email/social login. Coinbase CDP также поддерживает Solana accounts и embedded wallet flows.

Для первой версии рекомендуется:

```text
External wallets:
    Reown AppKit или стандартные EVM/Solana wallet adapters

Embedded wallet:
    не включать до решения об account model
```

## Card payments

Не предполагать, что новый custom token автоматически поддерживается fiat onramp.

Реалистичная схема:

```text
Card
  ↓
Onramp provider
  ↓
USDC или SOL на Solana
  ↓
Jupiter/Raydium swap
  ↓
Project token
```

Stripe onramp и Coinbase Onramp поддерживают ограниченные списки активов и сетей; Coinbase рекомендует получать актуальный список через Config/Options API. Stripe в текущей документации поддерживает SOL и USDC на Solana в ряде регионов, но доступность зависит от страны.

Card onramp не включать в initial mainnet scope. Сначала:

1. запустить токен;
2. создать DEX pool;
3. убедиться, что swap routing работает;
4. проверить страну пользователей;
5. подать заявку провайдеру;
6. интегрировать USDC/SOL onramp;
7. добавить атомарный или последовательный swap.

## Gasless UX

Позже можно рассмотреть:

- Kora;
- Privy gas sponsorship;
- собственный ограниченный Solana fee payer.

Kora — готовый Solana gasless relayer/paymaster, позволяющий приложению оплачивать fees или принимать оплату fee в SPL assets. Privy также позволяет задавать app-controlled fee payer для Solana. Это P2, потому что sponsorship создаёт отдельную abuse surface и требует policy/rate limits.

---

# 12. Agent autonomy matrix

## Можно выполнять автономно

- web research по официальной документации;
- dependency/version discovery;
- создание репозитория;
- Docker/Docker Compose;
- локальные сети;
- test-only wallets;
- local/testnet private keys;
- unit/fuzz/invariant tests;
- Slither и package audits;
- подготовка, simulation и unsigned manifests для Sepolia/Devnet;
- локальный mock cross-chain round-trip, явно не называемый CCIP E2E;
- local-validator liquidity pool со fake assets;
- frontend;
- monitor;
- documentation;
- gas simulations;
- mainnet fork;
- unsigned Safe transaction manifests;
- unsigned Squads instruction builders;
- public address verification;
- testnet faucet attempts;
- подготовка verification applications без отправки.

## Нужно спросить пользователя

- final name/symbol;
- utility;
- allocations;
- signer addresses;
- authority model;
- mainnet rate limits;
- public pool depth/venue and initial LP ratio;
- fee tier;
- utility beta scope;
- target countries;
- публикация репозитория;
- domain;
- любой paid subscription;
- любая public-network transaction, включая Sepolia и Solana Devnet;
- реальный testnet CCIP round-trip;
- создание Raydium/Orca Devnet pool;
- подача verification/listing form;
- mainnet deploy;
- mainnet CCIP test;
- mainnet Raydium pool;
- публичный launch announcement.

## Категорически запрещено

- просить mainnet seed phrase;
- помещать mainnet private key в `.env`;
- хранить mainnet key в Docker;
- auto-sign mainnet;
- auto-broadcast mainnet;
- создавать mainnet pool без подтверждения;
- создавать публичную продажу;
- обещать доходность;
- писать собственный bridge;
- писать собственный relayer;
- писать собственную Solana CCIP program;
- заменять CCIP без согласования;
- добавлять custom token mechanics ради «гибкости»;
- маскировать failed/simulated test как successful E2E.

---

# 13. Этапы реализации

Ниже сохранена полная roadmap. Активный scope и обязательность для первого
релиза определяются разделом «Граница MVP и правило изменения scope» в начале
плана. Наличие Phase в roadmap не разрешает начинать её в текущем local-only E2E.

## Phase 0 — discovery и фиксация решений

1. Проверить последние официальные версии:
   - CCIP EVM contracts;
   - CCIP SVM programs;
   - CCIP SDK/CLI;
   - OpenZeppelin Contracts;
   - Foundry;
   - Solana/Anza CLI;
   - Raydium SDK V2;
   - Safe SDK;
   - Squads SDK.
2. Прочитать Chainlink `llms.txt` и CCIP Agent Skill.
3. Установить Chainlink Agent Skills на уровне проекта.
4. Получить актуальные addresses/selectors из CCIP Directory.
5. Записать:
   - source URL;
   - retrieval date;
   - network;
   - chain ID;
   - selector;
   - program/contract address;
   - bytecode/program owner;
   - version.
6. Фиксировать только реально принятые irreversible decisions в
   `docs/decisions/`; proposed tokenomics остаётся вне immutable baseline.
7. Local/test-only neutral implementation может идти до legal entity. До freeze
   holder rights/ABI и mainnet genesis получить ответы по имени/symbol, live
   utility, allocations, issuer/entity и launch jurisdictions. До public
   communications/distribution/pool дополнительно закрыть phase-specific legal
   gates.
8. До pool contracts или monitor выполнить compatibility spike
   `@chainlink/contracts-ccip 1.6.4` против `2.0.0` вместе с SVM `1.6.3`, Solidity
   `0.8.36` и `evm_version=paris`: реально проверить registration/config encoding,
   backing holder и Ethereum-Solana lane. Зафиксировать выбранную protocol line,
   addresses, artifact digests и API отдельным ADR. Нельзя автоматически брать
   npm latest или молча оставаться на 1.6.x.

## Phase 1 — Hybrid native macOS arm64 + Linux CI environment

Создать Compose profiles:

```text
local
testnet
frontend
monitoring
```

Локальные native процессы:

```text
anvil
solana-validator
LiteSVM
```

Docker/Compose используется для Linux CI parity, web, monitor и поздних monitoring profiles. На Apple Silicon не запускать Agave через скрытую x86-эмуляцию по умолчанию.

Предпочтительно:

- Anvil для локальной EVM;
- `solana-test-validator` как стабильный baseline;
- Surfpool как опциональный fork/testing profile;
- Node.js 24 LTS;
- pnpm 11;
- Foundry;
- Solana CLI;
- SPL Token CLI;
- TypeScript 7 strict mode;
- `@agent-teams/engineering-foundation` как exact dev-only dependency;
- Clean Architecture dependency direction `domain <- application <- adapters <- composition`;
- feature-module topology из принятого стандарта Agent Teams Orchestrator:
  каждый production artifact принадлежит `src/features/<feature>/`, пустые
  ceremonial layers и broad `domain/shared/common/utils` запрещены;
- предлагаемые в ADR-0004 bounded contexts `Token Control` и `Cross-chain
  Accounting`; до явного принятия ADR-0004 accepted ADR-0003 остаётся source of
  truth и package migration не начинается; ADR задаёт границы ответственности,
  но не является реализацией Ethereum-Solana bridge;
- Rust/Anchor не устанавливать для MVP: собственная Solana program запрещена и не нужна.

Foundation capabilities применяются только там, где есть реальный consumer:
workspace/source dependencies, documentation references, ADR governance,
suppression governance, quality gates и portable agent workflow включены.
Public API compatibility, executable specifications, publishing security и
schema evolution включаются после появления соответствующего артефакта, а не с
фиктивным пустым evidence.

До принятия ADR-0004 accepted ADR-0003 остаётся source of truth. Первый local
Genesis Core slice создаёт только новую `genesis-manifest` feature в ADR-0003
`Supply` и не переносит существующий `packages/domain`. Package migration
начинается один раз отдельным изменением после Genesis Core barrier и решения
по ADR-0004: в два целевых context при принятии либо в ADR-0003 `Supply` при
отклонении. Принятие ADR само по себе код не переносит. До переноса фиксируются
package gates и сохранение либо явное версионирование identity уже созданного
manifest artifact.
Не создавать заранее generic `packages/chainlink-adapter` и
`packages/solana-adapter`: provider-specific code остаётся в outbound adapter
владельца use case до второго доказанного consumer.

Docker requirements:

- pinned base images;
- lockfiles;
- non-root containers;
- healthchecks;
- named volumes;
- no secrets in layers;
- `.dockerignore`;
- SBOM;
- dependency scan;
- `docker compose config` validation;
- Linux x86_64 support;
- native macOS arm64 bootstrap;
- no mainnet keys.

## Phase 2 — local Genesis Core без спорных policy vaults

🚨 Local/test-only neutral implementation разрешена. Не freeze-ить holder
rights/ABI и не готовить mainnet genesis до D-05/D-06,
entity/jurisdiction classification memo и holder-rights matrix. Код до этого
момента остаётся явно test-only и не является offer/launch artifact.

Исполнимый scope, архитектура, failure modes, тесты и acceptance criteria
зафиксированы в
[`GENESIS_CORE_LOCAL_PLAN.md`](GENESIS_CORE_LOCAL_PLAN.md).

Первый vertical slice содержит только:

```text
strict proposal/local-fixture schemas
test-only local fixture -> canonical manifest + allocation commitment
AGTMAIToken.sol
local Anvil deployment
adversarial read-only verifier
native macOS loop + exact-SHA Linux CI parity
```

`NoCatchUpVesting`, local Agave/SPL fixture, mock accounting и расширенная
security/CI matrix являются следующими independently-green slices, а не частью
12-часового Definition of Done.

Три zero-cost slice после Genesis Core исполняются по
[`NEXT_ZERO_COST_SLICES_PLAN.md`](NEXT_ZERO_COST_SLICES_PLAN.md). Их кандидат
`4037e4b` принят для local/test-only использования и прошёл exact-SHA CI без
`P0/P1`, однако это не означает полного выполнения каждой строки плана. Более
ранняя remediation девяти `P2` и шести `P3` имела локально green evidence для
Foundation full-scan, authenticated owned-process recovery, Solana
failure/publication evidence, полного compiler-input digest и независимой
Slither evidence validation.

Superseding correction, 2026-08-29: R7 вернул `AMEND` для текущего rollback
delivery. Published history смешивает slices и не доказывает
independent commit-group rollback; original isolated worker identity для W1, W2
и W3 недоступна. Remediation implementation теперь integrated: production
runner доказывает per-slice apply -> rollback -> exact byte/status equivalence,
использует bounded allowlisted descriptor/quarantine cleanup и сохраняет
substituted child/final-directory identity; root preflight проверяет complete
history, offline archives/binaries, pnpm store/workspace links, Docker и pinned
Slither image до gates. Complete-history verifier отвергает object alternates.
Linux x64 runtime связан с archive hash, immutable inner `bin/node` SHA-256,
canonical provenance, exact `process.execPath` и `/proc/self/exe`; Darwin arm64
fail closed. Continuously scheduled same-UID final-syscall micro-window и
privileged peer остаются вне local/test-only threat model. Exact-head,
full-history wiring уже integrated в существующий CI job, но hosted execution
этого candidate ещё pending. Текущий patch не принят. Superseding
recovery-review correction, 2026-08-31: byte-complete inventory
теперь фиксируется сразу после exact-head/full-history validation, до bootstrap,
cache или workspace executable, и повторно проверяется после gates. Foundry и
pnpm installed bytes сравниваются с payload, повторно полученным из
descriptor-opened archive под repository-pinned archive SHA-256; solc binary
копируется из его descriptor-opened executable archive. Mutable provenance не
является authority, а отсутствующий archive даёт явный
`TOOLCHAIN_PINNED_PAYLOAD_AUTHORITY_UNAVAILABLE`. Отдельные inner-file hashes
для Foundry/pnpm не заявляются. Recovery proof отделяет volatile diagnostics от
closed-schema deterministic statement/proof digest, independently validates
exact gate coverage и artifacts, публикует `READY` last, а CI загружает proof
только после validation; failure upload явно называется diagnostics. Все
`architecture/rollback/**`, `scripts/rollback/**`, history verifier и rollback
tests mandatory routed в Foundation full scan с negative coverage. Из-за этих
подтверждённых изменений прежний manifest rehash был недействителен. Финальные
shared/retained transitions теперь rehashed из точных current worktree bytes;
current-byte coverage и production apply regressions проходят со статусом
`REHASHED_WORKTREE_VALIDATED_PENDING_EXACT_HEAD_FULL_PROOF`. Clean exact-head
`--validate-only` требует внешне созданного candidate commit и здесь не
заявляется согласно запрету на commit. Полный local gate proof в
этом окружении не заявлен: отсутствуют полные offline Foundry/solc/pnpm/Agave
caches и cached Slither Docker image, поэтому preflight прекращает execution до
dependent gates. Proxy-disabled transport adapters и соответствующие
Foundation dependency declarations принадлежат отдельным coordinated lanes,
остаются pending и не изменяются или pre-approve этим patch; direct-HTTP `P1`
не закрыт. Structural rollback tests или preparation не являются полным proof.
Текущий patch не принят; authoritative exact-SHA CI и повторные
specialist/holistic reviews также остаются обязательными. Это local/test-only
engineering remediation, не audit, production, Devnet/Mainnet readiness или
разрешение на public network, signer либо broadcast.

Исполнение `Core-12h` использует production-hosted subscription-runtime:
W1 manifest и W2 Solidity идут параллельно до cross-language barrier, затем W3
verifier и W4 Linux parity идут от нового integrated SHA. Candidate проверяют
пять параллельных read-only критиков; accepted P0/P1 исправляет owner
затронутого path, после чего affected review и holistic exact-head review
повторяются. Exact ownership, recovery и evidence protocol находятся в §7
[`GENESIS_CORE_LOCAL_PLAN.md`](GENESIS_CORE_LOCAL_PLAN.md).

Сложные Community, Distribution, Contributor, Operations, Ecosystem и Liquidity
policy vaults, Timelock bootstrap и governance activation переходят в отдельный
следующий этап. Их нельзя писать до утверждения соответствующих product rules.
Такой порядок уменьшает attack surface и не выбрасывает работу: strict local
manifest, allocation commitment, ERC-20, verifier и тесты являются общими
primitives для будущей схемы.

Production schema и production compilation в этом slice отсутствуют: значение
`status: accepted` само по себе не доказывает approval. Будущий production path
потребует проверяемый approval envelope. Proposal не может создать deployable
artifact. Local tests используют отдельный `purpose: local-fixture`,
`status: test-only` и chain ID `31337`; он не меняет статус реальной tokenomics
proposal.

Amounts/caps кодируются только integer base units/bps. Token сам вычисляет
allocation commitment из chain ID, supply и фактически mint-нутых constructor
allocations; TypeScript/Solidity имеют общий committed golden vector с raw ABI
bytes. Отдельный RFC 8785 artifact SHA-256 явно не считается onchain approval.
Production full-manifest/approval commitment проектируется после утверждения
полного набора полей и approvers.

Token properties:

- immutable deployment;
- constructor mints exact base-unit allocations directly to test recipients;
- 9 decimals;
- no post-deployment mint;
- no owner-only transfer controls;
- no tax;
- no proxy;
- no pause;
- no blacklist;
- CCIP registration hook не добавляется до protocol-line ADR и mainnet ABI
  freeze.

Policy-vault этап после продуктового approval сохраняет требования из
[`CONTRACTS.md`](CONTRACTS.md): purpose-specific contracts без generic execute,
transfer/approve bypass, proxy или controller replacement; commitment и global
liquidization limits доказываются stateful tests.

## Phase 3 — Ethereum CCIP pool

Использовать только официальный version-specific LockRelease/LockBox design,
выбранный compatibility ADR. Для CCIP 2.0 backing находится в отдельном
`ERC20LockBox`; для 1.6.x API и holder отличаются. Monitor получает это из
versioned manifest, а не предполагает `balanceOf(pool)`.

Подготовить scripts для:

- deploy token;
- deploy pool;
- register/propose admin;
- accept admin;
- set pool in TokenAdminRegistry;
- configure Solana remote token;
- configure remote pool;
- rate limits;
- owner transfer;
- verify version-specific pool/LockBox owner, authorized callers and absence of
  unintended liquidity-management authority;
- verifier;
- state export.

Нормальный режим запрещает прямое pre-funding и любые version-specific
provide/withdraw/authorized-caller paths вне approved Bridge Timelock proposal.
Initial Solana allocation создаётся только реальным CCIP transfer. Любая
временная liquidity-management authority требует отдельного human-approved
proposal, state diff и reconciliation до/после.

Выполнить capability spike Token Manager:

- проверить current existing-token workflow;
- проверить Lock/Release source;
- проверить добавление Solana BurnMint remote;
- записать поддерживаемые и ручные шаги.

Execution source of truth после принятия:

```text
accepted config + schema/compiler version
canonical deployment-manifest.json + hash
verifier output
Foundry/TypeScript scripts
CCIP protocol-line ADR + artifact digests
```

## Phase 4 — Solana token и BurnMint pool

Scripts:

- create SPL mint;
- create treasury ATA;
- create metadata;
- set freeze authority to None;
- initialize self-serve BurnMint pool;
- derive Pool Signer PDA;
- configure remote Ethereum token/pool;
- configure rate limits;
- configure Squads;
- configure SPL multisig;
- inspect all authorities;
- compare state with manifest.

Не деплоить Chainlink program самостоятельно.

Self-serve mode является рекомендуемым вариантом: Chainlink-maintained standard pool programs уже развёрнуты, а проект только инициализирует собственный token pool state.

## Phase 5 — local tests

Локально проверить:

- ERC-20;
- SPL mint;
- authority transitions;
- pool configuration encoding;
- amount conversion;
- supply monitor;
- frontend with mocked CCIP messages;
- all failure paths.

Chainlink Local можно использовать для EVM-local tests, но он не доказывает реальную delivery Ethereum↔Solana. Настоящий cross-family E2E выполняется через Sepolia↔Solana Devnet. Не называть local mock настоящим CCIP E2E.

## Phase 6 — public testnet E2E

Только после fresh human approval конкретных Sepolia/Devnet адресов и decoded
operations. `$0` real-asset budget не является разрешением на public-network
broadcast.

Использовать:

```text
Ethereum Sepolia
↕
Solana Devnet
```

CCIP Directory сейчас показывает активный Sepolia lane и self-service pool programs на Solana Devnet.

Последовательность:

1. Deploy Ethereum test token.
2. Deploy/configure LockRelease pool.
3. Создать Solana mint с supply 0.
4. Initialize self-serve BurnMint pool.
5. Configure peers/remotes.
6. Configure low rate limits.
7. Verify all authority graph.
8. Bridge Ethereum → Solana.
9. Записать:
   - source tx;
   - message ID;
   - destination tx;
   - balances;
   - fee;
   - latency.
10. Проверить invariant.
11. Bridge часть обратно.
12. Повторно проверить invariant.
13. Повторить с другим получателем.
14. Проверить ATA creation.
15. Проверить transfer above rate limit.
16. Проверить pending/manual execution handling.
17. Сохранить отчёт.

## Phase 7 — frontend и dashboard

Для минимальной beta обязателен достоверный read-only статус основного
двухсетевого сценария. Полный branded frontend ниже является расширением,
а не условием завершения текущего локального MVP или первого CCIP round-trip.
Функции безопасности включённого transaction UX сохраняются полностью.

### Day-zero готовые инструменты

```text
Token Manager
Transporter
CCIP Explorer
Safe
Squads
Raydium
Jupiter
```

### Branded frontend

Страницы:

```text
/overview
/bridge
/transactions
/governance
/liquidity
/health
/contracts
/risks
```

Функции:

- EVM и Solana wallet connection;
- strict network validation;
- balances;
- fee quote;
- approve;
- CCIP send;
- message tracking;
- Explorer links;
- pending/manual status;
- global supply;
- Ethereum locked;
- Solana supply;
- backing ratio;
- authorities;
- rate limits;
- Raydium reserves;
- price impact;
- low-liquidity warning.

Использовать официальный CCIP SDK. SDK поддерживает EVM и Solana, fee/message tooling и требует Node 20+, с Node 24+ как рекомендуемым окружением.

Официальный `ccip-sdk-examples` использовать как reference, но не копировать без проверки: example code может быть testnet-oriented и не является заменой production review.

Frontend не должен:

- хранить ключи;
- принимать произвольные token/pool addresses из URL;
- использовать pool spot price как oracle;
- скрывать fee;
- скрывать low TVL;
- скрывать admin authorities;
- разрешать mainnet при compile-time/runtime flag `ENABLE_MAINNET=false`.

## Phase 8 — liquidity venue Devnet и cost comparison

Условная фаза: выполняется только при отдельно принятом включении DEX/pool.
Не блокирует минимальную beta без pool и не входит в текущий локальный MVP.
До любого включённого pool все её проверки и связанные cost/risk gates обязательны.
Только после successful CCIP round-trip:

1. Создать fake testnet USDC с 6 decimals.
2. Использовать bridged SPL token.
3. Сравнить Raydium CPMM и Orca Splash по current program IDs, complete account
   rent, creation fee, transaction fees, permission model и Jupiter routing.
4. Не считать `cluster="devnet"` достаточной настройкой.
5. Выбрать один стандартный venue по безопасности и total `$100` mainnet cap.
6. Создать выбранный pool.
7. Добавить liquidity.
8. Swap TOKEN→fake USDC.
9. Swap fake USDC→TOKEN.
10. Проверить slippage.
11. Сохранить pool ID, LP mint, vaults, reserves.
12. Проверить dashboard.

Raydium называет CPMM рекомендуемым default для большинства permissionless new
pools, но документирует mainnet creation cost около `0.19-0.2 SOL`. Orca
описывает Splash как более дешёвый full-range вариант и разрешает любому
участнику добавлять liquidity. Финальный выбор требует exact transaction
simulation непосредственно перед proposal.

## Phase 9 — monitoring

Это следующая продуктовая фаза, не новая разработка внутри текущего local-only
E2E. В минимальную двухсетевую beta входят supply/message/authority контроль,
finality, ошибки, alerts и incident runbook. Рыночная аналитика и retention
выполняются при включении соответствующей distribution/liquidity/incentive
механики; обязательные проверки уже принятых прав и выпускных политик остаются.
Список технологий ниже не требует отдельного сервиса для каждой строки.

Primary monitor должен быть собственным read-only сервисом, а не критически зависеть от одного SaaS.

Primary truth — event-sourced reconciler по finalized Ethereum/Solana history. CCIP Explorer/API используются только для enrichment и сверки.

Рекомендуемый стек:

```text
TypeScript monitor
Prometheus metrics
Grafana dashboard
SQLite/Postgres cache
Telegram webhook
structured JSON logs
CCIP SDK/API
Ethereum RPC
Solana RPC
```

Проверять:

- Ethereum fixed supply;
- version-specific canonical backing-holder balance;
- Solana supply;
- `P_ES`, `P_SE` и `backingSurplus`;
- причинное соответствие каждого mint/release конкретному message ID;
- pending CCIP messages без автоматического списания по timeout;
- manual execution;
- все Solana `MintTo`/`Burn`;
- finalized cursors, reorg rollback и disagreement между независимыми RPC;
- explicit `unknown`, `stale` и `inconsistent` states вместо ложного exact;
- direct backing donations и пользовательские SPL burns как отдельные
  классифицированные события;
- все Ethereum pool transfers и liquidity events;
- admin addresses;
- pool owner;
- remote pools/tokens;
- rate limits;
- mint authority;
- freeze authority;
- metadata authority;
- Squads threshold/signers;
- LP owner;
- Raydium reserves;
- liquid supply и liquid overhang 30/90 дней;
- worst-case 30-day sell pressure относительно executable depth;
- unlock-to-float ratio и beneficial-control concentration;
- treasury/issuer net flows и issuer buy share;
- airdrop cluster share, immediate sells и retention 30/90 дней;
- organic liquidity retention после incentives;
- orphan mints, duplicate settlements и bridge reconciliation lag;
- RPC consistency.

Chainlink оставляет за разработчиком ответственность за application monitoring, risk communication и обработку сообщений, требующих manual execution.

## Phase 10 — mainnet dry-run

Ethereum:

- current mainnet fork;
- simulate Safe creation/config;
- simulate token deployment;
- calculate deterministic/expected address where possible;
- simulate LockRelease pool;
- simulate registry operations;
- simulate remote configuration;
- simulate rate limits;
- estimate gas;
- generate Safe JSON;
- no broadcast.

Solana:

- fetch current program IDs;
- derive all PDAs;
- simulate instructions;
- create Squads transaction-builder payloads;
- no mainnet keypair;
- no recent blockhash transaction stored as a permanent artifact;
- no broadcast.

Raydium:

- calculate pool setup;
- compare fee tiers;
- calculate initial price;
- prohibit choosing the ratio from a desired marketing FDV;
- calculate expected price impact for `$100` and `$500` swaps;
- stress 100% pilot-airdrop sale, 30/90-day unlock sale and 80% quote-liquidity loss;
- no broadcast.

## Phase 11 — human-reviewed mainnet deployment

Перед каждым proposal показать:

```text
Operation
Network
Target
Decoded calldata/instructions
Current state
Expected state
Expected fee
Budget remaining
Signer threshold
Rollback/recovery
Verification command
```

Mainnet последовательность:

1. Зафиксировать entity/jurisdictions, dated classification memo, live utility,
   holder-rights matrix и applicable offer path. Freeze/sign Token Facts Pack,
   bind disclosure hash, а где применимо завершить white-paper notification и
   publication gates; Facts Pack не заменяет statutory document.
2. Создать/подтвердить Bridge Safe и Bridge Timelock.
3. Создать/подтвердить Treasury Safe.
4. Создать/подтвердить Emergency Safe.
5. Deploy и self-administer отдельные Community/Project Timelock и allocation
   contracts; проверить role graph и отсутствие bootstrap-admin residue.
6. Создать/подтвердить отдельные Bridge и Treasury Squads.
7. Deploy Ethereum token с прямым genesis allocation.
8. Проверить source, approval envelope, `GENESIS_MANIFEST_HASH`, bucket balances
   и нулевые необъяснимые balances deployer/factory/Safe.
9. Deploy/configure LockRelease pool only behind the protocol-line-specific
   admin policy controller; verify every privileged selector, immutable minimum
   delay, operation expiry and backing-withdrawal prohibition.
10. Register CCIP admin.
11. Create Solana mint and metadata; remove freeze authority.
12. Initialize BurnMint pool and configure authority model/remotes/rate limits;
    verify exact remote token/pool, program hash, upgrade authority and owner.
13. Run verifier.
14. Small Ethereum→Solana canary and target-chain state verification.
15. Small Solana→Ethereum canary and target-chain state verification.
16. Wait for clean monitoring window; после legal/public-communications scrub
    publish signed official address manifest.
17. Start utility/community beta only после applicable offer/onboarding gates,
    без treasury sales.
18. Separately approve airdrop consideration/Sybil gate before any wave.
19. Separately approve venue/CASP/admission, market-conduct, restricted-list,
    trading-window, depth, LP conflict policy and exact ratio before announcing
    a ratio, bridging LP allocation or creating the selected standard pool.

---

# 14. Rate-limit policy

Не задавать limits как случайный процент total supply.

Использовать:

```text
max_tolerable_incident_loss
normal_expected_daily_bridge_volume
initial_remote_allocation
current_remote_supply
```

Bootstrap mode:

```text
capacity ≈ exact LP allocation + small operational buffer
```

Post-launch mode:

```text
capacity + refillRate * detectionAndPauseLatency <= maximum tolerable incident loss
refill based on expected daily volume
outbound approximately 90% of inbound where appropriate
```

Нужно согласовать четыре bucket: Ethereum outbound ≤ Solana inbound и Solana outbound ≤ Ethereum inbound. `isEnabled=false` на EVM означает unlimited, а не pause. `paused.yaml` обязан сохранять limiter включённым с нулевыми capacity/rate и иметь executable contract test на pinned EVM и SVM versions.

Chainlink production tutorial рекомендует conservative limits и приводит outbound около 90% от inbound, чтобы уменьшить риск congestion при transfers in flight.

Нужно иметь:

- `bootstrap.yaml`;
- `beta.yaml`;
- `paused.yaml`;
- `production.template.yaml`.

Все значения:

- human-readable;
- base units;
- tokens/second;
- tokens/day;
- процент remote supply;
- приблизительное значение относительно LP.

---

# 15. Trading и Jupiter visibility

На старте создаётся не более одного pool:

```text
TOKEN / USDC
Raydium CPMM, Orca Splash или другой стандартный permissionless venue
Solana
```

Venue не фиксируется заранее: mainnet simulation должна показать полную
стоимость создания и начального deposit внутри общего `$100` founder cap. У
Raydium CPMM текущая документированная стоимость создания около 0.19-0.2 SOL;
Orca Splash заявляет lower setup cost и допускает добавление liquidity любым
участником. Решение принимается по exact current transactions, а не по бренду.

Не создавать Ethereum pool, поскольку это:

- раздробит маленькую liquidity;
- потребует WETH/USDC capital;
- ухудшит общий UX;
- создаст два рынка при отсутствии market maker.

После создания выбранного pool проверить:

- доступность прямого swap;
- обнаружение mint через Jupiter Tokens API;
- наличие metadata;
- наличие quote route;
- warning/verification status;
- organic score;
- holder и trading metrics.

Старый Jupiter token-list pull-request flow deprecated; актуальная discovery/verification опирается на Jupiter Verify и organic signals. Не обещать пользователю мгновенную зелёную verification badge.

Не делать искусственный volume bot или фиктивную активность ради verification.

---

# 16. Security requirements

Обязательные документы:

```text
THREAT_MODEL.md
AUTHORITY_MODEL.md
SUPPLY_INVARIANT.md
INCIDENT_RUNBOOK.md
MAINNET_RUNBOOK.md
TESTNET_RUNBOOK.md
KEY_MANAGEMENT.md
USER_RISK_DISCLOSURE.md
```

Threat model минимум:

- compromised deployer;
- compromised Safe signer;
- compromised Squads signer;
- two compromised signers;
- malicious frontend;
- compromised RPC;
- wrong chain selector;
- wrong remote pool;
- wrong token address;
- wrong decimals;
- unexpected Solana mint;
- metadata authority takeover;
- CCIP outage;
- CCIP manual execution;
- rate-limit misconfiguration;
- under-backed Solana supply;
- Raydium LP removal;
- low-liquidity manipulation;
- mass sale of the first airdrop wave;
- shared-cliff founder/team dump;
- treasury dump or insider/treasury cross-trade;
- token-funded reward or insurance death spiral;
- mercenary liquidity exit after incentives;
- flash-borrowed governance capture;
- airdrop Sybil clusters and immediate dumping;
- leaked testnet key reused on mainnet;
- dependency compromise;
- Docker secret leak;
- phishing Safe/Squads proposal.

Tests/checks:

- Forge unit tests;
- fuzz;
- invariants;
- Slither;
- strict TypeScript;
- ESLint;
- dependency audit;
- secret scan;
- Docker scan;
- chain ID guards;
- program-owner validation;
- bytecode checks;
- PDA derivation;
- decimals check;
- peer symmetry;
- role graph;
- rate-limit readback;
- multi-RPC consistency;
- frontend CSP;
- Playwright smoke tests;
- transaction simulation directly before signing.

Подтверждённое уточнение Slither environment от 29 августа 2026: официальный
Trail of Bits toolbox `nightly-20260824` содержит Slither `0.11.6`,
crytic-compile `0.4.2` и solc `0.8.36`, но встроенный Forge имеет версию `1.7.1`,
а проект закреплён на Forge `1.8.0`. Поэтому security gate не доверяет
встроенным Forge/solc: он checksum-проверяет official Linux binaries из
`tooling/toolchain.lock.json`, монтирует их read-only в digest-pinned toolbox и
принудительно использует exact paths. Custom Python image, floating tag и
системный fallback запрещены.

Deterministic economic scenarios:

- 100% of an airdrop pilot is sold immediately;
- every beneficiary in a 30/90-day unlock window sells;
- quote liquidity falls by 80%;
- treasury attempts a sale before an approved budget;
- governance uses flash-borrowed voting balance;
- rewards continue while product usage falls by 90%;
- duplicate, forged or manual Solana mint occurs.

---

# 17. Definition of done

## Local MVP: текущая обязательная приёмка

Критерий выхода полностью задан в разделе «Текущий обязательный результат:
локальный MVP» выше и в исходных zero-cost плане и критике. Frontend, новый
monitor и публичная CCIP delivery не добавляются к этой приёмке.

### Расширенный локальный продуктовый стенд, следующий scope

Исторический широкий список ниже относится к подготовке следующих продуктовых
фаз. Это отдельный рубеж, не дополнительные условия текущего локального MVP:

- `docker compose build` проходит;
- local stack стартует;
- healthchecks green;
- EVM tests green;
- Solana tests green;
- supply invariant green;
- frontend собирается;
- monitor запускается;
- no secrets in Git;
- reproducible bootstrap documented.

## Testnet E2E

- token deployed on Sepolia;
- mint created on Solana Devnet;
- pools configured;
- Ethereum→Solana successful;
- Solana→Ethereum successful;
- message IDs сохранены;
- balances match;
- invariant holds;
- limits tested;
- минимальный read-only статус показывает реальные данные основного сценария;
- если DEX/pool отдельно включён в scope, выбранный стандартный Devnet pool и
  swaps проверены по Phase 8 до его выпуска; без включённого pool этот пункт
  явно not-applicable, не ложный pass и не внешний blocker.

## Mainnet readiness

- final P0 decisions complete;
- live consumptive utility demonstrated;
- legal entity and launch jurisdictions fixed;
- dated classification memo covers exact rights, distribution and venue path;
- applicable exemption is documented or required white-paper notification,
  publication and marketing prerequisites are complete;
- Token Facts Pack, authority matrix and disclosure hash reviewed;
- 24-month unlock calendar and beneficial-control report published;
- sell-pressure simulation and liquid-supply budget pass;
- treasury sale/buyback, airdrop consideration and LP conflict policies pass;
- issuer/affiliate restricted list, trading windows, market-conduct owner and
  related-party LP/withdrawal disclosures pass before any pool;
- signer addresses verified out of band;
- source code frozen;
- dependency versions pinned;
- mainnet fork green;
- Safe JSON generated;
- Squads builders generated;
- gas report complete;
- budget under cap;
- two-person review complete;
- monitoring ready;
- incident runbook ready;
- user risk disclosure ready;
- no mainnet transaction broadcast by agent.

## Beta launch

- human-approved mainnet deployment;
- round-trip successful;
- monitoring clean;
- one experimental pool is optional until its separate legal/total-cost gate;
- if created, its token side is at most 0.01%, ratio is approved, extreme
  volatility is disclosed and project LP is held by disclosed Squads;
- official addresses published;
- liquidity depth and withdrawal powers are visible;
- no investment-return marketing.

---

# 18. Критический разбор архитектуры

## Что здесь действительно хорошо

1. Canonical Ethereum token остаётся обычным ERC-20 и не привязан навсегда к CCIP-specific inheritance.
2. Fixed supply создаётся один раз.
3. Solana даёт дешёвую торговлю и transfers.
4. CCIP решает bridge verification, execution, decimal conversion, rate limiting и standard pool logic.
5. На Solana не нужно поддерживать собственную bridge program.
6. Маленький budget достаточен для beta.
7. Config-as-code и manifests обеспечивают воспроизводимость.
8. Mainnet signing остаётся у людей.
9. Ethereum DEX liquidity не дробит маленький Solana pool.
10. Frontend может начать с готовых Transporter/Explorer.

## Слабые места и компромиссы

### 1. Зависимость от CCIP

Проект зависит от:

- availability выбранного lane;
- CCIP governance;
- Router/FeeQuoter upgrades;
- CCIP fees;
- manual execution process.

Это приемлемо, потому что альтернативой при таком бюджете была бы большая собственная security/operations surface.

### 2. Recoverable Solana authority не является абсолютным hard cap

Если Squads может выполнить recovery mint, holders должны знать об этом. Защита:

- multisig;
- public signers;
- alerts;
- public supply dashboard;
- documented emergency policy;
- последующее возможное hardening.

### 3. Tiny LP означает манипулируемую цену

С `50–100` units fake USDC на Devnet:

- цена легко двигается;
- FDV условный;
- крупная продажа может забрать значительную часть USDC;
- spot price нельзя использовать как oracle.

На Devnet это только demo. На mainnet такой же малый pool допускается только как
explicitly experimental: максимум 0.01% token side, founder total cash `$100`,
без valuation claims и с предупреждением о сильном движении цены. Это не
достаточная depth; mature gate оценивается отдельно.

### 4. Card → custom token не гарантирован

Большинство onramp providers сначала поддерживают ограниченный набор активов. Реалистичный UX — USDC/SOL onramp и затем swap.

### 5. Token Manager не заменяет DevOps

Даже если current wizard поддержит наш flow, нужны:

- versioned config;
- scripts;
- verification;
- state diff;
- audit trail;
- rollback/runbook.

Это не «велосипед», а минимальная безопасная orchestration вокруг готового протокола.

### 6. Local Docker не доказывает cross-chain delivery

Offchain CCIP infrastructure нельзя полноценно заменить Anvil + local Solana validator. Настоящий E2E требует public testnet lane.

### 7. Две governance systems

Safe + Squads/SPL Multisig добавляют operational complexity. Но это безопаснее, чем один deployer EOA.

### 8. Юридический wording

Фраза «ранние инвесторы получат profit благодаря нашей работе» создаёт ненужный regulatory risk. Contributor grants и utility beta — более чистая стартовая модель.

## Итоговый verdict

Архитектура остаётся оптимальной для заданных ограничений:

```text
маленький бюджет
+ Ethereum L1
+ Solana trading
+ controlled supply
+ no custom bridge
+ operational flexibility
+ AI-assisted implementation
```

Базовый протокол менять не нужно: актуальные CCIP lanes и self-serve SVM pools подтверждены. Token Manager не является условием жизнеспособности, а его capability spike не блокирует script-first реализацию.

---

# 19. Рекомендуемая структура репозитория

```text
/
├── compose.yaml
├── Makefile
├── README.md
├── .env.example
├── .gitignore
├── .dockerignore
├── docker/
│   ├── evm.Dockerfile
│   ├── solana.Dockerfile
│   ├── web.Dockerfile
│   └── monitor.Dockerfile
├── config/
│   ├── local.yaml
│   ├── testnet.yaml
│   ├── mainnet.template.yaml
│   ├── bootstrap-rate-limits.yaml
│   ├── beta-rate-limits.yaml
│   └── paused-rate-limits.yaml
├── contracts/
│   └── evm/
│       ├── src/features/
│       ├── test/features/
│       ├── script/features/
│       └── foundry.toml
├── packages/
│   └── contexts/
│       ├── token-control/src/features/
│       └── cross-chain-accounting/src/features/
├── apps/
│   ├── monitor/
│   └── transparency/
├── monitoring/
│   ├── prometheus/
│   └── grafana/
├── docs/
│   ├── DECISIONS.md
│   ├── OPEN_QUESTIONS.md
│   ├── STATUS.md
│   ├── ARCHITECTURE.md
│   ├── THREAT_MODEL.md
│   ├── AUTHORITY_MODEL.md
│   ├── SUPPLY_INVARIANT.md
│   ├── TESTNET_RUNBOOK.md
│   ├── MAINNET_RUNBOOK.md
│   ├── INCIDENT_RUNBOOK.md
│   ├── USER_RISK_DISCLOSURE.md
│   └── decisions/
├── reports/
└── secrets/
    └── testnet/        # gitignored
```

Эта topology является proposed target из ADR-0004. Не создавать пустые каталоги
и не мигрировать `packages/domain`, пока ADR-0004 не принят и package catalog,
default-deny source policy, topology validator и consumer tests не включены в
root `check`. `Cross-chain Accounting` должен начинаться с identity каждого
transfer, idempotency, finality/reorg evidence и reconciliation; агрегатные
счётчики являются только производным представлением. Ни один из двух context не
реализует Chainlink bridge, relayer или token pool.

Make targets:

```text
make bootstrap
make versions
make build
make up
make down
make lint
make test
make security
make local-e2e
make testnet-plan
make testnet-deploy
make testnet-e2e
make raydium-devnet
make frontend
make monitor
make report
make mainnet-dry-run
make verify-state
make secret-scan
make clean
```

---

# 20. Отчёты, которые агент обязан предоставить

`RUN_REPORT.md`:

- реально выполненные действия;
- simulated actions;
- mocked components;
- failed attempts;
- blockers;
- test results;
- addresses;
- transaction IDs;
- CCIP message IDs;
- pool IDs;
- fees;
- balances before/after;
- authority graph;
- supply invariant;
- точные следующие действия.

`BUDGET_REPORT.md`:

- prepared funds;
- actual spent;
- refundable/rent amounts;
- remaining ETH/SOL;
- LP capital;
- current quote;
- hard cap comparison.

`MAINNET_PROPOSALS.md`:

- proposal order;
- decoded operations;
- Safe JSON paths;
- Squads payload paths;
- expected state diffs;
- human verification steps.

`NEEDS_INPUT.md`:

Только реальные блокеры, например:

- final name/symbol;
- signer addresses;
- allocation;
- authority model;
- metadata URI;
- rate-limit risk cap;
- LP ratio;
- RPC credentials;
- wallet connection/signature.

---

# 21. Официальные источники

Все динамические адреса, версии и fees перепроверять во время реализации.

## Chainlink CCIP

```text
https://docs.chain.link/ccip
https://docs.chain.link/ccip/concepts/cross-chain-token
https://docs.chain.link/ccip/concepts/cross-chain-token/overview
https://docs.chain.link/ccip/concepts/cross-chain-token/evm/tokens
https://docs.chain.link/ccip/concepts/cross-chain-token/evm/token-pools
https://docs.chain.link/ccip/concepts/cross-chain-token/svm/token-pools
https://docs.chain.link/ccip/concepts/cross-chain-token/svm/upgradability
https://docs.chain.link/ccip/tutorials/evm/token-manager
https://docs.chain.link/ccip/tools-resources/token-manager
https://docs.chain.link/ccip/tutorials/evm/cross-chain-tokens/register-from-eoa-lock-mint-foundry
https://docs.chain.link/ccip/tutorials/svm/cross-chain-tokens/production-multisig-tutorial
https://docs.chain.link/ccip/tutorials/svm/cross-chain-tokens/spl-token-multisig-tutorial
https://docs.chain.link/ccip/tutorials/svm/cross-chain-tokens/direct-mint-authority
https://docs.chain.link/ccip/tutorials/svm/destination/token-transfers
https://docs.chain.link/ccip/tutorials/svm/source/token-transfers
https://docs.chain.link/ccip/concepts/rate-limit-management/overview
https://docs.chain.link/ccip/concepts/rate-limit-management/how-rate-limits-work
https://docs.chain.link/ccip/concepts/rate-limit-management/update-rate-limits
https://docs.chain.link/ccip/concepts/best-practices/evm
https://docs.chain.link/ccip/concepts/best-practices/svm
https://docs.chain.link/ccip/service-responsibility
https://docs.chain.link/ccip/billing
https://docs.chain.link/ccip/tools/
https://docs.chain.link/ccip/tools/sdk/
https://docs.chain.link/ccip/tools/cli/show
https://docs.chain.link/ccip/tools-resources/ccip-explorer
https://docs.chain.link/ccip/tutorials/evm/test-ccip-locally
https://docs.chain.link/ccip/directory/mainnet/chain/mainnet
https://docs.chain.link/ccip/directory/mainnet/chain/solana-mainnet
https://docs.chain.link/ccip/directory/testnet/chain/ethereum-testnet-sepolia
https://docs.chain.link/ccip/directory/testnet/chain/solana-devnet
https://docs.chain.link/resources/chainlink-developer-agent-skills
https://github.com/smartcontractkit/chainlink-agent-skills
https://github.com/smartcontractkit/ccip
https://github.com/smartcontractkit/ccip-sdk-examples
```

## OpenZeppelin и Foundry

```text
https://docs.openzeppelin.com/contracts/5.x/api/token/ERC20
https://docs.openzeppelin.com/contracts/5.x/wizard
https://docs.openzeppelin.com/contracts/5.x/api/finance
https://github.com/OpenZeppelin/openzeppelin-contracts
https://www.getfoundry.sh/
https://www.getfoundry.sh/introduction/installation
https://www.getfoundry.sh/anvil
https://www.getfoundry.sh/guides/fork-testing
```

## Safe и Squads

```text
https://docs.safe.global/home/ai-agent-quickstarts/human-approval
https://docs.safe.global/sdk/api-kit/guides/propose-and-confirm-transactions
https://docs.safe.global/sdk/protocol-kit/guides/execute-transactions
https://docs.safe.global/home/ai-overview
https://docs.squads.so/main
https://docs.squads.so/main/development/introduction/quickstart
https://docs.squads.so/main/getting-started/pricing
https://docs.squads.so/main/development/reference/time-locks
```

## Solana и metadata

```text
https://solana.com/docs
https://solana.com/docs/rpc
https://solana.com/docs/tools/surfpool
https://solana.com/docs/tools/litesvm
https://docs.anza.xyz/cli/examples/test-validator
https://github.com/metaplex-foundation/mpl-token-metadata
https://developers.metaplex.com/token-metadata
```

## Raydium и Jupiter

```text
https://docs.raydium.io/
https://docs.raydium.io/reference/fee-comparison
https://docs.raydium.io/user-flows/choosing-a-pool-type
https://docs.raydium.io/user-flows/create-cpmm-pool
https://docs.raydium.io/quick-start/deploy-cpmm-pool
https://docs.raydium.io/sdk-api/typescript-sdk
https://docs.raydium.io/reference/program-addresses
https://docs.raydium.io/security/attack-vectors
https://github.com/raydium-io/raydium-sdk-V2-demo
https://dev.jup.ag/docs/tokens
https://developers.jup.ag/blog/what-is-organic-score
https://github.com/jup-ag/token-list
```

## Docker

```text
https://docs.docker.com/reference/compose-file/
https://docs.docker.com/reference/compose-file/services/
https://docs.docker.com/compose/how-tos/startup-order/
https://docs.docker.com/engine/swarm/secrets/
```

## Wallet/account UX

```text
https://docs.privy.io/recipes/solana/getting-started-with-privy-and-solana
https://docs.privy.io/recipes/solana/standard-wallets
https://docs.privy.io/basics/react/advanced/automatic-wallet-creation
https://docs.privy.io/wallets/gas-and-asset-management/gas/solana
https://docs.reown.com/appkit/networks/supported-chains
https://docs.reown.com/appkit/authentication/socials
https://docs.cdp.coinbase.com/wallets/using-wallets/create-and-manage-wallets
https://docs.cdp.coinbase.com/onramp/introduction/welcome
```

## Onramp и gasless UX

```text
https://docs.stripe.com/crypto/onramp
https://docs.stripe.com/crypto/onramp/embedded
https://docs.transak.com/products/on-ramp
https://docs.transak.com/guides/partner-faqs
https://solana.com/docs/tools/kora
https://solana.com/docs/tools/kora/getting-started
https://solana.com/docs/tools/kora/operators
```

## Legal orientation

```text
https://eur-lex.europa.eu/eli/reg/2023/1114/oj/eng
https://eur-lex.europa.eu/EN/legal-content/summary/european-crypto-assets-regulation-mica.html
https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica
https://www.sec.gov/resources-small-businesses/capital-raising-building-blocks/transactions-involving-crypto-assets
https://www.sec.gov/newsroom/press-releases/2026-30-sec-clarifies-application-federal-securities-laws-crypto-assets
```

---

# 22. Текущий product intake

Исходное первое сообщение выполнено частично: пользователь подтвердил hybrid native macOS arm64 + Linux CI, назначение токена для Agent Teams AI и необходимость community-first прозрачной tokenomics. Открытые решения ведутся в `docs/OPEN_QUESTIONS.md`, варианты названия — в `docs/NAMING.md`, allocation/vesting — в `docs/TOKENOMICS.md`.

Не повторяй весь исходный опрос. Следующий пакет вопросов должен касаться только ещё не принятых P0 решений:

> Я принял архитектуру: Ethereum fixed-supply ERC-20 → CCIP LockRelease → Solana BurnMint → Raydium TOKEN/USDC. Основную техническую работу начинаю автономно; mainnet останется за Safe/Squads approvals.
>
> Мне нужен один пакет ответов на launch-blocking решения:
>
> `Agent Teams AI / AGTMAI` уже утверждено. Остались вопросы:
>
> 1. Оставляем рабочее предложение `45/25/15/8/6/1`, founder ≤3% внутри
>    contributors, `100,000,000` supply и 9 decimals, или меняем перед freeze?
> 2. Какая live consumptive utility будет доступна до public distribution?
> 3. Какая entity выпускает token и какие страны входят в launch scope?
> 4. Кто входит в изолированные Bridge/Treasury/Emergency Safe и два Solana Squads?
> 5. Подтверждаем recoverable authority только для test/bounded beta и обязательный
>    переход на Pool Signer PDA до широкой public distribution/liquidity?
> 6. Какой максимальный bridge loss и 30/90-day liquid-supply shock допустим?
> 7. Есть ли logo, domain, site и metadata URI?
>
> Пока ты отвечаешь, я продолжаю локальную архитектуру и тестовую среду без
> mainnet rights/ABI freeze, funds или private keys.

---

# 23. Последнее обязательное правило

При конфликте между:

```text
скоростью
удобством
минимальным бюджетом
безопасностью supply
```

приоритет такой:

```text
1. Не допустить неконтролируемый mint или неверный remote pool.
2. Не допустить утечку mainnet keys.
3. Обеспечить проверяемый global supply.
4. Сохранить возможность recovery.
5. Уложиться в бюджет.
6. Улучшать UX.
```

Лучше запросить одну человеческую подпись и показать понятный state diff, чем автоматизировать необратимую ошибку.
