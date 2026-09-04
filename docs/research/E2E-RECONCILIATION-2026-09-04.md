# E2E execution reconciliation, 2026-09-04

This ledger records observed local/hosted state, not final acceptance.
It does not approve tokenomics, vesting, governance, CCIP or public networks.

## Latest reconciliation: 18:01 UTC

Accepted integration source remains `31e909f72d5470613d8875ed9266adb482ddff85`.
Recovery candidate advanced to `a7ed090094776e15136b97f7b5bb61cc91012475`,
parentd9b237, only in the isolated worktree; it is not accepted/integrated.

- Reproduced the prepared-archive return-before-finally defect: initial1/7.
  Archive close failure could strand the prepared tree, mask a primary failure
  and leave ownership unavailable to the caller. The bounded fix closes before
  transfer, aggregates primary/close/cleanup failures, releases all captured
  owners, and preserves rather than adopts an uncertain or uncaptured tree.
  Copy-target raw finalization was corrected with the existing custody helper.
- Final focused**9/9** and broader**129/129**, zero skips; syntax, scoped lint
  and diff checks pass. Two selected nearby toolchain regressions pass. One
  macOS pnpm-version test fails identically on the exact parent and is recorded
  as pre-existing environment behavior, not hidden or attributed to this diff.
  Report: `RECOVERY-ARCHIVE-PREPARATION-FINALIZATION-2026-09-04.md`.
- Conventional isolated checkpoint: +251/-29,175 focused test lines. Source
  modules remain under Foundation limits. Original user checkout untouched.
- Correct oldhost and bundle verified. Linux verifier133 did not start because
  disk was3759MiB and IO avg10 some30.16/full26.43; the unchanged5GiB guard
  correctly blocked it. No unrelated hosted data was removed. Hosted model
  capacity also remains exhausted, so no writer/reviewer was launched. Future
  jobs stay sol medium/xhigh in fast/priority mode as requested.

Next: run exacta7ed Linux structural/runtime qualification once the oldhost is
above the admission guard, then obtain independent xhigh review. Continue
review120groups2/5 and the complete R3-R8/Solana/Slither/upstream/final matrix.
Full rollback, root/CI and E2E acceptance remain suspended.

## Latest reconciliation: 17:35 UTC

Accepted integration source remains `31e909f72d5470613d8875ed9266adb482ddff85`.
Recovery candidate now `d9b237fc3d54b37392c1653fc6c1c8ac5e84a489`, parent04d0e640,
in `/tmp/agtmai-custody-76c-mac`; tracked clean, known node_modules symlink only.
No full-base acceptance or integration follows from this checkpoint alone.

- Main addressed120/P1-4 Node runtime acquisition, file transfer and terminal
  finalization. Runtime proof/file authority split into309/214-line modules;
  moved bodies were verified byte-identical before behavioral correction.
  Every remaining Node consumer uses terminal ownership/primary preservation;
  result-file transfer waits for parent close, and top-level finalization still
  attempts prepared-payload cleanup after executable/root close failure.
  No platform/hash/mode/size/provenance guard removed; Darwin stays fail-closed.
  Eight files,+486/-243 including movement;217 new runtime test/probe lines.
- Portable baseline0/11 after mechanical extraction; fixed11/11. Mac broader
  **120/120**, zero skips,8.89s; Darwin rejection regression**1/1**,zero skips.
  Syntax/scoped lint/diff checks pass; Git lock probe passed without history
  mutation. No local test process remains running.
- Ordinary Linux verifier132 completed, NOT a model worker. Root
  `/var/data/agtmai-custody132-linux.hjsmqp`, exact source d9b237;
  validation passed; **175/175** structural tests, zero failures/skips,286.33s,
  exit0, source clean. All seven actual pinned-runtime fault scenarios passed
  inside the new integration test. Local session70533 is finished; do not rerun
  this unchanged checkpoint. Existing pinned Node reused; verified bundle
  requires04d0e640, SHA256
  ee858dd4296a40b5f6bf8cca6eea45cfa8a764934c6f74e0f7949f48f8c052d0.
  Correct oldhost machine,12087MiB RAM available,4169MiB swap free,5.6GiB disk
  and IO avg10 some1.71/full1.45 checked before launch.5GB guard unchanged;
  only one heavy verifier, no new installation or duplicate Node cache.
- Report `RECOVERY-RUNTIME-FINALIZATION-2026-09-04.md` has exact Mac/Linux
  evidence/hashes and follow-up scope. Post-run disk5.4GiB; no active test process.
  Read-only inspection identified another
  return-before-finally risk in `prepareVerifiedPayload` plus its pre-try cleanup
  acquisition; reproduce before fixing. It is NOT closed by this Node patch.
  Review120group2 evidence custody, group5 partial proof construction, remaining
  architecture/R3-R8, live Slither/Solana, upstream merge and final gates remain.
- Fresh17:22 read-only run-watch:0running/alive,57completed,2capacity-blocked.
 125/126 still quota blocked onaccount-m(tv goog five), reset11Sep11:19:36UTC;
  no new model job, auth/capacity/sandbox change or account cycle. Future hosted
  writers/reviewers remain sol medium/xhigh fast/priority; registry127 is free.
  Original user checkout dirt preserved and plan hash unchanged. Slithere9292
  and Solanaabf837 remain unchanged. No public chain, keys, spending,
  tokenomics/vesting, browser or material source/evidence deletion.

Next: reproduce the prepared-archive return/finalization risk and continue
120group2/group5 plus remaining architecture work. Independent review of the
bounded runtime checkpoint/full unaccepted base is still pending capacity.
Then finish every remaining original-matrix requirement. Full cached rollback,
root/CI/E2E acceptance is still suspended;175 tests do not replace those gates.

## Earlier reconciliation: 17:10 UTC

Accepted integration source remains `31e909f72d5470613d8875ed9266adb482ddff85`.
Recovery candidate is now `04d0e6400cac74789ba8cd5a02f088133cb3521e`, parenta7add,
in `/tmp/agtmai-custody-76c-mac`. Tracked clean; known node_modules symlink only.
Do not integrate the unaccepted full recovery base on these tests alone.

- Main fixed120/P1-4 directory-shape and staged-file finalization, reusing
  existing custody helpers. Successor ownership precedes predecessor close;
  primary validation/read/Git failure stays before terminal close errors;
  every acquired owner gets one close attempt, no retries of reused FD numbers.
  Iterator read/close ordering covered. No authority check or Foundation limit
  weakened. Six files,+375/-57,309 new test/fixture lines; PLAN updated.
- Actual pre-fix regressions0/16; first patch16/16. Added success/iterator-owner
  assertions: Mac broader109/109, zero skips,62.24s. A test property lint error
  was mechanically renamed; final changed file18/18, zero skips,5.81s.
  Scoped lint and diff check pass. No local test session remains active.
- Ordinary Linux verifier131 completed, NOT a model worker. Root
  `/var/data/agtmai-custody131-linux.0EXee0`, exact source04d0e640;
  validation passed; full structural suite **163/163**, zero failures/skips,
  221.24s,exit0, source clean. Local session91014 finished; do not rerun this
  unchanged checkpoint. Logs copied and hashed in the report below.
  Machine/RAM/swap/disk/IO plus bundle/Node hashes were verified; existing5GB
  admission guard retained. Free disk was7.3GiB at launch,6.2GiB on observation.
  Bundle SHA2567023ccdaac322ce11d50116a7c819c41064077bbdffb5a46a409f566749f6121.
- Source/evidence/handoff report:
  `RECOVERY-CONSUMER-FINALIZATION-2026-09-04.md`. Read-only follow-up identifies
  node-runtime's additional return-file-before-parent-close leak; the report
  gives a bounded next implementation/test split. Node-runtime is NOT fixed.
  Also open:120group2 evidence-directory custody, group5 partial construction,
  architecture findings, R3-R8, Slither/Solana live qualification, main merge
  and complete exact-head root/CI plus independent final reviews.
- Fresh16:54 run-watch: zero running/alive,57 completed,two capacity-blocked;
  latest125/126 quota blocked onaccount-m(tv goog five), reset11Sep11:19:36UTC.
  No new subscription worker, account cycle or auth/capacity/sandbox change.
  Future hosted workers remain sol medium/xhigh, fast/priority. Registry127
  is still next free; ordinary verifier131 is not registered there.
- Original user checkout remains212b278f with its recorded dirt preserved;
  original plan hash stillf377913670ba55be1b032afa47cdeb24d88fb612b242f91f4004a356a1a9666d.
  Slithere9292 and Solanaabf837 unchanged; no browser, public chain, signing,
  tokenomics/vesting, spending or material deletion. Integration has only this
  ledger edit and the new report; no source overlay integrated.

Next: continue remaining120 node-runtime/group2/group5 work with bounded
checkpoints and independent review when capacity returns, then every remaining
original-matrix requirement. Current163/163 structural evidence is not complete
cached rollback, exact-head root/CI or whole E2E acceptance.

## Earlier reconciliation: 16:46 UTC

Accepted integration source remains `31e909f72d5470613d8875ed9266adb482ddff85`.
Two additional bounded recovery corrections are committed in the isolated
candidate, NOT accepted or integrated into the full source yet.

- Recovery candidate now `a7add0d9c546e91b8e1bc62e8857f0435852fd1e`,
  worktree `/tmp/agtmai-custody-76c-mac`, tracked clean; only known node_modules
  symlink untracked. Source checkpoints:644476bb closes command logs on partial
  acquisition/invocation/finalization failures;9800ba91 closes failed common
  directory acquisitions; a7add0d9 corrects only a portable registry assertion.
  Combined sinceaeb721: six files,+526/-56, including411 new test lines.
  Original failures remain ordered; every owned FD gets one close attempt,
  never a retry after uncertain close. Existing Foundation limits preserved.
- Linux ordinary verifier128 at exact644476: validation pass and full structural
  **134/134**, zero skips,210.58s. Verifier129 at9800: validation pass but
  **81pass/10fail**, all from the test incorrectly expecting the Linux
  `/proc/self/fd` path constructor to validate registry membership. Failed
  logs are retained. Test-onlya7add uses the actual registry validator;
  verifier130 at exacta7add: validation pass, **91/91**, zero skips,0.99s.
  Same focused set on actual Mac exacta7add: **91/91**, zero skips,7.53s.
  Scoped lint/diff checks pass. All test sessions are finished; source clean.
- Full source/failed-test/transport/hashes are recorded in
  `RECOVERY-ACQUISITION-REGRESSION-2026-09-04.md`. The verifiers used fresh
  standalone exact-SHA clones and verified bundles/Node, no dependencies
  installed. Latest130 oldhost resource check: correct machine-id,9.2GiB
  free disk,12190MiB available RAM,4009MiB swap free;5GB guard unchanged.
  These are ordinary test processes, NOT subscription/model workers or registry
  jobs. Next free registered model-job number is still127.
- Read-only hosted observation at start of this continuation:120 completed,
  125/126 quota blocked, none running. Account-m(tv goog five) recorded reset
  remains2026-09-11T11:19:36Z. No model launch, auth/capacity/sandbox change,
  paid reset, API-key fallback or account cycling. Next hosted workers remain
  fast/priority, sol medium writers and xhigh reviewers when available.
- Review120 group1 is candidate-fixed byaeb721; group3 candidate-fixed by644476;
  group4 only common-directory acquisition fixed by9800. Group2 evidence
  directory custody, remaining group4 node-runtime/directory-shape/gate-contract
  raw-close sites, group5 partial construction and architecture findings stay
  OPEN. Do not treat structural tests as independent whole-base acceptance.
  Slithere9292/Solanaabf837 lanes unchanged;125 proposal stays NOTAPPLIED,
  126 has no independent verdict. The whole original invariant matrix remains
  in scope, including R3-R8 and the post-publication installation transaction.
- Original user checkout rechecked at212b278f; all previously recorded dirty
  files preserved. No browser/report opened, no public networks/keys/spending,
  no tokenomics/vesting changes and no material deletion this turn.

Next: continue bounded120 groups2/4/5; review a7add/full unaccepted recovery base
when hosted capacity returns. Then Slither125 correction/runtime qualification,
Solana independent review and actualAgave, complete store/bootstrap authority,
upstream semantic merge, full exact-head root/CI and specialist/holistic reviews.
Do not call134 structural or91 focused tests complete cached rollback or E2E.

## Earlier reconciliation: 16:14 UTC

Accepted integration source remains `31e909f72d5470613d8875ed9266adb482ddff85`.
Do not integrate the full recovery base on the strength of the following tests:
120 still has other P1 findings and independent acceptance is pending.

- Local recovery candidate is now committed as
  `aeb721dba1f48b5fd630a2ae50e4adfed6e1fa42`, parent exact47fe823.
  Scope: finalizer primary/cleanup/close ordering, four actual uncertain-close
  regressions, Darwin authority regression, accurate Linux root-gate docs.
  Nine files, +197/-17; tracked clean, only known node_modules symlink untracked.
  Mac broader custody/cleanup/removal/finalization **67/67**, zero skips, 5.72s;
  separate Darwin regression **1/1**; scoped lint and diff checks pass.
