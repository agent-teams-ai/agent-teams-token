#!/usr/bin/env bash
set -euo pipefail

token_repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
token_mode=${1:-all}
token_tools_root="$token_repo_root/.tools"
token_downloads="$token_tools_root/downloads"
umask 077

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    token_node_archive=node-v24.20.0-darwin-arm64.tar.gz
    token_node_directory=node-v24.20.0-darwin-arm64
    token_node_url=https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz
    token_node_sha256=40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8
    token_node_tar_flag=-xzf
    token_sha256_program=/usr/bin/shasum
    token_sha256_argument=-a
    ;;
  Linux:x86_64)
    token_node_archive=node-v24.20.0-linux-x64.tar.xz
    token_node_directory=node-v24.20.0-linux-x64
    token_node_url=https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz
    token_node_sha256=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
    token_node_tar_flag=-xJf
    token_sha256_program=/usr/bin/sha256sum
    token_sha256_argument=
    ;;
  *)
    printf 'TOOLCHAIN_UNSUPPORTED_PLATFORM platform=%s:%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

token_sha256() {
  if [[ -n "$token_sha256_argument" ]]; then
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C "$token_sha256_program" "$token_sha256_argument" 256 "$1" | /usr/bin/awk '{print $1}'
  else
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C "$token_sha256_program" "$1" | /usr/bin/awk '{print $1}'
  fi
}

token_prepare_pinned_node() {
  local token_allow_fetch=$1
  local token_archive_path="$token_downloads/$token_node_archive"
  mkdir -p "$token_downloads"
  chmod 700 "$token_tools_root" "$token_downloads"
  if [[ ! -f "$token_archive_path" ]] || [[ "$(token_sha256 "$token_archive_path")" != "$token_node_sha256" ]]; then
    if [[ "$token_allow_fetch" != true ]]; then
      printf 'TOOLCHAIN_OFFLINE_CACHE_MISS tool=node expected=%s\n' "$token_archive_path" >&2
      return 1
    fi
    rm -f "$token_archive_path"
    local token_part
    token_part=$(/usr/bin/mktemp "$token_downloads/.node.part.XXXXXX")
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C /usr/bin/curl --fail --location --proto '=https' --show-error --output "$token_part" "$token_node_url"
    local token_part_stat
    if [[ "$(uname -s)" == Linux ]]; then
      token_part_stat=$(/usr/bin/stat -c '%i:%d:%h:%F' "$token_part")
      [[ "$token_part_stat" == *":1:regular file" ]]
    else
      token_part_stat=$(/usr/bin/stat -f '%i:%d:%l:%HT' "$token_part")
      [[ "$token_part_stat" == *":1:Regular File" ]]
    fi
    local token_actual_sha256
    token_actual_sha256=$(token_sha256 "$token_part")
    if [[ "$token_actual_sha256" != "$token_node_sha256" ]]; then
      printf 'TOOLCHAIN_CHECKSUM_MISMATCH tool=node expected=%s actual=%s partial=%s\n' \
        "$token_node_sha256" "$token_actual_sha256" "$token_part" >&2
      return 1
    fi
    mv "$token_part" "$token_archive_path"
  fi
  token_node_stage=$(/usr/bin/mktemp -d "$token_tools_root/.bootstrap-node-part.XXXXXX")
  trap 'rm -rf "$token_node_stage"' EXIT
  /usr/bin/tar "$token_node_tar_flag" "$token_archive_path" -C "$token_node_stage"
  token_pinned_node="$token_node_stage/$token_node_directory/bin/node"
  [[ "$(env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C "$token_pinned_node" --version)" == v24.20.0 ]]
}

case "$token_mode" in
  fetch)
    token_prepare_pinned_node true
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C "$token_pinned_node" "$token_repo_root/scripts/toolchain.mjs" fetch "${@:2}"
    ;;
  install)
    token_prepare_pinned_node false
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C "$token_pinned_node" "$token_repo_root/scripts/toolchain.mjs" install "${@:2}"
    ;;
  verify)
    token_prepare_pinned_node false
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C "$token_pinned_node" "$token_repo_root/scripts/toolchain.mjs" verify "${@:2}"
    ;;
  all)
    token_prepare_pinned_node true
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C "$token_pinned_node" "$token_repo_root/scripts/toolchain.mjs" fetch
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C "$token_pinned_node" "$token_repo_root/scripts/toolchain.mjs" install --offline
    source "$token_repo_root/scripts/env.sh"
    if [[ "$(command -v pnpm)" != "$token_tools_root/bin/pnpm" ]]; then
      printf '%s\n' 'TOOLCHAIN_PNPM_PATH_MISMATCH expected=.tools/bin/pnpm' >&2
      exit 1
    fi
    if [[ "$(/usr/bin/env -i PATH="$PATH" HOME=/tmp LANG=C LC_ALL=C pnpm --version 2>/dev/null || true)" != "11.24.0" ]]; then
      printf '%s\n' 'TOOLCHAIN_PNPM_MISMATCH expected=11.24.0 action=install-the-exact-packageManager-version' >&2
      exit 1
    fi
    /usr/bin/env -i PATH="$PATH" HOME=/tmp LANG=C LC_ALL=C pnpm install --frozen-lockfile
    ;;
  *)
    printf 'Usage: ./dev bootstrap [fetch|install --offline|verify --offline|all]\n' >&2
    exit 64
    ;;
esac
