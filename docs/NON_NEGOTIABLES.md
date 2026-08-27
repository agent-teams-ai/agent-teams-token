# Ошибки, которые проект не повторяет

Status: обязательные product/security invariants. Ослабление любого пункта
требует отдельного ADR, threat review и явного решения владельца. Маркетинг не
может переопределить фактическое поведение контрактов.

## Supply и bridge

- Никогда не добавлять post-genesis mint, rebase, transfer tax, blacklist,
  upgradeable token proxy или скрытую admin-функцию Ethereum token.
- Никогда не mint-ить 100% supply во временный deployer или Treasury Safe.
  Genesis идёт напрямую в проверенные allocation contracts.
- Никогда не называть recoverable Solana mint authority абсолютным hard cap.
- Никогда не писать просто `fixed global supply` в beta: точная формулировка
  `fixed Ethereum issuance with governed Solana recovery authority`.
- Никогда не оставлять recoverable Solana mint authority перед широкой public
  distribution или liquidity: mainnet mint authority должна быть direct Pool
  Signer PDA и проверена на target chain.
- Никогда не считать Solana mint/release корректным без уникального finalized
  source event и exact-once message ledger.
- Никогда не списывать pending CCIP message только по timeout и не скрывать
  orphan mint, duplicate settlement или unexplained supply delta.
- Никогда не суммировать Ethereum `totalSupply` и Solana supply как global
  supply: locked backing учитывается один раз.
- Никогда не писать собственный bridge, relayer или Solana bridge program для
  MVP.

## Treasury, vesting и governance

- Никогда не перемещать treasury tokens до утверждённого бюджета/proposal.
- Никогда не выдавать обычный Timelock с generic ERC-20 `transfer/execute` за
  enforceable budget cap. Публичные caps живут в purpose-specific policy vaults.
- Никогда не считать treasury token spot value операционным runway. Payroll,
  audit, infra и legal требуют отдельного stablecoin/fiat budget.
- Никогда не разрешать treasury sales, buybacks или price support в beta.
- Никогда не давать Emergency Safe право propose, execute, mint или transfer.
  Cancellation только expiring, не self-renewable; bridge brake только down-only.
- Никогда не оставлять bridge admin, pool/LockBox owner или rate-limit increase
  под direct Safe: все такие изменения проходят Bridge Timelock.
- Никогда не оставлять bootstrap admin, случайный proposer/canceller role,
  неизвестный Safe module, guard или fallback handler.
- Никогда не принимать изоляцию Safe только потому, что адреса разные. Signer,
  device и recovery overlap должны быть ниже threshold.
- Никогда не использовать один общий founder/team cliff или cliff catch-up.
  Grants имеют отдельные старты, zero до cliff и linear stream после него.
- Никогда не смешивать assigned contributor obligations и unassigned future
  grant reserve в одной непрозрачной цифре.
- Никогда не создавать backdated contributor grant: его start не может быть
  раньше execution timestamp утвердившего proposal.
- Никогда не давать unreleased treasury/vesting/reserve balances voting power.
- Никогда не включать public Governor до flash-borrow, capture и cross-chain
  participation tests.

## Tokenomics и market

- Никогда не выдавать fixed supply за доказательство безопасного liquid supply.
  Обязательны 30/90-day overhang и worst-case sell-pressure budgets.
- Никогда не запускать peg, APY, staking emissions, own-token insurance или
  rewards, не покрытые внешним проверяемым бюджетом/revenue.
- Никогда не создавать официальный mainnet pool на `$50-100`. Это Devnet-only
  fake liquidity и не price discovery.
- Никогда не путать SDK `priceImpact`, realized slippage tolerance и post-trade
  marginal spot move: gates рассчитываются отдельно по exact fee config.
- Никогда не выбирать LP ratio из желаемого FDV и не использовать tiny-pool spot
  price как valuation, oracle, collateral или treasury accounting.
- Никогда не называть LP locked, пока Squads может его вывести.
- Никогда не считать undeployed liquidity reserve community allocation. TOKEN,
  внесённый в permissionless AMM, всегда circulating.
