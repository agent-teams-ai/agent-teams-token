#!/usr/bin/env bash

token_env_repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
token_env_tools_root="$token_env_repo_root/.tools"

for token_env_bin_dir in \
  "$token_env_tools_root/node-v24.20.0-darwin-arm64/bin" \
  "$token_env_tools_root/foundry-v1.8.0" \
  "$token_env_tools_root/bin"
do
  if [[ -d "$token_env_bin_dir" ]]; then
    export PATH="$token_env_bin_dir:$PATH"
  fi
done

token_env_agave_validator=$(find "$token_env_tools_root/agave-v4.2.1" -type f -name solana-test-validator -print -quit 2>/dev/null || true)
if [[ -n "$token_env_agave_validator" ]]; then
  export PATH="$(dirname "$token_env_agave_validator"):$PATH"
fi

unset token_env_repo_root token_env_tools_root token_env_bin_dir token_env_agave_validator
