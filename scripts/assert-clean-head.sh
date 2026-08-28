#!/usr/bin/env bash
set -euo pipefail

token_expected_sha=${1:?expected commit SHA is required}
token_actual_sha=$(git rev-parse HEAD)

if [[ ! "$token_expected_sha" =~ ^[a-f0-9]{40}$ ]] || [[ "$token_actual_sha" != "$token_expected_sha" ]]; then
  printf 'EXACT_HEAD_MISMATCH expected=%s actual=%s\n' "$token_expected_sha" "$token_actual_sha" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet \
  || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  printf 'EXACT_HEAD_DIRTY sha=%s\n' "$token_actual_sha" >&2
  git status --short >&2
  exit 1
fi

printf 'EXACT_HEAD_OK sha=%s clean=true\n' "$token_actual_sha"