- Ordinary pinned Linux verification (NOT a model worker) completed on oldhost
  in new `/var/data/agtmai-custody127-linux.dNOAwL/source`. Exact-head validation
  passed; **121/121 structural tests**, zero failures/skips, 255.06s, exit0;
  source remained clean. No dependencies installed and no auth/network-chain
  changes. Machine, resources, bundle and Node hashes were checked before use.
  Candidate bundle requires47fe823; SHA256
  `fff833075399f197723e0d703f52c6cb2abbc5e04af14418edf75fe2689f3eed`.
  Detailed source/test/transport evidence and failed initial Mac setup are in
  `RECOVERY-FINALIZATION-REGRESSION-2026-09-04.md`. The initial whole Mac run
  36pass/77fail/8skip is retained, not rewritten as success. The shared linked
  checkout's forbidden Git info/refs was preserved; the Linux verifier uses
  a fresh standalone clone and canonical temporary root instead of weakening
  authority checks. No local test session is still running.
- Reviewer120's full result and correction to its overlay inference are saved
  in `RECOVERY-FULL-BASE-CRITIQUE-2026-09-04.md`. Its P1 groups2-5 remain open:
  evidence directory custody, partial log acquisition, other raw close sites,
  partial proof construction. Architecture over-limit modules remain open.
  Gate documentation and stale Darwin assertion are corrected in aeb721 only,
  not yet in accepted source or the original dirty user checkout.
- Main reviewed the complete recovered125 source proposal. It is NOTAPPLIED:
  out-of-scope catch variable, repeated-stat uncertainty, weak directory-removal
  assertions and unfinished ownership states must be fixed. Exact handoff is
  `SLITHER-125-PROPOSAL-CRITIQUE-2026-09-04.md`; do not blindly apply that patch.
  Solana abf837 still has no126 independent verdict. Both source lanes unchanged.
- Hosted workers remain stopped:120 completed,125/126 quota blocked on account-m
  (tv goog five), recorded reset11September11:19:36UTC. No duplicate jobs, auth
  mutation, paid reset or account cycling. Future hosted workers remain fast:
  sol medium writers, xhigh reviewers, priority. Next free registry job is127;
  custody127 above is only an ordinary verifier, not a registered worker job.
  Original `/Users/belief/dev/projects/agent-teams-token` dirt was rechecked and
  preserved. No browser/report opened and no material files deleted this turn.

Next: independent review of bounded aeb721 when capacity returns; meanwhile
continue local recovery120 groups2-5 with nonoverlapping checkpoints. Slither125
amendment, Solana review/actualAgave, R3-R8, realDocker/cgroup, upstream semantic
merge and complete exact-head root/CI plus specialist/holistic reviews remain.
Do not call 121 structural tests full cached rollback or whole E2E acceptance.

## Earlier reconciliation: 16:05 UTC

Accepted integration source is still `31e909f72d5470613d8875ed9266adb482ddff85`.
No Slither, Solana or full recovery candidate is accepted or integrated.

- Fresh 15:58 read-only observation: 120 completed; 125 and 126 are blocked
  by quota. No worker is running. Account-m (tv goog five) is not scheduler
  eligible; the recorded reset is 2026-09-11T11:19:36Z. Do not repeat launches,
  modify auth/capacity, buy resets or use API-key fallback. Next hosted workers
  remain fast/priority, sol medium writers and xhigh reviewers when available.
- The complete 120 review is preserved in
  `RECOVERY-FULL-BASE-CRITIQUE-2026-09-04.md`: five P1 groups and three P2 groups,
  whole `f2d7ab918^..47fe823` base AMEND. Its 103/117 Linux run had 13 failures
  from pre-existing root-owned `/tmp/.git` and one stale Darwin source assertion.
  That foreign directory is not ours to remove. Accepted archive/Bash overlays
  are not proof of the installation-transaction fix; the report prefix records
  this correction to the reviewer's unsupported inference.
- 125's complete source proposal was recovered from its earlier task-specific
  assistant final and retained at `.tools/hosted-evidence/2026-09-04/recovered-125-final.md`.
  It has not been applied, tested or accepted. Terminal JSON alone omits it.
  126 left no assistant final/verdict; Solana `abf8377303d1b4628d032023904801c55e8125ef`
  still needs independent review, not automatic acceptance after quota failure.
- Main is applying a bounded local recovery correction in
  `/tmp/agtmai-custody-76c-mac`, parent `47fe823a944292784868a3f80bb790cdbbd242f0`.
  Four actual temporary-finalizer tests failed before the fix and now pass;
  combined descriptor/production/temporary finalization is 18/18, zero skips.
  Original proof, cleanup and terminal-close errors remain ordered; every owned
  workspace descriptor receives one close attempt, including real close then
  EINTR with immediate reuse. Post-removal close failure records failed cleanup
  with its already-completed removal facts, not a misleading clean pass.
  The Darwin regression now exercises the real platform authority function;
  loaded-image binding remains fail-closed. Docs/AGENTS clarify the existing
  complete Linux `pnpm check:linux` command without changing executable gates.
  Scoped lint/diff checks pass. Full structural rollback suite is currently
  running in a fresh disposable TMPDIR (local exec session 66118); do not edit
  its source or claim its result until completion. Original user checkout stays
  untouched. Local candidate is not yet committed or independently reviewed.

Next: finish the current structural test, checkpoint this bounded candidate,
then work through the remaining 120 findings. Preserve Slither/Solana candidate
lineages. Full original scope in ORIGINAL-PLAN-INVARIANT-AUDIT remains open,
including runtime authority/store, actual Agave/Docker, upstream reconciliation
and exact-head full root/CI plus specialist and holistic review. No Mainnet,
tokenomics, vesting, public RPC, real keys or spending is authorized here.

## Earlier reconciliation: 15:45 UTC

Accepted integration source remains31e909f72d5470613d8875ed9266adb482ddff85.
ActualMac EVM86/86 stays valid only for its earlier accepted source.
No Slither/Solana/recovery candidate from this turn is integrated.

- Solana123 full patch was recovered from its task-specific assistant final
  answer after exact session/cwd verification. Terminal JSON contained only
  a blocked summary, not the promised patch. No auth/key/reasoning records
  were exposed. Recovered source is preserved as
  .tools/hosted-evidence/2026-09-04/recovered-123-finals.md, SHA256
  5581a8d04574f7c9c376af239926ee1db86b4747e0d81db96892c9569bf87301.
  Applied ONLY tooling/local-solana files; stale docs/PLAN hunk not applied.
  New isolated candidateabf8377303d1b4628d032023904801c55e8125ef, parent6b877,
  eightfiles+628/-68. Once-only descriptor finalization and typed committed/
  uncertain publication errors avoid unsafe close retry and competing failure
  publication. Separate monotonic validator termination follows kernel start
  identity afterTERM while authenticating before every signal.
  The publication semantics are a candidate requiring independent validation,
  NOT an accepted relaxation of READY/CI/verifier guarantees.
  MainMac six-file test set84total79pass5Linux-onlyskips,0fail,11.49s.
  Main then added2 actualrunFixture committed/uncertain error scenarios;
  runner13/13,0skips; original listener replacement test retained. One initial
  lint error on AggregateError cause fixed by preserving caught publication
  cause and original failure as first ordered error. TS7/lint/diffcheck pass.
  No combined currentAgave or root gate claimed. Review126 runningPID2039219.
  Bundle prerequisite6b877, SHA256
  af89b732214ede4cf061b0b55b4f490980d21f46c3cb4e52520e39fab63cae94.
- Slither122 AMEND exacte9292: P1 outer staging cleanup is after claimed
  commit and can leave cleanREADY on overallfailure; P1 chmod/stat failure
  before destination-entry registration can orphan READY; P2 READY close can
  mask primary failure. ExistingMac141/141 did not cover those boundaries.
 125 source-patch writer launchedPID2022248 frome9292. Full source packet
  supplied; deliverable is a complete patch proposal, not tool execution,
  avoiding useless blocked-goal continuations when source packet is available.
  No new125 patch applied yet. Review122 source-basedNOTRUN afterfirstbwrap.
  ResultSHA2561a4024f0519c9b974f47a6560ae9c0d6ac2c091d177d999037b611fe4779ec90.
- Custody120 remains running/alive on47fe, reviewing WHOLE filesystem/rollback
  base. Do not extend118's narrowACCEPT to unacceptedf2d. No duplicate reviewer.
- Planner121 finished read-only. Complete result is preserved in
  MAIN-RECONCILIATION-PLAN-2026-09-04.md. Recommends exact upstream ancestry
  merge after source lanes stabilize, preserving pins and source, importing
  managed docs/ReviewRouter byte-exactly, semantically updating consumer-owned
  document metadata and adding only exact docs-protocol0.2.0 lock entries.
  No merge, install, workflowexecution, GitHubwrite or branch-protection change
  performed. Suggested owner/process concerns remain advisory; do not invent
  approval rituals for already-authorized in-scope zero-cost implementation.
 121 resultSHA2565a8baf77f39e4858f6f449d26d7358437e997e1d8fe9025430ffdfad8091c529.
- Disk cleanup: removed six inactive duplicate Node directories from completed
 85/86/87/88/101/104, then13 exact old .bootstrap-node-part directories under
  isolated toolchain-remediation10. Both preflights verified machine-id, real
  paths, untracked status, current binary hash, retained pinned archive hash,
  and no process/cwd/exe/open-FD/command references. Partial roots additionally
  contained only the exact Node tree+same archive and were older than1hour.
  Old10 registry was unknown, so no source/job was deleted or relabeled;
  only proven inactive reconstructible tool temporary directories were removed.
  Scripts /tmp/agtmai-clean-duplicate-node124.mjs and
  /tmp/agtmai-clean-bootstrap-partials124b.mjs hold the explicit target lists.
  Archive /var/data/agtmai-pinned-archive-cache-20260904.D9lVCp/
  node-v24.20.0-linux-x64.tar.xz remains, SHA256
  2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2.
  User informed all removed tools are reconstructible. Source, jobs, evidence,
  bundles, active102/103/105 tool copies and original checkout were preserved.
  Disk rose to8.3GiB; fresh126 launch8.0GiB,12.2GiB RAM available,3.7GiB swap.
- Latest15:44 observation120/125/126 allrunning/alive on oldhost, account-m,
  sol xhigh reviewers/medium writer, allpriority/fast.5GB guard unchanged.
  No active local test sessions remain. Isolated source repos trackedclean
  with only their known development node_modules symlink untracked.
  Automation remains five-minute heartbeat using this latest ledger.

Next: consume120/125/126, apply safe accepted packets and focused tests.
Finish full original scope: S5/S11/S13 and liveDocker/cgroup, SolanaAgave and
L5/L6, R3-R8 and actualDarwin recovery, semanticmain merge, full exacthead
root/CI plus four specialist and sequential holistic reviews. Full E2E is
not complete and no production readiness is claimed.

## Earlier reconciliation: 15:28 UTC

Accepted integration source remains31e909f7, actualMac EVM86/86,0skips.
No new Slither/Solana/recovery source is integrated.

- Review118 ACCEPT exact47fe823a944292784868a3f80bb790cdbbd242f0 vs7437:
  noP0-P3, independentLinux acquisition9/9 and acquisition+teardown14/14,
  zero skips. MainMac expanded50/50 remains separate. This accepts ONLY
  ancestor delta, not fullf2d base. Full-base reviewer120 is now live on47fe,
  PID1766078, isolated /var/data/agtmai-r212-recovery-base120-workspace.
 118 result SHA2569d2413088b25ef4ade6eee33e7ed82ef7e60d95bef55f61ef3ce6ebfbfa9ff32.
- Slither117 source patch applied in /tmp/agtmai-slither-91-mac and committed
  e9292d1a0a1893da74ec362ac238b5a1b085bd8d, parentb74e. Sevenfiles+370/-26.
  Clean READY gets a separate final commit cancellation check, including after
  READY publication. Failure evidence is non-abortable. Failed destination
  cleanup removes only captured entries and preserves foreign root/children;
  primary plus secondary cleanup errors remain visible. No recursive
  destination cleanup introduced. Existing generic latefault test retained.
  InitialMac48total44pass4fail came from new /tmp symlink fixtures; main used
  existing canonical makeTestDirectory for those4 tests. Correctedportable8/8;
  completeSlither141/141,0skips,9.90s. TS7/scopedlint/diffcheck passed after
  two mechanical lint corrections. First tsc attempt mistakenly invoked the
  shell shim as JS and failed before typechecking; corrected pinnedPATH tsc
  completed. No compiler or guard was replaced.
  Independent122 PID1816902 reviews exact e9292 including cleanup/commit
  interactions and possible inode reuse. It is NOT accepted on tests alone.
  Bundle prerequisiteb74e SHA256
  91dda454ce55745070602d4f0b73cd590f3ee9116678a98c9c46b5463c946e1d.
 117 result SHA256e86da2601bf4595d5657b013cffd2faf75722acb4d66e5dc7bfa076717e991c6.
