#!/bin/bash
export PATH=/usr/bin:/bin
set -euo pipefail

token_bootstrap_script=${BASH_SOURCE[0]}
[[ "$token_bootstrap_script" == */* ]] || token_bootstrap_script="./$token_bootstrap_script"
token_repo_root=$(CDPATH='' cd -P -- "${token_bootstrap_script%/*}/.." && pwd -P)
token_mode=${1:-all}
shift || true
token_tools_root="$token_repo_root/.tools"
token_downloads="$token_tools_root/downloads"
umask 077

case "$(/usr/bin/uname -s):$(/usr/bin/uname -m)" in
  Darwin:arm64)
    token_platform=darwin-arm64
    token_node_archive=node-v24.20.0-darwin-arm64.tar.gz
    token_node_directory=node-v24.20.0-darwin-arm64
    token_node_url=https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz
    token_node_sha256=40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8
    token_node_tar_flag=-xzf
    ;;
  Linux:x86_64)
    token_platform=linux-x64
    token_node_archive=node-v24.20.0-linux-x64.tar.xz
    token_node_directory=node-v24.20.0-linux-x64
    token_node_url=https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz
    token_node_sha256=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
    token_node_tar_flag=-xJf
    ;;
  *)
    printf 'TOOLCHAIN_UNSUPPORTED_PLATFORM platform=%s:%s\n' "$(/usr/bin/uname -s)" "$(/usr/bin/uname -m)" >&2
    exit 1
    ;;
esac

token_curl=/usr/bin/curl
if [[ "${TOKEN_BOOTSTRAP_TEST_MODE:-0}" == 1 ]]; then
  token_node_archive=${TOKEN_BOOTSTRAP_TEST_NODE_ARCHIVE:?}
  token_node_directory=${TOKEN_BOOTSTRAP_TEST_NODE_DIRECTORY:?}
  token_node_url=${TOKEN_BOOTSTRAP_TEST_NODE_URL:?}
  token_node_sha256=${TOKEN_BOOTSTRAP_TEST_NODE_SHA256:?}
  token_node_tar_flag=${TOKEN_BOOTSTRAP_TEST_NODE_TAR_FLAG:?}
  token_curl=${TOKEN_BOOTSTRAP_TEST_CURL:?}
  [[ "$token_curl" == /* && ! -L "$token_curl" && -x "$token_curl" ]] || {
    printf 'TOOLCHAIN_TEST_CURL_INVALID\n' >&2
    exit 1
  }
fi

token_stat() {
  if [[ "$token_platform" == linux-x64 ]]; then
    /usr/bin/stat -c '%u:%a:%h:%d:%i:%f' -- "$1"
  else
    /usr/bin/stat -f '%u:%Lp:%l:%d:%i:%HT' -- "$1"
  fi
}

token_stat_follow() {
  if [[ "$token_platform" == linux-x64 ]]; then
    /usr/bin/stat -Lc '%u:%a:%h:%d:%i:%f' -- "$1"
  else
    /usr/bin/stat -Lf '%u:%Lp:%l:%d:%i:%HT' -- "$1"
  fi
}

token_sha256() {
  if [[ "$token_platform" == linux-x64 ]]; then
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C /usr/bin/sha256sum -- "$1" | /usr/bin/awk '{print $1}'
  else
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C /usr/bin/shasum -a 256 -- "$1" | /usr/bin/awk '{print $1}'
  fi
}

token_validate_directory() {
  local token_path=$1
  local token_required=$2
  if [[ ! -e "$token_path" && ! -L "$token_path" ]]; then
    [[ "$token_required" == false ]] && return 0
    printf 'TOOLCHAIN_DIRECTORY_MISSING path=%s\n' "$token_path" >&2
    return 1
  fi
  if [[ -L "$token_path" || ! -d "$token_path" ]]; then
    printf 'TOOLCHAIN_DIRECTORY_IDENTITY_INVALID path=%s\n' "$token_path" >&2
    return 1
  fi
  local token_metadata token_uid token_mode_value
  token_metadata=$(token_stat "$token_path")
  IFS=: read -r token_uid token_mode_value _ <<< "$token_metadata"
  if [[ "$token_uid" != "$(/usr/bin/id -u)" || $((8#$token_mode_value & 8#022)) -ne 0 ]]; then
    printf 'TOOLCHAIN_DIRECTORY_OWNER_OR_MODE_INVALID path=%s\n' "$token_path" >&2
    return 1
  fi
}

token_prepare_directories() {
  token_validate_directory "$token_repo_root" true
  token_validate_directory "$token_tools_root" false
  token_validate_directory "$token_downloads" false
  /bin/mkdir -p "$token_tools_root"
  token_validate_directory "$token_tools_root" true
  /bin/mkdir -p "$token_downloads"
  token_validate_directory "$token_downloads" true
  /bin/chmod 700 "$token_tools_root" "$token_downloads"
}

token_safe_remove_part() {
  local token_part=$1
  if [[ -e "$token_part" || -L "$token_part" ]]; then
    if [[ -d "$token_part" && ! -L "$token_part" ]]; then
      printf 'TOOLCHAIN_FETCH_PART_UNSAFE partial=%s\n' "$token_part" >&2
      return 1
    fi
    /bin/rm -f "$token_part"
  fi
}

token_fetch_node() {
  local token_archive_path=$1
  local token_part="$token_archive_path.part"
  local token_part_fd=9
  token_safe_remove_part "$token_part"
  set -C
  if ! { exec 9> "$token_part"; } 2>/dev/null; then
    set +C
    printf 'TOOLCHAIN_FETCH_PART_CREATE_FAILED partial=%s\n' "$token_part" >&2
    return 1
  fi
  set +C
  local token_before token_after token_path_after token_actual
  token_before=$(token_stat_follow "/dev/fd/$token_part_fd")
  if ! /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C \
    "$token_curl" --fail --location --proto '=https' --show-error --output - "$token_node_url" >&"$token_part_fd"
  then
    exec 9>&-
    printf 'TOOLCHAIN_FETCH_FAILED tool=node partial=%s\n' "$token_part" >&2
    return 1
  fi
  token_after=$(token_stat_follow "/dev/fd/$token_part_fd")
  token_path_after=$(token_stat "$token_part")
  if [[ "$token_before" != "$token_after" ]]; then
    exec 9>&-
    printf 'TOOLCHAIN_FETCH_PART_UNSTABLE tool=node\n' >&2
    return 1
  fi
  if [[ "$token_before" != "$token_path_after" ]]; then
    exec 9>&-
    printf 'TOOLCHAIN_FETCH_PART_UNSTABLE tool=node\n' >&2
    return 1
  fi
  token_actual=$(token_sha256 "/dev/fd/$token_part_fd")
  if [[ "$token_actual" != "$token_node_sha256" ]]; then
    exec 9>&-
    printf 'TOOLCHAIN_CHECKSUM_MISMATCH tool=node expected=%s actual=%s partial=%s\n' \
      "$token_node_sha256" "$token_actual" "$token_part" >&2
    return 1
  fi
  /bin/mv "$token_part" "$token_archive_path"
  [[ "$(token_stat_follow "/dev/fd/$token_part_fd")" == "$(token_stat "$token_archive_path")" ]] || {
    exec 9>&-
    printf 'TOOLCHAIN_FETCH_PART_UNSTABLE tool=node\n' >&2
    return 1
  }
  exec 9>&-
}

token_snapshot_archive() {
  local token_archive_path=$1
  local token_snapshot=$2
  /bin/cp -P "$token_archive_path" "$token_snapshot" 2>/dev/null || return 1
  [[ ! -L "$token_snapshot" && -f "$token_snapshot" ]] || return 1
  local token_metadata
  token_metadata=$(token_stat "$token_snapshot")
  [[ "$token_metadata" == *":1:"* ]] || return 1
  [[ "$(token_sha256 "$token_snapshot")" == "$token_node_sha256" ]]
}

token_prepare_pinned_node() {
  local token_allow_fetch=$1
  token_prepare_directories
  local token_archive_path="$token_downloads/$token_node_archive"
  token_node_stage=$(/usr/bin/mktemp -d "$token_tools_root/.bootstrap-node-part.XXXXXX")
  trap '/bin/rm -rf "$token_node_stage"' EXIT
  local token_verified_archive="$token_node_stage/$token_node_archive"
  if ! token_snapshot_archive "$token_archive_path" "$token_verified_archive"; then
    /bin/rm -f "$token_verified_archive"
    if [[ "$token_allow_fetch" != true ]]; then
      printf 'TOOLCHAIN_OFFLINE_CACHE_MISS tool=node expected=%s\n' "$token_archive_path" >&2
      return 1
    fi
    token_fetch_node "$token_archive_path"
    token_snapshot_archive "$token_archive_path" "$token_verified_archive" || {
      printf 'TOOLCHAIN_ARCHIVE_IDENTITY_INVALID tool=node\n' >&2
      return 1
    }
  fi
  /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C TAR_OPTIONS= \
    /usr/bin/tar --no-same-owner "$token_node_tar_flag" "$token_verified_archive" -C "$token_node_stage"
  token_pinned_node="$token_node_stage/$token_node_directory/bin/node"
  [[ ! -L "$token_pinned_node" && -f "$token_pinned_node" && -x "$token_pinned_node" ]] || {
    printf 'TOOLCHAIN_NODE_SNAPSHOT_INVALID\n' >&2
    return 1
  }
  [[ "$(/usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C "$token_pinned_node" --version)" == v24.20.0 ]]
}

token_run_toolchain() {
  /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C \
    "$token_pinned_node" "$token_repo_root/scripts/toolchain.mjs" "$@"
}

case "$token_mode" in
  fetch)
    token_prepare_pinned_node true
    token_run_toolchain fetch "$@"
    ;;
  install)
    token_prepare_pinned_node false
    token_run_toolchain install "$@"
    ;;
  verify)
    token_prepare_pinned_node false
    token_run_toolchain verify "$@"
    ;;
  all)
    token_prepare_pinned_node true
    token_run_toolchain fetch --scope=solana
    token_run_toolchain install --offline --scope=solana
    token_run_toolchain run-pnpm install --frozen-lockfile
    ;;
  doctor)
    token_prepare_pinned_node false
    exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C \
      "$token_pinned_node" "$token_repo_root/scripts/doctor.mjs" "$@"
    ;;
  run-pnpm)
    token_prepare_pinned_node false
    token_run_toolchain run-pnpm "$@"
    ;;
  run-solana)
    token_prepare_pinned_node false
    exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C LC_ALL=C \
      "$token_pinned_node" "$token_repo_root/scripts/solana/local-fixture.ts" "$@"
    ;;
  *)
    printf 'Usage: ./dev bootstrap [fetch|install --offline|verify --offline|all]\n' >&2
    exit 64
    ;;
esac
