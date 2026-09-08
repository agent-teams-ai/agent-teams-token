import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// Keep the synthetic fixture executable with system Bash/Git alone so the
// entrypoint regression can also be validated before pinned Node is available.
const fixtureScript = String.raw`
set -euo pipefail
repository=$1
path_mode=$2
boundary=$(/usr/bin/mktemp -d /tmp/agtmai-ci-entrypoint.XXXXXX)
trap '/bin/rm -rf -- "$boundary"' EXIT
checkout="$boundary/checkout"
marker="$boundary/hostile-helper-ran"
checks=0
failures=0
/bin/mkdir -p "$checkout/scripts" "$boundary/empty-template" \
  "$boundary/pinned/node/bin" "$boundary/pinned/foundry" \
  "$boundary/pinned/solc" "$boundary/pinned/agave/bin" "$boundary/pinned/bin"
/bin/cp -p "$repository/scripts/assert-clean-head.sh" "$checkout/scripts/"
/bin/cp -p "$repository/scripts/assert-complete-history.sh" "$checkout/scripts/"

fixture_git() {
  /usr/bin/env -i HOME=/nonexistent PATH=/usr/bin:/bin LANG=C LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
    GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false GIT_SSH_COMMAND=/bin/false \
    GIT_AUTHOR_NAME='CI Entrypoint Test' GIT_AUTHOR_EMAIL=ci-entrypoint@invalid.local \
    GIT_COMMITTER_NAME='CI Entrypoint Test' GIT_COMMITTER_EMAIL=ci-entrypoint@invalid.local \
    GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z \
    /usr/bin/git -C "$checkout" -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false -c core.attributesFile=/dev/null \
    -c credential.helper= "$@"
}

fixture_git init --quiet --template="$boundary/empty-template"
printf 'baseline\n' >"$checkout/tracked.txt"
fixture_git add .
fixture_git commit --quiet -m 'test: baseline'
baseline=$(fixture_git rev-parse HEAD)
printf 'candidate\n' >"$checkout/tracked.txt"
fixture_git add tracked.txt
fixture_git commit --quiet -m 'test: candidate'
candidate=$(fixture_git rev-parse HEAD)
unrelated=$(fixture_git commit-tree "$candidate^{tree}" -m 'test: unrelated baseline')

# This is the post-source PATH constraint, not a simulated authentication pass:
# only pinned tool directories, with neither system Bash nor Git present.
caller_path="$boundary/pinned/node/bin:$boundary/pinned/foundry:$boundary/pinned/solc:$boundary/pinned/agave/bin:$boundary/pinned/bin"
case "$path_mode" in
  pinned) ;;
  hostile)
    /bin/mkdir "$boundary/hostile"
    for helper in bash git; do
      printf '#!/bin/bash\nprintf executed >"%s"\nexit 99\n' "$marker" \
        >"$boundary/hostile/$helper"
      /bin/chmod 755 "$boundary/hostile/$helper"
    done
    caller_path="$boundary/hostile:$caller_path"
    ;;
  *) exit 2 ;;
esac
printf 'export PATH=%q\n' "$caller_path" >"$boundary/post-source.sh"
cd "$checkout"

expect() {
  local label=$1 expected_status=$2 expected_message=$3 status output
  shift 3
  if /usr/bin/env -i HOME=/nonexistent PATH="$caller_path" LANG=C LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
    GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false GIT_SSH_COMMAND=/bin/false \
    "$@" >"$boundary/stdout" 2>"$boundary/stderr"; then
    status=0
  else
    status=$?
  fi
  output="$(<"$boundary/stdout") $(<"$boundary/stderr")"
  checks=$((checks + 1))
  if [[ "$status" != "$expected_status" || "$output" != *"$expected_message"* \
    || -e "$marker" ]] \
    || { [[ "$expected_status" != 0 ]] \
      && [[ "$output" == *EXACT_HEAD_OK* || "$output" == *ROLLBACK_HISTORY_OK* ]]; }; then
    failures=$((failures + 1))
    printf 'FAIL mode=%s case=%s status=%s expected=%s helper=%s\n%s\n' \
      "$path_mode" "$label" "$status" "$expected_status" "$([[ -e "$marker" ]] && printf executed || printf absent)" "$output"
  else
    printf 'PASS mode=%s case=%s status=%s\n' "$path_mode" "$label" "$status"
  fi
}

# These are actual executable invocations; Bash is not passed the target script.
expect clean-exact 0 "EXACT_HEAD_OK sha=$candidate clean=true" \
  scripts/assert-clean-head.sh "$candidate"
expect complete-history 0 "ROLLBACK_HISTORY_OK head=$candidate baseline=$baseline" \
  scripts/assert-complete-history.sh "$candidate" "$baseline"

# Reproduce the CI call shape after sourcing a PATH-only constraint fixture.
# Integration separately sources real scripts/env.sh with authenticated tools.
for entrypoint in assert-clean-head.sh assert-complete-history.sh; do
  case "$entrypoint" in
    assert-clean-head.sh) message="EXACT_HEAD_OK sha=$candidate clean=true" ;;
    *) message="ROLLBACK_HISTORY_OK head=$candidate baseline=$baseline" ;;
  esac
  expect "post-source-$entrypoint" 0 "$message" /bin/bash --noprofile --norc -c '
    set -euo pipefail
    source "$1"
    [[ "$PATH" == "$2" ]]
    "$3" "$4" "$5"
    [[ "$PATH" == "$2" ]]
  ' ci-entrypoint "$boundary/post-source.sh" "$caller_path" \
    "scripts/$entrypoint" "$candidate" "$baseline"
done

expect wrong-head 1 EXACT_HEAD_MISMATCH scripts/assert-clean-head.sh "$baseline"
expect history-wrong-head 1 ROLLBACK_HISTORY_HEAD_MISMATCH \
  scripts/assert-complete-history.sh "$baseline" "$baseline"
for invalid in HEAD "$(fixture_git rev-parse --short HEAD)"; do
  expect "invalid-head-$invalid" 1 EXACT_HEAD_MISMATCH scripts/assert-clean-head.sh "$invalid"
  expect "history-invalid-head-$invalid" 1 ROLLBACK_HISTORY_SHA_INVALID \
    scripts/assert-complete-history.sh "$invalid" "$baseline"
done

printf 'dirty\n' >tracked.txt
expect dirty-tracked 1 EXACT_HEAD_DIRTY scripts/assert-clean-head.sh "$candidate"
expect history-dirty-bytes 1 ROLLBACK_INVENTORY_BYTES_MISMATCH \
  scripts/assert-complete-history.sh "$candidate" "$baseline"
fixture_git add tracked.txt
expect staged 1 EXACT_HEAD_DIRTY scripts/assert-clean-head.sh "$candidate"
fixture_git reset --quiet --hard "$candidate"

# Restoring worktree bytes must not hide an index that differs from HEAD.
printf 'staged\n' >tracked.txt
fixture_git add tracked.txt
printf 'candidate\n' >tracked.txt
expect index-only 1 EXACT_HEAD_DIRTY scripts/assert-clean-head.sh "$candidate"
fixture_git reset --quiet --hard "$candidate"

printf 'untracked\n' >untracked.txt
expect untracked 1 EXACT_HEAD_DIRTY scripts/assert-clean-head.sh "$candidate"
/bin/rm untracked.txt
/bin/chmod 755 tracked.txt
expect executable-mode 1 EXACT_HEAD_DIRTY scripts/assert-clean-head.sh "$candidate"
expect history-executable-mode 1 ROLLBACK_INVENTORY_MODE_MISMATCH \
  scripts/assert-complete-history.sh "$candidate" "$baseline"
/bin/chmod 644 tracked.txt

expect unrelated-baseline 1 ROLLBACK_HISTORY_BASELINE_NOT_ANCESTOR \
  scripts/assert-complete-history.sh "$candidate" "$unrelated"
expect missing-baseline 1 ROLLBACK_HISTORY_BASELINE_UNAVAILABLE \
  scripts/assert-complete-history.sh "$candidate" 0000000000000000000000000000000000000000
expect invalid-baseline 1 ROLLBACK_HISTORY_SHA_INVALID \
  scripts/assert-complete-history.sh "$candidate" HEAD
printf '%s\n' "$candidate" >.git/shallow
expect shallow-history 1 ROLLBACK_HISTORY_SHALLOW \
  scripts/assert-complete-history.sh "$candidate" "$baseline"
/bin/rm .git/shallow
fixture_git replace "$candidate" "$unrelated"
expect replacement-history 1 ROLLBACK_HISTORY_REPLACEMENT_FORBIDDEN \
  scripts/assert-complete-history.sh "$candidate" "$baseline"
fixture_git replace -d "$candidate" >/dev/null
fixture_git config remote.origin.promisor true
expect promisor-config 1 ROLLBACK_GIT_LOCAL_CONFIG_FORBIDDEN \
  scripts/assert-complete-history.sh "$candidate" "$baseline"
fixture_git config --unset remote.origin.promisor

expect clean-after-negatives 0 "EXACT_HEAD_OK sha=$candidate clean=true" \
  scripts/assert-clean-head.sh "$candidate"
expect history-after-negatives 0 "ROLLBACK_HISTORY_OK head=$candidate baseline=$baseline" \
  scripts/assert-complete-history.sh "$candidate" "$baseline"
printf 'RESULT mode=%s checks=%s failures=%s\n' "$path_mode" "$checks" "$failures"
[[ "$failures" == 0 ]]
`;

for (const pathMode of ["pinned", "hostile"]) {
  test(`CI assertion executable entrypoints preserve authority under ${pathMode} PATH`, () => {
    const result = spawnSync("/bin/bash", [
      "--noprofile", "--norc", "-c", fixtureScript, "ci-entrypoint", repositoryRoot, pathMode,
    ], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /RESULT mode=(?:pinned|hostile) checks=25 failures=0/u);
  });
}
