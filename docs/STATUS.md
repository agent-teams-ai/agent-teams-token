# Grant accounting checkpoint, 2026-09-14

Implemented the internal contributor-grant ledger and test-only harness:
fixed allocation, per-grant schedule inputs, partial releases, non-revocable
founder kind and one-time team cancellation preserving unpaid vested value.
The new core is 137 lines; the three test files total 515 lines. Pinned Foundry
CI-profile validation passed all 37 Solidity tests, including 10,000 runs per
fuzz test and 65,536 generated grant operations (512 invariant sequences).

Slither reports one Medium `divide-before-multiply` warning for the exact
quotient/remainder formula. The candidate records it as a source-bound exception:
the remainder restores exact floor division and uint64 duration bounds prevent
overflow. The detector remains enabled, changed source/tuple bytes are rejected,
and the exception requires review before 2026-12-14 (expires 2027-03-14).
This is an explicitly reviewed warning, not a claim of zero analyzer findings.

This is accounting evidence, not custody or payout/refund E2E. Production
wrappers, reserve budget enforcement, beneficiary transfer rights, cancellation
authority and calendar compilation remain unfinished. Percentages and amounts
remain open. The accepted rules and implementation boundary are in
[PLAN](PLAN.md#agreed-accounting-slice-2026-09-14).

# Активный продуктовый статус, 8 сентября 2026

**Продуктовая testnet приёмка завершена:** настоящий AGTMAI Sepolia -> Solana
Devnet -> Sepolia round trip и третий E->B settled через официальный CCIP.
Это 100 AGTMAI test fixture, не production launch; mainnet вне scope.
Граница: [PLAN](PLAN.md). Точные identities и ATA provenance:
[public ledger](../tooling/testnet-ccip/transfer-status.md#public-transfer-ledger) и
[сохранённый JSON evidence](reports/AGTMAI-TESTNET-E2E-2026-09-08.json).

- PUBLIC `product-final-three-message-proof-success.json`, `2026-09-08T05:04:14.470Z`:
  все три сообщения settled; coherent fresh F=100, L=1, S=1, pending=0,
  backing surplus=0. Ethereum height 11658930, Solana slot 494943575.
- PUBLIC `product-final-balances-and-b-ata-proof.json`, `05:04:59.366Z`:
  E wallet=99, A=0, B=1 AGTMAI; B native SOL=0, без B funding/signatures.
  Стандартный Associated Token Program создал ATA отдельной транзакцией
  перед официальным автоматическим Execute, с тем же payer/signer.
  OffRamp CPI не создавал ATA. B approval nonce 8 и send nonce 9 succeeded;
  inventory complete, journals сохраняются, source transfers не повторять.
- Первый E->A восстановлен вручную после official remote-pool repair,
  без replacement source. Reverse API всё ещё HTTP 404; UNTRUSTED receipt hint
  работает с native/SDK authentication, finality, effects и message binding.
  Full native status всех трёх сообщений успешно выполнен обычным CLI.
- P2 stale snapshot исправлен `1f44039`, независимый ACCEPT: Ethereum <=30 min,
  Solana <=5 min; missing/future/invalid/stale timestamps исключают exact.
  После реального Solana RPC 429 / Retry-After 10, `d06f816` добавляет ровно один
  retry <=10 sec только allowlisted read-only methods; write retries отсутствуют.
  SDK уже фильтрует InProgress. 31 status/RPC test passed; `3fd2fd3`:
  171 default tests, 0 skips, lint 0 diagnostics, typecheck pass.
- Negative deployed-pool rate-limit `eth_call` — simulation rejection,
  не broadcast router rejection. Минимальный MVP scope не расширен.
- Main `370c` интегрирован в `255138f`; burn review `8e` ACCEPT, artifact
  approval ACCEPT_REFRESH; `e403d49`: 141 local-EVM + 7 native checks passed.
  Полный `pnpm check` на `ab69885` прошёл, включая 416 rollback tests с 1 skip.
  Последующий sealed proof failed на forge fmt двух test statements;
  исправлено `c370232`. Повторный proof `7a6465d` дошёл до Slither survivor
  и выявил отсутствующую CCIP source assignment; он завершился ошибкой и
  не является successful sealed proof. Исторический полный proof `75418030`
  остаётся evidence только своего SHA.
- `7268cfc`: оба token contracts входят в настоящий Docker Slither analysis.
  647 security tests passed без skips; штатный CLI и отдельный evidence validator
  завершились с exit 0. Policy clean, 0 blocking, 12 visible, 0 suppressed.
  Три обновлённые информационные записи рассмотрены независимым reviewer;
  исходные captures Slither/Foundry сохранены побайтно в test fixtures.
- CI `34191565273` на `b6939ec`: Solidity job passed; весь run failed.
  Исправлены runner context placement (`b181126`, independent ACCEPT) и
  точное `gc.auto=0` от checkout (`8a56dc2`, independent ACCEPT).
  Сбой Solana reclaim после TERM воспроизведён независимым аудитом: Linux
  teardown мог временно скрывать cmdline/environment до исчезновения PID.
- `1e76206`: bounded polling различает завершение исходного процесса,
  подмену identity и неполные наблюдения. Каждый сигнал требует свежей полной
  аутентификации; неоднозначность не разрешает удаление run. HIGH review ACCEPT,
  58 filesystem tests и полный strict Solana suite 192/192 без skips passed.
  `e72e056` только переразбивает тесты и добавляет новый test path в rollback
  ownership; production implementation сохраняется. Lint и typecheck passed.
- Итоговая Linux/Docker и sealed rollback qualification выполняется workflow
  `CI` на exact HEAD PR. Принимать её можно только по green run и проверенному
  immutable artifact с READY; исторические тесты выше не заменяют этот gate.
  При неуспешном run устраняется конкретная недоказанная фаза. Mainnet launch,
  новые сети, tokenomics, liquidity и developer frameworks остаются вне scope.

## Исторические setup/checkpoint evidence, 8 сентября

Ниже исходные наблюдения до settlement; текущие balances и remaining work выше.

- Solana Devnet mint `13Q74er9thh3my9oACjChDhtn4znJibWBp1u8q1rAYau` создан.
  Journal/RPC подтвердили exact finalized transaction, standard SPL, decimals 9,
  supply 0, исходный mint authority тестового payer, freeze None. Signature:
  `3piZtyGu7R16EgNBDdpdYURmoQjMJ7pdzExBhoXCRkhLmcQfVAATVS6qnMGfbubzYJ31RVezTXGpAEHDN8ZkT9bp`.
- Sepolia token `0xbee91ba3ca94dd7c639ee6c1b1c2fc1a1996cdc9` подтверждён
  exact-finalized-receipt. Transaction:
  `0xb4abc127a893bbe451fedf71a51d9a6e90b4e186b29775e5dea79398ea0b1837`.
  Canonical block-bound calls подтвердили supply 100 тестовых AGTMAI, decimals 9,
  весь fixture balance у тестового администратора и ожидаемый getCCIPAdmin.
- Исходная низкокомиссионная транзакция заменена одной осознанной fee-only
  операцией с тем же nonce 0 и теми же deployment bytes. Оба журнала сохранены;
  использовать fee-recovery settings для reconciliation и pool prerequisite.
  Production supply/allocations не менялись; faucet funding получено в обеих сетях.
- Solana BurnMint pool `DQ2LpgGVwXc62NNkqrwmhLMkUWuxVzMJhyt4p2Yw5aiJ`
  инициализирован и финализирован. Exact transaction и 368-byte State/BaseConfig
  проверены по mint/owner/signers/ATA/router/RMN/defaults. Signature:
  `5PyfuSbAUMEsybeFxLGyXWNsp8sS4qm3S85eJJPAEJa1L5s34S6DfXNis3Ui39WHYwDsN647XoDTxQcXiUdXFuT7`.
- EVM LockRelease pool `0x24508e2eb3bedc086318abc054153fd83823a4e2` финализирован,
  exact successful receipt подтверждён. Tx:
  `0xd6b574e9dc7391d00cf7b2ca4addb7593f32aeb2ce39c146f48a46126dd21521`.
  Canonical block calls подтвердили token/owner/decimals/router/RMN.
- Remote pool identity для EVM: raw 32-byte Solana Pool Config PDA. ABI calldata
  подготовлено. EVM register-admin, accept-admin и set-pool финализированы; set-pool
  transaction: `0x8d7731e8fa00d1ccc42c810da65ecd1d1c50602a57d7b5e35e92f7b5716e2a5d`.
  EVM remote configuration отправлена:
  `0x886aa9cc62b2740f7a9f75e072e10b3dd909597b29803f710fd271b83e232c54`,
  на том checkpoint финальность ещё ожидалась, до первого CCIP transfer.
- Solana pool ATA, proposal/accept administrator и передача mint authority
  официальному pool signer финализированы. Authority signature:
  `QacXkW3hAjKof1K7zCGHhjRKrLFXweNhcxmLXzntQ2V6Mzs7uL7hzk5YCKW2L44rBp8wB9hDZ9gtkh6VMFJprzB`.
- Solana remote chain init и append Ethereum pool финализированы. Signatures:
  `TpYd5Q85cqC7Ak2LNGqZs6cVzAx71E6HRYdfxxrJSzc2RiSmGsMJnJScarUFPC25qsFwL899hNa6g3eQCUtWyUu`,
  `RmS8YGMv5uWTUWQtch7w3tReRK6UY8hNHbnjQF9teBCVjWfMLtdaQTD73G5ba9yFjmYGM3HTcocJuMUQuaFzUZN`.
  Live registry v2 и ChainConfig allocation подтверждены официальным source;
  прежние observer length errors исправлены без повторной отправки.
- `d401b53`: 105 focused local tests без skips. `0908aba`: native Linux 3/3,
  включая captured live ChainConfig, exact SDK builders и отрицательные cases;
  независимый review ACCEPT. Rates, ALT и setPool Solana финализированы.
  ALT `595XKFP6v7zGTtSuA9h19BdA4q7hmcGTFiHSLRsmV6ru`; setPool signature:
  `3j9vHPuCTtQ6YSHxaVjVT3Pk3LCn4UoQKpdgkp9yw84xUBxKD9iPZmZz972oNmhNGTWpWEnD74yapY4VpFCEkBnA`.
- `f9d5613`: 82 focused Linux tests и отдельный native SDK signature/layout test
  прошли без skips; strict TS/lint прошли, независимый bounded review ACCEPT.
- EVM LockRelease deployment CLI и extraction на `f1600ae` получили независимый
  bounded ACCEPT без найденных P0/P1/P2. Registration CLI реализует отдельные
  register-admin/accept-admin/set-pool journals и finalized prerequisites;
  6 focused tests прошли, независимый bounded review ACCEPT.
- Исторический полный proof `7541803056db1815258a418459c450510e81640a` сохраняется:
  Mac20, Linux check:linux, sealed rollback, Docker Slither. Это не proof нового HEAD.
  Новые focused gates на `f1600ae`: 61 test, strict TS и lint прошли.
- Reverse consumer `f07c490`: independent ACCEPT, Linux 108/108 tests,
  native v0 signing/inspection на истёкшем TEST payload прошёл без broadcast.
- Status consumer `ddd88a8`: independent ACCEPT, 11 focused tests; live native
  baseline с чистым JSON подтвердил fixed supply 100000000000 base units,
  locked 0, Solana supply 0, backing surplus 0. Это исходное состояние,
  не доказательство межсетевой доставки.
- Pinned SDK подготовил unsigned forward 1 AGTMAI и exact bounded approval;
  calldata независимо сверена; на том checkpoint send ещё не был подписан. Котировка комиссии сохраняется
  как evidence подготовки и должна обновиться перед реальным подписанием.
- Mainnet, tokenomics/allocations и liquidity остаются вне текущего этапа.

Ниже сохранён исторический статус с его исходным объёмом evidence.

# Project status

Last reconciled: 2026-09-05. Earlier evidence below retains its original scope;
it must not be read as a current exact-head full-gate pass.

## Current execution checkpoint

This bounded correction uses clean base `ec980e345275285144b28135eb3793e1072128c8`.
The recorded integration evidence below does not qualify the edited
head. This checkpoint supersedes older current-state claims and job observations.

- Proven on clean Linux `ab97c6b9f1aab20c0acbe740ad2a6692b90cacde`: the actual
  production plus vulnerable Slither Docker gate and finalized validator passed,
  exit 0/0 in 15.044s; 101 detectors, 11 visible findings, 0 blocking and
  0 suppressed. Pins remain unchanged. Four actual Docker interruption cases
  passed: SIGINT/SIGTERM at creation/completion, exit 130/143, each exact created
  container absent afterward and no READY; no Docker result substitution.
- Actual EVM process tests passed 23/23 on both Mac and Linux `ab97c6b9`, with
  zero skips. The parent-publication worker passed 187/187 using synthetic
  analysis inputs and protocol responses; that is simulated, not Docker evidence.
- The recorded full Mac Slither suite is not green: 622 total, 577 passed, 32 failed,
  13 Linux-only skips. Of the failures, 31 new fixture failures came from the
  `/tmp` versus `/private/tmp` seam identity and were tracked separately.
  The one existing Python 5s timeout passed in isolation at 3.49s; that retry
  does not convert the full run into a pass.
- Solana focused Mac tests passed 53/53 with zero skips; typecheck and
  Foundation 0.20.0 passed. Strict real Mac integration passed 4/4 with zero
  skips in 109.440s: one mint/burn/negative-authority lifecycle and three rounds
  of two separately spawned fixtures. These checks used the exact source bytes
  immediately before the mechanical base commit, before this lint correction.
  The pinned oxlint run reported two snapshot diagnostics, addressed here;
  final exact-head qualification remains pending. Post-fixture offline bootstrap
  verification was still running at dispatch; its result is not inferred.
- The first full Linux `check:linux` stopped at correctly rejected leaked Solana
  snapshots, before full root checks or rollback proof. Legacy copies were
  authenticated and quarantined outside the installation without deletion.
  The new explicit snapshot lifetime prevents that placement error; actual Linux
  qualification of the new bytes is pending. See [the correction](PLAN.md) and
  [publication contract](../tooling/security/slither/src/README.md).
- Not proven for this candidate: full `check:linux`, sealed three-slice rollback
  proof, final Mac/Linux sets, four specialist reviews followed by sequential
  holistic review, fresh GitHub main semantic reconciliation and exact-head
  GitHub CI. No PR exists; last observed main was
  `370c3aac97e4b3ddc7fcc9ada762a050580d0f39`. Old-SHA results cannot qualify a new head.
- The user's checkout was untouched. Public networks, real keys, broadcast,
  token mechanics, fixed supply and allocations remain outside this work.
  Existing production-only deferred scope below stays deferred. The full
  [three-slice plan](NEXT_ZERO_COST_SLICES_PLAN.md) and its
  [critique](research/NEXT-ZERO-COST-SLICES-PLAN-CRITIQUE-2026-08-29.md) remain intact;
  root owns final qualification and subsequent status reconciliation.

## Historical execution checkpoints (4 September)

15:45 UTC: Solanaabf837 candidate has79Mac pass/5Linux-onlyskips plus13/13
runner cases, TS7/lint pass;126 independently reviews its publication semantics.
Slither122 AMEND three uncovered publication failures ->writer125.120 still
reviews full recovery base.121 main merge strategy is recorded, not applied.
Removed only19 reconstructible inactive Node/staging copies, archive retained;
oldhost8GiB free at latestlaunch.120/125/126 alive/fast; originalscope stillOPEN.

15:28 UTC: custody118 ACCEPT47fe delta;120 now reviews whole recovery base.
Slither e9292 passes141/141Mac,0skips, TS7/lint;122 independently reviews.
Solana119 UNAPPLIED because uncertain close is retried;123 corrects it on6b877.
121 plans semantic main reconciliation. Allfour hosted jobs alive/fast.
Disk4.6GiB blocks NEW provisioning only; no cleanup or source removal yet.
Accepted integration31e909 unchanged; full original E2E remains OPEN.

15:12 UTC: custody47fe passes50/50Mac,0skips+lint, reviewed by118. Slither114
patch is deliberately UNAPPLIED: unsafe recursive cleanup/silent errors go to117.
Solana116 confirms prior fixes but AMEND leaves twoP2s: postREADY close failure
and dying-validator reclaim transition;119 owns them. Linux73/74,0skips, notgreen.
Automation now reads the newest ledger for jobs/SHA instead of stale snapshots.

15:05 UTC: Solana6b8770c7 passes69Mac tests with5Linux-onlyskips, TS7/lint;
111 plus main READY-link rollback and actual config fixtures, underreview116.
Slither112 AMEND found late-cancellation falseREADY, owned by114. Custody113
accepted7437delta, but independently proved inherited ancestor metadata
false rejection;115 corrects only ancestors, keeping owned targets strict.
114/115/116 alive and fast. Accepted integration31e909 EVM86/86 unchanged.

14:58 UTC:111 returned a full unapplied source patch, testsNOTRUN after bwrap;
one real process-test fixture was absent from its packet and still needs
adaptation by the integrator.112/113 remain observed alive. Integration was still in progress at that checkpoint.

14:56 UTC: EVM review109 ACCEPT integrated at31e909f7 with cleanup regression
registered in the root command; TS7/lint pass, combined actual EVM86/86,0skips.
Slitherb74e passes135/135Mac,0skips and TS7/lint; independent112 reviewing.
Solana108 AMEND found3publication/config-at-use gaps, owned by111.
Custody7437 has15/15focused; expanded46/47 exposes an inherited ancestor
metadata issue, explicitly under113. All111/112/113 observed alive and fast.
Other slices and full original-plan E2E remain open; read the latest ledger.

14:45 UTC: EVM25b33245 passes39/39Mac, TS7/lint; independent109 is running.
Custody105 AMEND found2inherited production close/acquisition gaps, owned by110.
Slither106 completed, not yet applied; Solana108 is still reviewing80bb.
Three hosted jobs108/109/110 are observed alive, all fast/priority.
No new source has entered accepted integratione723; full E2E is still open.

14:40 UTC: review103 AMEND found3Slither cancellation/terminal-deadline gaps,
owned by106. Review104 AMEND found blocking FIFO reads in EVM, owned by107;
its independentLinux37/37 did not cover FIFOs. Custody598b Mac41/41 is under105.
Solana80bbca47 passes Mac31+1Linux-onlyskip, TS7/lint after main runtime-syntax,
cleanup, held-payload and FIFO corrections; independent108 is being launched.
105/106/107 are observed alive. Old-host IO delayed105 provisioning; newer jobs
avoid duplicate tool extraction, not test or sandbox requirements. No new
source is accepted/integrated and full original-plan E2E remains unfinished.

14:27 UTC supersedes the snapshots below: isolated Slither fb416ec1 passes
130/130Mac tests and TS7/lint. EVM1f4fc8d8 passes actualMac runner7/7 and TS7/lint;
focused37cases are covered across36pass+1focused timeout retry. New cleanup
tests still need root command registration at integration. Solanaa2261b36 has
21pass1Linux-onlyskip; confirmed held-file/READY publication gaps belong to102.
Custody101 is applied as598b5788: actualMac14/14focused and41/41expanded,
lint pass; independent105 is being launched.102/103/104 are running/alive after verified removal
of11 inactive duplicate Node copies. No source or evidence was deleted.
No new checkpoint is accepted or integrated.

14:04 UTC supersedes older entries: custody4c93 passes32/32 actualMac and lint,
now under independent fast reviewer99. EVMcfba covers all7realMac runner cases
(6pass plus1focused retry after timeout), publication/process30/30; review98
still found P1 mutable-file-state and P3 diagnostic-precedence gaps, owned by
fast writer100. Recovered96/97 patches are preserved, not applied/accepted.
Mac ENOSPC was relieved by removing only a duplicate inactive Agave tool copy;
the primary copy and all source remain. Original user worktree is unchanged.

Current accepted code e723bc0d includes independently accepted Solana raw-wire
verification. ActualMac source coverage:90total,87pass,3Linux-only skips,0fail;
real integration4/4 has no skips. Review92 found another P1 in filesystem FD
teardown despite earlier33/33actualMac tests; writer95 fixes it, not integrated.
Slither91 is an unaccepted draft: TS7 passes, firstMac16/17 and9lint findings.
Independent hosted93/94 cover legacy Solana provenance and initial publication
bounds. All new jobs use fast/priority on the old server; read the ledger first.

13:33 UTC: wrapper87 is independently ACCEPTed, Linux11/11 and actualMac
portability evidence. Solana wire374a7d49 passes34focused cases, TS7/lint and
is under independent89 review plus realMac integration. Custodye2b67d4a passes
22focused cases but expanded26cases exposes3failures from one Darwin
post-rename path-registry defect; bounded fast writer90 is correcting it.
Planner88 continues on Slither deadlines. None of these statuses is full E2E
acceptance, and no unaccepted recovery base entered the main candidate.

13:28 UTC supersedes earlier snapshots: complete original-plan audit80 is
preserved in research/ORIGINAL-PLAN-INVARIANT-AUDIT-2026-09-04.md. Integration
code remains b95c66be. Portability88d5daab passes actual Mac18/18focused and lint,
but review82 left four other custody findings, now owned by fast writer85.
Fast writer86 independently implements Solana raw-wire checks. Both are running
on the old host. Wrapper430b0b52 has a passing actual Mac Bash3.2 behavior test;
the diagnostic composition also passes10authority and16cleanup tests. It is
not accepted/integrated recovery. Actual Mac Solana integration passed4/4,
0skips, including real lifecycle and three parallel-process stress rounds.
Writers85/86 are terminal and their outputs await verification. Independent
review87 and Slither deadline planner88 are running, both xhigh/priority.
Hosted editor failures were not bypassed: complete writer patches were recovered
and applied locally; new jobs include exact source packets as a drafting fallback.

### Earlier checkpoints

13:04 UTC: independent review79 accepted solc redaction with no findings;
both source fixes are integrated in `b95c66be`. The combined actual Mac EVM
integration suite passed7/7, no skips. Custody75 completed a clean checkpoint
awaiting review/Mac verification; complete-plan audit80 is active.
Archive78 made no patch because its editor failed; main made a bounded
local +71line fix and is provisioning independent Linux review81.

The original user-path plan has additional remediation requirements missing
from this candidate's plan copy. Audit80 is reconciling them explicitly; do not
claim that recovery is the only remaining scope. Earlier statuses are historical.

13:07 UTC: actual Mac custody75 is NOT accepted:17tests9pass8fail, plus31scoped
lint errors. An accepted temporary-path spelling is rejected during handle
revalidation; two new fixtures also misuse the strict canonical-path API.
Independent review82 is running, and bounded writer83 is being provisioned.

12:53 UTC: redaction writer77 completed cleanae60e200 (two files). All25
focused actual Mac cases are covered after correcting two Anvil PATH setup
failures; local-EVM TS and scoped lint pass. Independent fast review79 is
running before integration. Active jobs are custody75, archive78 and review79.

Latest update at12:51 UTC: deployment review76 returned ACCEPT with no findings;
the fix is integrated as7d07a10c. Combined root lint, root TS build, deployment
TS and full Foundation checks pass. Solc redaction77 and recovery custody75
remain active; independent archive single-link writer78 has started in fast.
Spike74 completed the offline store comparison; package authority itself is
not implemented/accepted. Earlier snapshots below are historical.

Latest update at 12:42 UTC supersedes the earlier snapshots below:
toolchain checkpoint has independent ACCEPT and is integrated as `caedc5d6`.
Solc checkpoint `7926ace` passes all 7 actual Mac runner integration tests;
deployment checkpoint `d1bd4d95` passes 125 actual Mac tests including real
Anvil, with 3 Linux-only skips. Both await running independent fast reviews.
Recovery70 ended incomplete on process/namespace EAGAIN; its partial is
preserved and a fresh filesystem writer75 is active. Pinned-pnpm spike74 is
running independently. New jobs use priority/fast; implementation medium,
review xhigh. Full-plan acceptance remains open, not production clearance.

12:44 UTC: solc review73 found one new P2 in exposed error-cause stderr;
the two earlier P2s are closed. Dedicated fast writer77 is fixing only redaction
and its regressions before integration. No real key leak was observed.

Update at 12:05 UTC: `account-m` (`tv goog five`) passed a fresh live check.
Four new isolated hosted writers reached model execution: deployment-closure67,
toolchain-lint68, solc-p2-closure69 and recovery-custody70. All use medium,
no fast, network disabled; old partial workspaces remain untouched. The quota
snapshot below is historical. No new writer result has been accepted yet.

Update at 12:18 UTC: all four writers are active; toolchain68 resumed its
inspected partial changes after an intentional guidance interruption. A fifth
read-only xhigh planner is comparing minimal authenticated dependency-cache
designs for the next recovery checkpoint. Main is unchanged at `370c3aac`.

- Code candidate: `7d07a10c70fd5c898152eadccae8e3e4e5bd0ba6`, in the isolated
  `/tmp/agtmai-r212-integration2` worktree. The user's original worktree is untouched.
- Native provenance remediation is integrated, but Foundation, TypeScript and
  lint are not green. Its remaining defects must be fixed before acceptance.
- The Darwin test portability fix is integrated and verified on actual macOS:
  focused native-helper tests: 17 passed, 0 failed, 3 Linux-only skips;
  deployment-plan suite: 120 passed, 0 failed, 4 skips, including the separate
  real-Anvil opt-in test. This is not a full E2E acceptance claim.
- The separately enabled real-Anvil suite fails: 2 passed, 1 failed, 0 skipped.
  The new shared JSON parser incorrectly applies the 64 KiB policy-file bound
  to real Forge build-info. A current valid build-info is 1,366,773 bytes and
  contains a 33,914-byte string, exceeding both the byte and string bounds.
- Local-EVM source review: AMEND, no P0/P1, two open P2 findings.
- Separate recovery source review: REJECT, seven P1 plus P2/P3 findings;
  portable filesystem custody and archive/package execution authority remain unproven.
- Four hosted writer attempts ended partial after quota exhaustion. Their dirty
  workspaces/patches remain isolated and are not accepted code. No r212 worker
  was alive at the 11:25 UTC reconciliation.
- Earlier hosted pool snapshot: no eligible account in the 25-slot registry.
  Those checks confirmed quota exhaustion for l/v/w/y/t and reconnect-required a/g;
  fresh account-m availability now supersedes that snapshot.
  Do not retry these before new capacity/auth evidence; no safety bypass.
- Full exact-head CI, independent final reviews and safe main reconciliation
  remain outstanding. No Mainnet or production clearance is implied.

See [the reconciliation ledger](research/E2E-RECONCILIATION-2026-09-04.md)
for exact source commits, remaining work and the safe continuation contract.

Approved product identity: `Agent Teams AI`, symbol `AGTMAI`. Formal pre-launch
clearance remains required.

Liquidity direction: trading is required, founder total cash contribution is
capped at `$100`, and community liquidity must be added directly by its owners.
The first pool is explicitly experimental and highly volatile, not depth or
valuation evidence.

Tokenomics working baseline, still under discussion: `45/25/15/8/6/1` for the
community-governance reserve, distributions, all contributors, operations,
ecosystem grants and liquidity. Founder is capped at 3% inside contributors.

## Proven locally

- Monorepo dependency installation is reproducible from the lockfile.
- TypeScript 7 typecheck, lint and domain tests pass.
- The pure supply projection covers quiescent and both in-flight bridge
  directions; it is not yet a finalized event-ledger source of truth.
- Public networks are disabled by default.
- Node 24.20.0, pnpm 11.24.0, Foundry 1.8.0 and solc 0.8.36 are pinned by
  platform-specific checksums for macOS arm64 and Linux x64. Fetch, offline
  install, tamper recovery and fail-closed verification are implemented.
- Foundry 1.8.0 native and containerized Anvil are verified on chain ID 31337.
- Engineering Foundation 0.20.0 is installed dev-only; applicable architecture,
  dependency, documentation, ADR, suppression and quality-gate policies pass
  static validation.
- The containerized Anvil RPC responds on host port `8545` with chain ID 31337.
- Native Agave validator RPC responds on host port `8899` with version 4.2.1.
- Local, Sepolia and Solana Devnet testing has a `$0` real-asset budget; fake
  USDC and faucet test tokens are never purchased.
- Confirmed historical and design anti-patterns are frozen in
  `docs/NON_NEGOTIABLES.md` as an implementation/review contract.
- Six independent critics returned `AMEND`, not `REJECT`; accepted amendments
  and deliberately unresolved choices are recorded in
  `docs/research/CRITIQUE-ROUND-2026-08-27.md`.
- Four contract designers and five independent critics reviewed the release,
  governance, liquidity, security, economics and architecture proposal. The
  synthesis is recorded in
  `docs/research/CONTRACT-DESIGN-REVIEW-2026-08-27.md`; those earlier reviews
  used the disclosed local read-only fallback, and no contract code started.
- Five additional independent read-only reviews ran on production hosted
  subscription runtime against exact commit `853a14a` using `gpt-5.6-sol`,
  `xhigh` reasoning and fast service tier. Their accepted findings narrowed the
  executable first slice and are recorded in
  [`GENESIS-CORE-PLAN-CRITIQUE-2026-08-28.md`](research/GENESIS-CORE-PLAN-CRITIQUE-2026-08-28.md).
- Strict proposal/local-fixture separation, canonical manifest compiler,
  content-addressed READY-last artifact store and shared ABI/hash vector are
  implemented. Exact commit `d88edb4ffb2f7d3bfd7552b375bc5850cef5b835`
  passes Foundation 0.20, lint, TypeScript, 5 supply-domain tests and 30
  manifest tests on macOS arm64 and Linux Node 24.20.0.
- Immutable local-candidate `AGTMAIToken` is implemented without external
  mint/admin/proxy/pause/tax/blacklist paths. The code-identical Barrier 1
  commit passes 19 Foundry tests, including 10,000-run fuzzing and 65,536
  invariant calls, on macOS arm64 and Linux. This is local evidence, not an
  audit or production deployment approval.
- The local Anvil runner rebuilds with the pinned solc, deploys only to chain
  ID 31337, and is independently verified against trusted manifest, artifact,
  build-info, constructor input, runtime code, state and balances. Redirect,
  symlink, forged-evidence, parallel-run and interrupted-cleanup regressions pass.
- The current macOS arm64 full gate passes Foundation 0.20, lint, TypeScript,
  package tests, Linux-definition parity, canonical vectors, deterministic
  dependency/secret/license policy, 28 local-EVM tests and 3 isolated integration
  scenarios. No public RPC, real secret, real asset or paid gas was used.
- The local Solana fixture now completes a real classic SPL Token lifecycle on
  checksum-pinned Agave 4.2.1: supply `0 -> 1,000 -> 0`, freeze authority is
  irreversibly removed for the fixture, signed restore/freeze attempts fail,
  parallel runs remain isolated and no key material is retained. The verifier
  also proves zero supply immediately before minting, and stale-run leases bind
  PID plus process-start identity. All 42 applicable tests pass locally at real
  asset cost `$0`.
- The unsigned Ethereum deployment planner now binds the exact creation input,
  immutable test-only trust roots, buffer, fee-history/block facts and strict
  `blockTimestamp <= observedAt <= now < expiresAt` ordering. Its READY-last
  output uses an exclusive owned `0700` directory and rejects symlink,
  replacement and pre-existing-target attacks. Sender nonce, deterministic
  CREATE address, observation block and repeated trusted-clock checks are part
  of the reviewed identity. All 42 applicable tests plus the real loopback
  Anvil test pass; there is no signer or broadcast capability.
- The pinned Slither gate now runs the real Trail of Bits image digest as its
  immutable non-root user, mounts checksum-pinned Forge 1.8.0 and solc 0.8.36,
  analyses the six-file production closure with all 101 expected detectors and
  emits READY-last evidence. The real container reports 11 visible
  informational findings and zero blocking findings; all 61 unit/contract
  tests pass, including hostile serialized-output cases. This is
  static-analysis evidence, not an audit.
- Engineering Foundation 0.20.0 governs all three new feature roots with exact
  entrypoints and `domain -> application -> adapters -> composition` edges;
  the full gate reports zero diagnostics. Changed-only routing for non-TypeScript
  files in those roots remains a recorded P2 follow-up and is not represented as
  complete Foundation coverage.
- Five exact-SHA implementation critics and their remediation ledger are recorded
  in [`GENESIS-CORE-CODE-REVIEW-2026-08-28.md`](research/GENESIS-CORE-CODE-REVIEW-2026-08-28.md).
- The first final review of exact SHA `ec735a6` accepted Solidity and the
  holistic slice, and returned six blocking P1 findings across CI, manifest and
  local EVM. Commit `416ca13` closes all six with regression tests.
- Frozen code candidate `816bb10dc305741cb3ce7b0d5603aa6828c44732`
  passed all three Linux GitHub Actions jobs in run `33192539415`: Solidity,
  Foundation/TypeScript and isolated local-EVM E2E. Three affected exact-head
  hosted reviews returned `ACCEPT` with no findings. The holistic review found
  no code defect and requested only that this completed evidence replace the
  stale pending text in the review ledger.
- Barrier 2 is closed for the frozen code candidate. The evidence-recording
  documentation commit does not change product code and must independently
  retain green exact-head CI before merge.
- Frozen zero-cost-slices code candidate
  `4037e4b52ad4d8a1180ee8c7bf771de0d88f0819` passed all six GitHub Actions
  jobs in run `33258983415`, the complete local gate, real Agave and Anvil E2E,
  and the pinned Slither container. Four independent specialist reviews and a
  later holistic `gpt-5.6-sol xhigh` adjudication inspected clean detached
  checkouts of that exact SHA. The holistic verdict is `ACCEPT` with no P0/P1;
  its immutable result SHA-256 is
  `63ac52096a6875a68fc47f1eebcb9303396c2203e461a93dcd6499234a499cb2`.
  Barrier 3 is closed for this code candidate. This is local/test-only
  engineering evidence, not an audit or public-deployment approval.

## In progress

- The earlier remediation of nine retained P2 and six P3 zero-cost-slice
  findings has local evidence for Foundation full-scan routing, decoded-byte
  creation-input hashing, authenticated local-EVM recovery, owned Anvil ports,
  durable deployment publication, compiler-input identity, independent Slither
  evidence and fail-closed Solana evidence. R7 nevertheless returned `AMEND` on
  the current rollback delivery. Published history mixes slices and original
  isolated worker identities are `unavailable`. The remediation implementation
  is now integrated: each manifest application is followed by production-path
  rollback, exact tracked-byte/status/inventory comparison, strict survivor
  gates and a forbidden-residue check. Cleanup is descriptor-anchored,
  quarantined, exact-target allowlisted and bounded by entry/depth/path limits;
  symlinks are unlinked as link objects and deterministic child/final-directory
  substitution preserves the foreign identity and fails closed. Structural
  validation or preparation alone is still not the required exact/full proof.
- The accepted recovery review found five additional proof defects. Current
  remediation captures the byte-complete candidate immediately after
  exact-head/full-history validation and before checkout bootstrap/cache/
  workspace execution, then revalidates it afterward. Foundry and pnpm
  installations are compared against payloads freshly derived from the
  descriptor-opened repository-hash-pinned archives; solc is compared with its
  descriptor-opened executable archive. Mutable install provenance is not byte
  authority, no new inner digest was invented, and absent archive authority is
  reported explicitly. Recovery evidence now has a strict closed schema,
  independent exact-gate/artifact validation, deterministic canonical proof
  digest outside volatile telemetry and validated READY-last publication. CI
  uploads verified proof only after success and labels failure output as
  diagnostics. Every rollback architecture/script/history/test surface is
  mandatory Foundation full-scan routed with negative coverage.
- Final rollback-manifest shared/retained transitions were regenerated from the
  exact current worktree bytes. Current-byte coverage and production apply
  regressions pass as
  `REHASHED_WORKTREE_VALIDATED_PENDING_EXACT_HEAD_FULL_PROOF`; the earlier
  structural result remains invalid and must not be cited. Clean exact-head
  `--validate-only` awaits an externally created candidate commit because this
  remediation is explicitly no-commit. The current host lacks the complete offline Foundry, solc, pnpm and
  Agave archive cache set and cached Slither Docker image, so preflight stops
  before dependent gates and no full local proof is claimed.
- The rollback threat model is isolated local/CI execution at an exact commit
  with zero-cost identities; network access, public RPC and real secrets/assets
  are disabled. Kernel/filesystem descriptor semantics, fixed runtime,
  repository object database, the executing process and held descriptors are
  trusted; manifests, caches, command output and pathnames are
  untrusted. Symlink, mount and parent/child/final-name substitution before
  atomic quarantine or final identity revalidation are in scope and preserve a
  foreign identity. A continuously scheduled same-UID peer racing the separate
  final Node identity-check and unlink/rmdir syscalls, or the destination-
  absence check and following rename syscall, is explicitly out of scope, as is
  a root, capability-bearing or otherwise OS-privileged peer able
  to bypass mode `0700`, kernel or process-memory/descriptor compromise, and
  hostile runtime replacement. This proof is therefore not evidence against
  same-UID final-syscall races or privileged local peers; crash or `SIGKILL` may
  leave owned residue but never broadens cleanup.
- No custom cleanup helper remains. Linux x64 runtime provenance is now bound to
  the checksum-pinned Node `24.20.0` archive, independently pinned inner
  `bin/node` SHA-256, canonical install record, exact `process.execPath` and the
  loaded `/proc/self/exe` file identity/digest. Coherent binary/provenance
  substitution therefore fails the immutable inner hash. Darwin arm64 fails
  closed because an equivalent loaded-image binding is unavailable. The fixed
  Linux runtime is trusted only after these checks; later hostile replacement
  remains out of scope. This work is not an audit or production,
  Devnet or Mainnet readiness.
- Exact-head/full-history wiring is integrated into the existing
  `foundation-and-typescript` CI job. It checks out explicit `github.sha` with
  full history, rejects shallow/partial history, replacement refs, grafts and
  both environment/file object alternates, verifies pinned-baseline ancestry,
  captures complete tracked bytes before provisioning, runs non-pulling
  cache/tool preflight before root gates, reasserts history/clean identity, and
  uploads a verified proof only after independent validation; failures upload a
  separately named diagnostic subset.
  Hosted execution for these exact bytes remains pending, so no new CI success
  is claimed.
- Ethereum Mainnet deployment remains a mandatory owner TODO. Exact final
  constructor gas, every additional contract, live fees, total-cost guard and
  unsigned-plan review must be completed before any public broadcast. The
  current cheap local core estimate is not a whole-launch estimate.
- The three zero-cost follow-up slices (local SPL fixture, unsigned Ethereum
  deployment-cost plan and Slither/Linux security evidence) are implemented and
  historically accepted for local/test-only use at `4037e4b`; the current
  rollback patch is not accepted. The proxy-disabled local-Solana,
  deployment-plan and local-EVM adapters and their Foundation dependency
  declarations belong to coordinated external lanes, remain pending and are
  neither changed nor pre-approved here; the direct-HTTP P1 stays open. They are
  followed by authoritative exact-SHA CI and fresh specialist/holistic review.
  CI source integration is present but its hosted result remains pending, and
  public-chain work remains separately gated.

## Designed, not implemented

- Vesting and mocked cross-chain accounting remain later independent slices.
  The implemented local SPL fixture is test-only and proves neither production
  mint authority nor CCIP. Production manifest approval is intentionally not
  simulated by a self-declared status or integrity hash.
- Feature-module standard from Agent Teams Orchestrator is adopted. The proposed
  two-context topology is recorded in the independently reviewed and amended
  ADR-0004 and awaits explicit product-owner acceptance. Acceptance records the
  target only; package migration remains a later separately gated change.
  The local Genesis Core plan uses accepted ADR-0003 for the new manifest
  feature but leaves the generic bootstrap unchanged until ADR-0004 is accepted
  or rejected, avoiding a temporary double migration.
- Purpose-specific release/vesting vault proposal, rolling commitments and global
  liquidization budget; governance-reserve activation remains an explicit open
  decision and ABI blocker.
- Production genesis wiring, vesting and treasury contracts.
- Chainlink CCIP Ethereum and Solana pool configuration.
- CCIP EVM `1.6.4` versus `2.0.0` compatibility ADR and canonical backing-holder
  model for the live SVM `1.6.3` lane.
- Production tokenomics approval envelope/compiler; the implemented local
  fixture manifest/hash is deliberately test-only and cannot approve launch.
- Event-sourced cross-chain monitor and public transparency dashboard.
- Airdrop, liquidity and governance execution.
- Legal entity, launch jurisdictions, live utility and final tokenomics approval.

## Not proven locally

- Real CCIP offchain delivery between Ethereum and Solana. This requires an
  approved Sepolia-to-Solana Devnet test and must not be simulated as evidence.
- Mainnet addresses, signers, legal classification, audits or launch readiness.

No production token, sale, liquidity pool or official airdrop exists.
