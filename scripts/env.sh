#!/usr/bin/env bash

if [[ -n "${ZSH_VERSION:-}" ]]; then
  token_env_script=${(%):-%N}
  token_env_script_directory=${token_env_script:h}
else
  token_env_script=${BASH_SOURCE[0]}
  if [[ "$token_env_script" == */* ]]; then
    token_env_script_directory=${token_env_script%/*}
    [[ -n "$token_env_script_directory" ]] || token_env_script_directory=/
  else
    token_env_script_directory=.
  fi
fi

token_env_repo_root=$(CDPATH= cd -- "$token_env_script_directory/.." && pwd -P)
token_env_tools_root="$token_env_repo_root/.tools"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_ENABLE_PROJECT_SPEC=0

case "$(/usr/bin/uname -s):$(/usr/bin/uname -m)" in
  Darwin:arm64) token_env_platform=darwin-arm64 ;;
  Linux:x86_64) token_env_platform=linux-x64 ;;
  *) token_env_platform=unsupported ;;
esac

token_env_path_prefix=
for token_env_bin_dir in \
  "$token_env_tools_root/node-v24.20.0-$token_env_platform/bin" \
  "$token_env_tools_root/foundry-v1.8.0-$token_env_platform" \
  "$token_env_tools_root/solc-v0.8.36-$token_env_platform" \
  "$token_env_tools_root/agave-v4.2.1-$token_env_platform/bin" \
  "$token_env_tools_root/bin"
do
  if [[ -d "$token_env_bin_dir" ]]; then
    token_env_path_prefix="${token_env_path_prefix:+$token_env_path_prefix:}$token_env_bin_dir"
  fi
done

if [[ -n "$token_env_path_prefix" ]]; then
  export PATH="$token_env_path_prefix:$PATH"
fi

unset token_env_script token_env_script_directory token_env_repo_root token_env_tools_root token_env_platform token_env_bin_dir token_env_path_prefix