- Solana119 returned full source packet, NOTAPPLIED. Main found forbidden
  retries of failed parent/READY handle.close and a test that throws before
  real close then permits retry. This masks the case where actual close
  consumes the descriptor before rejection. No uncertain descriptor may be
  reused for close, stat, read or destructive withdrawal.
  New writer123 PID1817425, exact unchanged6b877, owns both review116 issues
  and these corrections. Full source packet supplied. Explicit committed
  publication/failed finalization semantics must not be silently confused with
  command success or relax READY/verifier safety. Dying validator waits must
  keep initial/per-signal authentication and use bounded monotonic timing.
 119 result SHA2565c2d09d95b596c769e4c0894dc566e81378ac15acf16213c06beb1901479255d.
- Read-only planner121 PID1767317 owns semantic reconciliation of6eaec1af
  integration docs/source31e909 with upstream370c3aac via common3231e8a9.
  Only upstream managed-docs6174b253 and ReviewRouter370c3aac are in scope;
  no main changes applied yet, no dependencies installed and noGitHubwrites.
  Bundle SHA256f32e1e6f5c88e67b2806c6751110c21f4e2e644bf1d9a040699b58bf41944966.
- All120/121/122/123 observed running/alive on oldhost, account-m, priority.
  Per-launch machine-id/RAM/swap/disk checks passed; latest launch had5.4GiB.
  At15:27 free disk fell to4.6GiB despite no repeated tool unpacking. Further
  provisioning remains behind5GB guard; main is investigating only owned
  inactive disposable tools, not touching source/jobs/evidence/user data.
  No deletion yet. AvailableRAM~11.4GiB, swap~4GiB. Original checkout preserved.

Next: consume120-123; only reviewed exact packets become candidates, followed
by actual platform tests. Whole recovery authority/store, actualAgave/Docker,
main reconciliation and exacthead root/CI/specialist/holistic gates remain
OPEN under ORIGINAL-PLAN-INVARIANT-AUDIT. No full goal acceptance.

## Earlier reconciliation: 15:12 UTC

Accepted integration source is still31e909f7, actualMac EVM86/86,0skips.
No new isolated Slither/Solana/recovery source is integrated here.

- Custody115 source packet applied in /tmp/agtmai-custody-76c-mac. Main fixed
  four test roots to realpathSync: initialMac6/9 failed because /var spelling
  did not match captured/private paths, so injected replacements never ran.
  Correctedfocused9/9, then expanded50/50,0skips,58.84seconds, lint/diffcheck
  passed. Current candidate47fe823a944292784868a3f80bb790cdbbd242f0,
  parent7437,2files+112/-5. Ancestor acquisition now checks stable object
  kind/dev/ino/mode/uid/gid; owned target still checks complete metadata.
  Separate reviewer118 launched PID1626045 on exact47fe.
  Bundle /tmp/agtmai-custody115-candidate.bundle prerequisite7437, SHA256
  49fed1fdc67c1149d714ea7cece3fede206f5d7965d7d012879d8b1ac66e5171.
  Worker115 JSON SHA256c3922e86387ff00e73701db742088164d719c99631dbcd1e00da0445bc65a8e2.
- Slither114 returned a full source patch, testsNOTRUN afterbwrap, NOTAPPLIED.
  Main rejected its new recursive failed-output cleanup based only on root
  identity, because it can delete a foreign child; it also silently swallows
  cleanup errors and leaves cancellation duringREADY/postwrite awaits unchecked.
 117 is a new boundedwriter fromunchangedb74e, PID1610590, revising114 with
  captured owned-entry cleanup, primary+secondary errors, latecommit checks and
  actual barrier/foreignsuccessor regressions. Generic prior fault coverage
  mustremain; no general native cleanup platform requested.
 114 JSON SHA256ad709a7046f49f0a377c590d177e95200203dbfd98e54f5e5142f243489d0637.
- Solana116 AMEND exact6b877: all previous config-at-use, finalnamedreadback,
  failedREADYlink, foreignsuccessor and supervisor validation closures verified.
  Remaining P2: withPublicationParent descriptor-close failure AFTER READY
  makes actualpublish/publishFailure reject with ownREADYstillpresent. Independent
  realstoreprobe demonstratedthis. Other inheritedP2: afterSIGTERM validator
  canceaseauthenticating before/procreportsexit, causingSOLANA_RECLAIM_IDENTITY.
  Linuxfocused74total73pass1fail,0skips,~10seconds; failureisreclaimtransition.
 119 nowownsONLY these2findings from6b877, launchedPID1644196. Do not
  reinterpret lostidentityas permissiontosignal anotherPID, weakeninitialauth,
  swallowcloseerrors orpromiseimpossibleatomicunlink. FullcurrentAgave remainsopen.
 116 result preserved in .tools/hosted-evidence/2026-09-04/
  agtmai-r212-solana-review116-20260904.latest-result.json.
- Active lanes are117 Slitherwriter,118 custodyreviewer,119 Solanawriter,
  allpriority/fast, mediumimplementation/xhighreview on oldhostaccount-m.
  Machine-idandadmissionchecked eachlaunch; latest~9.4GiBdisk,~11.8GiBavailable
  RAM/~4GiBfreeswap. No tools unpacked, no service/auth/sandboxchanges.
  Automation remains5minACTIVE/failed_runs_only but nowusesa durableprompt:
  always readthislatestledger forcurrentSHA/jobs, not mutable embedded snapshots.
  Originaluserworktree remainsuntouched. Fullscopeaudit requirements stayopen.

Next: consume117/118/119, applyreviewedpackets andfocusedplatformtests, then
complete wholebase/recoveryauthority, actualAgave/Docker, mainreconciliation
and exactheadfullroot/CI/specialist/holistic gates. No fullacceptance isclaimed.

## Earlier reconciliation: 15:05 UTC

Accepted integration source remains31e909f7 (actualMac EVM86/86,0skips).
The previous turn made source/evidence progress; this continuation also
advances Solana source. No root completion or blocker claim is justified.

- Solana111 applied on80bb, with main adapting all seven process-test config
  strings to explicit private config capabilities and updating fake runner
  fixtures. FirstTS7 caught those7type errors; corrected TS7/lint passes.
  Main additionally closed publication failure AFTER linkingREADY but BEFORE
  publishInitialFile returns: linked flag plus retained inode withdraw only
  the owned destination before temporary cleanup/close; actualPrivateRunStore
  regressions cover an owned marker and a substituted foreign successor.
  Exact /tmp/agtmai-solana-97-mac6b8770c7c2a63735aa34183eaeb1bcbe48409c37,
  parent80bb,12files+454/-44. FocusedMac74total69pass5Linux-onlyskips,0fail,
  8.49seconds. No actual current-source Agave qualification yet.
  Independent116 is launched PID1562344, exact candidate, xhigh/priority.
  Bundle /tmp/agtmai-solana111-candidate.bundle prerequisite80bb, SHA256
  023bcff1bbc52d2ef706875be827c09a6f6dfc13c076d12cf2ee9473b05f89ab.
- Review112 AMEND on Slitherb74e: late cancellation after the old evidence
  precondition but before destinationREADY can still publish clean success.
  New narrowwriter114 owns the cancellation-aware final publication commit
  and real barrier-driven regression, preserving failure evidence publication.
  114 launched PID1517668 fromb74e, medium/priority.112 confirmed earlier
  signal/createID/postauth closures and unchanged parser relocation. Its
  independentLinux135total134pass1fail was the unchanged descendant timeout
  reaching hard deadline, so Mac135/135 is not relabeled Linux acceptance.
  Review112 JSON SHA256fa0d5db4a6196adcc4be30c9cca875b87182ae702de5fc6a1f41339389c68bbd.
- Review113 ACCEPT exact7437 four-file110delta, independentLinux15/15 and
  confirms original digest failure plus5closes in corrected injectiontest.
  Separate inherited P1 is proven: sibling creation changes full directory
  metadata without replacingdev/ino, and openDirectoryRecord rejects shared
  ancestors before the intended owned-target policy.115 now owns a minimal
  ancestor-only stableobject comparison; owned target fullmetadata checks
  must remain strict. Deterministic sibling-churn/replacement/EINTR regressions
  required.115 launched PID1546449 from7437, medium/priority.
  Review113 JSON SHA256e565ff85650ade6cb889d192abfc38fa968e2a964047fba33704fd2c23015f62.
  No wholef2d recovery acceptance or Macloadedimage bypass.
- 114/115/116 are observed running/alive, all isolated old-host account-m jobs
  with priority. Latest machine-id/RAM/swap/disk admission valid:~9.8GiBdisk,
  ~11GiBavailableRAM/~4GiBfreeswap. No runtime changes or tools unpacked.
  FreshghAPI main is still370c3aac97e4b3ddc7fcc9ada762a050580d0f39.
  Read-only graph check finds2upstreamcommits after common3231e8a9: managed
  documentation adoption6174b253 and ReviewRouter370c3aac,26files+2157/-18
  (1391lockfilelines). Semantic reconciliation remains OPEN; no upstream
  commit was integrated and noGitHubwrite made.
  Original userHEAD212b, dirtyfileinventory and originalplanSHA256f3779136...
  are unchanged. Integration origin is an old localbundle, notGitHub: use
  explicitghAPI and exactknownobjects, don't assume origin/main exists.

Next: consume114/115/116; apply sourcepackets once and independentlyverify;
qualify accepted Solana on realAgave beforeintegration. Full S5/S11/S13,
L5/L6,R3-R8,Linuxrealruns,semanticmain,exactheadroot/CI andfinalreviewsremainopen.

## Earlier reconciliation: 14:56 UTC

14:58 update:111 terminal, full23966-character output is preserved at
.tools/hosted-evidence/2026-09-04/agtmai-r212-solana-amend111-20260904.latest-result.json,
SHA256e42a9bcb3e2c1b60dc3debfb3337b2f64a0f6af9a9d8405afe4c0713a42d6123.
It is an UNAPPLIED source patch, testsNOTRUN after first bwrap failure; the
worker marked its own goal blocked across continuations, not the root goal.
It explicitly requires one missing-packet fixture update at
tooling/local-solana/tests/process.test.ts:23 from config string to capability.
Next main must inspect/apply the full patch on exact80bb, adapt that actual
fixture, run TS7/lint/focused tests, then independent review. Do not launch a
duplicate implementation or claim111 tested/applied.112/113 are still alive.

Accepted integration source is now31e909f72d5470613d8875ed9266adb482ddff85.
This accepts the reviewed EVM N2 delta, NOT full original-plan E2E.

- Review109 ACCEPT exact25b over1f4: remaining FIFO issue closed; independent
  Linux2/2, no findings. Review104 had already confirmed the preceding content,
  identity and cleanup corrections. Exact EVM bytes are integrated as
  51475c32/59271cb4/a5ebb06d/548325f6, then31e909f7 registers cleanup.test.ts in
  test:local-evm:built. Byte comparison against25b is empty for tooling/local-evm.
  TS7 and scoped lint passed. Combined root-listed EVM plus real runner tests
  on31e909 passed86/86,0skips,82.0seconds, actualMac pinned Node/Foundry/solc
  and real pnpm. This includes7real runner lifecycle cases. Source remained
  unchanged while documentation was reconciled; not a full root/CI pass.
  Review109 result SHA2563de3e67e234dd92c257ee51b9f530579cb2d193b19bc187a88e6751e2d927a7f.
- Slither106 applied and main corrected the test options type plus a coherent
  move of the unchanged image environment parser into image-preflight.ts to
  satisfy500lines/module. No lint rule disabled. Exactb74e115782bfa26d26da140d58cbaf9a47c5ca60
  at /tmp/agtmai-slither-91-mac passes135/135 actualMac,0skips,11.4seconds,
  TS7/scoped lint/diffcheck. Firstpreflight failed testtype, nextlint failed
  max-lines; neither is hidden. Independent112 is running, PID1447431.
  Bundle /tmp/agtmai-slither106-candidate.bundle prerequisitefb416, SHA256
  b5cdcd78d1dccdd1659aca677305b0308a673d440e31d546dde1e6cb50aedaa7.
  Worker106 result SHA2569d2cf3a81aecb9c468468338ca671f995082b86f63e1c0dfaee1f2826c017662.
- Review108 AMEND on80bb: final publication name was not checked after held
  read; rejected post-READY bundle retained owned READY; config identity/bounds
  were discarded before actual validator/CLI use. IndependentLinux32/32 passed
  but a separate corruption probe demonstrated retained READY. Writer111 owns
  these3findings from80bb, running PID1407825. Legacyv3 and raw wire unchanged.
  Review result SHA2566058c6391935640586000f236e67de287d3848f3cc5de858d4d1142bebc66c62.
- Custody110 applied at /tmp/agtmai-custody-76c-mac as
  7437ec04ad265f37d0981d388563abeb5b9fd489, parent598b,4files+325/-48.
  Main corrected one patch-context mismatch, curly lint and prior test close
  injection index1->4/count2->5 because shared reads now have three additional
  protected closes before the final plan close. Firstfocused14/15 failed that
  old injection location. Correctedfocused15/15 plus scoped lint/diffcheck pass.
  Expanded47 was46pass1fail: unchanged custody-acquisition test saw ordinary
  ancestor identity rejection before the intended nonprivate-target policy.
  A focused retry passes, but47/47 is NOT claimed; reviewer113 independently
  classifies this inherited full-directory-metadata issue separately from110.
  113 running PID1461782. Full recoverybase f2d remains outside integration.
  Bundle /tmp/agtmai-custody110-candidate.bundle prerequisite598b, SHA256
  1da1df4f25385711a073b6921f30f8ee832d5035242cb7213bf9b5222bc3b9f7.
  Worker110 result SHA25650397c1f358f2d7bbac9eabe96c81d3197eb3e7f593f5c34391d2df222f930f1.
