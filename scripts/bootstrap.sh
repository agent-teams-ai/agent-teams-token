#!/usr/bin/env bash
set -euo pipefail

token_repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
token_mode=${1:-all}

token_bootstrap_node=${TOKEN_BOOTSTRAP_NODE:-node}

case "$token_mode" in
  fetch)
    exec "$token_bootstrap_node" "$token_repo_root/scripts/toolchain.mjs" fetch "${@:2}"
    ;;
  install)
    exec "$token_bootstrap_node" "$token_repo_root/scripts/toolchain.mjs" install "${@:2}"
    ;;
  verify)
    exec "$token_bootstrap_node" "$token_repo_root/scripts/toolchain.mjs" verify "${@:2}"
    ;;
  all)
    "$token_bootstrap_node" "$token_repo_root/scripts/toolchain.mjs" fetch
    "$token_bootstrap_node" "$token_repo_root/scripts/toolchain.mjs" install --offline
    source "$token_repo_root/scripts/env.sh"
    if [[ "$(pnpm --version 2>/dev/null || true)" != "11.24.0" ]]; then
      printf '%s\n' 'TOOLCHAIN_PNPM_MISMATCH expected=11.24.0 action=install-the-exact-packageManager-version' >&2
      exit 1
    fi
    pnpm install --frozen-lockfile
    ;;
  *)
    printf 'Usage: ./dev bootstrap [fetch|install --offline|verify --offline|all]\n' >&2
    exit 64
    ;;
esac