- Никогда не запускать liquidity mining или volume rewards в beta.

## Community distributions

- Никогда не обещать раздать весь distribution reserve заранее. Каждая wave
  требует отдельного approval и доказательства предыдущей retention.
- Никогда не называть airdrop free, если взамен нужны work, promotion, referral,
  purchase, personal data или заранее объявленная farmable activity.
- Никогда не публиковать точные thresholds до snapshot.
- Никогда не оценивать Sybil только по отдельным wallets. Cluster split не может
  увеличивать reward.
- Никогда не публиковать email, account ID, IP, device graph, PII или cross-chain
  wallet binding в Merkle leaf, logs или public manifests.
- Никогда не публиковать linkage graph или причины кластеризации по адресам;
  claim address и amount всё равно явно раскрываются как публичные onchain data.
- Никогда не мерить успех только claim rate. Нужны product retention 30/90/180
  дней, immediate sells, cluster share и appeal error rate.

## Legal, disclosure и коммуникация

- Никогда не обещать profit, APY, price growth, floor, buyback, listing,
  guaranteed liquidity или regulator approval.
- Никогда не говорить `community-owned`, `decentralized`, `immutable`,
  `trustless` или `no admin`, пока фактический control/upgrade/recovery graph это
  не доказывает.
- Никогда не подменять `community-designated` словом `community-directed`: на
  genesis binding community control равен 0%, пока решения принимают project roles.
- Никогда не считать слово utility или community юридической классификацией.
- Никогда не freeze-ить holder rights/ABI или mainnet genesis до определения
  live consumptive utility, issuer/entity, launch countries и classification.
  Local/test-only neutral implementation не является offer и разрешена раньше.
- Никогда не выдавать live utility за classification safe harbor, а Token Facts
  Pack - за замену обязательного MiCA white paper/notification/publication flow.
- Никогда не запускать offer, airdrop, pool или marketing без актуального Token
  Facts Pack, beneficial-control disclosure, unlock calendar и phase-specific
  legal gate.
- Никогда не анонсировать pool ratio и не разрешать issuer/affiliate trading без
  venue/CASP/admission и market-conduct review, restricted list, trading windows
  и disclosed LP/related-party powers.
- Никогда не скрывать related parties, signer affiliations, treasury/LP powers,
  paid promotion или конфликт интересов.

## Development и operations

- Никогда не покупать testnet tokens. Local/Devnet/Sepolia tests имеют `$0` real
  asset budget; недоступный faucet означает wait/local fallback.
- Никогда не использовать mainnet private keys или seed phrases в agent/CI.
- Никогда не называть mock/local relay реальным Ethereum-Solana CCIP E2E.
- Никогда не broadcast-ить public-network transaction без network, decoded
  operation, state diff, fee, budget, recovery и human approval.
- Никогда не проверять deployment только по source-chain transaction. Target
  owner, code/program ID, threshold, authority and balances читаются отдельно.
- Никогда не добавлять dependency без проверки current stable version и exact
  pin; test-only Chainlink Local не смешивается с production CCIP contracts.
- Никогда не писать CCIP pool adapter или supply monitor до ADR, который
  проверил совместимость EVM `1.6.4`/`2.0.0` с live SVM lane и назвал canonical
  backing holder. Npm latest сам по себе не является решением.
- Никогда не компилировать production genesis из `status: proposal`, YAML float
  или calendar-month template: только accepted config, integer bps/base units,
  exact UTC seconds, strict schema и canonical hash.
- Никогда не называть offchain policy onchain invariant; каждый guard маркируется
  как contract invariant, deploy verifier, monitor alert или legal release gate.
- Никогда не считать запуск validator доказательством совместимости реальных
  Chainlink SVM artifacts.
- Никогда не создавать универсальный EVM/Solana abstraction до двух реальных
  consumers с одинаковыми invariants и failure semantics.
- Никогда не обходить полный CI успешным changed-file/fast preflight.

Evidence and incident sources are maintained in
[the tokenomics review](research/TOKENOMICS-REVIEW-2026-08-27.md) and
[the engineering baseline](research/ENGINEERING-BASELINE-2026-08-27.md).