- Current hosted111/112/113 are observed running/alive. All fast/priority,
 111 medium writer,112/113 xhigh reviewers, isolated jobs on account-m.
  Fresh old-host admission machine-id verified,~11GiB disk,~11GiB availableRAM,
  ~4GiB free swap; no duplicate Node extraction or runtime/service changes.
  Mac disk now28GiB available without further deletion by this turn.
  Original userHEAD212b and exact plan SHA256f3779136... remain unchanged.

Next: consume111/112/113, apply only
reviewed scoped source, preserve full S5/S11/S13, L5/L6, R3-R8, both-platform
qualification, semantic main reconciliation and exact-head root/CI/review work.

## Earlier reconciliation: 14:45 UTC

- EVM107 patch is applied and main corrected its child-process ownership
  fixture: the registering child must create its own synthetic lease, otherwise
  owner rejection happens before the attack hook. First2tests1pass1fixturefail;
  corrected2/2, then exact-source Mac39/39,0skips,8.5seconds; TS7/lint pass.
  /tmp/agtmai-evm-94-mac now25b33245221b08a00db70569c7770e8e1a732cab,
  parent1f4f,3files+108/-2. Production change is O_NONBLOCK on both read opens.
  Independent109 is running/alive on exact25b, PID1347934.
  Bundle /tmp/agtmai-evm107-candidate.bundle, prerequisite1f4f,
  SHA256caddd1f3dc1f8cd9c63bf387e4957bc4a05389b7b596704d0aab0a37b26cd72a.
  Worker result SHA2566c0e1527910314c086d24d43855c0019e6dee0f4e4cf00f22953a63c082fa478.
- Review105 returned AMEND on598b with no newly introduced defects, but two
  inherited closure blockers: shared-file-operations.mjs actual read/edit/restore/
  create/absence traversal still uses raw closeSync without once-close/primary
  preservation, and removal traversal has canonicalization/registration outside
  the next-descriptor acquisition cleanup scope. These are concrete preexisting
  production paths, not an extension of the final-syscall residual threat model.
  Writer110 is running/alive from598b, PID1347970, owning only those2files plus
  focused regression tests. Review105 tests NOT RUN after bwrap; earlier41/41
  actualMac remains main evidence only. Review JSON SHA256
  761640026182c6a1d367f3dd2ffc3d105ad781c5fe82df4bb19d5c946892739d.
- Slither106 is completed; its result is being preserved locally for application
  on /tmp/agtmai-slither-91-mac fb416. Do not treat it as applied or accepted.
  Solana108 is still running/alive on80bb, PID1293268. Active3jobs108/109/110
  use priority;108/109 xhigh reviewers,110 medium writer. No idle/restart action
  is indicated. Always re-observe before launching a continuation.
- Last admission old-host disk5.1GiB, available RAM10.6GiB and swap3.5GiB.
  New jobs do not unpack duplicate tool runtimes; same5GB disk guard remains.
  Integration accepted codee723 and the original user worktree are unchanged.

Next: consume/apply106, consume108/109/110, focused tests and independent review
before integration. Do not drop the still-open full original-plan matrix below.

## Earlier reconciliation: 14:40 UTC

Accepted integration code is still e723bc0d. New drafts remain OUTSIDE
integration, original user dirty worktree preserved. Do not mark the root
goal complete or blocked: source work and verification are progressing.

- Review103 returned AMEND on aggregate Slitherfb416: P1 production CLI lacks
  signal wiring; P1 cancellation during create can discard the returned ID;
  P1 cancellation/deadline expiry during final output authentication can return
  false success. Writer106 owns these three exact issues fromfb416. Review103
  independently ran15Linux cases14pass1typed hard-deadline failure while reaping
  descendants; this is not a reproduced130/130Linux result. Mac130/130 remains
  valid narrow evidence, not S7 acceptance. Review result SHA256
  d14bd647131f6156d1dbb415ff67e7489df4124e20b2f03d60096a39d58798e8.
- Review104 confirmed review98 regular-file content/cleanup fixes but AMEND
  found P1 blocking FIFO opens in bounded lease read and predecessor reopen.
  Independent pinnedLinux37/37 passed but missed FIFO. Writer107 owns only
  O_NONBLOCK plus bounded FIFO actual-consumer regressions from1f4fc8d8.
  Review SHA2565f1b1d6b29b433433b80d9abe15d09070f4c7c01171986ba64e49e3642ab82da.
- Solana102 full patch is applied with main corrections in
  /tmp/agtmai-solana-97-mac:80bbca4763da6ad2ebd28b35f0bfa09c0b012d80,
  parenta226,5files+494/-59. First run failed before test discovery because a
  TypeScript parameter property is unsupported by pinned Node strip-only mode;
  lint found3unsafe-finally sites. Main replaced the parameter property, added
  explicit primary+secondary cleanup aggregation, and transferred published
  payload FDs into parent custody until all JSON/Markdown/READY checks complete.
  This prevents inode reuse while checking the original published identities.
  Main also added immediate named-temp pre-unlink check, post-read named checks,
  O_NONBLOCK for the two read opens, and deterministic bounded-child FIFO,
  payload-FD-lifetime and finalizer aggregation regressions. Exact Mac focused
 32total31pass1Linux-onlyskip,0fail,1.8seconds; TS7/lint/diffcheck pass.
  This is not current-source real Agave integration evidence. Independent108
  is being launched to review aggregate N2 versus e723, including main changes.
  Writer102 result SHA256521f2781c03f9e6f9a3e7ab0405c53d525ee8a9c5290a4319b380e12c3c779a0.
  Bundle /tmp/agtmai-solana102-candidate.bundle, prerequisitea226,
  SHA256c600099019cb314273d333afd212de3940e3f10f5d3b81f37517b468d0711c5e.
- Custody598b remains41/41Mac, independent105 is now running/alive, PID1259704.
  Its tool extraction was delayed ~13minutes by old-host IO pressure before
  the model actually started; earlier launch intention is not runtime evidence.
  Active106 PID1216636,107 PID1238048 are running/alive.108 is a new isolated
  read-only job, not counted alive until observed. Registry and old host unchanged.
- Old-host disk recovered to6GiB but IO pressure some~99%, full~50%, memory
  pressure and~15GiB used swap delayed even small writes. It later improved
  to IO some32%/full14%, disk5.2GiB. No limits/services were changed. No extra
  Node copies were deleted beyond the11 recorded earlier.106/107/108 omit
  duplicate tool extraction: they can draft/review exact source packets and
  must mark tests NOT RUN if no permitted pinned runtime is available. Main
  continues actual pinned Mac verification. Never bypass bwrap or package pins.

Next: consume105/106/107/108, apply writer patches only to their isolated exact
base, test then independent review. Root EVM cleanup-test registration remains
required at integration. Full original-plan S5/S11/S13, L5/L6, R3-R8, Linux
qualification, semantic main reconciliation, exact-head root/CI and final
specialist/holistic reviews remain open. All new jobs are priority/fast, sol
medium writers and sol xhigh reviewers. Split observation: custody101 first
focused run14/14; Solana102 first run exposed a runtime-syntax defect. Xhigh
review caught4concrete P1 classes beyond otherwise green suites; don't replace
independent review with model choice or test counts.

## Earlier reconciliation: 14:27 UTC

Custody101 complete inline patch was applied locally. Only overlapping diff
context was corrected to apply it; no source fix was necessary. Exact candidate
598b578807b8a9e5fb2cf20216e7ed6984b7829c in /tmp/agtmai-custody-76c-mac,
parent4c93,11files+860/-282. Actual Mac focused14/14 and expanded41/41,
0skips,11.6seconds; scoped lint/diffcheck pass. The expanded run includes
acquisition, teardown, production-finalization, cleanup-safety, proof-custody
and proof-replay suites. Worker-side tests were NOT RUN due to bwrap; these
are main's independent local measurements. Full recovery remains unaccepted.
Result JSON SHA256758a0954d2785a603a9ebb13837ae35de23c776a10b400fff0d27580e1ba759c.
Bundle /tmp/agtmai-custody101-candidate.bundle, prerequisite4c93,
SHA25689cbc85f16f0022cd6fe3ecf98e73bc677ef622f183d332bb4d8e73507124626.
Independent read-only xhigh/priority105 is being launched on exact598b.
Disk fell4.3GiB then recovered6.1GiB without further deletion by this agent;
no cleanup beyond the11 Node copies below was performed. Preserve admission.

### Previous observation at14:22

Fresh observation:101 is completed, output awaiting local consumption;
102/103/104 are running/alive/productive, not merely launcher PIDs. Old-host
duplicate cleanup removed11 pinned Node copies (~2.2GB nominal), verified
archive retained, source/job/evidence untouched. Disk3.5 ->5.6GiB before new
jobs; admission stayed unchanged and was rechecked before each launch.
New jobs:102 PID1076903 medium,103 PID1079088 xhigh,104 PID1082039 xhigh;
all priority, account-m, registry /var/data/agtmai-r212-resume-20260904-registry.
Original user worktree dirty-path inventory and original plan SHA256 were
rechecked unchanged at14:22. Details below describe their isolated candidates.

Accepted integration code remains e723bc0d. New checkpoints below are isolated,
unaccepted source candidates, not full E2E or public-network approval.

- Slither96 recovered patches are now applied in /tmp/agtmai-slither-91-mac.
  Main repaired the duplicated old lifecycle body/imports, kept image inspection
  in the existing image-preflight module, and updated the exact environment
  schema hash changed by91. Real child-process tests now allow Node startup
  1.5seconds within a2second hard deadline rather than assuming50ms startup.
  Exact candidate fb416ec111324cdc05663d6b00735a47c84d5e7a, parent4a0db1a3:
  full Mac Slither130/130,0skips; TS7/scoped lint pass. First full run exposed
  stale closure hash and two startup-timing failures; those results are not
  silently relabeled green. Independent aggregate S7 review103 is prepared.
- EVM100 is applied in /tmp/agtmai-evm-94-mac with bounded content/snapshot
  revalidation and primary-error-preserving cleanup. Main corrected callback
  types, a diagnostic expectation (snapshot mutation takes precedence over
  size interpretation), and placed directory syncing/final teardown in their
  concrete helper boundaries. Candidate1f4fc8d8cc7c7c8c119d827cce228443fbda52e3,
  parentcfba: TS7/lint pass. Focused37tests had36pass and one cast chain-id
  timeout; only that neighbour test was retried and passed1/1. New exact-source
  actual Mac runner suite passes7/7,0skips,66.5seconds. Independent aggregate
  N2 review104 is prepared. Root test:local-evm:built still needs registration
  of the new cleanup.test.ts at integration; do not lose these regression tests.
- Solana97 is applied in /tmp/agtmai-solana-97-mac, candidate
  a2261b3675cdf4c2a49d6fed2c2bfe87586776f9 from e723. TS7/lint pass;
  filesystem22total21pass1Linux-onlyskip. Main corrected canonical Darwin test
  paths, an import shadow and a test expecting deletion of a live validator.
  Confirmed remaining N2 gaps: parent/temp descriptors not held through
  publication, captured temp assigned only after write, missing named-temp
  check immediately before unlink, byte-only payload checks without original
  inode identity, and missing post-READY validation. Writer102 owns those exact
  gaps plus deterministic real-caller regressions. This checkpoint is not accepted.
- Custody review99 returned AMEND on4c93: direct closeSync acquisition paths
  still retry or leak on close failure, and actual apply-manifest/staging callers
  can mask primary errors. Linux focused21/21 passes; expanded32 has5 inherited
  TOOLCHAIN_GIT_LOCAL_CONFIG_UNAVAILABLE failures. Existing Mac32/32 is narrow
  evidence, not closure. Writer101 is alive/productive on the old host, fixing
  the complete confirmed production call paths, not just the new helper.
- Old-host disk dropped to3.5GiB free while RAM stayed about11.6GiB available.
  Admission correctly prevented102 before workspace/job creation. Main is
  removing only explicitly listed duplicate pinned Node directories from
  completed jobs89-100 after process/cwd checks; the verified archive is retained.
  Sources, jobs, outputs, bundles and active101 are not cleanup targets.
  Initial cleanup preflight stopped on an absent copy without deleting anything;
  absent copies are now skipped explicitly.103/104 are queued behind the same
  unchanged5GB disk admission guard, not yet claimed running in this snapshot.

Verified new bundles (base -> exact candidate):
- /tmp/agtmai-slither96-candidate.bundle,4a0 -> fb416,
  SHA256e8eec4ecf7f02fd59653f3a55c267683bd7fd39c01967b82b8f27aff77f70d79.
- /tmp/agtmai-evm100-candidate.bundle,cfba ->1f4f,
  SHA25645d2b5bc4bc283eddab79af9ea7f70140f7bcd074c0490c3bdad1afc697cd5ca.
