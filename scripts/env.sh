#!/usr/bin/env bash

if [[ -n "${ZSH_VERSION:-}" ]]; then
  eval 'token_env_script=${(%):-%N}'
else
  token_env_script=${BASH_SOURCE[0]}
fi

token_env_main() {
  local token_env_script token_env_repo_root token_env_tools_root token_env_platform
  local token_env_node token_env_foundry token_env_solc token_env_agave token_env_package_bin
  local token_env_executable
  token_env_script=$1
  token_env_repo_root=$(CDPATH='' cd -- "$(/usr/bin/dirname -- "$token_env_script")/.." && pwd)
  token_env_tools_root="$token_env_repo_root/.tools"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  export COREPACK_ENABLE_PROJECT_SPEC=0
  case "$(/usr/bin/uname -s):$(/usr/bin/uname -m)" in
    Darwin:arm64) token_env_platform=darwin-arm64 ;;
    Linux:x86_64) token_env_platform=linux-x64 ;;
    *)
      printf 'TOOLCHAIN_UNSUPPORTED_PLATFORM\n' >&2
      unset -f token_env_main 2>/dev/null || unfunction token_env_main 2>/dev/null || true
      return 1
      ;;
  esac
  token_env_node="$token_env_tools_root/node-v24.20.0-$token_env_platform/bin"
  token_env_foundry="$token_env_tools_root/foundry-v1.8.0-$token_env_platform"
  token_env_solc="$token_env_tools_root/solc-v0.8.36-$token_env_platform"
  token_env_agave="$token_env_tools_root/agave-v4.2.1-$token_env_platform/bin"
  token_env_package_bin="$token_env_tools_root/bin"
  for token_env_executable in \
    "$token_env_node/node" \
    "$token_env_foundry/forge" \
    "$token_env_foundry/cast" \
    "$token_env_foundry/anvil" \
    "$token_env_foundry/chisel" \
    "$token_env_solc/solc" \
    "$token_env_agave/solana" \
    "$token_env_agave/solana-keygen" \
    "$token_env_agave/solana-test-validator" \
    "$token_env_agave/spl-token" \
    "$token_env_package_bin/pnpm"
  do
    if [[ -L "$token_env_executable" || ! -f "$token_env_executable" || ! -x "$token_env_executable" ]]; then
      printf 'TOOLCHAIN_ENV_PIN_MISSING path=%s action=run-./dev-bootstrap-all\n' "$token_env_executable" >&2
      unset -f token_env_main 2>/dev/null || unfunction token_env_main 2>/dev/null || true
      return 1
    fi
  done
  export PATH="$token_env_node:$token_env_foundry:$token_env_solc:$token_env_agave:$token_env_package_bin"
  unset -f token_env_main 2>/dev/null || unfunction token_env_main 2>/dev/null || true
  return 0
}

token_env_main "$token_env_script"
unset token_env_script
