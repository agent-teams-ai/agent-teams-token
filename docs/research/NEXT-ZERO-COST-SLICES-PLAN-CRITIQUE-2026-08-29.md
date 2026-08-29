# Критика плана трёх zero-cost slices

Status: completed and incorporated, 2026-08-29.

## Проверенный объект

- repository: `agent-teams-ai/agent-teams-token`;
- exact draft SHA: `1cd55150b8b4c932cf4b68b4682652663ae9fcb2`;
- plan: `docs/NEXT_ZERO_COST_SLICES_PLAN.md`;
- worktrees: четыре отдельные read-only hosted workspace без изменений исходников;
- model profile: `gpt-5.6-sol`, reasoning `xhigh`, `serviceTier=default`, fast mode
  выключен, `networkAccess=restricted`.

## Hosted jobs

| Scope | Job ID | Verdict |
| --- | --- | --- |
| Solana/SPL lifecycle | `agtmai-plancrit-solana-1cd5515-r1` | AMEND |
| Ethereum unsigned deployment plan | `agtmai-plancrit-deploy-1cd5515-r1` | AMEND |
| Slither/Linux security gate | `agtmai-plancrit-security-1cd5515-r1` | AMEND |
| Delivery/architecture/review process | `agtmai-plancrit-delivery-1cd5515-r1` | AMEND |

У всех четырёх reviews нет P0. Все P1 приняты и внесены в исполнимый план; P2,
которые усиливают честность evidence без продуктового scope creep, также приняты.

## Принятые замечания

### Solana/SPL

1. Bootstrap теперь фиксирует immutable URL, archive и binary hashes, paths и
   exact Agave/SPL versions для каждой платформы; PATH/global fallback запрещён.
2. Freeze lifecycle больше не опционален: fixture создаётся с ephemeral freeze
   authority, переводится в `None`, после чего fully signed restore/freeze
   instructions должны дойти до Token program и завершиться ошибкой.
3. Evidence содержит finalized checkpoints и позволяет verifier восстановить
   create -> revoke -> mint -> burn lifecycle, а не доверять итоговому summary.
4. Все mutation commands используют absolute binaries, exact loopback URL,
   classic Token program ID и allowlisted environment.
5. Key generation и errors не могут вывести mnemonic/private key; это проверяют
   sentinel-secret tests.
6. План больше не обещает невозможный synchronous cleanup после `SIGKILL`:
   owned lease обеспечивает безопасную stale-run reclamation следующим запуском.
7. Evidence честно сообщает, что mint authority не revoked и remint технически
   возможен только до уничтожения ephemeral key/run-dir.

### Ethereum deployment plan

1. Stable identity получила domain-separated canonical `planId`, который
   связывает FQN, build profile, source/artifact/ABI/fixture digests, constructor,
   полный creation input, chain, from, value и cap policy.
2. Trust roots коммитятся отдельно от builder output и явно test-only; builder
   не может сам объявить собственный plan доверенным.
3. Зафиксированы точные bigint EIP-1559 формулы, ceil rounding, uint256 и
   gas/block/fee invariants; cap применяется к worst-case wei.
4. Freshness связывается с block number/hash/timestamp, fee-history head, TTL и
   maximum block lag, поэтому timestamp-only quote недостаточен.
5. Independent verifier отдельно строит initcode и выполняет только allowlisted
   RPC reads. Quote криптографически связан с plan и creation input.
6. Отсутствие broadcast доказывается ограниченным transport/import graph и
   отсутствием wallet/signing/private-key dependencies, а не только поиском строк.

### Slither/Linux security

1. Compatibility preflight стал обязательным до coding: official image tag и
   `linux/amd64` digest, provenance, Slither, crytic-compile, exact solc commit и
   Forge version, плюс parity с fresh Foundry bytecode.
2. Read-only checkout совместим со сборкой через fresh tmpfs work area и
   перенаправленные out/cache/build-info; stale host artifacts не используются.
3. Expected production target/source-closure manifest и detector inventory
   исключают ложный green при нуле или неполном анализе контрактов.
4. Suppression fingerprint стал точным и versioned; duplicate, expired, unused,
   unmatched или multiply matched waivers fail closed.
5. CI использует те же triggers и exact SHA, зависит от Solidity job, различает
   policy/tool/output/environment failures и не допускает skipped-green.
6. Sanitised machine evidence загружается и при успехе, и при ошибке; отсутствие
   evidence не позволяет принять candidate.
7. Container запускается non-root, без capabilities/network/socket/secrets, с
   read-only rootfs и resource/time limits.

### Delivery и architecture

1. Добавлен Barrier 0.5: pins, compatibility и Foundation coverage фиксируются
   до запуска W1-W3, затем все workers стартуют от нового общего exact SHA.
2. Foundation/source policy охватывает каждый новый `tooling/**` root и проверяет
   `domain <- application <- adapters <- composition` через negative fixtures.
3. W3 не редактирует workflows; только интегратор подключает его проверенный
   command к существующему CI.
4. Evidence publication использует fresh owned bundle и READY-last; GitHub
   evidence структурно связывает repo/SHA/workflow/run/attempt/head/jobs.
5. Четыре specialists работают параллельно, затем ledger замораживается и только
   после этого независимый holistic reviewer работает последовательно.
6. Авторы, интегратор и remediation-workers не могут ревьюить собственный scope.
7. Root wiring разбит по slices; commit DAG и independent revert проверяются.
8. Оценка поднята с `1 450-2 400` до `3 900-6 200` authored lines. Неделя является
   условной оценкой при green preflight и параллельной работе, не обещанием за
   счёт урезания тестов.

## Оставлено вне scope

Критики подтвердили, что для этих трёх локальных slices не нужно принимать
tokenomics, vesting, governance, signers, CCIP version, liquidity или Mainnet
решения. Их нельзя молча выбрать implementation-worker-у.

## Итог

Общий verdict: **AMEND, затем можно утверждать план**. После внесённых поправок
технический scope остаётся полезным, локальным и бесплатным, но теперь его
acceptance проверяет не только happy path, а также целостность инструментов,
полноту анализа, независимость evidence и невозможность скрытого broadcast.