- /tmp/agtmai-solana97-candidate.bundle,e723 ->a226,
  SHA256c76506886dea05b35379194fa5bbaabc60f227d14e455a950bda077db2845171.

New jobs use sol medium implementation / sol xhigh review, priority/fast,
account-m, isolated exact-SHA clones. Do not duplicate a job just because its
tools cannot write. Source-packet fallback is allowed, never sandbox bypass.
The original-plan matrix, L5 owner decision and all full-platform/root/CI gates
remain open as previously recorded. The original user worktree stays untouched.

## Earlier reconciliation: 14:04 UTC

Accepted integration code remains e723bc0df8efa867a78f8a4cd68e8862e95a18f2.
Nothing from the new unaccepted drafts entered the main candidate. Original
user worktree212b278f and its dirty paths are unchanged; original plan SHA256
still f377913670ba55be1b032afa47cdeb24d88fb612b242f91f4004a356a1a9666d.

- Custody95 patch was applied locally in /tmp/agtmai-custody-76c-mac. Main fixed
  the middle-FD-reuse test fixture (lower freed FD numbers must be temporarily
  occupied) and extracted pure cleanup evidence formatting/hash helpers.
  Candidate4c93be88b37ee955019f4e7abf9868745e920ace, parentff44,9files+557/-103.
  Actual Mac32/32 descriptor/cleanup/custody/replay tests,0skips,31.2seconds;
  scoped lint passes. First targeted5 had3pass/2test-fixture failures, then5/5.
  Independent reviewer99 is running on exact4c93 vsff44, not accepted yet.
- EVM94 draft plus main typing/structure/read-state/parent-custody corrections
  is cfba200f42e32de2b54cbbdaaac92dc93e3988e3 in /tmp/agtmai-evm-94-mac,
  parent checkpoint57a8d18e, basee723. Review98 returned AMEND P1: publication
  after the hook checks structural identity but omits mutable state/expected
  bytes, and an in-place predecessor rewrite is not detected. P3: teardown can
  mask the primary error. Pinned Linux focused15/15 passed but did not cover
  these boundaries. Writer100 owns exactly these two findings and regressions.
- Actual Mac cfba: publication/process30/30; required runner lifecycle6/7 passed
  with one90second timeout. Only the timed-out solc-substitution test was rerun
  and passed1/1 in6.2seconds, covering all7 real runner cases without a repeated
  full run. No full E2E/CI or security acceptance follows from that coverage.
  Verifier18/18 ran on earlier57a8; it is not relabeled as exactcfba evidence.
  Root TS7 build and scoped EVM lint now pass with existing pinned development
  dependency links, not an authenticated package-producer claim.
- Earlier setup failures are retained: absent Anvil PATH2cases; absent .tools
  solc18cases; absent pnpm PATH7runner cases; then ENOSPC and absent compiled
  supply CLI affected runner tests. A pinned solc copy, real pinned pnpm11.24.0
  --version (not a fabricated version shim), existing supply dependency link
  and TS7 build prepared the fixture. No package installation was performed.
- Mac disk reached918MiB free and actual solc snapshot writes hit ENOSPC.
  Main removed only its inactive copied Agave tool directory at
  /tmp/agtmai-solana-wire86-mac/.tools/agave-v4.2.1-darwin-arm64 (8GiB nominal).
  The authoritative development copy remains in integration2; the deleted copy
  is reproducible. No source, worktree or user data was deleted. Afterwards
  df reported10GiB then12GiB free. Do not assume the isolated Solana fixture
  still has binaries; rehydrate only if another actual-platform run needs them.
- Planner93 established missing v3 provenance. docs/PLAN.md now explicitly
  retains old Solana v3 directories and leaves L5 open for an owner decision;
  do not fabricate v4 bindings or authorize legacy deletion/signalling.
  Writer97 implements only current-format N2 publication/bounds, not that L5
  decision. Its final launcher summary lost the inline patch;96 likewise lost
  its refinement and incorrectly marked its own goal blocked after tool failure.
  Their useful patches were recovered from task-specific assistant final_answer
  records only, never auth/key/reasoning records. They remain UNAPPLIED drafts.
- Recovery files: .tools/hosted-evidence/2026-09-04/recovered-96-final-1.md is the
  Slither refinement diff on4a0db1a3; recovered-96-final-2.md supersedes its
  OwnedProcessExecution implementation. Apply both, not just one. Slither local
  /tmp/agtmai-slither-91-mac remains4a0db1a3ea5230e1b3c5376d036cb1ece931910a,
  the unaccepted16/17,9lint draft. recovered-97-final-1.md contains the complete
  Solana publication patch on e723. Original terminal JSONs are also retained.

Currently live old-host jobs, freshly observed:
- agtmai-r212-custody-review99-20260904, PID786658, xhigh/priority/read-only,
  exact4c93, workspace /var/data/agtmai-r212-custody-review99-workspace.
- agtmai-r212-evm-closure100-20260904, PID813028, medium/priority,
  exactcfba, workspace /var/data/agtmai-r212-evm-closure100-workspace.
Registry /var/data/agtmai-r212-resume-20260904-registry, account-m, old host
209.38.106.83 machinebe0aad971ea647fab370acd110b469b7. Last admission about
11.2GiB RAM available,4GiB swap free,12GiB disk. All source-packet fallbacks
require actual local application/tests and independent review, not sandbox bypass.

Bundles verified and copied to old host:
- /tmp/agtmai-custody95-candidate.bundle, prerequisiteff44,
  SHA2567736f67d57e1d1364cab780ef038bff071fdde2918b8418411126b152e4e30ec.
- /tmp/agtmai-evm94-parent-candidate.bundle, prerequisitee723,
  SHA256ae527207acff2aadb485217cb16e856804474056fd558d6077c55b24723f9d76.
- /tmp/agtmai-slither91-draft.bundle, prerequisiteb95,
  SHA2565804488768479b8f80aa3cce683340678f855d4f94ef92862445c51795fd3597.
Review98 JSON SHA2562cf5167e40e70503571f6630d21a09414b4502c358c4ad95e2077670a94f9a20.
Recovered96 final1 SHA25686cc2f2a63744f0cbac6b3016f3302d47802b750a5a63c786197ac4301107824;
final2 SHA2568d50b1b4362b3fdc4756b6068a8438ba74fd433a6e9c211231be07b5455a592a;
recovered97 SHA256a897dd521d6c6c3ec15871a0b692d2f304f6c5aae548fc886381f2bbced6e1d4.

Next: consume99/100, apply/test recovered96+97 in isolated source worktrees;
then independent review and accepted checkpoint integration. Full original-plan
matrix remains authoritative, including recovery package/bootstrap/loaded-image
and Slither authority obligations, Linux qualification, root/CI and final reviews.

## Earlier reconciliation: 13:49 UTC

Accepted integration code remains e723bc0df8efa867a78f8a4cd68e8862e95a18f2.
Original user worktree212b278f and its dirty paths remain untouched.

- Review92 returned AMEND P1: several teardown paths still stop after their
  first close failure or retry an uncertain numeric FD. Its targeted probe
  reproduced a nonterminal handle and an open root descriptor. Actual Linux
  cleanup/evidence19/19 passed; broader33cases had28pass/5inherited Git-authority
  failures. Earlier supplied Mac33/33 does not cover this newly found branch.
- Writer95 owns only those close/error paths and focused regressions, exactff44,
  medium/priority on old host, IDagtmai-r212-custody-teardown95-20260904,
  PID353421. No recovery acceptance/integration until it is fixed and reviewed.
- Writer91 supplied a complete Slither patch after one bwrap editor failure;
  no hosted tests ran. Main applied it in isolated /tmp/agtmai-slither-91-mac,
  correcting one stale context, pipe-child typing, portable test Node path and
  the shared environment-failure schema. TS7 passes; first focused actualMac
  run is16/17, with one wrong assertion about an already-exited leader's zero
  status while its descendant times out. Scoped lint reports9structural/style
  issues. This draft is NOT accepted or integrated; correction work continues.
- Planner93 is active on exacte723, legacy-v3 Solana reclamation provenance and
  initial no-replace/lease bounds. IDagtmai-r212-solana-filesystem93-20260904,
  PID68831, xhigh/priority/read-only. Writer94 owns the independent EVM half of
  initial no-replace/lease bounds, same base; IDagtmai-r212-evm-publication94-20260904,
  PID203452, medium/priority. Both have isolated exact-bundle clones and full
  source packets. Neither lane is accepted merely because a launcher completed.
- Latest old-host admission: machinebe0aad971ea647fab370acd110b469b7,
  about10.7GiB RAM available,3.6GiB swap free,16GiB disk. Priority/fast is active.
  No sandbox/runtime/auth changes or editor retries were used. Source fallback
  requires local application and actual tests plus independent review.

Next: correct/verify drafts91/94/95, consume93 advisory without widening deletion
or provenance authority, and continue the complete original-plan audit matrix.

## Earlier reconciliation: 13:38 UTC

Accepted integration code is now e723bc0df8efa867a78f8a4cd68e8862e95a18f2.
Original user worktree212b278f and all original dirty paths remain untouched.

- Review89 independently ACCEPTed374a7d49, no severity findings, Linux13/13
  wire/verifier tests. Main integrated only those four reviewed files as e723.
  git diff374a7d49..e723 -- tooling/local-solana is empty, proving source identity.
- ActualMac exact374a7d49 Solana coverage is90total:87pass,0fail,3Linux-only
  skips. This combines13wire/verifier,21CLI/RPC/runner,52remaining cases
  (49pass/3platform skips), and4/4real integration with required binaries,
  including three parallel-process rounds. Real suite took127.7seconds.
  TS7 and scoped lint pass. This closes L3 and current-source Mac L1 evidence,
  not legacy-v3/N2/Slither/recovery/CI or production approval.
- Writer90 returned the minimal rename-custody patch after one tool failure.
  Main applied it locally as ff44c448378d907bb8f2715365f4221206c50b8e,
  parente2b67d4a:2files+32/-6, actualMac33/33expanded custody/replay/removal
  cases,0skips,20.6seconds, lint passes. No accepted recovery integration yet.
  Entire filesystem series f2d..ff44 is19files+1252/-140, including tests.
- New independent reviewer92 is running on exactff44 vsf2d, reviewing the
  entire filesystem series and review82 closure. IDagtmai-r212-custody-review92-20260904,
  PID3883654, xhigh/priority/read-only, separate standalone clone.
- Planner88 completed the bounded Slither execution design. Main accepted the
  corrective scope: monotonic aggregate deadlines, termination/finalization
  reserves, bounded output, owned process-group kill/reap, exact-ID removal
  acknowledgement and typed cleanup uncertainty. No stronger malicious-daemon,
  uninterruptible-kernel or arbitrary non-cooperative-callback guarantee.
- New writer91 implements only that S7 scope onb95 (Slither source unchanged
  bye723). IDagtmai-r212-slither-execution91-20260904,PID3877551,medium/priority.
  No overlapping Slither writer. Input/tool/Git authority and publication are
  separate remaining lanes; no native helper/runtime redesign is authorized.
- Both new jobs have full source packets, verified Git bundles/exact bases,
  successful pre-dispatch Git-lock probes and direct pinnedNode24.20.0.
  Old-host identity matched;11.8GiB RAM available,3.6GiB swap free,19GiB disk.
  Editors failing bwrap are not retried/bypassed; source drafts remain useful
  but require main application/tests and independent review.

Independent accepted reports: review87.json SHA256
c5c7c5785a0c6cdb95eb5b174b2ee12408e8ced2705b96466bc9c0b03bab0dcb;
review89.json SHA256
b00748370f985defd82bb590a79e444c75a0a06a8a8038a3ab994f6bc77f1d2e.
planner88.json SHA256
d65e0016d1db311e12f97fa0db7097b7033b5f13090671dabd20f67fd5bafe42;
writer90.json SHA256
db785b689dc8a14fb9df09c88752e48345d5e48877eb8229f46b82f89b162632.
Review92 bundle /tmp/agtmai-custody90-reviewed-candidate.bundle SHA256
2912291c142690b63077523c46c203c2e63345e86c7ae0353dfa24787917997a.

Next: collect91/92 without duplicate jobs; review/qualify outputs, compose the
accepted filesystem/archive/wrapper series safely, then remaining authority,
legacy/publication obligations in the full audit. Final exact-head full local/CI
and four specialists plus sequential holistic review remain mandatory.

## Earlier reconciliation: 13:33 UTC

Accepted integration code remains b95c66be. Original worktree212b278f and its
dirty files are unchanged. Historical entries below are source-bound evidence.

- Writer85 returned a complete patch after one bwrap editor failure, no retries
  or source commit. Main applied it and added missing gid binding in stable
  shared ancestor identity. Isolated e2b67d4aa2fd0e86093fee43384a5e6c0c398e5e,
  parent88d5daab:22/22 focused actual Mac tests pass, lint passes. Expanded26case
  run has23pass/3fail: after a verified directory rename into quarantine,
  the Darwin descriptor registry still holds the old canonical source path.
  This is one uncovered transition defect, not three separate defects. No
  acceptance or full-recovery claim. Writer90 owns only removal-quarantine
  transition and targeted tests; PID3551164, basee2b67d4a, medium/priority.
