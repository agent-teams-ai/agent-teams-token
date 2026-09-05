#!/usr/bin/env bash

token_env_main() {
  local token_env_script token_env_repo_root token_env_tools_root token_env_platform
  local token_env_node token_env_foundry token_env_solc token_env_agave token_env_package_bin
  local token_env_executable token_env_directory
  local -a token_env_executables
  # Remove the helper before any failure (including errexit); all state is local.
  unset -f token_env_main
  # A failed re-source must not retain previously accepted binaries or PATH.
  export PATH=/dev/null
  unset AGTMAI_ANVIL_BINARY AGTMAI_FORGE_BINARY AGTMAI_SOLC_BINARY
  unset COREPACK_ENABLE_DOWNLOAD_PROMPT COREPACK_ENABLE_PROJECT_SPEC
  if [[ -n "${ZSH_VERSION:-}" ]]; then
    eval 'token_env_script=${(%):-%x}'
  else
    token_env_script=${BASH_SOURCE[0]}
  fi
  if [[ "$token_env_script" != /* ]]; then
    token_env_directory=$(pwd -P) || return 1
    token_env_script="$token_env_directory/$token_env_script"
  fi
  if [[ -L "$token_env_script" || ! -f "$token_env_script" ]]; then
    printf 'TOOLCHAIN_ENV_SOURCE_IDENTITY_INVALID path=%s\n' "$token_env_script" >&2
    return 1
  fi
  case "$(/usr/bin/uname -s):$(/usr/bin/uname -m)" in
    Darwin:arm64) token_env_platform=darwin-arm64 ;;
    Linux:x86_64) token_env_platform=linux-x64 ;;
    *)
      printf 'TOOLCHAIN_UNSUPPORTED_PLATFORM\n' >&2
      return 1
      ;;
  esac
  # Check lexical ancestors before cd -P can hide a source-directory symlink.
  token_env_directory=${token_env_script%/*}
  while [[ -n "$token_env_directory" ]]; do
    if [[ -L "$token_env_directory" ]]; then
      case "$token_env_platform:$token_env_directory:$(/usr/bin/readlink "$token_env_directory")" in
        darwin-arm64:/tmp:/private/tmp|darwin-arm64:/tmp:private/tmp|\
        darwin-arm64:/var:/private/var|darwin-arm64:/var:private/var) ;;
        *)
          printf 'TOOLCHAIN_ENV_SOURCE_IDENTITY_INVALID path=%s\n' "$token_env_directory" >&2
          return 1
          ;;
      esac
    fi
    token_env_directory=${token_env_directory%/*}
  done
  token_env_repo_root=$(CDPATH='' cd -P -- "${token_env_script%/*}/.." && pwd -P) || return 1
  if [[ "$token_env_repo_root" == *:* ]]; then
    printf 'TOOLCHAIN_ENV_PATH_INVALID path=%s\n' "$token_env_repo_root" >&2
    return 1
  fi
  token_env_tools_root="$token_env_repo_root/.tools"
  token_env_node="$token_env_tools_root/node-v24.20.0-$token_env_platform/bin"
  token_env_foundry="$token_env_tools_root/foundry-v1.8.0-$token_env_platform"
  token_env_solc="$token_env_tools_root/solc-v0.8.36-$token_env_platform"
  token_env_agave="$token_env_tools_root/agave-v4.2.1-$token_env_platform/bin"
  token_env_package_bin="$token_env_tools_root/bin"
  token_env_executables=(
    "$token_env_node/node"
    "$token_env_foundry/forge"
    "$token_env_foundry/cast"
    "$token_env_foundry/anvil"
    "$token_env_foundry/chisel"
    "$token_env_solc/solc"
    "$token_env_package_bin/pnpm"
  )
  # Core bootstrap omits Agave. Any entry at its pinned root requires all pins.
  if [[ -e "${token_env_agave%/bin}" || -L "${token_env_agave%/bin}" ]]; then
    token_env_executables+=(
      "$token_env_agave/solana"
      "$token_env_agave/solana-keygen"
      "$token_env_agave/solana-test-validator"
      "$token_env_agave/spl-token"
    )
  else
    token_env_agave=''
  fi
  for token_env_executable in "${token_env_executables[@]}"
  do
    if [[ -L "$token_env_executable" || ! -f "$token_env_executable" || ! -x "$token_env_executable" ]]; then
      printf 'TOOLCHAIN_ENV_PIN_MISSING path=%s action=run-./dev-bootstrap-all\n' "$token_env_executable" >&2
      return 1
    fi
    token_env_directory=${token_env_executable%/*}
    while [[ "$token_env_directory" != "$token_env_repo_root" ]]; do
      if [[ -L "$token_env_directory" || ! -d "$token_env_directory" ]]; then
        printf 'TOOLCHAIN_ENV_DIRECTORY_IDENTITY_INVALID path=%s\n' "$token_env_directory" >&2
        return 1
      fi
      token_env_directory=${token_env_directory%/*}
    done
  done
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  export COREPACK_ENABLE_PROJECT_SPEC=0
  export AGTMAI_ANVIL_BINARY="$token_env_foundry/anvil"
  export AGTMAI_FORGE_BINARY="$token_env_foundry/forge"
  export AGTMAI_SOLC_BINARY="$token_env_solc/solc"
  export PATH="$token_env_node:$token_env_foundry:$token_env_solc${token_env_agave:+:$token_env_agave}:$token_env_package_bin"
  return 0
}

token_env_main