- Writer86 likewise returned a source packet patch after one editor failure;
  main applied it as isolated374a7d49c6d6fc493ec39d9d09568d426a436edc,
  parentb95. Fourfiles+66/-6 independently verify exact Some/None raw bytes,
  reject malformed/trailing/foreign-key encodings and add literal transaction
  goldens. ActualMac13/13wire/verifier plus21/21CLI/RPC/runner cases, TS7 and
  scoped lint pass. Real local current-source integration is running: lifecycle
  passed; parallel-process rounds pending. Reviewer89 PID3544506 independently
  checks exact374a7d49, xhigh/priority/read-only. Not integrated until review.
- Reviewer87 ACCEPT for the Bash3.2 wrapper delta on b8d05aa7, no severity
  findings. Pinned Linux Node:11/11wrapper+authority tests, no skips. Existing
  actual Mac1/1wrapper and10/10authority evidence covers stockBash3.2; scoped
  acceptance only. Literal allowlisted metacharacters and nonzero exit code
  were statically inspected, not separate dynamic regressions. Do not create
  another architecture task for those informational test gaps.
- Planner88 remains running on the minimal Slither deadline/process/finalizer
  design. Do not duplicate it. All subsequent jobs remain fast/priority with
  medium implementation and xhigh independent review/planning.

Writer85/86 first deliverables took about78/71seconds. Solana's first local
focused run passed13/13; custody passed new targeted tests but expanded actual
Mac coverage exposed the transition defect above. Model speed is not acceptance.

Evidence writer85.json SHA256
b3fdd4fdf5806ab3bab417c13d289382e5b91648120a22643bfe553335f96bc0;
writer86.json SHA256
eb54bf8ad7b09d2ace42ac71767087eda1474bae88170aaf03d23cc3a9e077d1.
Portability/remediation bundle /tmp/agtmai-custody85-followup.bundle SHA256
13ea39d7bcdf2f97662caf3c177b115e0c8954a3939fe0180be66171538f0e7b;
Solana /tmp/agtmai-solana-wire86.bundle SHA256
63a18b998d9462489bac0105a10b2e2ea0b22c0fb2bfa9ea3c7c8d381b4fcdc2.
Standalone hosted clones verified exact bases and Git lock creation before job
dispatch. Node archives were SHA256 verified. About10.2GiB RAM available,
3.4GiB swap free,19GiB disk remained on the verified old host at dispatch.

## Earlier reconciliation: 13:28 UTC

Accepted integration code remains b95c66be5d19367f85e864fc72b3b41d4826e906;
the original dirty user worktree is untouched. This section supersedes all
running/pending claims below; historical results retain their exact source.

- Audit80 completed. The full deduplicated original-plan matrix is preserved in
  ORIGINAL-PLAN-INVARIANT-AUDIT-2026-09-04.md. It audited9e428793/code7d07:
  its then-open solc integration is now closed by b95 and actual Mac7/7.
  Slither at-use authority, bounded process/finalization, Git/evidence authority,
  Solana raw-wire/legacy-v3 recovery, initial size/publication bounds, recovery
  package/bootstrap authority, real platform qualification and final CI/reviews
  remain open. Do not reduce scope to recovery only.
- Review82 on76c9205 returned AMEND: P1 authority-root refresh discards policy;
  P1 replay fixture uses source instead of required checkout leaf; P2 retained
  sibling nlink increase is falsely rejected; P2 first close failure leaks later
  descriptors. Linux33/34focused,5/5evidence,16/16cleanup,88/89aggregate;
  the replay failure is real and not the external /tmp/.git issue.
- Writers83/84 ended with no source changes after bwrap UID-map editor failures.
  Their complete earlier final-answer patches were recovered from task-specific
  final-answer records only; no reasoning/auth/key files were read. Main applied
  them locally using apply_patch. No runtime or sandbox bypass was attempted.
- Portability checkpoint88d5daab15f0f013d94de5247480db54cb9c07c7, parent76c:
  original/canonical Darwin root revalidation, explicit fixture alias policy,
  module-size/lint fixes and a new typed descriptor registration correction.
  Shared-path registration previously stored serialized string fields, then
  compared them to BigInt fstat identity on Darwin. Now raw stats are registered
  only after identity checks and malformed serialized records are rejected.
  Actual Mac18/18focused,0skips; scoped lint/diff check pass. NOT accepted pending
  review82 remediation and independent re-review.
- Wrapper checkpoint430b0b52, parent49924acf: Bash3.2-compatible unset/empty/value
  detection, isolated behavior test registered by the existing toolchain suite.
  Test-only composition /tmp/agtmai-recovery-composed-88d is b8d05aa76854fdaa9ef28372998cade5217ede3b
  (88d+accepted archive delta+wrapper). Actual Mac10/10archive/authority and
  16/16cleanup cases pass. A no-isolation multi-file run reported27, but the
  wrapper file was only discovered, not its named test: the wrapper was rerun
  alone and its1/1behavior case passed. No inflated coverage claim. Scoped lint
  passes. Synthetic linux-x64 fixture bytes were executed under real Mac Bash;
  this is shell portability evidence, not a Linux runtime qualification.
- New hosted writer85 owns only review82 custody/shared-path/fixture findings;
  writer86 owns only independent Solana Some/None raw-wire verification/goldens.
  Both are actually running on the old host/account-m, medium/priority, separate
  clean standalone clones synchronized through verified exact-base Git bundles.
  IDs: agtmai-r212-custody-fixes85-20260904 (PID3115253,base88d5daab) and
  agtmai-r212-solana-wire86-20260904 (PID3122653,baseb95c66be).
  Complete source packets permit useful patch drafting if tools fail; tests
  must then be marked not run. No repeated broken-editor retries or host changes.
- Latest resource admission: machinebe0aad971ea647fab370acd110b469b7,
  about10.6GiB available RAM,3.5GiB free swap,21GiB free disk. Priority means
  fast mode; implementation medium, independent review/planning xhigh.
- Actual Mac current-source Solana integration completed:4/4,0fail,0skip,
  132.7seconds. Required-binary mode was enabled. Real mint/burn/negative-authority
  lifecycle and three rounds of separately spawned parallel fixture pairs pass.
  This closes the current-source Mac lifecycle gap, not Linux/CI or forthcoming
  wire/lease changes. No public network or paid asset was used.
- Independent fast review87 (PID3297240) checks only the Bash3.2 wrapper delta
  on diagnosticb8d05aa7; planner88 (PID3303816) designs the minimal Slither
  process/finalizer deadline correction onb95. Separate read-only xhigh jobs.
  Writers85/86 became terminal at13:28; outputs are being collected, not accepted.

Review82 raw final evidence: .tools/hosted-evidence/2026-09-04/review82-full.md.
Verified portability bundle /tmp/agtmai-custody-portable-85.bundle SHA256
040b6d0eac9ce6e06f994414c91ab3d76c1a928a1518e0d15da9ca822c194f67.
Diagnostic composition bundle /tmp/agtmai-wrapper-composed-b8.bundle SHA256
1b46bfceb4c1f88ddbf83fc853c07659f20e337ab85933f60180f247f1430dbb.

The original latest addendum explicitly retains the POSIX same-UID concurrent
mutation limitation. Audit80's stronger earlier cleanup wording is flagged,
not silently adopted or used to resurrect rejected native designs. Supported
lifecycle/substitution safety remains required; a stronger isolation boundary
would need a separate decision. No public network/tokenomics/vesting scope.

## Earlier reconciliation: 13:04 UTC

Current accepted integration code HEAD is
`b95c66be5d19367f85e864fc72b3b41d4826e906`. This section supersedes earlier
pending/running claims. The original dirty user worktree is untouched.

- Independent review79 returned ACCEPT on `ae60e200`, P0/P1/P2/P3 all zero.
  Linux:22pass/3native-solc skips/0fail. Actual Mac coverage of all25cases and
  TS/lint was recorded below. Parent7926ace and its redaction fix are integrated
  separately as `2a851aae` and `b95c66be`.
- Combined exact `b95c66be` passed actual Mac local-EVM runner integration:
  7pass/0fail/0skip,37.6seconds, covering replacement rejection, repeatability,
  parallel isolation, interruption and SIGKILL reclamation. Not the full gate.
- Recovery75 completed clean `76c9205aa55e483173c0dc305a47e80e6fe6299b`,
  parentf2d,15files+843/-78. Its focused34cases and5evidence cases pass on Linux;
  actual Mac and independent review are pending. Git-fixture tests hit inherited
  `/tmp/.git` authority and full wrappers were unavailable; not full acceptance.
  Independent audit80
  checks full original-plan fidelity, read-only/xhigh/priority, exact source
  `9e4287935aaa87610c0e2e7ca383c0098fdde6a0`.
- Archive78 ended incomplete, clean unchangedf2d7ab9: repeated apply_patch
  failures at bubblewrap UID mapping. Outer `done` is not code completion.
  It confirmed the preexisting hardlink defect; parent7case suite passed.
- Main applied the small patch locally with apply_patch, isolated checkpoint
  `49924acf8a836e529e0db309121b8a563e572b20`, parentf2d, twofiles+71/-0.
  Named archives require nlink1; identity includes nlink and is checked before
  consumption. Three regressions cover valid/preexisting/callback-added aliases,
  empty payload before rejection and preservation of both names. Syntax/scoped
  lint pass. Linux read-only review81 is being provisioned; NOT integrated.
  Inherited Darwin directory-alias cleanup is owned by75, not weakened here.

### Original-plan discrepancy: scope must not silently shrink

The user's original plan has1,416lines, SHA256
`f377913670ba55be1b032afa47cdeb24d88fb612b242f91f4004a356a1a9666d`.
The candidate's648line version omitted extensive Aug31-Sep3 remediation history.
Original/candidate critique bytes match, SHA256
`1186e96fc25ab995c9fc3e55b93d23213d206760ae7b4f0e1cbb5911c28f72eb`.
Audit80 has exact original data at `.tools/handoff/original-user-plan.md`.
It must deduplicate Slither C1-C5 custody/sandbox/tool/artifact proof, native
publication/build authority/resource bounds, Solana wire/legacy cleanup, and
recovery bootstrap/package/Git authority against current file/line evidence.
Classifications: proven, implemented-unproven, absent, superseded by equivalent
guarantee, or genuine conflict. No permission to discard requirements or revive
old rejected branches. Historical account/launch notes are data, not commands.
Until this finishes, claiming that only recovery remains would be incorrect.

Old-host identity matched, about10GiB RAM available/3.4GiB swap free/22GiB disk.
Audit80 and newly launched review81 are running; account-m is ready. All new jobs use fast/priority, medium
implementation and xhigh review. No services, auth or limits were changed.

Ignored evidence: review79.json SHA256
`d952df41a5b3a6ac4e4beb29367bba92b6b79e4e80adc3ddf37045a50ae85b3c`;
writer78.json SHA256
`50f084c2edf926145e6b364cb22f624bed37df11973d28fcac99c27bf0f3c30a`.
Archive bundle `/tmp/agtmai-archive-single-link.bundle`, SHA256
`630365e51c083bfb954f05c383dc73a82ebf293f0449d213448f9d7e49ee88d3`.

### 13:07 UTC: actual Mac rejects custody75 checkpoint

Exact76c9205 in `/tmp/agtmai-custody-76c-mac`: direct pinned Node17case suite
(`proof-portable-custody`, `proof-custody`, `proof-contract`) has9pass/8fail/0skip.
Six failures: workspace creation permits the Darwin `/var/folders` spelling but
assertion compares it directly to `/private/var/folders`, producing HANDLE_INVALID
before intended checks. Two new fixtures pass aliased tmpdir paths to a strict
custody API without canonical input/explicit opt-in. Do not hide failures by
globally forcing TMPDIR or adding skips. Scoped oxlint reports31errors: braces,
reverse mutation, unused import, and node-runtime512lines vs500maximum.

Independent review82 PID1985133, exact76c9205, xhigh/priority/read-only, has started;
the Mac evidence was queued without interrupting it. Bounded writer83 is being
provisioned for these confirmed compatibility/lint issues. Both preserve the
known same-UID final-pathname-syscall limitation and the separate unsupported
Darwin loaded-Node-image proof. No recovery acceptance yet.

### 13:11 UTC: archive checkpoint accepted; additional Mac toolchain finding

Independent review81 ACCEPT on49924acf, P0/P1/P2/P3 all zero, clean tracked state.
Direct pinned Linux Node:10authority+2archive-cleanup+1descriptor-source+
1bootstrap-snapshot cases passed, no skips. Its in-memory mutation removed the
pre-consumption assertion while retaining post-consumption:9pass/1intentional
failure, observing `['solc']` instead of empty payload. No source was modified.
Accept the delta only; do NOT cherry-pick the unaccepted f2d base into the main
candidate. Candidate has no toolchain-archive.mjs yet; compose this accepted
checkpoint into the isolated recovery series when that series is ready.

Actual Mac exact76c9205 additional check:16/16 cleanup-safety cases pass, and
2/7 toolchain-authority cases pass; the remaining5 fail during fixture install
because generated bin/node uses Bash `[[ -v name ]]`, unsupported by stock
macOS /bin/bash3.2. This is inherited fromf2d's toolchain-installation.mjs,
not the archive delta or newly added custody code. Total23:18pass/5fail/0skip.
The pnpm archive used was hash-verified development setup. Do not relabel this
as five distinct security defects; it is one concrete portability blocker.

Next: collect80/82/83; accept only independently reviewed exact checkpoints;
restore the full invariant ledger; close remaining confirmed code gaps and
package/bootstrap/Git authority; reconcile main; full exact-SHA local/CI then
four specialists and a sequential frozen-ledger holistic review.

## Earlier reconciliation: 12:53 UTC

Current integration code HEAD is `7d07a10c70fd5c898152eadccae8e3e4e5bd0ba6`.
Owned documentation checkpoint5bf3d1c8 is committed; the original user worktree
is untouched. This section supersedes all earlier job and gate snapshots.

- Deployment review76 returned independent ACCEPT on d1bd4d95, no P0-P3.
  Source is integrated as7d07a10c. Actual Mac source:125pass/3Linux-only skips,
  including enabled real Anvil. Combined candidate root lint, root TS build,
  deployment TS and Foundation0.20.0 full check pass, seven capabilities and
  zero diagnostics. This is not the complete final local/CI gate.
- Toolchain68/review72 are accepted and integrated ascaedc5d6.
- Solc69's7926ace remains outside the candidate: review73 closed its original
  two P2s but found one introduced raw-stderr cause metadata P2. Writer77 has
  completed cleanae60e2004f379bbc6511061e6efc7f37a674682c (parent7926ace),
  twofiles+57/-1, and independent fast review79 is running.
- Recovery75 remains active on filesystem custody/early capture/staging.
  Recovery70's failed partial remains preserved and unaccepted.
- New archive78, basef2d7ab9, PID1377305, provider.task.started12:50:05,
  medium/priority/account-m, owns only scripts/toolchain-archive.mjs and its
  authority tests. It addresses the known omitted named-archive nlink1 check
  with preexisting/during-callback hardlink regressions; no custody-file overlap
  with75 and no new trust framework/dependency/CI changes.
- All new workers use fast/priority, medium implementation and xhigh review,
  on the old host. Latest resources:11GiB available RAM,3.7GiB free swap,
  23GiB free disk; expected machine identity matched. No service/limit changes.

Spike74 completed in about14m37s. An authenticated complete quiescent pnpm11.24.0
store (`v11/index.db` and every referenced payload) produced by exact-lock fetch
supports frozen/offline/copy install with no new request, lifecycle execution,
escaping link or shared installed/store inode. Local-tarball `store add` cannot
populate registry lock identities. Missing required content fails; missing
optional content can return success while omitting the package. Thus exit0 is
not proof of required platform coverage. Do not build a custom CAFS/SQLite writer.
`--ignore-workspace` was only synthetic fixture isolation, not the real monorepo
command. Real Darwin/native addon coverage and the authenticated producer/
expected-bundle-hash channel remain implementation obligations. Both fake
registries and disposable state were removed; only the report remains.

Copied ignored development evidence in `.tools/hosted-evidence/2026-09-04/`:
review72.json SHA256`4f88030fcdf736ab53e13abe4d0ee713582eb15c54c5d20275829ba881aff47d`;
review73.json SHA256`e14968cbdd1ec4e30397b243264699a93846e52e83b50016736b16e57885bfe9`;
review76.json SHA256`a34012eca7e2847befdbfcab5ad317a188c6ae83e4df12bc2fc2b4a0d7c61d7a`;
spike74.md SHA256`6023a659e56316ecf9049bebe0ddc0e264a14020a37ed55e231f38743fb9f4a3`.
These reports are not package-byte trust roots or final production approvals.

Next: finish77/75/78 with scoped review; implement package/bootstrap/preflight
authority without overlapping custody ownership; then reconcile main and
execute the plan's full exact-head local/CI and final independent reviews.

Writer77 terminal evidence:25focusedtests22pass/3native-solc skips, zero fail;
first material patch12:47:05, two iterations, elapsed7m6s. It violated the
no-pnpm-execution guidance by attempting a check that implicitly installed;
it terminated that attempt, removed its generated node_modules and reported
no downloads. No tracked dependency or pin change exists. Its apply_patch
runtime could not initialize bubblewrap UID mappings, so it used the system
patch utility; final clean two-file Git diff was independently inspected.
Do not treat either operational issue as a source acceptance claim.

Verified bundle `/tmp/agtmai-solc-ae60e200.bundle`, SHA256
`ef4379fb330f1d6d3ac232084f97f93235bdeef0339a21c6239cbb37e2030b4e`.
Mac `/tmp/agtmai-solc-7926-mac` is now exactae60e200, not7926ace. First new
focused run:23pass/2setup failures because the orchestrator omitted Foundry
from PATH (Anvil ENOENT), not assertion failures. The two cases alone were
rerun with complete pinned Node/Foundry/pnpm PATH:2pass/0fail/0skip. All25
focused cases are covered on exactae60e200, with the initial setup failures
retained in this record. Local-EVM TS and scoped lint also passed afterward.
Review79 PID1489394 reached
provider.task.started12:53:00, xhigh/priority/read-only/account-m; its prompt
expressly prohibits even pinned pnpm/corepack/dev or gate-wrapper execution.

## Earlier reconciliation: 12:42 UTC

This section supersedes earlier pending/running statements below. Current
integration code HEAD is `caedc5d6c055a769a686385ec1e61c93e44b1cfb`.
Only owned documentation is dirty. The original user worktree remains untouched.

| Lane | Verified state | Next action |
| --- | --- | --- |
| toolchain68 / review72 | clean `bd8af372`, independent scoped ACCEPT, Mac 37 cases covered; cherry-picked as `caedc5d6` | final combined gates later |
| solc69 / review73 | clean `7926ace266edd532794b164c2b17a7aa8d807dbb`, parent `d3d79613`; actual Mac integration 7/7, no skips | review73 running, not integrated |
| deployment67 / review76 | clean `d1bd4d95a03d76987e0c3e36a5d692a80d990e42`, parent `09a1e882`; actual Mac 125 pass / 0 fail / 3 Linux skips, including enabled real Anvil | review76 running, not integrated |
| recovery70 | incomplete, uncommitted; repeated process/namespace EAGAIN; outer runtime `done` is not implementation completion | original partial preserved, not integrated |
| planner71 / spike74 | planner completed advisory analysis; disposable pinned-pnpm behavior experiment running | select authority design from measured behavior |
| recovery75 | fresh clean `f2d7ab9` clone, filesystem-only writer, medium/priority | collect completed tested checkpoint |

New fast jobs on old host/account-m, same registry: review73 PID1107449,
`provider.task.started` 12:37:06; spike74 PID1051365, start12:33:15;
recovery75 PID1174727, start12:40:57; review76 PID1189273, start12:41:51.
All are separate jobs/workspaces. Reviewers xhigh/read-only, writers medium;
all service-tier priority. No local collaboration subagents were used.
Fresh machine ID matched; 10 GiB available RAM, 3.9 GiB free swap, 25 GiB disk.

Solc source bundle `/tmp/agtmai-solc-7926ace.bundle`, SHA256
`c57f874c0ff0391b9a5f0cfecab461c8d6e1a572ee261f33045d888e4ae7166b`.
Actual Mac checkout `/tmp/agtmai-solc-7926-mac`: focused source suite first
54 pass/1 environment failure from missing Node on PATH, then that sole test
passed with the pinned Node PATH. All 55 cases covered; root TS build,
local-EVM TS and scoped lint pass. Actual runner integration: 7 pass, 0 fail,
0 skip, including all six snapshot replacement classes before both phases,
two clean chains, concurrent isolation, interrupt cleanup and SIGKILL recovery.
Shared development dependency symlinks are untracked test setup, not source
changes or recovery-authority evidence. No tracked file changed.

Deployment bundle `/tmp/agtmai-deployment-d1bd4d95.bundle`, SHA256
`fbc633bc4bed66fd3fa2d67b9d87a56b0482a11f2d05f1ac8943a2b3e710f71d`.
Actual Mac worktree `/tmp/agtmai-deployment-d1bd-mac` at exact d1bd4d95 ran
all deployment tests with pinned Anvil/Forge/solc explicitly enabled: 128 total,
125 pass, 0 fail, 3 Linux-only skips. The previous genuine Forge build-info
size failure is closed in this checkpoint, not yet in the combined candidate.
Writer Linux evidence: 125 pass/3 skips (different platform/opt-in skips),
scoped lint, five TS projects and seven Foundation capabilities pass.
Full pnpm wrappers were unavailable due missing offline metadata; no full
gate claim. One-line 89,640-byte representative build-info fixture is excluded
from handwritten-LOC expectations; other changes remain bounded to16paths.

Recovery70 diagnostic patch SHA256
`d6e14b97c8a80897f2346a7b428b16ad19f44eceaad74158080a76bf7025e101`
is preserved with its original tree and .orig/.rej files. Recovery75 starts
from clean exact base, with that patch available only as diagnostic material.
It must not blindly apply or integrate unfinished code. Scope is filesystem
custody, early capture and staging only, NOT package/bootstrap/Git-preflight/CI.
Main-agent correction: shared ancestor ctime/mtime/nlink/size change during
legitimate sibling operations; stable ancestor identity must be distinguished
from strict leaf/verified-transition identity. Added sibling-churn regression
and partial ancestor-acquisition descriptor cleanup to the writer contract.
No host PID limits or unrelated services were changed. Old deployment67
reported448 unreaped PID-1 zombies, so its final test used bounded single-process
isolation; recovery70's precise failed cgroup cause is not independently proven.

Planner71 recommends a complete authenticated pinned pnpm store bundle and
correctly rejects a mutable store as provenance. It also removes the need for
a second general installed-tree byte validator. This is advisory, not a new
accepted architecture. Spike74 uses only synthetic packages and owned loopback
registry to compare frozen/offline install after `fetch` versus supported
`store add` of independently SRI-verified local tarballs. It must prove registry
key compatibility, no lifecycle/pnpmfile execution, no remote request and no
store/install hardlink coupling. Planner71's suggestion that writer70 owns
Git/CI ordering was incorrect; that scope remains separate. Do not invent
extra owner approval rituals for already-authorized zero-cost in-scope work.

The final combined full gate, recovery acceptance, main reconciliation and
exact-head CI/specialist/holistic reviews are still outstanding.

### 12:44 UTC review follow-up

Review73 returned AMEND on7926ace: P0=0/P1=0/P2=1/P3=0. Both previous
classification/snapshot findings are fixed. A new introduced P2 is concrete:
CommandExitError's public stderr getter retains raw output in nested error
cause even though messages are redacted. The normal CLI message is safe, but
cause-aware reporting can expose synthetic key/mnemonic values. No real secret
was involved. Bounded writer `agtmai-r212-solc-redaction77-20260904`, base7926ace,
medium/priority/account-m, PID1220052 reached provider.task.started12:44:17.
Ownership: process.ts plus required diagnostic regressions, runner.ts only if
needed for exact classification. Other lifecycle/snapshot code is out of scope.
Do not integrate7926ace before this small remediation and repeated scoped review.

Actual Mac d1bd deployment TypeScript and scoped lint additionally pass with
existing development dependencies. No tracked source changed in that worktree.
The five-minute automation now defers to this latest ledger rather than stale
job states; no reports/browser were opened.

At12:45 actual Mac Foundation0.20.0 full check on exact d1bd passed all seven
capabilities with zero diagnostics, including the previously failing source
dependency entrypoint. The exploratory `check --help` command was rejected as
unsupported before running the valid `check --consumer .`; it was not a gate.
At12:47 supported run-watch reports all four remaining jobs74/75/76/77 alive,
productive and account-m ready. Its missing legacy plaintext-log warnings do
not imply failure; encrypted-runtime terminal outputs remain the result source.
GitHub API still reports main370c3aac and no open PR. No GitHub write was made.
Mac free disk11GiB; no cleanup of user data or tool caches was performed.

## Resumed at 12:05 UTC; live reconciliation at 12:18 UTC

Fresh user-provided `tv goog five` maps to `account-m`. Supported live account
inspection returned available/eligible and passed. Old-host resource check:
11 GiB available RAM, 4.3 GiB free swap, 28 GiB disk; expected machine ID matched.
Four isolated writer jobs reached `provider.task.started` on gpt-5.6-sol medium,
default service tier (no fast), with network disabled:

| Job suffix | Base SHA | Exclusive scope |
| --- | --- | --- |
| deployment-closure67 | 09a1e882c6e008f75795025dac97f46ecedf06e1 | deployment-plan Foundation/TS/lint and bounded real-build parser regression |
| toolchain-lint68 | 031cfe5251aac28d56a60b4d4b4cc793acb464c5 | scripts/toolchain lint refactor |
| solc-p2-closure69 | d3d79613dcf70378cac10b66d8206396bb07e7ac | local-EVM diagnostic and replacement-test P2s |
| recovery-custody70 | f2d7ab9189a937bc1f2d9788048277503e4197f9 | separate portable recovery filesystem custody checkpoint |
| recovery-authority-planner71 | f2d7ab9189a937bc1f2d9788048277503e4197f9 | read-only xhigh critique of minimal archive/package execution authority |

Full IDs are `agtmai-r212-<suffix>-20260904`; workspaces/jobs are
`/var/data/agtmai-r212-<suffix>-workspace` and `-job`.
Registry: `/var/data/agtmai-r212-resume-20260904-registry`.
The older partial workspaces were not reused or integrated. Source heads remain
unchanged locally until these writers return reviewed clean commits.

Pinned Node/pnpm archives were fetched by the orchestrator from the lockfile
URLs and copied into each ignored `.tools/downloads` only after SHA256 checks:
Node `2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2`,
pnpm `d1eab2433172661cc36a18ec85fce93f771db1962717329cc01ec9c2824ca24f`.
This is development-cache provisioning, not acceptance of recovery execution
authority. No dependencies or version pins were changed.

At 12:18 UTC all five jobs had fresh running heartbeats and confirmed model
start events. The four writers had scoped changes; planner71 started at 12:17
and has no write ownership. Final review independence follows plan section 8:
separate reviewer jobs/sessions with no author/integrator/remediator role for
their scope. Different subscription accounts are not required. Earlier scoped
reviews still cannot substitute for final reviews on the final exact SHA.
Main remains `370c3aac97e4b3ddc7fcc9ada762a050580d0f39` (fresh GitHub API read).

Toolchain68 was intentionally interrupted by scoped execution guidance after
it tried ambient pnpm and searched outside its workspace for tools. Runtime
returned `accepted_as_next_safe_point` but then ended the attempt with
`runtime_interrupted` and preserved the patch. No account quota failure occurred.
The orchestrator inspected the entire six-file partial diff (including the new
helper), exact unchanged base, clean diff-check and dead old PID. The supported
continue tool required inspection/forceStart and then supplied a no-tmux command.
That command resumed the same isolated workspace, not a new authoritative tree;
attempt-2 reached `provider.task.started` at 12:16:31, PID 817938. The initial
handoff patch/manifest remain in the job. Do not casually interrupt the other
productive writers just to deliver optional cache guidance.

Primary-source authority clarification for the next recovery lane:
[pnpm store documentation](https://pnpm.io/settings/store#verifystoreintegrity)
explicitly treats a shared store as a trust domain: verifying cached files does
not authenticate an index and payload both writable by an attacker. Read-only
store operation prevents mutation, not forged origin. The
[build documentation](https://pnpm.io/settings/build#ignorescripts) also notes
that disabling lifecycle scripts does not disable pnpmfile execution. Planner71
must compare authenticated package archives against a complete pinned store
bundle and identify the smallest tested design; no new architecture is accepted
merely by this research or by that worker's recommendation.

At 12:24 UTC a real dev-gate observation showed pinned `pnpm run/exec` starting
implicit installs during `check:changed` and `typecheck`; nested Foundation
execution also reached ambient pnpm. A configured network restriction alone
must not be reported as proof that no install was attempted. The official
[verifyDepsBeforeRun setting](https://pnpm.io/settings/build#verifydepsbeforerun)
accepts `install`, `warn`, `error`, `prompt`, or `false`, not `true`. Use an
explicit fail-on-stale configuration in the future execution-authority design;
it checks dependency freshness, not cryptographic byte authenticity. Direct
verified binaries or honest unavailable-gate reporting are preferable for the
current dev-only focused checks. Guidance was queued for toolchain68/planner71
at the next safe point. Unsupported live-delivery signals were superseded;
both control inboxes report zero blocked signals. No worker was interrupted
for this later guidance and no project dependency setting was changed.

## Exact candidate and preserved work

### Completed checkpoint awaiting integration/review

Toolchain68 completed clean commit
`bd8af372bd5669eae15542b7ab2a4f4aaf504951`, parent `031cfe5`, six owned files,
`+74/-62`. Runtime's auxiliary handoff materialization reported
`handoff_base_commit_mismatch`; direct Git inspection independently confirmed
the expected parent, clean tree and exact scope. A fresh Git bundle was made
from that verified commit instead, transferred and verified locally:
`/tmp/agtmai-toolchain-bd8af372.bundle`, SHA256
`4cebf600c2dcdd2b7bab37506eafc76dd2006f659f93bcd1e7592e9c99b07b23`.

Actual Mac source checkout: `/tmp/agtmai-toolchain-bd8-mac`, exact `bd8af372`.
Focused run had 36 pass plus one setup failure from absent pinned pnpm payload.
After checksum-verifying/extracting the existing pnpm archive, only that
unproven test was rerun: 1 pass, 0 fail. Together all 37 focused cases are
covered on that exact source; the first failed run remains part of the record.
Scoped oxlint passes with the byte-identical existing root config and installed
Foundation preset. This is dev-cache reuse, not proof of clean full bootstrap.

Fresh independent review `agtmai-r212-toolchain-bd8-review72-20260904` started
at 12:31:06 UTC, PID 1019254, exact `bd8af372`, xhigh / service-tier priority
(fast), read-only, same account-m. Its result is pending. Original author job68
is terminal; do not launch another writer for that completed scope.

- Local code head: `2b7ee4b4cff992c7526f8535859e2bb67f84a65b`.
- Candidate: `/tmp/agtmai-r212-integration2`.
- User worktree: `/Users/belief/dev/projects/agent-teams-token`, branch
  `feat/genesis-core`, original head `212b278f22c5de7c2158e53a5b338f7448a1973c`.
  Existing modified plans/status/lockfile and untracked reports were not touched.
- Old host: `209.38.106.83`, machine ID `be0aad971ea647fab370acd110b469b7`.
- Runtime revision: `d063fc9c81fe04c8bbb524d96e12081191fd996`.
- Hosted settings: gpt-5.6-sol, default service tier (no fast); medium writers,
  xhigh planners/reviewers. At 12:18 UTC the user requested fast for subsequent
  workers/reviewers: use service-tier priority for new launches. Existing five
  no-fast jobs continue unchanged. No real wallet or public-chain operation.

## Integrated source

1. Native provenance `031cfe5251aac28d56a60b4d4b4cc793acb464c5`, parent
   `25576915514da202c5e372b049653c22a19c4ebf`, integrated as `da5732d3`.
   Bundle SHA256: `5b0c01a53056d3b4830d65c9753718b76a3913921e1eeb920879395cdff5f055`.
   Source security changes are not yet accepted: the current local gates fail.
2. Darwin `/usr/bin/false` test fix
   `09a1e882c6e008f75795025dac97f46ecedf06e1`, parent `031cfe5`, integrated
   as `2b7ee4b4`. Bundle SHA256:
   `623a71919cf4b4af433b5bc5a8fa4023d827cae0bb2595d0226b3b2de90ecf1b`.
   One test file changed. Production native compiler policy did not change.

## Fresh verification

Actual macOS arm64, pinned Node 24.20.0:

- Native helper focused test: 20 total, 17 pass, 0 fail, 3 Linux-only skips.
- Deployment-plan suite: 124 total, 120 pass, 0 fail, 4 skips. The real Anvil
  case is opt-in and must be recorded separately, not counted as executed here.
- Separately enabled actual Anvil suite: 3 total, 2 pass, 1 fail, 0 skip.
  `BUILD_INFO_INVALID` is reproducible after the provenance parser change.
  Direct inspection of existing valid build-info found 1,366,773 bytes,
  depth 26, largest encoded string 33,914 bytes, largest object 19 members
  and largest array 31 items. Shared parser limits are only 65,536 bytes and
  16,384 string bytes, and it raises `JSON_LIMIT_BYTES`. A policy-size profile
  must not be reused blindly for artifact/build-info inputs. Retain bounded
  duplicate-safe parsing with explicit per-input profiles and real-build tests;
  do not simply remove all bounds or enlarge every policy parser globally.
- Before the Darwin fix, combined toolchain/deployment tests: 161 total,
  156 pass, 1 fail, 4 skips. Failure was absent `/bin/false`, now fixed.
- Foundation dev-only and registry assertions pass (version 0.20.0).
- Foundation source-dependency check fails: composition imports
  adapters/native-policy.ts outside declared adapters entrypoints.
- TS7 fails on widened `approvalSha256` in tests/verifier.test.ts.
- Root lint has 16 errors, covering composition parameter count, native helper
  complexity/length, braces/shadowing/unused import, and toolchain complexity,
  file length and mutating sort.

Do not call the full gate green based on focused runtime tests.

## Hosted outputs and remaining work

All paths below are under `/var/data/` on the old host.

| Job suffix | Observed outcome | Safe next action |
| --- | --- | --- |
| agtmai-r212-native-foundation-remediation61b-job | partial, account unavailable; 3 dirty files | restart from clean 031cfe5; no dirty integration |
| agtmai-r212-native-ts7-remediation62b-job | partial, account unavailable; one dirty test | restart from clean 031cfe5; also remove unused fixture import |
| agtmai-r212-native-darwin-test-remediation63b-job | completed, clean 09a1e882 | integrated and locally tested |
| agtmai-r212-native-deployment-lint64b-job | partial, account unavailable; 4 modified files plus .orig files | preserve attempt; fresh clean restart |
| agtmai-r212-native-toolchain-lint65b-job | partial, account unavailable | preserve attempt; fresh clean restart |
| agtmai-r212-solc-d3d-review59d-job | AMEND on d3d79613, two P2, no P0/P1 | bounded local-EVM remediation, then exact-head review |
| agtmai-r212-recovery-f2d-planner60-job | REJECT on f2d7ab9, seven P1 plus P2/P3 | reviewed, dependency-safe recovery remediation |
| agtmai-r212-recovery-portable-custody66-job | startup failed: prompt over 4000 chars; clean f2d7ab9 | use compact objective, fresh isolated job |

Quota-limited writers had no completed scoped commit. Saved patches are
diagnostic handoff material only. At 11:25 UTC no r212 writer/reviewer was alive.

Solc P2s: classify only actual child-solc execution denial, not arbitrary Forge
stderr; independently test exact 0500 regular/single-link snapshots and the
symlink/hardlink/rename substitution matrix before both execution phases.

At 12:27 UTC the orchestrator independently ran pinned Forge 1.8.0 on actual
macOS in a new disposable probe project, with an explicit non-executable local
compiler. It exited 1 and emitted exactly
`Error: "<selected-solc-path>": Permission denied (os error 13)` after a separate
warning. This confirms the concrete diagnostic format under test by writer69,
not acceptance of its still-uncommitted error handling. Probe source lives in
`/private/tmp/agtmai-solc-launch-probe.ul06wV`; no wallet, public RPC, installed
binary mutation or user-project execution was involved.

Recovery remains outside the integration candidate. Actual macOS rejected
ordinary `/var/folders` roots and `/dev/fd/N/child` directory traversal. Review
also found two late cleanup-ownership captures, bootstrap symlink traversal,
preflight running after untrusted work, mutable pnpm-store execution authority,
staging TOCTOU and omitted archive link count. Fixing one portability test is
not sufficient. Proposed custody/backend design is not a final accepted ADR.

## Account capacity and orchestration

Before the 12:05 resume, supported pool inspection found 25 configured slots
and no eligible account. Checks at that time: l/v/w/y/t quota-limited; a/g need
reconnect. This snapshot is superseded by the fresh available account-m above.
Do not delete quarantine/capacity/auth state or relogin automatically.
Recheck only when capacity is due or credentials change. A working launcher
without `provider.task.started` is not a productive worker.

Startup lessons: supported edit mode is `allow-edits`, not `read-write`.
Goal objective limit is 4000 characters. Use a compact objective plus the
runtime's documented long-prompt support. Failed startup is not implementation.

The five-minute thread automation was corrected: it no longer points to
obsolete Slither C1 `107b72d`. Its instructions must defer to the latest
verified ledger and never spawn duplicate writers from stale state.

## Continuation order

1. Keep the original dirty user worktree untouched. Reconcile live processes,
   exact SHAs and statuses before any new job.
2. Collect the running provenance scopes from their recorded clean bases, with disjoint
   ownership; Foundation and native-helper refactoring overlap, so give them
   one owner or sequence them. Include composition max-params and the unused
   verifier fixture import, which were not covered by earlier narrow prompts.
   Also fix the measured real-build parser regression with separate input-size
   profiles and real Anvil verification; it is an actual E2E blocker.
3. Run the solc two-P2 remediation independently from exact d3d79613.
4. Review recovery filesystem custody before dependent bootstrap/package
   execution authority; do not introduce an unapproved mutable-store trust root.
5. Transfer only completed clean commits using verified Git bundles. Run
   affected actual macOS/Linux gates; retain platform skips and failed gates.
6. Reconcile current main semantically only after the candidate is stable;
   preserve accepted ADR bytes and resolve docs/package/lock conflicts explicitly.
7. Freeze exact SHA, obtain full CI and the required independent specialist
   plus holistic ACCEPT. Record separate reviewer job/session identities and
   absence of scope authorship; do not invent a different-account prerequisite.

No production token launch is authorized or ready on this evidence.
